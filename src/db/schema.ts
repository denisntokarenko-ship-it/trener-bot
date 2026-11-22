// Таблиці з'являються міграцією у фазі, яка ними користується. Час — UTC мс.
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey(), // Telegram ID
    firstName: text("first_name").notNull(),
    tz: text("tz").notNull().default("Europe/Kyiv"),
    createdAt: integer("created_at").notNull(),
    // Фаза 2 (0005): розклад нагадувань. CHECK — лише в SQL міграції (ADD COLUMN), схема їх не бачить.
    /** ISO-дні 1 (Пн)…7 (Нд) через кому, зростаюче, без повторів, ≥ 1 день; порядок перевіряє домен. */
    trainingDays: text("training_days").notNull().default("1,3,5"),
    /** `HH:MM`, кратне 15 хв, 05:00–22:00; NULL — вимкнено. */
    remindTime: text("remind_time").default("08:00"),
    weighTime: text("weigh_time").default("07:30"),
  },
  (t) => [check("users_first_name_len", sql`length(${t.firstName}) <= 64`)],
);

export const processedUpdates = sqliteTable(
  "processed_updates",
  {
    updateId: integer("update_id").primaryKey(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("processed_updates_created_at").on(t.createdAt)],
);

// --- Фаза 1: каталог, програма, тренування (docs/spec/phase-1.md, «Схема») ---

/** Каталог спільний для всіх користувачів (без user_id), лише читання з бота. */
export const exercises = sqliteTable(
  "exercises",
  {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    nameUk: text("name_uk").notNull(),
    equipment: text("equipment", { enum: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] }).notNull(),
    weightStepKg: real("weight_step_kg").notNull(),
    minWeightKg: real("min_weight_kg").notNull(),
    muscleGroup: text("muscle_group", { enum: ["legs", "chest", "back", "shoulders", "core"] }).notNull(),
    cuesUk: text("cues_uk").notNull(),
    videoUrl: text("video_url"),
    // Фаза 1b (міграція 0002): стовпці для генератора плану. Nullable, заповнює сид; CHECK — у SQL міграції
    // (ALTER TABLE ADD COLUMN … CHECK), тут лише типи: таблицю exercises не перебудовуємо (на неї вказують FK).
    pattern: text("pattern", { enum: ["squat", "hinge", "hpush", "vpush", "hpull", "vpull", "core", "delt", "legacc"] }),
    kind: text("kind", { enum: ["compound", "accessory"] }),
    place: text("place", { enum: ["gym", "both"] }),
    minLevel: integer("min_level"),
    stress: text("stress"),
  },
  (t) => [
    check("exercises_slug_kebab", sql`${t.slug} <> '' AND ${t.slug} NOT GLOB '*[^a-z0-9-]*'`),
    check("exercises_equipment", sql`${t.equipment} IN ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight')`),
    check("exercises_muscle_group", sql`${t.muscleGroup} IN ('legs', 'chest', 'back', 'shoulders', 'core')`),
    check("exercises_min_weight", sql`${t.minWeightKg} >= 0`),
    check(
      "exercises_step",
      sql`(${t.equipment} = 'bodyweight' AND ${t.weightStepKg} = 0 AND ${t.minWeightKg} = 0) OR (${t.equipment} <> 'bodyweight' AND ${t.weightStepKg} > 0)`,
    ),
    // Рівно 3 непорожні рядки через \n: два переводи рядка, не поспіль і не на краях (рев'ю 1.1, дрібниця 1).
    check(
      "exercises_cues_3_lines",
      sql`length(${t.cuesUk}) - length(replace(${t.cuesUk}, char(10), '')) = 2 AND instr(${t.cuesUk}, char(10) || char(10)) = 0 AND substr(${t.cuesUk}, 1, 1) <> char(10) AND substr(${t.cuesUk}, -1, 1) <> char(10)`,
    ),
  ],
);

/** Напрямлена пара «чим замінити exercise_id». */
export const exerciseSubstitutes = sqliteTable(
  "exercise_substitutes",
  {
    exerciseId: integer("exercise_id").notNull().references(() => exercises.id),
    substituteId: integer("substitute_id").notNull().references(() => exercises.id),
  },
  (t) => [
    primaryKey({ columns: [t.exerciseId, t.substituteId] }),
    check("exercise_substitutes_not_self", sql`${t.exerciseId} <> ${t.substituteId}`),
  ],
);

export const programs = sqliteTable(
  "programs",
  {
    id: integer("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    active: integer("active").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("programs_active", sql`${t.active} IN (0, 1)`),
    // Одна активна програма на користувача — обмеженням БД, не лише кодом.
    uniqueIndex("programs_one_active").on(t.userId).where(sql`active = 1`),
  ],
);

export const programDays = sqliteTable(
  "program_days",
  {
    id: integer("id").primaryKey(),
    programId: integer("program_id").notNull().references(() => programs.id),
    code: text("code").notNull(),
    position: integer("position").notNull(),
    /** Назва дня для людини (0002, CHECK ≤ 40 у SQL); NULL → показ «День <code>». */
    title: text("title"),
  },
  (t) => [
    check("program_days_code_len", sql`length(${t.code}) BETWEEN 1 AND 8`),
    unique("program_days_program_code").on(t.programId, t.code),
    unique("program_days_program_position").on(t.programId, t.position),
  ],
);

/** Слот: вправа на позиції дня + sets × rep_min–rep_max. */
export const programExercises = sqliteTable(
  "program_exercises",
  {
    id: integer("id").primaryKey(),
    programDayId: integer("program_day_id").notNull().references(() => programDays.id),
    exerciseId: integer("exercise_id").notNull().references(() => exercises.id),
    position: integer("position").notNull(),
    sets: integer("sets").notNull(),
    repMin: integer("rep_min").notNull(),
    repMax: integer("rep_max").notNull(),
  },
  (t) => [
    check("program_exercises_sets", sql`${t.sets} BETWEEN 1 AND 10`),
    check("program_exercises_rep_min", sql`${t.repMin} >= 1`),
    check("program_exercises_rep_max", sql`${t.repMax} >= ${t.repMin} AND ${t.repMax} <= 50`),
    unique("program_exercises_day_position").on(t.programDayId, t.position),
    unique("program_exercises_day_exercise").on(t.programDayId, t.exerciseId),
  ],
);

export const workouts = sqliteTable(
  "workouts",
  {
    id: integer("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    programDayId: integer("program_day_id").notNull().references(() => programDays.id),
    status: text("status", { enum: ["active", "done", "abandoned"] }).notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    effort: integer("effort"),
    note: text("note"),
    awaitInput: text("await_input"),
  },
  (t) => [
    check("workouts_status", sql`${t.status} IN ('active', 'done', 'abandoned')`),
    check("workouts_effort", sql`${t.effort} BETWEEN 1 AND 5`),
    check("workouts_finished_iff_not_active", sql`(${t.status} = 'active') = (${t.finishedAt} IS NULL)`),
    check("workouts_done_iff_effort", sql`(${t.status} = 'done') = (${t.effort} IS NOT NULL)`),
    check("workouts_await_only_active", sql`${t.awaitInput} IS NULL OR ${t.status} = 'active'`),
    // Одне active-тренування на користувача — обмеженням БД.
    uniqueIndex("workouts_one_active").on(t.userId).where(sql`status = 'active'`),
    index("workouts_user_started").on(t.userId, t.startedAt),
    index("workouts_status_started").on(t.status, t.startedAt),
  ],
);

export const workoutSets = sqliteTable(
  "workout_sets",
  {
    id: integer("id").primaryKey(),
    workoutId: integer("workout_id").notNull().references(() => workouts.id),
    programExerciseId: integer("program_exercise_id").notNull().references(() => programExercises.id),
    exerciseId: integer("exercise_id").notNull().references(() => exercises.id),
    setNo: integer("set_no").notNull(),
    weightKg: real("weight_kg"),
    reps: integer("reps"),
    prescribedWeightKg: real("prescribed_weight_kg").notNull(),
    prescribedReps: integer("prescribed_reps").notNull(),
    skipped: integer("skipped").notNull().default(0),
  },
  (t) => [
    check("workout_sets_set_no", sql`${t.setNo} BETWEEN 1 AND 10`),
    check("workout_sets_skipped", sql`${t.skipped} IN (0, 1)`),
    // IS NOT NULL — явно: інакше NULL >= 0 дає NULL, і CHECK пропускає непропущений підхід без ваги.
    check(
      "workout_sets_values",
      sql`(${t.skipped} = 1 AND ${t.weightKg} IS NULL AND ${t.reps} IS NULL) OR (${t.skipped} = 0 AND ${t.weightKg} IS NOT NULL AND ${t.reps} IS NOT NULL AND ${t.weightKg} >= 0 AND ${t.reps} BETWEEN 0 AND 50)`,
    ),
    unique("workout_sets_workout_exercise_set").on(t.workoutId, t.exerciseId, t.setNo),
    index("workout_sets_exercise_workout").on(t.exerciseId, t.workoutId),
  ],
);

// --- Фаза 1b: профіль, анкета, стартові ваги (docs/spec/phase-1b.md, §2). Час — UTC мс. ---

const GOALS_SQL = "'lose_fat', 'muscle', 'recomp', 'strength', 'health', 'other'";

/** Профіль користувача. Усе, крім ключа й часу, nullable; `goal NULL` = анкета не пройдена. */
export const userProfiles = sqliteTable(
  "user_profiles",
  {
    userId: integer("user_id").primaryKey().references(() => users.id),
    goal: text("goal", { enum: ["lose_fat", "muscle", "recomp", "strength", "health", "other"] }),
    goalNote: text("goal_note"),
    level: text("level", { enum: ["novice", "mid", "adv"] }),
    daysPerWeek: integer("days_per_week"),
    sessionMin: integer("session_min"),
    place: text("place", { enum: ["gym", "home"] }),
    /** Прапорці через кому з {knee, back, shoulder, wrist}; '' = немає. */
    limits: text("limits"),
    limitsNote: text("limits_note"),
    sex: text("sex", { enum: ["m", "f"] }),
    birthYear: integer("birth_year"),
    heightCm: integer("height_cm"),
    weightKg: real("weight_kg"),
    mealsPerDay: integer("meals_per_day"),
    dietNote: text("diet_note"),
    sleepBand: text("sleep_band", { enum: ["lt6", "6_7", "7_8", "8p"] }),
    activity: text("activity", { enum: ["low", "mid", "high"] }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("user_profiles_goal", sql`${t.goal} IS NULL OR ${t.goal} IN (${sql.raw(GOALS_SQL)})`),
    check("user_profiles_goal_note", sql`${t.goalNote} IS NULL OR length(${t.goalNote}) <= 300`),
    check("user_profiles_level", sql`${t.level} IS NULL OR ${t.level} IN ('novice', 'mid', 'adv')`),
    check("user_profiles_days", sql`${t.daysPerWeek} IS NULL OR ${t.daysPerWeek} BETWEEN 2 AND 5`),
    check("user_profiles_session_min", sql`${t.sessionMin} IS NULL OR ${t.sessionMin} IN (30, 45, 60, 90)`),
    check("user_profiles_place", sql`${t.place} IS NULL OR ${t.place} IN ('gym', 'home')`),
    // Лише дозволені прапорці через кому: без токенів поза переліком, без порожніх (',,'), країв-ком і літер-залишків.
    check(
      "user_profiles_limits",
      sql`${t.limits} IS NULL OR ${t.limits} = '' OR (${t.limits} NOT LIKE ',%' AND ${t.limits} NOT LIKE '%,' AND ${t.limits} NOT LIKE '%,,%' AND replace(replace(replace(replace(replace(${t.limits}, 'knee', ''), 'back', ''), 'shoulder', ''), 'wrist', ''), ',', '') = '')`,
    ),
    check("user_profiles_limits_note", sql`${t.limitsNote} IS NULL OR length(${t.limitsNote}) <= 300`),
    check("user_profiles_sex", sql`${t.sex} IS NULL OR ${t.sex} IN ('m', 'f')`),
    check("user_profiles_birth_year", sql`${t.birthYear} IS NULL OR ${t.birthYear} BETWEEN 1930 AND 2020`),
    check("user_profiles_height", sql`${t.heightCm} IS NULL OR ${t.heightCm} BETWEEN 120 AND 230`),
    check("user_profiles_weight", sql`${t.weightKg} IS NULL OR ${t.weightKg} BETWEEN 30 AND 300`),
    check("user_profiles_meals", sql`${t.mealsPerDay} IS NULL OR ${t.mealsPerDay} BETWEEN 1 AND 5`),
    check("user_profiles_diet_note", sql`${t.dietNote} IS NULL OR length(${t.dietNote}) <= 300`),
    check("user_profiles_sleep", sql`${t.sleepBand} IS NULL OR ${t.sleepBand} IN ('lt6', '6_7', '7_8', '8p')`),
    check("user_profiles_activity", sql`${t.activity} IS NULL OR ${t.activity} IN ('low', 'mid', 'high')`),
  ],
);

export const ONBOARDING_STEPS = [
  "welcome", "goal", "goal_note", "level", "days", "minutes", "place", "limits", "limits_note", "lifts",
  "sex", "birth", "height", "weight", "meals", "diet", "sleep", "activity", "plan",
] as const;

/** Стан анкети: лише крок; відповіді лежать у профілі й start_weights. */
export const onboardingState = sqliteTable(
  "onboarding_state",
  {
    userId: integer("user_id").primaryKey().references(() => users.id),
    status: text("status", { enum: ["active", "done"] }).notNull(),
    step: text("step", { enum: ONBOARDING_STEPS }).notNull(),
    sub: integer("sub").notNull().default(0),
    msgId: integer("msg_id"),
    planVariant: integer("plan_variant").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("onboarding_state_status", sql`${t.status} IN ('active', 'done')`),
    check("onboarding_state_step", sql`${t.step} IN (${sql.raw(ONBOARDING_STEPS.map((s) => `'${s}'`).join(", "))})`),
    check("onboarding_state_sub", sql`${t.sub} BETWEEN 0 AND 3`),
    check("onboarding_state_variant", sql`${t.planVariant} BETWEEN 0 AND 2`),
  ],
);

/** Робочі ваги з анкети: стартова вага прогресії замість калібрування (діє лише без історії вправи). */
export const startWeights = sqliteTable(
  "start_weights",
  {
    userId: integer("user_id").notNull().references(() => users.id),
    exerciseId: integer("exercise_id").notNull().references(() => exercises.id),
    weightKg: real("weight_kg").notNull(),
    reps: integer("reps").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.exerciseId] }),
    check("start_weights_weight", sql`${t.weightKg} >= 0`),
    check("start_weights_reps", sql`${t.reps} BETWEEN 1 AND 30`),
  ],
);

/** Вага тіла: один запис на локальну дату (`users.tz`); `weight_dg` — десяті кілограма (78,4 кг = 784). */
export const bodyWeights = sqliteTable(
  "body_weights",
  {
    userId: integer("user_id").notNull().references(() => users.id),
    localDate: text("local_date").notNull(),
    weightDg: integer("weight_dg").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.localDate] }),
    check("body_weights_dg", sql`${t.weightDg} BETWEEN 300 AND 3000`),
    check("body_weights_date", sql`${t.localDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  ],
);

export const REMINDER_KINDS = ["train", "weigh", "report", "trend"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Заявка на нагадування: ключ ідемпотентності (user, kind, local_date). Не чиститься (≈ 3 рядки на день). */
export const remindersSent = sqliteTable(
  "reminders_sent",
  {
    userId: integer("user_id").notNull().references(() => users.id),
    kind: text("kind", { enum: REMINDER_KINDS }).notNull(),
    localDate: text("local_date").notNull(),
    sentAt: integer("sent_at").notNull(),
    /** message_id повідомлення Telegram; NULL — ще не надіслано або доля невідома (крах / таймаут). */
    messageId: integer("message_id"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.localDate] }),
    check("reminders_sent_kind", sql`${t.kind} IN ('train', 'weigh', 'report', 'trend')`),
    check("reminders_sent_date", sql`${t.localDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  ],
);

/** Один рядок (id = 1): коли востаннє відпрацював крон. `/health` показує вік. */
export const cronState = sqliteTable(
  "cron_state",
  {
    id: integer("id").primaryKey(),
    lastTickAt: integer("last_tick_at").notNull(),
    /** Останній тік без помилок (0006); NULL — таких ще не було. `/health` показує обидва віки. */
    lastOkAt: integer("last_ok_at"),
  },
  (t) => [check("cron_state_single", sql`${t.id} = 1`)],
);

// --- Фаза 3 (0007): харчування, норма КБЖУ, облік витрат на ШІ (docs/spec/phase-3.md §1) ---

const LOCAL_DATE_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";

export const FOOD_SOURCES = ["seed", "ai_estimate", "manual"] as const;
export type FoodSource = (typeof FOOD_SOURCES)[number];
export const MEAL_STATUSES = ["pending", "confirmed", "cancelled"] as const;
export type MealStatus = (typeof MEAL_STATUSES)[number];
export const MEAL_CONFIDENCES = ["low", "medium", "high"] as const;
export type MealConfidence = (typeof MEAL_CONFIDENCES)[number];
export const TARGET_REASONS = ["formula", "trend", "manual"] as const;
export type TargetReason = (typeof TARGET_REASONS)[number];

/** Каталог продуктів спільний для всіх користувачів (без user_id), як `exercises`. Макроси — десяті грама на 100 г. */
export const foods = sqliteTable(
  "foods",
  {
    id: integer("id").primaryKey(),
    nameUk: text("name_uk").notNull(),
    kcal100: integer("kcal_100").notNull(),
    protein100Dg: integer("protein_100_dg").notNull(),
    fat100Dg: integer("fat_100_dg").notNull(),
    carbs100Dg: integer("carbs_100_dg").notNull(),
    source: text("source", { enum: FOOD_SOURCES }).notNull(),
    /** fdc_id у USDA SR Legacy для `seed`; ключ ідемпотентності сиду. */
    fdcRef: text("fdc_ref"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("foods_name_len", sql`length(${t.nameUk}) BETWEEN 1 AND 60`),
    check("foods_kcal", sql`${t.kcal100} BETWEEN 0 AND 900`),
    check("foods_protein", sql`${t.protein100Dg} BETWEEN 0 AND 1000`),
    check("foods_fat", sql`${t.fat100Dg} BETWEEN 0 AND 1000`),
    check("foods_carbs", sql`${t.carbs100Dg} BETWEEN 0 AND 1000`),
    check("foods_macros_sum", sql`${t.protein100Dg} + ${t.fat100Dg} + ${t.carbs100Dg} <= 1000`),
    check("foods_source", sql`${t.source} IN ('seed', 'ai_estimate', 'manual')`),
    uniqueIndex("foods_fdc_ref_uq").on(t.fdcRef).where(sql`${t.fdcRef} IS NOT NULL`),
  ],
);

/** `alias` — лише результат `normalizeAlias` (src/domain/text.ts). */
export const foodAliases = sqliteTable(
  "food_aliases",
  {
    alias: text("alias").primaryKey(),
    foodId: integer("food_id").notNull().references(() => foods.id, { onDelete: "cascade" }),
  },
  (t) => [check("food_aliases_alias", sql`${t.alias} <> ''`), index("food_aliases_food").on(t.foodId)],
);

export const meals = sqliteTable(
  "meals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    status: text("status", { enum: MEAL_STATUSES }).notNull(),
    /** UTC мс (message.date фото × 1000). */
    eatenAt: integer("eaten_at").notNull(),
    /** За `users.tz` на момент `eaten_at`; після запису не змінюється. */
    localDate: text("local_date").notNull(),
    photoFileId: text("photo_file_id"),
    caption: text("caption"),
    aiModel: text("ai_model").notNull(),
    aiRawJson: text("ai_raw_json").notNull(),
    messageId: integer("message_id"),
    awaitGramsAt: integer("await_grams_at"),
    createdAt: integer("created_at").notNull(),
    confirmedAt: integer("confirmed_at"),
  },
  (t) => [
    check("meals_status", sql`${t.status} IN ('pending', 'confirmed', 'cancelled')`),
    check("meals_local_date", sql`${t.localDate} GLOB ${sql.raw(`'${LOCAL_DATE_GLOB}'`)}`),
    check("meals_caption_len", sql`${t.caption} IS NULL OR length(${t.caption}) <= 300`),
    check("meals_raw_len", sql`length(${t.aiRawJson}) <= 8192`),
    index("meals_user_date_status").on(t.userId, t.localDate, t.status),
  ],
);

/** Позиція прийому. Знімок КБЖУ (чотири поля разом або жодного) з'являється при `confirmMeal`. */
export const mealItems = sqliteTable(
  "meal_items",
  {
    mealId: integer("meal_id").notNull().references(() => meals.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    foodId: integer("food_id").notNull().references(() => foods.id),
    grams: integer("grams").notNull(),
    confidence: text("confidence", { enum: MEAL_CONFIDENCES }).notNull(),
    kcal: integer("kcal"),
    proteinDg: integer("protein_dg"),
    fatDg: integer("fat_dg"),
    carbsDg: integer("carbs_dg"),
  },
  (t) => [
    primaryKey({ columns: [t.mealId, t.position] }),
    check("meal_items_position", sql`${t.position} BETWEEN 1 AND 8`),
    check("meal_items_grams", sql`${t.grams} BETWEEN 1 AND 2000`),
    check("meal_items_confidence", sql`${t.confidence} IN ('low', 'medium', 'high')`),
    check("meal_items_snapshot_nonneg", sql`${t.kcal} >= 0 AND ${t.proteinDg} >= 0 AND ${t.fatDg} >= 0 AND ${t.carbsDg} >= 0`),
    check(
      "meal_items_snapshot_all_or_none",
      sql`(${t.kcal} IS NULL) = (${t.proteinDg} IS NULL) AND (${t.kcal} IS NULL) = (${t.fatDg} IS NULL) AND (${t.kcal} IS NULL) = (${t.carbsDg} IS NULL)`,
    ),
    index("meal_items_food").on(t.foodId),
  ],
);

/** Чинна норма на дату D — рядок з максимальним `valid_from <= D`. */
export const nutritionTargets = sqliteTable(
  "nutrition_targets",
  {
    userId: integer("user_id").notNull().references(() => users.id),
    validFrom: text("valid_from").notNull(),
    kcal: integer("kcal").notNull(),
    proteinG: integer("protein_g").notNull(),
    fatG: integer("fat_g").notNull(),
    carbsG: integer("carbs_g").notNull(),
    reason: text("reason", { enum: TARGET_REASONS }).notNull(),
    /** Для `trend` — дата пропозиції (ключ ідемпотентності). */
    sourceDate: text("source_date"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.validFrom] }),
    check("nutrition_targets_valid_from", sql`${t.validFrom} GLOB ${sql.raw(`'${LOCAL_DATE_GLOB}'`)}`),
    check("nutrition_targets_kcal", sql`${t.kcal} BETWEEN 800 AND 6000`),
    check("nutrition_targets_macros", sql`${t.proteinG} >= 0 AND ${t.fatG} >= 0 AND ${t.carbsG} >= 0`),
    check("nutrition_targets_reason", sql`${t.reason} IN ('formula', 'trend', 'manual')`),
    check("nutrition_targets_source_date", sql`${t.sourceDate} IS NULL OR ${t.sourceDate} GLOB ${sql.raw(`'${LOCAL_DATE_GLOB}'`)}`),
    uniqueIndex("nutrition_targets_source_uq").on(t.userId, t.sourceDate).where(sql`${t.sourceDate} IS NOT NULL`),
  ],
);

/** Резервування, що стає фактом: рядок з'являється до виклику з оцінкою, після відповіді оновлюється ціною з `usage`. */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** Мільйонні частки USD ($0,01 = 10 000). */
    costMicro: integer("cost_micro").notNull(),
    /** Без закритого CHECK: Фаза 4 додасть `chat` без перебудови таблиці. */
    purpose: text("purpose").notNull(),
    localDate: text("local_date").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("ai_usage_tokens", sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0`),
    check("ai_usage_cost", sql`${t.costMicro} >= 0`),
    check("ai_usage_purpose", sql`length(${t.purpose}) BETWEEN 1 AND 32`),
    check("ai_usage_local_date", sql`${t.localDate} GLOB ${sql.raw(`'${LOCAL_DATE_GLOB}'`)}`),
    index("ai_usage_user_date").on(t.userId, t.localDate),
  ],
);

// --- Фаза 4: пропозиції ШІ й контекст чату (docs/spec/phase-4.md, розділ 1) ---

export const PROPOSAL_KINDS = ["swap_exercise", "change_sets_reps", "adjust_target"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * Пропозиція ШІ: рядок `pending`, який застосовує лише код після кнопки. `payload_json` будує код (не модель).
 * Інваріант (тест, не CHECK — у batch стан проміжний): `accepted` ⇒ `applied_at IS NOT NULL`.
 */
export const aiProposals = sqliteTable(
  "ai_proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    kind: text("kind", { enum: PROPOSAL_KINDS }).notNull(),
    /** `pe:<program_exercise_id>` для двох перших видів, `target` для норми: одна відкрита пропозиція на предмет. */
    subjectKey: text("subject_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull(),
    expiresAt: integer("expires_at").notNull(),
    decidedAt: integer("decided_at"),
    appliedAt: integer("applied_at"),
    messageId: integer("message_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("ai_proposals_kind", sql`${t.kind} IN ('swap_exercise', 'change_sets_reps', 'adjust_target')`),
    check("ai_proposals_status", sql`${t.status} IN ('pending', 'accepted', 'rejected', 'expired')`),
    check("ai_proposals_subject", sql`length(${t.subjectKey}) BETWEEN 1 AND 32`),
    check("ai_proposals_payload", sql`length(${t.payloadJson}) <= 1024 AND json_valid(${t.payloadJson})`),
    check("ai_proposals_reason", sql`length(${t.reason}) BETWEEN 1 AND 200`),
    uniqueIndex("ai_proposals_pending_uq").on(t.userId, t.subjectKey).where(sql`${t.status} = 'pending'`),
    index("ai_proposals_user_status").on(t.userId, t.status),
  ],
);

/** Лише текст користувача й фінальної відповіді (без викликів інструментів і блоків мислення). */
export const chatTurns = sqliteTable(
  "chat_turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check("chat_turns_role", sql`${t.role} IN ('user', 'assistant')`),
    check("chat_turns_text", sql`length(${t.text}) BETWEEN 1 AND 3500`),
    index("chat_turns_user_id").on(t.userId, t.id),
  ],
);
