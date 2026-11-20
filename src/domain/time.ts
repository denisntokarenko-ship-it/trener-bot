// Локальна дата: календарна дата моменту UTC у часовому поясі (N4). Чисті функції, без Date.now.

/** `YYYY-MM-DD` моменту `nowUtcMs` у `tz`; враховує літній/зимовий час (Intl). */
export function localDate(nowUtcMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowUtcMs));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Календарна арифметика над `YYYY-MM-DD` (через UTC-північ: переходи часу не заважають). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Локальна дата, хвилини від опівночі й ISO-день тижня (1 = Пн … 7 = Нд) моменту `nowUtcMs` у `tz`. Невалідний `tz` → RangeError (Intl). */
export function localParts(nowUtcMs: number, tz: string): { date: string; minutes: number; isoWeekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const date = `${String(get("year")).padStart(4, "0")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`;
  return { date, minutes: get("hour") * 60 + get("minute"), isoWeekday: isoWeekday(date) };
}

/** ISO-день тижня календарної дати: 1 = Пн … 7 = Нд. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

/** Зсув `tz` відносно UTC (мс) у момент `t`: локальний час, прочитаний як UTC, мінус `t`. */
function tzOffsetMs(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/**
 * UTC мс локальної опівночі `date` у `tz` (доба переходу — 23/25 год, тож не «UTC-північ ± 24 год»).
 * Зсув уточнюється двома ітераціями: `t = UTC-північ − offset(t)`. Немає локальної опівночі (перехід о 00:00) —
 * перший наявний момент цієї дати.
 */
export function localDayStartUtc(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const midnight = Date.UTC(y, m - 1, d);
  let t = midnight - tzOffsetMs(midnight, tz);
  t = midnight - tzOffsetMs(t, tz);
  // Опівночі немає: t потрапив у попередню дату — крок до першої хвилини `date`.
  for (let i = 0; i < 24 * 60 && localDate(t, tz) < date; i++) t += 60_000;
  return t;
}
