import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { encodeCb, parseCb } from "../src/bot/callbacks";
import { CHAT_NO_KEY, NOT_UNDERSTOOD, NO_PROGRAM, RATING_TEXT } from "../src/bot/texts";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { OWNER, botInfo, env, fakeTelegram, resetDb, textUpdate, webhookRequest, outgoingProblems } from "./helpers";

const repo = createRepo(createDb(env.DB));
const T0 = 1_760_000_000_000;
let nowMs = T0;
let tg = fakeTelegram();
let updateId = 1;

interface Button {
  text: string;
  callback_data: string; // у URL-кнопки [🎥 Відео] насправді відсутнє
}
interface View {
  method: string;
  text: string;
  buttons: Button[];
}

async function send(update: Update): Promise<void> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => nowMs });
  await handleRequest(webhookRequest(update), env, handler);
}

const say = (text: string) => send(textUpdate(updateId++, OWNER, text));

function cbUpdate(data: string, messageId = 7): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: "cb" + updateId,
      from: { id: OWNER, is_bot: false, first_name: "Денис" },
      chat_instance: "ci",
      data,
      message: { message_id: messageId, date: 0, chat: { id: OWNER, type: "private", first_name: "Денис" }, text: "екран" },
    },
  } as Update;
}

const tap = (data: string) => send(cbUpdate(data));

/** Останнє повідомлення-екран (sendMessage чи editMessageText) з розібраною клавіатурою. */
function view(): View {
  const call = [...tg.calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")!;
  const markup = call.payload.reply_markup as { inline_keyboard: Button[][] } | undefined;
  return { method: call.method, text: String(call.payload.text), buttons: (markup?.inline_keyboard ?? []).flat() };
}

const button = (prefix: string): Button => {
  const b = view().buttons.find((x) => x.text.startsWith(prefix));
  if (!b) throw new Error(`немає кнопки «${prefix}» на екрані:\n${view().text}\n${view().buttons.map((x) => x.text).join(" | ")}`);
  return b;
};
const press = (prefix: string) => tap(button(prefix).callback_data);

const answers = () => tg.calls.filter((c) => c.method === "answerCallbackQuery");
const lastAnswer = () => answers().at(-1)?.payload.text as string | undefined;

async function sets(): Promise<{ exercise_id: number; program_exercise_id: number; set_no: number; weight_kg: number | null; reps: number | null; skipped: number; prescribed_weight_kg: number }[]> {
  return (await env.DB.prepare("SELECT exercise_id, program_exercise_id, set_no, weight_kg, reps, skipped, prescribed_weight_kg FROM workout_sets ORDER BY id").all()).results as never;
}
const setCount = async () => (await sets()).length;
const workoutRow = () => env.DB.prepare("SELECT id, status, effort, finished_at, await_input FROM workouts ORDER BY id DESC").first<{ id: number; status: string; effort: number | null; finished_at: number | null; await_input: string | null }>();

/** Проходить день: натискає [✅] на кожному екрані вправи до екрана оцінки. Повертає кількість натискань. */
async function playThrough(): Promise<number> {
  let presses = 0;
  while (!view().text.startsWith("✅ <b>Готово!</b>")) {
    await press("✅");
    presses++;
    if (presses > 40) throw new Error("не завершується:\n" + view().text);
  }
  return presses;
}

beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  nowMs = T0;
  updateId = 1;
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
});

// 1b.4: кожен вихідний виклик кожного тесту — HTML, валідна розмітка, ліміти Telegram.
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
});

/** Записує done-тренування дня зі слотом-підходами (історія для прогресії). */
async function seedDone(dayCode: string, startedAt: number, rows: { slot: number; exerciseId?: number; weight: number; reps: number }[], effort = 3): Promise<void> {
  const day = (await repo.getProgramDay(OWNER, dayCode))!;
  const w = (await repo.startWorkout(OWNER, day.id, startedAt))!.workout;
  const counters = new Map<number, number>();
  for (const r of rows) {
    const slot = day.slots[r.slot]!;
    const n = (counters.get(slot.id) ?? 0) + 1;
    counters.set(slot.id, n);
    await repo.upsertSet(OWNER, {
      workoutId: w.id,
      programExerciseId: slot.id,
      exerciseId: r.exerciseId ?? slot.exercise.id,
      setNo: n,
      weightKg: r.weight,
      reps: r.reps,
      prescribedWeightKg: r.weight,
      prescribedReps: r.reps,
      skipped: false,
    });
  }
  await repo.finishWorkout(OWNER, w.id, effort, startedAt + 3_000_000);
}

/** /trening; новий день спершу показує екран розминки — проходимо його кнопкою [⏭ Пропустити] (нові тести розминки — без цього). */
const trening = async (): Promise<void> => {
  await say("/trening");
  const skip = view().buttons.find((b) => (b.callback_data ?? "").startsWith("u:") && b.text.includes("Пропустити"));
  if (skip) await tap(skip.callback_data);
};

describe("callback_data: кодек", () => {
  it("round-trip і межа 64 байти", () => {
    const data = encodeCb("t", { w: 4294967295, p: 4294967295, e: 4294967295, n: 10, r: 50, g: 5000, t: 1 });
    expect(new TextEncoder().encode(data).byteLength).toBeLessThanOrEqual(64);
    expect(parseCb(data)).toMatchObject({ a: "t", w: 4294967295, n: 10, r: 50, g: 5000, t: 1 });
    expect(() => encodeCb("t", { w: 9e15, p: 9e15, e: 9e15, n: 10, r: 50, g: 5000, t: 1 })).toThrow();
  });
  it.each(["", "z:1", "s:1:2:3", "s:1:2:3:4:5:x", "s:1:2:3:11:5:400", "s:1:2:3:1:51:400", "f:1:6", "t:1:2:3:1:5:400:2", "s:0:2:3:1:5:400"])("битий формат «%s» → null", (d) => {
    expect(parseCb(d)).toBeNull();
  });
});

describe("P1.3 записати тренування", () => {
  it("P1.3.1 /trening без active → тренування A, екран вправи 1/5 з призначенням", async () => {
    await trening();
    const w = await workoutRow();
    expect(w?.status).toBe("active");
    expect(view().method).toBe("editMessageText"); // екран розминки (sendMessage) уже замінено першою вправою
    expect(view().text).toContain("Все тіло A · вправа 1/5");
    expect(view().text).toContain("Присідання зі штангою");
    expect(view().text).toContain("Підхід 1/3 · ціль <b>20 кг × 6</b>");
    expect(view().text).toContain("Калібрування: підбери робочу вагу кнопкою ⚖️");
    expect(view().buttons.map((b) => b.text)).toEqual(["✅ 6", "−1", "+1", "⚖️ Вага", "🔁 Замінити", "⏭ Пропустити", "💡 Техніка", "🎥 Відео"]);
  });

  it("P1.3.5 повний прохід дня A: рівно одне натискання на підхід + /trening + оцінка; рядки як очікувано", async () => {
    await trening();
    const presses = await playThrough();
    expect(presses).toBe(14); // 3+3+3+2+3 підходів
    const rows = await sets();
    expect(rows).toHaveLength(14);
    // Присідання: калібрування 20 × 6, усі три підходи.
    expect(rows.slice(0, 3).map((r) => [r.set_no, r.weight_kg, r.reps, r.prescribed_weight_kg])).toEqual([
      [1, 20, 6, 20],
      [2, 20, 6, 20],
      [3, 20, 6, 20],
    ]);
    expect(rows.every((r) => r.skipped === 0)).toBe(true);
    expect(view().text).toBe(RATING_TEXT);
    await press("4");
    const w = await workoutRow();
    expect([w?.status, w?.effort]).toEqual(["done", 4]);
    expect(w?.finished_at).toBe(T0);
    expect(w?.await_input).toBeNull();
    const text = view().text;
    expect(text).toContain("🏋️ <b>Все тіло A</b> · 0 хв");
    expect(text).toContain("Підходів: <b>14 з 14</b>");
    expect(text).toContain("Складність: <b>4/5</b>");
    expect(text).not.toContain("Рекорди");
    expect(text).toContain("Наступне тренування: <b>Все тіло B (ноги, спина, груди)</b>");
    expect(view().buttons).toHaveLength(0);
    // P1.5.6: кожне натискання — рівно один answerCallbackQuery.
    expect(answers()).toHaveLength(presses + 2); // + натискання [⏭ Пропустити] на екрані розминки
  });

  it("P1.3.3 [−1] нічого не пише; [✅ 7] пише reps = 7", async () => {
    await trening();
    await press("−1");
    expect(await setCount()).toBe(0);
    expect(view().buttons[0]!.text).toBe("✅ 5");
    await press("+1");
    await press("+1");
    expect(await setCount()).toBe(0);
    expect(view().buttons[0]!.text).toBe("✅ 7");
    await press("✅");
    expect((await sets()).map((r) => r.reps)).toEqual([7]);
    expect(view().text).toContain("✅ 1: 20 × 7");
    expect(view().text).toContain("Підхід 2/3");
  });

  it("P1.3.2 вага на екрані — з останнього записаного підходу", async () => {
    await trening();
    await press("⚖️");
    await say("45");
    await press("✅");
    expect(view().text).toContain("Підхід 2/3 · ціль <b>45 кг × 6</b>");
    await press("✅");
    expect((await sets()).map((r) => r.weight_kg)).toEqual([45, 45]);
  });
});

describe("P1.4 введення ваги", () => {
  it("підказка, відмова на неправильну вагу, прийняття 45", async () => {
    await trening();
    await press("⚖️");
    const w1 = await workoutRow();
    expect(JSON.parse(w1!.await_input!)).toMatchObject({ n: 1, r: 6, m: 7 });
    expect(view().text).toBe("⚖️ Яка вага для <b>Присідання зі штангою</b>, кг?\nКрок 5 кг, від 20 кг. Наприклад: <code>45</code>");
    await say("47,5");
    expect(view().text).toBe("❌ Не схоже на вагу. Крок 5 кг, від 20 кг. Наприклад: <code>45</code>");
    expect((await workoutRow())!.await_input).toBe(w1!.await_input);
    await say("15");
    expect(view().text).toContain("Не схоже на вагу");
    await say("45");
    expect((await workoutRow())!.await_input).toBeNull();
    const edit = tg.calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(edit.payload).toMatchObject({ message_id: 7, text: "⚖️ <b>45 кг</b>" });
    expect(edit.payload.reply_markup).toBeUndefined();
    expect(view().method).toBe("sendMessage");
    expect(view().text).toContain("Підхід 1/3 · ціль <b>45 кг × 6</b>");
  });

  it("команда при очікуванні знімає його; текст без очікування — не вага, іде в чат (тут ключа немає)", async () => {
    await trening();
    await press("⚖️");
    await say("/start");
    expect((await workoutRow())!.await_input).toBeNull();
    await say("щось");
    expect(view().text).toBe(CHAT_NO_KEY);
  });

  it("[↩️ Скасувати] знімає очікування й повертає екран", async () => {
    await trening();
    await press("⚖️");
    await press("↩️");
    expect((await workoutRow())!.await_input).toBeNull();
    expect(view().text).toContain("Присідання зі штангою");
  });

  it("P1.4.5 друге тренування A стартує з ваги, яку дала прогресія", async () => {
    await seedDone("A", T0 - 86_400_000 * 2, [
      ...[0, 1, 2].map(() => ({ slot: 0, weight: 50, reps: 8 })),
    ]);
    await seedDone("B", T0 - 86_400_000, [{ slot: 0, weight: 40, reps: 8 }]);
    await trening();
    expect(view().text).toContain("Все тіло A · вправа 1/5");
    expect(view().text).toContain("Підхід 1/3 · ціль <b>50 кг × 9</b>");
  });
});

describe("P1.5 повтори, застарілі кнопки й продовження", () => {
  it("P1.5.1 подвійне натискання ✅ того самого підходу → 1 рядок, друге — «Записано»", async () => {
    await trening();
    await press("✅"); // підхід 1
    const set2 = button("✅").callback_data;
    await tap(set2);
    await tap(set2);
    const rows = await sets();
    expect(rows.filter((r) => r.set_no === 2)).toHaveLength(1);
    expect(rows.map((r) => r.set_no)).toEqual([1, 2]);
    expect(lastAnswer()).toBe("Записано");
    expect(answers()).toHaveLength(4); // розминка + 3 натискання
  });

  it("P1.5.3 стара кнопка з іншими повторами → «Кнопка застаріла», рядок не змінено", async () => {
    await trening();
    await press("✅");
    const set2 = button("✅").callback_data;
    await tap(set2);
    const stale = set2.replace(/:6:200$/, ":7:200");
    expect(stale).not.toBe(set2);
    await tap(stale);
    expect(lastAnswer()).toBe("Кнопка застаріла — показую поточний підхід");
    expect((await sets()).find((r) => r.set_no === 2)!.reps).toBe(6);
    expect(await setCount()).toBe(2);
  });

  it("P1.5.2 натискання на завершеному тренуванні → «вже завершене», 0 нових рядків, клавіатуру прибрано", async () => {
    await trening();
    const first = button("✅").callback_data;
    await playThrough();
    await press("5");
    const before = await setCount();
    const rating = tg.calls.filter((c) => c.method === "editMessageText").length;
    // Нове значення повторів — без перевірки статусу кнопка пішла б у «застаріла», а не «завершене».
    await tap(first.replace(/:6:200$/, ":9:200"));
    expect(lastAnswer()).toBe("Тренування вже завершене. /trening — нове");
    expect(await setCount()).toBe(before);
    const markup = tg.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    expect(markup.payload.reply_markup).toEqual({ inline_keyboard: [] });
    expect(tg.calls.filter((c) => c.method === "editMessageText")).toHaveLength(rating);
  });

  it("P2.3.4 повторна оцінка → «Оцінку вже записано», effort не змінено", async () => {
    await trening();
    await playThrough();
    const five = button("5").callback_data;
    await press("3");
    await tap(five);
    expect(lastAnswer()).toBe("Оцінку вже записано");
    expect((await workoutRow())!.effort).toBe(3);
    expect(view().text).toContain("Складність: <b>3/5</b>");
  });

  it("P1.5.4 продовження після «перезапуску»: нове повідомлення-екран слота 3, нового тренування немає", async () => {
    await trening();
    for (let i = 0; i < 6; i++) await press("✅"); // слоти 1 і 2
    expect(view().text).toContain("вправа 3/5");
    const old = view();
    await press("⚖️");
    expect((await workoutRow())!.await_input).not.toBeNull();
    tg.calls.length = 0;
    await trening();
    expect(view().method).toBe("sendMessage");
    expect(view().text).toContain("Все тіло A · вправа 3/5");
    expect(view().text).toContain("Підхід 1/3");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workouts").first("n")).toBe(1);
    expect((await workoutRow())!.await_input).toBeNull();
    expect(old.text).toContain("вправа 3/5");
  });

  it("P1.5.5 active старше 4 год → abandoned, нове на той самий день", async () => {
    await trening();
    await press("✅");
    nowMs = T0 + 5 * 3_600_000;
    await trening();
    const rows = (await env.DB.prepare("SELECT status FROM workouts ORDER BY id").all()).results.map((r) => r.status);
    expect(rows).toEqual(["abandoned", "active"]);
    expect(view().text).toContain("Все тіло A · вправа 1/5");
  });

  it("чужий чи неіснуючий workout → «вже завершене»", async () => {
    await trening();
    await tap(encodeCb("s", { w: 9999, p: 1, e: 1, n: 1, r: 6, g: 200 }));
    expect(lastAnswer()).toBe("Тренування вже завершене. /trening — нове");
    await tap("garbage");
    expect(lastAnswer()).toBe("Кнопка застаріла");
    expect(await setCount()).toBe(0);
  });

  it("p з іншого дня й e не з слота → «Кнопка застаріла», без запису", async () => {
    await trening();
    const w = (await workoutRow())!.id;
    const dayB = (await repo.getProgramDay(OWNER, "B"))!;
    await tap(encodeCb("s", { w, p: dayB.slots[0]!.id, e: dayB.slots[0]!.exercise.id, n: 1, r: 6, g: 200 }));
    expect(lastAnswer()).toBe("Кнопка застаріла");
    const dayA = (await repo.getProgramDay(OWNER, "A"))!;
    await tap(encodeCb("s", { w, p: dayA.slots[0]!.id, e: dayB.slots[0]!.exercise.id, n: 1, r: 6, g: 200 }));
    expect(lastAnswer()).toBe("Кнопка застаріла");
    expect(await setCount()).toBe(0);
  });

  it("[✅] на передчасній оцінці (не всі слоти) → «Кнопка застаріла»", async () => {
    await trening();
    const w = (await workoutRow())!.id;
    await tap(encodeCb("f", { w, q: 4 }));
    expect(lastAnswer()).toBe("Кнопка застаріла");
    expect((await workoutRow())!.status).toBe("active");
  });
});

describe("P2.1 заміна вправи", () => {
  /** B-тренування: зробити останнім done день A, щоб /trening стартував B. */
  async function startDayB(history: Parameters<typeof seedDone>[2] = [{ slot: 0, weight: 40, reps: 8 }]): Promise<void> {
    await seedDone("A", T0 - 86_400_000, history);
    await trening();
    expect(view().text).toContain("Все тіло B");
  }

  it("P2.1.1–3 меню замін, екран заміни, закріплення першим підходом і продовження", async () => {
    // Історія гоблет-присідань (заміна присідань у дні A): 12 × 12 ×3 — rep_max слота жиму ногами (8–12), тож прогресія дасть підвищення.
    await seedDone("A", T0 - 86_400_000, [0, 1, 2].map(() => ({ slot: 0, exerciseId: 11, weight: 12, reps: 12 })));
    await trening();
    const history = await setCount(); // 3 підходи гоблета з історії
    for (let i = 0; i < 3; i++) await press("✅"); // слот 1 (румунська тяга)
    expect(view().text).toContain("вправа 2/5");
    expect(view().text).toContain("Жим ногами");
    await press("🔁");
    expect(view().buttons.map((b) => b.text)).toEqual(["Гоблет-присідання", "Присідання зі штангою", "↩️ Назад"]);
    await press("↩️");
    expect(view().text).toContain("Жим ногами");
    await press("🔁");
    await press("Гоблет-присідання");
    expect(await setCount()).toBe(history + 3); // заміна нічого не пише
    expect(view().text).toContain("Гоблет-присідання");
    expect(view().text).toContain("Підхід 1/3 · ціль <b>14 кг на гантель × 8</b>"); // гоблет — гантельна вправа: вага однієї гантелі // з історії заміни, а не калібрування жиму ногами
    await press("✅");
    const rows = await sets();
    const slot2 = (await repo.getProgramDay(OWNER, "B"))!.slots[1]!;
    expect(rows.at(-1)).toMatchObject({ exercise_id: 11, program_exercise_id: slot2.id, set_no: 1, weight_kg: 14, reps: 8 });
    expect(view().text).toContain("Гоблет-присідання");
    expect(view().text).toContain("Підхід 2/3");
    expect(view().buttons.some((b) => b.text.startsWith("🔁"))).toBe(false);
    // «Перезапуск»: слот 2 і далі — заміна.
    await trening();
    expect(view().text).toContain("Гоблет-присідання");
    expect(view().text).toContain("Підхід 2/3");
    await press("✅");
    await press("✅");
    expect(view().text).toContain("вправа 3/5");
    expect((await sets()).filter((r) => r.exercise_id === 11)).toHaveLength(3 + history);
  });

  it("P2.1.4 у слоті вже є підхід → заміни немає; стара кнопка y і x — «Кнопка застаріла»", async () => {
    await startDayB();
    for (let i = 0; i < 3; i++) await press("✅");
    const swap = button("🔁").callback_data;
    await press("✅");
    expect(view().buttons.some((b) => b.text.startsWith("🔁"))).toBe(false);
    const before = await setCount();
    await tap(swap);
    expect(lastAnswer()).toBe("Кнопка застаріла");
    const w = (await workoutRow())!.id;
    const slot2 = (await repo.getProgramDay(OWNER, "B"))!.slots[1]!;
    await tap(encodeCb("y", { w, p: slot2.id, e: 11 }));
    expect(lastAnswer()).toBe("Кнопка застаріла");
    expect(await setCount()).toBe(before);
    expect((await sets()).at(-1)!.exercise_id).toBe(slot2.exercise.id);
  });

  it("P2.1.5 заміна діє лише в цьому тренуванні: наступне B знову з жимом ногами", async () => {
    await startDayB();
    for (let i = 0; i < 3; i++) await press("✅");
    await press("🔁");
    await press("Гоблет-присідання");
    await playThrough();
    await press("3");
    await seedDone("A", T0 + 86_400_000, [{ slot: 0, weight: 40, reps: 8 }]);
    await trening();
    expect(view().text).toContain("Все тіло B · вправа 1/5");
    for (let i = 0; i < 3; i++) await press("✅");
    expect(view().text).toContain("Жим ногами");
  });
});

describe("P2.2 пропуск", () => {
  it("P2.2.1–2 пропуск пише n…sets, повтор — без змін", async () => {
    await trening();
    await press("✅");
    const skip = button("⏭").callback_data;
    await tap(skip);
    const rows = await sets();
    expect(rows.map((r) => [r.set_no, r.skipped, r.weight_kg, r.reps])).toEqual([
      [1, 0, 20, 6],
      [2, 1, null, null],
      [3, 1, null, null],
    ]);
    expect(view().text).toContain("вправа 2/5");
    await tap(skip);
    expect(await setCount()).toBe(3);
    expect(lastAnswer()).toBe("Записано");
  });

  it("P2.2.3 пропуск останнього слота → екран оцінки; підсумок: підходи й обсяг", async () => {
    await trening();
    for (let i = 0; i < 11; i++) await press("✅"); // слоти 1–4: 3+3+3+2
    expect(view().text).toContain("вправа 5/5");
    await press("⏭");
    expect(view().text.startsWith("✅ <b>Готово!</b>")).toBe(true);
    await press("2");
    expect(view().text).toContain("Підходів: <b>11 з 14</b> (пропущено 3)");
    // Обсяг: Σ вага × повтори; калібрувальні ваги (20, 20, 5, 2) і повтори (6, 6, 8, 8).
    expect(view().text).toContain(`Обсяг: <b>${20 * 6 * 3 + 20 * 6 * 3 + 5 * 8 * 3 + 2 * 8 * 2} кг</b>`);
  });
});

describe("P2.3 рекорди", () => {
  it("P2.3.1–2 рекорд за історією; перша сесія вправи рекорду не дає", async () => {
    // Присідання: попередній максимум 55 кг, і ще одна вправа без історії.
    await seedDone("A", T0 - 86_400_000 * 3, [0, 1, 2].map(() => ({ slot: 0, weight: 55, reps: 8 })));
    await seedDone("B", T0 - 86_400_000 * 2, [{ slot: 0, weight: 40, reps: 8 }]);
    await trening();
    await press("⚖️");
    await say("60");
    await press("✅");
    await press("+1");
    await press("+1");
    await press("✅");
    await press("✅");
    while (!view().text.startsWith("✅ <b>Готово!</b>")) await press("✅");
    await press("4");
    expect(view().text).toContain("🏆 <b>Рекорди</b>");
    const records = view().text.split("🏆 <b>Рекорди</b>\n")[1]!.split("\n").filter((l) => l.startsWith("•"));
    expect(records).toEqual(["• Присідання зі штангою — <b>60 кг × 11</b>"]);
    // Жим лежачи — перша сесія: рекорду немає.
    expect(view().text).not.toContain("Жим лежачи —");
  });

  it("R-2 В2: рекорд у підсумку — по всій історії, без вікна 30 сесій (той самий агрегат, що /progres)", async () => {
    // Присідання: 70 кг у найпершій сесії, далі 39 сесій по 50 кг; сьогодні 60 кг — не рекорд (70 > 60).
    const day = 86_400_000;
    await seedDone("A", T0 - day * 41, [{ slot: 0, weight: 70, reps: 5 }]);
    for (let i = 40; i >= 2; i--) await seedDone("A", T0 - day * i, [{ slot: 0, weight: 50, reps: 8 }]);
    await seedDone("B", T0 - day, [{ slot: 0, weight: 40, reps: 8 }]);
    await trening();
    await press("⚖️");
    await say("60");
    await press("✅");
    while (!view().text.startsWith("✅ <b>Готово!</b>")) await press("✅");
    await press("4");
    expect(view().text).not.toContain("Присідання зі штангою —");
    expect((await env.DB.prepare("SELECT MAX(weight_kg) AS w FROM workout_sets s JOIN workouts w ON w.id = s.workout_id WHERE w.status = 'done' AND w.started_at >= ?").bind(T0).first<{ w: number }>())?.w).toBe(60);
  });
});

describe("P2.4 техніка", () => {
  it("[💡 Техніка] показує 3 рядки cues; наступне редагування ховає", async () => {
    await trening();
    await press("💡");
    const t = view().text;
    const cues = (await repo.getExercise(1))!.cues;
    expect(cues).toHaveLength(3);
    for (const c of cues) expect(t).toContain(c);
    expect(view().buttons.map((b) => b.text)).toContain("✅ 6");
    await press("✅");
    for (const c of cues) expect(view().text).not.toContain(c);
  });
});

describe("N6/N9", () => {
  it("помилка обробника під час натискання все одно відповідає на callback", async () => {
    await trening();
    // Битий JSON у стані очікування не валить текстовий обробник.
    await env.DB.prepare("UPDATE workouts SET await_input = 'не json'").run();
    await say("45");
    expect(view().text).toContain(NOT_UNDERSTOOD);
    expect((await workoutRow())!.await_input).toBeNull();
  });

  it("немає програми → підказка про сид", async () => {
    await env.DB.batch(["workout_sets", "workouts", "program_exercises", "program_days", "programs"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await trening();
    expect(view().text).toBe(NO_PROGRAM);
  });
});

// Рев'ю Фази 1 (F-1).
describe("F-1 В1: призначення через БД на ≥ 2 сесіях, пропуски не витісняють зараховані", () => {
  /** Повністю пропущена сесія слота 0 (три ⏭): у БД це рядки skipped = 1, у спеці — не сесія. */
  async function seedSkipped(dayCode: string, startedAt: number): Promise<void> {
    const day = (await repo.getProgramDay(OWNER, dayCode))!;
    const w = (await repo.startWorkout(OWNER, day.id, startedAt))!.workout;
    const slot = day.slots[0]!;
    for (let n = 1; n <= slot.sets; n++) {
      await repo.upsertSet(OWNER, {
        workoutId: w.id, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: n,
        weightKg: null, reps: null, prescribedWeightKg: 60, prescribedReps: 6, skipped: true,
      });
    }
    await repo.finishWorkout(OWNER, w.id, 3, startedAt + 3_000_000);
  }
  const DAY = 86_400_000;

  it("[невдача, пропуск, пропуск, невдача] → deload 50 × 6 (правило 4)", async () => {
    await seedDone("A", T0 - DAY * 8, [{ slot: 0, weight: 60, reps: 6 }, { slot: 0, weight: 60, reps: 6 }, { slot: 0, weight: 60, reps: 5 }], 4);
    await seedSkipped("A", T0 - DAY * 6);
    await seedSkipped("A", T0 - DAY * 4);
    await seedDone("A", T0 - DAY * 2, [{ slot: 0, weight: 60, reps: 6 }, { slot: 0, weight: 60, reps: 5 }, { slot: 0, weight: 60, reps: 5 }], 4);
    await seedDone("B", T0 - DAY, [{ slot: 0, weight: 40, reps: 8 }]);
    await trening();
    expect(view().text).toContain("Все тіло A · вправа 1/5");
    expect(view().text).toContain("Підхід 1/3 · ціль <b>50 кг × 6</b>");
  });

  it("[успіх e5, пропуск, пропуск, успіх e5] → 45 × 6 (правило 5: не двічі поспіль)", async () => {
    const full = [0, 1, 2].map(() => ({ slot: 0, weight: 40, reps: 10 }));
    await seedDone("A", T0 - DAY * 8, full, 5);
    await seedSkipped("A", T0 - DAY * 6);
    await seedSkipped("A", T0 - DAY * 4);
    await seedDone("A", T0 - DAY * 2, full, 5);
    await seedDone("B", T0 - DAY, [{ slot: 0, weight: 40, reps: 8 }]);
    await trening();
    expect(view().text).toContain("Підхід 1/3 · ціль <b>45 кг × 6</b>");
  });
});

describe("F-1 В2: кількість запитів D1 на натискання", () => {
  it("✅ другого підходу того самого слота: ≤ 8 запитів D1 (було 9; +1 читання start_weights, лише без історії вправи — 1b.2)", async () => {
    await trening();
    await press("✅"); // підхід 1
    const next = button("✅").callback_data;
    let queries = 0;
    const counted = {
      ...env,
      DB: new Proxy(env.DB, {
        get(t, k) {
          const v = Reflect.get(t, k) as unknown;
          if (k === "prepare") return (q: string) => { queries++; return t.prepare(q); };
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    };
    const handler = telegramHandler(counted, { fetch: tg.fetch, botInfo, now: () => nowMs });
    await handleRequest(webhookRequest(cbUpdate(next)), counted, handler);
    expect(await setCount()).toBe(2);
    expect(queries).toBeLessThanOrEqual(8);
  });
});

describe("F-1 В3: дві вимоги спеки", () => {
  it("«s» з n ≠ рядків + 1 (розрив нумерації) → «Кнопка застаріла — показую поточний підхід», рядка немає", async () => {
    await trening();
    const cb = parseCb(button("✅").callback_data)!;
    expect(cb.n).toBe(1);
    await tap(encodeCb("s", { ...cb, n: 3 }));
    expect(lastAnswer()).toBe("Кнопка застаріла — показую поточний підхід");
    expect(await setCount()).toBe(0);
  });
});

describe("1b.3: назви тренувань (P3.2, P3.3)", () => {
  const LONG = "Ш".repeat(40); // ліміт назви ≤ 40; кирилиця — 2 байти на символ

  it("день без title → «День A» на екрані, у підсумку й у /prohrama", async () => {
    await env.DB.prepare("UPDATE program_days SET title = NULL").run();
    await say("/prohrama");
    expect(view().text).toContain("<b>День A</b> · ноги, груди, спина\n1.");
    expect(view().text).toContain("➡️ <b>Наступне тренування: День A (ноги, груди, спина)</b>");
    await trening();
    expect(view().text).toContain("День A · вправа 1/5");
    await say("/prohrama");
    expect(view().text).toContain("Зараз триває: <b>День A</b>");
  });

  it("довга назва: екран, /prohrama, підсумок і /progres показують її; callback_data ≤ 64 байти і без назви", async () => {
    await env.DB.prepare("UPDATE program_days SET title = ? WHERE code = 'A'").bind(LONG).run();
    await trening();
    expect(view().text).toContain(`${LONG} · вправа 1/5`);
    expect(view().text.length).toBeLessThanOrEqual(4096);
    for (const b of view().buttons) {
      if (b.callback_data === undefined) continue; // URL-кнопка [🎥 Відео] без callback_data
      expect(new TextEncoder().encode(b.callback_data).length, b.callback_data).toBeLessThanOrEqual(64);
      expect(b.callback_data).not.toContain(LONG);
    }
    await say("/prohrama");
    expect(view().text).toContain(`<b>${LONG}</b> · ноги, груди, спина\n1.`);
    expect(view().text).toContain(`Зараз триває: <b>${LONG}</b>`);
    // Підсумок і /progres: закриваємо тренування A.
    const w = await workoutRow();
    await repo.finishWorkout(OWNER, w!.id, 3, T0 + 1);
    await say("/progres");
    await tap("p:r"); // у закритого без підходів тренування екран /progres порожній, тож кнопку кличемо напряму
    expect(view().text).toContain(`· ${LONG}</b> · 3/5`);
    expect(view().text.length).toBeLessThanOrEqual(4096);
  });
});

describe("Розминка (phase-1-flow.md, «Розминка»)", () => {
  const warmupButtons = () => view().buttons.filter((b) => (b.callback_data ?? "").startsWith("u:"));

  it("W1 нове тренування: екран розминки перед першою вправою, дві кнопки ≤ 24 символи, у БД порожньо", async () => {
    await say("/trening");
    expect(view().method).toBe("sendMessage");
    const text = view().text;
    expect(text).toContain("🔥 <b>Розминка</b> · <i>Все тіло A</i>");
    expect(text).toContain("Кардіо, 5–7 хв:</b> доріжка, велосипед або скакалка");
    expect(text).toContain("Суглоби, 2–3 хв:</b> кола плечима й тазом, 10 присідань без ваги, 10 ягідичних містків");
    expect(text).not.toContain("вправа 1/5");
    expect(view().buttons.map((b) => b.text)).toEqual(["✅ Розминку зроблено", "⏭ Пропустити"]);
    for (const b of view().buttons) expect([...b.text].length).toBeLessThanOrEqual(24);
    expect(await setCount()).toBe(0);
    expect((await workoutRow())?.status).toBe("active");
  });

  it.each([["✅ Розминку зроблено"], ["⏭ Пропустити"]])("W2 [%s] веде до першої вправи й нічого не пише", async (label) => {
    await say("/trening");
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM workouts").first("n");
    await press(label);
    expect(view().method).toBe("editMessageText");
    expect(view().text).toContain("Все тіло A · вправа 1/5");
    expect(view().text).toContain("Присідання зі штангою");
    expect(view().text).toContain("Підхід 1/3");
    expect(view().buttons.some((b) => b.text.startsWith("✅ 6"))).toBe(true);
    expect(await setCount()).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workouts").first("n")).toBe(before);
    expect(answers()).toHaveLength(1);
  });

  it("W3 подвійне натискання: без помилки, екран вправи не змінився, 0 рядків, відповідь на кожне", async () => {
    await say("/trening");
    const data = warmupButtons()[0]!.callback_data;
    await tap(data);
    const first = view().text;
    await tap(data);
    expect(view().text).toBe(first);
    expect(view().text).toContain("вправа 1/5");
    expect(await setCount()).toBe(0);
    expect(answers()).toHaveLength(2);
  });

  it("W4 стара кнопка розминки після підходів: поточний екран, нічого не записано", async () => {
    await say("/trening");
    const data = warmupButtons()[1]!.callback_data;
    await tap(data);
    await press("✅");
    expect(await setCount()).toBe(1);
    await tap(data);
    expect(view().text).toContain("Підхід 2/3");
    expect(await setCount()).toBe(1);
  });

  it("W5 продовження active розминку не показує: ні без підходів, ні після них", async () => {
    await say("/trening"); // екран розминки, кнопку не тиснуть
    await say("/trening");
    expect(view().method).toBe("sendMessage");
    expect(view().text).toContain("Все тіло A · вправа 1/5");
    expect(view().text).not.toContain("🔥");
    expect(warmupButtons()).toHaveLength(0);
    await press("✅");
    await say("/trening");
    expect(view().text).toContain("Підхід 2/3");
    expect(view().text).not.toContain("🔥");
    expect(warmupButtons()).toHaveLength(0);
  });

  it("W6 після завершення нове тренування знову починається з розминки", async () => {
    await say("/trening");
    await press("⏭ Пропустити");
    await playThrough();
    await press("4");
    await say("/trening");
    expect(view().text).toContain("🔥 <b>Розминка</b> · <i>Все тіло B");
    expect(warmupButtons()).toHaveLength(2);
  });

  it("W7 «дім»: замість доріжки — швидка ходьба або стрибки на місці; зал — доріжка", async () => {
    await repo.upsertProfile(OWNER, { place: "home" }, 1);
    await say("/trening");
    expect(view().text).toContain("швидка ходьба або стрибки на місці");
    expect(view().text).not.toMatch(/доріжка|велосипед|скакалка/);
    expect(view().text).toContain("кола плечима й тазом");
    await repo.finishWorkout(OWNER, (await workoutRow())!.id, 3, T0 + 1);
    await repo.upsertProfile(OWNER, { place: "gym" }, 2);
    await say("/trening");
    expect(view().text).toContain("доріжка, велосипед або скакалка");
    expect(view().text).not.toContain("стрибки на місці");
  });
});
