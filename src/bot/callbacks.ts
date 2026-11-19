// callback_data кнопок потоку /trening (phase-1-flow.md, «callback_data»): поля через «:», лише ASCII, ≤ 64 байти.
// Чиста функція без I/O: кодер і розбірник — одне місце, де живе формат.

export type Action = "s" | "a" | "v" | "c" | "x" | "y" | "k" | "t" | "f";

/**
 * w — workout_id, p — program_exercise_id, e — exercise_id, n — set_no, r — повтори на кнопці,
 * g — вага в десятих кг, t — показ техніки (0/1), q — оцінка 1–5 (спека називає її score).
 */
export type Field = "w" | "p" | "e" | "n" | "r" | "g" | "t" | "q";

export type Cb = { a: Action } & Record<Field, number>;

const FIELDS: Record<Action, readonly Field[]> = {
  s: ["w", "p", "e", "n", "r", "g"],
  a: ["w", "p", "e", "n", "r", "g"],
  v: ["w", "p", "e", "n", "r"],
  c: ["w"],
  x: ["w", "p", "e", "n", "r", "g"],
  y: ["w", "p", "e"],
  k: ["w", "p", "e", "n"],
  t: ["w", "p", "e", "n", "r", "g", "t"],
  f: ["w", "q"],
};

export const CALLBACK_DATA_MAX_BYTES = 64;
export const MAX_REPS = 50;
export const MAX_WEIGHT_KG = 500;

/** Допустимий діапазон поля; id — додатні (0 у БД не існує). */
function inRange(f: Field, v: number): boolean {
  switch (f) {
    case "w":
    case "p":
    case "e":
      return v >= 1;
    case "n":
      return v >= 1 && v <= 10;
    case "r":
      return v >= 0 && v <= MAX_REPS;
    case "g":
      return v >= 0 && v <= MAX_WEIGHT_KG * 10;
    case "t":
      return v === 0 || v === 1;
    case "q":
      return v >= 1 && v <= 5;
  }
}

/** Рядок для callback_data. Кидає, якщо більше 64 байтів (Telegram відхилив би весь екран). */
export function encodeCb(a: Action, fields: Partial<Record<Field, number>>): string {
  const parts: string[] = [a];
  for (const f of FIELDS[a]) {
    const v = fields[f];
    if (v === undefined || !Number.isSafeInteger(v) || v < 0) throw new RangeError(`callback ${a}: поле ${f}`);
    parts.push(String(v));
  }
  const data = parts.join(":");
  if (new TextEncoder().encode(data).byteLength > CALLBACK_DATA_MAX_BYTES) {
    throw new RangeError(`callback_data довше за ${CALLBACK_DATA_MAX_BYTES} байтів`);
  }
  return data;
}

/** Розбір; битий формат, чужа дія чи число поза діапазоном — null («Кнопка застаріла»). */
export function parseCb(data: string): Cb | null {
  const parts = data.split(":");
  const a = parts[0] as Action;
  if (!Object.hasOwn(FIELDS, a)) return null;
  const names = FIELDS[a];
  if (parts.length !== names.length + 1) return null;
  const out = { a, w: 0, p: 0, e: 0, n: 0, r: 0, g: 0, t: 0, q: 0 } satisfies Cb;
  for (const [i, f] of names.entries()) {
    const raw = parts[i + 1]!;
    if (!/^\d{1,10}$/.test(raw)) return null;
    const v = Number(raw);
    if (!inRange(f, v)) return null;
    out[f] = v;
  }
  return out;
}
