// Чисті правила анкети (docs/spec/phase-1b.md, §1): порядок кроків, валідація вводу, вправи-якорі для робочих ваг.
// Без I/O і без Date.now — рік «зараз» приходить параметром.
import { GOAL_PARAMS, type Goal, type Level, type Limit, type Place, type PlanCatalogItem } from "./plan";

/** Порядок кроків анкети; збігається з `ONBOARDING_STEPS` у схемі (тест). */
export const STEPS = [
  "welcome", "goal", "goal_note", "level", "days", "minutes", "place", "limits", "limits_note", "lifts",
  "sex", "birth", "height", "weight", "meals", "diet", "sleep", "activity", "plan",
] as const;
export type Step = (typeof STEPS)[number];

/** Кроки, що чекають текст від людини (інші — лише кнопки). */
export const TEXT_STEPS: ReadonlySet<Step> = new Set<Step>(["goal_note", "limits_note", "lifts", "birth", "height", "weight", "diet"]);

export const NOTE_MAX = 300;

/** Значення за замовчуванням для пропущених питань (§1). Решта пропущеного — NULL. */
export const SKIP_DEFAULTS = { level: "novice", daysPerWeek: 3, sessionMin: 60, place: "gym", limits: "" } as const;

export function nextStep(step: Step): Step {
  return STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)]!;
}
export function prevStep(step: Step): Step {
  return STEPS[Math.max(STEPS.indexOf(step) - 1, 0)]!;
}

// --- Ввід ---

const DECIMAL = /^\d{1,4}(?:[.,]\d{1,2})?$/;

/** «80,5» / «80.5» / «80» → число; інше (мінус, літери, порожнє) — null. */
export function parseDecimal(raw: string): number | null {
  const t = raw.trim();
  return DECIMAL.test(t) ? Number(t.replace(",", ".")) : null;
}

/** Вага тіла 30–300 кг. */
export function parseBodyWeight(raw: string): number | null {
  const v = parseDecimal(raw);
  return v !== null && v >= 30 && v <= 300 ? v : null;
}

/** Зріст 120–230 см (десяткові округлюються до цілого). */
export function parseHeight(raw: string): number | null {
  const v = parseDecimal(raw);
  if (v === null) return null;
  const cm = Math.round(v);
  return cm >= 120 && cm <= 230 ? cm : null;
}

/** Рік народження: чотири цифри, вік 14–80, рік у межах схеми 1930–2020. */
export function parseBirthYear(raw: string, nowYear: number): number | null {
  const t = raw.trim();
  if (!/^\d{4}$/.test(t)) return null;
  const y = Number(t);
  const age = nowYear - y;
  return age >= 14 && age <= 80 && y >= 1930 && y <= 2020 ? y : null;
}

/** Нотатка 1–300 символів (за кодовими точками, як `length()` у SQLite); порожня чи задовга — null. */
export function parseNote(raw: string): string | null {
  const t = raw.trim();
  const len = [...t].length;
  return len >= 1 && len <= NOTE_MAX ? t : null;
}

export const MAX_START_WEIGHT_KG = 400;
export const MAX_START_REPS = 30;

export type LiftError = "format" | "weight" | "reps" | "min";
export type LiftResult = { ok: true; weightKg: number; reps: number } | { ok: false; error: LiftError };

/**
 * «60x8» / «60×8» / «60 8» / «42,5x10»: вага > 0 і ≤ 400, повтори 1–30; вага округлюється вниз до кроку вправи.
 * Нижче `min_weight_kg` після округлення — помилка `min` (грифа/найлегшої гантелі не вистачає).
 */
export function parseLift(raw: string, ex: { weightStepKg: number; minWeightKg: number }): LiftResult {
  const m = /^(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:[xXхХ×*]\s*|\s+)(\d{1,3})$/.exec(raw.trim());
  if (!m) return { ok: false, error: "format" };
  const weight = Number(m[1]!.replace(",", "."));
  const reps = Number(m[2]);
  if (!(weight > 0) || weight > MAX_START_WEIGHT_KG) return { ok: false, error: "weight" };
  if (reps < 1 || reps > MAX_START_REPS) return { ok: false, error: "reps" };
  const g = Math.round(weight * 1000);
  const step = Math.round(ex.weightStepKg * 1000);
  const floored = step > 0 ? Math.floor(g / step) * step : g;
  if (floored < Math.round(ex.minWeightKg * 1000) || floored <= 0) return { ok: false, error: "min" };
  return { ok: true, weightKg: floored / 1000, reps };
}

// --- Якорі робочих ваг (питання 7) ---

/** id вправ-якорів за місцем, у порядку питань (стабільні id сиду): зал — присідання, жим лежачи, тяга блока, жим сидячи. */
export const ANCHOR_IDS: Record<Place, readonly number[]> = {
  gym: [1, 2, 3, 4],
  home: [11, 16, 22, 15],
};

export interface AnchorProfile {
  level: Level;
  place: Place;
  limits: readonly Limit[];
  goal: Goal | null;
}

const LEVEL_NUM: Record<Level, number> = { novice: 1, mid: 2, adv: 3 };

/** Якорі, що проходять ті самі фільтри, що й `buildPlan` (місце, рівень, обмеження, «без штанги» для health). */
export function anchorCandidates(profile: AnchorProfile, catalog: readonly PlanCatalogItem[]): number[] {
  const noBarbell = profile.goal !== null && GOAL_PARAMS[profile.goal].noBarbell;
  const byId = new Map(catalog.map((c) => [c.id, c]));
  return ANCHOR_IDS[profile.place].filter((id) => {
    const item = byId.get(id);
    if (!item) return false;
    if (profile.place === "home" && item.place !== "both") return false;
    if (item.minLevel > LEVEL_NUM[profile.level]) return false;
    if (item.stress.some((s) => profile.limits.includes(s))) return false;
    return !(noBarbell && item.equipment === "barbell");
  });
}
