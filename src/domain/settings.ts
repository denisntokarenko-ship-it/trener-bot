// Налаштування розкладу (docs/spec/phase-2.md, розділ 5). Чисті функції без I/O.
import { parseReminderTime, parseTrainingDays } from "./reminders";

/** Дефолтні дні для N тренувань на тиждень (2–5); поза діапазоном — як для 3. */
const DEFAULT_DAYS: Record<number, string> = { 2: "1,4", 3: "1,3,5", 4: "1,2,4,5", 5: "1,2,3,4,5" };
export const defaultTrainingDays = (n: number): string => DEFAULT_DAYS[n] ?? DEFAULT_DAYS[3]!;

/** Перемикає ISO-день у списку `1,3,5`. Останній день не знімається → null. Невалідний вхід → null. */
export function toggleTrainingDay(raw: string, day: number): string | null {
  const days = parseTrainingDays(raw);
  if (!days || !Number.isInteger(day) || day < 1 || day > 7) return null;
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
  return next.length === 0 ? null : next.join(",");
}

export const TZ_MAX = 40;
const TZ_SHAPE = /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/;

/** Канонічна IANA-зона за ICU рантайму або null. `Etc/*`, офсети й «Mars/Base» відхиляються. */
export function parseTimezone(raw: string): string | null {
  if (raw.length > TZ_MAX || !TZ_SHAPE.test(raw) || /^etc\//i.test(raw)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Час нагадування з callback: година 05–22 і хвилина з {0,15,30,45} → `HH:MM`, інакше null (через ту саму перевірку, що й CHECK). */
export function reminderTimeFrom(h: number, m: number): string | null {
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  const s = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return parseReminderTime(s) === null ? null : s;
}
