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

## Репетиція бекапу на preview

```bash
bash scripts/backup-prod.sh preview
```

Той самий export, файл `backups/preview-YYYYMMDD-HHMMSS.sql`. `backups/` у `.gitignore`.
