# RUNBOOK

Ручні операції з продом і preview. Команди — з кореня репозиторію. Секрети тут не пишуться ніколи.

| Середовище | Worker | D1 |
|---|---|---|
| preview | `trener-preview` | `trener-preview` |
| production | `trener-prod` | `trener-prod` |

Акаунт Cloudflare пришпилений у `wrangler.jsonc` (`account_id` = `3d91f589…`, платний тариф). Перенесено 2026-11-20 зі старого акаунта `286f73de…` (free): нові порожні D1 `trener-preview` і `trener-prod`, дані зі старих баз не переносились (були лише тестові). Workers.dev-субдомен нового акаунта — `adhd-bot`: `https://trener-preview.adhd-bot.workers.dev`, `https://trener-prod.adhd-bot.workers.dev` (старі `*.koxbe.workers.dev` більше не діють).

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

1. **Бекап:** `npm run backup:prod` → `backups/prod-YYYYMMDD-HHMMSS.sql`. Скрипт падає з кодом ≠ 0 і видаляє файл, якщо export не вдався або в ньому немає `CREATE TABLE` якоїсь таблиці. Виняток — порожня БД (перший реліз): порожній список таблиць дозволений, лише якщо export рівно `PRAGMA defer_foreign_keys=TRUE;`. Тест — `npm run test:scripts` (стаб wrangler, 5 випадків).
2. **Bookmark до міграції:** `npx wrangler d1 time-travel info trener-prod --env production` → записати `bookmark` (у нотатку релізу, не в git).
3. **Міграція:** `npm run db:migrate:prod` (`wrangler d1 migrations apply DB --remote --env production`).
4. **Деплой коду:** `npm run deploy:prod`.
5. **Smoke:** `/start` prod-боту → привітання; `npx wrangler tail --env production` без помилок.
6. **Збій після міграції:** `npx wrangler d1 time-travel restore trener-prod --env production --bookmark=<записаний на кроці 2>`, потім задеплоїти попередній коміт.

## Відкат через Time Travel

- Time Travel тримає історію **30 днів на Paid** (7 на Free; акаунт тепер платний). Bookmark — точка в часі; restore повертає БД цілком у цей стан.
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

Worker `https://trener-prod.adhd-bot.workers.dev` (до переносу 2026-11-20 — `trener-prod.koxbe.workers.dev`, старий акаунт), D1 `trener-prod` (`c34e8f9c-…`; до переносу `cb3ae401-…`), крон `*/15 * * * *`. Що відрізнялось від написаного вище:

- **Бекап порожньої БД.** `backup:prod` на БД без таблиць раніше падав («Не вдалося прочитати список таблиць») — export порожньої БД це один рядок `PRAGMA defer_foreign_keys=TRUE;` (32 байти). Тепер порожній список таблиць дозволений, лише якщо export рівно `PRAGMA defer_foreign_keys=TRUE;` (будь-що інше — помилка); скрипт друкує, що перевірку пропущено. Для БД із таблицями поведінка незмінна.
- **Порядок «міграція → сид → деплой» і сид без профілю.** Сид до першого `/start` кладе лише каталог (18 вправ, 18 замін), програму отримує профіль з `users`. Тому після `set-webhook production` і першого `/start` власника — ще раз `npm run seed:prod` (ідемпотентний), і лише тоді `/trening`.
- **Worker без секретів — fail-closed.** Після `deploy:prod`, до секретів, будь-який POST на `/tg/webhook` дає 401 (з секретом і без) — прод безпечно лишати так.
- **Секрети й вебхук — одним скриптом**, бо секрет вебхука ніде не зберігається: скрипт `scripts/setup-secrets.ps1` (preview і prod разом, по черзі питає токен кожного бота; `-Only preview|production` — одне середовище; `OwnerId` за замовчуванням 369942190): `powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1` (політика виконання блокує голий `.ps1`). Скрипт: токен через `Read-Host -AsSecureString` → новий випадковий секрет → `wrangler secret put` ×3 (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ALLOWED_TELEGRAM_IDS`) → перевірка 200 на `{}` з секретом (до 12 спроб по 5 с — нова версія підхоплюється не миттєво) → `npm run set-webhook -- <env>` (три фейки від чужого id після переносу зі скрипта прибрано; свідок F-0 — нижче, вручну) у тому ж процесі → `finally` чистить змінні. Ротація секрету = той самий скрипт.
- **Свідок фейків (борг F-0).** Код 200 від фейків нічого не доводить (200 дає і «дедуп», і «чужий»). Після запуску читай прод: `npx wrangler d1 execute trener-prod --remote --env production --command "SELECT update_id FROM processed_updates WHERE update_id IN (900100, 900101)"` і `SELECT count(*) FROM users` — очікування й трактування в «Перевірці 1.5». Фейки лишають у `processed_updates` прода 1–2 синтетичні рядки; крон прибере їх за 3 доби.
- **Time Travel репетиція (preview, 2026-11-19).** Тимчасова таблиця: рядок X=`before` → `time-travel info` (bookmark) → X=`after` → `time-travel restore … --bookmark=<bm>` → X=`before`. Restore друкує bookmark для скасування самого restore. Між bookmark і restore не пиши в БД нічого, що шкода втратити.
- **tail у файл.** `npx wrangler tail --env production --format json > файл` у фоні; `&` усередині Bash-інструмента процес не тримає — запускати окремим фоновим завданням.
