// Логіка scripts/set-bot-profile.ts без process — тестується з мокнутим fetch (phase-1b.md, P3.6).
// Оформлення бота: назва, меню команд, опис, короткий опис, аватарка. Тексти — з src/bot/texts.ts (BOT_PROFILES).
// Ідемпотентно: що вже збігається — не пишемо. Аватарку Telegram прочитати не дає (getMyProfilePhoto немає) — її ставимо щоразу, якщо не `--no-photo`.
import { BOT_COMMANDS, BOT_PROFILES, PREVIEW_BOT_USERNAME } from "../src/bot/texts.ts";

export const TARGETS = ["preview", "production"] as const;
export type Target = (typeof TARGETS)[number];

/** Файл аватарки (JPG: Bot API `InputProfilePhotoStatic` приймає лише .JPG) — джерела SVG/PNG лежать поруч. */
export const AVATAR_FILES: Record<Target, string> = {
  preview: "assets/bot/preview.jpg",
  production: "assets/bot/prod.jpg",
};

export interface SetBotProfileIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Читає файл аватарки (відносно кореня репозиторію). Без нього `--photo` недоступний. */
  readFile?: (path: string) => Uint8Array;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** Повертає код виходу. Токен не потрапляє в log/error. Використання: set-bot-profile preview | production [--no-photo]. */
export async function runSetBotProfile(args: string[], io: SetBotProfileIo): Promise<number> {
  const target = args[0];
  if (!TARGETS.includes(target as Target)) {
    io.error("Використання: npm run set-bot-profile -- preview | production [--no-photo]");
    return 1;
  }
  const profile = BOT_PROFILES[target as Target];
  const withPhoto = !args.includes("--no-photo");
  const token = io.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    io.error("Не задано змінну середовища TELEGRAM_BOT_TOKEN");
    return 1;
  }
  const redact = (s: string) => s.split(token).join("***");

  async function call<T>(method: string, params: Record<string, unknown> | FormData = {}): Promise<T> {
    const isForm = params instanceof FormData;
    const res = await io.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      // Для FormData заголовок із boundary виставляє сам fetch.
      ...(isForm ? {} : { headers: { "content-type": "application/json" } }),
      body: isForm ? params : JSON.stringify(params),
    });
    const data = (await res.json()) as TgResponse<T>;
    if (!data.ok || data.result === undefined) throw new Error(`${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  try {
    // Захист від переплутаних токенів: тестове оформлення не має потрапити на робочого бота й навпаки.
    const me = await call<{ username?: string }>("getMe");
    const isPreviewBot = (me.username ?? "").toLowerCase() === PREVIEW_BOT_USERNAME.toLowerCase();
    if (isPreviewBot !== (target === "preview")) {
      io.error(
        target === "preview"
          ? `Ціль preview, але токен належить @${me.username ?? "?"}, а не @${PREVIEW_BOT_USERNAME}. Нічого не змінено.`
          : `Ціль production, але токен належить тестовому боту @${PREVIEW_BOT_USERNAME}. Нічого не змінено.`,
      );
      return 1;
    }
    io.log(`Бот: @${me.username ?? "?"} (${target})`);

    const name = await call<{ name: string }>("getMyName");
    if (name.name === profile.name) io.log("Назва: без змін");
    else {
      await call<boolean>("setMyName", { name: profile.name });
      io.log(`Назва: оновлено → ${profile.name}`);
    }

    // Меню команд: порівнюємо перелік (порядок має значення — так його бачить людина).
    const have = await call<{ command: string; description: string }[]>("getMyCommands");
    const same = have.length === BOT_COMMANDS.length && have.every((c, i) => c.command === BOT_COMMANDS[i]!.command && c.description === BOT_COMMANDS[i]!.description);
    if (same) io.log("Меню команд: без змін");
    else {
      await call<boolean>("setMyCommands", { commands: BOT_COMMANDS.map((c) => ({ command: c.command, description: c.description })) });
      io.log("Меню команд: оновлено");
    }

    const description = await call<{ description: string }>("getMyDescription");
    if (description.description === profile.description) io.log("Опис: без змін");
    else {
      await call<boolean>("setMyDescription", { description: profile.description });
      io.log("Опис: оновлено");
    }

    const short = await call<{ short_description: string }>("getMyShortDescription");
    if (short.short_description === profile.shortDescription) io.log("Короткий опис: без змін");
    else {
      await call<boolean>("setMyShortDescription", { short_description: profile.shortDescription });
      io.log("Короткий опис: оновлено");
    }

    if (!withPhoto) io.log("Аватарка: пропущено (--no-photo)");
    else {
      if (!io.readFile) throw new Error("немає readFile для аватарки");
      const bytes = io.readFile(AVATAR_FILES[target as Target]);
      const form = new FormData();
      // `photo` — JSON InputProfilePhotoStatic; сам файл — окреме поле, на яке вказує attach://.
      form.set("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
      form.set("avatar", new Blob([bytes], { type: "image/jpeg" }), "avatar.jpg");
      await call<boolean>("setMyProfilePhoto", form);
      io.log(`Аватарка: оновлено (${AVATAR_FILES[target as Target]})`);
    }
    return 0;
  } catch (err) {
    io.error(redact(`Помилка Telegram API: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
}
