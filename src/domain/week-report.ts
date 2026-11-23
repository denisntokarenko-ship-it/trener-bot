// Недільний звіт (docs/spec/phase-2.md, розділ 4): структура, яку потім рендерить texts.ts. Чисті функції без I/O.
// Фаза 4 додасть у `WeeklyReport` поле коментаря — рендер лишається окремо.
import type { ProgressSetRow } from "./records";
import type { ExerciseUnits } from "./units";
import { addDays } from "./time";
import { avg7, weekChange, type WeightEntry } from "./weight";

export const MAX_REPORT_RECORDS = 3;

export interface WeekRecord {
  nameUk: string;
  bodyweight: boolean;
  units: ExerciseUnits;
  /** Вага тіла: 0 — показуються повтори. */
  weightKg: number;
  reps: number;
  /** Приріст над попереднім рекордом (кг; для ваги тіла — повтори): за ним відбір. */
  gain: number;
}

/**
 * Нові рекорди тижня `[fromUtc, toUtc)`: вправа, де макс. вага (вага тіла — повтори) у сесіях тижня перевищила
 * попередній рекорд. Перша сесія вправи — калібрування, рекордом не вважається (лише задає базу). Відбір ≤ 3:
 * за приростом спадно, за рівності — за назвою.
 */
export function weekRecords(rows: readonly ProgressSetRow[], fromUtc: number, toUtc: number): WeekRecord[] {
  const byExercise = new Map<number, ProgressSetRow[]>();
  for (const r of rows) {
    if (r.reps < 1) continue;
    const list = byExercise.get(r.exerciseId);
    if (list) list.push(r);
    else byExercise.set(r.exerciseId, [r]);
  }
  const out: WeekRecord[] = [];
  for (const list of byExercise.values()) {
    const bw = list[0]!.bodyweight;
    const metric = (r: ProgressSetRow): number => (bw ? r.reps : r.weightKg);
    const sessions = new Map<number, { at: number; sets: ProgressSetRow[] }>();
    for (const r of list) {
      const s = sessions.get(r.workoutId);
      if (s) s.sets.push(r);
      else sessions.set(r.workoutId, { at: r.startedAt, sets: [r] });
    }
    const ordered = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    const firstId = ordered[0]![0];
    // База — усе до тижня; якщо до тижня нічого немає, то лише перша сесія (вона не рахується).
    const before = ordered.filter(([, s]) => s.at < fromUtc);
    const base = Math.max(...(before.length > 0 ? before : [ordered[0]!]).flatMap(([, s]) => s.sets.map(metric)));
    const inWeek = ordered.filter(([id, s]) => id !== firstId && s.at >= fromUtc && s.at < toUtc).flatMap(([, s]) => s.sets);
    if (inWeek.length === 0) continue;
    const top = Math.max(...inWeek.map(metric));
    if (top <= base) continue;
    const reps = Math.max(...inWeek.filter((r) => metric(r) === top).map((r) => r.reps));
    out.push({ nameUk: list[0]!.nameUk, bodyweight: bw, units: list[0]!.units, weightKg: bw ? 0 : top, reps, gain: top - base });
  }
  return out.sort((a, b) => b.gain - a.gain || a.nameUk.localeCompare(b.nameUk, "uk")).slice(0, MAX_REPORT_RECORDS);
}

export interface WeeklyReport {
  /** Пн і Нд тижня (локальні дати). */
  weekStart: string;
  weekEnd: string;
  workouts: number;
  /** «з N» — кількість training_days. */
  planned: number;
  sets: number;
  volumeKg: number;
  records: WeekRecord[];
  /** Середня вага тижня (Пн–Нд) і зміна до минулого тижня; null — записів за тиждень немає. */
  weight: { avgDg: number; n: number; changeDg: number | null } | null;
  /** Назва наступного дня (`dayLabel`); null — немає активної програми. */
  next: string | null;
}

export interface WeeklyReportInput {
  /** Неділя тижня — локальна дата, коли звіт формується. */
  weekEnd: string;
  planned: number;
  stats: { workouts: number; sets: number; volumeKg: number };
  progressRows: readonly ProgressSetRow[];
  /** Межі тижня в UTC: `localDayStartUtc(Пн)` … `localDayStartUtc(Пн наступного)`. */
  fromUtc: number;
  toUtc: number;
  /** Записи ваги щонайменше за два тижні (Пн минулого — Нд цього). */
  weights: readonly WeightEntry[];
  next: string | null;
}

export function buildWeeklyReport(i: WeeklyReportInput): WeeklyReport {
  // Тиждень Пн–Нд — це 7 дат, що закінчуються неділею: ті самі вікна, що й W0/W1 на екранах ваги.
  const { avgDg, n } = avg7(i.weights, i.weekEnd);
  return {
    weekStart: addDays(i.weekEnd, -6),
    weekEnd: i.weekEnd,
    workouts: i.stats.workouts,
    planned: i.planned,
    sets: i.stats.sets,
    volumeKg: i.stats.volumeKg,
    records: weekRecords(i.progressRows, i.fromUtc, i.toUtc),
    weight: avgDg === null ? null : { avgDg, n, changeDg: weekChange(i.weights, i.weekEnd) },
    next: i.next,
  };
}
