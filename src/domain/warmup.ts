// Розминкові підходи (docs/spec/phase-1-flow.md, «Розминка»). Чисті функції: без I/O і Date.now.
// Арифметика ваг — у цілих грамах, як у прогресії: 22,5 кг не має дробових похибок.

export interface WarmupSet {
  weightKg: number;
  reps: number;
}

export interface WarmupInput {
  /** Робоча вага з екрана вправи. */
  workingKg: number;
  /** `exercises.weight_step_kg`. */
  stepKg: number;
  /** `exercises.min_weight_kg` — нижче цієї ваги розминкового підходу не буває. */
  minKg: number;
}

/** Схема: частка робочої ваги (%) × повтори. */
export const WARMUP_SCHEME: ReadonlyArray<{ percent: number; reps: number }> = [
  { percent: 50, reps: 8 },
  { percent: 75, reps: 4 },
];

const toGrams = (kg: number): number => Math.round(kg * 1000);

/**
 * ≈50 % × 8 і ≈75 % × 4: кожна вага — вниз до кратного кроку, не нижче мінімуму. Підхід, що ≥ робочої ваги
 * або дорівнює попередньому показаному (чи нуль), відпадає; нічого не лишилось → порожньо.
 */
export function warmupSets(input: WarmupInput): WarmupSet[] {
  const working = toGrams(input.workingKg);
  const step = toGrams(input.stepKg);
  const min = toGrams(input.minKg);
  if (!(working > 0) || !(step > 0)) return [];
  const out: WarmupSet[] = [];
  let previous = -1;
  for (const { percent, reps } of WARMUP_SCHEME) {
    const grams = Math.max(Math.floor((working * percent) / (100 * step)) * step, min);
    if (grams <= 0 || grams >= working || grams === previous) continue;
    out.push({ weightKg: grams / 1000, reps });
    previous = grams;
  }
  return out;
}

/** Силові патерни з вагою; `core`, `delt` і `legacc` — ізоляція, розминка до них зайва. */
const BASE_PATTERNS: ReadonlySet<string> = new Set(["squat", "hinge", "hpush", "vpush", "hpull", "vpull"]);

/** Базова вправа з вагою: `equipment ≠ bodyweight`, `kind = compound`, патерн із `BASE_PATTERNS`. Порожні метадані → ні. */
export function isWarmupExercise(e: { equipment: string; pattern: string | null; kind: string | null }): boolean {
  return e.equipment !== "bodyweight" && e.kind === "compound" && e.pattern !== null && BASE_PATTERNS.has(e.pattern);
}
