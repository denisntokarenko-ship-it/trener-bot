// Чат ШІ-тренера: маршрутизація тексту (крок 5), конвеєр ходу, картки пропозицій і кнопки `i:y|n:<id>`
// (docs/spec/phase-4-chat.md, розділи 2–3; docs/spec/phase-4.md, розділ 3). ШІ лише читає й пропонує: запис робить applyProposal після кнопки.
import Anthropic from "@anthropic-ai/sdk";
import type { Api, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { runChatLoop, type LoopResult, type ProposalRef } from "../ai/chat-loop";
import { chatStateLine, promisesConfirmation } from "../ai/chat-state";
import { chatUserMessage } from "../ai/prompts";
import { proposalSummary } from "../ai/proposals";
import { classifyAiError, type AiFailure } from "../ai/food-prompt";
import {
  AI_DAILY_LIMIT_MICRO,
  CHAT_CALL_EST_MICRO,
  CHAT_HISTORY_MAX_AGE_MS,
  CHAT_INFLIGHT_MS,
  CHAT_INPUT_MAX_CHARS,
  CHAT_MODEL,
  CHAT_REPLY_MAX_CHARS,
  TELEGRAM_TEXT_MAX,
} from "../config";
import type { ApplyOutcome, ProposalView, Repo } from "../db/repo";
import { isoWeekday, localDate } from "../domain/time";
import { unitsOf } from "../domain/units";
import { prescribeSlot } from "./prescribe";
import {
  CHAT_BUSY,
  CHAT_BUSY_PREVIOUS,
  CHAT_CONFIRM_LINE,
  CHAT_CUT,
  CHAT_EMPTY,
  CHAT_INVALID,
  CHAT_ITERATIONS,
  CHAT_LIMIT,
  CHAT_NO_KEY,
  CHAT_NO_PROPOSAL_NOTE,
  CHAT_REFUSAL,
  CHAT_TIMEOUT,
  CHAT_TOO_LONG,
  CHAT_UNAVAILABLE,
  PROPOSAL_ALREADY_APPLIED,
  PROPOSAL_ALREADY_REJECTED,
  PROPOSAL_APPLIED,
  PROPOSAL_BTN_NO,
  PROPOSAL_BTN_YES,
  PROPOSAL_BUSY,
  PROPOSAL_DUPLICATE,
  PROPOSAL_EXPIRED,
  PROPOSAL_GONE,
  PROPOSAL_NEW_EXERCISE,
  PROPOSAL_REJECTED,
  PROPOSAL_STALE,
  PROPOSAL_TARGET_TODAY,
  SOMETHING_WRONG,
  esc,
  prescriptionText,
  proposalCardText,
  proposalDecidedText,
  proposalWeightsLine,
} from "./texts";

const DEFAULT_TZ = "Europe/Kyiv";

/** `i:y:<id>` — застосувати, `i:n:<id>` — відхилити. Префікс `i:` вільний (о:, s:, p:, m:, n:, f: і літери потоку тренування зайняті). */
const PROPOSAL_CB = /^i:([yn]):(\d{1,10})$/;
export const isProposalCb = (data: string): boolean => PROPOSAL_CB.test(data);
export const proposalCb = (action: "y" | "n", id: number): string => `i:${action}:${id}`;

/** Голе число: у чат не йде (лишається підказка /vaga). */
const BARE_NUMBER = /^\d+([.,]\d+)?$/;

const FAIL_TEXT: Record<AiFailure, string> = { busy: CHAT_BUSY, unavailable: CHAT_UNAVAILABLE, invalid: CHAT_INVALID };

const OUTCOME_TOAST: Partial<Record<ApplyOutcome, string>> = {
  already: PROPOSAL_ALREADY_APPLIED,
  rejected: PROPOSAL_ALREADY_REJECTED,
  expired: PROPOSAL_EXPIRED,
  busy: PROPOSAL_BUSY,
  target_today: PROPOSAL_TARGET_TODAY,
  duplicate: PROPOSAL_DUPLICATE,
  stale: PROPOSAL_STALE,
  missing: PROPOSAL_GONE,
};
/** Тимчасові відмови: пропозиція лишається `pending`, кнопки лишаються. */
const TEMPORARY: ReadonlySet<ApplyOutcome> = new Set(["busy", "target_today"]);

type GrammySignal = NonNullable<Parameters<Api["sendChatAction"]>[3]>;
const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export interface ChatDeps {
  apiKey: string | undefined;
  /** fetch для SDK Anthropic (тести підставляють фейк); undefined — глобальний. */
  anthropicFetch?: typeof fetch;
  waitUntil: (p: Promise<unknown>) => void;
  timeoutMs: number;
}

interface ChatJob {
  userId: number;
  chatId: number;
  text: string;
}

const clip = (s: string, max: number): string => Array.from(s).slice(0, max).join("");

/**
 * Текст відповіді користувачу: сирий текст моделі → обрізати → `esc` → разом зі статичними рядками ≤ 4096 (`esc` розтягує `&` до 5×;
 * обрізання ПІСЛЯ `esc` могло б розрізати сутність `&am` → Telegram «can't parse entities»), інакше обрізати сирий текст і повторити.
 */
export function chatReplyText(raw: string, cut: boolean, confirm: boolean, noProposal = false): string {
  const tail = [...(cut ? [CHAT_CUT] : []), ...(confirm ? [CHAT_CONFIRM_LINE] : []), ...(noProposal ? [CHAT_NO_PROPOSAL_NOTE] : [])];
  let body = clip(raw, CHAT_REPLY_MAX_CHARS);
  for (;;) {
    const text = [...(body ? [esc(body)] : []), ...tail].join("\n\n");
    if (text.length <= TELEGRAM_TEXT_MAX || body === "") return text;
    body = clip(body, Math.floor(Array.from(body).length * 0.9));
  }
}

export function createChatFlow(repo: Repo, now: () => number, deps: ChatDeps) {
  /** «Наступне призначення: було … → стане …» — два виклики `prescribeSlot` (поточний і гіпотетичний слот), без запису. */
  async function weightsLine(userId: number, p: ProposalView): Promise<string | null> {
    const peId = p.payload.program_exercise_id;
    if (typeof peId !== "number") return null;
    const own = await repo.getOwnSlot(userId, peId);
    const day = own ? await repo.getProgramDay(userId, own.dayCode) : null;
    const slot = day?.slots.find((s) => s.id === peId);
    const { sets, rep_min: repMin, rep_max: repMax } = p.payload;
    if (!slot || typeof sets !== "number" || typeof repMin !== "number" || typeof repMax !== "number") return null;
    const bodyweight = slot.exercise.equipment === "bodyweight";
    const was = await prescribeSlot(repo, userId, slot.exercise, slot);
    const will = await prescribeSlot(repo, userId, slot.exercise, { ...slot, sets, repMin, repMax });
    const units = unitsOf(slot.exercise);
    return proposalWeightsLine(prescriptionText(was, bodyweight, units), prescriptionText(will, bodyweight, units));
  }

  async function sendCard(api: Api, job: ChatJob, id: number): Promise<void> {
    const p = await repo.getProposal(job.userId, id);
    if (!p || p.status !== "pending") return;
    const extra = p.kind === "change_sets_reps" ? await weightsLine(job.userId, p) : p.kind === "swap_exercise" ? PROPOSAL_NEW_EXERCISE : null;
    const kb = new InlineKeyboard().text(PROPOSAL_BTN_YES, proposalCb("y", id)).text(PROPOSAL_BTN_NO, proposalCb("n", id));
    const msg = await api.sendMessage(job.chatId, proposalCardText(proposalSummary(p.kind, p.payload), p.reason, extra), { reply_markup: kb });
    await repo.setProposalMessageId(job.userId, id, msg.message_id);
  }

  async function turn(api: Api, job: ChatJob): Promise<void> {
    const say = async (text: string) => void (await api.sendMessage(job.chatId, text));
    const tz = (await repo.getUserTz(job.userId)) ?? DEFAULT_TZ;
    const t0 = now();
    const today = localDate(t0, tz);
    // Крок 2: одне атомарне резервування (ліміт + взаємовиключність ходів); немає місця — клієнт Anthropic не створюється.
    const usageId = await repo.reserveAiUsage(
      job.userId,
      { model: CHAT_MODEL, purpose: "chat", localDate: today, estMicro: CHAT_CALL_EST_MICRO, limitMicro: AI_DAILY_LIMIT_MICRO, exclusiveWithinMs: CHAT_INFLIGHT_MS },
      t0,
    );
    if (usageId === null) return say((await repo.chatInFlight(job.userId, t0)) ? CHAT_BUSY_PREVIOUS : CHAT_LIMIT);

    // Крок 3: один дедлайн на весь цикл.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs);
    let result: LoopResult;
    let open: ProposalView[];
    let stateLine: string;
    try {
      try {
        await api.sendChatAction(job.chatId, "typing", undefined, ac.signal as unknown as GrammySignal);
      } catch {
        // «друкує…» — лише зручність
      }
      const history = await repo.getChatTurns(job.userId, now());
      // Рішення кнопкою мусять бути в контексті наступного ходу: модель інакше бере стан зі своїх старих відповідей в історії (preview 4.2, Д-Б).
      open = (await repo.listProposalsForChat(job.userId, now(), CHAT_HISTORY_MAX_AGE_MS)).filter((p) => p.status === "pending");
      stateLine = chatStateLine(await repo.listProposalsForChat(job.userId, now(), CHAT_HISTORY_MAX_AGE_MS));
      const client = new Anthropic({ apiKey: deps.apiKey, maxRetries: 0, fetch: deps.anthropicFetch });
      result = await runChatLoop({
        client,
        history,
        userMessage: chatUserMessage(job.text, today, isoWeekday(today), stateLine),
        tool: { repo, userId: job.userId, tz, now: t0 },
        signal: ac.signal,
      });
    } catch (e) {
      // Збій до першого запиту (напр. читання історії): жодного запиту не було — резервування знято.
      await repo.releaseAiUsage(job.userId, usageId);
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const u = result.usage;
    const createdIds = result.proposals.filter((p) => p.created).map((p) => p.id);
    // Пропозиції ходу, що не дійшов до відповіді, гасимо: без кнопок вони б 48 год блокували предмет.
    const dropCreated = () => repo.expireOwnProposals(job.userId, createdIds, now());
    // settleAiUsage — сумою всіх запитів, навіть якщо далі збій розбору; оплачена ітерація не зникає з aiSpendToday.
    // Збій розрахунку не губить уже оплачену відповідь: лише лог (оцінка в ai_usage лишається), далі — відправка.
    const settle = async (): Promise<void> => {
      try {
        await repo.settleAiUsage(job.userId, usageId, { inputTokens: Math.max(1, u.inputTokens), outputTokens: u.outputTokens, costMicro: u.costMicro });
      } catch (e) {
        console.error("chat settle failed", { error: errorName(e) });
      }
    };

    if (result.kind === "failed") {
      const e = result.error;
      const deadline = ac.signal.aborted;
      const f = deadline ? null : classifyAiError(e);
      if (u.responses > 0) await settle();
      else if (deadline ? u.requests === 0 : f ? f.refund : u.requests === 0) await repo.releaseAiUsage(job.userId, usageId);
      // (обрив/таймаут на першому запиті після відправки — оцінка лишається)
      await dropCreated();
      if (deadline) return say(CHAT_TIMEOUT);
      if (!f) throw e;
      console.error(f.kind === "unavailable" ? "anthropic unavailable" : "anthropic call failed", { status: f.status, error: errorName(e) });
      return say(FAIL_TEXT[f.kind]);
    }

    await settle();
    const { reason, text } = result;
    if (reason === "refusal" || reason === "iterations") {
      await dropCreated();
      return say(reason === "refusal" ? CHAT_REFUSAL : CHAT_ITERATIONS);
    }
    const cut = reason === "max_tokens";
    // Порожня відповідь без пропозицій: гасити нічого (пропозицій немає). З пропозиціями порожній текст не дає CHAT_EMPTY — картки важливіші.
    if (text === "" && result.proposals.length === 0) return say(CHAT_EMPTY);
    // Крок 6: спершу відправка відповіді й карток, потім chat_turns (збій запису історії не скасовує оплачену відповідь).
    // Д-А: модель пообіцяла кнопку, а пропозиції (ні нової, ні відкритої) немає — код дописує правду, а не лишає обіцянку без картки.
    const brokenPromise = result.proposals.length === 0 && open.length === 0 && promisesConfirmation(text);
    await say(chatReplyText(text, cut, result.proposals.length > 0, brokenPromise));
    const cards: ProposalRef[] = result.proposals.filter((p) => p.created || p.messageId === null);
    for (const c of cards) {
      try {
        await sendCard(api, job, c.id);
      } catch (e) {
        console.error("proposal card failed", { error: errorName(e) });
      }
    }
    try {
      await repo.addChatTurns(job.userId, job.text, text, now());
    } catch (e) {
      console.error("chat turns failed", { error: errorName(e) });
    }
  }

  async function finishDecided(ctx: Context, mark: string, p: ProposalView): Promise<void> {
    try {
      await ctx.editMessageText(proposalDecidedText(mark, proposalSummary(p.kind, p.payload)));
    } catch {
      // повідомлення вже не редагується — рішення записано
    }
  }

  return {
    /**
     * Крок 5 маршрутизації: текст → чат. false — не чат (команда, голе число, порожній): далі «Не зрозумів». Робота ШІ — у waitUntil (N2).
     */
    async text(ctx: Context): Promise<boolean> {
      const raw = (ctx.message?.text ?? "").trim();
      if (raw === "" || BARE_NUMBER.test(raw) || raw.startsWith("/") || ctx.message?.entities?.some((e) => e.type === "bot_command" && e.offset === 0)) return false;
      if (!deps.apiKey) {
        console.warn("chat: ANTHROPIC_API_KEY is not set");
        await ctx.reply(CHAT_NO_KEY);
        return true;
      }
      if (Array.from(raw).length > CHAT_INPUT_MAX_CHARS) {
        await ctx.reply(CHAT_TOO_LONG);
        return true;
      }
      const job: ChatJob = { userId: ctx.from!.id, chatId: ctx.chat!.id, text: raw };
      const api = ctx.api;
      deps.waitUntil(
        turn(api, job).catch(async (e: unknown) => {
          console.error("chat failed", { error: errorName(e) });
          try {
            await api.sendMessage(job.chatId, SOMETHING_WRONG);
          } catch {
            // відправка неможлива — лишається лог
          }
        }),
      );
      return true;
    },

    /** `i:y:<id>` → applyProposal; `i:n:<id>` → rejectProposal. Застосовує лише код, лише з кнопки. */
    async callback(ctx: Context): Promise<void> {
      const m = PROPOSAL_CB.exec(ctx.callbackQuery?.data ?? "");
      if (!m) return void (await ctx.answerCallbackQuery());
      const id = Number(m[2]);
      const userId = ctx.from!.id;
      const p = await repo.getProposal(userId, id);
      if (!p) return void (await ctx.answerCallbackQuery({ text: PROPOSAL_GONE }));

      if (m[1] === "n") {
        if (await repo.rejectProposal(userId, id, now())) {
          await ctx.answerCallbackQuery();
          return finishDecided(ctx, PROPOSAL_REJECTED, p);
        }
        const cur = await repo.getProposal(userId, id);
        await ctx.answerCallbackQuery({ text: cur?.status === "accepted" ? PROPOSAL_ALREADY_APPLIED : cur?.status === "rejected" ? PROPOSAL_ALREADY_REJECTED : PROPOSAL_EXPIRED });
        return;
      }

      const tz = (await repo.getUserTz(userId)) ?? DEFAULT_TZ;
      const t = now();
      const r = await repo.applyProposal(userId, id, t, localDate(t, tz));
      if (r.outcome === "applied") {
        await ctx.answerCallbackQuery();
        return finishDecided(ctx, PROPOSAL_APPLIED, p);
      }
      await ctx.answerCallbackQuery({ text: OUTCOME_TOAST[r.outcome] ?? PROPOSAL_STALE });
      // Постійна відмова — кнопки знімаються (пропозиція вже не застосується); тимчасова — лишаються.
      if (!TEMPORARY.has(r.outcome) && r.outcome !== "missing") {
        const mark = r.outcome === "already" ? PROPOSAL_APPLIED : r.outcome === "rejected" ? PROPOSAL_REJECTED : PROPOSAL_EXPIRED;
        await finishDecided(ctx, mark, p);
      }
    },
  };
}
