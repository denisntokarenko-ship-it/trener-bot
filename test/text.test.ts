import { describe, expect, it } from "vitest";
import { normalizeAlias } from "../src/domain/text";

describe("normalizeAlias (P3.1.3)", () => {
  it("апострофи й регістр: Мʼясо, м’ясо, М'ЯСО  → мясо", () => {
    for (const s of ["Мʼясо", "м’ясо", "М'ЯСО ", "м‘ясо", "м`ясо", "м´ясо", "м′ясо", "МЯСО"]) {
      expect(normalizeAlias(s), s).toBe("мясо");
    }
  });

  it("приклади спеки: розділові знаки й дефіс — пробіл, пробіли стиснуті", () => {
    expect(normalizeAlias("М’ЯСО  свиняче")).toBe("мясо свиняче");
    expect(normalizeAlias("Куряче філе (варене)")).toBe("куряче філе варене");
    expect(normalizeAlias("Йогурт-грецький")).toBe("йогурт грецький");
    expect(normalizeAlias("Молоко 3,25%")).toBe("молоко 3 25");
  });

  it("порожній результат — недійсний: null", () => {
    for (const s of ["", "  ", "()", " - ' ", "’’"]) expect(normalizeAlias(s), JSON.stringify(s)).toBeNull();
  });

  it("NFC: розкладене «й» (и + U+0306) дорівнює складеному", () => {
    expect(normalizeAlias("край")).toBe(normalizeAlias("край"));
    expect(normalizeAlias("край")).toBe("край");
  });

  it("ідемпотентна: нормалізований аліас нормалізується в себе", () => {
    for (const s of ["М’ЯСО  свиняче", "Куряче філе (варене)", "Молоко 3,25%", "Кешʼю сирий"]) {
      const once = normalizeAlias(s)!;
      expect(normalizeAlias(once)).toBe(once);
    }
  });
});
