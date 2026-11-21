export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ALLOWED_TELEGRAM_IDS?: string;
  /** Ключ Claude для фото їжі (3.3). Немає — «Розпізнавання ще не підключене». */
  ANTHROPIC_API_KEY?: string;
}
