// Порядок обробки запиту — phase-0.md, «Порядок обробки запиту». Кроки 1–4 не пишуть у БД і не кличуть Telegram.
import { webhookCallback } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { isAllowed, parseAllowedIds, privateSenderId, secretMatches } from "./access";
import { createBot } from "./bot/bot";
import { createDb } from "./db/client";
import { createRepo } from "./db/repo";
import type { Env } from "./env";

export const WEBHOOK_PATH = "/tg/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Крок 6. Отримує розібраний апдейт і сире тіло (для webhookCallback grammY). */
export type UpdateHandler = (update: Update, body: string) => Promise<void>;

const ok = () => new Response(null, { status: 200 });

export async function handleRequest(request: Request, env: Env, handler: UpdateHandler): Promise<Response> {
  const { pathname } = new URL(request.url);

  // 1. Метод і шлях.
  if (pathname === "/health") {
    return request.method === "GET" ? new Response("ok") : new Response("Not Found", { status: 404 });
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

  // 4. Відправник: білий список і лише приватний чат.
  if (!isAllowed(privateSenderId(update), parseAllowedIds(env.ALLOWED_TELEGRAM_IDS))) return ok();

  // 5. Дедуп (at-most-once): рядок лишається, навіть якщо обробник упаде.
  const repo = createRepo(createDb(env.DB));
  if (!(await repo.markUpdateProcessed(update.update_id))) return ok();

  // 6. Обробник.
  try {
    await handler(update, body);
  } catch (err) {
    console.error("update failed", { update_id: update.update_id, error: err instanceof Error ? err.name : typeof err });
  }
  return ok();
}

// getMe — один раз на ізолят: далі botInfo передається новим Bot без звернення до Telegram.
let cachedBotInfo: UserFromGetMe | undefined;

export function telegramHandler(
  env: Env,
  opts: { fetch?: typeof fetch; botInfo?: UserFromGetMe; now?: () => number } = {},
): UpdateHandler {
  return async (_update, body) => {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const bot = createBot(env.TELEGRAM_BOT_TOKEN, createRepo(createDb(env.DB)), {
      botInfo: opts.botInfo ?? cachedBotInfo,
      fetch: opts.fetch,
      now: opts.now,
    });
    const callback = webhookCallback(bot, "cloudflare-mod");
    await callback(
      new Request("https://bot.internal" + WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    if (!opts.botInfo && bot.isInited()) cachedBotInfo = bot.botInfo;
  };
}
