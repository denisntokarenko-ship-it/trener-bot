// Чисті правила анкети й стартові ваги в прогресії (phase-1b.md, P2.9, §1 «Питання 7»).
import { describe, expect, it } from "vitest";
import { ONBOARDING_STEPS } from "../src/db/schema";
import { STEPS, parseBirthYear, parseBodyWeight, parseHeight, parseLift, parseNote } from "../src/domain/onboarding";
import { nextPrescription } from "../src/domain/progression";

const squat = { weightStepKg: 5, minWeightKg: 20 };
const slot = { repMin: 6, repMax: 10 };

describe("P2.9 стартова вага в nextPrescription", () => {
  it("60×8 → 60 кг × repMin, причина calibration", () => {
    expect(nextPrescription([], squat, slot, { weightKg: 60, reps: 8 })).toEqual({ weightKg: 60, targetReps: 6, reason: "calibration" });
  });
  it("60×4 при repMin 6, крок 5 → 54 → 50 кг", () => {
    expect(nextPrescription([], squat, slot, { weightKg: 60, reps: 4 }).weightKg).toBe(50);
  });
  it("без запису — мінімум; нижче мінімуму — мінімум", () => {
    expect(nextPrescription([], squat, slot).weightKg).toBe(20);
    expect(nextPrescription([], squat, slot, { weightKg: 10, reps: 8 }).weightKg).toBe(20);
  });
  it("є історія — start ігнорується", () => {
    const h = [{ plannedSets: 1, effort: 3, sets: [{ setNo: 1, weightKg: 40, reps: 6, skipped: false }] }];
    expect(nextPrescription(h, squat, slot, { weightKg: 100, reps: 8 }).weightKg).toBe(40);
  });
});

describe("валідація вводу анкети", () => {
  it("вага тіла", () => {
    expect(parseBodyWeight("80,5")).toBe(80.5);
    for (const bad of ["0", "1000", "-5", "29", "301", "x"]) expect(parseBodyWeight(bad)).toBeNull();
  });
  it("зріст і рік", () => {
    expect(parseHeight("120")).toBe(120);
    expect(parseHeight("119")).toBeNull();
    expect(parseBirthYear("1995", 2026)).toBe(1995);
    expect(parseBirthYear("2015", 2026)).toBeNull();
    expect(parseBirthYear("1930", 2026)).toBeNull();
  });
  it("нотатка 1–300", () => {
    expect(parseNote(" ")).toBeNull();
    expect(parseNote("a".repeat(300))).not.toBeNull();
    expect(parseNote("a".repeat(301))).toBeNull();
  });
  it("робоча вага: роздільники й округлення вниз", () => {
    for (const s of ["60x8", "60×8", "60 8", "60х8"]) expect(parseLift(s, squat)).toEqual({ ok: true, weightKg: 60, reps: 8 });
    expect(parseLift("62x8", squat)).toEqual({ ok: true, weightKg: 60, reps: 8 });
    expect(parseLift("42,5x10", { weightStepKg: 2, minWeightKg: 2 })).toEqual({ ok: true, weightKg: 42, reps: 10 });
    expect(parseLift("401x8", squat)).toMatchObject({ error: "weight" });
    expect(parseLift("60x31", squat)).toMatchObject({ error: "reps" });
  });
  it("кроки збігаються зі схемою", () => {
    expect([...STEPS]).toEqual([...ONBOARDING_STEPS]);
  });
});
