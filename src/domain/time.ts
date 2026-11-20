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
