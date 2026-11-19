// Кроки 2 і 4 порядку обробки (phase-0.md): чисті функції, без БД і без Telegram API.
import type { Update } from "grammy/types";

const encoder = new TextEncoder();

/** Порівняння за сталий час. Порожній чи не заданий секрет у env — доступу немає нікому. */
export function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!expected || given === null) return false;
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength) {
    // Однаковий час незалежно від довжини: порівнюємо a саме з собою й відкидаємо результат.
    return !crypto.subtle.timingSafeEqual(a, a);
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

/** "111, 222" → {"111","222"}. Порожній чи не заданий список — порожня множина (fail closed). */
export function parseAllowedIds(raw: string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (/^\d+$/.test(id)) ids.add(id);
  }
  return ids;
}

/** ID відправника, лише якщо апдейт — message чи callback_query з приватного чату. */
export function privateSenderId(update: Update): number | undefined {
  if (update.message) {
    return update.message.chat.type === "private" ? update.message.from?.id : undefined;
  }
  if (update.callback_query) {
    return update.callback_query.message?.chat.type === "private" ? update.callback_query.from.id : undefined;
  }
  return undefined;
}

export function isAllowed(senderId: number | undefined, allowed: Set<string>): boolean {
  return senderId !== undefined && allowed.has(String(senderId));
}
