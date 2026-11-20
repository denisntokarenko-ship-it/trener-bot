// /progres і /prohrama — чисті функції (phase-1-flow.md, P2.5). Тексти — у texts.ts.
import type { WorkoutSummaryRow } from "../db/repo";
import { NO_WORKOUTS, TELEGRAM_TEXT_MAX, clip, dayName, fmtKg, progressTitle, workoutBlock as renderBlock } from "./texts";

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
