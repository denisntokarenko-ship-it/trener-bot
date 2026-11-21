// P3.3.3, P3.3.8, P3.3.14: чисті функції потоку фото — межі валідації, введення грамів, округлення, вартість.
import { describe, expect, it } from "vitest";
import { costMicro, estimateOf, itemNutrients, looksDryPortion, parseFoodResponse, parseGrams, type FoodResponse } from "../src/domain/meal";

const ok = (items: unknown[], extra: Partial<FoodResponse> = {}): FoodResponse => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ not_food: false, items }) }],
  ...extra,
});
const it0 = { name_uk: "рис варений", grams: 180, kcal_100: 130, protein_100: 2.7, fat_100: 0.3, carbs_100: 28, confidence: "high" };
const kind = (r: FoodResponse) => parseFoodResponse(r).kind;

describe("parseFoodResponse: межі інклюзивні", () => {
  it("валідна позиція: назва обрізана, грами — ціле", () => {
    expect(parseFoodResponse(ok([{ ...it0, name_uk: "  рис варений ", grams: 180.4 }]))).toEqual({
      kind: "ok",
      items: [{ nameUk: "рис варений", grams: 180, kcal100: 130, protein100: 2.7, fat100: 0.3, carbs100: 28, confidence: "high" }],
    });
  });

  it("kcal 900 проходить, 901 — ні", () => {
    expect(kind(ok([{ ...it0, kcal_100: 900, protein_100: 0, fat_100: 100, carbs_100: 0 }]))).toBe("ok");
    expect(kind(ok([{ ...it0, kcal_100: 901, protein_100: 0, fat_100: 100, carbs_100: 0 }]))).toBe("invalid");
  });

  it("грами 5 і 2000 проходять, 4,9 і 2000,1 — ні; NaN/рядок — ні", () => {
    for (const g of [5, 2000]) expect(kind(ok([{ ...it0, grams: g }]))).toBe("ok");
    for (const g of [4.9, 2000.1, "180", null]) expect(kind(ok([{ ...it0, grams: g }]))).toBe("invalid");
  });

  it("8 позицій проходять, 9 — ні; 0 позицій — NOT_FOOD", () => {
    expect(kind(ok(Array.from({ length: 8 }, () => it0)))).toBe("ok");
    expect(kind(ok(Array.from({ length: 9 }, () => it0)))).toBe("invalid");
    expect(kind(ok([]))).toBe("not_food");
  });

  it("not_food: true — NOT_FOOD навіть з позиціями", () => {
    expect(kind({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ not_food: true, items: [it0] }) }] })).toBe("not_food");
  });

  it("макроси 0–100 кожен, сума ≤ 100,5", () => {
    expect(kind(ok([{ ...it0, kcal_100: 402, protein_100: 0.5, fat_100: 0, carbs_100: 100 }]))).toBe("ok"); // 100,5
    expect(kind(ok([{ ...it0, kcal_100: 404, protein_100: 1, fat_100: 0, carbs_100: 100 }]))).toBe("invalid"); // 101
    expect(kind(ok([{ ...it0, protein_100: -1 }]))).toBe("invalid");
  });

  it("Атуотер: |kcal − (4Б+4В+9Ж)| ≤ max(30, 0,3·kcal) — межа включно", () => {
    // 4·2,7 + 4·28 + 9·0,3 = 125,5 → межа max(30, 0,3·k)
    expect(kind(ok([{ ...it0, kcal_100: 179 }]))).toBe("ok"); // різниця 53,5 ≤ 0,3·179 = 53,7
    expect(kind(ok([{ ...it0, kcal_100: 180 }]))).toBe("invalid"); // 54,5 > 54
    expect(kind(ok([{ ...it0, kcal_100: 95.5 }]))).toBe("ok"); // −30
    expect(kind(ok([{ ...it0, kcal_100: 95 }]))).toBe("invalid"); // −30,5
    expect(kind(ok([{ ...it0, kcal_100: 200 }]))).toBe("invalid"); // 74,5 > 60
  });

  it("назва: порожня після нормалізації, > 60 символів, не рядок — INVALID; confidence з переліку", () => {
    for (const n of ["  ", "()", "я".repeat(61), 5]) expect(kind(ok([{ ...it0, name_uk: n }]))).toBe("invalid");
    expect(kind(ok([{ ...it0, name_uk: "я".repeat(60) }]))).toBe("ok");
    expect(kind(ok([{ ...it0, confidence: "very" }]))).toBe("invalid");
  });

  it("одна погана позиція з кількох — INVALID усе", () => {
    expect(kind(ok([it0, { ...it0, grams: 4 }]))).toBe("invalid");
  });

  it("stop_reason не end_turn, не JSON, немає text-блоку, не та форма — INVALID", () => {
    expect(kind(ok([it0], { stop_reason: "max_tokens" }))).toBe("invalid");
    expect(kind(ok([it0], { stop_reason: "refusal" }))).toBe("invalid");
    expect(kind({ stop_reason: "end_turn", content: [{ type: "text", text: "рис" }] })).toBe("invalid");
    expect(kind({ stop_reason: "end_turn", content: [] })).toBe("invalid");
    expect(kind({ stop_reason: "end_turn", content: [{ type: "text", text: "[]" }] })).toBe("invalid");
    expect(kind({ stop_reason: "end_turn", content: [{ type: "text", text: '{"items": []}' }] })).toBe("invalid");
  });
});

describe("estimateOf", () => {
  it("× 10 з округленням; сума 100,5 г → ≤ 1000 дг (надлишок знято з найбільшого)", () => {
    expect(estimateOf({ nameUk: "x", grams: 1, kcal100: 52.4, protein100: 2, fat100: 2.5, carbs100: 5.5, confidence: "low" })).toEqual({ kcal100: 52, protein100Dg: 20, fat100Dg: 25, carbs100Dg: 55 });
    const e = estimateOf({ nameUk: "x", grams: 1, kcal100: 402, protein100: 0.5, fat100: 0, carbs100: 100, confidence: "low" });
    expect(e.protein100Dg + e.fat100Dg + e.carbs100Dg).toBe(1000);
    expect(e).toMatchObject({ protein100Dg: 5, carbs100Dg: 995 });
  });
});

describe("itemNutrients і costMicro", () => {
  it("(g · x + 50) div 100 — половина вгору, ціле", () => {
    expect(itemNutrients(180, { kcal: 130, proteinDg: 27, fatDg: 3, carbsDg: 280 })).toEqual({ kcal: 234, proteinDg: 49, fatDg: 5, carbsDg: 504 });
    expect(itemNutrients(50, { kcal: 1, proteinDg: 3, fatDg: 0, carbsDg: 0 })).toEqual({ kcal: 1, proteinDg: 2, fatDg: 0, carbsDg: 0 }); // 0,5 → 1; 1,5 → 2
    expect(itemNutrients(49, { kcal: 1, proteinDg: 0, fatDg: 0, carbsDg: 0 }).kcal).toBe(0);
  });

  it("⌈(in · P_in + out · P_out) / 1e6⌉", () => {
    expect(costMicro(2500, 1000, 2_000_000, 10_000_000)).toBe(15_000);
    expect(costMicro(1, 0, 2_000_000, 10_000_000)).toBe(2);
    expect(costMicro(1, 1, 3, 3)).toBe(1); // 6 / 1e6 → вгору до 1
  });
});

describe("parseGrams", () => {
  it("розділювачі пробіл, кома, крапка з комою, новий рядок; суфікс г/g", () => {
    for (const t of ["200 150", "200,150", "200; 150", "200\n150", "200г 150g", " 200 ,150 "]) expect(parseGrams(t, 2)).toEqual({ ok: true, grams: [200, 150] });
  });

  it("0 — вилучити; межі 0 і 2000", () => {
    expect(parseGrams("150г 0", 2)).toEqual({ ok: true, grams: [150, 0] });
    expect(parseGrams("2000 0", 2)).toEqual({ ok: true, grams: [2000, 0] });
  });

  it("кількість не та → count з фактичною кількістю", () => {
    expect(parseGrams("200", 2)).toEqual({ ok: false, reason: "count", got: 1 });
    expect(parseGrams("", 1)).toEqual({ ok: false, reason: "count", got: 0 });
  });

  it("усі нулі → all_zero; abc, 2001, 12345, 1.5 → bad", () => {
    expect(parseGrams("0 0", 2)).toEqual({ ok: false, reason: "all_zero" });
    for (const t of ["abc", "2001 100", "12345 1", "1.5 2", "-5 3"]) expect(parseGrams(t, 2)).toEqual({ ok: false, reason: "bad" });
  });
});

describe("В5 рев'ю 3.3: «сухий/сирий» стан порції", () => {
  it("сухий/сирий у назві й порція ≥ 150 г → підозра; «сир» (продукт) і мала порція — ні", () => {
    expect(looksDryPortion("рис з овочами і трюфелем сухий", 200)).toBe(true);
    expect(looksDryPortion("Гречка суха", 150)).toBe(true);
    expect(looksDryPortion("морква сира", 200)).toBe(true);
    expect(looksDryPortion("гречка суха", 149)).toBe(false);
    expect(looksDryPortion("вівсяні пластівці сухі", 40)).toBe(false);
    expect(looksDryPortion("сир кисломолочний", 200)).toBe(false);
    expect(looksDryPortion("сирники", 200)).toBe(false);
    expect(looksDryPortion("рис варений", 200)).toBe(false);
  });

  it("parseFoodResponse знижує confidence до low для такої позиції", () => {
    const r = parseFoodResponse(ok([{ ...it0, name_uk: "рис сухий", grams: 200, kcal_100: 350, protein_100: 7, fat_100: 1, carbs_100: 77, confidence: "high" }]));
    expect(r).toMatchObject({ kind: "ok", items: [{ confidence: "low" }] });
    expect(parseFoodResponse(ok([it0]))).toMatchObject({ items: [{ confidence: "high" }] });
  });
});
