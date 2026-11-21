// Коли нагадування «має піти» (docs/spec/phase-2.md, розділ 4). Чисті функції: без I/O, без Date.now — час параметром.
import { REMINDER_WINDOW_MIN, REPORT_LOCAL_MINUTES, TREND_LOCAL_MINUTES } from "../config";
import { localParts } from "./time";

export type ReminderKind = "train" | "weigh" | "report" | "trend";

/** Поля `users`, від яких залежить розклад. */
export interface ReminderUser {
  tz: string;
  /** `1,3,5` — ISO-дні через кому. */
  trainingDays: string;
  /** `HH:MM` або null (вимкнено). */
  remindTime: string | null;
  weighTime: string | null;
}

/** `1,3,5` → [1, 3, 5]; порожнє, повтор, не за зростанням, поза 1–7 → null. */
export function parseTrainingDays(raw: string): number[] | null {
  if (raw === "") return null;
  const days = raw.split(",").map((x) => (/^[1-7]$/.test(x) ? Number(x) : NaN));
  if (days.some(Number.isNaN)) return null;
  for (let i = 1; i < days.length; i++) if (days[i]! <= days[i - 1]!) return null;
  return days;
}

/** `08:15` → 495 хв; кратність 15 хв і діапазон 05:00–22:00 — як у CHECK міграції; інакше null. */
export function parseReminderTime(raw: string | null): number | null {
  if (raw === null) return null;
  const m = /^([0-2]\d):([0-5]\d)$/.exec(raw);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes % 15 === 0 && minutes >= 5 * 60 && minutes <= 22 * 60 ? minutes : null;
}

/** Поточна хвилина всередині вікна `T … T+59`. */
const inWindow = (minutes: number, t: number): boolean => minutes - t >= 0 && minutes - t < REMINDER_WINDOW_MIN;

/**
 * Які нагадування належать до цього моменту (лише за розкладом: умови даних — «тренування вже було», «вага вже є» —
 * перевіряє виконавець). Час — локальний через Intl, не «T у UTC». Невалідний `tz` → RangeError.
 * Заявка в `reminders_sent` на локальну дату — окремо, у репо.
 */
export function dueReminders(user: ReminderUser, nowUtcMs: number): ReminderKind[] {
  const { minutes, isoWeekday } = localParts(nowUtcMs, user.tz);
  const out: ReminderKind[] = [];
  const weigh = parseReminderTime(user.weighTime);
  if (weigh !== null && inWindow(minutes, weigh)) out.push("weigh");
  const train = parseReminderTime(user.remindTime);
  if (train !== null && inWindow(minutes, train) && (parseTrainingDays(user.trainingDays) ?? []).includes(isoWeekday)) out.push("train");
  // Звіт: Нд з 19:00 до кінця локальної доби — пізній звіт кращий за жоден.
  if (isoWeekday === 7 && minutes >= REPORT_LOCAL_MINUTES) out.push("report");
  // Оцінка тренду норми (Фаза 3): вікно [09:00, 10:00); чи є норма й що казати — перевіряє виконавець.
  if (inWindow(minutes, TREND_LOCAL_MINUTES)) out.push("trend");
  return out;
}
