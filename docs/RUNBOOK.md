# RUNBOOK

Ручні операції з продом і preview. Команди — з кореня репозиторію. Секрети тут не пишуться ніколи.

| Середовище | Worker | D1 |
|---|---|---|
| preview | `trener-preview` | `trener-preview` |
| production | `trener-prod` | `trener-prod` |

Акаунт Cloudflare пришпилений у `wrangler.jsonc` (`account_id`): його id — це акаунт, у якому `npx wrangler d1 list` показує обидві БД `trener-*` (або з URL дашборда `dash.cloudflare.com/<id>`); без поля wrangler при двох акаунтах у логіні падає в неінтерактивному запуску.

## Секрети (одноразово на середовище)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN --env preview
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env preview
npx wrangler secret put ALLOWED_TELEGRAM_IDS --env preview
```

Для прода — те саме з `--env production` і токеном prod-бота. `TELEGRAM_WEBHOOK_SECRET` — випадковий рядок `A-Z a-z 0-9 _ -`, 1–256 символів (обмеження Telegram), наприклад `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. `ALLOWED_TELEGRAM_IDS` — ID через кому; порожній = доступу немає нікому.

## Вебхук

У терміналі, де задані `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (ті самі, що в `wrangler secret`) і `WORKER_URL` (`https://trener-preview.<subdomain>.workers.dev`):

```bash
npm run set-webhook -- preview
```

Скрипт друкує `@username` бота — звір, що це бот потрібного середовища. Повторний запуск безпечний.

## Чек-лист «міграція прода»

Строго по порядку. Збій на кроці — не йти далі.

1. **Бекап:** `npm run backup:prod` → `backups/prod-YYYYMMDD-HHMMSS.sql`. Скрипт падає з кодом ≠ 0 і видаляє файл, якщо export не вдався або в ньому немає `CREATE TABLE` якоїсь таблиці.
2. **Bookmark до міграції:** `npx wrangler d1 time-travel info trener-prod --env production` → записати `bookmark` (у нотатку релізу, не в git).
3. **Міграція:** `npm run db:migrate:prod` (`wrangler d1 migrations apply DB --remote --env production`).
4. **Деплой коду:** `npm run deploy:prod`.
5. **Smoke:** `/start` prod-боту → привітання; `npx wrangler tail --env production` без помилок.
6. **Збій після міграції:** `npx wrangler d1 time-travel restore trener-prod --env production --bookmark=<записаний на кроці 2>`, потім задеплоїти попередній коміт.

## Відкат через Time Travel

- Time Travel тримає історію **7 днів на Free** (30 на Paid). Bookmark — точка в часі; restore повертає БД цілком у цей стан.
- ⚠️ Restore відкочує **всі** дані, записані після bookmark, — не лише зміни міграції. Тренування, записані між міграцією й відкатом, зникнуть: перед restore зроби ще один `npm run backup:prod`, щоб їх можна було дістати вручну.
- Без записаного bookmark: `npx wrangler d1 time-travel restore trener-prod --env production --timestamp=2026-10-23T12:00:00Z`.
- Перевірка після restore: `npx wrangler d1 execute trener-prod --remote --env production --command "SELECT name FROM d1_migrations"`.

## Відкат пізніше ніж за 7 днів

Time Travel уже не дістає — лише файл з `backups/`:

1. `npx wrangler d1 create trener-prod-restore`
2. `npx wrangler d1 execute trener-prod-restore --remote --file=backups/prod-<дата>.sql`
3. У `wrangler.jsonc` → `env.production.d1_databases[0].database_id` = id нової БД; `npm run deploy:prod`; smoke `/start`.
4. Стару БД не видаляти, поки нова не пропрацює тиждень.

## Відкат міграції 0000 (users, processed_updates)

D1 не має down-міграцій. Варіанти — від кращого:

1. **Time Travel** на bookmark до міграції (розділ вище).
2. **Вручну** (лише якщо даних у таблицях ще немає або вони не потрібні):

   ```bash
   npx wrangler d1 execute trener-prod --remote --env production --command "DROP TABLE IF EXISTS processed_updates; DROP TABLE IF EXISTS users; DELETE FROM d1_migrations WHERE name = '0000_users_processed_updates.sql';"
   ```

   Для preview — `trener-preview` і `--env preview`. Рядок у `d1_migrations` треба прибрати, інакше `migrations apply` вважатиме міграцію застосованою.

## Сид каталогу й програми (фаза 1)

Бот без програми відповідає «Програму не знайдено — запусти сид». Сид ідемпотентний: повторний запуск нічого не дублює.

1. Міграції середовища застосовані (`npm run db:migrate:preview` / `:prod`).
2. Власник хоч раз написав боту `/start` — програму отримує кожен профіль з `users` без активної програми; без профілю сид кладе лише каталог.
3. `npm run seed:preview` (або `seed:prod`, `seed:local`): SQL іде в `.seed.sql` (у `.gitignore`), далі `wrangler d1 execute --file`.

Хибне припущення про крок чи мінімум ваги → правка `CATALOG` у `scripts/seed-core.ts` і повторний сид (каталог — upsert за `slug`). Програму, дні й слоти повторний сид не змінює — лише дописує відсутні.

## Відкат міграції 0001 (тренування)

Як для 0000: Time Travel або вручну, діти раніше батьків (FK):

```bash
npx wrangler d1 execute trener-preview --remote --env preview --command "DROP TABLE IF EXISTS workout_sets; DROP TABLE IF EXISTS workouts; DROP TABLE IF EXISTS program_exercises; DROP TABLE IF EXISTS program_days; DROP TABLE IF EXISTS programs; DROP TABLE IF EXISTS exercise_substitutes; DROP TABLE IF EXISTS exercises; DELETE FROM d1_migrations WHERE name = '0001_workouts.sql';"
```

## Репетиція бекапу на preview

```bash
bash scripts/backup-prod.sh preview
```

Той самий export, файл `backups/preview-YYYYMMDD-HHMMSS.sql`. `backups/` у `.gitignore`.

## Перший реліз прода — факти (2026-11-19)

Worker `https://trener-prod.koxbe.workers.dev`, D1 `trener-prod` (`cb3ae401-…`), крон `*/15 * * * *`. Що відрізнялось від написаного вище:

- **Бекап порожньої БД.** `backup:prod` на БД без таблиць раніше падав («Не вдалося прочитати список таблиць») — export порожньої БД це один рядок `PRAGMA defer_foreign_keys=TRUE;` (32 байти). Тепер порожній список таблиць дозволений, лише якщо в export немає `CREATE TABLE` (інакше — помилка); скрипт друкує, що перевірку пропущено. Для БД із таблицями поведінка незмінна.
- **Порядок «міграція → сид → деплой» і сид без профілю.** Сид до першого `/start` кладе лише каталог (18 вправ, 18 замін), програму отримує профіль з `users`. Тому після `set-webhook production` і першого `/start` власника — ще раз `npm run seed:prod` (ідемпотентний), і лише тоді `/trening`.
- **Worker без секретів — fail-closed.** Після `deploy:prod`, до секретів, будь-який POST на `/tg/webhook` дає 401 (з секретом і без) — прод безпечно лишати так.
- **Секрети й вебхук — одним скриптом**, бо секрет вебхука ніде не зберігається: запуск `powershell -ExecutionPolicy Bypass -File <шлях>` (політика виконання блокує голий `.ps1`). Скрипт: токен через `Read-Host -AsSecureString` → новий випадковий секрет → `wrangler secret put` ×3 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_TELEGRAM_IDS`) → перевірка 200 на `{}` з секретом (до 12 спроб по 5 с — нова версія підхоплюється не миттєво) → три фейки від чужого id (дедуп, тиша) → `npm run set-webhook -- production` у тому ж процесі → `finally` чистить змінні. Ротація секрету = той самий скрипт.
- **Time Travel репетиція (preview, 2026-11-19).** Тимчасова таблиця: рядок X=`before` → `time-travel info` (bookmark) → X=`after` → `time-travel restore … --bookmark=<bm>` → X=`before`. Restore друкує bookmark для скасування самого restore. Між bookmark і restore не пиши в БД нічого, що шкода втратити.
- **tail у файл.** `npx wrangler tail --env production --format json > файл` у фоні; `&` усередині Bash-інструмента процес не тримає — запускати окремим фоновим завданням.
