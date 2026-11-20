// Завдання 1b.2: потік анкети (docs/spec/phase-1b.md, історії P1.1–P1.11, P2.8–P2.10).
import { beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { parseOb, planScreen } from "../src/bot/onboarding-view";
import { GOAL_LABELS } from "../src/domain/plan";
import { OWNER, botInfo, count, env, fakeTelegram, resetDb, textUpdate, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const OTHER = 222;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
let nowMs = T0;
let tg = fakeTelegram();
let updateId = 1;

interface Button {
  text: string;
  callback_data: string;
}

async function send(update: Update): Promise<void> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => nowMs });
  await handleRequest(webhookRequest(update), env, handler);
}
const say = (text: string) => send(textUpdate(updateId++, OWNER, text));
function cbUpdate(data: string, messageId = 7, from = OWNER): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: "cb" + updateId,
      from: { id: from, is_bot: false, first_name: "Денис" },
      chat_instance: "ci",
      data,
      message: { message_id: messageId, date: 0, chat: { id: from, type: "private", first_name: "Денис" }, text: "екран" },
    },
  } as Update;
}
const tap = (data: string) => send(cbUpdate(data));

/** Останній екран із кнопками (sendMessage чи editMessageText); усі callback_data ≤ 64 байти (N6). */
function view(): { text: string; buttons: Button[] } {
  const call = [...tg.calls].reverse().find((c) => (c.method === "sendMessage" || c.method === "editMessageText") && c.payload.reply_markup);
  if (!call) throw new Error("немає екрана з кнопками");
  const buttons = ((call.payload.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard ?? []).flat();
  for (const b of buttons) expect(new TextEncoder().encode(b.callback_data).byteLength).toBeLessThanOrEqual(64);
  return { text: String(call.payload.text), buttons };
}
const lastText = (): string => String([...tg.calls].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText")!.payload.text);
const button = (prefix: string): Button => {
  const b = view().buttons.find((x) => x.text.includes(prefix));
  if (!b) throw new Error(`немає кнопки «${prefix}»:\n${view().text}\n${view().buttons.map((x) => x.text).join(" | ")}`);
  return b;
};
const press = (prefix: string) => tap(button(prefix).callback_data);
/** Натискає «⏭ Пропустити» n разів поспіль. */
const skip = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await press("⏭");
};
const lastAnswer = () => tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.payload.text as string | undefined;

const state = () => repo.getOnboarding(OWNER);
const profile = () => repo.getProfile(OWNER);
const programsCount = () => count("programs");

beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  nowMs = T0;
  updateId = 1;
  // Лише каталог: користувачів ще немає, тож програма A/B не створюється (новий користувач).
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
});

/** Власник зі старою програмою A/B (існуючі дані, які анкета не має зламати). */
async function ownerWithProgram(): Promise<void> {
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
}

/** Проходить анкету до екрана плану; goal — префікс кнопки цілі. */
async function walkToPlan(goal = "💪 Набрати", opts: { lift?: string } = {}): Promise<void> {
  await say("/start");
  await press("▶️");
  await press(goal);
  await press("➡️ Далі");
  await press("Новачок");
  await press("3 дні");
  await press("60 хв");
  await press("Зал");
  await press("✅ Готово");
  await press("➡️ Далі");
  // Питання 7: чотири якорі залу.
  if (opts.lift) await say(opts.lift);
  else await press("🤷");
  for (let i = 0; i < 3; i++) await press("🤷");
  await press("Чоловік");
  await say("1995");
  await say("178");
  await say("80,5");
  await press("3");
  await say("без лактози");
  await press("7–8");
  await press("Помірна");
}

describe("P1.1 перше питання — ціль", () => {
  it("новий користувач: /start → привітання, [▶️ Почати] → ціль: 6 кнопок, без «Пропустити» і «Назад»", async () => {
    await say("/start");
    expect(view().text).toContain("Привіт, Денис");
    expect(view().buttons.map((b) => b.text)).toEqual(["▶️ Почати"]);
    await press("▶️");
    const goal = view();
    expect(goal.text).toContain("Чого хочеш від тренувань");
    expect(goal.buttons).toHaveLength(6);
    expect(goal.buttons.some((b) => /Пропустити|Назад/.test(b.text))).toBe(false);
    expect((await state())?.step).toBe("goal");
  });
});

describe("P1.2 ціль: текст і застаріла кнопка", () => {
  it("текст на кроці цілі → повторне питання, стан і профіль без змін", async () => {
    await say("/start");
    await press("▶️");
    await say("схуднути хочу");
    expect(lastText()).toContain("Обери ціль кнопкою");
    expect(view().buttons).toHaveLength(6);
    expect((await state())?.step).toBe("goal");
    expect(await profile()).toBeNull();
  });

  it("застаріла кнопка іншого кроку → «Це вже неактуально», екран поточного кроку, профіль без змін", async () => {
    await say("/start");
    await press("▶️");
    await tap("o:lv:mid");
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect(lastText()).toContain("Чого хочеш від тренувань");
    expect(await profile()).toBeNull();
    expect((await state())?.step).toBe("goal");
  });

  it("підроблений «Пропустити» на цілі не обходить питання", async () => {
    await say("/start");
    await press("▶️");
    await tap("o:g:s");
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect((await state())?.step).toBe("goal");
    expect(await profile()).toBeNull();
  });
});

describe("P1.3–P1.4 уточнення цілі", () => {
  it("інше: [➡️ Далі] без уточнення відхилено; для muscle — goal_note NULL і далі рівень", async () => {
    await say("/start");
    await press("▶️");
    await press("✍️ Інше");
    expect(view().text).toContain("Опиши свою ціль");
    expect(view().buttons.some((b) => b.text.startsWith("➡️"))).toBe(false);
    await tap("o:gn:n"); // підроблена кнопка
    expect(lastAnswer()).toBe("Для «Інше» напиши кілька слів про ціль");
    expect((await state())?.step).toBe("goal_note");
    await say("хочу бігати півмарафон");
    expect((await profile())?.goalNote).toBe("хочу бігати півмарафон");
    expect((await state())?.step).toBe("level");
  });

  it("для muscle [➡️ Далі] → goal_note NULL", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    expect((await profile())?.goalNote).toBeNull();
    expect((await state())?.step).toBe("level");
  });

  it("<b>х</b> & зберігається як є, у /profil екрановано; 301 символ відхилено", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await say("a".repeat(301));
    expect((await profile())?.goalNote).toBeNull();
    expect((await state())?.step).toBe("goal_note");
    expect(lastText()).toContain("від 1 до 300");
    await say("<b>х</b> &");
    expect((await profile())?.goalNote).toBe("<b>х</b> &");
    await say("/profil");
    const text = lastText();
    expect(text).toContain("&lt;b&gt;х&lt;/b&gt; &amp;");
    expect(text).not.toContain("<b>х</b>");
    expect(text.split("\n")[1]).toContain("🎯 Ціль:");
    expect(text.split("\n")[2]).toContain("&lt;b&gt;");
  });

  it("300 символів — межа приймається", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await say("б".repeat(300));
    expect((await profile())?.goalNote).toHaveLength(300);
  });
});

describe("P1.5 перерва й продовження", () => {
  it("повернення до кроку height після /start", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await press("Новачок");
    await press("3 дні");
    await press("60 хв");
    await press("Зал");
    await press("✅ Готово");
    await press("➡️ Далі");
    await press("⏭ Пропустити"); // ваги пропущено
    await press("Жінка");
    await say("1998");
    expect((await state())?.step).toBe("height");
    await say("/start");
    expect(view().buttons.map((b) => b.text)).toEqual(["▶️ Продовжити", "🔄 Спочатку"]);
    await press("▶️ Продовжити");
    expect(lastText()).toContain("Зріст");
    const p = await profile();
    expect(p).toMatchObject({ goal: "muscle", level: "novice", daysPerWeek: 3, sessionMin: 60, place: "gym", sex: "f", birthYear: 1998 });
  });

  it("[🔄 Спочатку] → привітання, відповіді профілю лишаються й позначені ✅", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await say("/start");
    await press("🔄 Спочатку");
    expect((await state())?.step).toBe("welcome");
    await press("▶️");
    expect(view().buttons.some((b) => b.text.startsWith("✅ Набрати"))).toBe(true);
  });
});

describe("P1.6 числа", () => {
  async function toWeightStep(): Promise<void> {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    for (let i = 0; i < 2; i++) await press("⏭"); // рівень, дні
    await press("⏭"); // хвилини
    await press("⏭"); // місце
    await press("⏭"); // обмеження
    await press("➡️ Далі"); // нотатка
    await press("⏭"); // ваги
    await press("⏭"); // стать
    await press("⏭"); // рік
    await press("⏭"); // зріст
    expect((await state())?.step).toBe("weight");
  }

  it("«80,5» приймається; «0», «1000», «-5», «abc» — повідомлення, стан незмінний", async () => {
    await toWeightStep();
    for (const bad of ["0", "1000", "-5", "abc", "29,9", "300,5"]) {
      await say(bad);
      expect((await state())?.step).toBe("weight");
      expect((await profile())?.weightKg ?? null).toBeNull();
      expect(lastText()).toContain("Не схоже на вагу");
    }
    await say("80,5");
    expect((await profile())?.weightKg).toBe(80.5);
    expect((await state())?.step).toBe("meals");
  });

  it("межі: рік 1995 ✓ / 2015 ✗ (вік < 14) / 1900 ✗; зріст 119 ✗ 120 ✓ 230 ✓ 231 ✗", async () => {
    await toWeightStep();
    await press("⬅️ Назад"); // зріст
    expect((await state())?.step).toBe("height");
    for (const bad of ["119", "231", "170 см", "-170"]) {
      await say(bad);
      expect((await profile())?.heightCm ?? null).toBeNull();
    }
    await say("120");
    expect((await profile())?.heightCm).toBe(120);
    await press("⬅️ Назад"); // знову зріст? з weight → height
    await say("230");
    expect((await profile())?.heightCm).toBe(230);
    // рік
    await press("⬅️ Назад");
    await press("⬅️ Назад");
    expect((await state())?.step).toBe("birth");
    for (const bad of ["2015", "1900", "95", "abcd"]) {
      await say(bad);
      expect((await profile())?.birthYear ?? null).toBeNull();
    }
    await say("1995");
    expect((await profile())?.birthYear).toBe(1995);
  });
});

describe("P1.7 робочі ваги → start_weights", () => {
  async function toLifts(): Promise<void> {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await press("Новачок");
    await press("3 дні");
    await press("60 хв");
    await press("Зал");
    await press("✅ Готово");
    await press("➡️ Далі");
    expect((await state())?.step).toBe("lifts");
  }

  it("«60x8» для присідання → 60 кг × 8; крок 5: 62,5x8 → 60; «Не знаю» → запису немає", async () => {
    await toLifts();
    expect(view().text).toContain("Присідання зі штангою");
    await say("62,5x8"); // крок 5 → вниз до 60
    expect(await repo.getStartWeight(OWNER, 1)).toMatchObject({ weightKg: 60, reps: 8 });
    expect(view().text).toContain("Жим лежачи");
    await press("🤷");
    expect(await repo.getStartWeight(OWNER, 2)).toBeNull();
    await say("40×10");
    expect(await repo.getStartWeight(OWNER, 3)).toMatchObject({ weightKg: 40, reps: 10 });
    await say("30 12");
    expect(await repo.getStartWeight(OWNER, 4)).toMatchObject({ weightKg: 30, reps: 12 });
    expect((await state())?.step).toBe("sex");
  });

  it("помилки вводу: 0, 401 кг, 0 і 31 повтор, нижче грифа 15 кг — крок і запис незмінні", async () => {
    await toLifts();
    for (const bad of ["0x8", "401x8", "60x0", "60x31", "15x8", "шістдесят", "60"]) {
      await say(bad);
      expect(await repo.getStartWeights(OWNER)).toHaveLength(0);
      expect((await state())?.sub).toBe(0);
    }
    await say("400x30");
    expect(await repo.getStartWeight(OWNER, 1)).toMatchObject({ weightKg: 400, reps: 30 });
  });

  it("«Не знаю» після введеної ваги прибирає запис; «Пропустити» пропускає весь блок", async () => {
    await toLifts();
    await say("60x8");
    await press("⬅️ Назад");
    expect((await state())?.sub).toBe(0);
    await press("🤷");
    expect(await repo.getStartWeight(OWNER, 1)).toBeNull();
    await press("⏭ Пропустити");
    expect((await state())?.step).toBe("sex");
  });

  it("вправа з done-історією власника не питається", async () => {
    await ownerWithProgram();
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    const w = (await repo.startWorkout(OWNER, day.id, 5_000))!.workout;
    const slot = day.slots[0]!; // присідання (id 1)
    await repo.upsertSet(OWNER, { workoutId: w.id, programExerciseId: slot.id, exerciseId: 1, setNo: 1, weightKg: 60, reps: 8, prescribedWeightKg: 60, prescribedReps: 8, skipped: false });
    await repo.finishWorkout(OWNER, w.id, 3, 6_000);
    await repo.upsertOnboarding(OWNER, { status: "active", step: "limits_note" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle", level: "novice", place: "gym", limits: "" }, 1);
    await say("/start");
    await press("▶️ Продовжити");
    await press("➡️ Далі");
    expect(view().text).not.toContain("Присідання зі штангою");
    expect(view().text).toContain("Жим лежачи");
  });
});

describe("P1.8 подвійне натискання й ізоляція", () => {
  it("те саме натискання двічі → один запис і один перехід", async () => {
    await say("/start");
    await press("▶️");
    const goal = button("💪 Набрати").callback_data;
    await tap(goal);
    const stateAfter = await state();
    const profileAfter = await profile();
    await tap(goal);
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect(await state()).toEqual(stateAfter);
    expect(await profile()).toEqual(profileAfter);
    expect(await count("user_profiles")).toBe(1);
  });

  it("чужий userId не бачить стану, профілю й робочих ваг", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await repo.upsertUser(OTHER, "Інший", 0);
    expect(await repo.getOnboarding(OTHER)).toBeNull();
    expect(await repo.getProfile(OTHER)).toBeNull();
    await repo.setStartWeight(OWNER, 1, 60, 8, 1);
    expect(await repo.getStartWeight(OTHER, 1)).toBeNull();
    expect(await repo.getStartWeights(OTHER)).toEqual([]);
  });

  it("робочі ваги іншого користувача не діють на призначення власника", async () => {
    await ownerWithProgram();
    await repo.upsertUser(OTHER, "Інший", 0);
    await repo.setStartWeight(OTHER, 1, 100, 8, 1);
    await say("/trening");
    // присідання зі штангою: без start_weights власника — калібрування від мінімуму грифа (20 кг)
    expect(lastText()).toContain("20 кг × 6");
  });
});

describe("P1.10 пропущено все, крім цілі", () => {
  it("профіль із дефолтами, план будується й приймається", async () => {
    await say("/start");
    await press("▶️");
    await press("🏋️ Сила");
    await press("➡️ Далі"); // уточнення
    await skip(5);
    await press("➡️ Далі"); // нотатка обмежень
    await skip(9);
    expect((await state())?.step).toBe("plan");
    expect(await profile()).toMatchObject({ goal: "strength", level: "novice", daysPerWeek: 3, sessionMin: 60, place: "gym", limits: "", sex: null, weightKg: null });
    expect(view().text).toContain("План: сила");
    expect(await programsCount()).toBe(0);
    await press("✅ Прийняти");
    expect(await programsCount()).toBe(1);
    expect((await state())?.status).toBe("done");
  });
});

describe("P1.11 текст за станом", () => {
  it("активне тренування чекає вагу → текст «80» іде вазі, анкета не змінилась", async () => {
    await ownerWithProgram();
    await repo.upsertOnboarding(OWNER, { status: "active", step: "height" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle" }, 1);
    await say("/trening");
    await press("⚖️ Вага");
    const before = await state();
    await say("40");
    expect((await profile())?.heightCm ?? null).toBeNull();
    expect(await state()).toEqual(before);
    expect(lastText()).toContain("40 кг");
  });

  it("команда скидає очікування ваги — анкета лишається на кроці", async () => {
    await ownerWithProgram();
    await repo.upsertOnboarding(OWNER, { status: "active", step: "height" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle" }, 1);
    await say("/trening");
    await press("⚖️ Вага");
    await say("/progres");
    await say("178");
    expect((await profile())?.heightCm).toBe(178);
  });

  it("текст не на текстовому кроці — «Не розумію»; без анкети — теж", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await say("привіт"); // крок level — кнопки
    expect(lastText()).toContain("Не розумію");
    await resetDb();
    await say("привіт");
    expect(lastText()).toContain("Не розумію");
  });
});

describe("«Назад» і «Пропустити»", () => {
  it("[⬅️ Назад] на кроці рівня повертає до уточнення; на цілі «Назад» немає", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    expect((await state())?.step).toBe("level");
    await press("⬅️ Назад");
    expect((await state())?.step).toBe("goal_note");
    await press("⬅️ Назад");
    expect((await state())?.step).toBe("goal");
    expect(view().buttons.some((b) => b.text.includes("Назад"))).toBe(false);
  });

  it("пропуск не затирає наявну відповідь (повторне проходження)", async () => {
    await repo.upsertUser(OWNER, "Денис", 0);
    await repo.upsertProfile(OWNER, { goal: "muscle", level: "adv" }, 1);
    await repo.upsertOnboarding(OWNER, { status: "active", step: "level" }, 1);
    await say("/start");
    await press("▶️ Продовжити");
    expect(view().buttons.some((b) => b.text.startsWith("✅ Досвідчений"))).toBe(true);
    await press("⏭");
    expect((await profile())?.level).toBe("adv");
  });
});

describe("P2.8–P2.10 підтвердження плану", () => {
  it("план показано; до [✅] у programs нічого; [🔁] тричі → 4-й варіант = 1-й; [✏️ Змінити дні] скидає варіант", async () => {
    await ownerWithProgram();
    const before = await programsCount();
    await say("/profil");
    await press("Пройти");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await skip(5);
    await press("➡️ Далі");
    await skip(9);
    expect((await state())?.step).toBe("plan");
    const first = view().text;
    expect(first).toContain("Варіант 1 з 3");
    expect(await programsCount()).toBe(before);
    const seen = [first];
    for (let i = 1; i <= 3; i++) {
      await press("🔁");
      seen.push(view().text);
      expect((await state())?.planVariant).toBe(i % 3);
      expect(await programsCount()).toBe(before);
    }
    expect(seen[1]).not.toBe(seen[0]); // gym: різні варіанти дають різні плани
    expect(seen[2]).not.toBe(seen[1]);
    expect(seen[3]).toBe(seen[0]);
    await press("🔁");
    expect((await state())?.planVariant).toBe(1);
    await press("✏️ Змінити дні");
    expect((await state())?.planVariant).toBe(0);
    expect((await state())?.step).toBe("days");
    await press("4 дні");
    expect((await state())?.step).toBe("minutes");
    await press("45 хв");
    expect((await state())?.step).toBe("plan");
    expect(view().text).toContain("4 дні на тиждень · ~45 хв");
    expect(await programsCount()).toBe(before);
    // стару програму не зачеплено
    expect((await repo.getActiveProgram(OWNER))?.name).not.toContain("План:");
  });

  it("[✅ Прийняти]: стара програма active = 0, нова одна active = 1; історія не змінилась; повторне [✅] — застаріла", async () => {
    await ownerWithProgram();
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    const w = (await repo.startWorkout(OWNER, day.id, 5_000))!.workout;
    const slot = day.slots[0]!;
    await repo.upsertSet(OWNER, { workoutId: w.id, programExerciseId: slot.id, exerciseId: 1, setNo: 1, weightKg: 60, reps: 8, prescribedWeightKg: 60, prescribedReps: 8, skipped: false });
    await repo.finishWorkout(OWNER, w.id, 3, 6_000);
    const snap = async () => JSON.stringify([(await env.DB.prepare("SELECT * FROM workouts").all()).results, (await env.DB.prepare("SELECT * FROM workout_sets").all()).results]);
    const snapshot = await snap();
    await repo.upsertOnboarding(OWNER, { status: "active", step: "activity" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle" }, 1);
    await say("/start");
    await press("▶️ Продовжити");
    await press("⏭");
    expect(view().text).toContain(`План: ${GOAL_LABELS.muscle}`);
    const accept = button("✅ Прийняти").callback_data;
    await tap(accept);
    expect(await programsCount()).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM programs WHERE active = 1").first<{ n: number }>())!.n).toBe(1);
    expect(await snap()).toBe(snapshot);
    expect((await state())?.status).toBe("done");
    expect(lastText()).toContain("Готово");
    expect(lastText()).toContain("Наступне тренування");
    // Назва дня самодостатня: «Все тіло A (ноги, груди, спина)», не код і не голе «День».
    expect(lastText()).toMatch(/Наступне тренування: <b>[^<(]+ \([а-яі]+(, [а-яі]+){0,2}\)<\/b>/);
    expect(lastText()).not.toMatch(/День|bF[AB]b/);
    // P2.10
    await tap(accept);
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect(await programsCount()).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM programs WHERE active = 1").first<{ n: number }>())!.n).toBe(1);
  });

  it("активне тренування → [✅] відмовляє, programs без змін, екран плану лишається", async () => {
    await ownerWithProgram();
    await repo.upsertOnboarding(OWNER, { status: "active", step: "activity" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle" }, 1);
    await say("/start");
    await press("▶️ Продовжити");
    await press("⏭");
    await say("/trening");
    const before = await programsCount();
    // екран плану — попереднє повідомлення; кнопка з нього
    await tap("o:pl:ok0");
    expect(lastAnswer()).toBe("Заверши тренування (/trening) і повтори");
    expect(await programsCount()).toBe(before);
    expect((await state())?.status).toBe("active");
  });

  it("відмова від плану (анкету кинуто) не чіпає стару програму", async () => {
    await ownerWithProgram();
    const before = await repo.getActiveProgram(OWNER);
    await say("/profil");
    await press("Пройти");
    await press("▶️");
    await press("🏋️ Сила");
    await say("/trening"); // життя триває; анкета лишилась на кроці
    expect(await repo.getActiveProgram(OWNER)).toEqual(before);
    expect((await profile())?.goal).toBe("strength");
    await say("/profil");
    expect(lastText()).toContain("Активний план");
    expect(lastText()).toContain(before!.name);
  });

  it("EMPTY_DAY: екран із діями, у programs нічого", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await press("Новачок");
    await press("5 днів");
    await press("30 хв");
    await press("Зал");
    await press("💪 Плечі");
    await press("✅ Готово");
    await press("➡️ Далі");
    for (let i = 0; i < 2; i++) await press("🤷"); // з обмеженням «плечі» лишаються 2 якорі
    await skip(8);
    expect(view().text).toContain("Не вдалося скласти план із такими обмеженнями");
    expect(view().buttons.map((b) => b.text)).toEqual(["🦵 Змінити обмеження", "⏱ Змінити тривалість", "🔄 Спочатку"]);
    expect(await programsCount()).toBe(0);
    // [Змінити тривалість] → 60 хв → план
    await press("⏱ Змінити тривалість");
    await press("90 хв");
    expect(view().text).toContain("План:");
  });
});

describe("повний прохід", () => {
  it("профіль, робочі ваги й план записано; /trening бере стартову вагу", async () => {
    await walkToPlan("💪 Набрати", { lift: "60x8" });
    expect(await profile()).toMatchObject({
      goal: "muscle", goalNote: null, level: "novice", daysPerWeek: 3, sessionMin: 60, place: "gym", limits: "",
      sex: "m", birthYear: 1995, heightCm: 178, weightKg: 80.5, mealsPerDay: 3, dietNote: "без лактози", sleepBand: "7_8", activity: "mid",
    });
    expect(await repo.getStartWeights(OWNER)).toEqual([{ exerciseId: 1, weightKg: 60, reps: 8 }]);
    await press("✅ Прийняти");
    const program = (await repo.getActiveProgram(OWNER))!;
    expect(program.name).toBe(`План: ${GOAL_LABELS.muscle}`);
    expect(program.days.map((d) => d.code)).toEqual(["FA", "FB"]);
  });

  it("/trening після прийняття: вправа з робочою вагою — призначення 60 кг × repMin", async () => {
    await ownerWithProgram();
    await repo.setStartWeight(OWNER, 1, 60, 8, 1);
    await say("/trening");
    expect(lastText()).toContain("60 кг × 6");
  });

  it("робоча вага з повторами < repMin → × 0,9 до кроку; без запису — мінімум", async () => {
    await ownerWithProgram();
    await repo.setStartWeight(OWNER, 1, 60, 4, 1);
    await say("/trening");
    expect(lastText()).toContain("50 кг × 6"); // 60 × 0,9 = 54 → 50
  });
});

describe("/start і /profil", () => {
  it("власник із програмою: звичайне привітання + [📝 Налаштувати], без примусу й без стану анкети", async () => {
    await ownerWithProgram();
    await say("/start");
    expect(lastText()).toContain("Привіт, Денис");
    expect(view().buttons.map((b) => b.text)).toEqual(["📝 Налаштувати персональний план"]);
    expect(await state()).toBeNull();
    expect(await repo.getActiveProgram(OWNER)).not.toBeNull();
    await press("📝");
    expect((await state())?.step).toBe("welcome");
    expect(await programsCount()).toBe(1);
  });

  it("/profil без профілю: «не вказана» і [📝 Пройти анкету]", async () => {
    await ownerWithProgram();
    await say("/profil");
    expect(lastText()).toContain("Ціль: не вказана");
    expect(view().buttons.map((b) => b.text)).toEqual(["📝 Пройти анкету"]);
  });

  it("/profil: перший рядок після заголовка — ціль, нижче активний план", async () => {
    await ownerWithProgram();
    await repo.upsertProfile(OWNER, { goal: "recomp", goalNote: "хочу сушитись" }, 1);
    await say("/profil");
    const lines = lastText().split("\n");
    expect(lines[1]).toBe("🎯 Ціль: <b>рекомпозиція</b>");
    expect(lines[2]).toBe("<i>хочу сушитись</i>");
    expect(lines[3]).toContain("📋 Активний план:");
  });
});

describe("callback_data і межі", () => {
  it("parseOb: лише o:<код>:<значення>", () => {
    expect(parseOb("o:g:muscle")).toEqual({ code: "g", step: "goal", value: "muscle" });
    expect(parseOb("o:pl:ok")).toEqual({ code: "pl", step: "plan", value: "ok" });
    expect(parseOb("o:rs:go")).toMatchObject({ code: "rs", step: null });
    for (const bad of ["s:1:2", "o:zz:x", "o:g:", "o:g:A", "o:g:x:y", "o:::"]) expect(parseOb(bad)).toBeNull();
  });

  it("екран плану 5 днів × 7 слотів із довгими назвами ≤ 4096 символів", () => {
    const names = new Map<number, string>();
    const days = Array.from({ length: 5 }, (_, d) => ({
      code: "UP",
      title: "Д".repeat(40),
      slots: Array.from({ length: 7 }, (_, s) => {
        names.set(d * 10 + s, "Н".repeat(80));
        return { exerciseId: d * 10 + s, sets: 4, repMin: 8, repMax: 12 };
      }),
    }));
    const screen = planScreen({ plan: { name: "План: " + "я".repeat(100), days }, names, daysPerWeek: 5, sessionMin: 90, limits: ["knee", "back", "shoulder", "wrist"], variant: 2, weightsUsed: 3, weightsTotal: 4 });
    expect(screen.text.length).toBeLessThanOrEqual(4096);
  });

  it("екран плану екранує назви вправ", () => {
    const screen = planScreen({
      plan: { name: "План", days: [{ code: "FA", title: "Все тіло A", slots: [{ exerciseId: 1, sets: 3, repMin: 8, repMax: 12 }] }] },
      names: new Map([[1, "Жим <b> & тяга"]]),
      daysPerWeek: 3, sessionMin: 60, limits: [], variant: 0, weightsUsed: 0, weightsTotal: 0,
    });
    expect(screen.text).toContain("Жим &lt;b&gt; &amp; тяга");
  });
});

describe("рев'ю 1b.2", () => {
  async function toPlan(): Promise<void> {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await skip(5);
    await press("➡️ Далі");
    await skip(9);
    expect((await state())?.step).toBe("plan");
  }

  it("В1: [✅] зі старого екрана плану (інший варіант у стані) не активує невидимий варіант", async () => {
    await toPlan();
    const oldOk = button("✅ Прийняти").callback_data; // варіант 1 (ok0)
    expect(oldOk).toBe("o:pl:ok0");
    await press("🔁"); // стан: варіант 2
    await tap(oldOk);
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect(await programsCount()).toBe(0);
    expect((await state())?.status).toBe("active");
    await tap(button("✅ Прийняти").callback_data); // актуальний екран — приймається
    expect(await programsCount()).toBe(1);
  });

  it("Д1: зміна цілі з «Інше» на іншу очищає goal_note", async () => {
    await say("/start");
    await press("▶️");
    await press("✍️ Інше");
    await say("свій текст");
    await press("⬅️ Назад");
    await press("⬅️ Назад");
    await press("💪 Набрати");
    expect(await profile()).toMatchObject({ goal: "muscle", goalNote: null });
  });

  it("Д2: три довгі нотатки з & не ламають HTML профілю (≤ 4096, без обрізаної сутності)", async () => {
    await ownerWithProgram();
    const long = "&".repeat(300);
    await repo.upsertProfile(OWNER, { goal: "muscle", goalNote: long, limitsNote: long, dietNote: long }, 1);
    await say("/profil");
    const t = lastText();
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t.replace(/&amp;/g, "").includes("&")).toBe(false);
    expect((t.match(/<i>/g) ?? []).length).toBe((t.match(/<\/i>/g) ?? []).length);
  });

  it("Д3: значення чужого кроку (o:m:3 на кроці days) ігнорується", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await press("Новачок");
    expect((await state())?.step).toBe("days");
    await tap("o:m:3");
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect((await profile())?.mealsPerDay ?? null).toBeNull();
    expect((await state())?.step).toBe("days");
  });

  it("Д3: стан plan без цілі повертає на goal, нічого не пише", async () => {
    await repo.upsertUser(OWNER, "Денис", 0);
    await repo.upsertOnboarding(OWNER, { status: "active", step: "plan" }, 1);
    await tap("o:pl:ok0");
    expect(lastAnswer()).toBe("Це вже неактуально");
    expect((await state())?.step).toBe("goal");
    expect(await programsCount()).toBe(0);
  });

  it("Д3: без доступних якорів крок lifts пропускається, «Назад» із sex веде в limits_note", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await press("➡️ Далі");
    await press("Новачок");
    await press("3 дні");
    await press("60 хв");
    await press("Вдома");
    for (const l of ["Коліна", "Спина", "Плечі"]) await press(l);
    await press("✅ Готово");
    await press("➡️ Далі");
    expect((await state())?.step).toBe("sex");
    await press("⬅️ Назад");
    expect((await state())?.step).toBe("limits_note");
  });

  it("Д3: після текстової відповіді з попереднього екрана знімається клавіатура", async () => {
    await say("/start");
    await press("▶️");
    await press("💪 Набрати");
    await say("уточнення");
    expect(tg.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
  });
});
