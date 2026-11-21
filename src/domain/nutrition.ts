// Денна норма КБЖУ (docs/spec/phase-3.md, розділ 3): чисті функції без I/O і без Date.now — рік приходить параметром.

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
