// Вага тіла (docs/spec/phase-2.md, розділ 2). Чисті функції: без I/O, без Date.now, без float-округлень.
// Вага — цілі десяті кілограма («dg»): 78,4 кг = 784.
import { addDays } from "./time";

export const MIN_WEIGHT_DG = 300;
export const MAX_WEIGHT_DG = 3000;
/** Стрибок до попереднього запису, після якого відповідь просить перевірити (> 5 кг). */
export const JUMP_DG = 50;
export const JUMP_LOOKBACK_DAYS = 14;

const FORMAT = /^(\d{2,3})(?:[.,](\d{1,2}))?$/;

/** Рядок формату `^\d{2,3}([.,]\d{1,2})?$` → ціла кількість сотих; інакше null. */
function hundredths(raw: string): number | null {
  const m = FORMAT.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Чи схоже на вагу за форматом (без діапазону): для відрізнення голого числа від тексту. */
export function parseWeightDg(raw: string): number | null {
  const h = hundredths(raw);
  if (h === null) return null;
  const dg = Math.floor((h + 5) / 10); // половина вгору до десятих
  return dg >= MIN_WEIGHT_DG && dg <= MAX_WEIGHT_DG ? dg : null;
}

/** Чи схоже на вагу: формат і діапазон перевіряються після округлення (29,96 → 30,0 — вага; 29,94 — ні). */
export const isWeightLike = (raw: string): boolean => parseWeightDg(raw) !== null;

export interface WeightEntry {
  localDate: string;
  weightDg: number;
}

export interface WindowStats {
  /** Сума десятих і кількість записів у вікні. */
  sum: number;
  n: number;
}

/** 7 локальних дат, що закінчуються `end` включно: W0 → end = сьогодні, W1 → сьогодні−7. */
function windowStats(entries: readonly WeightEntry[], end: string): WindowStats {
  const start = addDays(end, -6);
  let sum = 0;
  let n = 0;
  for (const e of entries) {
    if (e.localDate >= start && e.localDate <= end) {
      sum += e.weightDg;
      n++;
    }
  }
  return { sum, n };
}

/** Ділення з округленням половини вгору (для невід'ємних). */
const divHalfUp = (a: number, b: number): number => Math.floor((2 * a + b) / (2 * b));

/** Середнє за 7 локальних дат до `today` включно. n = 0 → avgDg null. */
export function avg7(entries: readonly WeightEntry[], today: string): { avgDg: number | null; n: number } {
  const { sum, n } = windowStats(entries, today);
  return { avgDg: n === 0 ? null : divHalfUp(sum, n), n };
}

/**
 * Зміна до минулого тижня: avg(W0) − avg(W1) на неокруглених середніх, у десятих з округленням половини від нуля.
 * null — якщо в одному з вікон менше 2 записів.
 */
export function weekChange(entries: readonly WeightEntry[], today: string): number | null {
  const w0 = windowStats(entries, today);
  const w1 = windowStats(entries, addDays(today, -7));
  if (w0.n < 2 || w1.n < 2) return null;
  const num = w0.sum * w1.n - w1.sum * w0.n;
  const den = w0.n * w1.n;
  const abs = divHalfUp(Math.abs(num), den);
  return num < 0 && abs > 0 ? -abs : abs;
}

const MINUS = "−";

/** 784 → «78,4». */
export function formatKg(dg: number): string {
  return `${Math.floor(dg / 10)},${dg % 10}`;
}

/** Зі знаком: +0,3 / −0,5; нуль — «0,0» без знаку. */
export function formatChange(dg: number): string {
  if (dg === 0) return "0,0";
  return `${dg < 0 ? MINUS : "+"}${formatKg(Math.abs(dg))}`;
}

/** Попередній запис за ≤ 14 днів до `today` (не сьогодні) і різниця новий − попередній, якщо > 5 кг за модулем. */
export function jumpFrom(entries: readonly WeightEntry[], today: string, newDg: number): number | null {
  const from = addDays(today, -JUMP_LOOKBACK_DAYS);
  let prev: WeightEntry | null = null;
  for (const e of entries) if (e.localDate >= from && e.localDate < today && (!prev || e.localDate > prev.localDate)) prev = e;
  if (!prev) return null;
  const diff = newDg - prev.weightDg;
  return Math.abs(diff) > JUMP_DG ? diff : null;
}
