// Логіка scripts/set-webhook.ts без process — тестується з мокнутим fetch (phase-0.md, P2.1).
export const REQUIRED_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "WORKER_URL"] as const;
export const TARGETS = ["preview", "production"] as const;

export interface SetWebhookIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** Повертає код виходу. Ні токен, ні секрет не потрапляють у log/error. */
export async function runSetWebhook(args: string[], io: SetWebhookIo): Promise<number> {
  const target = args[0];
  if (!TARGETS.includes(target as (typeof TARGETS)[number])) {
    io.error("Використання: npm run set-webhook -- preview | production");
    return 1;
  }
  for (const name of REQUIRED_ENV) {
    if (!io.env[name]) {
      io.error(`Не задано змінну середовища ${name}`);
      return 1;
    }
  }
  const token = io.env.TELEGRAM_BOT_TOKEN!;
  const secret = io.env.TELEGRAM_WEBHOOK_SECRET!;
  const redact = (s: string) => s.split(token).join("***").split(secret).join("***");

  let workerUrl: URL;
  try {
    workerUrl = new URL(io.env.WORKER_URL!.replace(/\/+$/, "") + "/tg/webhook");
  } catch {
    io.error("WORKER_URL — не URL");
    return 1;
  }
  if (workerUrl.protocol !== "https:") {
    io.error("WORKER_URL має бути https://");
    return 1;
  }

  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await io.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as TgResponse<T>;
    if (!data.ok || data.result === undefined) throw new Error(`${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  try {
    await call<boolean>("setWebhook", {
      url: workerUrl.toString(),
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      max_connections: 1,
      drop_pending_updates: false,
    });
    const info = await call<{ url: string; pending_update_count: number; last_error_message?: string }>("getWebhookInfo");
    const me = await call<{ username?: string }>("getMe");
    io.log(`Середовище: ${target}`);
    io.log(`Бот: @${me.username ?? "?"}`);
    io.log(`Хост вебхука: ${info.url ? new URL(info.url).host : "(не встановлено)"}`);
    io.log(`pending_update_count: ${info.pending_update_count}`);
    io.log(`last_error_message: ${info.last_error_message ?? "—"}`);
    return 0;
  } catch (err) {
    io.error(redact(`Помилка Telegram API: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
}
