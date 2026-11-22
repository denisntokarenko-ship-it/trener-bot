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
  "chat_turns",
  "ai_proposals",
  "meal_items",
  "meals",
  "food_aliases",
  "foods",
  "nutrition_targets",
  "ai_usage",
  "reminders_sent",
  "cron_state",
  "body_weights",
  "workout_sets",
  "start_weights",
  "onboarding_state",
  "user_profiles",
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

/**
 * Перевірка тексту за правилами Telegram parse_mode HTML для тегів, що їх вживає бот (b, i, code):
 * теги парні й вкладені правильно, голих `<` `>` немає, `&` лише як `&amp;` `&lt;` `&gt;`; довжина ≤ 4096.
 * Повертає перелік проблем (порожній — текст прийняв би Telegram).
 */
export function htmlProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.length > 4096) problems.push(`довжина ${text.length} > 4096`);
  const stack: string[] = [];
  let rest = text;
  const tag = /<(\/?)(b|i|code)>/;
  for (let m = tag.exec(rest); m; m = tag.exec(rest)) {
    const before = rest.slice(0, m.index);
    if (/[<>]/.test(before)) problems.push(`голий < або > перед тегом: ${JSON.stringify(before.slice(-30))}`);
    if (m[1] === "") stack.push(m[2]!);
    else if (stack.pop() !== m[2]) problems.push(`тег </${m[2]}> не збігся з відкритим`);
    rest = rest.slice(m.index + m[0].length);
  }
  if (/[<>]/.test(rest)) problems.push(`голий < або > у тексті: ${JSON.stringify(rest.slice(0, 40))}`);
  if (stack.length > 0) problems.push(`незакриті теги: ${stack.join(",")}`);
  if (/&(?!amp;|lt;|gt;)/.test(text)) problems.push("голий & (не сутність)");
  return problems;
}

/**
 * Перевірка всіх вихідних викликів фейкового Bot API: кожне sendMessage/editMessageText — із parse_mode HTML
 * і коректною розміткою; тост answerCallbackQuery — без тегів і ≤ 200 символів; кнопки — callback_data ≤ 64 байти.
 */
export function outgoingProblems(calls: readonly { method: string; payload: Record<string, unknown> }[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.method === "sendMessage" || c.method === "editMessageText") {
      if (c.payload.parse_mode !== "HTML") out.push(`${c.method} без parse_mode HTML`);
      for (const p of htmlProblems(String(c.payload.text))) out.push(`${c.method}: ${p}`);
    }
    if (c.method === "answerCallbackQuery" && typeof c.payload.text === "string") {
      if (/[<>]/.test(c.payload.text)) out.push(`тост з тегами: ${c.payload.text}`);
      if (c.payload.text.length > 200) out.push("тост довший за 200");
    }
    const markup = c.payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } | undefined;
    for (const b of markup?.inline_keyboard?.flat() ?? []) {
      if (b.callback_data !== undefined && new TextEncoder().encode(b.callback_data).length > 64) out.push(`callback_data > 64: ${b.callback_data}`);
      if (b.callback_data !== undefined && b.url !== undefined) out.push(`кнопка і з callback_data, і з url: ${b.text}`);
      if ([...b.text].length > 24) out.push(`кнопка довша за 24 символи: ${b.text}`);
    }
  }
  return out;
}

/** Крок сценарію для scriptedTelegram: "ok" — прийняв (message_id 100, 101, …); число — відповідь зі статусом; "throw" — обрив мережі; "hang" — висить до abort. */
export type TelegramStep = "ok" | number | "throw" | "hang";

/** Фейковий Telegram для крону: кроки беруться по черзі, далі — "ok". Записує звернення в формі calls fakeTelegram. */
export function scriptedTelegram(steps: TelegramStep[] = []) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  let nextId = 100;
  const queue = [...steps];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ method: url.slice(url.lastIndexOf("/") + 1), payload: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const step = queue.shift() ?? "ok";
    if (step === "throw") throw new TypeError("network down");
    if (step === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (typeof step === "number") return new Response(JSON.stringify({ ok: false, error_code: step, description: "err" }), { status: step });
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++, date: 0, chat: { id: 1, type: "private" } } }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetch: fetchFn, texts: () => calls.map((c) => String(c.payload.text)) };
}
