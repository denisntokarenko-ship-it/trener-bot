import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { OWNER, botInfo, env, fakeTelegram, resetDb, textUpdate, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const T0 = Date.UTC(2025, 9, 20, 7, 0); // пн
const DAY = 86_400_000;
let tg = fakeTelegram();
let updateId = 1;
let nowMs = T0 + 10 * DAY;

async function say(text: string): Promise<string> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => nowMs });
  await handleRequest(webhookRequest(textUpdate(updateId++, OWNER, text)), env, handler);
  return String(tg.calls.filter((c) => c.method === "sendMessage").at(-1)?.payload.text);
}

beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  updateId = 1;
  nowMs = T0 + 10 * DAY;
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
});

/** Тренування дня: по `sets` підходів кожного слота з вагою/повторами; abandoned — без оцінки. */
async function seedWorkout(dayCode: string, startedAt: number, status: "done" | "abandoned", weightBySlot: (slot: number) => [number, number]): Promise<void> {
  const day = (await repo.getProgramDay(OWNER, dayCode))!;
  const w = (await repo.startWorkout(OWNER, day.id, startedAt))!.workout;
  for (const [i, slot] of day.slots.entries()) {
    const [weight, reps] = weightBySlot(i);
    for (let n = 1; n <= slot.sets; n++) {
      await repo.upsertSet(OWNER, {
        workoutId: w.id,
        programExerciseId: slot.id,
        exerciseId: slot.exercise.id,
        setNo: n,
        weightKg: weight,
        reps,
        prescribedWeightKg: weight,
        prescribedReps: reps,
        skipped: false,
      });
    }
  }
  if (status === "done") await repo.finishWorkout(OWNER, w.id, 4, startedAt + 3_000_000);
  else await repo.abandonStale(startedAt + 5 * 3_600_000);
}

describe("/progres", () => {
  it("немає тренувань", async () => {
    expect(await say("/progres")).toBe("Ще немає тренувань. Почни: /trening");
  });

  it("7 тренувань → 5 найновіших, від нових до старих, з локальною датою", async () => {
    for (let i = 0; i < 7; i++) await seedWorkout(i % 2 === 0 ? "A" : "B", T0 + i * DAY, "done", () => [20, 8]);
    const text = await say("/progres");
    const heads = text.split("\n\n").map((b) => b.split("\n")[0]);
    expect(heads).toEqual(["26.10 (нд) · Все тіло A · 4/5", "25.10 (сб) · Все тіло B · 4/5", "24.10 (пт) · Все тіло A · 4/5", "23.10 (чт) · Все тіло B · 4/5", "22.10 (ср) · Все тіло A · 4/5"]);
    expect(text).toContain("Присідання зі штангою 20×8,8,8");
  });

  it("abandoned — «не завершене»; active не показується", async () => {
    await seedWorkout("A", T0, "abandoned", () => [20, 8]);
    const day = (await repo.getProgramDay(OWNER, "B"))!;
    await repo.startWorkout(OWNER, day.id, T0 + DAY);
    const text = await say("/progres");
    expect(text.split("\n\n")).toHaveLength(1);
    expect(text.startsWith("20.10 (пн) · Все тіло A · не завершене")).toBe(true);
  });

  it("чужі тренування не показуються (ізоляція)", async () => {
    await repo.upsertUser(222, "Хтось", 0);
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const day = (await repo.getProgramDay(222, "A"))!;
    const w = (await repo.startWorkout(222, day.id, T0))!.workout;
    await repo.finishWorkout(222, w.id, 3, T0 + 1);
    expect(await say("/progres")).toBe("Ще немає тренувань. Почни: /trening");
  });
});

describe("/prohrama", () => {
  it("без done — день A, обидва дні зі слотами, калібрування без active", async () => {
    const text = await say("/prohrama");
    expect(text).toContain("<b>Все тіло A</b> · ноги, груди, спина\n1. Присідання зі штангою — 3 × 6–10");
    expect(text).toContain("<b>Все тіло B</b> · ноги, спина, груди\n1. Румунська тяга зі штангою");
    expect(text).toContain("➡️ Наступне тренування: Все тіло A (ноги, груди, спина)\n");
    expect(text).not.toContain("Зараз триває");
  });

  it("після done A — наступний B з призначеними вагами", async () => {
    await seedWorkout("A", T0, "done", () => [20, 8]);
    const text = await say("/prohrama");
    expect(text).toContain("➡️ Наступне тренування: Все тіло B (ноги, спина, груди)");
    const next = text.slice(text.indexOf("➡️"));
    expect(next).toMatch(/Румунська тяга зі штангою — \d+(,\d+)? кг × \d+/);
  });

  it("є active — рядок «Зараз триває»", async () => {
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    await repo.startWorkout(OWNER, day.id, nowMs - 1000);
    expect((await say("/prohrama")).endsWith("Зараз триває: Все тіло A — /trening, щоб продовжити")).toBe(true);
  });

  it("без програми — повідомлення про сид", async () => {
    await resetDb();
    await repo.upsertUser(OWNER, "Денис", 0);
    expect(await say("/prohrama")).toBe("Програму не знайдено — запусти сид (docs/RUNBOOK.md).");
  });
});

describe("/start і меню команд", () => {
  it("перелічує команди меню", async () => {
    const text = await say("/start");
    for (const c of ["/trening", "/progres", "/prohrama"]) expect(text).toContain(c);
  });
});
