export interface Env {
  DB: D1Database;
  /** Метадані версії Worker (binding `version_metadata` у wrangler.jsonc); у тестах і `wrangler dev` може бути відсутній. */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ALLOWED_TELEGRAM_IDS?: string;
  /** Ключ Claude для фото їжі (3.3). Немає — «Розпізнавання ще не підключене». */
  ANTHROPIC_API_KEY?: string;
}
