import { beforeEach, describe, expect, it } from "vitest";
import foodsMap from "../scripts/foods-map.json";
import seedJson from "../scripts/foods-seed.json";
import { buildFoodsSeed, foodsSeedStatements, parseCsv, SOURCE_NOTE, type FoodsSeed, type MapEntry } from "../scripts/foods-seed-core";
import { normalizeAlias } from "../src/domain/text";
import { count, env, resetDb } from "./helpers";

const seed = seedJson as FoodsSeed;
const map = foodsMap as MapEntry[];

async function applySeed(now = 1_000): Promise<void> {
  await env.DB.batch(foodsSeedStatements(seed, now).map((s) => env.DB.prepare(s)));
}

beforeEach(resetDb);

describe("сид продуктів: дані (P3.1.6, спека §2)", () => {
  it("≈ 100 продуктів, source_note з атрибуцією FDC і датою вибірки", () => {
    expect(seed.foods.length).toBeGreaterThanOrEqual(90);
    expect(seed.foods.length).toBeLessThanOrEqual(120);
    expect(seed.source_note).toBe(SOURCE_NOTE);
    expect(seed.source_note).toContain("FoodData Central");
    expect(seed.source_note).toContain("CC0");
    expect(seed.sampled_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("«якорі» ккал/100 г", () => {
    const anchors: [string, number, number][] = [
      ["Рис білий варений", 110, 140],
      ["Куряче філе варене", 140, 180],
      ["Олія оливкова", 880, 900],
      ["Яйце варене", 140, 160],
      ["Гречка варена", 90, 120],
      ["Банан", 80, 100],
    ];
    for (const [name, lo, hi] of anchors) {
      const f = seed.foods.find((x) => x.name_uk === name);
      expect(f, name).toBeDefined();
      expect(f!.kcal_100, name).toBeGreaterThanOrEqual(lo);
      expect(f!.kcal_100, name).toBeLessThanOrEqual(hi);
    }
  });

  it("Атуотер: |ккал − (4Б + 4В + 9Ж)| ≤ max(20, 0,15·ккал) для кожного продукту", () => {
    const bad = seed.foods.filter((f) => {
      const atwater = 4 * (f.protein_100_dg / 10) + 4 * (f.carbs_100_dg / 10) + 9 * (f.fat_100_dg / 10);
      return Math.abs(f.kcal_100 - atwater) > Math.max(20, 0.15 * f.kcal_100);
    });
    expect(bad.map((f) => f.name_uk)).toEqual([]);
  });

  it("межі схеми: ккал ≤ 900, Б+Ж+В ≤ 100 г, назва 1–60", () => {
    for (const f of seed.foods) {
      expect(f.kcal_100, f.name_uk).toBeLessThanOrEqual(900);
      expect(f.protein_100_dg + f.fat_100_dg + f.carbs_100_dg, f.name_uk).toBeLessThanOrEqual(1000);
      expect([...f.name_uk].length, f.name_uk).toBeLessThanOrEqual(60);
    }
  });

  it("кожен продукт має аліас normalizeAlias(name_uk); усі аліаси нормалізовані й унікальні в усьому сиді", () => {
    const all: string[] = [];
    for (const f of seed.foods) {
      expect(f.aliases, f.name_uk).toContain(normalizeAlias(f.name_uk));
      for (const a of f.aliases) expect(normalizeAlias(a), a).toBe(a);
      all.push(...f.aliases);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it("мапа й сид узгоджені: ті самі продукти, fdc_ref унікальні, опис непорожній", () => {
    expect(seed.foods.map((f) => [f.name_uk, f.fdc_ref])).toEqual(map.map((e) => [e.name_uk, e.fdc_ref]));
    expect(new Set(map.map((e) => e.fdc_ref)).size).toBe(map.length);
    for (const e of map) expect(e.fdc_desc.length, e.name_uk).toBeGreaterThan(3);
  });
});

describe("сид у D1 (P3.1.6)", () => {
  it("застосовується: foods = seed, аліаси знаходяться; повтор — 0 змін", async () => {
    await applySeed();
    const total = seed.foods.length;
    expect(await count("foods")).toBe(total);
    const aliases = seed.foods.reduce((n, f) => n + f.aliases.length, 0);
    expect(await count("food_aliases")).toBe(aliases);

    const rice = await env.DB.prepare("SELECT f.name_uk AS n, f.kcal_100 AS k, f.source AS s, f.fdc_ref AS r FROM food_aliases a JOIN foods f ON f.id = a.food_id WHERE a.alias = ?")
      .bind("рис")
      .first<{ n: string; k: number; s: string; r: string }>();
    expect(rice).toEqual({ n: "Рис білий варений", k: 130, s: "seed", r: "168878" });

    const before = await env.DB.prepare("SELECT * FROM foods ORDER BY id").all();
    await applySeed(9_999_999); // інший `now`: created_at наявних не змінюється
    expect(await count("foods")).toBe(total);
    expect(await count("food_aliases")).toBe(aliases);
    expect((await env.DB.prepare("SELECT * FROM foods ORDER BY id").all()).results).toEqual(before.results);
  });

  it("змінені значення в сиді оновлюють продукт на місці (id той самий), не дублюють", async () => {
    await applySeed();
    const id = (await env.DB.prepare("SELECT id FROM foods WHERE fdc_ref = '168878'").first<{ id: number }>())!.id;
    const changed: FoodsSeed = { ...seed, foods: seed.foods.map((f) => (f.fdc_ref === "168878" ? { ...f, kcal_100: 131 } : f)) };
    await env.DB.batch(foodsSeedStatements(changed, 2_000).map((s) => env.DB.prepare(s)));
    const row = await env.DB.prepare("SELECT id, kcal_100 FROM foods WHERE fdc_ref = '168878'").first<{ id: number; kcal_100: number }>();
    expect(row).toEqual({ id, kcal_100: 131 });
    expect(await count("foods")).toBe(seed.foods.length);
  });

  it("апостроф у назві не ламає SQL (кешʼю, кеш'ю)", async () => {
    const tricky: FoodsSeed = {
      ...seed,
      foods: [{ name_uk: "Д'Артаньян", aliases: ["д'артаньян сир"], fdc_ref: "1", kcal_100: 100, protein_100_dg: 100, fat_100_dg: 50, carbs_100_dg: 100 }],
    };
    await env.DB.batch(foodsSeedStatements(tricky, 1).map((s) => env.DB.prepare(s)));
    const row = await env.DB.prepare("SELECT name_uk FROM foods").first<{ name_uk: string }>();
    expect(row?.name_uk).toBe("Д'Артаньян");
  });
});

// Мінімальні CSV у форматі FDC (food.csv, food_nutrient.csv).
const FOOD_CSV = [
  '"fdc_id","data_type","description","food_category_id","publication_date"',
  '"100","sr_legacy_food","Rice, white, long-grain, regular, enriched, cooked","20","2019-04-01"',
  '"101","sr_legacy_food","Rice, white, long-grain, regular, enriched, raw","20","2019-04-01"',
  '"102","sr_legacy_food","Oil, olive, ""salad"" or cooking","4","2019-04-01"',
].join("\n");
const NUT_CSV = [
  '"id","fdc_id","nutrient_id","amount","data_points"',
  '"1","100","1008","130","1"',
  '"2","100","1003","2.69","1"',
  '"3","100","1004","0.28","1"',
  '"4","100","1005","28.17","1"',
  '"5","101","1008","365","1"',
  '"6","102","1008","884","1"',
  '"7","102","1003","0","1"',
  '"8","102","1004","100","1"',
  '"9","102","1005","0","1"',
].join("\n");
const RICE: MapEntry = { name_uk: "Рис варений", aliases: ["рис"], fdc_ref: "100", fdc_desc: "Rice, white, long-grain, regular, enriched, cooked" };
const OIL: MapEntry = { name_uk: "Олія оливкова", aliases: [], fdc_ref: "102", fdc_desc: 'Oil, olive, "salad" or cooking' };

describe("build-foods-seed: захисти (P3.1.6)", () => {
  it("збирає значення: ккал цілі, макроси в десятих грама; таблиця name_uk → fdc_desc → ккал", () => {
    const { seed: s, table } = buildFoodsSeed([RICE, OIL], FOOD_CSV, NUT_CSV, "2026-11-20");
    expect(s.foods[0]).toEqual({ name_uk: "Рис варений", aliases: ["рис варений", "рис"], fdc_ref: "100", kcal_100: 130, protein_100_dg: 27, fat_100_dg: 3, carbs_100_dg: 282 });
    expect(s.sampled_at).toBe("2026-11-20");
    expect(table.split("\n")[0]).toBe("Рис варений → Rice, white, long-grain, regular, enriched, cooked → 130 ккал");
  });

  it("лапки й подвоєні лапки у CSV читаються (опис з лапками збігається)", () => {
    expect(parseCsv(FOOD_CSV)[3]![2]).toBe('Oil, olive, "salad" or cooking');
    expect(() => buildFoodsSeed([OIL], FOOD_CSV, NUT_CSV, "2026-11-20")).not.toThrow();
  });

  it("опис у CSV ≠ fdc_desc (сирий замість вареного) → падає з обома описами", () => {
    const wrong: MapEntry = { ...RICE, fdc_ref: "101" };
    expect(() => buildFoodsSeed([wrong], FOOD_CSV, NUT_CSV, "2026-11-20")).toThrow(/опис у CSV «Rice, white, long-grain, regular, enriched, raw» ≠ fdc_desc/);
  });

  it("дубль нормалізованого аліаса між продуктами → падає", () => {
    const a: MapEntry = { ...RICE, aliases: ["М’ЯСО"] };
    const b: MapEntry = { ...OIL, aliases: ["мясо"] };
    expect(() => buildFoodsSeed([a, b], FOOD_CSV, NUT_CSV, "2026-11-20")).toThrow(/аліас «мясо» збігається/);
  });

  it("аліас, що збігається з назвою іншого продукту, → падає; свій власний повтор — ні", () => {
    expect(() => buildFoodsSeed([RICE, { ...OIL, aliases: ["Рис варений"] }], FOOD_CSV, NUT_CSV, "d")).toThrow(/збігається/);
    expect(() => buildFoodsSeed([{ ...RICE, aliases: ["рис варений", "Рис  варений"] }], FOOD_CSV, NUT_CSV, "d")).not.toThrow();
  });

  it("порожній аліас, невідомий fdc_ref, немає нутрієнтів, дубль fdc_ref → падає", () => {
    expect(() => buildFoodsSeed([{ ...RICE, aliases: ["()"] }], FOOD_CSV, NUT_CSV, "d")).toThrow(/порожній після нормалізації/);
    expect(() => buildFoodsSeed([{ ...RICE, fdc_ref: "999" }], FOOD_CSV, NUT_CSV, "d")).toThrow(/немає в food.csv/);
    expect(() => buildFoodsSeed([RICE], FOOD_CSV, NUT_CSV.split("\n").filter((l) => !l.startsWith('"2"')).join("\n"), "d")).toThrow(/немає значення «білок»/);
    expect(() => buildFoodsSeed([RICE, { ...OIL, fdc_ref: "100" }], FOOD_CSV, NUT_CSV, "d")).toThrow(/вже є в мапі/);
  });
});
