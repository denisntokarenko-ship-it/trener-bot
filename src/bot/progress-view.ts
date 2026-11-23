// /progres і /prohrama — чисті функції (phase-1-flow.md, P2.5). Тексти — у texts.ts.
import { InlineKeyboard } from "grammy";
import type { WorkoutSummaryRow } from "../db/repo";
import { avg7, formatChange, formatKg, weekChange, type WeightEntry } from "../domain/weight";
import { addDays, localDate } from "../domain/time";
import type { ExerciseProgress } from "../domain/records";
import {
  NO_WORKOUTS,
  PROGRESS_BACK_BTN,
  PROGRESS_EMPTY,
  PROGRESS_FULL_TITLE,
  PROGRESS_RECENT_BTN,
  TELEGRAM_TEXT_MAX,
  clip,
  dayName,
  exerciseBlock,
  fmtKg,
  progressTitle,
  WEIGHT_LABEL_PROFILE,
  weightBlock,
  weightLabelAvg,
  weightLabelFirst,
  weightLabelLast,
  workoutBlock as renderBlock,
  type WeightBlockModel,
} from "./texts";

export { NO_WORKOUTS, programText } from "./texts";
export type { NextSlotLine, ProgramTextModel as ProgramModel } from "./texts";

const DEFAULT_TZ = "Europe/Kyiv";

/** 1700000000000 → «15.11 (ср)» за часовим поясом користувача; невідомий пояс → Київ. */
export function fmtLocalDate(ms: number, tz: string): string {
  const make = (timeZone: string) => new Intl.DateTimeFormat("uk-UA", { timeZone, day: "2-digit", month: "2-digit", weekday: "short" });
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = make(tz);
  } catch {
    fmt = make(DEFAULT_TZ);
  }
  const part = (t: Intl.DateTimeFormatPartTypes) => fmt.formatToParts(ms).find((p) => p.type === t)?.value ?? "";
  return `${part("day")}.${part("month")} (${part("weekday")})`;
}

/** Підходи вправи: `60×8,8,7`; зміна ваги — `45×5, 40×8,8`; пропущений підхід — `—`. */
export function fmtSets(sets: WorkoutSummaryRow["exercises"][number]["sets"]): string {
  const groups: { w: string | null; reps: string[] }[] = [];
  for (const s of sets) {
    const w = s.skipped || s.weightKg === null ? null : fmtKg(s.weightKg);
    const token = s.skipped || s.reps === null ? "—" : String(s.reps);
    const last = groups.at(-1);
    if (last && (w === null || last.w === w)) last.reps.push(token);
    else groups.push({ w, reps: [token] });
  }
  return groups.map((g) => (g.w === null ? g.reps.join(",") : `${g.w}×${g.reps.join(",")}`)).join(", ");
}

const block = (w: WorkoutSummaryRow, tz: string): string =>
  renderBlock({
    date: fmtLocalDate(w.startedAt, tz),
    dayName: dayName({ code: w.dayCode, title: w.dayTitle }),
    effort: w.status === "done" && w.effort !== null ? w.effort : null,
    exercises: w.exercises.map((e) => ({ name: e.nameUk, sets: fmtSets(e.sets) })),
  });

/** Від нових до старих; не влізло в 4096 — відкидаються найстаріші (P2.5.3). */
export function progressText(workouts: readonly WorkoutSummaryRow[], tz: string): string {
  if (workouts.length === 0) return NO_WORKOUTS;
  const blocks = workouts.map((w) => block(w, tz));
  const join = (b: string[]): string => `${progressTitle}\n\n${b.join("\n\n")}`;
  while (blocks.length > 1 && join(blocks).length > TELEGRAM_TEXT_MAX) blocks.pop();
  return clip(join(blocks));
}

/** callback_data кнопок екрана /progres: без полів, не плутаються з потоком /trening (parseCb їх не знає). */
export const PROGRESS_RECENT_CB = "p:r";
export const PROGRESS_BACK_CB = "p:b";

export const progressKeyboard = (): InlineKeyboard => new InlineKeyboard().text(PROGRESS_RECENT_BTN, PROGRESS_RECENT_CB);
export const recentKeyboard = (): InlineKeyboard => new InlineKeyboard().text(PROGRESS_BACK_BTN, PROGRESS_BACK_CB);

/** Локальна дата `ДД.ММ`; невідомий пояс → Київ. */
function shortDate(ms: number, tz: string): string {
  let d: string;
  try {
    d = localDate(ms, tz);
  } catch {
    d = localDate(ms, DEFAULT_TZ);
  }
  return `${d.slice(8)}.${d.slice(5, 7)}`;
}

export interface WeightInput {
  /** Вага з анкети, кг (30–300); null — немає. */
  profileKg: number | null;
  /** Записи за 21 день (W2…W0). */
  recent: readonly WeightEntry[];
  first: WeightEntry | null;
  last: WeightEntry | null;
  today: string;
}

/** Модель блоку ваги: вікна W0/W1/W2 — ті самі, що в «Тиждень до тижня» (розділ 2 спеки). */
export function weightModel(i: WeightInput): WeightBlockModel {
  const w0 = avg7(i.recent, i.today);
  const w1 = avg7(i.recent, addDays(i.today, -7));
  const w2 = avg7(i.recent, addDays(i.today, -14));
  const startDg = i.profileKg !== null ? Math.round(i.profileKg * 10) : null;

  let start: WeightBlockModel["start"] = null;
  if (startDg !== null) start = { kg: formatKg(startDg), label: WEIGHT_LABEL_PROFILE };
  else if (i.first && i.last && i.first.localDate !== i.last.localDate) start = { kg: formatKg(i.first.weightDg), label: weightLabelFirst(`${i.first.localDate.slice(8)}.${i.first.localDate.slice(5, 7)}`) };

  let nowDg: number | null = null;
  let now: WeightBlockModel["now"] = null;
  if (w0.avgDg !== null) {
    nowDg = w0.avgDg;
    now = { kg: formatKg(w0.avgDg), label: weightLabelAvg(w0.n) };
  } else if (i.last) {
    nowDg = i.last.weightDg;
    now = { kg: formatKg(i.last.weightDg), label: weightLabelLast(`${i.last.localDate.slice(8)}.${i.last.localDate.slice(5, 7)}`) };
  }
  const startForTotal = start ? (startDg ?? i.first!.weightDg) : null;
  const wc = weekChange(i.recent, i.today);
  return {
    start,
    now,
    total: startForTotal !== null && nowDg !== null ? formatChange(nowDg - startForTotal) : null,
    weekChange: wc === null ? null : formatChange(wc),
    windows: [w2, w1, w0].filter((w) => w.avgDg !== null).map((w) => formatKg(w.avgDg!)),
  };
}

/** Повний екран /progres. Не влізло в 4096 — відкидаються вправи з найстарішою останньою сесією (N6). Немає даних — PROGRESS_EMPTY. */
export function fullProgressText(exercises: readonly ExerciseProgress[], weight: WeightBlockModel, tz: string): string {
  const w = weightBlock(weight);
  if (exercises.length === 0 && w === "") return PROGRESS_EMPTY;
  const blocks = exercises.map((e) =>
    exerciseBlock({
      name: e.nameUk,
      bodyweight: e.bodyweight,
      units: e.units,
      start: e.start,
      now: e.now,
      record: { ...e.record, date: shortDate(e.record.at, tz) },
      e1rm: e.e1rm,
    }),
  );
  const join = (b: readonly string[]): string => [PROGRESS_FULL_TITLE, ...(w ? [w] : []), ...b].join("\n");
  while (blocks.length > 1 && join(blocks).length > TELEGRAM_TEXT_MAX) blocks.pop();
  return clip(join(blocks));
}
