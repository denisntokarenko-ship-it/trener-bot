// Порядок обробки запиту — phase-0.md, «Порядок обробки запиту». Кроки 1–4 не пишуть у БД і не кличуть Telegram.
import { BotError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { isAllowed, parseAllowedIds, privateSenderId, secretMatches } from "./access";
import { createBot, replyFailure } from "./bot/bot";
import { WEBHOOK_PATH } from "./constants";
import { createDb } from "./db/client";
import { createRepo } from "./db/repo";
import type { Env } from "./env";

export { WEBHOOK_PATH };
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Крок 6. Отримує розібраний апдейт і сире тіло. */
export type UpdateHandler = (update: Update, body: string) => Promise<void>;

const ok = () => new Response(null, { status: 200 });

/** Для логу — лише ім'я помилки; BotError grammY розгортаємо до справжньої причини. */
function errorName(err: unknown): string {
  const cause = err instanceof BotError ? err.error : err;
  return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * Для `/health`: `cron=7m ok=7m` — вік останнього тіку й останнього тіку без помилок (тік, що впав, «живим» не виглядає).
 * Тіку ще не було чи D1 недоступна — `cron=?`; безпомилкового ще не було — `ok=?`. Health лишається 200.
 */
async function cronAge(env: Env, nowMs: number): Promise<string> {
  const age = (at: number | null | undefined): string => (at == null ? "?" : `${Math.max(0, Math.floor((nowMs - at) / 60_000))}m`);
  try {
    const t = await createRepo(createDb(env.DB)).getCronTick();
    return `cron=${age(t?.tickAt)} ok=${age(t?.okAt)}`;
  } catch {
    return "cron=? ok=?";
  }
}

export async function handleRequest(request: Request, env: Env, handler: UpdateHandler, now: () => number = Date.now): Promise<Response> {
  const { pathname } = new URL(request.url);

  // 1. Метод і шлях.
  if (pathname === "/health") {
    return request.method === "GET" ? new Response(`ok ${await cronAge(env, now())}`) : new Response("Not Found", { status: 404 });
  }
  if (pathname !== WEBHOOK_PATH) return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  // 2. Секрет.
  if (!secretMatches(request.headers.get(SECRET_HEADER), env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response(null, { status: 401 });
  }

  // 3. Тіло.
  const body = await request.text();
  let update: Update;
  try {
    update = JSON.parse(body) as Update;
  } catch {
    return ok();
  }
  if (typeof update !== "object" || update === null || !Number.isSafeInteger(update.update_id)) return ok();

  // 4. Відправник: білий список і лише приватний чат. Тіло нестандартної форми ({"message":1}) — як чужий.
  let sender: number | undefined;
  try {
    sender = privateSenderId(update);
  } catch {
    return ok();
  }
  if (!isAllowed(sender, parseAllowedIds(env.ALLOWED_TELEGRAM_IDS))) return ok();

  // 5. Дедуп (at-most-once): рядок лишається, навіть якщо обробник упаде.
  const repo = createRepo(createDb(env.DB));
  if (!(await repo.markUpdateProcessed(update.update_id))) return ok();

  // 6. Обробник.
  try {
    await handler(update, body);
  } catch (err) {
    console.error("update failed", { update_id: update.update_id, error: errorName(err) });
  }
  return ok();
}

// getMe — один раз на ізолят: далі botInfo передається новим Bot без звернення до Telegram.
let cachedBotInfo: UserFromGetMe | undefined;

export function telegramHandler(
  env: Env,
  opts: {
    fetch?: typeof fetch;
    botInfo?: UserFromGetMe;
    now?: () => number;
    /** ctx.waitUntil Worker (N2): робота ШІ після відповіді 200. Немає (тести) — обробник чекає її до кінця. */
    waitUntil?: (p: Promise<unknown>) => void;
    anthropicFetch?: typeof fetch;
    foodTimeoutMs?: number;
    chatTimeoutMs?: number;
  } = {},
): UpdateHandler {
  return async (update) => {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const background: Promise<unknown>[] = [];
    const bot = createBot(env.TELEGRAM_BOT_TOKEN, createRepo(createDb(env.DB)), {
      botInfo: opts.botInfo ?? cachedBotInfo,
      fetch: opts.fetch,
      now: opts.now,
      waitUntil: opts.waitUntil ?? ((p) => void background.push(p)),
      anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
      anthropicFetch: opts.anthropicFetch,
      foodTimeoutMs: opts.foodTimeoutMs,
      chatTimeoutMs: opts.chatTimeoutMs,
    });
    try {
      // Без webhookCallback: апдейт уже розібрано й перевірено в handleRequest (шлях, секрет, білий список, дедуп),
      // тож другий Request і розбір тіла зайві. webhookCallback додавав ще таймаут 10 с, що кидав помилку (і «Щось пішло
      // не так» людині), поки обробник ще працював, — тепер обробник виконується до кінця (ШІ — у waitUntil).
      if (!bot.isInited()) await bot.init();
      await bot.handleUpdate(update);
    } catch (err) {
      await replyFailure(err);
      throw err; // лог — у handleRequest (крок 6)
    }
    if (!opts.botInfo && bot.isInited()) cachedBotInfo = bot.botInfo;
    await Promise.all(background); // лише без waitUntil; фонові задачі самі ловлять свої помилки
  };
}
