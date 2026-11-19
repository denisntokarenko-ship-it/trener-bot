import { env as workerEnv } from "cloudflare:workers";
import type { Update, UserFromGetMe } from "grammy/types";
import { WEBHOOK_PATH } from "../src/app";
import type { Env } from "../src/env";

export const env: Env = workerEnv;
export const SECRET = "test-secret-0123456789";
export const OWNER = 111;
export const STRANGER = 333;

export const botInfo = {
  id: 999,
  is_bot: true,
  first_name: "Тренер",
  username: "trener_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

export function webhookRequest(body: unknown, secret: string | null = SECRET, method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://example.com" + WEBHOOK_PATH, {
    method,
    headers,
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function textUpdate(
  updateId: number,
  fromId: number,
  text: string,
  opts: { firstName?: string; chatType?: "private" | "group" | "supergroup" } = {},
): Update {
  const firstName = opts.firstName ?? "Денис";
  const chatType = opts.chatType ?? "private";
  const isCommand = text.startsWith("/");
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      from: { id: fromId, is_bot: false, first_name: firstName },
      chat:
        chatType === "private"
          ? { id: fromId, type: "private", first_name: firstName }
          : { id: -100, type: chatType, title: "Група" },
      text,
      entities: isCommand ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined,
    },
  } as Update;
}

export function callbackUpdate(
  updateId: number,
  fromId: number,
  opts: { chatType?: "private" | "group" | "supergroup" } = {},
): Update {
  const chatType = opts.chatType ?? "private";
  return {
    update_id: updateId,
    callback_query: {
      id: "cb" + updateId,
      from: { id: fromId, is_bot: false, first_name: "Хтось" },
      chat_instance: "ci",
      data: "x",
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat:
          chatType === "private"
            ? { id: fromId, type: "private", first_name: "Хтось" }
            : { id: -100, type: chatType, title: "Група" },
        text: "кнопки",
      },
    },
  } as Update;
}

/** Фейковий Bot API: записує виклики методів, на все відповідає ok. */
export function fakeTelegram() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, payload });
    const result = method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" } } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

/** Усі таблиці від дочірніх до батьківських — у такому порядку їх чистить resetDb (FK у D1 увімкнені). */
export const TABLES = [
  "workout_sets",
  "workouts",
  "program_exercises",
  "program_days",
  "programs",
  "exercise_substitutes",
  "exercises",
  "users",
  "processed_updates",
] as const;
export type Table = (typeof TABLES)[number];

export async function count(table: Table): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}
