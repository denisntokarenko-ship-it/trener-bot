import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { NO_PROGRAM, PROGRESS_EMPTY } from "../src/bot/texts";
import { OWNER, botInfo, callbackUpdate, env, fakeTelegram, resetDb, textUpdate, webhookRequest } from "./helpers";

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

/** Тап по callback_data на повідомленні /progres: повертає текст і клавіатуру редагування. */
async function tap(data: string): Promise<{ text: string; buttons: { text: string; callback_data?: string }[]; answered: number }> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => nowMs });
  const upd = callbackUpdate(updateId++, OWNER);
  (upd.callback_query as { data: string }).data = data;
  await handleRequest(webhookRequest(upd), env, handler);
  const edit = tg.calls.filter((c) => c.method === "editMessageText").at(-1)!;
  const markup = edit.payload.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] } | undefined;
  return { text: String(edit.payload.text), buttons: (markup?.inline_keyboard ?? []).flat(), answered: tg.calls.filter((c) => c.method === "answerCallbackQuery").length };
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
  it("немає ні ваги, ні тренувань → підказка без кнопки", async () => {
    expect(await say("/progres")).toBe(PROGRESS_EMPTY);
    const sent = tg.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(sent.payload.reply_markup).toBeUndefined();
  });

  it("7 тренувань → 5 найновіших, від нових до старих, з локальною датою", async () => {
    for (let i = 0; i < 7; i++) await seedWorkout(i % 2 === 0 ? "A" : "B", T0 + i * DAY, "done", () => [20, 8]);
    await say("/progres");
    const text = (await tap("p:r")).text;
    const heads = text.split("\n\n").slice(1).map((b) => b.split("\n")[0]);
    expect(heads).toEqual(["<b>26.10 (нд) · Все тіло A</b> · 4/5", "<b>25.10 (сб) · Все тіло B</b> · 4/5", "<b>24.10 (пт) · Все тіло A</b> · 4/5", "<b>23.10 (чт) · Все тіло B</b> · 4/5", "<b>22.10 (ср) · Все тіло A</b> · 4/5"]);
    expect(text).toContain("Присідання зі штангою 20×8,8,8");
  });

  it("abandoned — «не завершене»; active не показується", async () => {
    await seedWorkout("A", T0, "abandoned", () => [20, 8]);
    const day = (await repo.getProgramDay(OWNER, "B"))!;
    await repo.startWorkout(OWNER, day.id, T0 + DAY);
    await say("/progres");
    const text = (await tap("p:r")).text;
    expect(text.split("\n\n")).toHaveLength(2); // заголовок + одне обірване
    expect(text.split("\n\n")[1]!.startsWith("<b>20.10 (пн) · Все тіло A</b> · не завершене")).toBe(true);
  });

  it("чужі тренування не показуються (ізоляція)", async () => {
    await repo.upsertUser(222, "Хтось", 0);
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const day = (await repo.getProgramDay(222, "A"))!;
    const w = (await repo.startWorkout(222, day.id, T0))!.workout;
    const slot = day.slots[0]!;
    await repo.upsertSet(222, { workoutId: w.id, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 1, weightKg: 90, reps: 5, prescribedWeightKg: 90, prescribedReps: 5, skipped: false });
    await repo.finishWorkout(222, w.id, 3, T0 + 1);
    expect(await say("/progres")).toBe(PROGRESS_EMPTY);
  });
});

/** Тренування дня A: підходи першої вправи — явні пари вага×повтори. */
async function seedSquat(startedAt: number, pairs: [number, number][]): Promise<void> {
  const day = (await repo.getProgramDay(OWNER, "A"))!;
  const w = (await repo.startWorkout(OWNER, day.id, startedAt))!.workout;
  const slot = day.slots[0]!;
  for (const [i, [weight, reps]] of pairs.entries()) {
    await repo.upsertSet(OWNER, { workoutId: w.id, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: i + 1, weightKg: weight, reps, prescribedWeightKg: weight, prescribedReps: reps, skipped: false });
  }
  await repo.finishWorkout(OWNER, w.id, 4, startedAt + 3_000_000);
}

describe("/progres — повний екран (2.2)", () => {
  it("P2.2.1: присідання 40×8 → 60×8, рекорд 62,5×6 (23.10), e1RM 76; вага з анкети й вікна", async () => {
    await seedSquat(T0, [[40, 8]]);
    await seedSquat(T0 + 3 * DAY, [[62.5, 6], [60, 8]]);
    await repo.upsertProfile(OWNER, { weightKg: 82 }, 0);
    for (const [d, dg] of [["2025-10-10", 800], ["2025-10-12", 802], ["2025-10-18", 798], ["2025-10-20", 798], ["2025-10-26", 794], ["2025-10-28", 794], ["2025-10-30", 794]] as const) {
      await repo.upsertBodyWeight(OWNER, d, dg, 0);
    }
    const text = await say("/progres");
    expect(text).toContain("⚖️ Вага: 82,0 (анкета) → 79,4 (середнє 7 днів) · −2,6 кг\n   Тиждень до тижня: −0,4 кг · 7-денні вікна: 80,1 · 79,8 · 79,4");
    expect(text).toContain("<b>Присідання зі штангою</b>\n   Старт 40 × 8 → зараз 60 × 8 · рекорд 62,5 × 6 (23.10)\n   e1RM ≈ 76 кг");
  });

  it("P2.2.3: 35 тренувань — рекорд із першого не випадає з вікна", async () => {
    await seedSquat(T0 - 40 * DAY, [[100, 5]]);
    for (let i = 0; i < 34; i++) await seedSquat(T0 - (34 - i) * DAY, [[20, 8]]);
    const text = await say("/progres");
    expect(text).toContain("рекорд 100 × 5");
    expect(text).toContain("Старт 100 × 5 → зараз 20 × 8");
  });

  it("P2.2.4: лише вага з анкети — рядок ваги без вправ", async () => {
    await repo.upsertProfile(OWNER, { weightKg: 82 }, 0);
    expect(await say("/progres")).toBe("📈 <b>Прогрес</b>\n⚖️ Вага: 82,0 (анкета)");
  });

  it("P2.2.4: пропущені підходи не дають вправи в списку", async () => {
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    const w = (await repo.startWorkout(OWNER, day.id, T0))!.workout;
    const slot = day.slots[0]!;
    await repo.upsertSet(OWNER, { workoutId: w.id, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 1, weightKg: null, reps: null, prescribedWeightKg: 40, prescribedReps: 8, skipped: true });
    await repo.finishWorkout(OWNER, w.id, 3, T0 + 1);
    expect(await say("/progres")).toBe(PROGRESS_EMPTY);
  });

  it("P2.2.5: [📜] і [⬅️] редагують те саме повідомлення", async () => {
    await seedSquat(T0, [[40, 8]]);
    await say("/progres");
    const sent = tg.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    const kb = (sent.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
    expect(kb.map((b) => b.text)).toEqual(["📜 Останні тренування"]);
    const recent = await tap(kb[0]!.callback_data);
    expect(recent.text).toContain("Останні тренування");
    expect(recent.text).toContain("Присідання зі штангою 40×8");
    expect(recent.buttons.map((b) => b.text)).toEqual(["⬅️ Назад"]);
    const back = await tap(recent.buttons[0]!.callback_data!);
    expect(back.text).toContain("<b>Прогрес</b>");
    expect(back.buttons.map((b) => b.text)).toEqual(["📜 Останні тренування"]);
  });
});

describe("/prohrama", () => {
  it("без done — день A, обидва дні зі слотами, калібрування без active", async () => {
    const text = await say("/prohrama");
    expect(text).toContain("<b>Все тіло A</b> · ноги, груди, спина\n1. Присідання зі штангою — 3 × 6–10");
    expect(text).toContain("<b>Все тіло B</b> · ноги, спина, груди\n1. Румунська тяга зі штангою");
    expect(text).toContain("➡️ <b>Наступне тренування: Все тіло A (ноги, груди, спина)</b>\n");
    expect(text).not.toContain("Зараз триває");
  });

  it("після done A — наступний B з призначеними вагами", async () => {
    await seedWorkout("A", T0, "done", () => [20, 8]);
    const text = await say("/prohrama");
    expect(text).toContain("➡️ <b>Наступне тренування: Все тіло B (ноги, спина, груди)</b>");
    const next = text.slice(text.indexOf("➡️"));
    expect(next).toMatch(/Румунська тяга зі штангою — \d+(,\d+)? кг × \d+/);
  });

  it("є active — рядок «Зараз триває»", async () => {
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    await repo.startWorkout(OWNER, day.id, nowMs - 1000);
    expect((await say("/prohrama")).endsWith("Зараз триває: <b>Все тіло A</b> — /trening, щоб продовжити")).toBe(true);
  });

  it("без програми — повідомлення про сид", async () => {
    await resetDb();
    await repo.upsertUser(OWNER, "Денис", 0);
    expect(await say("/prohrama")).toBe(NO_PROGRAM);
  });
});

describe("/start і меню команд", () => {
  it("перелічує команди меню", async () => {
    const text = await say("/start");
    for (const c of ["/trening", "/progres", "/prohrama"]) expect(text).toContain(c);
  });
});
