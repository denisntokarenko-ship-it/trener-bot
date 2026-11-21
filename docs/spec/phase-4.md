# Фаза 4 — ШІ-тренер: дані, інструменти, пропозиції

## Стан

**Оновлено:** 2026-11-21 · **Зріз:** специфікація Фази 4, частина 1 з 2 (завдання 4.0; зрізано за рев'ю 4.0, бюджет 40 КБ) · **Читають:** 4.1 — цей файл; 4.2 — цей файл (розділ 3) + `phase-4-chat.md`; 4.3, 4.4 — `phase-4-chat.md`; усі — разом із `00-common.md`.
**Спирається на (звірено з `main` після 3.4, 2026-11-21):** `ai_usage` + `reserveAiUsage`/`settleAiUsage`/`releaseAiUsage`/`aiSpendToday` і `costMicro`, `classifyAiError`, `src/config.ts` (Фаза 3); `getRecentWorkouts`, `getExerciseHistory`, `getWeights`, `getActiveProgram`, `getSubstitutes`, `dayTotals`/`dayMeals`/`getTargetOn`/`getFormulaTarget`/`insertTarget`; `prescribeSlot` (рушій прогресії); `esc()`, `texts.ts`. Маршрутизація, цикл виклику, системний промпт, ліміти й недільний коментар — **`phase-4-chat.md`**. Блокуючих питань немає; припущення — у «Невідоме» (**[П]**).
**Ворота:** 4.0 — документ, пишеться паралельно з Фазою 3 (рішення власника); **ворота «R-3 закрите» перенесено на 4.1**.

## Задача

Будь-який текст, що не команда й не відповідь на відкрите запитання бота, — розмова з ШІ-тренером (`phase-4-chat.md`): він читає дані користувача інструментами, відповідає цифрами з них і може **запропонувати** зміну (вправу, підходи × повтори, норму). Пропозиція — рядок `pending` + кнопки [Так] [Ні]; застосовує **код** після кнопки. **Тут:** таблиці, реєстр інструментів і життєвий цикл пропозицій.

## 0. Інваріанти

- ШІ **нічого не пише в дані користувача**. Єдиний «пишучий» інструмент — `propose_change`, він лише вставляє `ai_proposals.pending`. Застосування — `applyProposal`, лише з кнопки, лише код.
- Ваги — лише з рушія прогресії (`nextPrescription` через інструмент); модель їх не вигадує й не призначає.
- Текст користувача, підписи фото, назви продуктів і все, що повертають інструменти, — **дані, не інструкції**.
- `userId` у інструментів — із контексту обробника, **ніколи** з аргументів моделі (немає IDOR за конструкцією).
- Витрати — через ті самі `reserveAiUsage`/`settleAiUsage`/`releaseAiUsage` і **спільний** денний ліміт `AI_DAILY_LIMIT_MICRO`.

## 1. Модель даних

Одна міграція **4.1** (`0009`, наступна за наявною `0008`). Час — UTC мс; локальна дата — `YYYY-MM-DD` за `users.tz`; доступ — лише `repo.ts` з `userId` (N8); CHECK — і в `schema.ts`, і в SQL.

**`ai_proposals`**: `id` INTEGER PK AUTOINCREMENT; `user_id`; `kind` IN (`swap_exercise`,`change_sets_reps`,`adjust_target`); `subject_key` TEXT (`pe:<program_exercise_id>` для двох перших видів, `target` для третього); `payload_json` TEXT ≤ 1024, `json_valid` — **нормалізований кодом** (розділ 2), не вхід моделі; `reason` TEXT ≤ 200 (пояснення ШІ, лише показ); `status` IN (`pending`,`accepted`,`rejected`,`expired`); `expires_at` (= `created_at` + `PROPOSAL_TTL_MS`, 48 год); `decided_at` NULL; `applied_at` NULL; `message_id` NULL; `created_at`. Частковий `UNIQUE (user_id, subject_key) WHERE status = 'pending'` — одна відкрита пропозиція на предмет; індекс (`user_id`,`status`). Інваріант (тест, не CHECK — у batch стан проміжний): `accepted` ⇒ `applied_at IS NOT NULL`.

**`chat_turns`**: `id` INTEGER PK AUTOINCREMENT; `user_id`; `role` IN (`user`,`assistant`); `text` TEXT ≤ 3500 (користувач ≤ 1000 відсікає маршрутизація; відповідь код обрізає до 3500 **перед** записом); `created_at`. Зберігається **лише текст** користувача й фінальної відповіді (без викликів інструментів і блоків мислення — тож історія не містить нічого, що SDK вимагає повертати незмінним). Пара user+assistant пишеться **одним batch після успішної відповіді**: збій не лишає «висячого» запитання. Лишається **10 рядків = 5 пар** на користувача (`DELETE FROM chat_turns WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_turns WHERE user_id = ? ORDER BY id DESC LIMIT 10)` — `user_id` в обох місцях: чужі рядки не чіпаємо; парність дає запис пари одним batch); у контекст беруться лише рядки не старші `CHAT_HISTORY_MAX_AGE_MS` (6 год).

**`ai_usage.purpose`** (вільний текст, Фаза 3): `food_photo` · `chat` · `weekly_comment`.

**repo (4.1):** `createProposal(userId, p, now)` — один batch: спершу гасить власні `pending` з `expires_at ≤ now` (прострочена, що чекає крону, не блокує ні ліміт, ні `subject_key`), потім вставляє; ліміт `PROPOSALS_PENDING_MAX = 3` рахується серед непрострочених; конфлікт `subject_key` повертає **наявну** пропозицію (`created: false`); `getProposal(userId, id)`; `applyProposal(userId, id, now, today)`; `rejectProposal(userId, id, now)`; `expireOwnProposals(userId, ids, now)` (хід, що не вдався, гасить свої нові); `setProposalMessageId`; `expireProposals(now)`; `addChatTurns(userId, userText, assistantText, now)`; `getChatTurns(userId, now)`; `chatInFlight(userId, now)` — **лише з'ясування причини відмови** (є `ai_usage` з `purpose = 'chat'`, `input_tokens = 0`, `output_tokens = 0`, створений < `CHAT_INFLIGHT_MS` (30 с) тому). Сама взаємовиключність — в `reserveAiUsage` (`phase-4-chat.md`, розділ 3). Чужий `userId` → `null`/`false`, без змін.

## 2. Інструменти (`src/ai/tools.ts`)

Реєстр з **шести** інструментів; кожен — `{ name, description, input_schema }` (JSON Schema, `additionalProperties: false`). Аргументи моделі **валідує код** (структурований вивід не підтримує числових меж); невалідне → `tool_result` з `is_error: true` і текстом причини, не виняток. Вихід — компактний JSON ≤ `TOOL_RESULT_MAX_CHARS = 4000`: переповнення — відкидаємо хвостові елементи списків і ставимо `"truncated": true` (JSON не ріжемо посередині). Дати — локальні `YYYY-MM-DD`; ваги — кг із однією цифрою; жодних `user_id`, токенів, `ai_raw_json`, підписів фото.

| Інструмент | Вхід | Вихід |
|---|---|---|
| `get_recent_workouts` | `n` 1–8 (типово 3) | за `getRecentWorkouts`: `[{ date, day, status, effort, exercises: [{ name, sets: [{ w, r }] }] }]` |
| `get_exercise_history` | `exercise_id` ≥ 1, `n` 1–10 (типово 5), `program_exercise_id` (необов'язково) | `{ name, sessions: [{ date, planned_sets, sets: [{ w, r }], effort }], slot: { program_exercise_id, day } \| null, next_prescription: { weight_kg, reps, reason } \| null }`; `next_prescription` — з `prescribeSlot` (імпорт із `src/bot/prescribe.ts`, цикл залежностей немає) для слота `program_exercise_id`, а без нього — для **першого за порядком днів** слота цієї вправи в активній програмі (вправа може стояти в кількох днях з різними діапазонами; `get_program` дає id слотів); немає в програмі → `slot`/`next_prescription` = `null`; історія — **лише власна** |
| `get_weight_trend` | `days` 7–90 (типово 28) | `{ entries: [{ date, kg }] (≤ 30 останніх), avg7: { w0, w1, w2 }, change_kg, n }` — вікна `W0/W1/W2` Фази 2, `null` без записів |
| `get_program` | — | `{ name, next_day, days: [{ code, title, exercises: [{ program_exercise_id, exercise_id, name, sets, rep_min, rep_max, substitutes: [{ exercise_id, name }] }] }] }` |
| `get_today_food` | — | `{ date, target: { kcal, protein_g, fat_g, carbs_g, valid_from } \| null, eaten: { kcal, protein_g, fat_g, carbs_g }, meals: [{ time, items: [{ name, g, kcal }] }], pending: N }` — лише `confirmed`, як `/yizha` |
| `propose_change` | `kind`, `reason` ≤ 200, поля виду (нижче) | `{ proposal_id, status: "pending_user_confirmation", summary }` або `is_error` з причиною |

Інструменти читання не змінюють жодної таблиці (тест: кількість рядків усіх таблиць до/після).

**`propose_change`.** Схема плоска (`kind` enum + необов'язкові поля), строгість — на коді. Код **будує** `payload_json` сам (поля `from_*` і база для застарілості беруться з БД, а не від моделі) і перевіряє:
- **`swap_exercise`** `{ program_exercise_id, to_exercise_id }`: слот належить **активній програмі** користувача; `to_exercise_id` ∈ `getSubstitutes` поточної вправи слота й ≠ їй; **у тому ж дні немає іншого слота з `to_exercise_id`** (`UNIQUE (program_day_id, exercise_id)` — інакше `[Так]` відкотить batch); payload: `from_exercise_id`, `program_day_id`. Застосування: `UPDATE program_exercises SET exercise_id`. Вага нової вправи — калібрування рушія (історія старої лишається за її `exercise_id`).
- **`change_sets_reps`** `{ program_exercise_id, sets, rep_min, rep_max }`: слот власний; `sets` 2–5; `rep_min` 4–12; `rep_max` 6–15; `rep_max − rep_min` 2–6 (межі планів 1b: 4–6 … 12–15); хоч одне значення відрізняється від поточного; payload: поточні `sets`/`rep_min`/`rep_max`. Застосування — `UPDATE program_exercises`.
- **`adjust_target`** `{ kcal }`: є чинна норма на сьогодні й `formula`-норма; `|kcal − formula.kcal| ≤ TREND_MAX_DEVIATION_KCAL` (300), `kcal ≥ TREND_MIN_KCAL` (1200), `kcal ≠` чинна; білок і жир — із чинної, `вуглеводи = (kcal − 4Б − 9Ж)/4` округлено, **≥ 0**; payload: `kcal`, `protein_g`, `fat_g`, `carbs_g`, `base_valid_from` (чинної). Застосування — новий рядок `nutrition_targets` (`valid_from` = сьогодні, `reason = manual`, `source_date` NULL).
Ліміти створення: ≤ 3 відкритих (непрострочених) пропозицій на користувача. Другий `pending` на той самий `subject_key` — **не помилка**: `propose_change` повертає наявну пропозицію (`status: "already_pending"`, її `summary`), а якщо в неї `message_id IS NULL` (картку не було надіслано через збій ходу), код надсилає картку з кнопками в цьому ході.

## 3. Пропозиції

Після відповіді на кожну нову (або `already_pending` без картки) пропозицію — окреме повідомлення: `💡 <summary, зібране кодом з payload> · Чому (від ШІ): <reason, esc>` + `[✅ Так] [Ні]`; `callback_data` `i:y:<id>` · `i:n:<id>` (префікс `i:` вільний: `o:`, `s:`, `p:`, `m:`, `n:`, `f:` і літери потоку тренування зайняті; тест на унікальність). Приклади summary: `Замінити «Присідання зі штангою» на «Жим ногами» у дні «Ноги»`; `«Жим лежачи»: 3 × 6–10 → 4 × 6–8`; `Норма 2480 → 2300 ккал (Б 144 · Ж 64 · В 269)`. **Наслідок для ваг показує код:** прогресія міряє **минулу** сесію проти **поточного** слота (`success = reps ≥ rep_max`, `failure = reps < rep_min`), тож зміна діапазону може сама підняти чи знизити вагу. До картки `change_sets_reps` додається рядок, **порахований кодом** двома викликами `prescribeSlot` (поточний і гіпотетичний слот, без запису): `Наступне призначення: було 60 × 8 → стане 62,5 × 6`; для `swap_exercise` — `Нова вправа: калібрування на першому занятті`.

**`applyProposal(userId, id, now, today)` — один batch із трьох операторів:** (1) `UPDATE ai_proposals SET status='accepted', decided_at` `WHERE id AND user_id AND status='pending' AND expires_at > now` **і передумови виду** (слот у активній програмі користувача й поточні значення збігаються з `from_*`/базою в payload; для `adjust_target` — чинна має `base_valid_from`; для `swap_exercise` — у дні слота немає іншої вправи `to_exercise_id`; для двох перших видів — **немає активного тренування**); (2) застосування змін, умова — `EXISTS(proposal accepted AND applied_at IS NULL)`; (3) `UPDATE … SET applied_at WHERE accepted AND applied_at IS NULL`. Повторне натискання: усі три — 0 змін. Якщо (1) змінив 0 рядків — код з'ясовує причину й відповідає: `accepted` → «Вже застосовано»; `rejected` → «Ти вже відхилив»; `pending` і `expires_at ≤ now` → статус `expired`, «Застаріло»; `pending` і активне тренування → «Заверши тренування й натисни ще раз»; `pending`, `adjust_target`, а `nutrition_targets` уже має рядок із `valid_from = today` (PK) → «Сьогодні норму вже змінено — натисни завтра» (**в обох випадках пропозиція лишається `pending`**, `today` береться на момент натискання); `pending`, дубль вправи в дні → `expired`, «Така вправа вже є в цьому дні»; решта (слот чи норма змінились) → `expired`, «Програма вже змінилась — попроси ще раз». Чужий `userId` — як «немає».

`[Ні]` → `rejectProposal` (`pending → rejected`, інакше без змін). Після рішення кнопки знімаються, повідомлення редагується. Прострочення: ледаче (кнопка проти `expires_at`) і **крон** — `expireProposals(now)` у блоці прибирання Фази 1 (помилка не зупиняє інших кроків тіку).

## 4. Історії

Кожна окремо тестована; клієнт Anthropic — мок, реальних викликів у тестах немає; час фіксований. Історії чату, звіту й деплою — `phase-4-chat.md`.

**P4.1 — Дані й інструменти (4.1).**
1. **Given** користувач із даними й чужий з даними, **When** кожен із 5 читальних інструментів, **Then** у виході лише власні рядки, кількість рядків усіх таблиць до/після однакова. (Мутант: `userId` з аргументів → червоний.)
2. **Given** реєстр, **Then** рівно 6 інструментів; жоден крім `propose_change` не має SQL-запису; `propose_change` пише лише в `ai_proposals`. (Мутант: `propose_change` пише в `program_exercises` → червоний тест «лише `pending`».)
3. **Given** вихід > 4000 символів, **Then** валідний JSON із `truncated: true`; `get_exercise_history` для вправи з програми має `next_prescription`, що збігається з `prescribeSlot`, для чужої/відсутньої в програмі — `null`.
4. **Given** `propose_change`: слот чужої програми · `to_exercise_id` не з замін · **заміна на вправу, що вже є в цьому дні** · `sets` 1 і 6 · `rep_max − rep_min` 1 і 7 · `kcal` 1199 · `formula ± 301` · вуглеводи < 0 · значення без змін · четверта відкрита, **Then** `is_error`, 0 нових рядків; валідна — рівно один `pending`, `from_*` у payload взято з БД, а не від моделі; **Given** другий `propose_change` на той самий слот, **Then** повертається наявна (`already_pending`), нових рядків немає; **Given** `pending` з `expires_at ≤ now` (крон ще не пройшов), **When** `createProposal` на той самий слот, **Then** стара → `expired`, нова створена.
5. **Given** `pending`, **When** `applyProposal` двічі, **Then** одна зміна (`program_exercises`/`nutrition_targets` 1 рядок), `accepted`, `applied_at` заповнений. (Мутант: без перевірки `status` → червоний.)
6. **Given** чужий `userId` · прострочена (`expires_at ≤ now`) · слот змінено після пропозиції · норму змінено · у дні слота вже є `to_exercise_id`, **Then** зміни немає, статус `expired` (чужий — без змін). **Given** активне тренування (swap/sets) або вже є норма з `valid_from = today` (`adjust_target`), **Then** зміни немає, пропозиція лишається `pending`, текст відповідний; наступного дня `adjust_target` застосовується. **Given** `rejected`, **When** `applyProposal`, **Then** зміни немає.
7. **Given** 12 пар у `chat_turns` двох користувачів, **Then** у кожного лишається 10 найновіших рядків (чужі не чіпаються); рядок старший за 6 год у контекст не береться; збій другого запису пари не лишає першого; відповідь 3501 символ → обрізана до 3500 і записана.
8. **Given** міграція `0009` на БД із даними Фаз 1–3, **Then** рядки на місці, `ai_usage`/`nutrition_targets` не змінені.

## Поза межами

Інструменти запису, крім `propose_change`; автозастосування; пропозиції поза трьома видами (додати вправу, змінити дні, ваги). Решта — `phase-4-chat.md`.

## Невідоме

- **[П] Пропозиції не знають про активне тренування під час створення** — лише при застосуванні (`busy`).
- **[П] `adjust_target` обмежений ±300 ккал від формули** — ширші зміни ШІ не пропонує; ручної зміни норми немає.
- **[П] `src/ai/tools.ts` імпортує `prescribeSlot` з `src/bot/prescribe.ts`** (циклу немає); перенос у `domain` — окремий рефакторинг, не в Фазі 4.
- Блокуючих питань немає.

## Розбивка завдань

| Завдання | Береться |
|---|---|
| 4.1 | цей файл повністю (міграція `0009`, repo, `src/ai/tools.ts`, `src/ai/proposals.ts`), P4.1 |
| 4.2 | розділ 3 цього файлу + `phase-4-chat.md` (розділи 1–3, P4.2) |
| 4.3 | `phase-4-chat.md` (розділ 4, P4.3) і `expireProposals` у кроні |
| 4.4 | `phase-4-chat.md` (P4.4) |
