// Недільний коментар ШІ до звіту (docs/spec/phase-4-chat.md, розділ 4). Один виклик CHAT_MODEL без інструментів, лише числа, пораховані кодом.
// Будь-яка відмова (немає ключа, ліміт, помилка, дедлайн, refusal, max_tokens без тексту, провал перевірки чисел) → null: звіт іде без коментаря.
import Anthropic from "@anthropic-ai/sdk";
import { AI_DAILY_LIMIT_MICRO, CHAT_MODEL, WEEKLY_COMMENT_EST_MICRO, WEEKLY_COMMENT_MAX_CHARS, WEEKLY_COMMENT_MAX_TOKENS } from "../config";
import type { Repo } from "../db/repo";
import { weekRangeLabel, type WeeklyReportTextModel } from "../bot/texts";
import { chatRequestCost } from "./chat-loop";
import { WEEKLY_SYSTEM } from "./prompts";

/** Число: цифри з необов'язковими групами тисяч (звичайний, нерозривний, вузький нерозривний пробіл) і дробовою частиною. */
const NUMBER = /\d+(?:[\u0020\u00A0\u202F]\d{3})*(?:[.,]\d+)?/g;
/** Нормалізація: без пробілів тисяч, кома → крапка. Знак (в т.ч. «−» U+2212) у число не входить — при порівнянні ігнорується. */
const normalize = (m: string): string => m.replace(/[\u0020\u00A0\u202F]/g, "").replace(",", ".");

/** Усі числа тексту в нормалізованому вигляді (теги HTML знімаються: рахується те, що бачить людина). */
export function numbersIn(text: string): Set<string> {
  return new Set([...text.replace(/<[^>]*>/g, "").matchAll(NUMBER)].map((m) => normalize(m[0])));
}

/**
 * Перевірка коментаря: непорожній, ≤ `WEEKLY_COMMENT_MAX_CHARS`, кожне число — серед чисел самого звіту (відрендереного тексту);
 * дозволені також цілі 0–10 без `%` («2 рази», «за 1 тиждень»). Повертає нормалізований текст або null.
 */
export function validateWeeklyComment(raw: string, reportText: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "" || Array.from(text).length > WEEKLY_COMMENT_MAX_CHARS) return null;
  const allowed = numbersIn(reportText);
  for (const m of text.matchAll(NUMBER)) {
    const value = normalize(m[0]);
    if (allowed.has(value)) continue;
    const small = /^\d+$/.test(value) && Number(value) <= 10;
    const percent = text.slice((m.index ?? 0) + m[0].length).trimStart().startsWith("%");
    if (small && !percent) continue;
    return null;
  }
  return text;
}

/** Вхід моделі: лише поля звіту, форматовані так само, як у самому звіті (тож числа збігаються). */
export function weeklyCommentInput(m: WeeklyReportTextModel): string {
  return JSON.stringify({
    week: weekRangeLabel(m.weekStart, m.weekEnd),
    workouts_done: m.workouts,
    workouts_planned: m.planned,
    sets: m.sets,
    volume_kg: m.volumeKg,
    new_records: m.records.map((r) => r.replace(/<[^>]*>/g, "")), // готові рядки звіту без HTML-тегів
    average_weight: m.weight ? { kg: m.weight.avg, entries: m.weight.n, change_vs_last_week: m.weight.change } : null,
    next_workout: m.next,
  });
}

export interface WeeklyCommentDeps {
  repo: Repo;
  apiKey: string | undefined;
  /** fetch для SDK Anthropic (тести підставляють фейк). */
  anthropicFetch?: typeof fetch;
  timeoutMs: number;
  now: number;
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** Коментар до звіту або null. Не кидає: будь-яка помилка → null. `reportText` — відрендерований звіт БЕЗ коментаря. */
export async function generateWeeklyComment(d: WeeklyCommentDeps, userId: number, date: string, model: WeeklyReportTextModel, reportText: string): Promise<string | null> {
  if (!d.apiKey) return null;
  let usageId: number | null;
  try {
    usageId = await d.repo.reserveAiUsage(userId, { model: CHAT_MODEL, purpose: "weekly_comment", localDate: date, estMicro: WEEKLY_COMMENT_EST_MICRO, limitMicro: AI_DAILY_LIMIT_MICRO }, d.now);
  } catch (e) {
    console.error("weekly comment reserve failed", { error: errorName(e) });
    return null;
  }
  if (usageId === null) return null; // ліміт: звіт без коментаря
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), d.timeoutMs);
  let sent = false;
  try {
    const client = new Anthropic({ apiKey: d.apiKey, maxRetries: 0, fetch: d.anthropicFetch });
    sent = true;
    const res = await client.messages.create(
      { model: CHAT_MODEL, max_tokens: WEEKLY_COMMENT_MAX_TOKENS, output_config: { effort: "low" }, system: WEEKLY_SYSTEM, messages: [{ role: "user", content: weeklyCommentInput(model) }] },
      { signal: ac.signal },
    );
    // Відповідь 200 — облік фактичною ціною завжди, навіть якщо далі коментар відкинуто.
    await d.repo.settleAiUsage(userId, usageId, { inputTokens: Math.max(1, res.usage.input_tokens), outputTokens: res.usage.output_tokens, costMicro: chatRequestCost(res.usage) });
    if (res.stop_reason === "refusal") return null;
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    const ok = validateWeeklyComment(text, reportText);
    if (ok === null) console.warn("weekly comment rejected", { stop_reason: res.stop_reason });
    return ok;
  } catch (e) {
    // До відправки запиту — резервування знято; після (обрив, дедлайн, HTTP-помилка) — оцінка лишається (спека).
    if (!sent) await d.repo.releaseAiUsage(userId, usageId).catch(() => undefined);
    console.warn("weekly comment failed", { error: errorName(e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
