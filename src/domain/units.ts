// Одиниці вправи (docs/spec/phase-1-flow.md, «Одиниці вправи»): вага гантельної вправи — це ОДНА гантель,
// повтори односторонньої — на КОЖНУ сторону. Чисті функції без I/O: тексти лише складають їх із числами.

/** Іменник сторони в «на кожну …»: legs → ногу, core → сторону, решта → руку. */
export type SideNoun = "ногу" | "руку" | "сторону";

export interface ExerciseUnits {
  /** Гантельна вправа: число ваги — вага однієї гантелі. */
  dumbbell: boolean;
  /** Одностороння вправа: повтори на кожну сторону; null — повтори загальні. */
  side: SideNoun | null;
}

export const NO_UNITS: ExerciseUnits = { dumbbell: false, side: null };

export interface UnitsSource {
  equipment: string;
  muscleGroup: string;
  unilateral: boolean;
}

export function unitsOf(e: UnitsSource): ExerciseUnits {
  const side: SideNoun = e.muscleGroup === "legs" ? "ногу" : e.muscleGroup === "core" ? "сторону" : "руку";
  return { dumbbell: e.equipment === "dumbbell", side: e.unilateral ? side : null };
}

/** `кг` або `кг на гантель`. */
export const kgUnit = (u: ExerciseUnits): string => (u.dumbbell ? "кг на гантель" : "кг");

/** `» на кожну ногу` після числа повторів або порожній рядок. */
export const repsTail = (u: ExerciseUnits): string => (u.side ? ` на кожну ${u.side}` : "");

/**
 * Пояснення для підказок (калібрування, блок `/progres`): `вага — однієї гантелі · повтори — на кожну ногу`;
 * null — звичайна вправа, пояснювати нічого.
 */
export function unitsNote(u: ExerciseUnits): string | null {
  const parts: string[] = [];
  if (u.dumbbell) parts.push("вага — однієї гантелі");
  if (u.side) parts.push(`повтори — на кожну ${u.side}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
