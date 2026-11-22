// Порядок обробки запиту — phase-0.md, «Порядок обробки запиту». Кроки 1–4 не пишуть у БД і не кличуть Telegram.
import { BotError, webhookCallback } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { isAllowed, parseAllowedIds, privateSenderId, secretMatches } from "./access";
import { createBot, replyFailure } from "./bot/bot";
import { createDb } from "./db/client";
import { createRepo } from "./db/repo";
import type { Env } from "./env";

export const WEBHOOK_PATH = "/tg/webhook";
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Крок 6. Отримує розібраний апдейт і сире тіло (для webhookCallback grammY). */
export type UpdateHandler = (update: Update, body: string) => Promise<void>;

const ok = () => new Response(null, { status: 200 });

/** Для логу — лише ім'я помилки; BotError grammY розгортаємо до справжньої причини. */
function errorName(err: unknown): string {
  const cause = err instanceof BotError ? err.error : err;
  return cause instanceof Error ? cause.name : typeof cause;
}

/** Скільки секунд тік крону живе в кеші ізоляту: `/health` публічний, а мінутна точність `cron=Nm` від 30 с не страждає (Д8 рев'ю 2.3). */
export const HEALTH_CACHE_MS = 30_000;
let healthCache: { db: D1Database; at: number; tick: { tickAt: number; okAt: number | null } | null } | undefined;
/** Скидає кеш `/health` (тести: БД між тестами та «годинник» змінюються). */
export function resetHealthCache(): void {
  healthCache = undefined;
}

/**
 * Для `/health`: `cron=7m ok=7m` — вік останнього тіку й останнього тіку без помилок (тік, що впав, «живим» не виглядає).
 * Тіку ще не було чи D1 недоступна — `cron=?`; безпомилкового ще не було — `ok=?`. Health лишається 200.
 * Тік читається з D1 не частіше за раз на `HEALTH_CACHE_MS` на ізолят (кешується сирий момент, вік рахується від поточного `nowMs`);
 * помилку читання не кешуємо — відновлення D1 видно одразу.
 */
async function cronAge(env: Env, nowMs: number): Promise<string> {
  const age = (at: number | null | undefined): string => (at == null ? "?" : `${Math.max(0, Math.floor((nowMs - at) / 60_000))}m`);
  try {
    const c = healthCache;
    let tick: { tickAt: number; okAt: number | null } | null;
    if (c && c.db === env.DB && nowMs >= c.at && nowMs - c.at < HEALTH_CACHE_MS) tick = c.tick;
    else {
      tick = await createRepo(createDb(env.DB)).getCronTick();
      healthCache = { db: env.DB, at: nowMs, tick };
    }
    return `cron=${age(tick?.tickAt)} ok=${age(tick?.okAt)}`;
  } catch {
    return "cron=? ok=?";
  }
}

/**
 * Версія деплою для `/health` (рев'ю 2.5, В1): `v=<8 символів id версії Worker>` з binding `CF_VERSION_METADATA` — id версії, яку Cloudflare
 * справді виконує (збігається з `wrangler versions list`), а не довільне `--message`. Якщо деплой зроблено з `--tag` (напр. git sha) — додається й `tag=`.
 * Binding немає (локально/тести без нього) — порожній рядок: старий формат відповіді не змінюється.
 */
export function versionSuffix(env: Env): string {
  const m = env.CF_VERSION_METADATA;
  if (!m || typeof m.id !== "string" || m.id === "") return "";
  const id = m.id.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 8);
  const tag = typeof m.tag === "string" && /^[\w.-]{1,40}$/.test(m.tag) ? ` tag=${m.tag}` : "";
  return id === "" ? "" : ` v=${id}${tag}`;
}

export async function handleRequest(request: Request, env: Env, handler: UpdateHandler, now: () => number = Date.now): Promise<Response> {
  const { pathname } = new URL(request.url);

  // 1. Метод і шлях.
  if (pathname === "/health") {
    return request.method === "GET" ? new Response(`ok ${await cronAge(env, now())}${versionSuffix(env)}`) : new Response("Not Found", { status: 404 });
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
  return async (_update, body) => {
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
    const callback = webhookCallback(bot, "cloudflare-mod");
    try {
      await callback(
        new Request("https://bot.internal" + WEBHOOK_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    } catch (err) {
      await replyFailure(err);
      throw err; // лог — у handleRequest (крок 6)
    }
    if (!opts.botInfo && bot.isInited()) cachedBotInfo = bot.botInfo;
    await Promise.all(background); // лише без waitUntil; фонові задачі самі ловлять свої помилки
  };
}
