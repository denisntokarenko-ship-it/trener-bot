// Значення, що живуть у кількох місцях (код, схема БД, скрипт, міграція) — одне джерело. Без імпортів: його читає і Worker, і node-скрипти.

/** Шлях вебхука Telegram: його слухає `src/app.ts` і реєструє `scripts/set-webhook-core.ts`. */
export const WEBHOOK_PATH = "/tg/webhook";

/** Довжина імені користувача в `users.first_name`: обрізка в `repo.upsertUser`, CHECK у `schema.ts` і в міграції 0000. */
export const FIRST_NAME_MAX = 64;
