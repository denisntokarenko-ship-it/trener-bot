// 3.4 — корекція норми за трендом ваги (docs/spec/phase-3.md, розділ 4; історії P3.4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";
import { handleRequest, telegramHandler } from "../src/app";
import { isTrendCb, trendKeyboard } from "../src/bot/trend-flow";
import { runCron } from "../src/cron";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { GOAL_BANDS } from "../src/config";
import { formatPace, trendProposal, type Goal, type TrendInput } from "../src/domain/nutrition";
import { dueReminders } from "../src/domain/reminders";
import { addDays } from "../src/domain/time";
import { OWNER, botInfo, count, env, fakeTelegram, outgoingProblems, resetDb, scriptedTelegram, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const TODAY = "2026-11-20";

/** `n` цілих десятих кг із заданою сумою. */
function spread(sum: number, n: number): number[] {
  const base = Math.floor(sum / n);
  const extra = sum - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
/** Зважування: W0 = TODAY−6…TODAY, W1 = TODAY−13…TODAY−7; по `n` записів у вікні з сумою `sum` (десяті кг). */
function weights(w0: { sum: number; n: number }, w1: { sum: number; n: number }, today = TODAY) {
  const out: { localDate: string; weightDg: number }[] = [];
  spread(w0.sum, w0.n).forEach((dg, i) => out.push({ localDate: addDays(today, -i), weightDg: dg }));
  spread(w1.sum, w1.n).forEach((dg, i) => out.push({ localDate: addDays(today, -7 - i), weightDg: dg }));
  return out;
}
const base = (over: Partial<TrendInput> = {}): TrendInput => ({
  weights: weights({ sum: 19910, n: 7 }, { sum: 20000, n: 7 }),
  goal: "recomp",
  today: TODAY,
  kcal: 2480,
  carbsG: 332,
  formulaKcal: 2480,
  ...over,
});
/** Темп при W1 = 20000 (n = 7): 1 одиниця суми W0 = 0,005 %; p·100 = (s0 − 20000)/2. */
const atPace = (centi: number, over: Partial<TrendInput> = {}) => trendProposal(base({ weights: weights({ sum: 20000 + centi * 2, n: 7 }, { sum: 20000, n: 7 }), ...over }));

describe("P3.4.1 поріг зважувань", () => {
  const strong = (n0: number, n1: number) => weights({ sum: n0 * 790, n: n0 }, { sum: n1 * 800, n: n1 }); // p ≈ −1,25 %
  it("9 зважувань (4+5) → пропозиції немає; 10 (3+7) → є", () => {
    expect(trendProposal(base({ weights: strong(4, 5) }))).toBeNull();
    expect(trendProposal(base({ weights: strong(3, 7) }))?.delta).toBe(100);
    expect(trendProposal(base({ weights: strong(5, 5) }))?.delta).toBe(100);
  });
  it("у `W0` або `W1` лише 2 записи → пропозиції немає (у вікні ≤ 7 записів, тож «≥ 3 у кожному» випливає з «≥ 10 разом»)", () => {
    expect(trendProposal(base({ weights: strong(2, 7) }))).toBeNull();
    expect(trendProposal(base({ weights: strong(7, 2) }))).toBeNull();
    expect(trendProposal(base({ weights: strong(3, 7) }))?.delta).toBe(100);
    expect(trendProposal(base({ weights: strong(7, 3) }))?.delta).toBe(100);
  });
  it("записи поза W0 ∪ W1 не рахуються", () => {
    const old = [{ localDate: addDays(TODAY, -20), weightDg: 800 }, { localDate: addDays(TODAY, -30), weightDg: 800 }, { localDate: addDays(TODAY, -40), weightDg: 800 }];
    expect(trendProposal(base({ weights: [...strong(4, 5), ...old] }))).toBeNull();
  });
});

describe("P3.4.2 пороги за ціллю (межі строгі)", () => {
  it("recomp: p = −0,45 → нічого; −0,46 → +100; +0,20 → нічого; +0,21 → −100", () => {
    expect(atPace(-45)).toBeNull();
    expect(atPace(-46)?.delta).toBe(100);
    expect(atPace(20)).toBeNull();
    expect(atPace(21)?.delta).toBe(-100);
  });
  it("lose_fat: −1,20 → нічого, −1,21 → +100; −0,30 → нічого, −0,29 → −100", () => {
    expect(atPace(-120, { goal: "lose_fat" })).toBeNull();
    expect(atPace(-121, { goal: "lose_fat" })?.delta).toBe(100);
    expect(atPace(-30, { goal: "lose_fat" })).toBeNull();
    expect(atPace(-29, { goal: "lose_fat" })?.delta).toBe(-100);
  });
  it("muscle: −0,10 → нічого, −0,11 → +100; +0,70 → нічого, +0,71 → −100", () => {
    expect(atPace(-10, { goal: "muscle" })).toBeNull();
    expect(atPace(-11, { goal: "muscle" })?.delta).toBe(100);
    expect(atPace(70, { goal: "muscle" })).toBeNull();
    expect(atPace(71, { goal: "muscle" })?.delta).toBe(-100);
  });
  it.each(["strength", "health", "other"] as Goal[])("%s: ±0,45", (goal) => {
    expect(atPace(-45, { goal })).toBeNull();
    expect(atPace(-46, { goal })?.delta).toBe(100);
    expect(atPace(45, { goal })).toBeNull();
    expect(atPace(46, { goal })?.delta).toBe(-100);
  });
  it("кожна ціль має смугу, add < cut", () => {
    for (const b of Object.values(GOAL_BANDS)) expect(b.add).toBeLessThan(b.cut);
    expect(Object.keys(GOAL_BANDS).sort()).toEqual(["health", "lose_fat", "muscle", "other", "recomp", "strength"]);
  });
  it("пропозиція несе середні, темп і нову норму: 80,0 → 79,4, −0,75 %/тиж, +100 ккал, +25 г", () => {
    const p = atPace(-75)!;
    expect(p).toMatchObject({ delta: 100, avg1Dg: 2857, avg0Dg: 2836, paceCenti: -75, newKcal: 2580, carbsDeltaG: 25 });
    const q = trendProposal(base({ weights: weights({ sum: 7 * 794, n: 7 }, { sum: 7 * 800, n: 7 }) }))!;
    expect([q.avg1Dg, q.avg0Dg, q.paceCenti]).toEqual([800, 794, -75]);
    expect(formatPace(-75)).toBe("−0,75");
    expect(formatPace(20)).toBe("+0,20");
    expect(formatPace(0)).toBe("0,00");
  });
});

describe("P3.4 запобіжники", () => {
  it("відхилення від formula-норми ≤ ±300: 2680 → 2780 (300) можна, 2780 → 2880 (400) — ні", () => {
    expect(atPace(-60, { kcal: 2680, formulaKcal: 2480 })?.newKcal).toBe(2780);
    expect(atPace(-60, { kcal: 2780, formulaKcal: 2480 })).toBeNull();
  });
  it("−100 нижче formula−300 — ні; рівно −300 — так", () => {
    expect(atPace(60, { kcal: 2280, formulaKcal: 2480 })?.newKcal).toBe(2180);
    expect(atPace(60, { kcal: 2270, formulaKcal: 2480 })).toBeNull();
  });
  it("нова норма ≥ 1200 ккал", () => {
    expect(atPace(60, { kcal: 1300, formulaKcal: 1300, carbsG: 100 })?.newKcal).toBe(1200);
    expect(atPace(60, { kcal: 1250, formulaKcal: 1300, carbsG: 100 })).toBeNull();
  });
  it("−100 лише коли вуглеводів ≥ 25 г; +100 — завжди", () => {
    expect(atPace(60, { carbsG: 24 })).toBeNull();
    expect(atPace(60, { carbsG: 25 })).toMatchObject({ delta: -100, carbsDeltaG: -25 });
    expect(atPace(-60, { carbsG: 0 })?.delta).toBe(100);
  });
});

describe("кнопки й розклад", () => {
  it("callback_data: n:a:<±100>:<YYYYMMDD> і n:d:<YYYYMMDD>, ≤ 64 байти", () => {
    const k = trendKeyboard(-100, "2026-11-20").inline_keyboard[0]!;
    expect(k.map((b) => b.callback_data)).toEqual(["n:a:-100:20261120", "n:d:20261120"]);
    expect(k.map((b) => b.text)).toEqual(["✅ Прийняти", "Ні"]);
    for (const d of ["n:a:100:20261120", "n:a:-100:20261120", "n:d:20261120"]) expect(isTrendCb(d)).toBe(true);
    for (const d of ["n:a:150:20261120", "n:a:100:2026-11-20", "n:x:20261120", "f:go:recomp", "n:a:100:2026112"]) expect(isTrendCb(d)).toBe(false);
  });
  it("тренд належить до вікна 09:00–09:59 за tz користувача (EET і EEST)", () => {
    const u = { tz: "Europe/Kyiv", trainingDays: "1", remindTime: null, weighTime: null };
    const due = (utc: string) => dueReminders(u, Date.parse(utc)).includes("trend");
    expect(due("2026-11-20T06:59:00Z")).toBe(false); // 08:59 EET
    expect(due("2026-11-20T07:00:00Z")).toBe(true); // 09:00 EET
    expect(due("2026-11-20T07:59:00Z")).toBe(true);
    expect(due("2026-11-20T08:00:00Z")).toBe(false);
    expect(due("2026-07-20T06:00:00Z")).toBe(true); // 09:00 EEST
    expect(due("2026-07-20T07:00:00Z")).toBe(false);
  });
});

// ---------- Крон і кнопки ----------

const TICK = Date.parse("2026-11-20T07:00:00Z"); // 09:00 Києва
let tg = scriptedTelegram();
let bot = fakeTelegram();
let now = TICK;
let updateId = 1;
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(async () => {
  await resetDb();
  tg = scriptedTelegram();
  bot = fakeTelegram();
  now = TICK;
  updateId = 1;
  spies = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
  await repo.upsertUser(OWNER, "Денис", 0);
  await repo.upsertProfile(OWNER, { goal: "recomp", sex: "m", birthYear: 1996, heightCm: 180, activity: "mid", weightKg: 80 }, 0);
  await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run();
  await norm("2026-11-01", 2480, "formula");
});
afterEach(() => {
  expect(outgoingProblems([...tg.calls, ...bot.calls])).toEqual([]);
  for (const s of spies) s.mockRestore();
});

async function norm(validFrom: string, kcal: number, reason: "formula" | "trend", sourceDate: string | null = null): Promise<void> {
  await repo.insertTarget(OWNER, { validFrom, kcal, proteinG: 144, fatG: 64, carbsG: (kcal - 4 * 144 - 9 * 64) / 4, reason, sourceDate }, 0);
}
/** Вагові дані, що дають пропозицію +100 (80,0 → 79,4 кг, −0,75 %/тиж) на `today`. */
async function seedWeights(today = TODAY, w0 = 794, w1 = 800, n0 = 7, n1 = 7): Promise<void> {
  for (let i = 0; i < n0; i++) await repo.upsertBodyWeight(OWNER, addDays(today, -i), w0, 0);
  for (let i = 0; i < n1; i++) await repo.upsertBodyWeight(OWNER, addDays(today, -7 - i), w1, 0);
}
const tick = (t = now) => runCron(env, t, { fetch: tg.fetch, timeoutMs: 50 });
const trendRows = () => env.DB.prepare("SELECT local_date, message_id FROM reminders_sent WHERE kind = 'trend' ORDER BY local_date").all<{ local_date: string; message_id: number | null }>().then((r) => r.results);
const targetRows = () => env.DB.prepare("SELECT valid_from AS v, kcal, protein_g AS p, fat_g AS f, carbs_g AS c, reason, source_date AS s FROM nutrition_targets ORDER BY valid_from").all().then((r) => r.results);

async function tap(data: string): Promise<void> {
  const handler = telegramHandler(env, { fetch: bot.fetch, botInfo, now: () => now });
  const u = {
    update_id: updateId++,
    callback_query: {
      id: "cb" + updateId,
      from: { id: OWNER, is_bot: false, first_name: "Денис" },
      chat_instance: "ci",
      data,
      message: { message_id: 7, date: 0, chat: { id: OWNER, type: "private", first_name: "Денис" }, text: "📈 …" },
    },
  } as Update;
  await handleRequest(webhookRequest(u), env, handler);
}
const toast = () => String(bot.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.payload.text ?? "");

describe("P3.4 крон: пропозиція", () => {
  it("09:00, чинна норма, 14 зважувань, p = −0,75 % (recomp) → одне повідомлення з текстом спеки й кнопками", async () => {
    await seedWeights();
    const c = await tick();
    expect(c).toMatchObject({ sent: 1, errors: 0 });
    expect(tg.calls).toHaveLength(1);
    const p = tg.calls[0]!.payload as { chat_id: number; text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
    expect(p.chat_id).toBe(OWNER);
    expect(p.text).toBe("📈 За 14 днів: 80,0 → 79,4 кг (−0,75 %/тиж) — нижче, ніж треба для цілі. Пропоную 2480 → 2580 ккал (вуглеводи +25 г).");
    expect(p.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["n:a:100:20261120", "n:d:20261120"]);
    expect(await trendRows()).toEqual([{ local_date: TODAY, message_id: 100 }]);
    expect(await count("nutrition_targets")).toBe(1); // сама пропозиція норму не змінює
  });

  it("вага йде вгору → −100 і «вище»", async () => {
    await seedWeights(TODAY, 806, 800);
    await tick();
    expect(tg.texts()[0]).toBe("📈 За 14 днів: 80,0 → 80,6 кг (+0,75 %/тиж) — вище, ніж треба для цілі. Пропоную 2480 → 2380 ккал (вуглеводи −25 г).");
    expect((tg.calls[0]!.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data).toBe("n:a:-100:20261120");
  });

  it("повторні тіки того ж дня й наступні дні до 14-го — нічого", async () => {
    await seedWeights();
    await tick();
    await tick(TICK + 15 * 60_000);
    await tick(TICK + 30 * 60_000);
    expect(tg.calls).toHaveLength(1);
    // 12-04 — рівно 14 днів після пропозиції 11-20: вікно даних має бути свіжим
    await seedWeights("2026-12-03");
    await tick(TICK + 13 * 86_400_000); // 12-03: 13 днів — рано
    expect(tg.calls).toHaveLength(1);
    await seedWeights("2026-12-04");
    await tick(TICK + 14 * 86_400_000); // 12-04: 14 днів
    expect(tg.calls).toHaveLength(2);
    expect((await trendRows()).map((r) => r.local_date)).toEqual(["2026-11-20", "2026-12-04"]);
  });

  it("не раніше ніж через 14 днів від valid_from чинної норми", async () => {
    await env.DB.prepare("DELETE FROM nutrition_targets").run();
    await norm("2026-11-07", 2480, "formula"); // 13 днів до 11-20
    await seedWeights();
    await tick();
    expect(tg.calls).toHaveLength(0);
    await env.DB.prepare("UPDATE nutrition_targets SET valid_from = '2026-11-06'").run(); // рівно 14
    await tick();
    expect(tg.calls).toHaveLength(1);
  });

  it("9 зважувань → тихо, заявки немає (завтра перевіримо знову)", async () => {
    await seedWeights(TODAY, 794, 800, 4, 5);
    const c = await tick();
    expect(c).toMatchObject({ sent: 0, errors: 0 });
    expect(tg.calls).toHaveLength(0);
    expect(await trendRows()).toEqual([]);
  });

  it("p у смузі → тихо, заявки немає (цикл не спалюється)", async () => {
    await seedWeights(TODAY, 798, 800); // −0,25 %: смуга recomp
    await tick();
    expect(tg.calls).toHaveLength(0);
    expect(await trendRows()).toEqual([]);
  });

  it("без норми, без цілі у профілі, поза вікном 09:00–10:00 — нічого", async () => {
    await seedWeights();
    await tick(Date.parse("2026-11-20T08:00:00Z")); // 10:00 Києва
    await tick(Date.parse("2026-11-20T06:45:00Z")); // 08:45
    expect(tg.calls).toHaveLength(0);
    await env.DB.prepare("UPDATE user_profiles SET goal = NULL").run();
    await tick();
    expect(tg.calls).toHaveLength(0);
    await env.DB.prepare("UPDATE user_profiles SET goal = 'recomp'").run();
    await env.DB.prepare("DELETE FROM nutrition_targets").run();
    await tick();
    expect(tg.calls).toHaveLength(0);
    expect(await trendRows()).toEqual([]);
  });

  it("визначена недоставка (403) знімає заявку; наступний тік у вікні повторить", async () => {
    await seedWeights();
    tg = scriptedTelegram([403]);
    expect(await tick()).toMatchObject({ released: 1, sent: 0 });
    expect(await trendRows()).toEqual([]);
    await tick(TICK + 15 * 60_000);
    expect(tg.calls).toHaveLength(2);
    expect(await trendRows()).toHaveLength(1);
  });

  it("відхилення від formula-норми вже 300 ккал → пропозиції немає", async () => {
    await norm("2026-11-05", 2780, "trend", "2026-11-05");
    await seedWeights();
    await tick();
    expect(tg.calls).toHaveLength(0);
  });
});

describe("P3.4.3 прийняття", () => {
  it("[Прийняти] двічі → один рядок trend: source_date, ккал +100, вуглеводи +25; другий раз — «Вже застосовано»", async () => {
    await seedWeights();
    await tick();
    await tap("n:a:100:20261120");
    expect(await targetRows()).toEqual([
      { v: "2026-11-01", kcal: 2480, p: 144, f: 64, c: 332, reason: "formula", s: null },
      { v: TODAY, kcal: 2580, p: 144, f: 64, c: 357, reason: "trend", s: TODAY },
    ]);
    const reply = bot.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(String(reply.payload.text)).toBe("✅ Нова норма від 20.11: 2580 ккал · Б 144 г · Ж 64 г · В 357 г");
    expect(bot.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
    await tap("n:a:100:20261120");
    expect(await count("nutrition_targets")).toBe(2);
    expect(toast()).toBe("Вже застосовано");
    expect((await repo.getTargetOn(OWNER, TODAY))?.kcal).toBe(2580);
    expect((await repo.getTargetOn(OWNER, "2026-11-19"))?.kcal).toBe(2480); // минула дата — стара норма
  });

  it("прийняття наступного дня: valid_from = день натискання, а не дата пропозиції", async () => {
    await seedWeights();
    await tick();
    now = TICK + 86_400_000;
    await tap("n:a:100:20261120");
    expect((await targetRows()).at(-1)).toMatchObject({ v: "2026-11-21", kcal: 2580, s: TODAY });
  });

  it("−100: ккал −100, вуглеводи −25", async () => {
    await seedWeights(TODAY, 806, 800);
    await tick();
    await tap("n:a:-100:20261120");
    expect((await targetRows()).at(-1)).toMatchObject({ kcal: 2380, c: 307, reason: "trend" });
  });

  it("пропозиція старша за новішу заявку trend → «Пропозиція застаріла», рядків немає", async () => {
    await seedWeights();
    await tick();
    await env.DB.prepare("INSERT INTO reminders_sent (user_id, kind, local_date, sent_at, message_id) VALUES (?, 'trend', '2026-12-04', 0, 5)").bind(OWNER).run();
    await tap("n:a:100:20261120");
    expect(toast()).toBe("Пропозиція застаріла");
    expect(await count("nutrition_targets")).toBe(1);
  });

  it("після дати пропозиції з'явився новий valid_from → застаріла", async () => {
    await seedWeights();
    await tick();
    await norm("2026-11-25", 2500, "trend", "2026-11-25");
    await tap("n:a:100:20261120");
    expect(toast()).toBe("Пропозиція застаріла");
    expect(await count("nutrition_targets")).toBe(2);
  });

  it("кнопка без заявки (підроблена дата) → застаріла", async () => {
    await tap("n:a:100:20261120");
    expect(toast()).toBe("Пропозиція застаріла");
    expect(await count("nutrition_targets")).toBe(1);
  });

  it("[Ні] лише знімає кнопки: норма та сама, заявка лишається", async () => {
    await seedWeights();
    await tick();
    await tap("n:d:20261120");
    expect(await count("nutrition_targets")).toBe(1);
    expect(await trendRows()).toHaveLength(1);
    expect(bot.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
    expect(toast()).toBe("Добре, норму не чіпаю");
  });

  it("чужа норма: прийняття чіпає лише норми свого користувача", async () => {
    await repo.upsertUser(999, "Інший", 0);
    await repo.insertTarget(999, { validFrom: "2026-11-01", kcal: 2000, proteinG: 100, fatG: 60, carbsG: 265, reason: "formula", sourceDate: null }, 0);
    await seedWeights();
    await tick();
    await tap("n:a:100:20261120");
    const other = await env.DB.prepare("SELECT COUNT(*) AS n FROM nutrition_targets WHERE user_id = 999").first<{ n: number }>();
    expect(other!.n).toBe(1);
  });
});

describe("P3.4.7 міграція 0008", () => {
  it("рядки reminders_sent збережені, `trend` приймається, чуже значення — ні", async () => {
    const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const m = migrations.find((x) => x.name.startsWith("0008"));
    expect(m, "міграції 0008 немає").toBeDefined();
    // Повертаємо стару таблицю (форма 0005), кладемо рядки й накочуємо тіло 0008.
    await env.DB.prepare("DROP TABLE reminders_sent").run();
    await env.DB.prepare(
      "CREATE TABLE reminders_sent (user_id integer NOT NULL, kind text NOT NULL, local_date text NOT NULL, sent_at integer NOT NULL, message_id integer, PRIMARY KEY(user_id, kind, local_date), FOREIGN KEY (user_id) REFERENCES users(id), CONSTRAINT reminders_sent_kind CHECK(kind IN ('train', 'weigh', 'report')), CONSTRAINT reminders_sent_date CHECK(local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'))",
    ).run();
    await env.DB.prepare("INSERT INTO reminders_sent VALUES (?, 'weigh', '2026-11-21', 1795242630977, 100), (?, 'train', '2026-11-20', 5, NULL), (?, 'report', '2026-11-15', 7, 9)").bind(OWNER, OWNER, OWNER).run();
    await expect(env.DB.prepare("INSERT INTO reminders_sent VALUES (?, 'trend', '2026-11-20', 1, 1)").bind(OWNER).run()).rejects.toThrow(); // стара CHECK
    for (const q of m!.queries) await env.DB.prepare(q).run();
    const rows = await env.DB.prepare("SELECT user_id, kind, local_date, sent_at, message_id FROM reminders_sent ORDER BY local_date").all();
    expect(rows.results).toEqual([
      { user_id: OWNER, kind: "report", local_date: "2026-11-15", sent_at: 7, message_id: 9 },
      { user_id: OWNER, kind: "train", local_date: "2026-11-20", sent_at: 5, message_id: null },
      { user_id: OWNER, kind: "weigh", local_date: "2026-11-21", sent_at: 1795242630977, message_id: 100 },
    ]);
    await env.DB.prepare("INSERT INTO reminders_sent VALUES (?, 'trend', '2026-11-20', 1, 1)").bind(OWNER).run();
    await expect(env.DB.prepare("INSERT INTO reminders_sent VALUES (?, 'bogus', '2026-11-20', 1, 1)").bind(OWNER).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO reminders_sent VALUES (?, 'trend', '2026-11-20', 1, 1)").bind(OWNER).run()).rejects.toThrow(); // PK збережено
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'reminders_sent%'").all<{ name: string }>();
    expect(tables.results.map((t) => t.name).sort()).toEqual(["reminders_sent"]);
  });
});
