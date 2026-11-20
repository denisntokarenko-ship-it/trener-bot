// Рушій подвійної прогресії (docs/spec/phase-1.md, «Правила прогресії»).
// Чисті функції: без I/O, без Date.now, без імпорту БД. Арифметика ваг — у цілих грамах.

export type PrescriptionReason = "calibration" | "deload" | "hold" | "increase" | "reps";

export interface Prescription {
  weightKg: number;
  targetReps: number;
  reason: PrescriptionReason;
}

export interface ProgressionSet {
  setNo: number;
  weightKg: number | null;
  reps: number | null;
  skipped: boolean;
}

/** Сесія вправи в одному тренуванні `done` / `abandoned`. Структурно сумісна з `HistorySession` з repo. */
export interface ProgressionSession {
  /** `sets` слота, за яким записано підходи. Відсутні підходи рахуються пропущеними. */
  plannedSets: number;
  /** `workouts.effort`; `null` (abandoned) ≠ 5. */
  effort: number | null;
  sets: readonly ProgressionSet[];
}

export interface ProgressionExercise {
  weightStepKg: number;
  minWeightKg: number;
}

export interface ProgressionSlot {
  repMin: number;
  repMax: number;
}

/** Робоча вага з анкети (start_weights): діє лише поки в вправи немає історії (phase-1b.md, §2). */
export interface StartWeight {
  weightKg: number;
  reps: number;
}

interface Analyzed {
  /** Робоча вага сесії, г. */
  w: number;
  success: boolean;
  failure: boolean;
  maxReps: number;
  effort: number | null;
}

const toGrams = (kg: number): number => Math.round(kg * 1000);

/** Аналіз сесії; `null` — сесія без жодного непропущеного підходу (не зараховується). */
function analyze(s: ProgressionSession, slot: ProgressionSlot): Analyzed | null {
  const done = [...s.sets]
    .sort((a, b) => a.setNo - b.setNo)
    .filter((x): x is ProgressionSet & { weightKg: number; reps: number } => !x.skipped && x.weightKg !== null && x.reps !== null);
  const last = done.at(-1);
  if (!last) return null;
  const w = toGrams(last.weightKg);
  const working = done.filter((x) => toGrams(x.weightKg) === w);
  // Повна: стільки робочих підходів, скільки в слоті; жодного пропущеного (відсутні теж пропущені) й іншої ваги.
  const complete = working.length === s.plannedSets && done.length === s.plannedSets;
  return {
    w,
    success: complete && working.every((x) => x.reps >= slot.repMax),
    failure: working.some((x) => x.reps < slot.repMin),
    maxReps: Math.max(...working.map((x) => x.reps)),
    effort: s.effort,
  };
}

export function nextPrescription(
  history: readonly ProgressionSession[],
  exercise: ProgressionExercise,
  slot: ProgressionSlot,
  start: StartWeight | null = null,
): Prescription {
  const stepG = toGrams(exercise.weightStepKg);
  const minG = toGrams(exercise.minWeightKg);
  // Правило 6: крок 0 — лише нижня межа; інакше — округлення вниз до кроку.
  const norm = (g: number): number => Math.max(minG, stepG === 0 ? g : Math.floor(g / stepG) * stepG);
  const out = (g: number, targetReps: number, reason: PrescriptionReason): Prescription => ({
    weightKg: norm(g) / 1000,
    targetReps,
    reason,
  });

  const counted = history.map((s) => analyze(s, slot)).filter((a): a is Analyzed => a !== null);
  const last = counted.at(-1);
  const prev = counted.at(-2);

  // 1. Калібрування. Робоча вага з анкети замінює мінімальну; повтори < repMin — вага × 0,9 (нормалізує norm).
  if (!last) {
    if (!start) return out(minG, slot.repMin, "calibration");
    const g = toGrams(start.weightKg);
    return out(start.reps >= slot.repMin ? g : Math.floor((g * 9) / 10), slot.repMin, "calibration");
  }
  // 4. Розвантаження: дві останні — невдачі з однаковою W (лічильник лише поспіль і за тієї самої W).
  if (prev && last.failure && prev.failure && prev.w === last.w) {
    return out(Math.floor((last.w * 9) / 10), slot.repMin, "deload");
  }
  // 5. Утримання після оцінки 5, але не двічі поспіль за тієї самої W.
  if (last.success && last.effort === 5 && !(prev && prev.success && prev.effort === 5 && prev.w === last.w)) {
    return out(last.w, slot.repMax, "hold");
  }
  // 2. Підвищення; для ваги тіла (крок 0) — стеля: вага та сама, повтори rep_max.
  if (last.success) {
    return stepG === 0 ? out(last.w, slot.repMax, "increase") : out(last.w + stepG, slot.repMin, "increase");
  }
  // 3. Додати повтор у межах [rep_min, rep_max].
  return out(last.w, Math.min(slot.repMax, Math.max(slot.repMin, last.maxReps + 1)), "reps");
}

export interface DayRef {
  code: string;
  position: number;
}

/**
 * Код наступного дня: немає `done`-тренувань — перший день за `position`; інакше — наступний за днем
 * останнього `done`, по колу. `abandoned` не зсуває (repo передає лише `done`). Невідомий код дня
 * (програму замінили) — перший день: спека мовчить, обрано безпечне стартове значення.
 */
export function nextDayCode(lastDone: { dayCode: string } | null, days: readonly DayRef[]): string {
  const ordered = [...days].sort((a, b) => a.position - b.position);
  const first = ordered[0];
  if (!first) throw new RangeError("nextDayCode: у програмі немає днів");
  if (!lastDone) return first.code;
  const i = ordered.findIndex((d) => d.code === lastDone.dayCode);
  if (i < 0) return first.code;
  return (ordered[(i + 1) % ordered.length] ?? first).code;
}
