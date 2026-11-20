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

export const REMINDER_KINDS = ["train", "weigh", "report"] as const;
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
    check("reminders_sent_kind", sql`${t.kind} IN ('train', 'weigh', 'report')`),
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
