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

## Профіль бота (меню, опис)

Той самий `TELEGRAM_BOT_TOKEN` (потрібного бота) у середовищі терміналу:

```bash
npm run set-bot-profile
```

Скрипт читає з Telegram меню команд, опис і короткий опис (`getMyCommands`, `getMyDescription`, `getMyShortDescription`) і пише лише те, що відрізняється; тексти — `BOT_COMMANDS`, `BOT_DESCRIPTION`, `BOT_SHORT_DESCRIPTION` у `src/bot/texts.ts`. Повторний запуск безпечний («без змін»). `set-webhook` теж виставляє меню команд.

## Чек-лист «міграція прода»

Строго по порядку. Збій на кроці — не йти далі.

1. **Бекап:** `npm run backup:prod` → `backups/prod-YYYYMMDD-HHMMSS.sql` (повний) і `…-data.sql` (лише дані — для відновлення, розділ «Відкат пізніше ніж за 7 днів»). Скрипт падає з кодом ≠ 0 і видаляє обидва файли, якщо export не вдався, у повному немає `CREATE TABLE` якоїсь таблиці або кількість `INSERT` таблиці в дампі даних ≠ `COUNT(*)` у БД (запис посеред бекапу — повтори). Виняток — порожня БД (перший реліз): порожній список таблиць дозволений, лише якщо export рівно `PRAGMA defer_foreign_keys=TRUE;`. Тест — `npm run test:scripts` (стаб wrangler, 8 випадків + репетиція відновлення на локальній D1).
2. **Bookmark і знімок «до»:** `npx wrangler d1 time-travel info trener-prod --env production` → записати `bookmark` (у нотатку релізу, не в git). Знімок лічильників — **одним** `SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM workouts) workouts, …` (довгий `UNION ALL` D1 відхиляє: `too many terms in compound SELECT`); той самий запит — після релізу.
3. **Міграція:** `npm run db:migrate:prod` (`wrangler d1 migrations apply DB --remote --env production`).
4. **Деплой коду:** `npm run deploy:prod -- --message "main <sha> (<завдання>)"` — без `--message` версію не звірити з `main` у `deployments list`. Це довільний рядок, не sha збірки: вміст підтверджує живий крок, а не `message`.
5. **Smoke:** `/start` prod-боту → привітання; `npx wrangler tail --env production --format json > файл` **запущений до натискань** і з перевіркою росту файлу (власний `curl /health` → у файлі з'явилась подія). Критерій — події `POST /tg/webhook`, `outcome: ok`, `exceptions: []`, `cpuTime` натискань; лише `GET /health` у файлі — не smoke.
6. **Збій після міграції** — для міграцій, що **ламають старий код** (перейменування/видалення): `npx wrangler d1 time-travel restore trener-prod --env production --bookmark=<записаний на кроці 2>`, потім задеплоїти попередній коміт. Для міграцій, що лише **додають** (Фаза 2), порядок інший — спершу `wrangler rollback`, базу лише за пошкодження даних: розділ «План відкату Фази 2».

## Відкат через Time Travel

- Time Travel тримає історію **30 днів на Paid** (7 на Free; акаунт тепер платний). Bookmark — точка в часі; restore повертає БД цілком у цей стан.
- ⚠️ Restore відкочує **всі** дані, записані після bookmark, — не лише зміни міграції. Тренування, записані між міграцією й відкатом, зникнуть: перед restore зроби ще один `npm run backup:prod`, щоб їх можна було дістати вручну.
- Без записаного bookmark: `npx wrangler d1 time-travel restore trener-prod --env production --timestamp=2026-10-23T12:00:00Z`.
- Перевірка після restore: `npx wrangler d1 execute trener-prod --remote --env production --command "SELECT name FROM d1_migrations"`.
- **Репетиція на preview (4.4, 2026-11-22 15:09 UTC):** `time-travel info trener-preview --env preview` → bookmark; `INSERT` тестового `processed_updates` (update_id 999000044) → рядок є, усього 63; `time-travel restore trener-preview --env preview --bookmark=<записаний>` → рядка немає, усього 62. Прапорця `--yes` у `restore` немає (`Unknown argument: yes`); у неінтерактивному запуску (`CI=1`, stdin не термінал) wrangler сам відповідає «yes» на «OK to proceed» — restore у скрипті не має запобіжника, перевір `--env` і ім'я БД до запуску. Результат дає bookmark для скасування («To undo … restore to the previous bookmark»).

## Відкат пізніше ніж за 7 днів

Time Travel уже не дістає (на Paid — 30 днів) — лише файли з `backups/`. **Повний дамп `prod-<дата>.sql` у чисту БД не відновлюється** (R-2 В1): `wrangler d1 export` пише `INSERT INTO exercise_substitutes` до `CREATE TABLE exercises` → `no such table: main.exercises`. Відновлюємо схему міграціями, дані — з `prod-<дата>-data.sql` (`backup:prod` пише його поруч: `--no-schema`, без рядків `d1_migrations`, кількість рядків кожної таблиці звірена з `COUNT(*)`):

1. Код — на коміті, міграції якого збігаються з `INSERT INTO "d1_migrations"` у повному дампі (новіші міграції, що перейменовують/видаляють, дамп даних не прийме).
2. `npx wrangler d1 create trener-prod-restore` → у `wrangler.jsonc` `env.production.d1_databases[0].database_id` = id нової БД (поки не деплоїти).
3. `npm run db:migrate:prod` — схема в новій БД.
4. `npx wrangler d1 execute trener-prod-restore --remote --env production --file=backups/prod-<дата>-data.sql --yes`.
5. Звірка: лічильники таблиць (одним `SELECT (SELECT count(*) FROM …) …`) = рядок `Рядки (дамп = БД): …`, який надрукував `backup:prod`.
6. `npm run deploy:prod -- --message …`; smoke `/start`. Стару БД не видаляти, поки нова не пропрацює тиждень.

Рецепт репетирується в CI на локальній D1: `scripts/test-restore.mjs` (у `npm run test:scripts`) — дані з FK у різні боки → справжній `backup-prod.sh` → кроки 3–4 у чисту БД → ті самі лічильники всіх таблиць. Remote-відновлення в нову D1 не репетирувалось (створює БД в акаунті — живий крок людини).

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

### Сид продуктів (Фаза 3, 3.1)

Каталог продуктів — окремий сид: `npm run seed:foods:preview` (або `:prod`, `:local`) → `.seed-foods.sql` → `wrangler d1 execute --file`. Потребує міграції `0007`. Ідемпотентний (ключ — `foods.fdc_ref`): повтор — 0 записаних рядків. **Сид продуктів — до першого фото** (Д2 рев'ю 3.1): `ON CONFLICT (alias) DO NOTHING` віддав би аліас уже наявному `ai_estimate`. Після сиду: `SELECT COUNT(*) FROM foods f WHERE NOT EXISTS (SELECT 1 FROM food_aliases a WHERE a.food_id = f.id)` має бути 0. Перебудова `scripts/foods-seed.json` з мапи — `node scripts/build-foods-seed.ts <папка CSV SR Legacy> <дата>` (CSV: fdc.nal.usda.gov, SR Legacy 2018-04; не комітиться); скрипт падає на розбіжності опису з `fdc_desc` і на дубль аліаса.

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

## Реліз Фази 1b — факти (2026-11-20, 1b.5)

Деплой і міграції Фази 1b зроблено ще до 1b.5 (після переносу акаунта): прод і preview на коді `main` (`ddcbb3b`), міграції `0002_profile_plan` і `0003_day_titles_backfill` у `d1_migrations` обох баз. 1b.5 — верифікація (лише SELECT і tail), не повторний деплой.

- **Стан прода (SELECT):** `exercises` = 30 (`video_url` у 29; `NULL` лише `face-pull` — борг R-1b.1), `exercise_substitutes` = 40; каталог прода й preview ідентичний (`slug, video_url` — однакова контрольна сума). `users` = 1 (власник), `programs`/`program_days`/`workouts`/`workout_sets` = 0: база нова після переносу акаунта, власник анкету на проді ще не проходив — програма з'явиться після `/start` → анкета → «✅ Прийняти». Знімок «до/після»: 0/0/0 → 0/0/0 (нічого не мігрувалось і не деплоїлось у цьому кроці).
- **Версія прода:** `/health` віддає `ok cron=<вік тіку>m` (з 2.3; `cron=?` — тіку ще не було; без git sha — борг із `fix/day-titles`). Звірка деплою з main — `npx wrangler deployments list --env production`: остання версія `3e1d24fb…` створена 15:49:41 UTC, merge `ddcbb3b` — 15:49:07 UTC, тобто деплой після мержу.
- **Бекап і bookmark — ПІСЛЯ деплою Фази 1b, не до (ревʼю 1b.5 В1):** `npm run backup:prod` → `backups/prod-20261120-155115.sql` (34 КБ, `.gitignore`) створено о 15:51 UTC, а деплой і міграції 0002/0003 — о 15:49. Bookmark Time Travel — того ж моменту (`npx wrangler d1 time-travel info trener-prod --env production`). Стану «до Фази 1b» ніде не записано; оскільки даних власника на проді немає, відкат бази = Time Travel за `--timestamp` до 15:49 UTC 2026-11-20 (вікно 30 днів) або перестворення з міграцій 0000–0003 + `seed:prod`.

### План відкату Фази 1b

1. Код: `npx wrangler rollback --env production` (попередня версія Worker) або `git switch -c rollback origin/<попередній коміт> && npm run deploy:prod`. Код 1b.2+ без міграцій 0002/0003 не працює (читає нові стовпці), код ≤ 1.x з міграціями 0002/0003 має працювати (стовпці лише додані; не перевірялось) — тому відкочувати спершу код, базу чіпати останньою.
2. База: нових даних власника поки немає (0 програм/тренувань) → restore безпечний, але bookmark з `info` повертає лише до стану ПІСЛЯ Фази 1b; для стану до неї — `--timestamp=2026-11-20T15:48:00Z`. Коли дані з'являться — спершу `npm run backup:prod`, бо restore стирає все після bookmark.
3. Міграції 0002 (`ALTER … ADD COLUMN` із CHECK) і 0003 (бекфіл `title`) вручну не відкочуються — лише Time Travel.
- **tail production (5 хв, 2026-11-20 16:15 UTC):** один тік крону — `outcome: ok`, `cpuTime` 6 мс, `exceptions: []`, `scriptVersion` `3e1d24fb…` (та сама, що в `deployments list`). Натискань кнопок у вікні не було: `cpuTime` натискання < 10 мс — не перевірено (потрібен живий прохід людини, див. PR 1b.5).
- **Історія зі старого акаунта (ревʼю 1b.5 В2):** тренування, які власник проходив на старому прод/preview (акаунт `286f73de…`, free), на нові бази не переносились (на момент переносу вважались тестовими). Старі Worker і D1 там можуть ще існувати — рішення «експортувати чи відпустити» за власником; поки не ухвалено, нічого не видаляти зі старого акаунта.
- **Версія прода (В4):** доказ деплою — лише порядок у часі; вмісту деплою (sha) нічим не підтверджено. Лікування — sha у `/health` або `--message` у `deploy:prod` (у «Борг»).
- **Сирий tail (Д1):** лишено поза git у спільній папці нотаток сесій (`tail-prod-1b5.log`).

## Реліз Фази 2 — факти (2026-11-20, 2.5)

До релізу: прод на коді Фази 1b, міграції 0000–0003. Реліз: `0004_body_weights`, `0005_reminders`, `0006_cron_ok` + код, зібраний з `main` `78529d5` (PR #31). Задеплоєно версію `95478ee1`, її `message` = `main 78529d5 (2.5)` — це текст, який набрав автор у `--message`, а не sha збірки: вміст (2.4, `/nalashtuvannia`) доведено живим кроком пакета (налаштування 09:00/08:30 змінено через бота, `SELECT users`), `/health` sha не віддає (борг «до релізу Фази 3 (3.5)»). Нових секретів немає.

### План відкату Фази 2 (записано до першої prod-команди)

Сумісність: міграції 0004–0006 лише **додають** (3 таблиці, 3 стовпці `users` з DEFAULT, стовпець `cron_state`) — код Фази 1b з ними працює (нових стовпців не читає, `SELECT *` у repo немає — drizzle перелічує стовпці). Код Фази 2 **без** міграцій падає (читає `body_weights`, `users.training_days`, `cron_state`). Тому: міграції → деплой; відкат — спершу код, базу — останньою й лише за потреби.

1. **Збій міграції (до деплою):** код Фази 1b ще працює. `SELECT name FROM d1_migrations` — яка застосувалась. Частково застосовану міграцію не допрацьовувати руками → `npx wrangler d1 time-travel restore trener-prod --env production --bookmark=<bookmark до міграції>` (bookmark — у PR-коментарі релізу), перевірка `d1_migrations` = 0000–0003.
2. **Збій коду після деплою** (`/health` не `ok`, помилки в tail, бот не відповідає): `npx wrangler rollback <версія до релізу> --env production` (id версії — у PR-коментарі релізу, з `wrangler deployments list` до деплою). Базу не чіпати: код 1b з міграціями 0004–0006 сумісний. Свідок — `wrangler deployments list` і `/health` (код 1b відповідає `ok` без `cron=`).
3. **Зіпсовано дані** (лише тоді — Time Travel): спершу ще раз `npm run backup:prod` (restore стирає все після bookmark: тренування, вагу, `reminders_sent`), потім код (крок 2), потім `time-travel restore … --bookmark=<до міграції>`; свідок — `d1_migrations` = 0000–0003 і `count(*)` таблиць зі знімка «до» (PR-коментар).
4. **Нагадування заважають** (шле не те / дублює), а решта працює: не відкат, а `/nalashtuvannia` → вимкнути (`remind_time`/`weigh_time` = NULL) у власника; крон тоді лише прибирає. Глобально — `wrangler rollback` (крок 2).
5. Вручну міграції не відкочуються (`ALTER … ADD COLUMN` з CHECK у 0005) — лише Time Travel (30 днів на Paid) або файл `backups/` (розділ «Відкат пізніше ніж за 7 днів»).

Значення відкату цього релізу (версія до релізу `3e1d24fb-…`, bookmark, знімок «до») — у коментарі PR #32, не в git.

### Що сталося (2026-11-20, UTC)

- **18:57 бекап:** `backups/prod-20261120-185745.sql` (єдина копія поза Time Travel: стабільна — `D:\01CLOud CODE\Тренер\backups\prod-20261120-185745.sql`, корінь основного checkout, `backups/` у `.gitignore`, не в git, не в worktree, який зникає після мержу; копія в worktree `phase-2-05-prod-release-ad5276` ідентична, `cmp` ✔), 34 217 байт, `CREATE TABLE` для всіх 13 таблиць; рядків `workout_sets` — **0** (і `workouts` = 0): власник на проді анкету не завершив (`onboarding_state` = 1, `user_profiles` = 0), «реальних даних» ще немає. Bookmark `00000016-…` — `time-travel info` одразу після бекапу; **restore'ом не перевірений** (це змінило б прод): доведено лише порядок — коментар PR 18:58:02Z раніше за `d1_migrations.applied_at` 18:58:15; `time-travel info --timestamp` для 18:57:40–18:58:40 повертає той самий `00000003-…` (мітка груба — не свідок). Механіку restore відрепетирувано на preview (1.5).
- **D1 не приймає довгий `UNION ALL`** (`too many terms in compound SELECT`) — знімок лічильників одним рядком з підзапитами: `SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM workouts) workouts, …`.
- **18:58 міграції 0004→0005→0006** — одним `migrations apply` (усі три `applied_at` = `18:58:15`), усі ✅. Після: `d1_migrations` 0000–0006, 16 таблиць (+`body_weights`, `reminders_sent`, `cron_state`), у власника бекфіл `training_days='1,3,5'` (профілю немає → ELSE), `remind_time` 08:00, `weigh_time` 07:30.
- **18:58 деплой:** `npm run deploy:prod -- --message "main 78529d5 (2.5)"` → версія `95478ee1-…`; `deployments list` показує це повідомлення, але воно **довільний рядок**, а не sha збірки (рев'ю 2.5 В1): сценарій «деплой із зайвою незакомічену правкою» дав би те саме `message` і той самий `/health`. Версія прода = «`95478ee1`, message `main 78529d5`», вміст підтверджує живий крок (`/nalashtuvannia` відкрився). Sha у `/health` — борг до релізу Фази 3 (3.5). Перші ~30 с після деплою `/health` віддавав `ok` (стара версія 1b), далі `ok cron=? ok=?`.
- **Перший тік 19:00:30:** `/health` → `ok cron=0m ok=0m`, `cron_state.last_ok_at` = `last_tick_at`. Тік 19:15:32 у tail: `outcome: ok`, `cpuTime` 9 мс, wall 735 мс, `exceptions: []`, лог `cron tick {sent:0, skipped:0, released:0, errors:0}` (о 21:15 Києва вікон нагадувань немає).
- **Ліміти (developers.cloudflare.com/workers/platform/limits, Paid):** Cron Triggers на акаунт: Free 5, **Paid 1 000** (раніше тут стояло застаріле 250; рев'ю 2.5, знято 2026-11-20) — у нас 2 (`trener-preview`, `trener-prod`) + ≤ 2 у проєкті ADHD на тому ж акаунті (число з локального `wrangler.toml` ADHD-бота, а не з акаунта); верхній рівень `wrangler.jsonc` (`trener-local`) не деплоїться. Wall-time запланованого обробника — 15 хв; CPU для крону з інтервалом < 1 год — 30 с. Тік 9 мс / 735 мс — запас на порядки.
- **tail у файл рветься мовчки:** `Tail connection lost. Reconnecting` у stderr, після чого файл перестав рости (тік 19:00 і запити після нього не записались). Свідок живого tail — власний `curl /health` і ріст файлу; замовк — перезапуск.
- **Живий пакет 19:20–19:23:** власник завершив анкету (програма активна), записав вагу 93,5 кг, поставив `remind_time` 09:00 / `weigh_time` 08:30. 33 вебхуки — усі `ok`, `cpuTime` медіана 19 мс, макс 46 мс. Нагадування наживо не спостерігалось (`reminders_sent` = 0). Свідки (рев'ю 2.5, SELECT на проді 19:28Z): `user_profiles` 1, активних програм 1, `body_weights` 2026-11-20 = 935 dg, `users` = `1,3,5 09:00 08:30 Europe/Kyiv`, `workouts`/`workout_sets` 0; у tail-файлі 33 × `POST /tg/webhook` 19:20:18–19:23:46Z, усі `outcome: ok`, `exceptions: []`, версія `95478ee1`, `cpuTime` 8–46 мс (мед. 19) — раніше (до пакета) у файлі були лише `GET /health` і тік, смоук-вебхука не було. **Непройдене в пакеті:** дні тренувань і пояс (`/nalashtuvannia Europe/Warsaw`), «🔕 Вимкнути», reply на нагадування, `/vaga` з кабінету нагадування, `/progres` → [📜] → [⬅️]; час вебхуків `/vaga` окремо не виокремлено. Процедура для наступних пакетів — крок 5 чек-листа: tail **під** натискання, ріст файлу звіряти `curl /health`, `cpuTime` і `exceptions: []` вписувати перед ✅.
- **Перше нагадування прода** — Сб 2026-11-21 08:30 Києва = 06:30 UTC (`weigh`, якщо ваги за день немає); свідок — `SELECT * FROM reminders_sent` (kind `weigh`, `message_id` ≠ NULL). Звіт — Нд 22.11 19:00 (вага є → піде), `train` — Пн 23.11 09:00. Це **запасний варіант** замість штучного вікна «до 22:00 Києва» (воно сплило ввечері 21.11): природне нагадування Сб 08:30 Києва і є кроком «reply числом на нагадування» — окремої зміни налаштувань не треба. Текст «Доброго ранку!» у нагадуванні, що прийшло б ввечері, — косметика (рев'ю 2.5, дрібниця 6г).

## Реліз Фази 3 — факти (2026-11-21, 3.5)

До релізу: прод на коді Фази 2 (`main 78529d5`), версія `4d96fc62` — це `95478ee1` + секрет `ANTHROPIC_API_KEY` (Source: Secret Change, 2026-11-21 11:54 UTC), міграції 0000–0006. Реліз: `0007_nutrition` (6 нових таблиць), `0008_trend_reminders` (перебудова `reminders_sent`: новий CHECK з `trend`, копія рядків → `DROP` → `RENAME`), сид `foods`, код `main` (`ff026a3`). Секрет `ANTHROPIC_API_KEY` внесено раніше (`set-anthropic-key.ps1`), тут — лише перевірка імені.

### План відкату Фази 3 (записано до першої prod-команди)

Сумісність: код Фази 2 зі схемою 0007/0008 працює — нових таблиць не читає, `reminders_sent` має ті самі стовпці, а CHECK лише ширший (`train|weigh|report` ⊂ `…|trend`). Код Фази 3 без 0007/0008 падає (читає `foods`, `meals`, `nutrition_targets`, пише `trend`). Порядок: міграції → сид → деплой; відкат — спершу код.

1. **Збій міграції 0007/0008** (до деплою): код Фази 2 ще працює. `SELECT name FROM d1_migrations` — що застосувалось. Чи D1 застосовує файл міграції атомарно (усе або нічого) — **не перевірено** (ні репетицією збою, ні документацією), тому перевіряй стан: якщо 0008 лишила `reminders_sent_new` або без `reminders_sent` — **не лагодити руками**: `time-travel restore --bookmark=<до міграції>` (значення — у коментарі PR 3.5).
2. **Збій сиду** — ідемпотентний: повторити `npm run seed:foods:prod`; код Фази 2 таблиць `foods` не читає, тож бот працює.
3. **Збій коду після деплою** (`/health` не `ok`, помилки в tail, бот мовчить): `npx wrangler rollback 4d96fc62-ddf2-4454-a0fc-7258c6b1d77a --env production` — **не** `95478ee1` (у ній ще немає ключа Anthropic у наборі секретів версії). Базу не чіпати (крок «Сумісність»). Ключ Anthropic код Фази 2 не використовує.
4. **Фото дає шкоду** (хибні записи, перевитрата ШІ) при живій решті: ліміт `aiSpendToday` у `config.ts` уже обмежує витрати на день; негайно — `wrangler rollback` (крок 3); прийоми `pending` код Фази 2 не показує.
5. **Зіпсовано дані:** ще один `npm run backup:prod` → відкат коду → `time-travel restore --bookmark=<до міграції>` (стирає все після bookmark: вагу, нагадування, тренування). Пізніше 30 днів — дамп даних `…-data.sql` за рецептом «Відкат пізніше ніж за 7 днів» на коміті з міграціями 0000–0006.

### Що сталося (2026-11-21, UTC)

- **12:31 до релізу:** остання версія прода — не `95478ee1` (деплой 2.5), а `4d96fc62` (Source: **Secret Change**, 11:54 — `set-anthropic-key.ps1`): `secret put` створює нову версію Worker. Ціль відкату — остання версія, а не останній *деплой*: стара мала б інший набір секретів. Звіряти `deployments list` перед записом плану.
- **Секрети прода (лише імена, `wrangler secret list --env production`):** `ALLOWED_TELEGRAM_IDS`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; ті самі 4 — у новій версії (`versions view`).
- **Свідок нагадування 2.5:** `reminders_sent` — `weigh / 2026-11-21 / message_id 35`, `sent_at` 06:30:30 UTC (= 08:30 Києва); `body_weights` 21.11 = 898 dg.
- **12:32 бекап:** `prod-20261121-123239.sql` (42 464 Б, sha256 `63b508f2…`) + `…-data.sql` (27 935 Б, sha256 `bf7d2492…`). **Стабільна копія** (рев'ю 3.5 В1; worktree прибирається разом із його `backups/`): `D:\01CLOud CODE\Тренер\backups\prod-20261121-123239.sql` і `…-data.sql` основного checkout (gitignored), sha256 звірено з оригіналом. Дані прода в git не комітяться. `Рядки (дамп = БД)` — 15 таблиць **без `d1_migrations`** (її рядки вирізані з дампу даних, у новій БД їх пише `migrations apply`): `workout_sets` 0, `body_weights` 2. **Відновлення перевірено** за рецептом F-2: дамп даних → чиста локальна D1 з міграціями 0000–0006 (= прод) → 16 лічильників 1:1 (ті 15 + `d1_migrations` = 7 з `migrations apply`). На тих самих даних — генеральна репетиція: 0007 → 0008 (`reminders_sent` збережено рядок у рядок, CHECK з `trend`, `reminders_sent_new` немає) → сид foods (106 / 253, повтор 0). Кроки — розділ «Генеральна репетиція міграцій на дампі прода» нижче.
- **12:33 міграції 0007, 0008** ✅; на проді ті самі свідки, що в репетиції. **Сид foods:** 971 рядок записано, повтор — 0; `foods` 106, `food_aliases` 253, продуктів без аліаса 0, не-`seed` 0.
- **Деплой — збірка впала** (`Could not resolve "@anthropic-ai/sdk"`): `node_modules` worktree ставились під lock Фази 2. Збірка падає до завантаження — прод лишився на `4d96fc62` (сумісний зі схемою). Лікування — `npm ci` після `git switch` на свіжий `main`, потім `deploy:prod`. ⚠️ `npm ci` перевстановлює `node_modules` під запущеним `wrangler tail` — tail вижив, але ріст файлу перевірено `curl /health`.
- **12:35 деплой:** `npm run deploy:prod -- --message "main ff026a3 (3.5)"` → версія `9c67e31b`; `/health` → `ok cron=5m ok=5m`, у tail `scriptVersion` = `9c67e31b`.
- **Тік 12:45:31 (код Фази 3):** `outcome: ok`, `cpuTime` 12 мс, wall 101 мс, `exceptions: []`, `cron tick {sent:0, skipped:0, released:0, errors:0}`; `/health` → `ok cron=0m ok=0m`.
- **Живий пакет 2026-11-22 11:32–11:33 UTC** (людина, PR #40): анкета норми → `nutrition_targets` `formula`, `valid_from` 2026-11-22, 2940 ккал; фото → `ai_usage` `food_photo` `claude-sonnet-5-5`, 6669 + 83 токенів, `cost_micro` 14 168 (= 6669 × 2 + 83 × 10, не резерв 15 000), `aiSpendToday` 14 168 ≤ 300 000; ✅ → `meals` id 1 `confirmed`, 1 позиція (яблуко 180 г, `seed`) зі знімком 94 ккал / 0,5 / 0,4 / 24,8 г, `NULL` у знімку 0; `foods` `ai_estimate` 0, сиріт 0. `processed_updates` 35 → 42.
- **Логи пакета:** `wrangler tail` (12:46–15:46 UTC 21.11) завершився до пакета, тож доказ — Workers Observability (дашборд, лише читання): за 24 год 212 подій, **0 Errors**; 7 × `POST /tg/webhook`, усі `ok`, версія `9c67e31b`; вебхук фото — статус 200, `cpuTime` 112 мс, wall 3,4 с.
- **Розбіжність (не перевірено):** банер Observability пише «You're on Workers Free», а цей RUNBOOK — «платний тариф». `cpuTime` 112 мс пройшов `ok`; тариф звірити в Billing перед Фазою 4.

## Реліз Фази 4 — факти (2026-11-22, 4.4)

До релізу: прод на коді Фази 3 (`main ff026a3`), версія `9c67e31b` (остання і за `versions list`: Secret Change після неї не було; секрети `ALLOWED_TELEGRAM_IDS`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`), міграції 0000–0008. Реліз: `0009_ai_proposals` (лише нові таблиці `ai_proposals`, `chat_turns`), код `main` (`643ccee`). Нових секретів немає: чат і недільний коментар ходять тим самим `ANTHROPIC_API_KEY`.

### План відкату Фази 4 (записано до першої prod-команди)

Сумісність: код Фази 3 зі схемою 0009 працює — нових таблиць не читає, наявні таблиці 0009 не змінює. Код Фази 4 без 0009 падає (пише `chat_turns`, `ai_proposals`). Порядок: міграція → деплой; відкат — спершу код.

1. **Збій міграції 0009** (до деплою): код Фази 3 ще працює. `SELECT name FROM d1_migrations` і `SELECT name FROM sqlite_master WHERE name IN ('ai_proposals','chat_turns')`. Частково створені таблиці не лагодити руками: `time-travel restore --bookmark=<до міграції>` (значення — у коментарі PR 4.4). Атомарність файлу міграції в D1 — не перевірено (як у 3.5).
2. **Збій коду після деплою** (`/health` не `ok`, помилки в Observability/tail, бот мовчить на текст): `npx wrangler rollback 9c67e31b-cc89-4c17-bfc2-9ef550c6cdb9 --env production`. Базу не чіпати (крок «Сумісність»). Пропозиції `pending` код Фази 3 ігнорує; кнопки [Так]/[Ні] (`i:…`) у старих повідомленнях після відкату потрапляють у загальний обробник кнопок тренування (`flow.callback`) і дають тост «Кнопка застаріла» — тиші немає (рев'ю 4.4, Д2).
3. **ШІ дає шкоду** (хибна пропозиція застосувалась, перевитрата) при живій решті: `AI_DAILY_LIMIT_MICRO` (300 000 мкр = $0,30) обмежує лише **добу** — спільно для фото, чату й коментаря. **Місяць кодом не обмежено:** $0,30 × 30 = до **$9**, тоді як ліміт Anthropic Console — $5 (R-3); що робити, коли Console обріже ключ, — крок 5; рішення про місячну межу — `docs/spec/decisions.md`, ВІДКРИТЕ за людиною. Негайно при шкоді — крок 2. Застосовану пропозицію відкочує людина в боті (зміна підходів/вправи — звичайні дані програми), не restore.
4. **Зіпсовано дані:** ще один `npm run backup:prod` → відкат коду → `time-travel restore --bookmark=<до міграції>` (стирає все після bookmark). Вікно Time Travel: тариф Workers не підтверджено (банер Observability — «Workers Free»), тож розраховуй на **≤ 7 днів — bookmark, далі — файл бекапу**: дамп даних `…-data.sql` зі стабільної теки за рецептом «Відкат пізніше ніж за 7 днів» на коміті з міграціями 0000–0008. 30 днів — лише після підтвердження Paid у Billing (рев'ю 4.4, В2).
5. **Console обрізав ключ** (місячний ліміт витрат в Anthropic Console вичерпано; R-3, рев'ю 4.4 В1). **Як упізнати:** `/health` → `ok`, крон `ok`, вебхуки в Observability/tail — `ok`, але кожен виклик ШІ відхиляється з 4xx: на фото людина бачить «Не вдалося розібрати відповідь. Спробуй ще раз.» (`MEAL_INVALID`), у чаті — «Не вдалося отримати відповідь. Спробуй ще раз.» (`CHAT_INVALID`), недільний звіт приходить без 💬. У логах Observability — `anthropic call failed` зі `status` 4xx (фото/чат) або `weekly comment failed`; у `ai_usage` за день нових рядків із `input_tokens > 0` немає (резерв знімається, бо 4xx не оплачується). **Що робити:** відкат коду **не** допомагає (ключ той самий) — людина в Anthropic Console → Limits піднімає місячний ліміт (рекомендовано ≥ $10) або чекає початку місяця; ключ і секрет `ANTHROPIC_API_KEY` не міняти. Без ШІ решта бота працює: тренування, вага, нагадування, `/yizha` з уже записаного.

### Що сталося (2026-11-22, UTC)

- **15:06 бекап:** `npm run backup:prod` → `prod-20261122-150618.sql` (93 920 Б) і `…-data.sql` (73 608 Б); «Рядки (дамп = БД)» для 21 таблиці, серед них `workout_sets` 0, `body_weights` 3, `meals` 1, `nutrition_targets` 1. Обидва файли скопійовано в стабільну `D:\01CLOud CODE\Тренер\backups\` (gitignored): sha256 повного `25d510c0…`, даних `c1807077…` — копія = оригінал.
- **Репетиція на дампі прода** (локальна D1, кроки розділу «Генеральна репетиція»): дамп даних → чиста БД з 0000–0008 → 22 лічильники = прод; `0009` застосовано → `ai_proposals`, `chat_turns` порожні, рядки `meals`, `meal_items`, `nutrition_targets`, `ai_usage`, `reminders_sent`, `body_weights`, `program_exercises` байт у байт до/після, CHECK `kind` відхиляє невалідний рядок на прод-даних.
- **15:06:47 bookmark** до 0009 і знімок «до» — у коментарі PR #47 (не в git).
- **15:08 міграція:** `npm run db:migrate:prod` → `0009_ai_proposals.sql ✅`.
- **15:08 деплой:** `npm run deploy:prod -- --message "main 643ccee (4.4)"` → версія `c7ffa35f`; `git diff origin/main` — лише `docs/`; `/health` → `ok cron=8m ok=8m`, у tail `scriptVersion` = `c7ffa35f`. Секрети (імена): ті самі чотири, нових не треба.
- **Тік 15:15:31 (код Фази 4):** `outcome: ok`, `cpuTime` 25 мс, wall 694 мс, `exceptions: []`, `cron tick {sent:0, skipped:0, released:0, errors:0}`; `/health` → `ok cron=0m ok=0m`. Знімок «після» = «до», крім `d1_migrations` 9 → 10 і нових порожніх `ai_proposals`, `chat_turns`.
- **Репетиція Time Travel на preview** — розділ «Відкат через Time Travel».
- **Живий пакет, чат 15:23 UTC** (людина, PR #47; крок 3 — «Заміни жим ногами на гоблет-присідання»: присідань зі штангою в прод-програмі немає): `chat_turns` 1–6. Відповідь 1 — вага 91 кг (22.11), середня 91,4 (= (935 + 898 + 910) / 3 дг з `body_weights`), норма **2940** ккал / Б 165 / Ж 73 / В 406 = рядок `nutrition_targets` `formula`; відповідь 2 — яблуко 180 г, 94 ккал = знімок `meal_items`. `ai_proposals` id 1 `swap_exercise` `pe:8` «Жим ногами» → «Гоблет-присідання» (день B), `rejected`, `decided_at` є, `applied_at` NULL, `message_id` 57; `program_exercises` — «Жим ногами» на місці (день 2, позиція 2). `ai_usage` 2–4 `chat` `claude-haiku-5-5`: 665 / 886 / 1426 мкр; `aiSpendToday` 22.11 = 17 145 ≤ 300 000. Tail: 4 × `POST /tg/webhook` `ok`, `c7ffa35f`, `cpuTime` 57 / 17 / 40 / 5 мс, wall ≤ 4,1 с, `exceptions` 0; `processed_updates` 42 → 46.
- **Недільний звіт 22.11, 17:00:30 UTC** (19:00 Київ, природний тік на `c7ffa35f`, без ручного крону): `reminders_sent` `report` 22.11, `message_id` 64; `ai_usage` id 5 `weekly_comment` `claude-haiku-5-5`, 415 / 79 токенів, 81 мкр, `created_at` = `sent_at` (коментар згенеровано перед claim); `aiSpendToday` 22.11 = 17 226 (= 17 145 + 81), 5 рядків. Текст — скріншот людини (через оркестратора): «📊 Тиждень 16–22 листопада», «Цього тижня тренувань не було…», «⚖️ Середня вага 91,4 кг» і блок 💬 «…заплановано 3, виконано 0…» — числа коментаря 16, 22, 91,4 зі звіту, 3 і 0 — дозволені малі цілі. Логів цього тіку (tail/Observability) немає: tail зупинено о ~16:40, бо wrangler перелогінено в інший акаунт; БД читалась `--profile trener-old`, лише `SELECT`.

## Генеральна репетиція міграцій на дампі прода

Для релізу з міграцією, що перебудовує таблицю (як 0008), — до `db:migrate:prod`, на локальній D1, без запису в remote (рев'ю 3.5 Д3; уперше — 3.5).

1. `npm run backup:prod` → `backups/prod-<дата>-data.sql` і рядок `Рядки (дамп = БД): …`.
2. Тимчасова тека `T` поза репозиторієм: `T/wrangler.json` = `{"name":"r","compatibility_date":"2026-10-19","d1_databases":[{"binding":"DB","database_name":"trener-prod","database_id":"00000000-0000-0000-0000-000000000000","migrations_dir":"<T>/migrations"}]}` (прямі слеші); у `T/migrations` — **лише** ті файли з `migrations/`, що є в `d1_migrations` прода. Окрема тека — бо `wrangler d1 export --local` не має `--persist-to`, локальна БД живе поруч із конфігом.
3. З `T`: `node <репо>/node_modules/wrangler/bin/wrangler.js d1 migrations apply trener-prod --local`, потім `… d1 execute trener-prod --local --file <репо>/backups/prod-<дата>-data.sql --yes`. Лічильники таблиць одним `SELECT (SELECT count(*) FROM "t") AS "t", …` = рядок `Рядки` з кроку 1 (+ `d1_migrations` від `migrations apply`).
4. Зберегти вміст таблиці, яку перебудовує міграція (`SELECT * … ORDER BY` PK), докопіювати нові міграції в `T/migrations`, знову `migrations apply` — вміст той самий, у `sqlite_master` немає проміжної `*_new`, новий CHECK на місці.
5. Сид нової фази (`node scripts/seed-foods.ts > T/s.sql`) — двічі `execute --file`; другий прогін — `0 rows written`; решта лічильників — як у кроці 3.

Скрипт 3.5 (`rehearse-3.5.mjs`, кроки 2–5 для 0007/0008) — у нотатках сесії, не в git: прив'язаний до конкретних номерів міграцій.
