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
/** Найбільше позицій у відповіді моделі й у прийомі — єдине джерело (parseFoodResponse, createPendingMeal, промпт); CHECK `position` 1–8 у БД — та сама межа. */
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

// --- Фаза 3: корекція норми за трендом ваги (docs/spec/phase-3.md, розділ 4). ---

/** Оцінка тренду — вікно тіків `[09:00, 10:00)` за `tz` (60 хв, як у нагадувань Фази 2). */
export const TREND_LOCAL_MINUTES = 9 * 60;
/** Не частіше ніж раз на стільки днів від `valid_from` чинної норми й від останньої пропозиції. */
export const TREND_MIN_DAYS = 14;
/** Зважувань у `W0 ∪ W1` не менше й у кожному вікні не менше. */
export const TREND_MIN_WEIGHINGS = 10;
export const TREND_MIN_PER_WINDOW = 3;
/** Крок пропозиції, ккал; вуглеводи змінюються на стільки грамів на крок (4 ккал/г). */
export const TREND_STEP_KCAL = 100;
export const TREND_STEP_CARBS_G = 25;
/** Найбільше сумарне відхилення від `formula`-норми, ккал; нова норма не нижча за мінімум. */
export const TREND_MAX_DEVIATION_KCAL = 300;
export const TREND_MIN_KCAL = 1200;

export type GoalKey = "lose_fat" | "recomp" | "muscle" | "strength" | "health" | "other";

/**
 * Пороги темпу `p` у сотих відсотка за тиждень (−120 = −1,20 %/тиж). Смуга цілі + запас 0,20 на шум середніх за 3–7 зважувань:
 * `p < add` → +100 ккал, `p > cut` → −100 ккал; межі строгі (рівно на порозі — нічого).
 */
export const GOAL_BANDS: Record<GoalKey, { add: number; cut: number }> = {
  lose_fat: { add: -120, cut: -30 },
  recomp: { add: -45, cut: 20 },
  muscle: { add: -10, cut: 70 },
  strength: { add: -45, cut: 45 },
  health: { add: -45, cut: 45 },
  other: { add: -45, cut: 45 },
};

// --- Фаза 4: ШІ-тренер (docs/spec/phase-4.md, розділи 1–2; ціни й ліміти виклику чату додає 4.2). ---

/** Пропозиція ШІ живе стільки від створення, потім `expired` (ледаче й кроном). */
export const PROPOSAL_TTL_MS = 48 * 60 * 60 * 1000;
/** Найбільше відкритих (непрострочених) пропозицій на користувача. */
export const PROPOSALS_PENDING_MAX = 3;
/** Рядків `chat_turns` на користувача (= 5 пар). */
export const CHAT_HISTORY_TURNS = 10;
/** У контекст чату беруться лише рядки не старші за це. */
export const CHAT_HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Резервування `purpose = 'chat'` без токенів молодше за це — чат ще відповідає. */
export const CHAT_INFLIGHT_MS = 30_000;
/** Найдовший текст рядка `chat_turns` (CHECK); довше — обрізається перед записом. */
export const CHAT_TURN_MAX_CHARS = 3500;
/** Вихід інструмента ШІ ≤ стільки символів; переповнення — відкидаємо хвіст списку й ставимо `truncated`. */
export const TOOL_RESULT_MAX_CHARS = 4000;

// --- Фаза 4: чат ШІ-тренера (docs/spec/phase-4-chat.md, розділ 3). Ціни Haiku 5.5 звірено живцем 2026-11-22 (platform.claude.com/docs/en/about-claude/pricing). ---

/** Модель чату. Без server-side fallback при `refusal` (спека: [П]). */
export const CHAT_MODEL = "claude-haiku-5-5";
/** Ціни CHAT_MODEL для промпту ≤ `CHAT_LONG_PROMPT_TOKENS`, мікро-USD за 1 млн токенів ($0,10 / $0,50 за MTok). */
export const CHAT_PRICE_IN_MICRO = 100_000;
export const CHAT_PRICE_OUT_MICRO = 500_000;
/** Запит з промптом довшим за це коштує дорожче ($0,50 / $2,50); поріг — за промптом одного запиту, тож вартість рахується по кожному запиту окремо. */
export const CHAT_LONG_PROMPT_TOKENS = 100_000;
export const CHAT_LONG_PRICE_IN_MICRO = 500_000;
export const CHAT_LONG_PRICE_OUT_MICRO = 2_500_000;
/** `max_tokens` одного запиту (мислення входить). */
export const CHAT_MAX_TOKENS = 2000;
/** Найбільше запитів до моделі за хід. */
export const CHAT_MAX_ITERATIONS = 5;
/** Найбільше виконаних викликів інструментів за хід; решта отримує `is_error` (кожен `tool_use` мусить отримати `tool_result`). */
export const CHAT_MAX_TOOL_CALLS = 6;
/** Один дедлайн на весь цикл. */
export const CHAT_TIMEOUT_MS = 25_000;
/** Оцінка-резервування ходу, мікро-USD ($0,008; типовий хід ≈ $0,003). */
export const CHAT_CALL_EST_MICRO = 8_000;
/** Довші повідомлення в чат не йдуть. */
export const CHAT_INPUT_MAX_CHARS = 1000;
/** Відповідь моделі обрізається до цього (сирий текст) перед `esc` і записом у `chat_turns`. */
export const CHAT_REPLY_MAX_CHARS = 3500;
/** Ліміт довжини повідомлення Telegram. */
export const TELEGRAM_TEXT_MAX = 4096;

// --- Фаза 4: недільний коментар у звіті (docs/spec/phase-4-chat.md, розділ 4). Модель і ціни — CHAT_*. ---

/** Окремий дедлайн виклику коментаря (не подовжує вікно «заявлено, ще не надіслано»). */
export const WEEKLY_COMMENT_TIMEOUT_MS = 10_000;
/** Оцінка-резервування коментаря, мікро-USD ($0,003). */
export const WEEKLY_COMMENT_EST_MICRO = 3_000;
/** `max_tokens` коментаря (2–3 речення). */
export const WEEKLY_COMMENT_MAX_TOKENS = 600;
/** Коментар довший за це відкидається. */
export const WEEKLY_COMMENT_MAX_CHARS = 500;
