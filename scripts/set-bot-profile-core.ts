// Логіка scripts/set-bot-profile.ts без process — тестується з мокнутим fetch (phase-1b.md, P3.6).
// Меню команд, опис і короткий опис бота; тексти — з src/bot/texts.ts. Ідемпотентно: що вже збігається — не пишемо.
import { BOT_COMMANDS, BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION } from "../src/bot/texts.ts";

export interface SetBotProfileIo {
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

/** Повертає код виходу. Токен не потрапляє в log/error. */
export async function runSetBotProfile(io: SetBotProfileIo): Promise<number> {
  const token = io.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    io.error("Не задано змінну середовища TELEGRAM_BOT_TOKEN");
    return 1;
  }
  const redact = (s: string) => s.split(token).join("***");

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
    // Меню команд: порівнюємо перелік (порядок має значення — так його бачить людина).
    const have = await call<{ command: string; description: string }[]>("getMyCommands");
    const same = have.length === BOT_COMMANDS.length && have.every((c, i) => c.command === BOT_COMMANDS[i]!.command && c.description === BOT_COMMANDS[i]!.description);
    if (same) io.log("Меню команд: без змін");
    else {
      await call<boolean>("setMyCommands", { commands: BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })) });
      io.log("Меню команд: оновлено");
    }

    const description = await call<{ description: string }>("getMyDescription");
    if (description.description === BOT_DESCRIPTION) io.log("Опис: без змін");
    else {
      await call<boolean>("setMyDescription", { description: BOT_DESCRIPTION });
      io.log("Опис: оновлено");
    }

    const short = await call<{ short_description: string }>("getMyShortDescription");
    if (short.short_description === BOT_SHORT_DESCRIPTION) io.log("Короткий опис: без змін");
    else {
      await call<boolean>("setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION });
      io.log("Короткий опис: оновлено");
    }
    return 0;
  } catch (err) {
    io.error(redact(`Помилка Telegram API: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
}
