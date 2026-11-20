// Чисті текстові функції без I/O (phase-3.md §2).

/** Апострофи, що зникають зовсім: м'ясо = мʼясо = м’ясо = мясо. */
const APOSTROPHES = /['ʼ’‘`´′]/gu;

/**
 * Ключ каталогу продуктів: NFC → нижній регістр → без апострофів → усе, що не літера й не цифра, пробілом → стиснуті пробіли.
 * Порожній результат (`"  "`, `"()"`) — недійсний: `null`. Функція ідемпотентна: normalizeAlias(normalizeAlias(x)) = normalizeAlias(x).
 */
export function normalizeAlias(s: string): string | null {
  const out = s
    .normalize("NFC")
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return out === "" ? null : out;
}
