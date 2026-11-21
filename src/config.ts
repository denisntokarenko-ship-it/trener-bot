// Константи поведінки, що не належать до одного модуля. Моделі й ціни Claude (з Фази 3) — теж тут.

/** Недільний звіт: локальна година й хвилина (не налаштовується). */
export const REPORT_LOCAL_MINUTES = 19 * 60;
/** Нагадування `T` належить до тіків `T … T+59` хв: один-два пропущені тіки не гублять його, пізніше години — пропуск. */
export const REMINDER_WINDOW_MIN = 60;
/** Таймаут `sendMessage` у кроні: довше — доля невідома, заявку лишаємо (повтору не буде). */
export const TELEGRAM_SEND_TIMEOUT_MS = 5000;
/** Тік крону старший за це — `/health` усе одно 200, але вік видно (2.5 перевіряє `cron < 20m`). */
export const CRON_TICK_MINUTES = 15;

// --- Фаза 3: розпізнавання їжі за фото (docs/spec/phase-3-photo.md §2). Ціни звірено живцем 2026-11-21 (platform.claude.com/docs/en/about-claude/pricing). ---

/** Модель для фото їжі. */
export const FOOD_MODEL = "claude-sonnet-5-5";
/** Ціна вхідних токенів FOOD_MODEL, мікро-USD за 1 млн токенів ($2 / MTok). */
export const FOOD_PRICE_IN_MICRO = 2_000_000;
/** Ціна вихідних токенів FOOD_MODEL, мікро-USD за 1 млн токенів ($10 / MTok). */
export const FOOD_PRICE_OUT_MICRO = 10_000_000;
/** Денний ліміт витрат на ШІ на користувача, мікро-USD ($0,30). */
export const AI_DAILY_LIMIT_MICRO = 300_000;
/** Оцінка-резервування одного виклику, мікро-USD ($0,015 — більша за типову ≈ $0,01). */
export const FOOD_CALL_EST_MICRO = 15_000;
/** Один дедлайн на весь конвеєр фото: typing → getFile → завантаження → виклик Anthropic. */
export const FOOD_TIMEOUT_MS = 25_000;
/** Стеля відповіді моделі (мислення вимкнено `between_tools`). */
export const FOOD_MAX_TOKENS = 1500;
/** Найбільше позицій у відповіді. */
export const FOOD_MAX_ITEMS = 8;
/** Найбільший розмір фото, що завантажуємо (беремо найбільший PhotoSize не більший за це). */
export const FOOD_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** Підпис-підказка обрізається до стількох символів. */
export const FOOD_CAPTION_MAX = 300;
/** Скільки відомих назв продуктів іде в запит. */
export const FOOD_KNOWN_NAMES_MAX = 300;
/** `pending`-прийом старший за це (від created_at) — застарів. */
export const MEAL_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Очікування введення грамів живе стільки після [✏️ Грами]. */
export const GRAMS_AWAIT_TTL_MS = 15 * 60 * 1000;
