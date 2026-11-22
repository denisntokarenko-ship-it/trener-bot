import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { foodsSeedStatements, type FoodsSeed } from "../scripts/foods-seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { isFoodCb } from "../src/bot/food-flow";
import { BOT_COMMANDS, FOOD_ASK_HEAD, foodAskFieldOf, foodAskText } from "../src/bot/texts";
import { createDb } from "../src/db/client";
import { createRepo, type ProfilePatch } from "../src/db/repo";
import { bmrMifflin, firstMissing, normWeightKg, round10, targets, type NormProfile } from "../src/domain/nutrition";
import { OWNER, botInfo, count, env, fakeTelegram, outgoingProblems, resetDb, textUpdate, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const NOON = Date.parse("2026-11-20T10:00:00Z"); // 12:00 Києва, 2026-11-20
let now = NOON;
let tg = fakeTelegram();
let updateId = 1;

async function send(update: Update): Promise<void> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => now });
  await handleRequest(webhookRequest(update), env, handler);
}
const say = (text: string) => send(textUpdate(updateId++, OWNER, text));
/** Відповідь (reply) на повідомлення бота з даним текстом. */
function replyTo(question: string, text: string): Update {
  const u = textUpdate(updateId++, OWNER, text) as unknown as { message: Record<string, unknown> };
  u.message.reply_to_message = { message_id: 55, date: 0, chat: u.message.chat, from: botInfo, text: question };
  return u as unknown as Update;
}
function cb(data: string): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: "cb" + updateId,
      from: { id: OWNER, is_bot: false, first_name: "Денис" },
      chat_instance: "ci",
      data,
      message: { message_id: 7, date: 0, chat: { id: OWNER, type: "private", first_name: "Денис" }, text: "питання" },
    },
  } as Update;
}
const sent = () => tg.calls.filter((c) => c.method === "sendMessage");
const texts = () => sent().map((c) => String(c.payload.text));
const lastText = () => texts().at(-1)!;
const buttons = (i = -1) => ((sent().at(i)!.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const targetRows = () => env.DB.prepare("SELECT valid_from AS v, kcal, protein_g AS p, fat_g AS f, carbs_g AS c, reason FROM nutrition_targets ORDER BY valid_from").all();
const profile = (patch: ProfilePatch) => repo.upsertProfile(OWNER, patch, 0);
const FULL: ProfilePatch = { goal: "recomp", sex: "m", birthYear: 1996, heightCm: 180, activity: "mid", weightKg: 80 };

async function seedFood(name: string, kcal: number): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO foods (name_uk, kcal_100, protein_100_dg, fat_100_dg, carbs_100_dg, source, fdc_ref, created_at) VALUES (?, ?, 100, 50, 200, 'seed', NULL, 0)").bind(name, kcal).run();
  return r.meta.last_row_id;
}
/** Прийом за локальну дату: confirmed (за замовчуванням) чи pending. */
async function meal(foodId: number, grams: number, opts: { date?: string; at?: string; confirm?: boolean } = {}): Promise<number> {
  const date = opts.date ?? "2026-11-20";
  const id = await repo.createPendingMeal(OWNER, { eatenAt: Date.parse(opts.at ?? `${date}T08:00:00Z`), localDate: date, photoFileId: null, caption: null, aiModel: "m", aiRawJson: "{}", items: [{ foodId, grams, confidence: "high" }] }, NOON);
  if (opts.confirm !== false) await repo.confirmMeal(OWNER, id!, NOON);
  return id!;
}

beforeEach(async () => {
  await resetDb();
  now = NOON;
  tg = fakeTelegram();
  updateId = 1;
  await repo.upsertUser(OWNER, "Денис", 0);
});
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
});

describe("P3.2.1 домен: Міффлін і норма", () => {
  const m: NormProfile = { sex: "m", birthYear: 1996, heightCm: 180, activity: "mid", goal: "recomp" };
  const f: NormProfile = { sex: "f", birthYear: 1996, heightCm: 165, activity: "low", goal: "recomp" };

  it("BMR: обидві статі за відомими значеннями (поправка +5 / −161)", () => {
    expect(bmrMifflin("m", 80, 180, 30)).toBe(1780);
    expect(bmrMifflin("f", 60, 165, 30)).toBe(1320.25);
    expect(bmrMifflin("m", 80, 180, 30) - bmrMifflin("f", 80, 180, 30)).toBe(166);
  });

  it("контрольні вектори спеки: m 2480 (Б144 Ж64 В332), f 1630 (Б108 Ж48 В192)", () => {
    expect(targets(m, 80, 2026)).toEqual({ kcal: 2480, proteinG: 144, fatG: 64, carbsG: 332 });
    expect(targets(f, 60, 2026)).toEqual({ kcal: 1630, proteinG: 108, fatG: 48, carbsG: 192 });
  });

  it("4Б + 9Ж > kcal → вуглеводи 0 і kcal = 4Б + 9Ж (2060 → 2160)", () => {
    expect(targets({ sex: "f", birthYear: 1946, heightCm: 150, activity: "low", goal: "lose_fat" }, 150, 2026)).toEqual({ kcal: 2160, proteinG: 270, fatG: 120, carbsG: 0 });
  });

  it("цілі: lose_fat −20 %, muscle +10 %, strength/health/other 0; активність low < mid < high", () => {
    const base = { sex: "m", birthYear: 1996, heightCm: 180, activity: "mid" } as const;
    const k = (goal: NormProfile["goal"], activity: NormProfile["activity"] = "mid") => targets({ ...base, goal, activity }, 80, 2026)!.kcal;
    expect(k("lose_fat")).toBe(2210); // 2759 × 0,8 = 2207,2
    expect(k("muscle")).toBe(3030); // 2759 × 1,1 = 3034,9
    expect(k("strength")).toBe(2760);
    expect(k("health")).toBe(k("other"));
    expect(k("health", "low")).toBeLessThan(k("health", "mid"));
    expect(k("health", "mid")).toBeLessThan(k("health", "high"));
  });

  it("вуглеводи ніколи не від'ємні, kcal ціле й кратне 10 (крім підлоги 4Б+9Ж), на сітці профілів", () => {
    for (const sex of ["m", "f"] as const)
      for (const goal of ["lose_fat", "recomp", "muscle", "strength", "health", "other"] as const)
        for (const activity of ["low", "mid", "high"] as const)
          for (const w of [40, 55, 80, 120, 200, 300])
            for (const h of [150, 175, 200])
              for (const by of [1950, 1990, 2010]) {
                const n = targets({ sex, birthYear: by, heightCm: h, activity, goal }, w, 2026);
                if (n === null) continue;
                expect(n.carbsG).toBeGreaterThanOrEqual(0);
                expect(n.kcal).toBeGreaterThanOrEqual(4 * n.proteinG + 9 * n.fatG);
                expect(Number.isInteger(n.kcal)).toBe(true);
              }
  });

  it("kcal поза 800–6000 → null (норми немає)", () => {
    expect(targets({ sex: "f", birthYear: 1930, heightCm: 120, activity: "low", goal: "lose_fat" }, 30, 2026)).toBeNull(); // ≈ 450
    expect(targets({ sex: "m", birthYear: 2010, heightCm: 230, activity: "high", goal: "muscle" }, 300, 2026)).toBeNull(); // > 6000
  });

  it("round10: половина вгору", () => {
    expect([2484.9, 2485, 2490.1, 0].map(round10)).toEqual([2480, 2490, 2490, 0]);
  });

  it("вага для норми: середнє W0 → останній запис → вага з анкети → немає", () => {
    expect(normWeightKg({ avgDg: 784, lastDg: 790, profileKg: 80 })).toBe(78.4);
    expect(normWeightKg({ avgDg: null, lastDg: 790, profileKg: 80 })).toBe(79);
    expect(normWeightKg({ avgDg: null, lastDg: null, profileKg: 80 })).toBe(80);
    expect(normWeightKg({ avgDg: null, lastDg: null, profileKg: null })).toBeNull();
  });

  it("порядок питань: ціль → стать → рік → зріст → активність → вага", () => {
    const p = { goal: null, sex: null, birthYear: null, heightCm: null, activity: null };
    expect(firstMissing(null, null)).toBe("goal");
    expect(firstMissing(p, 80)).toBe("goal");
    expect(firstMissing({ ...p, goal: "recomp" }, 80)).toBe("sex");
    expect(firstMissing({ ...p, goal: "recomp", sex: "m" }, 80)).toBe("birth_year");
    expect(firstMissing({ ...p, goal: "recomp", sex: "m", birthYear: 1990 }, 80)).toBe("height_cm");
    expect(firstMissing({ ...p, goal: "recomp", sex: "m", birthYear: 1990, heightCm: 180 }, 80)).toBe("activity");
    expect(firstMissing({ goal: "recomp", sex: "m", birthYear: 1990, heightCm: 180, activity: "low" }, null)).toBe("weight");
    expect(firstMissing({ goal: "recomp", sex: "m", birthYear: 1990, heightCm: 180, activity: "low" }, 80)).toBeNull();
  });
});

describe("/yizha: норма на дату, ліниве створення", () => {
  it("P3.2.2: норма 2480 з 01.11 і 2580 з 15.11, /yizha за 10.11 → 2480 (чинна на дату, не найновіша)", async () => {
    await profile(FULL);
    await repo.insertTarget(OWNER, { validFrom: "2026-11-01", kcal: 2480, proteinG: 144, fatG: 64, carbsG: 332, reason: "formula", sourceDate: null }, 0);
    await repo.insertTarget(OWNER, { validFrom: "2026-11-15", kcal: 2580, proteinG: 144, fatG: 64, carbsG: 357, reason: "trend", sourceDate: "2026-11-14" }, 0);
    now = Date.parse("2026-11-10T10:00:00Z");
    await say("/yizha");
    expect(lastText()).toContain("2 480");
    expect(lastText()).not.toContain("2 580");
    expect(lastText()).toContain("норма від 01.11");
    expect(await count("nutrition_targets")).toBe(2); // нічого не додано: норма вже є
    now = Date.parse("2026-11-16T10:00:00Z");
    await say("/yizha");
    expect(lastText()).toContain("2 580");
  });

  it("нова норма з valid_from не змінює підсумок минулого дня: рядок минулого дня береться з тієї норми, що діяла", async () => {
    await profile(FULL);
    await repo.insertTarget(OWNER, { validFrom: "2026-11-01", kcal: 2480, proteinG: 144, fatG: 64, carbsG: 332, reason: "formula", sourceDate: null }, 0);
    expect((await repo.getTargetOn(OWNER, "2026-11-14"))?.kcal).toBe(2480);
    await repo.insertTarget(OWNER, { validFrom: "2026-11-15", kcal: 2580, proteinG: 144, fatG: 64, carbsG: 357, reason: "trend", sourceDate: "2026-11-14" }, 0);
    expect((await repo.getTargetOn(OWNER, "2026-11-14"))?.kcal).toBe(2480);
    const food = await seedFood("страва", 100);
    await meal(food, 200, { date: "2026-11-14" });
    expect(await repo.dayTotals(OWNER, "2026-11-14")).toMatchObject({ kcal: 200 });
  });

  it("P3.2.3: повний профіль без норми → рядок formula на сьогодні; повторно — без нового рядка", async () => {
    await profile(FULL);
    await say("/yizha");
    expect(await targetRows()).toMatchObject({ results: [{ v: "2026-11-20", kcal: 2480, p: 144, f: 64, c: 332, reason: "formula" }] });
    expect(lastText()).toContain("0 / 2 480");
    expect(lastText()).toContain("Б 0 / 144 г · Ж 0 / 64 г · В 0 / 332 г");
    await say("/yizha");
    expect(await count("nutrition_targets")).toBe(1);
    expect(sent()).toHaveLength(2); // жодних питань
  });

  it("вік рахується від року локальної дати: m 1996, strength (Δ 0) у 2026 → 2760, а не 2750 (вік 31)", async () => {
    await profile({ ...FULL, goal: "strength" });
    await say("/yizha");
    expect((await targetRows()).results[0]).toMatchObject({ kcal: 2760 });
  });

  it("вага для норми — «Зараз» із body_weights (середнє W0), а не з анкети", async () => {
    await profile(FULL); // анкета: 80 кг
    await repo.upsertBodyWeight(OWNER, "2026-11-19", 700, 0);
    await repo.upsertBodyWeight(OWNER, "2026-11-20", 720, 0); // середнє 71,0
    await say("/yizha");
    const n = targets({ sex: "m", birthYear: 1996, heightCm: 180, activity: "mid", goal: "recomp" }, 71, 2026)!;
    expect((await targetRows()).results[0]).toMatchObject({ kcal: n.kcal, p: n.proteinG });
    expect(n.kcal).not.toBe(2480);
  });

  it("P3.2.6: 14 підтверджених і 1 pending — сума без pending, «Не підтверджено: 1», ≤ 4096, «…ще 2»", async () => {
    await profile(FULL);
    const long = await seedFood("Дуже довга назва страви ".repeat(2).trim().slice(0, 55), 100);
    for (let i = 0; i < 14; i++) await meal(long, 100, { at: `2026-11-20T${String(6 + i).padStart(2, "0")}:00:00Z` });
    await meal(long, 500, { confirm: false });
    await say("/yizha");
    const t = lastText();
    expect(t).toContain("1 400 / 2 480");
    expect(t.split("\n")).toContain("⏳ Не підтверджено: 1"); // рівно 1, а не 15
    expect(t).toContain("…ще 2");
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(12);
  });

  it("час прийому — за tz користувача; підсумок не переходить через північ за UTC", async () => {
    await profile(FULL);
    const food = await seedFood("рис", 100);
    await meal(food, 100, { at: "2026-11-20T07:30:00Z" }); // 09:30 Києва
    await say("/yizha");
    expect(lastText()).toContain("• 09:30 — рис 100 г · 100 ккал");
    await meal(food, 300, { date: "2026-11-19" }); // вчора — не в сумі
    await say("/yizha");
    expect(lastText()).toContain("100 / 2 480");
  });

  it("перебір: «+N ккал понад норму»; без прийомів — «ще нічого не підтверджено»", async () => {
    await profile(FULL);
    await say("/yizha");
    expect(lastText()).toContain("Сьогодні ще нічого не підтверджено.");
    const food = await seedFood("торт", 500);
    await meal(food, 600); // 3000 ккал
    await say("/yizha");
    expect(lastText()).toContain("+520 ккал понад норму");
  });

  it("P3.2.7: профіль із kcal поза 800–6000 → норми немає, «Перевір профіль», виняток не кидається, сума показана", async () => {
    await profile({ goal: "lose_fat", sex: "f", birthYear: 1930, heightCm: 120, activity: "low", weightKg: 30 });
    await say("/yizha");
    expect(lastText()).toContain("Перевір профіль");
    expect(lastText()).toContain("З'їдено");
    expect(await count("nutrition_targets")).toBe(0);
    expect(sent()).toHaveLength(1); // питань немає: поля заповнені
  });
});

describe("/yizha: прогалини профілю", () => {
  it("P3.2.4: рік народження порожній → сума дня + одне питання; reply 1996 → записано, далі норма й підсумок", async () => {
    await profile({ ...FULL, birthYear: null });
    await say("/yizha");
    expect(texts()).toHaveLength(2); // підсумок + одне питання
    expect(texts()[0]).toContain("З'їдено");
    expect(texts()[1]).toBe(foodAskText("birth_year"));
    expect(await count("nutrition_targets")).toBe(0);

    await send(replyTo(foodAskText("birth_year"), "1996"));
    expect((await repo.getProfile(OWNER))?.birthYear).toBe(1996);
    expect(await targetRows()).toMatchObject({ results: [{ kcal: 2480, reason: "formula" }] });
    expect(lastText()).toContain("2 480");
  });

  it("reply 1929 / abc / 2021 → підказка, значення не змінене й не питається інше", async () => {
    await profile({ ...FULL, birthYear: null });
    await say("/yizha");
    for (const bad of ["1929", "abc", "2021", "1996.5", ""]) {
      const before = sent().length;
      await send(replyTo(foodAskText("birth_year"), bad || " "));
      expect(sent().length, bad).toBe(before + 1);
      expect(lastText(), bad).toContain("❌ Рік народження");
      expect((await repo.getProfile(OWNER))?.birthYear, bad).toBeNull();
    }
    expect(await count("nutrition_targets")).toBe(0);
  });

  it("onboarding_state і training_days не змінюються; анкета не запускається", async () => {
    await profile({ ...FULL, birthYear: null });
    const before = await env.DB.prepare("SELECT training_days, remind_time, weigh_time FROM users WHERE id = ?").bind(OWNER).first();
    await say("/yizha");
    await send(replyTo(foodAskText("birth_year"), "1996"));
    expect(await count("onboarding_state")).toBe(0);
    expect(await env.DB.prepare("SELECT training_days, remind_time, weigh_time FROM users WHERE id = ?").bind(OWNER).first()).toEqual(before);
    expect(texts().join("\n")).not.toContain("Питання");
  });

  it("стать порожня → кнопки f:sx:m|f; тап записує; повторний тап іншого — без змін", async () => {
    await profile({ ...FULL, sex: null });
    await say("/yizha");
    expect(texts()[1]).toBe(FOOD_ASK_HEAD.sex);
    const kb = buttons();
    expect(kb.map((b) => b.callback_data)).toEqual(["f:sx:m", "f:sx:f"]);
    await send(cb("f:sx:m"));
    expect((await repo.getProfile(OWNER))?.sex).toBe("m");
    expect(await count("nutrition_targets")).toBe(1); // остання прогалина закрита → норма
    await send(cb("f:sx:f"));
    expect((await repo.getProfile(OWNER))?.sex).toBe("m");
    const answers = tg.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text);
    expect(answers.at(-1)).toContain("вже заповнено");
  });

  it("порожній профіль: питання йдуть по одному за порядком (ціль → стать → рік → зріст → активність → вага), по одному на крок", async () => {
    await say("/yizha");
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toBe(FOOD_ASK_HEAD.goal);
    expect(buttons().map((b) => b.callback_data)).toEqual(["f:go:lose_fat", "f:go:muscle", "f:go:recomp", "f:go:strength", "f:go:health", "f:go:other"]);
    await send(cb("f:go:recomp"));
    expect(lastText()).toBe(FOOD_ASK_HEAD.sex);
    await send(cb("f:sx:f"));
    expect(foodAskFieldOf(lastText())).toBe("birth_year");
    await send(replyTo(lastText(), "1996"));
    expect(foodAskFieldOf(lastText())).toBe("height_cm");
    await send(replyTo(lastText(), "165"));
    expect(lastText()).toBe(FOOD_ASK_HEAD.activity);
    expect(buttons().map((b) => b.callback_data)).toEqual(["f:ac:low", "f:ac:mid", "f:ac:high"]);
    await send(cb("f:ac:low"));
    expect(foodAskFieldOf(lastText())).toBe("weight");
    expect(await count("nutrition_targets")).toBe(0);
    await send(replyTo(lastText(), "60"));
    expect((await repo.getProfile(OWNER))?.weightKg).toBe(60);
    expect(await count("body_weights")).toBe(0); // вага з питання — знімок анкети, не запис тренду
    expect(await targetRows()).toMatchObject({ results: [{ kcal: 1630, p: 108, f: 48, c: 192, reason: "formula" }] });
    expect(lastText()).toContain("0 / 1 630");
    expect(await count("onboarding_state")).toBe(0);
  });

  it("вага порожня в анкеті, але є запис body_weights → вага не питається", async () => {
    await profile({ ...FULL, weightKg: null });
    await repo.upsertBodyWeight(OWNER, "2026-11-20", 800, 0);
    await say("/yizha");
    expect(sent()).toHaveLength(1);
    expect(await count("nutrition_targets")).toBe(1);
  });

  it("reply на питання про вагу: межі 30–300; вже заповнене поле — без змін", async () => {
    await profile({ ...FULL, weightKg: null });
    await say("/yizha");
    for (const bad of ["29", "301", "abc"]) {
      await send(replyTo(foodAskText("weight"), bad));
      expect(lastText()).toContain("❌ Вага");
    }
    expect((await repo.getProfile(OWNER))?.weightKg).toBeNull();
    await send(replyTo(foodAskText("weight"), "80,5"));
    expect((await repo.getProfile(OWNER))?.weightKg).toBe(80.5);
    await send(replyTo(foodAskText("weight"), "90"));
    expect((await repo.getProfile(OWNER))?.weightKg).toBe(80.5);
    expect(lastText()).toContain("вже заповнено");
  });

  it("P3.2.5: усі поля заповнені → жодного питання, анкета не запускається вдруге", async () => {
    await profile(FULL);
    await say("/yizha");
    await say("/yizha");
    expect(sent()).toHaveLength(2);
    expect(tg.calls.some((c) => c.payload.reply_markup)).toBe(false);
    expect(await count("onboarding_state")).toBe(0);
  });

  it("reply на чуже повідомлення — не наше питання: іде далі за звичайною маршрутизацією", async () => {
    await profile(FULL);
    await send(replyTo("щось інше", "1996"));
    expect(lastText()).toContain("Не зрозумів");
  });
});

describe("маршрутизація й меню", () => {
  it("f:go|sx|ac — наші кнопки; f:<число>:<число> (оцінка тренування) — ні", () => {
    for (const d of ["f:go:lose_fat", "f:sx:m", "f:ac:high"]) expect(isFoodCb(d), d).toBe(true);
    for (const d of ["f:12:3", "f:go", "f:xx:m", "f:sx:M", "o:g:lose_fat", "f:sx:m:1"]) expect(isFoodCb(d), d).toBe(false);
  });

  it("yizha — у BOT_COMMANDS з описом «Їжа за день і норма»", () => {
    expect(BOT_COMMANDS).toContainEqual({ command: "yizha", description: "Їжа за день і норма" });
  });

  it("заголовки питань унікальні (за ними впізнається reply)", () => {
    expect(new Set(Object.values(FOOD_ASK_HEAD)).size).toBe(6);
    expect(foodAskFieldOf(foodAskText("height_cm"))).toBe("height_cm");
    expect(foodAskFieldOf("…")).toBeNull();
    expect(foodAskFieldOf(undefined)).toBeNull();
  });
});

describe("В1 рев'ю Фази 3: /yizha показує знімок, не foods наживо", () => {
  const seedOf = (kcal: number): FoodsSeed => ({
    source_note: "test",
    sampled_at: "2026-11-20",
    foods: [{ name_uk: "рис варений", aliases: ["рис варений"], fdc_ref: "990001", kcal_100: kcal, protein_100_dg: 27, fat_100_dg: 3, carbs_100_dg: 280 }],
  });
  const summary = () => texts().filter((t) => t.includes("Їжа за сьогодні")).at(-1)!; // далі може йти питання про профіль
  const applySeed = (kcal: number) => env.DB.batch(foodsSeedStatements(seedOf(kcal), 0).map((q) => env.DB.prepare(q)));

  it("правка foods повторним сидом після підтвердження не змінює ні рядка прийому, ні «З'їдено»", async () => {
    await applySeed(130);
    const riceId = (await env.DB.prepare("SELECT id FROM foods WHERE fdc_ref = '990001'").first<{ id: number }>())!.id;
    await meal(riceId, 180, { at: "2026-11-20T08:00:00Z" }); // 10:00 Києва, знімок 234 ккал
    await say("/yizha");
    const before = summary();
    expect(before).toContain("• 10:00 — рис варений 180 г · 234 ккал");
    expect(before).toContain("З'їдено <b>234</b> ккал");
    await applySeed(200); // сид оновлює продукт на місці (ON CONFLICT (fdc_ref) DO UPDATE)
    expect(await env.DB.prepare("SELECT kcal_100 FROM foods WHERE id = ?").bind(riceId).first("kcal_100")).toBe(200);
    await say("/yizha");
    expect(summary()).toBe(before);
  });
});
