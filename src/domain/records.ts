// Рекорди й e1RM (docs/spec/phase-2.md, розділ 3). Чисті функції: без I/O, без Date.now.
import type { ExerciseUnits } from "./units";

/** Підходи з більшою кількістю повторів у e1RM не беруться: формула Еплі стає ненадійною. */
export const E1RM_MAX_REPS = 10;

/** Один зарахований підхід (непропущений, з вагою й повторами ≥ 1) з контекстом сесії. */
export interface ProgressSetRow {
  exerciseId: number;
  nameUk: string;
  /** Вага тіла: e1RM немає, рахуються повтори. */
  bodyweight: boolean;
  /** Одиниці для підписів: гантель / повтори на сторону. */
  units: ExerciseUnits;
  workoutId: number;
  startedAt: number;
  weightKg: number;
  reps: number;
}

export interface BestSet {
  weightKg: number;
  reps: number;
}

export interface ExerciseProgress {
  exerciseId: number;
  nameUk: string;
  bodyweight: boolean;
  units: ExerciseUnits;
  start: BestSet;
  now: BestSet;
  /** Дата рекорду — момент початку тренування, де його вперше поставлено. */
  record: BestSet & { at: number };
  /** e1RM найкращого підходу останньої сесії, до 0,5 кг; null — немає підходів з ≤ 10 повторів. */
  e1rm: number | null;
  /** Початок останньої сесії: за ним сортується екран. */
  lastAt: number;
}

/** Еплі: w × (1 + r/30); r = 1 → w. Без округлення. */
export function epley(weightKg: number, reps: number): number {
  return reps === 1 ? weightKg : weightKg * (1 + reps / 30);
}

/** До найближчих 0,5 кг. */
export const roundHalfKg = (x: number): number => Math.round(x * 2) / 2;

/** Найкращий підхід сесії: максимум e1RM серед підходів з r ≤ 10; немає таких — найбільша вага (за рівності — більше повторів). */
export function bestSet(sets: readonly BestSet[], bodyweight: boolean): BestSet {
  let best: BestSet | null = null;
  const better = (a: BestSet, b: BestSet): boolean => (bodyweight ? a.reps > b.reps : a.weightKg > b.weightKg || (a.weightKg === b.weightKg && a.reps > b.reps));
  const eligible = bodyweight ? [] : sets.filter((s) => s.reps <= E1RM_MAX_REPS);
  if (eligible.length > 0) {
    let top = -1;
    for (const s of eligible) {
      const e = epley(s.weightKg, s.reps);
      if (e > top || (e === top && better(s, best!))) {
        top = e;
        best = s;
      }
    }
    return best!;
  }
  for (const s of sets) if (!best || better(s, best)) best = s;
  return best!;
}

/**
 * Агрегат по всій історії (без вікна): рядки підходів у будь-якому порядку → вправи за датою останньої сесії, нові зверху
 * (за рівної дати — за id вправи). Вправа без жодного підходу сюди не потрапляє.
 */
export function buildProgress(rows: readonly ProgressSetRow[]): ExerciseProgress[] {
  const byExercise = new Map<number, ProgressSetRow[]>();
  for (const r of rows) {
    if (r.reps < 1) continue;
    const list = byExercise.get(r.exerciseId);
    if (list) list.push(r);
    else byExercise.set(r.exerciseId, [r]);
  }
  const out: ExerciseProgress[] = [];
  for (const list of byExercise.values()) {
    const head = list[0]!;
    const sessions = new Map<number, { at: number; sets: ProgressSetRow[] }>();
    for (const r of list) {
      const s = sessions.get(r.workoutId);
      if (s) s.sets.push(r);
      else sessions.set(r.workoutId, { at: r.startedAt, sets: [r] });
    }
    const ordered = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).map(([, s]) => s);
    const first = ordered[0]!;
    const last = ordered.at(-1)!;
    const bw = head.bodyweight;
    const bestOf = (s: { sets: ProgressSetRow[] }): BestSet => {
      const b = bestSet(s.sets, bw);
      return { weightKg: b.weightKg, reps: b.reps };
    };

    // Рекорд: найбільша вага (вага тіла — повтори), за рівності — більше повторів; за повної рівності лишається найраніший.
    let record: ExerciseProgress["record"] | null = null;
    for (const s of ordered) {
      for (const x of s.sets) {
        const beats = !record || (bw ? x.reps > record.reps : x.weightKg > record.weightKg || (x.weightKg === record.weightKg && x.reps > record.reps));
        if (beats) record = { weightKg: x.weightKg, reps: x.reps, at: s.at };
      }
    }

    const now = bestOf(last);
    const eligible = bw ? [] : last.sets.filter((x) => x.reps <= E1RM_MAX_REPS);
    out.push({
      exerciseId: head.exerciseId,
      nameUk: head.nameUk,
      bodyweight: bw,
      units: head.units,
      start: bestOf(first),
      now,
      record: record!,
      e1rm: eligible.length > 0 ? roundHalfKg(epley(now.weightKg, now.reps)) : null,
      lastAt: last.at,
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt || a.exerciseId - b.exerciseId);
}
