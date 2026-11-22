import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, resetHealthCache } from "../src/app";
import { runCron } from "../src/cron";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import worker from "../src/index";
import { OWNER, env, outgoingProblems, resetDb, scriptedTelegram, type TelegramStep } from "./helpers";

const repo = createRepo(createDb(env.DB));
const OTHER = 222;

// Пн 2026-10-19, EEST (+3): 08:00 за Києвом = 05:00Z; 07:30 = 04:30Z.
const MON_0800 = Date.parse("2026-10-19T05:00:00Z");
const MIN = 60_000;
const at = (utc: string): number => Date.parse(utc);

let tg = scriptedTelegram();
let spies: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

beforeEach(async () => {
  await resetDb();
  tg = scriptedTelegram();
  spies = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
});
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
  for (const s of Object.values(spies)) s.mockRestore();
});

const tick = (now: number, steps?: TelegramStep[]) => {
  if (steps) tg = scriptedTelegram(steps);
  return runCron(env, now, { fetch: tg.fetch, timeoutMs: 50 });
};
/** Лише train: без нагадування про вагу, щоб рахувати повідомлення. */
const onlyTrain = () => env.DB.prepare("UPDATE users SET weigh_time = NULL").run();
const onlyWeigh = () => env.DB.prepare("UPDATE users SET remind_time = NULL").run();
const sentRows = () =>
  env.DB.prepare("SELECT user_id, kind, local_date, sent_at, message_id FROM reminders_sent ORDER BY user_id, kind")
    .all<{ user_id: number; kind: string; local_date: string; sent_at: number; message_id: number | null }>()
    .then((r) => r.results);

describe("P2.3.1 нагадування про тренування", () => {
  it("Пн 08:00 за Києвом: одне повідомлення з назвою дня й призначеннями, chat_id = id користувача", async () => {
    await onlyTrain();
    const c = await tick(MON_0800);
    expect(c).toEqual({ sent: 1, skipped: 0, released: 0, errors: 0 });
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.payload).toMatchObject({ chat_id: OWNER, parse_mode: "HTML" });
    const text = tg.texts()[0]!;
    expect(text).toContain("🏋️ <b>Сьогодні тренування — Все тіло A (ноги, груди, спина)</b>");
    expect(text).toContain("Присідання зі штангою — калібрування, старт ≈ 20 кг × 6");
    expect(text).toContain("Тяга верхнього блока — калібрування, старт ≈ 5 кг × 8");
    expect(text.endsWith("Почати: /trening")).toBe(true);
    expect(await sentRows()).toEqual([{ user_id: OWNER, kind: "train", local_date: "2026-10-19", sent_at: MON_0800, message_id: 100 }]);
  });

  it("другий тік тієї ж години — нічого (рядок у reminders_sent)", async () => {
    await onlyTrain();
    await tick(MON_0800);
    const c = await tick(MON_0800 + 15 * MIN);
    expect(c).toMatchObject({ sent: 0, skipped: 1 });
    expect(tg.calls).toHaveLength(1);
    expect(await sentRows()).toHaveLength(1);
  });

  it("два виклики scheduled() в одному вікні → 1 повідомлення (через worker.scheduled)", async () => {
    await onlyTrain();
    const real = globalThis.fetch;
    globalThis.fetch = tg.fetch;
    try {
      const run = (t: number) => worker.scheduled!({ scheduledTime: t, cron: "*/15 * * * *", noRetry() {} } as ScheduledController, env);
      await run(MON_0800);
      await run(MON_0800 + 15 * MIN);
    } finally {
      globalThis.fetch = real;
    }
    expect(tg.calls).toHaveLength(1);
  });

  it("гонка: два паралельні тіки → рівно одне повідомлення (UNIQUE)", async () => {
    await onlyTrain();
    await Promise.all([tick(MON_0800), tick(MON_0800)]);
    expect(tg.calls).toHaveLength(1);
    expect(await sentRows()).toHaveLength(1);
  });

  it("вага й тренування в один тік — окремі повідомлення", async () => {
    await tick(MON_0800); // 08:00: weigh (07:30, вікно до 08:29) і train
    expect(tg.texts().filter((t) => t.startsWith("⚖️"))).toHaveLength(1);
    expect(tg.texts().filter((t) => t.startsWith("🏋️"))).toHaveLength(1);
    expect(tg.calls).toHaveLength(2);
  });

  it("після завершеного тренування наступне нагадування показує наступний день, а після нового плану — перший", async () => {
    await onlyTrain();
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', ?, ?, 3)").bind(OWNER, dayA.id, at("2026-10-17T10:00:00Z"), at("2026-10-17T11:00:00Z")).run();
    await tick(MON_0800);
    expect(tg.texts()[0]).toContain("Все тіло B");
  });

  it("призначення — з історії (nextPrescription), як у /prohrama: 3 × 60 кг × 10 → 65 кг × 6", async () => {
    await onlyTrain();
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    const dayB = (await repo.getProgramDay(OWNER, "B"))!;
    const insert = (dayId: number, startedAt: number) =>
      env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', ?, ?, 3)").bind(OWNER, dayId, startedAt, startedAt + 3_000_000).run();
    const wa = await insert(dayA.id, at("2026-10-12T10:00:00Z"));
    for (const n of [1, 2, 3]) {
      await env.DB.prepare("INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped) VALUES (?, ?, ?, ?, 60, 10, 60, 10, 0)").bind(wa.meta.last_row_id, dayA.slots[0]!.id, dayA.slots[0]!.exercise.id, n).run();
    }
    await insert(dayB.id, at("2026-10-14T10:00:00Z")); // після B наступний — A
    await tick(MON_0800);
    expect(tg.texts()[0]).toContain("Все тіло A");
    expect(tg.texts()[0]).toContain("Присідання зі штангою — 65 кг × 6");
  });
});

describe("P2.3.2 умови: не день тренування, тренування вже було", () => {
  it("Вт — train не надсилається, заявки немає", async () => {
    await onlyTrain();
    const c = await tick(at("2026-10-20T05:00:00Z"));
    expect(c).toEqual({ sent: 0, skipped: 0, released: 0, errors: 0 });
    expect(tg.calls).toHaveLength(0);
    expect(await sentRows()).toEqual([]);
  });

  it.each(["active", "done"] as const)("тренування сьогодні (%s) — train не надсилається й заявки немає", async (status) => {
    await onlyTrain();
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    const fin = status === "done" ? ", finished_at, effort" : "";
    const vals = status === "done" ? ", ?, 3" : "";
    await env.DB.prepare(`INSERT INTO workouts (user_id, program_day_id, status, started_at${fin}) VALUES (?, ?, '${status}', ?${vals})`)
      .bind(...([OWNER, dayA.id, at("2026-10-19T04:00:00Z"), ...(status === "done" ? [at("2026-10-19T04:50:00Z")] : [])] as (string | number)[]))
      .run();
    await tick(MON_0800);
    expect(tg.calls).toHaveLength(0);
    expect(await sentRows()).toEqual([]);
  });

  it("«сьогодні» — за локальною датою: тренування вчора ввечері (UTC уже сьогодні) не блокує", async () => {
    await onlyTrain();
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    // Нд 2026-10-18 23:30 за Києвом = 20:30Z — інша локальна доба.
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', ?, ?, 3)").bind(OWNER, dayA.id, at("2026-10-18T20:30:00Z"), at("2026-10-18T20:50:00Z")).run();
    await tick(MON_0800);
    expect(tg.calls).toHaveLength(1);
  });

  it("тренування сьогодні, розпочате о 00:30 за Києвом (UTC — ще вчора), блокує нагадування", async () => {
    await onlyTrain();
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', ?, ?, 3)").bind(OWNER, dayA.id, at("2026-10-18T21:30:00Z"), at("2026-10-18T22:00:00Z")).run();
    await tick(MON_0800);
    expect(tg.calls).toHaveLength(0);
  });

  it("немає активної програми — train не надсилається", async () => {
    await onlyTrain();
    await env.DB.prepare("UPDATE programs SET active = 0").run();
    await tick(MON_0800);
    expect(tg.calls).toHaveLength(0);
    expect(await sentRows()).toEqual([]);
  });
});

describe("P2.3.3 і P2.3.9 помилки Telegram", () => {
  // Д2 рев'ю 2.3: 5xx (502/504 від проксі) не гарантує, що Telegram не прийняв запит — повтор дав би дубль.
  it.each([500, 502, 504])("відповідь %i → невизначена недоставка: заявку ЛИШЕНО, повтору немає (без дубля), тік із помилкою", async (status) => {
    await onlyTrain();
    const c1 = await tick(MON_0800, [status]);
    expect(c1).toEqual({ sent: 0, skipped: 0, released: 0, errors: 1 });
    expect(await sentRows()).toEqual([{ user_id: OWNER, kind: "train", local_date: "2026-10-19", sent_at: MON_0800, message_id: null }]);
    await tick(MON_0800 + 15 * MIN);
    expect(tg.calls).toHaveLength(1); // нових спроб немає
  });

  it.each([400, 429])("відповідь %i — визначена недоставка: заявку знято; наступний тік у вікні надсилає", async (status) => {
    await onlyTrain();
    const c1 = await tick(MON_0800, [status]);
    expect(c1).toEqual({ sent: 0, skipped: 0, released: 1, errors: 0 });
    expect(await sentRows()).toEqual([]);
    await tick(MON_0800 + 15 * MIN);
    expect(await sentRows()).toHaveLength(1);
  });

  // Д1 рев'ю 2.3: 403 детермінований — повтор до кінця вікна (4 тіки, для звіту — до кінця доби) лише палить виклики й побудову звіту.
  it("відповідь 403 (бот заблокований) → заявку ЛИШЕНО (день пропущено), не помилка тіку; решта вікна без спроб; наступної доби — знову", async () => {
    await onlyTrain();
    const c1 = await tick(MON_0800, [403]);
    expect(c1).toEqual({ sent: 0, skipped: 1, released: 0, errors: 0 });
    expect(await sentRows()).toEqual([{ user_id: OWNER, kind: "train", local_date: "2026-10-19", sent_at: MON_0800, message_id: null }]);
    for (const m of [15, 30, 45]) await tick(MON_0800 + m * MIN);
    expect(tg.calls).toHaveLength(1); // лише перша спроба
    expect((await repo.getCronTick())?.okAt).toBe(MON_0800 + 45 * MIN); // 403 не робить крон «хворим»
    const WED_0800 = MON_0800 + 2 * 24 * 3_600_000; // Ср — наступний день тренування
    await tick(WED_0800);
    expect(tg.calls).toHaveLength(2);
    expect((await sentRows()).map((r) => r.local_date)).toEqual(["2026-10-19", "2026-10-21"]);
  });

  it("помилка триває все вікно → день пропущено, reminders_sent порожній, після T+60 спроб немає", async () => {
    await onlyTrain();
    for (const m of [0, 15, 30, 45]) {
      await tick(MON_0800 + m * MIN, [429]);
      expect(tg.calls).toHaveLength(1); // кожен тік у вікні пробує знову
    }
    expect(await sentRows()).toEqual([]);
    await tick(MON_0800 + 60 * MIN, [429]);
    expect(tg.calls).toHaveLength(0); // T+60: вікно закрите, спроби немає
  });

  it("таймаут → заявку ЛИШЕНО (message_id NULL), повтору немає", async () => {
    await onlyTrain();
    const c = await tick(MON_0800, ["hang"]);
    expect(c).toEqual({ sent: 0, skipped: 0, released: 0, errors: 1 });
    expect(await sentRows()).toEqual([{ user_id: OWNER, kind: "train", local_date: "2026-10-19", sent_at: MON_0800, message_id: null }]);
    await tick(MON_0800 + 15 * MIN);
    expect(tg.calls).toHaveLength(1); // нових спроб немає: лише та, що завмерла
  });

  it("обрив мережі (fetch кидає) → заявку лишено, повтору немає", async () => {
    await onlyTrain();
    await tick(MON_0800, ["throw"]);
    expect(await sentRows()).toHaveLength(1);
    await tick(MON_0800 + 15 * MIN);
    expect(tg.calls).toHaveLength(1); // лише перша спроба
  });

  it("помилка побудови тексту до відправки → заявку знято (недоставка визначена)", async () => {
    await onlyTrain();
    const broken = { ...repo, getProgramDay: () => Promise.reject(new Error("D1 впала")) };
    const c = await runCron(env, MON_0800, { repo: broken as typeof repo, fetch: tg.fetch });
    expect(c.errors).toBe(1);
    expect(await sentRows()).toEqual([]);
    expect(tg.calls).toHaveLength(0);
  });

  it("токен і текст не потрапляють у логи", async () => {
    await onlyTrain();
    await tick(MON_0800, [429]);
    const logged = JSON.stringify([...spies.warn.mock.calls, ...spies.error.mock.calls, ...spies.log.mock.calls]);
    expect(logged).not.toContain(env.TELEGRAM_BOT_TOKEN!);
    expect(logged).not.toContain("Присідання");
    expect(logged).not.toContain("тренування");
  });
});

describe("P2.3.6 вимкнено / вже є", () => {
  it("remind_time = NULL → train немає; weigh_time = NULL → weigh немає", async () => {
    await env.DB.prepare("UPDATE users SET remind_time = NULL, weigh_time = NULL").run();
    await tick(MON_0800);
    expect(tg.calls).toHaveLength(0);
    expect(await sentRows()).toEqual([]);
  });

  it("вага за сьогодні вже є → weigh немає й заявки немає", async () => {
    await onlyWeigh();
    await repo.upsertBodyWeight(OWNER, "2026-10-19", 784, 1);
    await tick(at("2026-10-19T04:30:00Z"));
    expect(tg.calls).toHaveLength(0);
    expect(await sentRows()).toEqual([]);
  });

  it("weigh: текст зі спеки й message_id у заявці (для reply)", async () => {
    await onlyWeigh();
    await tick(at("2026-10-19T04:30:00Z"));
    expect(tg.texts()).toEqual(["⚖️ Доброго ранку! Вага? Надішли число у відповідь (наприклад 78.4) або /vaga 78.4"]);
    expect((await sentRows())[0]).toMatchObject({ kind: "weigh", local_date: "2026-10-19", message_id: 100 });
  });

  it("зважування вчора не блокує сьогоднішнє нагадування", async () => {
    await onlyWeigh();
    await repo.upsertBodyWeight(OWNER, "2026-10-18", 784, 1);
    await tick(at("2026-10-19T04:30:00Z"));
    expect(tg.calls).toHaveLength(1);
  });
});

describe("P2.3.5 переходи часу: ключ ідемпотентності local_date", () => {
  it("2026-10-25 (EEST → EET): weigh о 07:30 EET = 05:30Z; одна заявка, повторний тік 05:45Z нічого не шле", async () => {
    await onlyWeigh();
    await tick(at("2026-10-25T04:30:00Z")); // 06:30 локально — ще рано
    expect(tg.calls).toHaveLength(0);
    await tick(at("2026-10-25T05:30:00Z"));
    expect(tg.calls).toHaveLength(1);
    await tick(at("2026-10-25T05:45:00Z"));
    expect(tg.calls).toHaveLength(1);
    expect(await sentRows()).toEqual([expect.objectContaining({ kind: "weigh", local_date: "2026-10-25" })]);
  });

  it("2026-10-25: train 08:00 EET = 06:00Z; тік 06:00Z випав — покриває 06:15Z", async () => {
    await onlyTrain();
    await env.DB.prepare("UPDATE users SET training_days = '7'").run();
    await tick(at("2026-10-25T05:45:00Z"));
    expect(tg.calls).toHaveLength(0);
    await tick(at("2026-10-25T06:15:00Z"));
    expect(tg.calls).toHaveLength(1);
  });

  it("2027-03-28 (EET → EEST): weigh 07:30 = 04:30Z; тік 04:30Z випав — шле 05:15Z (T+45); 05:30Z (T+60) уже ні", async () => {
    await onlyWeigh();
    await tick(at("2027-03-28T05:30:00Z"));
    expect(tg.calls).toHaveLength(0);
    await tick(at("2027-03-28T05:15:00Z"));
    expect(tg.calls).toHaveLength(1);
  });

  it("2027-03-28: train 08:00 EEST = 05:00Z", async () => {
    await onlyTrain();
    await env.DB.prepare("UPDATE users SET training_days = '7'").run();
    await tick(at("2027-03-28T04:45:00Z"));
    expect(tg.calls).toHaveLength(0);
    await tick(at("2027-03-28T05:00:00Z"));
    expect(tg.calls).toHaveLength(1);
  });

  it("T+45 після T — ні (заявка); без T — T+45 шле", async () => {
    await onlyTrain();
    await tick(MON_0800);
    await tick(MON_0800 + 45 * MIN);
    expect(tg.calls).toHaveLength(1); // лише тік T
    await repo.releaseReminder(OWNER, "train", "2026-10-19"); // «без T»
    await tick(MON_0800 + 45 * MIN);
    expect(tg.calls).toHaveLength(2);
  });
});

describe("P2.3.8 ізоляція користувачів", () => {
  it("tz = «Bad/Zone» в одного — інший отримує нагадування, помилка рахується", async () => {
    await env.DB.prepare("INSERT INTO users (id, first_name, tz, created_at) VALUES (?, 'Хтось', 'Bad/Zone', 0)").bind(OTHER).run();
    await onlyTrain();
    const c = await tick(MON_0800);
    expect(c).toMatchObject({ sent: 1, errors: 1 });
    expect(tg.calls.map((x) => x.payload.chat_id)).toEqual([OWNER]);
  });

  it("помилка в одній парі (train) не блокує іншу (weigh)", async () => {
    const broken = { ...repo, getActiveProgram: () => Promise.reject(new Error("збій")) };
    const c = await runCron(env, MON_0800, { repo: broken as typeof repo, fetch: tg.fetch });
    expect(c.sent).toBe(1);
    expect(c.errors).toBe(1);
    expect(tg.texts()[0]).toMatch(/^⚖️/);
  });
});

describe("P2.3.7 недільний звіт", () => {
  // Нд 2026-10-25, EET (+2): 19:00 = 17:00Z. Тиждень Пн 19.10 — Нд 25.10.
  const SUN_1900 = at("2026-10-25T17:00:00Z");
  const strip = (s: string): string => s.replace(/<\/?[a-z]+>/g, "");

  async function addWorkout(day: "A" | "B", startedAt: number, sets: [number, number, number, number][], status: "done" | "abandoned" = "done"): Promise<number> {
    const d = (await repo.getProgramDay(OWNER, day))!;
    const w = await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, ?, ?, ?, ?)").bind(OWNER, d.id, status, startedAt, startedAt + 3_000_000, status === "done" ? 3 : null).run();
    const setNo = new Map<number, number>(); // set_no рахується в межах вправи
    for (const [weight, reps, slotIdx, skipped] of sets) {
      const slot = d.slots[slotIdx]!;
      const no = (setNo.get(slotIdx) ?? 0) + 1;
      setNo.set(slotIdx, no);
      await env.DB.prepare("INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(w.meta.last_row_id, slot.id, slot.exercise.id, no, skipped ? null : weight, skipped ? null : reps, weight, Math.max(reps, 1), skipped)
        .run();
    }
    return w.meta.last_row_id;
  }

  it("текст збігається зі знімком: тренування, підходи, обсяг, рекорд, середня вага, «далі»", async () => {
    await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run();
    // Минулий тиждень (Пн 12.10): присідання 60 × 8 — база; ваги тіла 80,0 · 79,6.
    await addWorkout("A", at("2026-10-12T07:00:00Z"), [[60, 8, 0, 0]]);
    // Цей тиждень: Пн A, Ср B, Пт A. У Пт присідання 62,5 × 6 — рекорд (+2,5).
    await addWorkout("A", at("2026-10-19T07:00:00Z"), [[60, 8, 0, 0], [60, 8, 0, 0], [45, 10, 1, 0]]);
    await addWorkout("B", at("2026-10-21T07:00:00Z"), [[40, 10, 0, 0], [40, 10, 0, 0]]);
    await addWorkout("A", at("2026-10-23T07:00:00Z"), [[62.5, 6, 0, 0], [60, 8, 0, 0], [0, 0, 1, 1]]);
    await repo.upsertBodyWeight(OWNER, "2026-10-13", 800, 1);
    await repo.upsertBodyWeight(OWNER, "2026-10-15", 796, 1);
    await repo.upsertBodyWeight(OWNER, "2026-10-20", 792, 1);
    await repo.upsertBodyWeight(OWNER, "2026-10-22", 790, 1);
    await repo.upsertBodyWeight(OWNER, "2026-10-24", 788, 1);
    await tick(SUN_1900);
    expect(tg.calls).toHaveLength(1);
    const volume = 60 * 8 * 2 + 45 * 10 + 40 * 10 * 2 + 62.5 * 6 + 60 * 8; // 960 + 450 + 800 + 375 + 480
    expect(volume).toBe(3065);
    expect(strip(tg.texts()[0]!)).toBe(
      [
        "📊 Тиждень 19–25 жовтня",
        "Тренувань: 3 з 3 · Підходів: 7 · Обсяг: 3 065 кг",
        "🏆 Нові рекорди: Присідання зі штангою — 62,5 кг × 6",
        "⚖️ Середня вага 79,0 кг (−0,8 до минулого тижня)",
        "Далі: Все тіло B (ноги, спина, груди) — /trening",
      ].join("\n"),
    );
    expect((await sentRows())[0]).toMatchObject({ kind: "report", local_date: "2026-10-25" });
  });

  it("R-2 R4: кинуте (abandoned) тренування тижня не входить у «Тренувань/Підходів/Обсяг», а його підхід — у рекорди", async () => {
    // Одне правило (R-2, дрібниця 4): лічильники — лише done (спека §4); рекорд — з усіх зарахованих підходів, як підсумок і /progres.
    await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run();
    await addWorkout("A", at("2026-10-12T07:00:00Z"), [[60, 8, 0, 0]]);
    await addWorkout("A", at("2026-10-19T07:00:00Z"), [[60, 8, 0, 0], [60, 8, 0, 0], [45, 10, 1, 0]]);
    await addWorkout("B", at("2026-10-21T07:00:00Z"), [[40, 10, 0, 0], [40, 10, 0, 0]]);
    await addWorkout("A", at("2026-10-23T07:00:00Z"), [[62.5, 6, 0, 0], [60, 8, 0, 0], [0, 0, 1, 1]]);
    await addWorkout("A", at("2026-10-24T07:00:00Z"), [[70, 3, 0, 0], [45, 10, 1, 0]], "abandoned"); // Сб, кинуте
    await tick(SUN_1900);
    const text = strip(tg.texts()[0]!);
    expect(text).toContain("Тренувань: 3 з 3 · Підходів: 7 · Обсяг: 3 065 кг");
    expect(text).toContain("🏆 Нові рекорди: Присідання зі штангою — 70 кг × 3");
  });

  it("нуль тренувань, але є вага — без докорів, з «далі»", async () => {
    await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run();
    await repo.upsertBodyWeight(OWNER, "2026-10-20", 790, 1);
    await tick(SUN_1900);
    const text = strip(tg.texts()[0]!);
    expect(text).toContain("Цього тижня тренувань не було. Нічого страшного — далі: Все тіло A");
    expect(text).toContain("⚖️ Середня вага 79,0 кг (1 зваж.)");
    expect(text).not.toMatch(/Тренувань:/);
  });

  it("немає ні тренувань, ні ваги за весь час → мовчить, заявки немає", async () => {
    await tick(SUN_1900);
    expect(tg.calls).toHaveLength(0);
    expect(await sentRows()).toEqual([]);
  });

  it("Сб і Нд 18:59 — звіту немає; Нд 20:30 — є (вікно до кінця доби); повторні тіки — ні", async () => {
    await repo.upsertBodyWeight(OWNER, "2026-10-20", 790, 1);
    await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run();
    const reports = () => tg.texts().filter((t) => t.startsWith("📊")).length;
    await tick(at("2026-10-24T17:00:00Z")); // Сб 19:00
    await tick(at("2026-10-25T16:59:00Z")); // Нд 18:59
    expect(reports()).toBe(0);
    await tick(at("2026-10-25T18:30:00Z")); // Нд 20:30
    expect(reports()).toBe(1);
    await tick(at("2026-10-25T18:45:00Z"));
    await tick(at("2026-10-25T21:59:00Z")); // Нд 23:59
    expect(reports()).toBe(1);
  });

  // Д4 рев'ю 2.3: звіт іде з першим тіком ≥ 19:00, тож тиждень закінчується в Нд 19:00 локально, а не опівночі. Інакше тренування Нд після 19:00
  // не потрапляло б ні в цей звіт, ні в наступний (вікно наступного починалося б з Пн 00:00).
  it("межа тижня — Нд 19:00 локально (через перехід часу): тренування Нд після 19:00 і Пн 00:10 — у НАСТУПНОМУ звіті, ніде не губиться й не дублюється", async () => {
    await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run();
    await addWorkout("A", at("2026-10-18T15:30:00Z"), [[50, 10, 0, 0]]); // Нд 18:30 EEST (+3) — до 19:00: минулий тиждень
    await addWorkout("B", at("2026-10-18T16:30:00Z"), [[40, 10, 0, 0]]); // Нд 19:30 EEST — після 19:00: цей тиждень (вікно від 16:00Z, а не 17:00Z)
    await addWorkout("A", at("2026-10-25T16:50:00Z"), [[60, 8, 0, 0]]); // Нд 18:50 EET (+2) — ще цей тиждень
    await addWorkout("B", at("2026-10-25T18:30:00Z"), [[30, 10, 0, 0]]); // Нд 20:30 EET — наступний
    await addWorkout("A", at("2026-10-25T22:10:00Z"), [[20, 10, 0, 0]]); // Пн 00:10 EET — наступний
    await tick(SUN_1900);
    expect(strip(tg.texts()[0]!)).toContain("Тренувань: 2 з 3 · Підходів: 2 · Обсяг: 880 кг");
    await tick(at("2026-11-01T17:00:00Z")); // наступна Нд 19:00 EET
    expect(strip(tg.texts()[1]!)).toContain("Тренувань: 2 з 3 · Підходів: 2 · Обсяг: 500 кг");
  });
});

describe("P2.3.7 і P2.3.11 крон: незалежні збої, cron_state", () => {
  it("purge… кидає — нагадування йдуть, cron_state оновлено", async () => {
    await onlyTrain();
    const broken = { ...repo, purgeProcessedUpdates: () => Promise.reject(new Error("збій")) };
    const c = await runCron(env, MON_0800, { repo: broken as typeof repo, fetch: tg.fetch });
    expect(c).toMatchObject({ sent: 1, errors: 1 });
    expect((await repo.getCronTick())?.tickAt).toBe(MON_0800);
  });

  it("нагадування кидають — прибирання працює (abandonStale), cron_state оновлено", async () => {
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    const stale = MON_0800 - 5 * 3_600_000;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at) VALUES (?, ?, 'active', ?)").bind(OWNER, dayA.id, stale).run();
    const broken = { ...repo, getReminderUsers: () => Promise.reject(new Error("збій")) };
    const c = await runCron(env, MON_0800, { repo: broken as typeof repo, fetch: tg.fetch });
    expect(c.errors).toBe(1);
    const row = await env.DB.prepare("SELECT status FROM workouts WHERE started_at = ?").bind(stale).first<{ status: string }>();
    expect(row?.status).toBe("abandoned");
    expect((await repo.getCronTick())?.tickAt).toBe(MON_0800);
  });

  it("без токена — помилка в лозі, але cron_state й прибирання працюють", async () => {
    const c = await runCron({ ...env, TELEGRAM_BOT_TOKEN: undefined }, MON_0800, { fetch: tg.fetch });
    expect(c.errors).toBe(1);
    expect((await repo.getCronTick())?.tickAt).toBe(MON_0800);
  });

  it("кожен тік пише last_tick_at = now (навіть без нагадувань), один рядок", async () => {
    await tick(at("2026-10-20T12:00:00Z"));
    expect((await repo.getCronTick())?.tickAt).toBe(at("2026-10-20T12:00:00Z"));
    await tick(at("2026-10-20T12:15:00Z"));
    expect((await repo.getCronTick())?.tickAt).toBe(at("2026-10-20T12:15:00Z"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cron_state").first<{ n: number }>())!.n).toBe(1);
  });

  it("один лог із лічильниками без текстів", async () => {
    await onlyTrain();
    await tick(MON_0800);
    expect(spies.log.mock.calls).toEqual([["cron tick", { sent: 1, skipped: 0, released: 0, errors: 0 }]]);
  });
});

describe("P2.3.12 білий список у кроні (Д7 рев'ю 2.3)", () => {
  it("користувач поза ALLOWED_TELEGRAM_IDS у users: нагадування йдуть лише власнику, заявок чужому немає", async () => {
    await env.DB.prepare("INSERT INTO users (id, first_name, created_at) VALUES (?, 'Хтось', 0)").bind(OTHER).run();
    await env.DB.prepare("UPDATE users SET weigh_time = NULL").run();
    await runCron({ ...env, ALLOWED_TELEGRAM_IDS: String(OWNER) }, MON_0800, { fetch: tg.fetch, timeoutMs: 50 });
    expect(tg.calls.map((x) => x.payload.chat_id)).toEqual([OWNER]);
    expect((await sentRows()).map((r) => r.user_id)).toEqual([OWNER]);
  });

  it("список не заданий → нікому (fail closed, як вебхук); тік і прибирання відбуваються", async () => {
    await env.DB.prepare("UPDATE users SET weigh_time = NULL").run();
    const c = await runCron({ ...env, ALLOWED_TELEGRAM_IDS: undefined }, MON_0800, { fetch: tg.fetch, timeoutMs: 50 });
    expect(c).toEqual({ sent: 0, skipped: 0, released: 0, errors: 0 });
    expect(tg.calls).toHaveLength(0);
    expect((await repo.getCronTick())?.tickAt).toBe(MON_0800);
  });
});

describe("P2.3.11 /health: вік тіку й тіку без помилок (В1 рев'ю)", () => {
  // Кеш /health між викликами скидаємо: тут стан БД і «годинник» міняються всередині тесту; сам кеш — у «Д8» нижче.
  const health = async (now: number): Promise<{ status: number; body: string }> => {
    resetHealthCache();
    const res = await handleRequest(new Request("https://example.com/health"), { ...env, CF_VERSION_METADATA: undefined }, async () => {}, () => now);
    return { status: res.status, body: await res.text() };
  };

  it("тіку не було — `ok cron=? ok=?`", async () => {
    expect(await health(MON_0800)).toEqual({ status: 200, body: "ok cron=? ok=?" });
  });
  it("вік у хвилинах (округлення вниз)", async () => {
    await repo.touchCron(MON_0800);
    expect(await health(MON_0800 + 7 * MIN + 59_000)).toEqual({ status: 200, body: "ok cron=7m ok=7m" });
    expect(await health(MON_0800)).toEqual({ status: 200, body: "ok cron=0m ok=0m" });
  });
  it("годинник «назад» не дає від'ємного віку", async () => {
    await repo.touchCron(MON_0800);
    expect((await health(MON_0800 - MIN)).body).toBe("ok cron=0m ok=0m");
  });
  it("тіло починається з `ok` (моніторингу, що чекає «ok», достатньо)", async () => {
    expect((await health(MON_0800)).body.startsWith("ok")).toBe(true);
  });

  it("тік, що впав (немає токена): cron свіжий, ok не оновлюється — видно мовчазну відмову", async () => {
    await runCron(env, MON_0800, { fetch: tg.fetch }); // успішний тік
    await runCron({ ...env, TELEGRAM_BOT_TOKEN: undefined }, MON_0800 + 15 * MIN, { fetch: tg.fetch });
    await runCron({ ...env, TELEGRAM_BOT_TOKEN: undefined }, MON_0800 + 30 * MIN, { fetch: tg.fetch });
    expect(await repo.getCronTick()).toEqual({ tickAt: MON_0800 + 30 * MIN, okAt: MON_0800 });
    expect((await health(MON_0800 + 31 * MIN)).body).toBe("ok cron=1m ok=31m");
  });
  it("помилка в одній парі (Bad/Zone) теж не дає ok; після одужання ok знову оновлюється", async () => {
    await env.DB.prepare("INSERT INTO users (id, first_name, tz, created_at) VALUES (?, 'Хтось', 'Bad/Zone', 0)").bind(OTHER).run();
    await tick(MON_0800);
    expect(await repo.getCronTick()).toEqual({ tickAt: MON_0800, okAt: null });
    expect((await health(MON_0800)).body).toBe("ok cron=0m ok=?");
    await env.DB.prepare("UPDATE users SET tz = 'Europe/Kyiv' WHERE id = ?").bind(OTHER).run();
    await tick(MON_0800 + 15 * MIN);
    expect((await repo.getCronTick())?.okAt).toBe(MON_0800 + 15 * MIN);
  });
  it("таймаут Telegram (невизначена доля) теж рахується помилкою тіку", async () => {
    await tick(MON_0800, ["hang"]);
    expect((await repo.getCronTick())?.okAt).toBeNull();
  });
});

describe("В2 рев'ю: локальна дата за tz користувача, не за UTC (пояси поза Києвом)", () => {
  const setTz = (tz: string, extra = "") => env.DB.prepare(`UPDATE users SET tz = ?${extra}`).bind(tz).run();

  it("Нью-Йорк, Нд 20:30 EDT = Пн 00:30Z: звіт із local_date неділі й тижнем 19–25 жовтня", async () => {
    await setTz("America/New_York", ", weigh_time = NULL, remind_time = NULL");
    await repo.upsertBodyWeight(OWNER, "2026-10-20", 790, 1);
    await tick(at("2026-10-26T00:30:00Z"));
    expect(tg.texts()).toHaveLength(1);
    expect(tg.texts()[0]).toContain("Тиждень 19–25 жовтня");
    expect((await sentRows())[0]).toMatchObject({ kind: "report", local_date: "2026-10-25" });
  });

  it("Токіо, Пн 08:00 JST = Нд 23:00Z: train із local_date понеділка (UTC-дата була б неділею)", async () => {
    await setTz("Asia/Tokyo", ", weigh_time = NULL");
    await tick(at("2026-10-18T23:00:00Z"));
    expect(tg.texts()[0]).toContain("Сьогодні тренування");
    expect((await sentRows())[0]).toMatchObject({ kind: "train", local_date: "2026-10-19" });
  });

  it("Токіо, 07:30 JST = Нд 22:30Z: weigh із local_date понеділка; вага «сьогодні» — за локальною датою", async () => {
    await setTz("Asia/Tokyo", ", remind_time = NULL");
    await repo.upsertBodyWeight(OWNER, "2026-10-18", 790, 1); // локально це «вчора»: не блокує
    await tick(at("2026-10-18T22:30:00Z"));
    expect(tg.calls).toHaveLength(1);
    expect((await sentRows())[0]).toMatchObject({ kind: "weigh", local_date: "2026-10-19" });
  });

  it("Нью-Йорк: тренування сьогодні за локальною добою (Пн 21:00 EDT = Вт 01:00Z) блокує нагадування Пн", async () => {
    await setTz("America/New_York", ", weigh_time = NULL, remind_time = '09:00'");
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    // Пн 2026-10-19 07:00 EDT = 11:00Z — тренування; нагадування Пн 09:15 EDT = 13:15Z має мовчати.
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', ?, ?, 3)").bind(OWNER, dayA.id, at("2026-10-19T11:00:00Z"), at("2026-10-19T12:00:00Z")).run();
    await tick(at("2026-10-19T13:15:00Z"));
    expect(tg.calls).toHaveLength(0);
  });
});
