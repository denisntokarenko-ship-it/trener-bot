// Тексти /progres і /prohrama — чисті функції (phase-1-flow.md, P2.5).
import type { ProgramDay, WorkoutSummaryRow } from "../db/repo";
import { TELEGRAM_TEXT_MAX, clip, dayName, fmtKg } from "./workout-view";

export const NO_WORKOUTS = "Ще немає тренувань. Почни: /trening";

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

function workoutBlock(w: WorkoutSummaryRow, tz: string): string {
  const head = `${fmtLocalDate(w.startedAt, tz)} · ${dayName({ code: w.dayCode, title: w.dayTitle })} · ${w.status === "done" && w.effort !== null ? `${w.effort}/5` : "не завершене"}`;
  const body = w.exercises.map((e) => `${e.nameUk} ${fmtSets(e.sets)}`).join(" · ");
  return body ? `${head}\n${body}` : head;
}

/** Від нових до старих; не влізло в 4096 — відкидаються найстаріші (P2.5.3). */
export function progressText(workouts: readonly WorkoutSummaryRow[], tz: string): string {
  if (workouts.length === 0) return NO_WORKOUTS;
  const blocks = workouts.map((w) => workoutBlock(w, tz));
  while (blocks.length > 1 && blocks.join("\n\n").length > TELEGRAM_TEXT_MAX) blocks.pop();
  return clip(blocks.join("\n\n"));
}

export interface NextSlotLine {
  nameUk: string;
  bodyweight: boolean;
  weightKg: number;
  targetReps: number;
}

export interface ProgramModel {
  days: ProgramDay[];
  next: { dayName: string; lines: NextSlotLine[] };
  /** Назва дня активного тренування, якщо воно є. */
  activeDayName: string | null;
}

export function programText(m: ProgramModel): string {
  const parts: string[] = [];
  for (const d of m.days) {
    const slots = d.slots.map((s, i) => `${i + 1}. ${s.exercise.nameUk} — ${s.sets} × ${s.repMin}–${s.repMax}`);
    parts.push([dayName(d), ...slots].join("\n"));
  }
  const next = m.next.lines.map((l) => `${l.nameUk} — ${l.bodyweight ? "власна вага" : `${fmtKg(l.weightKg)} кг`} × ${l.targetReps}`);
  parts.push([`➡️ Наступне: ${m.next.dayName}`, ...next].join("\n"));
  if (m.activeDayName) parts.push(`Зараз триває: ${m.activeDayName} — /trening, щоб продовжити`);
  return clip(parts.join("\n\n"));
}
