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
