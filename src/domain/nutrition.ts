// Денна норма КБЖУ (docs/spec/phase-3.md, розділ 3) і корекція за трендом ваги (розділ 4): чисті функції без I/O і без Date.now —
// рік і «сьогодні» приходять параметром.
import { GOAL_BANDS, TREND_MAX_DEVIATION_KCAL, TREND_MIN_KCAL, TREND_MIN_PER_WINDOW, TREND_MIN_WEIGHINGS, TREND_STEP_CARBS_G, TREND_STEP_KCAL } from "../config";
import { addDays } from "./time";
import { windowStats, type WeightEntry } from "./weight";

export type Sex = "m" | "f";
export type Activity = "low" | "mid" | "high";
export type Goal = "lose_fat" | "muscle" | "recomp" | "strength" | "health" | "other";

/** Межі `nutrition_targets.kcal`: поза ними норми немає. */
export const NORM_KCAL_MIN = 800;
export const NORM_KCAL_MAX = 6000;

/** Рух поза залом (тренування вже враховані в цілі). */
export const ACTIVITY_K: Record<Activity, number> = { low: 1.375, mid: 1.55, high: 1.725 };

/** Δ до TDEE за ціллю: рекомпозиція −10 % (рішення плану). */
export const GOAL_DELTA: Record<Goal, number> = { lose_fat: -0.2, recomp: -0.1, muscle: 0.1, strength: 0, health: 0, other: 0 };

export const PROTEIN_G_PER_KG = 1.8;
export const FAT_G_PER_KG = 0.8;

/** Міффлін — Сан Жеор, ккал/добу (не округлюється): 10·w + 6,25·h − 5·вік + (m: +5, f: −161). */
export function bmrMifflin(sex: Sex, weightKg: number, heightCm: number, age: number): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === "m" ? 5 : -161);
}

export function tdee(bmr: number, activity: Activity): number {
  return bmr * ACTIVITY_K[activity];
}

/** До найближчих 10, половина вгору (для невід'ємних). */
export const round10 = (x: number): number => Math.floor(x / 10 + 0.5) * 10;

export interface NormProfile {
  sex: Sex;
  birthYear: number;
  heightCm: number;
  activity: Activity;
  goal: Goal;
}
export interface Norm {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

/**
 * Норма на день. `year` — рік локальної дати (вік = year − birthYear). Білок 1,8·w, жир 0,8·w, решта — вуглеводи (≥ 0).
 * Якщо 4Б + 9Ж > kcal, вуглеводи 0 і kcal = 4Б + 9Ж (норма лишається арифметично цілісною).
 * null — kcal поза 800–6000: норми немає (крайній, але дозволений профіль).
 */
export function targets(p: NormProfile, weightKg: number, year: number): Norm | null {
  const bmr = bmrMifflin(p.sex, weightKg, p.heightCm, year - p.birthYear);
  let kcal = round10(tdee(bmr, p.activity) * (1 + GOAL_DELTA[p.goal]));
  const proteinG = Math.round(PROTEIN_G_PER_KG * weightKg);
  const fatG = Math.round(FAT_G_PER_KG * weightKg);
  const floor = 4 * proteinG + 9 * fatG;
  let carbsG = Math.max(0, Math.round((kcal - floor) / 4));
  if (floor > kcal) {
    carbsG = 0;
    kcal = floor;
  }
  if (!Number.isFinite(kcal) || kcal < NORM_KCAL_MIN || kcal > NORM_KCAL_MAX) return null;
  return { kcal, proteinG, fatG, carbsG };
}

/**
 * Вага для норми: «Зараз» Фази 2 (середнє W0, інакше останній запис `body_weights`), а немає записів — вага з анкети.
 * Вхід у десятих кг (`avgDg`, `lastDg`) і кг (`profileKg`); результат — кг з точністю до десятих або null.
 */
export function normWeightKg(w: { avgDg: number | null; lastDg: number | null; profileKg: number | null }): number | null {
  if (w.avgDg !== null) return w.avgDg / 10;
  if (w.lastDg !== null) return w.lastDg / 10;
  return w.profileKg;
}

/** Поля профілю, що бракують для норми, у порядку питань: ціль → стать → рік → зріст → активність → вага. */
export type MissingField = "goal" | "sex" | "birth_year" | "height_cm" | "activity" | "weight";
export const MISSING_ORDER: readonly MissingField[] = ["goal", "sex", "birth_year", "height_cm", "activity", "weight"];

export interface ProfileForNorm {
  goal: Goal | null;
  sex: Sex | null;
  birthYear: number | null;
  heightCm: number | null;
  activity: Activity | null;
}

/** Перше відсутнє поле (за порядком питань) або null, якщо норму можна рахувати. */
export function firstMissing(p: ProfileForNorm | null, weightKg: number | null): MissingField | null {
  const has: Record<MissingField, boolean> = {
    goal: p?.goal != null,
    sex: p?.sex != null,
    birth_year: p?.birthYear != null,
    height_cm: p?.heightCm != null,
    activity: p?.activity != null,
    weight: weightKg !== null,
  };
  return MISSING_ORDER.find((f) => !has[f]) ?? null;
}

export interface TrendInput {
  /** Зважування за ≥ 14 днів до `today` включно (зайві дати ігноруються). */
  weights: readonly WeightEntry[];
  goal: Goal;
  /** Локальна дата оцінки: `W0` = today−6…today, `W1` = today−13…today−7. */
  today: string;
  /** Чинна норма: kcal і вуглеводи. */
  kcal: number;
  carbsG: number;
  /** kcal норми `reason = formula` (від неї міряється сумарне відхилення). */
  formulaKcal: number;
}
export interface TrendProposal {
  delta: 100 | -100;
  /** Середні `W1` і `W0` у десятих кг, половина вгору. */
  avg1Dg: number;
  avg0Dg: number;
  /** Темп `p` у сотих відсотка за тиждень (−75 = −0,75 %/тиж), половина від нуля. */
  paceCenti: number;
  newKcal: number;
  carbsDeltaG: number;
}

const divHalfUp = (a: number, b: number): number => Math.floor((2 * a + b) / (2 * b));

/**
 * Пропозиція ±100 ккал за темпом зміни ваги (спека, розділ 4) або null. Темп `p = (avg(W0) − avg(W1)) / avg(W1) · 100` —
 * цілочисельне перехресне множення десятих кг, без `float`; порогів строго (рівно на порозі — нічого).
 * Умови: зважувань у `W0 ∪ W1` ≥ 10 і в кожному вікні ≥ 3; нова норма в межах ±300 від `formula` і ≥ 1200; `−100` — лише якщо вуглеводів ≥ 25 г.
 */
export function trendProposal(i: TrendInput): TrendProposal | null {
  const w0 = windowStats(i.weights, i.today);
  const w1 = windowStats(i.weights, addDays(i.today, -7));
  if (w0.n + w1.n < TREND_MIN_WEIGHINGS || w0.n < TREND_MIN_PER_WINDOW || w1.n < TREND_MIN_PER_WINDOW) return null;
  const num = w0.sum * w1.n - w1.sum * w0.n; // знак p
  const den = w1.sum * w0.n; // > 0
  const band = GOAL_BANDS[i.goal];
  const delta = num * 10000 < band.add * den ? TREND_STEP_KCAL : num * 10000 > band.cut * den ? -TREND_STEP_KCAL : 0;
  if (delta === 0) return null;
  const newKcal = i.kcal + delta;
  if (newKcal < TREND_MIN_KCAL || newKcal > NORM_KCAL_MAX || Math.abs(newKcal - i.formulaKcal) > TREND_MAX_DEVIATION_KCAL) return null;
  if (delta < 0 && i.carbsG < TREND_STEP_CARBS_G) return null;
  const abs = divHalfUp(Math.abs(num) * 10000, den);
  return {
    delta: delta as 100 | -100,
    avg1Dg: divHalfUp(w1.sum, w1.n),
    avg0Dg: divHalfUp(w0.sum, w0.n),
    paceCenti: num < 0 && abs > 0 ? -abs : abs,
    newKcal,
    carbsDeltaG: delta > 0 ? TREND_STEP_CARBS_G : -TREND_STEP_CARBS_G,
  };
}

/** Темп у сотих відсотка → «−0,75» / «+0,20» / «0,00». */
export function formatPace(centi: number): string {
  const a = Math.abs(centi);
  return `${centi < 0 ? "−" : centi > 0 ? "+" : ""}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}`;
}
