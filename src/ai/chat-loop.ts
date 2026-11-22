// Ручний цикл tool-use чату (docs/spec/phase-4-chat.md, розділ 3): `client.messages.create` у циклі, не Tool Runner — потрібні одне
// резервування й сумарний облік на всі ітерації, спільний дедлайн, стеля ітерацій і власна обробка помилок інструментів.
// Без `temperature`/`top_p`/prefill/`tool_choice` (на 5.5-моделях це 400); `thinking` не задаємо (Haiku 5.5 мислить адаптивно,
// мислення входить у `max_tokens`). `response.content` додається до `messages` БЕЗ ЗМІН (блоки мислення повертаються незмінними);
// усі `tool_result` однієї відповіді — одним повідомленням `user`. Вміст відповіді читається за `type`, не за позицією.
import type Anthropic from "@anthropic-ai/sdk";
import {
  CHAT_LONG_PRICE_IN_MICRO,
  CHAT_LONG_PRICE_OUT_MICRO,
  CHAT_LONG_PROMPT_TOKENS,
  CHAT_MAX_ITERATIONS,
  CHAT_MAX_TOKENS,
  CHAT_MAX_TOOL_CALLS,
  CHAT_MODEL,
  CHAT_PRICE_IN_MICRO,
  CHAT_PRICE_OUT_MICRO,
} from "../config";
import type { ChatTurn } from "../db/repo";
import { costMicro } from "../domain/meal";
import { CHAT_SYSTEM, chatHistoryUserText } from "./prompts";
import { TOOL_DEFS, runTool, type ToolContext } from "./tools";

/** Вартість одного запиту, мікро-USD: поріг довгого промпту — за промптом саме цього запиту (кеш не використовуємо, але його токени входять у довжину промпту). */
export function chatRequestCost(u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): number {
  const prompt = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const long = prompt > CHAT_LONG_PROMPT_TOKENS;
  return costMicro(u.input_tokens, u.output_tokens, long ? CHAT_LONG_PRICE_IN_MICRO : CHAT_PRICE_IN_MICRO, long ? CHAT_LONG_PRICE_OUT_MICRO : CHAT_PRICE_OUT_MICRO);
}

/** Пропозиція, створена або повернута інструментом `propose_change` за хід. */
export interface ProposalRef {
  id: number;
  /** true — створена цим ходом; false — наявна відкрита (`already_pending`). */
  created: boolean;
  /** Є — картку з кнопками вже надіслано раніше. */
  messageId: number | null;
}

export interface LoopUsage {
  /** Запитів відправлено / відповідей 200 отримано. */
  requests: number;
  responses: number;
  inputTokens: number;
  outputTokens: number;
  costMicro: number;
}

export type LoopResult =
  | { kind: "finished"; reason: "end_turn" | "max_tokens" | "refusal" | "iterations"; text: string; proposals: ProposalRef[]; usage: LoopUsage }
  | { kind: "failed"; error: unknown; proposals: ProposalRef[]; usage: LoopUsage };

export interface LoopInput {
  client: Anthropic;
  /** Історія `chat_turns` (від старих до нових) і поточне повідомлення користувача (з рядком дати). */
  history: readonly ChatTurn[];
  userMessage: string;
  tool: ToolContext;
  signal: AbortSignal;
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export async function runChatLoop(i: LoopInput): Promise<LoopResult> {
  const messages: Anthropic.MessageParam[] = i.history.map((t) => ({ role: t.role, content: t.role === "user" ? chatHistoryUserText(t.text) : t.text }));
  while (messages[0]?.role === "assistant") messages.shift(); // перше повідомлення має бути від користувача
  messages.push({ role: "user", content: i.userMessage });

  const usage: LoopUsage = { requests: 0, responses: 0, inputTokens: 0, outputTokens: 0, costMicro: 0 };
  const proposals = new Map<number, ProposalRef>();
  const list = (): ProposalRef[] => [...proposals.values()];
  let toolCalls = 0;

  try {
    for (let iteration = 1; iteration <= CHAT_MAX_ITERATIONS; iteration++) {
      // Дедлайн уже минув: запиту не буде — це «до першого запиту» (резервування знімається), а не «обрив після відправки».
      if (i.signal.aborted) throw new DOMException("aborted", "AbortError");
      usage.requests++;
      const res = await i.client.messages.create(
        { model: CHAT_MODEL, max_tokens: CHAT_MAX_TOKENS, output_config: { effort: "low" }, system: CHAT_SYSTEM, tools: TOOL_DEFS as unknown as Anthropic.Tool[], messages },
        { signal: i.signal },
      );
      usage.responses++;
      usage.inputTokens += res.usage.input_tokens;
      usage.outputTokens += res.usage.output_tokens;
      usage.costMicro += chatRequestCost(res.usage);

      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (res.stop_reason === "tool_use" && toolUses.length > 0) {
        // Модель ще просить інструмент, а запитів уже немає — відповіді не буде.
        if (iteration === CHAT_MAX_ITERATIONS) return { kind: "finished", reason: "iterations", text: "", proposals: list(), usage };
        messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          // Кожен tool_use мусить отримати tool_result — інакше наступний запит дає 400.
          if (++toolCalls > CHAT_MAX_TOOL_CALLS) {
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: "забагато викликів інструментів за один хід" }) });
            continue;
          }
          try {
            const r = await runTool(i.tool, use.name, use.input);
            // Повторний propose_change на той самий предмет у цьому ж ході повертає `already_pending` (created: false) — прапорець «створено цим ходом» не губимо.
            if (r.proposal) proposals.set(r.proposal.id, { ...r.proposal, created: r.proposal.created || (proposals.get(r.proposal.id)?.created ?? false) });
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: r.isError, content: r.content });
          } catch (e) {
            console.error("chat tool failed", { tool: use.name, error: errorName(e) });
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: "помилка інструмента" }) });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const reason = res.stop_reason === "refusal" ? "refusal" : res.stop_reason === "max_tokens" ? "max_tokens" : "end_turn";
      return { kind: "finished", reason, text, proposals: list(), usage };
    }
    return { kind: "finished", reason: "iterations", text: "", proposals: list(), usage };
  } catch (error) {
    return { kind: "failed", error, proposals: list(), usage };
  }
}
