// Єдиний вхід у D1. Функції над даними користувача приймають userId (N8): чужий рядок для них не існує —
// читання дає null / [], запис — false без змін (phase-1.md, «Ізоляція»). Винятки без userId:
// processed_updates (службова, ключ — update_id), foods і food_aliases (спільний каталог, як exercises), expirePendingMeals, abandonStale і getReminderUsers (крон по всіх користувачах) та cron_state (один рядок).
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import type { Limit, Plan, PlanCatalogItem } from "../domain/plan";
import type { ProgressSetRow } from "../domain/records";
import { parseReminderTime, parseTrainingDays } from "../domain/reminders";
import { parseTimezone } from "../domain/settings";
import { normalizeAlias } from "../domain/text";
import { bodyWeights, cronState, exerciseSubstitutes, exercises, onboardingState, processedUpdates, programDays, programExercises, programs, remindersSent, startWeights, userProfiles, users, workoutSets, workouts, type FoodSource, type MealConfidence, type MealStatus, type ReminderKind, type TargetReason } from "./schema";

export const FIRST_NAME_MAX = 64;
/** active старше за цей вік закривається як abandoned (phase-1-flow.md). */
export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export type Equipment = (typeof exercises.equipment.enumValues)[number];
export type MuscleGroup = (typeof exercises.muscleGroup.enumValues)[number];
export type WorkoutStatus = (typeof workouts.status.enumValues)[number];

export interface Exercise {
  id: number;
  slug: string;
  nameUk: string;
  equipment: Equipment;
  weightStepKg: number;
  minWeightKg: number;
  muscleGroup: MuscleGroup;
  cues: string[];
  videoUrl: string | null;
}

export interface ActiveProgram {
  id: number;
  name: string;
  /** За position. */
  days: { id: number; code: string; position: number; title: string | null }[];
}

export interface Slot {
  /** program_exercises.id */
  id: number;
  position: number;
  sets: number;
  repMin: number;
  repMax: number;
  exercise: Exercise;
}

export interface ProgramDay {
  id: number;
  programId: number;
  code: string;
  position: number;
  /** Назва дня (0002); NULL → показ «День <code>». */
  title: string | null;
  /** За position. */
  slots: Slot[];
}

export interface Workout {
  id: number;
  programDayId: number;
  dayCode: string;
  status: WorkoutStatus;
  startedAt: number;
  finishedAt: number | null;
  effort: number | null;
  /** Сирий JSON стану очікування ваги; зміст визначає потік 1.3. */
  awaitInput: string | null;
}

/** Тренування для /progres: підходи згруповано за слотами (за position), вправа — фактично виконана. */
export interface WorkoutSummaryRow {
  id: number;
  dayCode: string;
  /** Назва дня (NULL → показ за кодом). */
  dayTitle: string | null;
  status: Exclude<WorkoutStatus, "active">;
  startedAt: number;
  effort: number | null;
  exercises: { nameUk: string; sets: HistorySet[] }[];
}

export interface SetInput {
  workoutId: number;
  programExerciseId: number;
  /** Фактично виконана вправа (вправа слота або заміна). */
  exerciseId: number;
  setNo: number;
  /** null — лише для пропущеного підходу (інакше CHECK workout_sets_values). */
  weightKg: number | null;
  reps: number | null;
  prescribedWeightKg: number;
  prescribedReps: number;
  skipped: boolean;
}

export interface HistorySet {
  setNo: number;
  weightKg: number | null;
  reps: number | null;
  skipped: boolean;
}

/** Сесія вправи в одному тренуванні — вхід рушія прогресії (phase-1.md, «Правила прогресії»). */
export interface HistorySession {
  workoutId: number;
  status: Exclude<WorkoutStatus, "active">;
  startedAt: number;
  effort: number | null;
  /** sets слота, за яким записано підходи; один на сесію — upsertSet не переносить підхід між слотами. */
  plannedSets: number;
  /** За set_no. Відсутні підходи обірваного тренування тут не з'являються — їх добудовує рушій. */
  sets: HistorySet[];
}

/** Підхід тренування як його бачить потік: слот, фактична вправа, факт і знімок призначення. */
export interface WorkoutSetRow {
  programExerciseId: number;
  exerciseId: number;
  setNo: number;
  weightKg: number | null;
  reps: number | null;
  skipped: boolean;
  prescribedWeightKg: number;
  prescribedReps: number;
}

const workoutColumns = {
  id: workouts.id,
  programDayId: workouts.programDayId,
  dayCode: programDays.code,
  status: workouts.status,
  startedAt: workouts.startedAt,
  finishedAt: workouts.finishedAt,
  effort: workouts.effort,
  awaitInput: workouts.awaitInput,
};

export type ProfileRow = typeof userProfiles.$inferSelect;
/** Поля профілю, які анкета пише по одному; ключ і час ставить repo. */
export type ProfilePatch = Partial<Omit<ProfileRow, "userId" | "createdAt" | "updatedAt">>;
export type OnboardingRow = typeof onboardingState.$inferSelect;
export type OnboardingPatch = Partial<Omit<OnboardingRow, "userId" | "startedAt" | "updatedAt">>;
export interface ReminderUserRow {
  id: number;
  tz: string;
  trainingDays: string;
  remindTime: string | null;
  weighTime: string | null;
}
export interface UserSettings {
  tz: string;
  trainingDays: string;
  remindTime: string | null;
  weighTime: string | null;
}
export type SettingsPatch = Partial<UserSettings>;
export interface StartWeight {
  exerciseId: number;
  weightKg: number;
  reps: number;
}
export type ActivatePlanResult = { ok: true; programId: number } | { ok: false; error: "ACTIVE_WORKOUT" | "NO_USER" | "BAD_PLAN" };

// --- Фаза 3: харчування (phase-3.md §1). Макроси — десяті грама, ккал — цілі. ---

/** Продукт каталогу; значення — на 100 г. */
export interface Food {
  id: number;
  nameUk: string;
  kcal100: number;
  protein100Dg: number;
  fat100Dg: number;
  carbs100Dg: number;
  source: FoodSource;
  fdcRef: string | null;
}
/** Оцінка моделі для невідомого продукту (значення на 100 г, макроси вже в десятих грама). */
export interface EstimatedFood {
  nameUk: string;
  kcal100: number;
  protein100Dg: number;
  fat100Dg: number;
  carbs100Dg: number;
}
export interface NewMeal {
  eatenAt: number;
  localDate: string;
  photoFileId: string | null;
  caption: string | null;
  aiModel: string;
  aiRawJson: string;
  messageId?: number | null;
  /** 1–8 позицій; `position` = індекс + 1. */
  items: { foodId: number; grams: number; confidence: MealConfidence }[];
}
export interface Nutrients {
  kcal: number;
  proteinDg: number;
  fatDg: number;
  carbsDg: number;
}
export interface MealItemView {
  position: number;
  foodId: number;
  nameUk: string;
  grams: number;
  confidence: MealConfidence;
  source: FoodSource;
  /** Поточні значення з `foods` (показ `pending`). */
  food: Nutrients;
  /** Знімок на момент підтвердження; `null` — ще `pending`. */
  snapshot: Nutrients | null;
}
export interface MealView {
  id: number;
  userId: number;
  status: MealStatus;
  eatenAt: number;
  localDate: string;
  photoFileId: string | null;
  caption: string | null;
  aiModel: string;
  messageId: number | null;
  awaitGramsAt: number | null;
  createdAt: number;
  confirmedAt: number | null;
  items: MealItemView[];
}
export interface AiUsageReservation {
  model: string;
  purpose: string;
  localDate: string;
  /** Оцінка вартості виклику, мікро-USD. */
  estMicro: number;
  /** Денний ліміт, мікро-USD. */
  limitMicro: number;
}
export interface AiUsageActual {
  inputTokens: number;
  outputTokens: number;
  costMicro: number;
}
export interface NutritionTarget {
  validFrom: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  reason: TargetReason;
  sourceDate: string | null;
}

interface FoodRow {
  id: number;
  name_uk: string;
  kcal_100: number;
  protein_100_dg: number;
  fat_100_dg: number;
  carbs_100_dg: number;
  source: FoodSource;
  fdc_ref: string | null;
}
const FOOD_COLUMNS = "f.id AS id, f.name_uk AS name_uk, f.kcal_100 AS kcal_100, f.protein_100_dg AS protein_100_dg, f.fat_100_dg AS fat_100_dg, f.carbs_100_dg AS carbs_100_dg, f.source AS source, f.fdc_ref AS fdc_ref";
function toFood(r: FoodRow): Food {
  return { id: r.id, nameUk: r.name_uk, kcal100: r.kcal_100, protein100Dg: r.protein_100_dg, fat100Dg: r.fat_100_dg, carbs100Dg: r.carbs_100_dg, source: r.source, fdcRef: r.fdc_ref };
}

/** DELETE осиротілих `ai_estimate` серед `foodIds` (жодної позиції): аліаси йдуть каскадом. Страж NOT EXISTS не дає зачепити продукт у чужому прийомі. */
function orphanEstimates(d1: D1Database, foodIds: number[]): D1PreparedStatement {
  const marks = foodIds.map(() => "?").join(", ");
  return d1
    .prepare(`DELETE FROM foods WHERE source = 'ai_estimate' AND id IN (${marks}) AND NOT EXISTS (SELECT 1 FROM meal_items mi WHERE mi.food_id = foods.id)`)
    .bind(...foodIds);
}

/** Прийом `pending`, що належить користувачеві: умова-страж для кроків batch. */
const OWN_PENDING_MEAL = "EXISTS (SELECT 1 FROM meals gm WHERE gm.id = ? AND gm.user_id = ? AND gm.status = 'pending')";

/** Прапорці обмежень «knee,back» → масив; невідомі токени відкидаються. */
export function parseLimits(raw: string | null | undefined): Limit[] {
  return (raw ?? "").split(",").filter((x): x is Limit => x === "knee" || x === "back" || x === "shoulder" || x === "wrist");
}

function toExercise(row: typeof exercises.$inferSelect): Exercise {
  const { cuesUk, ...rest } = row;
  return { ...rest, cues: cuesUk.split("\n") };
}

export function createRepo(db: Db) {
  const repo = {
    /** Створює профіль або оновлює first_name; tz і created_at не чіпає. Повертає кількість записаних рядків: без зміни імені — 0. */
    async upsertUser(userId: number, firstName: string, now: number): Promise<number> {
      const name = [...firstName].slice(0, FIRST_NAME_MAX).join("");
      const res = await db
        .insert(users)
        .values({ id: userId, firstName: name, createdAt: now })
        .onConflictDoUpdate({
          target: users.id,
          set: { firstName: sql`excluded.first_name` },
          setWhere: sql`${users.firstName} <> excluded.first_name`,
        })
        .run();
      return res.meta.changes;
    },

    /** true — апдейт новий і щойно записаний; false — уже оброблявся. */
    async markUpdateProcessed(updateId: number, now: number = Date.now()): Promise<boolean> {
      const res = await db
        .insert(processedUpdates)
        .values({ updateId, createdAt: now })
        .onConflictDoNothing()
        .run();
      return res.meta.changes === 1;
    },

    /** Видаляє записи дедупу, старші за olderThan (UTC мс). Повертає кількість видалених. */
    async purgeProcessedUpdates(olderThan: number): Promise<number> {
      const res = await db.delete(processedUpdates).where(lt(processedUpdates.createdAt, olderThan)).run();
      return res.meta.changes;
    },

    /** Активна програма користувача з днями за position; немає — null. */
    async getActiveProgram(userId: number): Promise<ActiveProgram | null> {
      const program = await db
        .select({ id: programs.id, name: programs.name })
        .from(programs)
        .where(and(eq(programs.userId, userId), eq(programs.active, 1)))
        .get();
      if (!program) return null;
      const days = await db
        .select({ id: programDays.id, code: programDays.code, position: programDays.position, title: programDays.title })
        .from(programDays)
        .where(eq(programDays.programId, program.id))
        .orderBy(asc(programDays.position))
        .all();
      return { ...program, days };
    },

    /** День активної програми користувача за кодом (A, B) зі слотами й вправами одним запитом; немає — null. */
    async getProgramDay(userId: number, code: string): Promise<ProgramDay | null> {
      const rows = await db
        .select({
          day: { id: programDays.id, programId: programDays.programId, code: programDays.code, position: programDays.position, title: programDays.title },
          slot: programExercises,
          exercise: exercises,
        })
        .from(programDays)
        .innerJoin(programs, eq(programs.id, programDays.programId))
        .leftJoin(programExercises, eq(programExercises.programDayId, programDays.id))
        .leftJoin(exercises, eq(exercises.id, programExercises.exerciseId))
        .where(and(eq(programs.userId, userId), eq(programs.active, 1), eq(programDays.code, code)))
        .orderBy(asc(programExercises.position))
        .all();
      const day = rows[0]?.day;
      if (!day) return null;
      const slots = rows.flatMap(({ slot, exercise }) =>
        slot && exercise
          ? [{ id: slot.id, position: slot.position, sets: slot.sets, repMin: slot.repMin, repMax: slot.repMax, exercise: toExercise(exercise) }]
          : [],
      );
      return { ...day, slots };
    },

    /** Тренування користувача за id (будь-який статус); чуже чи неіснуюче — null. */
    async getWorkout(userId: number, workoutId: number): Promise<Workout | null> {
      const row = await db
        .select(workoutColumns)
        .from(workouts)
        .innerJoin(programDays, eq(programDays.id, workouts.programDayId))
        .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)))
        .get();
      return row ?? null;
    },

    /** Усі підходи тренування користувача за порядком запису; чуже чи неіснуюче — []. */
    async getWorkoutSets(userId: number, workoutId: number): Promise<WorkoutSetRow[]> {
      const rows = await db
        .select({
          programExerciseId: workoutSets.programExerciseId,
          exerciseId: workoutSets.exerciseId,
          setNo: workoutSets.setNo,
          weightKg: workoutSets.weightKg,
          reps: workoutSets.reps,
          skipped: workoutSets.skipped,
          prescribedWeightKg: workoutSets.prescribedWeightKg,
          prescribedReps: workoutSets.prescribedReps,
        })
        .from(workoutSets)
        .innerJoin(workouts, eq(workouts.id, workoutSets.workoutId))
        .where(and(eq(workoutSets.workoutId, workoutId), eq(workouts.userId, userId)))
        .orderBy(asc(workoutSets.id))
        .all();
      return rows.map((r) => ({ ...r, skipped: r.skipped === 1 }));
    },

    /** Вправа каталогу за id (каталог спільний, лише читання); немає — null. */
    async getExercise(exerciseId: number): Promise<Exercise | null> {
      const row = await db.select().from(exercises).where(eq(exercises.id, exerciseId)).get();
      return row ? toExercise(row) : null;
    },

    /** Вправи каталогу за id (для показу плану); порядок — за id, невідомі id пропускаються. */
    async getExercises(ids: readonly number[]): Promise<Exercise[]> {
      if (ids.length === 0) return [];
      const rows = await db.select().from(exercises).where(inArray(exercises.id, [...ids])).orderBy(asc(exercises.id)).all();
      return rows.map(toExercise);
    },

    /** Чим можна замінити вправу (exercise_substitutes), у порядку каталогу заміни. */
    async getSubstitutes(exerciseId: number): Promise<Exercise[]> {
      const rows = await db
        .select({ exercise: exercises })
        .from(exerciseSubstitutes)
        .innerJoin(exercises, eq(exercises.id, exerciseSubstitutes.substituteId))
        .where(eq(exerciseSubstitutes.exerciseId, exerciseId))
        .orderBy(sql`exercise_substitutes.rowid`) // порядок каталогу: сид вставляє заміни за таблицею спеки
        .all();
      return rows.map((r) => toExercise(r.exercise));
    },

    /** Ставить чи знімає (null) стан очікування ваги; лише для active-тренування користувача, інакше false. */
    async setAwaitInput(userId: number, workoutId: number, value: string | null): Promise<boolean> {
      const res = await db
        .update(workouts)
        .set({ awaitInput: value })
        .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId), eq(workouts.status, "active")))
        .run();
      return res.meta.changes === 1;
    },

    /** Розклад нагадувань і пояс користувача; користувача немає — null. */
    async getUserSettings(userId: number): Promise<UserSettings | null> {
      const row = await db
        .select({ tz: users.tz, trainingDays: users.trainingDays, remindTime: users.remindTime, weighTime: users.weighTime })
        .from(users)
        .where(eq(users.id, userId))
        .get();
      return row ?? null;
    },

    /**
     * Змінює лише передані поля (`undefined` — не чіпати, `null` у часі — вимкнути). Кожне значення проходить ту саму
     * перевірку, що й у кроні; будь-яке невалідне → нічого не пишемо, null. Пояс зберігається канонічним (ICU).
     * Повертає стан після запису; користувача немає — null.
     */
    async updateUserSettings(userId: number, patch: SettingsPatch): Promise<UserSettings | null> {
      const set: SettingsPatch = {};
      if (patch.trainingDays !== undefined) {
        if (parseTrainingDays(patch.trainingDays) === null) return null;
        set.trainingDays = patch.trainingDays;
      }
      for (const k of ["remindTime", "weighTime"] as const) {
        const v = patch[k];
        if (v === undefined) continue;
        if (v !== null && parseReminderTime(v) === null) return null;
        set[k] = v;
      }
      if (patch.tz !== undefined) {
        const tz = parseTimezone(patch.tz);
        if (tz === null) return null;
        set.tz = tz;
      }
      if (Object.keys(set).length > 0) {
        const res = await db.update(users).set(set).where(eq(users.id, userId)).run();
        if (res.meta.changes !== 1) return null;
      }
      return this.getUserSettings(userId);
    },

    /** Часовий пояс користувача (IANA); профілю немає — null. */
    async getUserTz(userId: number): Promise<string | null> {
      const row = await db.select({ tz: users.tz }).from(users).where(eq(users.id, userId)).get();
      return row?.tz ?? null;
    },

    /** Останні n тренувань done і abandoned користувача, від нових до старих, з підходами за слотами. */
    async getRecentWorkouts(userId: number, n: number): Promise<WorkoutSummaryRow[]> {
      if (n <= 0) return [];
      const heads = await db.all<{ id: number; day_code: string; day_title: string | null; status: "done" | "abandoned"; started_at: number; effort: number | null }>(sql`
        SELECT w.id, d.code AS day_code, d.title AS day_title, w.status, w.started_at, w.effort
        FROM workouts w JOIN program_days d ON d.id = w.program_day_id
        WHERE w.user_id = ${userId} AND w.status IN ('done', 'abandoned')
        ORDER BY w.started_at DESC, w.id DESC
        LIMIT ${n}`);
      if (heads.length === 0) return [];
      const rows = await db.all<{
        workout_id: number;
        program_exercise_id: number;
        name_uk: string;
        set_no: number;
        weight_kg: number | null;
        reps: number | null;
        skipped: number;
      }>(sql`
        SELECT s.workout_id, s.program_exercise_id, e.name_uk, s.set_no, s.weight_kg, s.reps, s.skipped
        FROM workout_sets s
        JOIN program_exercises pe ON pe.id = s.program_exercise_id
        JOIN exercises e ON e.id = s.exercise_id
        WHERE s.workout_id IN (
          SELECT w.id FROM workouts w
          WHERE w.user_id = ${userId} AND w.status IN ('done', 'abandoned')
          ORDER BY w.started_at DESC, w.id DESC
          LIMIT ${n})
        ORDER BY s.workout_id, pe.position, s.set_no`);
      return heads.map((h) => {
        const exs: WorkoutSummaryRow["exercises"] = [];
        let lastSlot = -1;
        for (const r of rows) {
          if (r.workout_id !== h.id) continue;
          if (r.program_exercise_id !== lastSlot) {
            exs.push({ nameUk: r.name_uk, sets: [] });
            lastSlot = r.program_exercise_id;
          }
          exs[exs.length - 1]!.sets.push({ setNo: r.set_no, weightKg: r.weight_kg, reps: r.reps, skipped: r.skipped === 1 });
        }
        return { id: h.id, dayCode: h.day_code, dayTitle: h.day_title, status: h.status, startedAt: h.started_at, effort: h.effort, exercises: exs };
      });
    },

    /** Усі зараховані підходи (непропущені, з вагою й повторами ≥ 1) done/abandoned тренувань — вся історія, без вікна (агрегат /progres). */
    async getProgressSets(userId: number): Promise<ProgressSetRow[]> {
      const rows = await db.all<{ exercise_id: number; name_uk: string; equipment: string; workout_id: number; started_at: number; weight_kg: number; reps: number }>(sql`
        SELECT s.exercise_id, e.name_uk, e.equipment, s.workout_id, w.started_at, s.weight_kg, s.reps
        FROM workout_sets s
        JOIN workouts w ON w.id = s.workout_id
        JOIN exercises e ON e.id = s.exercise_id
        WHERE w.user_id = ${userId} AND w.status IN ('done', 'abandoned')
          AND s.skipped = 0 AND s.weight_kg IS NOT NULL AND s.reps >= 1
        ORDER BY w.started_at, w.id, s.set_no`);
      return rows.map((r) => ({
        exerciseId: r.exercise_id,
        nameUk: r.name_uk,
        bodyweight: r.equipment === "bodyweight",
        workoutId: r.workout_id,
        startedAt: r.started_at,
        weightKg: r.weight_kg,
        reps: r.reps,
      }));
    },

    /** Поточне active-тренування користувача; немає — null. */
    async getActiveWorkout(userId: number): Promise<Workout | null> {
      const row = await db
        .select(workoutColumns)
        .from(workouts)
        .innerJoin(programDays, eq(programDays.id, workouts.programDayId))
        .where(and(eq(workouts.userId, userId), eq(workouts.status, "active")))
        .get();
      return row ?? null;
    },

    /**
     * Починає тренування за днем програми користувача. Уже є active — повертає його (created: false),
     * навіть якщо день інший: одне active на користувача тримає індекс workouts_one_active.
     * День не з програми користувача й active немає — null.
     */
    async startWorkout(userId: number, programDayId: number, now: number): Promise<{ workout: Workout; created: boolean } | null> {
      const res = await db.run(sql`
        INSERT INTO workouts (user_id, program_day_id, status, started_at)
        SELECT ${userId}, d.id, 'active', ${now}
        FROM program_days d JOIN programs p ON p.id = d.program_id
        WHERE d.id = ${programDayId} AND p.user_id = ${userId}
        ON CONFLICT DO NOTHING`);
      const workout = await this.getActiveWorkout(userId);
      return workout ? { workout, created: res.meta.changes === 1 } : null;
    },

    /**
     * Записує підхід; повтор того самого (workout, вправа, set_no) перезаписує рядок, а не дублює (N3).
     * Пише лише в active-тренування користувача, лише в слот його дня, лише вправу слота або її заміну
     * (exercise_substitutes) і лише set_no ≤ sets слота; інакше false без змін і без винятку —
     * exerciseId і setNo приходять з кнопки (рев'ю 1.1, В2). Повтор з іншим слотом — теж false:
     * записаний підхід не переїжджає між слотами, тож у сесії один plannedSets.
     * Решту відмов застарілій кнопці (не наступний підхід, закріплена заміна) робить потік (1.3).
     */
    async upsertSet(userId: number, s: SetInput): Promise<boolean> {
      const res = await db.run(sql`
        INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped)
        SELECT w.id, pe.id, ${s.exerciseId}, ${s.setNo}, ${s.weightKg}, ${s.reps}, ${s.prescribedWeightKg}, ${s.prescribedReps}, ${s.skipped ? 1 : 0}
        FROM workouts w JOIN program_exercises pe ON pe.program_day_id = w.program_day_id
        WHERE w.id = ${s.workoutId} AND w.user_id = ${userId} AND w.status = 'active' AND pe.id = ${s.programExerciseId}
          AND ${s.setNo} <= pe.sets
          AND (${s.exerciseId} = pe.exercise_id OR EXISTS (SELECT 1 FROM exercise_substitutes es WHERE es.exercise_id = pe.exercise_id AND es.substitute_id = ${s.exerciseId}))
        ON CONFLICT (workout_id, exercise_id, set_no) DO UPDATE SET weight_kg = excluded.weight_kg, reps = excluded.reps, prescribed_weight_kg = excluded.prescribed_weight_kg, prescribed_reps = excluded.prescribed_reps, skipped = excluded.skipped
          WHERE workout_sets.program_exercise_id = excluded.program_exercise_id`);
      return res.meta.changes === 1;
    },

    /** active → done з оцінкою 1–5; await_input обнуляється. Повторна оцінка, чуже чи неактивне — false без змін. */
    async finishWorkout(userId: number, workoutId: number, effort: number, now: number): Promise<boolean> {
      const res = await db
        .update(workouts)
        .set({ status: "done", effort, finishedAt: now, awaitInput: null })
        .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId), eq(workouts.status, "active")))
        .run();
      return res.meta.changes === 1;
    },

    /** Закриває як abandoned усі active, початі раніше за now − 4 год (рівно 4 год — ще ні). Повертає кількість. */
    async abandonStale(now: number): Promise<number> {
      const res = await db
        .update(workouts)
        .set({ status: "abandoned", finishedAt: now, awaitInput: null })
        .where(and(eq(workouts.status, "active"), lt(workouts.startedAt, now - STALE_AFTER_MS)))
        .run();
      return res.meta.changes;
    },

    /**
     * Останні n сесій вправи (фактично виконаної — exercise_id) з тренувань done і abandoned користувача,
     * від старшої до новішої. Сесія — лише тренування з ≥ 1 непропущеним підходом цієї вправи (спека: повністю
     * пропущена не зараховується), тож пропуски не витісняють зараховані сесії з вікна n (рев'ю Фази 1, В1).
     */
    async getExerciseHistory(userId: number, exerciseId: number, n: number): Promise<HistorySession[]> {
      if (n <= 0) return [];
      const rows = await db.all<{
        workout_id: number;
        status: "done" | "abandoned";
        started_at: number;
        effort: number | null;
        planned_sets: number;
        set_no: number;
        weight_kg: number | null;
        reps: number | null;
        skipped: number;
      }>(sql`
        SELECT w.id AS workout_id, w.status, w.started_at, w.effort, pe.sets AS planned_sets,
               s.set_no, s.weight_kg, s.reps, s.skipped
        FROM workout_sets s
        JOIN workouts w ON w.id = s.workout_id
        JOIN program_exercises pe ON pe.id = s.program_exercise_id
        WHERE s.exercise_id = ${exerciseId} AND w.id IN (
          SELECT w2.id FROM workouts w2
          WHERE w2.user_id = ${userId} AND w2.status IN ('done', 'abandoned')
            AND EXISTS (SELECT 1 FROM workout_sets s2 WHERE s2.workout_id = w2.id AND s2.exercise_id = ${exerciseId} AND s2.skipped = 0)
          ORDER BY w2.started_at DESC, w2.id DESC
          LIMIT ${n})
        ORDER BY w.started_at, w.id, s.set_no`);
      const sessions: HistorySession[] = [];
      for (const r of rows) {
        let last = sessions[sessions.length - 1];
        if (!last || last.workoutId !== r.workout_id) {
          last = { workoutId: r.workout_id, status: r.status, startedAt: r.started_at, effort: r.effort, plannedSets: r.planned_sets, sets: [] };
          sessions.push(last);
        }
        last.sets.push({ setNo: r.set_no, weightKg: r.weight_kg, reps: r.reps, skipped: r.skipped === 1 });
      }
      return sessions;
    },

    /** Останнє done-тренування користувача (за started_at) — для наступного дня; немає — null. */
    async getLastDoneWorkout(userId: number): Promise<Workout | null> {
      const row = await db
        .select(workoutColumns)
        .from(workouts)
        .innerJoin(programDays, eq(programDays.id, workouts.programDayId))
        // Лише активна програма: після активації нового плану лічильник «наступного дня» починається з першого дня (P2.3.12).
        .innerJoin(programs, and(eq(programs.id, programDays.programId), eq(programs.active, 1)))
        .where(and(eq(workouts.userId, userId), eq(workouts.status, "done")))
        .orderBy(desc(workouts.startedAt), desc(workouts.id))
        .get();
      return row ?? null;
    },

    /** Профіль користувача; рядка немає — null. */
    async getProfile(userId: number): Promise<ProfileRow | null> {
      return (await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).get()) ?? null;
    },

    /** Створює профіль або оновлює лише передані поля (відповідь анкети пишеться одразу, повтор — upsert). */
    async upsertProfile(userId: number, patch: ProfilePatch, now: number): Promise<void> {
      await db
        .insert(userProfiles)
        .values({ ...patch, userId, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: userProfiles.userId, set: { ...patch, updatedAt: now } })
        .run();
    },

    async getOnboarding(userId: number): Promise<OnboardingRow | null> {
      return (await db.select().from(onboardingState).where(eq(onboardingState.userId, userId)).get()) ?? null;
    },

    /** Створює стан анкети або оновлює передані поля; started_at при оновленні не чіпає. */
    async upsertOnboarding(userId: number, patch: OnboardingPatch, now: number): Promise<void> {
      await db
        .insert(onboardingState)
        .values({ status: "active", step: "welcome", ...patch, userId, startedAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: onboardingState.userId, set: { ...patch, updatedAt: now } })
        .run();
    },

    /** Запис робочої ваги вправи; повтор — upsert (N3). */
    async setStartWeight(userId: number, exerciseId: number, weightKg: number, reps: number, now: number): Promise<void> {
      await db
        .insert(startWeights)
        .values({ userId, exerciseId, weightKg, reps, createdAt: now })
        .onConflictDoUpdate({ target: [startWeights.userId, startWeights.exerciseId], set: { weightKg, reps, createdAt: now } })
        .run();
    },

    async getStartWeight(userId: number, exerciseId: number): Promise<StartWeight | null> {
      const row = await db
        .select({ exerciseId: startWeights.exerciseId, weightKg: startWeights.weightKg, reps: startWeights.reps })
        .from(startWeights)
        .where(and(eq(startWeights.userId, userId), eq(startWeights.exerciseId, exerciseId)))
        .get();
      return row ?? null;
    },

    async getStartWeights(userId: number): Promise<StartWeight[]> {
      return db
        .select({ exerciseId: startWeights.exerciseId, weightKg: startWeights.weightKg, reps: startWeights.reps })
        .from(startWeights)
        .where(eq(startWeights.userId, userId))
        .orderBy(asc(startWeights.exerciseId))
        .all();
    },

    /** «Не знаю» після раніше введеної ваги: прибирає запис. */
    async clearStartWeight(userId: number, exerciseId: number): Promise<void> {
      await db.delete(startWeights).where(and(eq(startWeights.userId, userId), eq(startWeights.exerciseId, exerciseId))).run();
    },

    /** Каталог для buildPlan: лише вправи з заповненими метаданими (pattern NULL для генератора не існує). */
    async getPlanCatalog(): Promise<PlanCatalogItem[]> {
      const rows = await db.select().from(exercises).orderBy(asc(exercises.id)).all();
      return rows.flatMap((r) =>
        r.pattern && r.kind && r.place && r.minLevel !== null
          ? [{ id: r.id, pattern: r.pattern, kind: r.kind, place: r.place, minLevel: r.minLevel, stress: parseLimits(r.stress), equipment: r.equipment }]
          : [],
      );
    },

    /**
     * Активує план одним батчем D1: стара програма active = 0, нова active = 1 + дні + слоти. workouts і
     * workout_sets не чіпаються. Є active-тренування — ACTIVE_WORKOUT без запису. Нова програма має
     * заздалегідь взятий id, дні й слоти знаходять її за id (назва не унікальна); кожен крок захищено
     * умовою «нова програма існує», тож відмова гарду не лишає напівзаписаного плану.
     */
    async activatePlan(userId: number, plan: Plan, now: number): Promise<ActivatePlanResult> {
      if (plan.days.length === 0 || plan.days.some((d) => d.slots.length === 0)) return { ok: false, error: "BAD_PLAN" };
      if (await this.getActiveWorkout(userId)) return { ok: false, error: "ACTIVE_WORKOUT" };
      const idRow = await db.get<{ next: number }>(sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM programs`);
      const pid = idRow?.next ?? 1;
      const d1 = db.$client;
      const noActive = "NOT EXISTS (SELECT 1 FROM workouts w WHERE w.user_id = ? AND w.status = 'active')";
      const exists = "EXISTS (SELECT 1 FROM programs np WHERE np.id = ? AND np.user_id = ?)";
      const stmts = [
        d1
          .prepare(`UPDATE programs SET active = 0 WHERE user_id = ? AND active = 1 AND ${noActive} AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?)`)
          .bind(userId, userId, userId),
        d1
          .prepare(`INSERT INTO programs (id, user_id, name, active, created_at) SELECT ?, u.id, ?, 1, ? FROM users u WHERE u.id = ? AND ${noActive}`)
          .bind(pid, plan.name, now, userId, userId),
        ...plan.days.flatMap((day, i) => [
          d1
            .prepare(`INSERT INTO program_days (program_id, code, position, title) SELECT ?, ?, ?, ? WHERE ${exists}`)
            .bind(pid, day.code, i + 1, day.title, pid, userId),
          ...day.slots.map((slot, j) =>
            d1
              .prepare(
                `INSERT INTO program_exercises (program_day_id, exercise_id, position, sets, rep_min, rep_max)
                 SELECT d.id, ?, ?, ?, ?, ? FROM program_days d WHERE d.program_id = ? AND d.code = ? AND ${exists}`,
              )
              .bind(slot.exerciseId, j + 1, slot.sets, slot.repMin, slot.repMax, pid, day.code, pid, userId),
          ),
        ]),
      ];
      const res = await d1.batch(stmts);
      if (res[1]?.meta.changes === 1) return { ok: true, programId: pid };
      return (await this.getActiveWorkout(userId)) ? { ok: false, error: "ACTIVE_WORKOUT" } : { ok: false, error: "NO_USER" };
    },

    /** Вага тіла за локальну дату: перезаписує день. Повертає попереднє значення дня (десяті кг) або null. */
    async upsertBodyWeight(userId: number, localDate: string, weightDg: number, now: number): Promise<number | null> {
      const prev = await db
        .select({ weightDg: bodyWeights.weightDg })
        .from(bodyWeights)
        .where(and(eq(bodyWeights.userId, userId), eq(bodyWeights.localDate, localDate)))
        .get();
      await db
        .insert(bodyWeights)
        .values({ userId, localDate, weightDg, updatedAt: now })
        .onConflictDoUpdate({ target: [bodyWeights.userId, bodyWeights.localDate], set: { weightDg, updatedAt: now } })
        .run();
      return prev?.weightDg ?? null;
    },

    /** Записи ваги за локальні дати [from, to] включно, за зростанням дати. */
    async getWeights(userId: number, from: string, to: string): Promise<{ localDate: string; weightDg: number }[]> {
      return db
        .select({ localDate: bodyWeights.localDate, weightDg: bodyWeights.weightDg })
        .from(bodyWeights)
        .where(and(eq(bodyWeights.userId, userId), gte(bodyWeights.localDate, from), lte(bodyWeights.localDate, to)))
        .orderBy(asc(bodyWeights.localDate))
        .all();
    },

    /** Найстаріший запис ваги (старт тренду, якщо анкета ваги не мала). */
    async getFirstWeight(userId: number): Promise<{ localDate: string; weightDg: number } | null> {
      const row = await db
        .select({ localDate: bodyWeights.localDate, weightDg: bodyWeights.weightDg })
        .from(bodyWeights)
        .where(eq(bodyWeights.userId, userId))
        .orderBy(asc(bodyWeights.localDate))
        .limit(1)
        .get();
      return row ?? null;
    },

    /** Найновіший запис ваги (для /vaga без числа). */
    async getLastWeight(userId: number): Promise<{ localDate: string; weightDg: number } | null> {
      const row = await db
        .select({ localDate: bodyWeights.localDate, weightDg: bodyWeights.weightDg })
        .from(bodyWeights)
        .where(eq(bodyWeights.userId, userId))
        .orderBy(desc(bodyWeights.localDate))
        .limit(1)
        .get();
      return row ?? null;
    },

    // --- Нагадування й крон (Фаза 2.3) ---

    /** Усі користувачі з розкладом нагадувань (крон іде по всіх). */
    async getReminderUsers(): Promise<ReminderUserRow[]> {
      return db
        .select({ id: users.id, tz: users.tz, trainingDays: users.trainingDays, remindTime: users.remindTime, weighTime: users.weighTime })
        .from(users)
        .all();
    },

    /** Є заявка (user, kind, local_date) — нагадування вже взяте. */
    async hasReminder(userId: number, kind: ReminderKind, localDate: string): Promise<boolean> {
      const row = await db
        .select({ k: remindersSent.kind })
        .from(remindersSent)
        .where(and(eq(remindersSent.userId, userId), eq(remindersSent.kind, kind), eq(remindersSent.localDate, localDate)))
        .get();
      return row !== undefined;
    },

    /** Крок 1 «заявити → надіслати»: true — заявку взято цим тіком; false — її вже взяв інший (UNIQUE). */
    async claimReminder(userId: number, kind: ReminderKind, localDate: string, now: number): Promise<boolean> {
      const res = await db.insert(remindersSent).values({ userId, kind, localDate, sentAt: now }).onConflictDoNothing().run();
      return res.meta.changes === 1;
    },

    /** Крок 2: Telegram прийняв — зберегти message_id (для відповіді-reply на нагадування про вагу). */
    async setReminderMessageId(userId: number, kind: ReminderKind, localDate: string, messageId: number): Promise<void> {
      await db
        .update(remindersSent)
        .set({ messageId })
        .where(and(eq(remindersSent.userId, userId), eq(remindersSent.kind, kind), eq(remindersSent.localDate, localDate)))
        .run();
    },

    /** Крок 3: визначена недоставка — зняти заявку, наступний тік у вікні повторить. */
    async releaseReminder(userId: number, kind: ReminderKind, localDate: string): Promise<void> {
      await db
        .delete(remindersSent)
        .where(and(eq(remindersSent.userId, userId), eq(remindersSent.kind, kind), eq(remindersSent.localDate, localDate)))
        .run();
    },

    /** Нагадування про вагу, на яке відповіли reply (за message_id): його локальна дата; немає — null. */
    async getWeighReminderDate(userId: number, messageId: number): Promise<string | null> {
      const row = await db
        .select({ localDate: remindersSent.localDate })
        .from(remindersSent)
        .where(and(eq(remindersSent.userId, userId), eq(remindersSent.kind, "weigh"), eq(remindersSent.messageId, messageId)))
        .get();
      return row?.localDate ?? null;
    },

    /** Є тренування `active`/`done`, розпочате в `[fromUtc, toUtc)` (локальна доба). */
    async hasWorkoutBetween(userId: number, fromUtc: number, toUtc: number): Promise<boolean> {
      const row = await db
        .select({ id: workouts.id })
        .from(workouts)
        .where(and(eq(workouts.userId, userId), inArray(workouts.status, ["active", "done"]), gte(workouts.startedAt, fromUtc), lt(workouts.startedAt, toUtc)))
        .limit(1)
        .get();
      return row !== undefined;
    },

    /** Тижневий підсумок: `done`-тренування, розпочаті в `[fromUtc, toUtc)`; підходи й обсяг — як у підсумку тренування (непропущені). */
    async getWeekStats(userId: number, fromUtc: number, toUtc: number): Promise<{ workouts: number; sets: number; volumeKg: number }> {
      const row = await db.all<{ workouts: number; sets: number; volume: number }>(sql`
        SELECT COUNT(DISTINCT w.id) AS workouts,
               COUNT(s.id) AS sets,
               COALESCE(SUM(COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)), 0) AS volume
        FROM workouts w
        LEFT JOIN workout_sets s ON s.workout_id = w.id AND s.skipped = 0
        WHERE w.user_id = ${userId} AND w.status = 'done' AND w.started_at >= ${fromUtc} AND w.started_at < ${toUtc}`);
      const r = row[0];
      return { workouts: r?.workouts ?? 0, sets: r?.sets ?? 0, volumeKg: r?.volume ?? 0 };
    },

    /** Чи є в користувача хоч одне `done`-тренування або запис ваги за весь час (інакше недільний звіт мовчить). */
    async hasHistory(userId: number): Promise<boolean> {
      const row = await db.all<{ n: number }>(sql`
        SELECT (EXISTS (SELECT 1 FROM workouts WHERE user_id = ${userId} AND status = 'done')
             OR EXISTS (SELECT 1 FROM body_weights WHERE user_id = ${userId})) AS n`);
      return row[0]?.n === 1;
    },

    /** Кінець кожного тіку (навіть якщо нагадування кидали): `/health` бере звідси вік крону. `ok` — тік без помилок: лише тоді оновлюється last_ok_at. */
    async touchCron(now: number, ok = true): Promise<void> {
      await db
        .insert(cronState)
        .values({ id: 1, lastTickAt: now, lastOkAt: ok ? now : null })
        .onConflictDoUpdate({ target: cronState.id, set: ok ? { lastTickAt: now, lastOkAt: now } : { lastTickAt: now } })
        .run();
    },

    /** Момент останнього тіку й останнього тіку без помилок (UTC мс); тіку ще не було — null. */
    async getCronTick(): Promise<{ tickAt: number; okAt: number | null } | null> {
      const row = await db.select({ tickAt: cronState.lastTickAt, okAt: cronState.lastOkAt }).from(cronState).where(eq(cronState.id, 1)).get();
      return row ?? null;
    },

    // --- Фаза 3: каталог продуктів і прийоми їжі. foods/food_aliases — спільні (без userId), решта — лише власні рядки. ---

    /** Продукт за аліасом (нормалізується тут же, нормалізація ідемпотентна); невалідний аліас або немає — null. */
    async findFoodByAlias(alias: string): Promise<Food | null> {
      const key = normalizeAlias(alias);
      if (key === null) return null;
      const rows = await db.all<FoodRow>(sql`
        SELECT ${sql.raw(FOOD_COLUMNS)} FROM food_aliases a JOIN foods f ON f.id = a.food_id WHERE a.alias = ${key}`);
      return rows[0] ? toFood(rows[0]) : null;
    },

    /**
     * Оцінка моделі як новий продукт `ai_estimate` з аліасом `normalizeAlias(nameUk)`. Ідемпотентно за аліасом:
     * є — повертає наявний, нового рядка немає (також при гонці: аліас-конфлікт відкочує весь batch).
     * Невалідна назва (порожня після нормалізації, > 60 символів) або значення поза межами схеми — null, нічого не записано.
     */
    async insertEstimatedFood(f: EstimatedFood, now: number): Promise<Food | null> {
      const key = normalizeAlias(f.nameUk);
      if (key === null || [...f.nameUk].length > 60) return null;
      const dg = [f.protein100Dg, f.fat100Dg, f.carbs100Dg];
      if (!Number.isInteger(f.kcal100) || f.kcal100 < 0 || f.kcal100 > 900) return null;
      if (dg.some((v) => !Number.isInteger(v) || v < 0 || v > 1000) || dg[0]! + dg[1]! + dg[2]! > 1000) return null;
      const existing = await repo.findFoodByAlias(key);
      if (existing) return existing;
      const d1 = db.$client;
      try {
        await d1.batch([
          d1
            .prepare("INSERT INTO foods (name_uk, kcal_100, protein_100_dg, fat_100_dg, carbs_100_dg, source, fdc_ref, created_at) VALUES (?, ?, ?, ?, ?, 'ai_estimate', NULL, ?)")
            .bind(f.nameUk, f.kcal100, f.protein100Dg, f.fat100Dg, f.carbs100Dg, now),
          // Рядок щойно вставлений у цьому ж batch (одна транзакція): MAX(id) — він.
          d1.prepare("INSERT INTO food_aliases (alias, food_id) VALUES (?, (SELECT MAX(id) FROM foods))").bind(key),
        ]);
      } catch (e) {
        const raced = await repo.findFoodByAlias(key);
        if (raced) return raced;
        throw e;
      }
      return repo.findFoodByAlias(key);
    },

    /**
     * `pending`-прийом з позиціями одним batch. Немає користувача або позицій не 1–8 → null. Знімка КБЖУ немає до confirmMeal.
     * Значення поза межами схеми (грами не цілі 1–2000, дата не `YYYY-MM-DD`, caption > 300, ai_raw_json > 8192) — null без запису.
     * Невідомий food_id відхиляє FK — виняток, batch відкочується цілком.
     */
    async createPendingMeal(userId: number, m: NewMeal, now: number): Promise<number | null> {
      if (m.items.length < 1 || m.items.length > 8) return null;
      if (m.items.some((it) => !Number.isInteger(it.grams) || it.grams < 1 || it.grams > 2000)) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.localDate) || [...(m.caption ?? "")].length > 300 || [...m.aiRawJson].length > 8192) return null;
      const u = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
      if (!u) return null;
      const d1 = db.$client;
      const res = await d1.batch([
        d1
          .prepare(
            `INSERT INTO meals (user_id, status, eaten_at, local_date, photo_file_id, caption, ai_model, ai_raw_json, message_id, await_grams_at, created_at, confirmed_at)
             VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .bind(userId, m.eatenAt, m.localDate, m.photoFileId, m.caption, m.aiModel, m.aiRawJson, m.messageId ?? null, now),
        // Прийом щойно вставлений у цьому ж batch: його id — найбільший серед прийомів користувача (AUTOINCREMENT).
        ...m.items.map((it, i) =>
          d1
            .prepare("INSERT INTO meal_items (meal_id, position, food_id, grams, confidence) VALUES ((SELECT MAX(id) FROM meals WHERE user_id = ?), ?, ?, ?, ?)")
            .bind(userId, i + 1, it.foodId, it.grams, it.confidence),
        ),
      ]);
      return res[0]?.meta.last_row_id ?? null;
    },

    /** Прийом з позиціями; чужий або неіснуючий — null. */
    async getMeal(userId: number, mealId: number): Promise<MealView | null> {
      const rows = await db.all<{
        id: number; user_id: number; status: MealStatus; eaten_at: number; local_date: string; photo_file_id: string | null; caption: string | null;
        ai_model: string; message_id: number | null; await_grams_at: number | null; created_at: number; confirmed_at: number | null;
      }>(sql`
        SELECT id, user_id, status, eaten_at, local_date, photo_file_id, caption, ai_model, message_id, await_grams_at, created_at, confirmed_at
        FROM meals WHERE id = ${mealId} AND user_id = ${userId}`);
      const m = rows[0];
      if (!m) return null;
      const items = await db.all<{
        position: number; food_id: number; name_uk: string; grams: number; confidence: MealConfidence; source: FoodSource;
        kcal_100: number; protein_100_dg: number; fat_100_dg: number; carbs_100_dg: number;
        kcal: number | null; protein_dg: number | null; fat_dg: number | null; carbs_dg: number | null;
      }>(sql`
        SELECT mi.position AS position, mi.food_id AS food_id, f.name_uk AS name_uk, mi.grams AS grams, mi.confidence AS confidence, f.source AS source,
               f.kcal_100 AS kcal_100, f.protein_100_dg AS protein_100_dg, f.fat_100_dg AS fat_100_dg, f.carbs_100_dg AS carbs_100_dg,
               mi.kcal AS kcal, mi.protein_dg AS protein_dg, mi.fat_dg AS fat_dg, mi.carbs_dg AS carbs_dg
        FROM meal_items mi JOIN foods f ON f.id = mi.food_id
        WHERE mi.meal_id = ${mealId} ORDER BY mi.position`);
      return {
        id: m.id,
        userId: m.user_id,
        status: m.status,
        eatenAt: m.eaten_at,
        localDate: m.local_date,
        photoFileId: m.photo_file_id,
        caption: m.caption,
        aiModel: m.ai_model,
        messageId: m.message_id,
        awaitGramsAt: m.await_grams_at,
        createdAt: m.created_at,
        confirmedAt: m.confirmed_at,
        items: items.map((r) => ({
          position: r.position,
          foodId: r.food_id,
          nameUk: r.name_uk,
          grams: r.grams,
          confidence: r.confidence,
          source: r.source,
          food: { kcal: r.kcal_100, proteinDg: r.protein_100_dg, fatDg: r.fat_100_dg, carbsDg: r.carbs_100_dg },
          snapshot: r.kcal === null ? null : { kcal: r.kcal, proteinDg: r.protein_dg ?? 0, fatDg: r.fat_dg ?? 0, carbsDg: r.carbs_dg ?? 0 },
        })),
      };
    },

    /** `pending`-прийом користувача, що чекає грами (`await_grams_at` не старший за ttlMs); найсвіжіший. */
    async awaitingGramsMeal(userId: number, now: number, ttlMs: number): Promise<MealView | null> {
      const rows = await db.all<{ id: number }>(sql`
        SELECT id FROM meals
        WHERE user_id = ${userId} AND status = 'pending' AND await_grams_at IS NOT NULL AND await_grams_at >= ${now - ttlMs}
        ORDER BY await_grams_at DESC, id DESC LIMIT 1`);
      return rows[0] ? repo.getMeal(userId, rows[0].id) : null;
    },

    /**
     * pending → confirmed і знімок КБЖУ в позиціях — один batch. Знімок за формулою (грами × x_100 + 50) div 100 (ціле, половина вгору),
     * лише де його ще немає. true — прийом щойно підтверджено; повторний виклик, чужий прийом, не `pending` — false без змін.
     */
    async confirmMeal(userId: number, mealId: number, now: number): Promise<boolean> {
      const d1 = db.$client;
      const res = await d1.batch([
        // Порожній прийом (усі позиції вилучено) не підтверджується: dayTotals показав би «їв», якого не було.
        d1
          .prepare("UPDATE meals SET status = 'confirmed', confirmed_at = ?, await_grams_at = NULL WHERE id = ? AND user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM meal_items WHERE meal_id = ?)")
          .bind(now, mealId, userId, mealId),
        d1
          .prepare(
            `UPDATE meal_items SET
               kcal = (meal_items.grams * f.kcal_100 + 50) / 100,
               protein_dg = (meal_items.grams * f.protein_100_dg + 50) / 100,
               fat_dg = (meal_items.grams * f.fat_100_dg + 50) / 100,
               carbs_dg = (meal_items.grams * f.carbs_100_dg + 50) / 100
             FROM foods f
             WHERE f.id = meal_items.food_id AND meal_items.meal_id = ? AND meal_items.kcal IS NULL
               AND EXISTS (SELECT 1 FROM meals gm WHERE gm.id = ? AND gm.user_id = ? AND gm.status = 'confirmed')`,
          )
          .bind(mealId, mealId, userId),
      ]);
      return res[0]?.meta.changes === 1;
    },

    /**
     * Нові грами для позицій власного `pending`-прийому: `grams` 1–2000 — змінити, 0 — вилучити позицію (`position` не перенумеровується).
     * Знімає очікування грамів. false без змін: чужий/не `pending`, невідома або повторена позиція, грами поза 0–2000,
     * вилучені всі позиції. Осиротілі `ai_estimate`-продукти вилучених позицій прибираються.
     */
    async updateMealGrams(userId: number, mealId: number, changes: { position: number; grams: number }[]): Promise<boolean> {
      const meal = await repo.getMeal(userId, mealId);
      if (!meal || meal.status !== "pending") return false;
      const byPos = new Map(meal.items.map((it) => [it.position, it]));
      const seen = new Set<number>();
      for (const c of changes) {
        if (!byPos.has(c.position) || seen.has(c.position) || !Number.isInteger(c.grams) || c.grams < 0 || c.grams > 2000) return false;
        seen.add(c.position);
      }
      const removed = changes.filter((c) => c.grams === 0).map((c) => byPos.get(c.position)!.foodId);
      if (removed.length >= meal.items.length) return false;
      const d1 = db.$client;
      // Лічильник вище міг застаріти (паралельна правка того ж прийому): «щонайменше одна позиція лишається» знову перевіряє сам DELETE.
      const stmts = changes.map((c) =>
        c.grams === 0
          ? d1
              .prepare(`DELETE FROM meal_items WHERE meal_id = ? AND position = ? AND ${OWN_PENDING_MEAL} AND (SELECT COUNT(*) FROM meal_items WHERE meal_id = ?) > 1`)
              .bind(mealId, c.position, mealId, userId, mealId)
          : d1.prepare(`UPDATE meal_items SET grams = ? WHERE meal_id = ? AND position = ? AND ${OWN_PENDING_MEAL}`).bind(c.grams, mealId, c.position, mealId, userId),
      );
      const deleteIdx = changes.flatMap((c, i) => (c.grams === 0 ? [i] : []));
      stmts.push(d1.prepare("UPDATE meals SET await_grams_at = NULL WHERE id = ? AND user_id = ? AND status = 'pending'").bind(mealId, userId));
      const metaIdx = stmts.length - 1;
      if (removed.length > 0) stmts.push(orphanEstimates(d1, removed));
      const res = await d1.batch(stmts);
      return res[metaIdx]?.meta.changes === 1 && deleteIdx.every((i) => res[i]?.meta.changes === 1);
    },

    /**
     * Скасування: `pending` → `cancelled` з вилученням позицій і осиротілих `ai_estimate`-продуктів (відкинута оцінка не стає еталоном);
     * `confirmed` → `cancelled` — позиції й знімок лишаються для історії, у dayTotals не входять. true — стан змінився;
     * повторне скасування, чужий прийом — false без помилки.
     */
    async cancelMeal(userId: number, mealId: number): Promise<boolean> {
      const meal = await repo.getMeal(userId, mealId);
      if (!meal || meal.status === "cancelled") return false;
      const d1 = db.$client;
      const foodIds = meal.status === "pending" ? [...new Set(meal.items.map((it) => it.foodId))] : [];
      const stmts = [
        d1.prepare(`DELETE FROM meal_items WHERE meal_id = ? AND ${OWN_PENDING_MEAL}`).bind(mealId, mealId, userId),
        d1.prepare("UPDATE meals SET status = 'cancelled', await_grams_at = NULL WHERE id = ? AND user_id = ? AND status IN ('pending', 'confirmed')").bind(mealId, userId),
      ];
      if (foodIds.length > 0) stmts.push(orphanEstimates(d1, foodIds));
      const res = await d1.batch(stmts);
      return res[1]?.meta.changes === 1;
    },

    /**
     * Крон (усі користувачі, без userId): `pending`, створені до `cutoff` (UTC мс), → `cancelled` з вилученням позицій;
     * осиротілі `ai_estimate` старші за `cutoff` — геть (також від збою між створенням продукту й прийому). Повертає кількість скасованих.
     */
    async expirePendingMeals(cutoff: number): Promise<number> {
      const d1 = db.$client;
      const res = await d1.batch([
        d1.prepare("DELETE FROM meal_items WHERE meal_id IN (SELECT id FROM meals WHERE status = 'pending' AND created_at < ?)").bind(cutoff),
        d1.prepare("UPDATE meals SET status = 'cancelled', await_grams_at = NULL WHERE status = 'pending' AND created_at < ?").bind(cutoff),
        d1
          .prepare("DELETE FROM foods WHERE source = 'ai_estimate' AND created_at < ? AND NOT EXISTS (SELECT 1 FROM meal_items mi WHERE mi.food_id = foods.id)")
          .bind(cutoff),
      ]);
      return res[1]?.meta.changes ?? 0;
    },

    /** Сума знімків за локальну дату — лише `confirmed`. Порожній день — нулі. */
    async dayTotals(userId: number, localDate: string): Promise<Nutrients> {
      const rows = await db.all<{ kcal: number; protein: number; fat: number; carbs: number }>(sql`
        SELECT COALESCE(SUM(mi.kcal), 0) AS kcal, COALESCE(SUM(mi.protein_dg), 0) AS protein,
               COALESCE(SUM(mi.fat_dg), 0) AS fat, COALESCE(SUM(mi.carbs_dg), 0) AS carbs
        FROM meal_items mi JOIN meals m ON m.id = mi.meal_id
        WHERE m.user_id = ${userId} AND m.local_date = ${localDate} AND m.status = 'confirmed'`);
      const r = rows[0];
      return { kcal: r?.kcal ?? 0, proteinDg: r?.protein ?? 0, fatDg: r?.fat ?? 0, carbsDg: r?.carbs ?? 0 };
    },

    /**
     * Резервування ліміту витрат на ШІ: умовний атомарний INSERT (перевірка суми й запис — один оператор, паралельні виклики не обходять ліміт).
     * Повертає id рядка або null, якщо `сума за локальну дату + estMicro > limitMicro` чи користувача немає.
     */
    async reserveAiUsage(userId: number, r: AiUsageReservation, now: number): Promise<number | null> {
      const res = await db.$client
        .prepare(
          `INSERT INTO ai_usage (user_id, model, input_tokens, output_tokens, cost_micro, purpose, local_date, created_at)
           SELECT u.id, ?, 0, 0, ?, ?, ?, ? FROM users u
           WHERE u.id = ? AND (SELECT COALESCE(SUM(cost_micro), 0) FROM ai_usage WHERE user_id = u.id AND local_date = ?) + ? <= ?`,
        )
        .bind(r.model, r.estMicro, r.purpose, r.localDate, now, userId, r.localDate, r.estMicro, r.limitMicro)
        .run();
      return res.meta.changes === 1 ? res.meta.last_row_id : null;
    },

    /** Оцінка → факт: токени й ціна з `usage` відповіді (input ≥ 1). false — чужий, неіснуючий або вже розрахований рядок. */
    async settleAiUsage(userId: number, usageId: number, actual: AiUsageActual): Promise<boolean> {
      // Стан «резервування» = токени 0/0, «факт» = input ≥ 1 (відповідь API завжди має вхідні токени). Тому settle без вхідних токенів відхиляється
      // (інакше факт 0/0 став би знову вилучним), а повторний settle не перезаписує вже розраховане.
      if (!Number.isInteger(actual.inputTokens) || actual.inputTokens < 1 || !Number.isInteger(actual.outputTokens) || actual.outputTokens < 0) return false;
      const res = await db.$client
        .prepare("UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, cost_micro = ? WHERE id = ? AND user_id = ? AND input_tokens = 0 AND output_tokens = 0")
        .bind(actual.inputTokens, actual.outputTokens, actual.costMicro, usageId, userId)
        .run();
      return res.meta.changes === 1;
    },

    /** Повернути ліміт: вилучає лише ще не закрите резервування (токени 0/0); факт оплати не стирається. */
    async releaseAiUsage(userId: number, usageId: number): Promise<boolean> {
      const res = await db.$client
        .prepare("DELETE FROM ai_usage WHERE id = ? AND user_id = ? AND input_tokens = 0 AND output_tokens = 0")
        .bind(usageId, userId)
        .run();
      return res.meta.changes === 1;
    },

    /** Витрати на ШІ за локальну дату (мікро-USD), резервування включно. */
    async aiSpendToday(userId: number, localDate: string): Promise<number> {
      const rows = await db.all<{ spent: number }>(sql`
        SELECT COALESCE(SUM(cost_micro), 0) AS spent FROM ai_usage WHERE user_id = ${userId} AND local_date = ${localDate}`);
      return rows[0]?.spent ?? 0;
    },

    /** Норма з датою початку. Ідемпотентно (PK `user, valid_from` і `user, source_date`): true — записано, false — вже було або немає користувача. */
    async insertTarget(userId: number, t: NutritionTarget, now: number): Promise<boolean> {
      const res = await db.$client
        .prepare(
          `INSERT INTO nutrition_targets (user_id, valid_from, kcal, protein_g, fat_g, carbs_g, reason, source_date, created_at)
           SELECT u.id, ?, ?, ?, ?, ?, ?, ?, ? FROM users u WHERE u.id = ?
           ON CONFLICT DO NOTHING`,
        )
        .bind(t.validFrom, t.kcal, t.proteinG, t.fatG, t.carbsG, t.reason, t.sourceDate, now, userId)
        .run();
      return res.meta.changes === 1;
    },

    /** Чинна норма на локальну дату: рядок з максимальним `valid_from <= localDate`. */
    async getTargetOn(userId: number, localDate: string): Promise<NutritionTarget | null> {
      const rows = await db.all<{ valid_from: string; kcal: number; protein_g: number; fat_g: number; carbs_g: number; reason: TargetReason; source_date: string | null }>(sql`
        SELECT valid_from, kcal, protein_g, fat_g, carbs_g, reason, source_date FROM nutrition_targets
        WHERE user_id = ${userId} AND valid_from <= ${localDate} ORDER BY valid_from DESC LIMIT 1`);
      const r = rows[0];
      return r ? { validFrom: r.valid_from, kcal: r.kcal, proteinG: r.protein_g, fatG: r.fat_g, carbsG: r.carbs_g, reason: r.reason, sourceDate: r.source_date } : null;
    },
  };
  return repo;
}

export type Repo = ReturnType<typeof createRepo>;
