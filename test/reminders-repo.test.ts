import { NO_UNITS } from "../src/domain/units";
import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { TELEGRAM_TEXT_MAX, trainReminderText, weekRangeLabel, weeklyReportText, type TrainReminderLine } from "../src/bot/texts";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { nextDayCode } from "../src/domain/progression";
import type { Plan } from "../src/domain/plan";
import { OWNER, count, env, htmlProblems, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(OWNER, "Денис", 0);
});

const user = () => env.DB.prepare("SELECT training_days, remind_time, weigh_time FROM users WHERE id = ?").bind(OWNER).first<{ training_days: string; remind_time: string | null; weigh_time: string | null }>();
const update = (set: string) => env.DB.prepare(`UPDATE users SET ${set} WHERE id = ?`).bind(OWNER).run();

describe("міграція 0005: users.training_days / remind_time / weigh_time", () => {
  it("значення за замовчуванням: 1,3,5 · 08:00 · 07:30", async () => {
    expect(await user()).toEqual({ training_days: "1,3,5", remind_time: "08:00", weigh_time: "07:30" });
  });

  it.each(["08:15", "05:00", "22:00", "13:45", null])("remind_time = %s приймається", async (v) => {
    await env.DB.prepare("UPDATE users SET remind_time = ? WHERE id = ?").bind(v, OWNER).run();
    expect((await user())!.remind_time).toBe(v);
  });

  it.each(["04:45", "22:15", "08:10", "8:00", "08-00", "24:00", "ab:cd", "08:00:00"])("remind_time = %s відхиляється CHECK-ом", async (v) => {
    await expect(env.DB.prepare("UPDATE users SET remind_time = ? WHERE id = ?").bind(v, OWNER).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE users SET weigh_time = ? WHERE id = ?").bind(v, OWNER).run()).rejects.toThrow();
  });

  it.each(["", "8", "x", "0"])("training_days = %j відхиляється CHECK-ом (слабка перевірка першого символу)", async (v) => {
    await expect(env.DB.prepare("UPDATE users SET training_days = ? WHERE id = ?").bind(v, OWNER).run()).rejects.toThrow();
  });

  it("NOT NULL: training_days не може стати NULL", async () => {
    await expect(update("training_days = NULL")).rejects.toThrow();
  });
});

describe("міграція 0005: бекфіл training_days за days_per_week", () => {
  // Той самий UPDATE, що й у міграції, — у тесті, бо схема вже застосована.
  const backfill = async () => {
    const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const q = migrations.find((m) => m.name.startsWith("0005"))!.queries.find((x) => x.includes("UPDATE `users`") && x.includes("CASE"));
    if (!q) throw new Error("бекфілу в 0005 немає");
    await env.DB.prepare(q).run();
  };
  const days = async (id: number) => (await env.DB.prepare("SELECT training_days FROM users WHERE id = ?").bind(id).first<{ training_days: string }>())!.training_days;

  it("2 → 1,4 · 3 → 1,3,5 · 4 → 1,2,4,5 · 5 → 1,2,3,4,5 · NULL і немає профілю → 1,3,5", async () => {
    const cases: [number, number | null | "no-profile", string][] = [
      [10, 2, "1,4"],
      [11, 3, "1,3,5"],
      [12, 4, "1,2,4,5"],
      [13, 5, "1,2,3,4,5"],
      [14, null, "1,3,5"],
      [15, "no-profile", "1,3,5"],
    ];
    for (const [id, dpw] of cases) {
      await env.DB.prepare("INSERT INTO users (id, first_name, created_at, training_days) VALUES (?, 'U', 0, '7')").bind(id).run();
      if (dpw !== "no-profile") await env.DB.prepare("INSERT INTO user_profiles (user_id, days_per_week, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(id, dpw).run();
    }
    await backfill();
    for (const [id, , expected] of cases) expect(await days(id), String(id)).toBe(expected);
    await env.DB.prepare("DELETE FROM user_profiles WHERE user_id >= 10").run();
    await env.DB.prepare("DELETE FROM users WHERE id >= 10").run();
  });
});

describe("reminders_sent і cron_state", () => {
  it("UNIQUE (user, kind, local_date): другий claim — false, один рядок", async () => {
    expect(await repo.claimReminder(OWNER, "train", "2026-10-19", 1)).toBe(true);
    expect(await repo.claimReminder(OWNER, "train", "2026-10-19", 2)).toBe(false);
    expect(await count("reminders_sent")).toBe(1);
    expect(await repo.claimReminder(OWNER, "weigh", "2026-10-19", 1)).toBe(true); // інший kind
    expect(await repo.claimReminder(OWNER, "train", "2026-10-20", 1)).toBe(true); // інша дата
  });

  it("CHECK: kind поза переліком і неправильна дата відхиляються", async () => {
    await expect(env.DB.prepare("INSERT INTO reminders_sent (user_id, kind, local_date, sent_at) VALUES (?, 'x', '2026-10-19', 1)").bind(OWNER).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO reminders_sent (user_id, kind, local_date, sent_at) VALUES (?, 'train', '19.10.2026', 1)").bind(OWNER).run()).rejects.toThrow();
  });

  it("release знімає заявку (можна взяти знову); message_id зберігається й шукається лише для weigh", async () => {
    await repo.claimReminder(OWNER, "weigh", "2026-10-19", 1);
    await repo.setReminderMessageId(OWNER, "weigh", "2026-10-19", 55);
    expect(await repo.getWeighReminderDate(OWNER, 55)).toBe("2026-10-19");
    expect(await repo.getWeighReminderDate(OWNER, 56)).toBeNull();
    expect(await repo.getWeighReminderDate(999, 55)).toBeNull(); // чужий користувач
    await repo.releaseReminder(OWNER, "weigh", "2026-10-19");
    expect(await repo.hasReminder(OWNER, "weigh", "2026-10-19")).toBe(false);
    expect(await repo.claimReminder(OWNER, "weigh", "2026-10-19", 2)).toBe(true);
  });

  it("cron_state: один рядок (id = 1), upsert; last_ok_at оновлюється лише для ok-тіку; CHECK id = 1", async () => {
    expect(await repo.getCronTick()).toBeNull();
    await repo.touchCron(100);
    await repo.touchCron(200);
    expect(await repo.getCronTick()).toEqual({ tickAt: 200, okAt: 200 });
    await repo.touchCron(300, false);
    expect(await repo.getCronTick()).toEqual({ tickAt: 300, okAt: 200 });
    expect(await count("cron_state")).toBe(1);
    await expect(env.DB.prepare("INSERT INTO cron_state (id, last_tick_at) VALUES (2, 1)").run()).rejects.toThrow();
  });

  it("перший тік із помилкою: last_ok_at = NULL", async () => {
    await repo.touchCron(100, false);
    expect(await repo.getCronTick()).toEqual({ tickAt: 100, okAt: null });
  });

  it("hasHistory: порожньо → false; лише active-тренування → false; done → true; або запис ваги → true", async () => {
    expect(await repo.hasHistory(OWNER)).toBe(false);
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at) VALUES (?, ?, 'active', 1000)").bind(OWNER, day.id).run();
    expect(await repo.hasHistory(OWNER)).toBe(false);
    await env.DB.prepare("UPDATE workouts SET status = 'done', finished_at = 2000, effort = 3").run();
    expect(await repo.hasHistory(OWNER)).toBe(true);
    await env.DB.prepare("DELETE FROM workouts").run();
    expect(await repo.hasHistory(OWNER)).toBe(false);
    await repo.upsertBodyWeight(OWNER, "2026-10-19", 784, 1);
    expect(await repo.hasHistory(OWNER)).toBe(true);
  });
});

describe("P2.3.12 nextDayCode після активації нового плану", () => {
  it("done-тренування старої програми не зсуває лічильник нової: перший день за position", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', 1000, 2000, 3)").bind(OWNER, dayA.id).run();
    const before = await repo.getActiveProgram(OWNER);
    expect(nextDayCode(await repo.getLastDoneWorkout(OWNER), before!.days)).toBe("B"); // після A — B (стара програма)

    const exerciseId = (await repo.getPlanCatalog())[0]!.id;
    const slot = { exerciseId, sets: 3, repMin: 8, repMax: 12 };
    const plan = { name: "Новий", days: [{ code: "A", title: "Все тіло A", slots: [slot] }, { code: "B", title: "Все тіло B", slots: [slot] }] } as Plan;
    expect((await repo.activatePlan(OWNER, plan, 5_000)).ok).toBe(true);
    const after = await repo.getActiveProgram(OWNER);
    expect(after!.name).toBe("Новий");
    expect(await repo.getLastDoneWorkout(OWNER)).toBeNull();
    expect(nextDayCode(await repo.getLastDoneWorkout(OWNER), after!.days)).toBe("A"); // а не B за кодом старої програми
  });

  it("done у поточній програмі — як і раніше: наступний за днем останнього", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const dayB = (await repo.getProgramDay(OWNER, "B"))!;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', 1000, 2000, 3)").bind(OWNER, dayB.id).run();
    expect(nextDayCode(await repo.getLastDoneWorkout(OWNER), (await repo.getActiveProgram(OWNER))!.days)).toBe("A");
  });
});

describe("тексти нагадувань", () => {
  const line = (i: number): TrainReminderLine => ({ nameUk: `Вправа ${i} з дуже довгою назвою для перевірки ліміту повідомлення`, bodyweight: false, units: NO_UNITS, weightKg: 60, targetReps: 8, calibration: false });

  it("нагадування про тренування: заголовок, рядки, «Почати»; HTML валідний", () => {
    const t = trainReminderText({ dayLabel: "Все тіло A (ноги, груди, спина)", lines: [{ nameUk: "Присідання зі штангою", bodyweight: false, units: NO_UNITS, weightKg: 60, targetReps: 8, calibration: false }, { nameUk: "Віджимання", bodyweight: true, units: NO_UNITS, weightKg: 0, targetReps: 10, calibration: false }] });
    expect(t).toBe("🏋️ <b>Сьогодні тренування — Все тіло A (ноги, груди, спина)</b>\nПрисідання зі штангою — 60 кг × 8\nВіджимання — власна вага × 10\nПочати: /trening");
    expect(htmlProblems(t)).toEqual([]);
  });

  it("N6: довгий список ріжеться з кінця, «Почати» лишається, ≤ 4096", () => {
    const t = trainReminderText({ dayLabel: "День", lines: Array.from({ length: 200 }, (_, i) => line(i)) });
    expect(t.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(t.endsWith("Почати: /trening")).toBe(true);
    expect(t).toContain("Вправа 0 ");
    expect(t).not.toContain("Вправа 199 ");
    expect(htmlProblems(t)).toEqual([]);
  });

  it("назви екрануються (HTML)", () => {
    const t = trainReminderText({ dayLabel: "A<B", lines: [{ nameUk: "x & y", bodyweight: false, units: NO_UNITS, weightKg: 1, targetReps: 1, calibration: false }] });
    expect(htmlProblems(t)).toEqual([]);
    expect(t).toContain("A&lt;B");
    expect(t).toContain("x &amp; y");
  });

  it("діапазон тижня: один місяць і через місяць (родовий відмінок)", () => {
    expect(weekRangeLabel("2026-10-19", "2026-10-25")).toBe("19–25 жовтня");
    expect(weekRangeLabel("2026-10-28", "2026-11-03")).toBe("28 жовтня – 3 листопада");
    expect(weekRangeLabel("2026-12-28", "2027-01-03")).toBe("28 грудня – 3 січня");
    expect(weekRangeLabel("2027-03-01", "2027-03-07")).toBe("1–7 березня");
  });

  it("звіт: planned = 0 (битий training_days) — без «з 0»", () => {
    const t = weeklyReportText({ weekStart: "2026-10-19", weekEnd: "2026-10-25", workouts: 1, planned: 0, sets: 3, volumeKg: 480, records: [], weight: null, next: null });
    expect(t).toContain("Тренувань: <b>1</b> · Підходів");
    expect(t).not.toContain(" з 0");
  });

  it("звіт: примітка (n зваж.) при < 3 записів; без зміни — без дужки; нуль тренувань без «далі» закінчується крапкою", () => {
    const base = { weekStart: "2026-10-19", weekEnd: "2026-10-25", planned: 3, sets: 0, volumeKg: 0, records: [], next: null };
    const t = weeklyReportText({ ...base, workouts: 0, weight: { avg: "79,4", n: 2, change: null } });
    expect(t).toBe("📊 <b>Тиждень 19–25 жовтня</b>\nЦього тижня тренувань не було. Нічого страшного.\n⚖️ Середня вага <b>79,4 кг</b> (2 зваж.)");
    expect(htmlProblems(t)).toEqual([]);
  });
});
