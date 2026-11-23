import { describe, expect, it } from "vitest";
import { isWarmupExercise, warmupSets } from "../src/domain/warmup";

type Case = { name: string; working: number; step: number; min: number; expected: [number, number][] };

// [вага, повтори]. 50 % і 75 % — вниз до кроку, не нижче мінімуму; ≥ робочої або дубль попереднього — відпадає.
const CASES: Case[] = [
  { name: "штанга 40: рівно 20 і 30", working: 40, step: 5, min: 20, expected: [[20, 8], [30, 4]] },
  { name: "штанга 60: 30 і 45", working: 60, step: 5, min: 20, expected: [[30, 8], [45, 4]] },
  { name: "штанга 100: 50 і 75", working: 100, step: 5, min: 20, expected: [[50, 8], [75, 4]] },
  { name: "штанга 50: 37,5 → вниз до 35", working: 50, step: 5, min: 20, expected: [[25, 8], [35, 4]] },
  { name: "штанга 45: 22,5 → 20, 33,75 → 30", working: 45, step: 5, min: 20, expected: [[20, 8], [30, 4]] },
  { name: "крок 2,5, вага 50: 25 і 37,5 (без округлення вгору)", working: 50, step: 2.5, min: 20, expected: [[25, 8], [37.5, 4]] },
  { name: "крок 2,5, вага 62,5: 31,25 → 30, 46,875 → 45", working: 62.5, step: 2.5, min: 20, expected: [[30, 8], [45, 4]] },
  { name: "крок 2,5, вага 42,5: 21,25 → 20, 31,875 → 30", working: 42.5, step: 2.5, min: 20, expected: [[20, 8], [30, 4]] },
  { name: "гантелі крок 2, вага 22: 11 → 10, 16,5 → 16", working: 22, step: 2, min: 2, expected: [[10, 8], [16, 4]] },
  { name: "блок крок 5, вага 60, мінімум 5: 30 і 45", working: 60, step: 5, min: 5, expected: [[30, 8], [45, 4]] },
  { name: "мінімум піднімає 1-й підхід, 2-й дублює його → лишається один", working: 30, step: 5, min: 20, expected: [[20, 8]] },
  { name: "вага 25 при мінімумі 20: обидва → 20, лишається один", working: 25, step: 5, min: 20, expected: [[20, 8]] },
  { name: "гантелі 4 кг: 2 і 2 → один підхід 2", working: 4, step: 2, min: 2, expected: [[2, 8]] },
  { name: "блок 10 кг: 5 і 7,5 → 5 — один підхід", working: 10, step: 5, min: 5, expected: [[5, 8]] },
  { name: "вага = мінімум: підхід ≥ робочої відпадає — порожньо", working: 20, step: 5, min: 20, expected: [] },
  { name: "гантелі 2 кг (мінімум = вага): порожньо", working: 2, step: 2, min: 2, expected: [] },
  { name: "блок 5 кг при мінімумі 5: порожньо", working: 5, step: 5, min: 5, expected: [] },
  { name: "мінімум 0, вага = кроку: 0 кг не показуємо", working: 5, step: 5, min: 0, expected: [] },
  { name: "нульова вага — порожньо", working: 0, step: 5, min: 20, expected: [] },
  { name: "нульовий крок (власна вага) — порожньо", working: 40, step: 0, min: 0, expected: [] },
];

describe("warmupSets (spec: «Розминка»)", () => {
  it.each(CASES)("$name", ({ working, step, min, expected }) => {
    expect(warmupSets({ workingKg: working, stepKg: step, minKg: min }).map((s) => [s.weightKg, s.reps])).toEqual(expected);
  });

  it("інваріанти на сітці ваг: кратні кроку, ≥ мінімуму, < робочої, строго зростають, не більше двох, повтори 8 і 4", () => {
    for (const [step, min] of [[5, 20], [2.5, 20], [2, 2], [5, 5]] as const) {
      for (let w = step; w <= 200; w += step) {
        const sets = warmupSets({ workingKg: w, stepKg: step, minKg: min });
        expect(sets.length).toBeLessThanOrEqual(2);
        let prev = 0;
        for (const s of sets) {
          expect(Math.round(s.weightKg * 1000) % Math.round(step * 1000)).toBe(0);
          expect(s.weightKg).toBeGreaterThanOrEqual(min);
          expect(s.weightKg).toBeLessThan(w);
          expect(s.weightKg).toBeGreaterThan(prev);
          prev = s.weightKg;
        }
        if (sets.length === 2) expect(sets.map((s) => s.reps)).toEqual([8, 4]);
        if (sets.length === 1) expect(sets[0]!.reps).toBe(8);
      }
    }
  });
});

describe("isWarmupExercise: база з вагою за полями exercises", () => {
  const e = (equipment: string, pattern: string | null, kind: string | null) => ({ equipment, pattern, kind });
  it.each([
    ["barbell", "squat", "compound", true],
    ["barbell", "hinge", "compound", true],
    ["dumbbell", "hpush", "compound", true],
    ["barbell", "vpush", "compound", true],
    ["cable", "hpull", "compound", true],
    ["cable", "vpull", "compound", true],
    ["machine", "squat", "compound", true],
    ["bodyweight", "vpull", "compound", false], // підтягування: без ваги
    ["bodyweight", "hpush", "compound", false],
    ["cable", "core", "accessory", false],
    ["cable", "core", "compound", false], // core — не база, навіть якщо kind збіжиться
    ["dumbbell", "delt", "compound", false],
    ["machine", "legacc", "compound", false],
    ["dumbbell", "squat", "accessory", false], // випади — допоміжна
    ["barbell", "squat", null, false],
    ["barbell", null, "compound", false],
  ] as const)("%s · %s · %s → %s", (equipment, pattern, kind, expected) => {
    expect(isWarmupExercise(e(equipment, pattern, kind))).toBe(expected);
  });
});
