// Чисті функції потоку фото їжі (docs/spec/phase-3-photo.md §1): розбір відповіді моделі, введення грамів, округлення КБЖУ, вартість.
// Без I/O і без Date.now; SDK Anthropic тут не імпортується — відповідь приходить структурною формою.
import { normalizeAlias } from "./text";

export type Confidence = "low" | "medium" | "high";

/** Позиція, що пройшла валідацію: значення моделі на 100 г (грами білка/жиру/вуглеводів, не десяті). */
export interface FoodGuess {
  nameUk: string;
  grams: number;
  kcal100: number;
  protein100: number;
  fat100: number;
  carbs100: number;
  confidence: Confidence;
}

export type FoodParse = { kind: "ok"; items: FoodGuess[] } | { kind: "not_food" } | { kind: "invalid" };

/** Мінімум відповіді Messages API, потрібний розбору. */
export interface FoodResponse {
  stop_reason: string | null;
  content: readonly { type: string; text?: string }[];
}

export const FOOD_ITEMS_MAX = 8;
const CONFIDENCE: readonly string[] = ["low", "medium", "high"];

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const within = (v: unknown, lo: number, hi: number): v is number => num(v) && v >= lo && v <= hi;

/** Одна позиція відповіді; будь-яке порушення — null (і весь розбір INVALID). Межі інклюзивні. */
function parseItem(raw: unknown): FoodGuess | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name_uk !== "string") return null;
  const name = r.name_uk.trim();
  const len = [...name].length;
  if (len < 1 || len > 60 || normalizeAlias(name) === null) return null;
  if (!within(r.grams, 5, 2000) || !within(r.kcal_100, 0, 900)) return null;
  const { protein_100: p, fat_100: f, carbs_100: c } = r;
  if (!within(p, 0, 100) || !within(f, 0, 100) || !within(c, 0, 100) || p + f + c > 100.5) return null;
  // Атуотер: ккал мають сходитися з макросами (4 Б + 4 В + 9 Ж) з допуском max(30, 30 %).
  if (Math.abs(r.kcal_100 - (4 * p + 4 * c + 9 * f)) > Math.max(30, 0.3 * r.kcal_100)) return null;
  if (typeof r.confidence !== "string" || !CONFIDENCE.includes(r.confidence)) return null;
  const grams = Math.round(r.grams);
  // Страховка В5 рев'ю 3.3: «сухий/сирий» стан у назві порції ≥ 150 г — ймовірно, ккал сухого продукту на вагу готової страви (завищення ×2–3).
  const confidence = looksDryPortion(name, grams) ? "low" : (r.confidence as Confidence);
  return { nameUk: name, grams, kcal100: r.kcal_100, protein100: p, fat100: f, carbs100: c, confidence };
}

/** Порог порції, з якого «сухий/сирий» у назві вважається підозрілим. */
export const DRY_PORTION_GRAMS = 150;
const DRY_WORD = /(?:^| )(?:сух|сир)(?:ий|а|е|і)(?: |$)/u;

/** Назва каже «сухий/сирий» (не «сир» — сир лишається), а порція велика — так виглядає ціна сухої крупи на тарілці каші. */
export function looksDryPortion(nameUk: string, grams: number): boolean {
  return grams >= DRY_PORTION_GRAMS && DRY_WORD.test(normalizeAlias(nameUk) ?? "");
}

/**
 * Відповідь моделі → позиції / NOT_FOOD / INVALID. `stop_reason` не `end_turn` (max_tokens, refusal) — INVALID;
 * не JSON — INVALID; `not_food` або порожній `items` — NOT_FOOD; 1–8 позицій, кожна валідна, інакше — INVALID усе.
 */
export function parseFoodResponse(res: FoodResponse): FoodParse {
  if (res.stop_reason !== "end_turn") return { kind: "invalid" };
  const text = res.content.find((b) => b.type === "text")?.text;
  if (typeof text !== "string") return { kind: "invalid" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof data !== "object" || data === null) return { kind: "invalid" };
  const d = data as Record<string, unknown>;
  if (typeof d.not_food !== "boolean" || !Array.isArray(d.items)) return { kind: "invalid" };
  if (d.not_food || d.items.length === 0) return { kind: "not_food" };
  if (d.items.length > FOOD_ITEMS_MAX) return { kind: "invalid" };
  const items: FoodGuess[] = [];
  for (const raw of d.items) {
    const it = parseItem(raw);
    if (!it) return { kind: "invalid" };
    items.push(it);
  }
  return { kind: "ok", items };
}

/**
 * Оцінка моделі → рядок каталогу `ai_estimate`: ккал цілі, макроси в десятих грама (× 10, округлено).
 * Сума макросів ≤ 100,5 г проходить валідацію, а каталог тримає ≤ 1000 дг — надлишок знімається з найбільшого.
 */
export function estimateOf(g: FoodGuess): { kcal100: number; protein100Dg: number; fat100Dg: number; carbs100Dg: number } {
  const dg = [g.protein100, g.fat100, g.carbs100].map((x) => Math.round(x * 10));
  const excess = dg[0]! + dg[1]! + dg[2]! - 1000;
  if (excess > 0) {
    const i = dg.indexOf(Math.max(...dg));
    dg[i] = dg[i]! - excess;
  }
  return { kcal100: Math.round(g.kcal100), protein100Dg: dg[0]!, fat100Dg: dg[1]!, carbs100Dg: dg[2]! };
}

export interface Per100 {
  kcal: number;
  proteinDg: number;
  fatDg: number;
  carbsDg: number;
}

/** Значення позиції за правилом знімка `(grams · x_100 + 50) div 100` — та сама формула, що в confirmMeal (SQL). */
export function itemNutrients(grams: number, per100: Per100): Per100 {
  const r = (x: number) => Math.floor((grams * x + 50) / 100);
  return { kcal: r(per100.kcal), proteinDg: r(per100.proteinDg), fatDg: r(per100.fatDg), carbsDg: r(per100.carbsDg) };
}

/** Вартість виклику, мікро-USD: ⌈(input · P_in + output · P_out) / 1 000 000⌉ (ціни — мікро-USD за 1 млн токенів). */
export function costMicro(inputTokens: number, outputTokens: number, priceIn: number, priceOut: number): number {
  return Math.ceil((inputTokens * priceIn + outputTokens * priceOut) / 1_000_000);
}

export type GramsParse = { ok: true; grams: number[] } | { ok: false; reason: "count"; got: number } | { ok: false; reason: "bad" } | { ok: false; reason: "all_zero" };

/**
 * Введення грамів «200 150» для n позицій (за порядком показу). Розділювачі — пробіл, «,», «;», новий рядок;
 * токен `\d{1,4}` з необовʼязковим «г»/«g», значення 0–2000; 0 — вилучити позицію; усі нулі — відмова.
 */
export function parseGrams(text: string, n: number): GramsParse {
  const tokens = text.split(/[\s,;]+/u).filter((t) => t !== "");
  const grams: number[] = [];
  for (const t of tokens) {
    const m = /^(\d{1,4})(?:г|g)?$/iu.exec(t);
    if (!m) return { ok: false, reason: "bad" };
    const v = Number(m[1]);
    if (v > 2000) return { ok: false, reason: "bad" };
    grams.push(v);
  }
  if (grams.length !== n) return { ok: false, reason: "count", got: grams.length };
  if (grams.every((g) => g === 0)) return { ok: false, reason: "all_zero" };
  return { ok: true, grams };
}
