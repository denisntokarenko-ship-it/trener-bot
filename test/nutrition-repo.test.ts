import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { createRepo, type NewMeal } from "../src/db/repo";
import { localDate } from "../src/domain/time";
import { count, env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const U = 111;
const OTHER = 222;
const DAY = "2026-11-20";
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(U, "Денис", 0);
  await repo.upsertUser(OTHER, "Інший", 0);
});

/** Продукт сиду прямим SQL (аліас — нормалізований name_uk). */
async function seedFood(name: string, kcal: number, p: number, f: number, c: number, ref: string | null = null): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO foods (name_uk, kcal_100, protein_100_dg, fat_100_dg, carbs_100_dg, source, fdc_ref, created_at) VALUES (?, ?, ?, ?, ?, 'seed', ?, 0)")
    .bind(name, kcal, p, f, c, ref)
    .run();
  const id = r.meta.last_row_id;
  await env.DB.prepare("INSERT INTO food_aliases (alias, food_id) VALUES (?, ?)").bind(name.toLowerCase(), id).run();
  return id;
}

function meal(items: NewMeal["items"], date = DAY): NewMeal {
  return { eatenAt: NOW, localDate: date, photoFileId: "AgACAgIAAxkB", caption: null, aiModel: "claude-sonnet-5-5", aiRawJson: "{}", items };
}

async function pending(userId: number, items: NewMeal["items"], date = DAY, now = NOW): Promise<number> {
  const id = await repo.createPendingMeal(userId, meal(items, date), now);
  expect(id).not.toBeNull();
  return id!;
}

describe("dayTotals і знімок (P3.1.1–2)", () => {
  it("P3.1.1: pending і cancelled не входять у dayTotals; після confirmMeal сума = знімок прийому", async () => {
    const rice = await seedFood("рис", 100, 20, 10, 250); // 100 ккал/100 г
    const pendingId = await pending(U, [{ foodId: rice, grams: 600, confidence: "high" }]); // 600 ккал, не підтверджений
    // Захист у глибину: навіть якщо в pending-прийомі випадково є знімок, він не рахується.
    await env.DB.prepare("UPDATE meal_items SET kcal = 600, protein_dg = 120, fat_dg = 60, carbs_dg = 1500 WHERE meal_id = ?").bind(pendingId).run();
    const cancelled = await pending(U, [{ foodId: rice, grams: 300, confidence: "high" }]); // 300 ккал
    expect(await repo.confirmMeal(U, cancelled, NOW)).toBe(true);
    expect(await repo.cancelMeal(U, cancelled)).toBe(true); // знімок лишається для історії

    expect(await repo.dayTotals(U, DAY)).toEqual({ kcal: 0, proteinDg: 0, fatDg: 0, carbsDg: 0 });

    const ok = await pending(U, [{ foodId: rice, grams: 150, confidence: "high" }]);
    expect(await repo.confirmMeal(U, ok, NOW)).toBe(true);
    expect(await repo.dayTotals(U, DAY)).toEqual({ kcal: 150, proteinDg: 30, fatDg: 15, carbsDg: 375 });
    expect(await repo.dayTotals(U, "2026-11-21")).toEqual({ kcal: 0, proteinDg: 0, fatDg: 0, carbsDg: 0 });
    expect(await repo.dayTotals(OTHER, DAY)).toEqual({ kcal: 0, proteinDg: 0, fatDg: 0, carbsDg: 0 });
  });

  it("P3.1.2: зміна foods після confirm не змінює минулий день (знімок, не foods)", async () => {
    const rice = await seedFood("рис", 130, 27, 3, 282);
    const m = await pending(U, [{ foodId: rice, grams: 200, confidence: "medium" }]);
    await repo.confirmMeal(U, m, NOW);
    const before = await repo.dayTotals(U, DAY);
    expect(before.kcal).toBe(260);

    await env.DB.prepare("UPDATE foods SET kcal_100 = 900, protein_100_dg = 0, fat_100_dg = 0, carbs_100_dg = 0 WHERE id = ?").bind(rice).run();
    expect(await repo.dayTotals(U, DAY)).toEqual(before);
    const view = await repo.getMeal(U, m);
    expect(view?.items[0]?.snapshot?.kcal).toBe(260);
    expect(view?.items[0]?.food.kcal).toBe(900); // живий показ — з foods, знімок — окремо
  });

  it("знімок: (грами × x_100 + 50) div 100 — половина вгору; суми цілі", async () => {
    const f = await seedFood("дивний", 87, 19, 1, 201); // 33 г: 28,71+0,5 → 29; 6,27+0,5 → 6; 0,33+0,5 → 0; 66,33+0,5 → 66
    const m = await pending(U, [{ foodId: f, grams: 33, confidence: "high" }]);
    await repo.confirmMeal(U, m, NOW);
    expect((await repo.getMeal(U, m))?.items[0]?.snapshot).toEqual({ kcal: 29, proteinDg: 6, fatDg: 0, carbsDg: 66 });
    const half = await seedFood("половина", 5, 5, 5, 5); // 10 г × 5 / 100 = 0,5 → 1
    const m2 = await pending(U, [{ foodId: half, grams: 10, confidence: "high" }]);
    await repo.confirmMeal(U, m2, NOW);
    expect((await repo.getMeal(U, m2))?.items[0]?.snapshot).toEqual({ kcal: 1, proteinDg: 1, fatDg: 1, carbsDg: 1 });
  });

  it("confirmMeal: друге натискання — false без змін; знімок не перераховується після правки foods; confirmed_at і local_date збережено", async () => {
    const rice = await seedFood("рис", 130, 27, 3, 282);
    const m = await pending(U, [{ foodId: rice, grams: 100, confidence: "high" }], "2026-11-19"); // фото до півночі, тап після
    expect(await repo.confirmMeal(U, m, NOW + 5000)).toBe(true);
    await env.DB.prepare("UPDATE foods SET kcal_100 = 500 WHERE id = ?").bind(rice).run();
    expect(await repo.confirmMeal(U, m, NOW + 9000)).toBe(false);
    const v = await repo.getMeal(U, m);
    expect(v?.status).toBe("confirmed");
    expect(v?.confirmedAt).toBe(NOW + 5000);
    expect(v?.localDate).toBe("2026-11-19");
    expect(v?.items[0]?.snapshot?.kcal).toBe(130);
    expect((await repo.dayTotals(U, "2026-11-19")).kcal).toBe(130);
  });

  it("P3.1.7: знімок kcal без protein_dg — CHECK відмовляє (усі чотири NULL або жодного)", async () => {
    const rice = await seedFood("рис", 130, 27, 3, 282);
    const m = await pending(U, [{ foodId: rice, grams: 100, confidence: "high" }]);
    await expect(env.DB.prepare("UPDATE meal_items SET kcal = 130 WHERE meal_id = ?").bind(m).run()).rejects.toThrow(/meal_items_snapshot_all_or_none|CHECK/);
    // Кожне поле знімка окремо: бракує рівно одного з чотирьох — CHECK відмовляє (інакше «дірка» в одному стовпці)
    for (const missing of ["kcal", "protein_dg", "fat_dg", "carbs_dg"]) {
      const cols = { kcal: "130", protein_dg: "1", fat_dg: "1", carbs_dg: "1", [missing]: "NULL" };
      const set = Object.entries(cols).map(([k, v]) => `${k} = ${v}`).join(", ");
      await expect(env.DB.prepare(`UPDATE meal_items SET ${set} WHERE meal_id = ?`).bind(m).run(), missing).rejects.toThrow(/CHECK/);
    }
    await expect(env.DB.prepare("UPDATE meal_items SET kcal = 130, protein_dg = 1, fat_dg = 1, carbs_dg = -1 WHERE meal_id = ?").bind(m).run()).rejects.toThrow(/CHECK/);
    await env.DB.prepare("UPDATE meal_items SET kcal = 130, protein_dg = 1, fat_dg = 1, carbs_dg = 1 WHERE meal_id = ?").bind(m).run(); // усі чотири — можна
  });
});

describe("каталог: аліаси й оцінки (P3.1.3, P3.1.6)", () => {
  it("P3.1.3: аліас з іншим регістром і апострофом знаходить продукт", async () => {
    const id = await seedFood("мясо", 250, 250, 200, 0);
    for (const s of ["Мʼясо", "м’ясо", "М'ЯСО ", "  мясо  "]) expect((await repo.findFoodByAlias(s))?.id, s).toBe(id);
    expect(await repo.findFoodByAlias("риба")).toBeNull();
    expect(await repo.findFoodByAlias("()")).toBeNull();
  });

  it("P3.1.6: insertEstimatedFood двічі з одним аліасом — один foods; паралельно теж один", async () => {
    const a = await repo.insertEstimatedFood({ nameUk: "Борщ", kcal100: 50, protein100Dg: 20, fat100Dg: 20, carbs100Dg: 60 }, NOW);
    const b = await repo.insertEstimatedFood({ nameUk: "  БОРЩ ", kcal100: 60, protein100Dg: 1, fat100Dg: 1, carbs100Dg: 1 }, NOW + 1);
    expect(a?.source).toBe("ai_estimate");
    expect(b?.id).toBe(a?.id);
    expect(b?.kcal100).toBe(50); // наявний, не перезаписаний
    expect(await count("foods")).toBe(1);

    const racing = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => repo.insertEstimatedFood({ nameUk: "Вареники", kcal100: 100 + i, protein100Dg: 30, fat100Dg: 30, carbs100Dg: 200 }, NOW + i)),
    );
    expect(new Set(racing.map((f) => f?.id)).size).toBe(1);
    expect(await count("foods")).toBe(2);
    expect(await count("food_aliases")).toBe(2);
    expect(await repo.insertEstimatedFood({ nameUk: "()", kcal100: 1, protein100Dg: 0, fat100Dg: 0, carbs100Dg: 0 }, NOW)).toBeNull();
  });

  it("insertEstimatedFood: значення поза межами схеми (Б+Ж+В > 100 г, 61 символ, ккал 901, не цілі) — null, нічого не лишає (Д1)", async () => {
    await expect(repo.insertEstimatedFood({ nameUk: "Нісенітниця", kcal100: 100, protein100Dg: 600, fat100Dg: 600, carbs100Dg: 0 }, NOW)).resolves.toBeNull(); // Д1: null, не виняток
    const bad = [
      { nameUk: "я".repeat(61), kcal100: 1, protein100Dg: 0, fat100Dg: 0, carbs100Dg: 0 },
      { nameUk: "Гарячий", kcal100: 901, protein100Dg: 0, fat100Dg: 0, carbs100Dg: 0 },
      { nameUk: "Дробовий", kcal100: 10.5, protein100Dg: 0, fat100Dg: 0, carbs100Dg: 0 },
      { nameUk: "Мінусовий", kcal100: 10, protein100Dg: -1, fat100Dg: 0, carbs100Dg: 0 },
      { nameUk: "Забагато", kcal100: 10, protein100Dg: 500, fat100Dg: 400, carbs100Dg: 101 },
    ];
    for (const b of bad) expect(await repo.insertEstimatedFood(b, NOW), b.nameUk.slice(0, 12)).toBeNull();
    expect(await count("foods")).toBe(0);
    expect(await count("food_aliases")).toBe(0);
  });
});

describe("прийоми: створення, правка, скасування (P3.1.5)", () => {
  it("createPendingMeal: один batch (прийом + позиції); немає користувача → null; зламана позиція відкочує все", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const id = await pending(U, [
      { foodId: a, grams: 100, confidence: "low" },
      { foodId: a, grams: 50, confidence: "high" },
    ]);
    const v = await repo.getMeal(U, id);
    expect(v?.status).toBe("pending");
    expect(v?.items.map((i) => [i.position, i.grams, i.confidence, i.snapshot])).toEqual([[1, 100, "low", null], [2, 50, "high", null]]);

    expect(await repo.createPendingMeal(999, meal([{ foodId: a, grams: 1, confidence: "low" }]), NOW)).toBeNull();
    expect(await repo.createPendingMeal(U, meal([]), NOW)).toBeNull();
    // Невідомий food_id у другій позиції: FK відхиляє, batch відкочується цілком — ні прийому, ні першої позиції.
    await expect(repo.createPendingMeal(U, meal([{ foodId: a, grams: 10, confidence: "low" }, { foodId: 999_999, grams: 10, confidence: "low" }]), NOW)).rejects.toThrow();
    expect(await count("meals")).toBe(1);
    expect(await count("meal_items")).toBe(2);
  });

  it("createPendingMeal: паралельні прийоми одного користувача — кожному свої позиції", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const ids = await Promise.all([1, 2, 3, 4].map((n) => repo.createPendingMeal(U, meal(Array.from({ length: n }, () => ({ foodId: a, grams: 10 * n, confidence: "high" as const }))), NOW + n)));
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      const v = await repo.getMeal(U, id!);
      expect(v!.items.length).toBeGreaterThan(0);
      expect(new Set(v!.items.map((i) => i.grams)).size).toBe(1); // усі позиції одного прийому — з одного виклику
    }
    expect(await count("meal_items")).toBe(1 + 2 + 3 + 4);
  });

  it("P3.1.5: чужий userId не бачить і не змінює прийом (getMeal/confirmMeal/updateMealGrams/cancelMeal)", async () => {
    const a = await seedFood("а", 100, 10, 10, 10);
    const id = await pending(U, [{ foodId: a, grams: 100, confidence: "high" }]);
    expect(await repo.getMeal(OTHER, id)).toBeNull();
    expect(await repo.confirmMeal(OTHER, id, NOW)).toBe(false);
    expect(await repo.updateMealGrams(OTHER, id, [{ position: 1, grams: 5 }])).toBe(false);
    expect(await repo.cancelMeal(OTHER, id)).toBe(false);
    expect(await repo.awaitingGramsMeal(OTHER, NOW, 900_000)).toBeNull();
    const v = await repo.getMeal(U, id);
    expect(v?.status).toBe("pending");
    expect(v?.items[0]?.grams).toBe(100);
    expect(v?.items[0]?.snapshot).toBeNull();
    // і після підтвердження власником чужий не скасовує й не бачить у підсумку
    await repo.confirmMeal(U, id, NOW);
    expect(await repo.cancelMeal(OTHER, id)).toBe(false);
    expect((await repo.getMeal(U, id))?.status).toBe("confirmed");
    expect((await repo.dayTotals(OTHER, DAY)).kcal).toBe(0);
  });

  it("updateMealGrams: міняє грами, 0 вилучає позицію (position не перенумеровується), знімає очікування", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const id = await pending(U, [
      { foodId: a, grams: 100, confidence: "high" },
      { foodId: a, grams: 200, confidence: "high" },
      { foodId: a, grams: 300, confidence: "high" },
    ]);
    await env.DB.prepare("UPDATE meals SET await_grams_at = ? WHERE id = ?").bind(NOW, id).run();
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 120 }, { position: 2, grams: 0 }, { position: 3, grams: 330 }])).toBe(true);
    const v = await repo.getMeal(U, id);
    expect(v?.items.map((i) => [i.position, i.grams])).toEqual([[1, 120], [3, 330]]);
    expect(v?.awaitGramsAt).toBeNull();
  });

  it("updateMealGrams: усе вилучити, грами поза 0–2000, невідома чи повторена позиція, не pending — false без змін", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const id = await pending(U, [{ foodId: a, grams: 100, confidence: "high" }, { foodId: a, grams: 200, confidence: "high" }]);
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 0 }, { position: 2, grams: 0 }])).toBe(false);
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 2001 }])).toBe(false);
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: -1 }])).toBe(false);
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 1.5 }])).toBe(false);
    expect(await repo.updateMealGrams(U, id, [{ position: 7, grams: 10 }])).toBe(false);
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 10 }, { position: 1, grams: 20 }])).toBe(false);
    expect((await repo.getMeal(U, id))?.items.map((i) => i.grams)).toEqual([100, 200]);
    await repo.confirmMeal(U, id, NOW);
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 10 }])).toBe(false);
    expect((await repo.getMeal(U, id))?.items.map((i) => i.grams)).toEqual([100, 200]);
  });

  it("updateMealGrams: вилучена позиція з осиротілою ai_estimate чистить каталог; продукт сиду лишається", async () => {
    const seedF = await seedFood("рис", 130, 27, 3, 282);
    const est = (await repo.insertEstimatedFood({ nameUk: "Дивна страва", kcal100: 200, protein100Dg: 100, fat100Dg: 100, carbs100Dg: 200 }, NOW))!;
    const id = await pending(U, [{ foodId: seedF, grams: 100, confidence: "high" }, { foodId: est.id, grams: 100, confidence: "low" }]);
    expect(await repo.updateMealGrams(U, id, [{ position: 2, grams: 0 }])).toBe(true);
    expect(await repo.findFoodByAlias("дивна страва")).toBeNull();
    expect(await repo.findFoodByAlias("рис")).not.toBeNull();
  });

  it("awaitingGramsMeal: лише власний pending, не старший за TTL; найсвіжіший", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const old = await pending(U, [{ foodId: a, grams: 10, confidence: "high" }]);
    const fresh = await pending(U, [{ foodId: a, grams: 20, confidence: "high" }]);
    await env.DB.prepare("UPDATE meals SET await_grams_at = ? WHERE id = ?").bind(NOW - 20 * 60_000, old).run();
    expect(await repo.awaitingGramsMeal(U, NOW, 15 * 60_000)).toBeNull(); // 20 хв > TTL 15 хв
    await env.DB.prepare("UPDATE meals SET await_grams_at = ? WHERE id = ?").bind(NOW - 60_000, fresh).run();
    expect((await repo.awaitingGramsMeal(U, NOW, 15 * 60_000))?.id).toBe(fresh);
    await repo.confirmMeal(U, fresh, NOW); // підтвердження знімає очікування й не лишає confirmed у вибірці
    expect(await repo.awaitingGramsMeal(U, NOW, 15 * 60_000)).toBeNull();
  });

  it("cancelMeal: pending → cancelled, позиції й осиротіла ai_estimate зникають; сид і продукт, що є в іншому прийомі, лишаються; повтор — false", async () => {
    const seedF = await seedFood("рис", 130, 27, 3, 282);
    const lonely = (await repo.insertEstimatedFood({ nameUk: "Лише тут", kcal100: 100, protein100Dg: 10, fat100Dg: 10, carbs100Dg: 10 }, NOW))!;
    const shared = (await repo.insertEstimatedFood({ nameUk: "Спільний", kcal100: 100, protein100Dg: 10, fat100Dg: 10, carbs100Dg: 10 }, NOW))!;
    const m1 = await pending(U, [{ foodId: seedF, grams: 100, confidence: "high" }, { foodId: lonely.id, grams: 100, confidence: "low" }, { foodId: shared.id, grams: 50, confidence: "low" }]);
    const m2 = await pending(U, [{ foodId: shared.id, grams: 70, confidence: "low" }]);

    expect(await repo.cancelMeal(U, m1)).toBe(true);
    const v = await repo.getMeal(U, m1);
    expect(v?.status).toBe("cancelled");
    expect(v?.items).toEqual([]);
    expect(await repo.findFoodByAlias("лише тут")).toBeNull();
    expect(await repo.findFoodByAlias("спільний")).not.toBeNull();
    expect(await repo.findFoodByAlias("рис")).not.toBeNull();
    expect(await repo.cancelMeal(U, m1)).toBe(false); // повторне — без помилки
    expect((await repo.getMeal(U, m2))?.items).toHaveLength(1);
  });

  it("cancelMeal підтвердженого: cancelled, знімок і позиції лишаються, у dayTotals немає, ai_estimate лишається в каталозі", async () => {
    const est = (await repo.insertEstimatedFood({ nameUk: "Лишається", kcal100: 100, protein100Dg: 10, fat100Dg: 10, carbs100Dg: 10 }, NOW))!;
    const m = await pending(U, [{ foodId: est.id, grams: 100, confidence: "low" }]);
    await repo.confirmMeal(U, m, NOW);
    expect((await repo.dayTotals(U, DAY)).kcal).toBe(100);
    expect(await repo.cancelMeal(U, m)).toBe(true);
    const v = await repo.getMeal(U, m);
    expect(v?.status).toBe("cancelled");
    expect(v?.items[0]?.snapshot?.kcal).toBe(100);
    expect((await repo.dayTotals(U, DAY)).kcal).toBe(0);
    expect(await repo.findFoodByAlias("лишається")).not.toBeNull();
  });

  it("expirePendingMeals: pending старші за cutoff → cancelled з чисткою; свіжі й підтверджені не чіпає; осиротіла стара оцінка прибирається", async () => {
    const seedF = await seedFood("рис", 130, 27, 3, 282);
    const est = (await repo.insertEstimatedFood({ nameUk: "Прострочена", kcal100: 100, protein100Dg: 10, fat100Dg: 10, carbs100Dg: 10 }, 1_000))!;
    const stale = await pending(U, [{ foodId: seedF, grams: 100, confidence: "high" }, { foodId: est.id, grams: 100, confidence: "low" }], DAY, 2_000);
    const fresh = await pending(U, [{ foodId: seedF, grams: 100, confidence: "high" }], DAY, 90_000);
    const done = await pending(U, [{ foodId: seedF, grams: 100, confidence: "high" }], DAY, 1_500);
    await repo.confirmMeal(U, done, 3_000);
    await repo.insertEstimatedFood({ nameUk: "Сирота", kcal100: 1, protein100Dg: 0, fat100Dg: 0, carbs100Dg: 0 }, 500); // збій між продуктом і прийомом

    expect(await repo.expirePendingMeals(50_000)).toBe(1);
    expect((await repo.getMeal(U, stale))?.status).toBe("cancelled");
    expect((await repo.getMeal(U, fresh))?.status).toBe("pending");
    expect((await repo.getMeal(U, done))?.status).toBe("confirmed");
    expect(await repo.findFoodByAlias("прострочена")).toBeNull();
    expect(await repo.findFoodByAlias("сирота")).toBeNull();
    expect(await repo.findFoodByAlias("рис")).not.toBeNull();
    expect(await repo.expirePendingMeals(50_000)).toBe(0); // повтор нічого не міняє
  });
});

describe("облік витрат на ШІ (P3.1.4)", () => {
  const reservation = (localDate: string, est = 15_000, limit = 30_000) => ({ model: "claude-sonnet-5-5", purpose: "food_photo", localDate, estMicro: est, limitMicro: limit });

  it("aiSpendToday рахує за локальну дату, а не за добою UTC: 00:30 Києва — це вже наступний день", async () => {
    const t = Date.UTC(2026, 10, 20, 22, 30); // 22:30 UTC = 00:30 21 листопада за Києвом
    const local = localDate(t, "Europe/Kyiv");
    expect(local).toBe("2026-11-21");
    expect(new Date(t).toISOString().slice(0, 10)).toBe("2026-11-20"); // UTC-доба інша
    const id = await repo.reserveAiUsage(U, reservation(local), t);
    expect(id).not.toBeNull();
    expect(await repo.aiSpendToday(U, "2026-11-21")).toBe(15_000);
    expect(await repo.aiSpendToday(U, "2026-11-20")).toBe(0);
    expect(await repo.aiSpendToday(OTHER, "2026-11-21")).toBe(0);
  });

  it("10 паралельних reserveAiUsage при залишку на 2 → успішні рівно 2, решта null", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => repo.reserveAiUsage(U, reservation(DAY, 15_000, 30_000), NOW)));
    expect(results.filter((r) => r !== null)).toHaveLength(2);
    expect(results.filter((r) => r === null)).toHaveLength(8);
    expect(await count("ai_usage")).toBe(2);
    expect(await repo.aiSpendToday(U, DAY)).toBe(30_000);
  });

  it("ліміт тримається по користувачах і по днях окремо; невідомий користувач → null без помилки FK", async () => {
    expect(await repo.reserveAiUsage(U, reservation(DAY, 30_000, 30_000), NOW)).not.toBeNull();
    expect(await repo.reserveAiUsage(U, reservation(DAY, 1, 30_000), NOW)).toBeNull(); // день повний
    expect(await repo.reserveAiUsage(OTHER, reservation(DAY, 30_000, 30_000), NOW)).not.toBeNull(); // інший користувач
    expect(await repo.reserveAiUsage(U, reservation("2026-11-21", 30_000, 30_000), NOW)).not.toBeNull(); // інший день
    expect(await repo.reserveAiUsage(999, reservation(DAY), NOW)).toBeNull();
  });

  it("settleAiUsage замінює оцінку фактом; releaseAiUsage повертає ліміт; факт оплати не вилучається", async () => {
    const a = (await repo.reserveAiUsage(U, reservation(DAY), NOW))!;
    const b = (await repo.reserveAiUsage(U, reservation(DAY), NOW))!;
    expect(await repo.reserveAiUsage(U, reservation(DAY), NOW)).toBeNull(); // ліміт на 2 вичерпано

    expect(await repo.settleAiUsage(U, a, { inputTokens: 3200, outputTokens: 480, costMicro: 9_000 })).toBe(true);
    expect(await repo.aiSpendToday(U, DAY)).toBe(9_000 + 15_000); // a — факт, b — ще оцінка
    const row = await env.DB.prepare("SELECT input_tokens AS i, output_tokens AS o, cost_micro AS c FROM ai_usage WHERE id = ?").bind(a).first();
    expect(row).toEqual({ i: 3200, o: 480, c: 9_000 });

    expect(await repo.releaseAiUsage(U, b)).toBe(true); // HTTP-помилка до відправки
    expect(await repo.aiSpendToday(U, DAY)).toBe(9_000);
    expect(await repo.reserveAiUsage(U, reservation(DAY), NOW)).not.toBeNull(); // ліміт повернувся
    expect(await repo.releaseAiUsage(U, a)).toBe(false); // розрахований рядок — факт, не вилучається
    expect(await repo.aiSpendToday(U, DAY)).toBe(9_000 + 15_000);
  });

  it("settle/release чужого рядка — false без змін", async () => {
    const a = (await repo.reserveAiUsage(U, reservation(DAY), NOW))!;
    expect(await repo.settleAiUsage(OTHER, a, { inputTokens: 1, outputTokens: 1, costMicro: 1 })).toBe(false);
    expect(await repo.releaseAiUsage(OTHER, a)).toBe(false);
    expect(await repo.aiSpendToday(U, DAY)).toBe(15_000);
    expect(await repo.settleAiUsage(U, 999_999, { inputTokens: 1, outputTokens: 1, costMicro: 1 })).toBe(false);
  });

  it("purpose без закритого CHECK (chat), але 1–32 символи; від'ємна ціна й токени відхиляються", async () => {
    expect(await repo.reserveAiUsage(U, { ...reservation(DAY), purpose: "chat" }, NOW)).not.toBeNull();
    await expect(repo.reserveAiUsage(U, { ...reservation(DAY), purpose: "" }, NOW)).rejects.toThrow();
    await expect(repo.reserveAiUsage(U, { ...reservation(DAY), purpose: "x".repeat(33) }, NOW)).rejects.toThrow();
    await expect(repo.reserveAiUsage(U, { ...reservation(DAY), estMicro: -1 }, NOW)).rejects.toThrow();
  });
});

describe("норма (nutrition_targets)", () => {
  const t = (validFrom: string, kcal: number, reason: "formula" | "trend" = "formula", sourceDate: string | null = null) => ({ validFrom, kcal, proteinG: 150, fatG: 70, carbsG: 250, reason, sourceDate });

  it("getTargetOn: рядок з максимальним valid_from ≤ дати; до першої норми — null", async () => {
    await repo.insertTarget(U, t("2026-11-01", 2500), NOW);
    await repo.insertTarget(U, t("2026-11-15", 2400, "trend", "2026-11-14"), NOW);
    expect(await repo.getTargetOn(U, "2026-10-31")).toBeNull();
    expect((await repo.getTargetOn(U, "2026-11-14"))?.kcal).toBe(2500);
    expect((await repo.getTargetOn(U, "2026-11-15"))?.kcal).toBe(2400);
    expect((await repo.getTargetOn(U, "2026-12-31"))?.reason).toBe("trend");
    expect(await repo.getTargetOn(OTHER, "2026-12-31")).toBeNull();
  });

  it("insertTarget ідемпотентний: той самий valid_from і той самий source_date — false, перший рядок лишається", async () => {
    expect(await repo.insertTarget(U, t("2026-11-01", 2500), NOW)).toBe(true);
    expect(await repo.insertTarget(U, t("2026-11-01", 2000), NOW)).toBe(false);
    expect(await repo.insertTarget(U, t("2026-11-15", 2400, "trend", "2026-11-14"), NOW)).toBe(true);
    expect(await repo.insertTarget(U, t("2026-11-16", 2300, "trend", "2026-11-14"), NOW)).toBe(false); // та сама пропозиція
    expect(await repo.insertTarget(OTHER, t("2026-11-16", 2300, "trend", "2026-11-14"), NOW)).toBe(true); // у іншого користувача — окремо
    expect(await repo.insertTarget(999, t("2026-11-01", 2500), NOW)).toBe(false);
    expect(await count("nutrition_targets")).toBe(3);
    expect((await repo.getTargetOn(U, "2026-11-30"))?.kcal).toBe(2400);
  });

  it("CHECK: kcal 800–6000", async () => {
    await expect(repo.insertTarget(U, t("2026-11-01", 700), NOW)).rejects.toThrow();
    await expect(repo.insertTarget(U, t("2026-11-01", 6001), NOW)).rejects.toThrow();
  });
});

describe("виправлення за рев'ю 3.1", () => {
  it("В1: два паралельні updateMealGrams, що разом вилучили б усі позиції, — лишається одна, рівно один true; confirm порожнього відмовляє", async () => {
    const a = await seedFood("а", 100, 10, 10, 10);
    const id = await pending(U, [{ foodId: a, grams: 100, confidence: "high" }, { foodId: a, grams: 200, confidence: "high" }]);
    const r = await Promise.all([repo.updateMealGrams(U, id, [{ position: 1, grams: 0 }]), repo.updateMealGrams(U, id, [{ position: 2, grams: 0 }])]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect((await repo.getMeal(U, id))?.items).toHaveLength(1);
    expect(await repo.confirmMeal(U, id, NOW)).toBe(true);

    // Пояс: порожній pending (позиції зникли будь-яким шляхом) не підтверджується.
    const empty = await pending(U, [{ foodId: a, grams: 100, confidence: "high" }]);
    await env.DB.prepare("DELETE FROM meal_items WHERE meal_id = ?").bind(empty).run();
    expect(await repo.confirmMeal(U, empty, NOW)).toBe(false);
    expect((await repo.getMeal(U, empty))?.status).toBe("pending");
  });

  it("В1: вилучення двох із трьох позицій одним викликом — працює, лишається одна", async () => {
    const a = await seedFood("а", 100, 10, 10, 10);
    const id = await pending(U, [1, 2, 3].map(() => ({ foodId: a, grams: 100, confidence: "high" as const })));
    expect(await repo.updateMealGrams(U, id, [{ position: 1, grams: 0 }, { position: 3, grams: 0 }])).toBe(true);
    expect((await repo.getMeal(U, id))?.items.map((i) => i.position)).toEqual([2]);
  });

  it("В2: settle без вхідних токенів відхиляється, повторний settle не перезаписує, release розрахованого — false", async () => {
    const res = { model: "claude-sonnet-5-5", purpose: "food_photo", localDate: DAY, estMicro: 15_000, limitMicro: 300_000 };
    const id = (await repo.reserveAiUsage(U, res, NOW))!;
    expect(await repo.settleAiUsage(U, id, { inputTokens: 0, outputTokens: 0, costMicro: 9_000 })).toBe(false);
    expect(await repo.aiSpendToday(U, DAY)).toBe(15_000); // усе ще резервування
    expect(await repo.settleAiUsage(U, id, { inputTokens: 3000, outputTokens: 400, costMicro: 9_000 })).toBe(true);
    expect(await repo.settleAiUsage(U, id, { inputTokens: 1, outputTokens: 1, costMicro: 1 })).toBe(false);
    expect(await repo.aiSpendToday(U, DAY)).toBe(9_000);
    expect(await repo.releaseAiUsage(U, id)).toBe(false);
    expect(await repo.aiSpendToday(U, DAY)).toBe(9_000);
  });

  it("В3: awaitingGramsMeal не бачить очікування іншого користувача, навіть свіжішого", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const mine = await pending(U, [{ foodId: a, grams: 10, confidence: "high" }]);
    const theirs = await pending(OTHER, [{ foodId: a, grams: 10, confidence: "high" }]);
    await env.DB.prepare("UPDATE meals SET await_grams_at = ? WHERE id = ?").bind(NOW - 120_000, mine).run();
    await env.DB.prepare("UPDATE meals SET await_grams_at = ? WHERE id = ?").bind(NOW - 1_000, theirs).run();
    expect((await repo.awaitingGramsMeal(U, NOW, 900_000))?.id).toBe(mine);
    expect((await repo.awaitingGramsMeal(OTHER, NOW, 900_000))?.id).toBe(theirs);
  });

  it("В4: свіжа осиротіла ai_estimate (між insertEstimatedFood і createPendingMeal) переживає expirePendingMeals", async () => {
    const fresh = (await repo.insertEstimatedFood({ nameUk: "Свіжа оцінка", kcal100: 100, protein100Dg: 10, fat100Dg: 10, carbs100Dg: 10 }, 60_000))!;
    await repo.expirePendingMeals(50_000); // cutoff старший за створення продукту
    expect(await repo.findFoodByAlias("свіжа оцінка")).not.toBeNull();
    expect(await repo.createPendingMeal(U, meal([{ foodId: fresh.id, grams: 100, confidence: "low" }]), 60_000)).not.toBeNull();
  });

  it("Д1: createPendingMeal — null без запису для грамів 0/2001/1,5, caption 301, ai_raw_json 8193, дати не за форматом", async () => {
    const a = await seedFood("а", 100, 0, 0, 0);
    const ok = [{ foodId: a, grams: 10, confidence: "low" as const }];
    const bad: NewMeal[] = [
      meal([{ foodId: a, grams: 0, confidence: "low" }]),
      meal([{ foodId: a, grams: 2001, confidence: "low" }]),
      meal([{ foodId: a, grams: 1.5, confidence: "low" }]),
      { ...meal(ok), caption: "я".repeat(301) },
      { ...meal(ok), aiRawJson: "x".repeat(8193) },
      meal(ok, "20.11.2026"),
    ];
    for (const m of bad) expect(await repo.createPendingMeal(U, m, NOW)).toBeNull();
    expect(await count("meals")).toBe(0);
    expect(await repo.createPendingMeal(U, { ...meal(ok), caption: "я".repeat(300) }, NOW)).not.toBeNull();
  });

  it("Д5: методи працюють після деструктурування repo (без this)", async () => {
    const { insertEstimatedFood, findFoodByAlias, createPendingMeal, getMeal, updateMealGrams, cancelMeal, awaitingGramsMeal } = repo;
    const f = (await insertEstimatedFood({ nameUk: "Окрема", kcal100: 100, protein100Dg: 10, fat100Dg: 10, carbs100Dg: 10 }, NOW))!;
    expect((await insertEstimatedFood({ nameUk: "окрема", kcal100: 1, protein100Dg: 0, fat100Dg: 0, carbs100Dg: 0 }, NOW))?.id).toBe(f.id);
    expect(await findFoodByAlias("Окрема")).not.toBeNull();
    const id = (await createPendingMeal(U, meal([{ foodId: f.id, grams: 10, confidence: "low" }, { foodId: f.id, grams: 20, confidence: "low" }]), NOW))!;
    expect(await updateMealGrams(U, id, [{ position: 1, grams: 30 }])).toBe(true);
    expect((await getMeal(U, id))?.items[0]?.grams).toBe(30);
    expect(await awaitingGramsMeal(U, NOW, 1000)).toBeNull();
    expect(await cancelMeal(U, id)).toBe(true);
  });
});

/** D1, що рахує SELECT-запити (drizzle і сирий prepare йдуть через `prepare`). */
function countingDb(): { db: D1Database; selects: () => number } {
  let n = 0;
  const db = new Proxy(env.DB, {
    get(t, prop) {
      if (prop === "prepare") {
        return (q: string) => {
          if (/^\s*select/i.test(q)) n++;
          return t.prepare(q);
        };
      }
      const v = Reflect.get(t, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db, selects: () => n };
}

describe("борг [3.1] Д4: cancelMeal і updateMealGrams читають один раз, не getMeal (два запити)", () => {
  it("cancelMeal pending: рівно 1 SELECT; чистка осиротілої оцінки й результат ті самі", async () => {
    const rice = await seedFood("рис", 130, 27, 3, 280);
    const est = (await repo.insertEstimatedFood({ nameUk: "кефір", kcal100: 40, protein100Dg: 30, fat100Dg: 10, carbs100Dg: 40 }, NOW))!.id;
    const id = await pending(U, [{ foodId: rice, grams: 100, confidence: "high" }, { foodId: est, grams: 200, confidence: "low" }]);
    const c = countingDb();
    const r = createRepo(createDb(c.db));
    expect(await r.cancelMeal(U, id)).toBe(true);
    expect(c.selects()).toBe(1);
    expect(await count("meal_items")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM foods WHERE id = ?").bind(est).first("n")).toBe(0);
    expect(await r.cancelMeal(U, id)).toBe(false); // повтор
    expect(await r.cancelMeal(OTHER, id)).toBe(false);
    expect(await r.cancelMeal(U, 99999)).toBe(false);
  });

  it("cancelMeal confirmed: знімок лишається; чужий — false і прийом цілий", async () => {
    const rice = await seedFood("рис", 130, 27, 3, 280);
    const id = await pending(U, [{ foodId: rice, grams: 100, confidence: "high" }]);
    await repo.confirmMeal(U, id, NOW);
    expect(await createRepo(createDb(env.DB)).cancelMeal(OTHER, id)).toBe(false);
    expect((await repo.getMeal(U, id))!.status).toBe("confirmed");
    expect(await repo.cancelMeal(U, id)).toBe(true);
    expect((await repo.getMeal(U, id))!.items).toHaveLength(1);
  });

  it("updateMealGrams: рівно 1 SELECT до batch; відмови без запису, успіх — як раніше", async () => {
    const rice = await seedFood("рис", 130, 27, 3, 280);
    const chicken = await seedFood("курка", 165, 310, 36, 0);
    const id = await pending(U, [{ foodId: rice, grams: 100, confidence: "high" }, { foodId: chicken, grams: 150, confidence: "high" }]);
    const c = countingDb();
    const r = createRepo(createDb(c.db));
    expect(await r.updateMealGrams(U, id, [{ position: 1, grams: 120 }, { position: 2, grams: 0 }])).toBe(true);
    expect(c.selects()).toBe(1);
    const left = (await r.getMeal(U, id))!.items;
    expect(left.map((i) => [i.position, i.grams])).toEqual([[1, 120]]);
    // не свій / неіснуючий / не pending / усі вилучити — false
    expect(await r.updateMealGrams(OTHER, id, [{ position: 1, grams: 5 }])).toBe(false);
    expect(await r.updateMealGrams(U, 99999, [{ position: 1, grams: 5 }])).toBe(false);
    expect(await r.updateMealGrams(U, id, [{ position: 1, grams: 0 }])).toBe(false);
    await repo.cancelMeal(U, id);
    expect(await r.updateMealGrams(U, id, [{ position: 1, grams: 5 }])).toBe(false);
  });
});
