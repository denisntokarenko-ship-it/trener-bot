// Єдиний вхід у D1. Функції над даними користувача приймають userId (N8): чужий рядок для них не існує —
// читання дає null / [], запис — false без змін (phase-1.md, «Ізоляція»). Винятки без userId:
// processed_updates (службова, ключ — update_id) і abandonStale (крон по всіх користувачах).
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { exerciseSubstitutes, exercises, processedUpdates, programDays, programExercises, programs, users, workoutSets, workouts } from "./schema";

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
  days: { id: number; code: string; position: number }[];
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

function toExercise(row: typeof exercises.$inferSelect): Exercise {
  const { cuesUk, ...rest } = row;
  return { ...rest, cues: cuesUk.split("\n") };
}

export function createRepo(db: Db) {
  return {
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
        .select({ id: programDays.id, code: programDays.code, position: programDays.position })
        .from(programDays)
        .where(eq(programDays.programId, program.id))
        .orderBy(asc(programDays.position))
        .all();
      return { ...program, days };
    },

    /** День активної програми користувача за кодом (A, B) зі слотами й вправами; немає — null. */
    async getProgramDay(userId: number, code: string): Promise<ProgramDay | null> {
      const day = await db
        .select({ id: programDays.id, programId: programDays.programId, code: programDays.code, position: programDays.position })
        .from(programDays)
        .innerJoin(programs, eq(programs.id, programDays.programId))
        .where(and(eq(programs.userId, userId), eq(programs.active, 1), eq(programDays.code, code)))
        .get();
      if (!day) return null;
      const rows = await db
        .select({ slot: programExercises, exercise: exercises })
        .from(programExercises)
        .innerJoin(exercises, eq(exercises.id, programExercises.exerciseId))
        .where(eq(programExercises.programDayId, day.id))
        .orderBy(asc(programExercises.position))
        .all();
      const slots = rows.map(({ slot, exercise }) => ({
        id: slot.id,
        position: slot.position,
        sets: slot.sets,
        repMin: slot.repMin,
        repMax: slot.repMax,
        exercise: toExercise(exercise),
      }));
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

    /** Часовий пояс користувача (IANA); профілю немає — null. */
    async getUserTz(userId: number): Promise<string | null> {
      const row = await db.select({ tz: users.tz }).from(users).where(eq(users.id, userId)).get();
      return row?.tz ?? null;
    },

    /** Останні n тренувань done і abandoned користувача, від нових до старих, з підходами за слотами. */
    async getRecentWorkouts(userId: number, n: number): Promise<WorkoutSummaryRow[]> {
      if (n <= 0) return [];
      const heads = await db.all<{ id: number; day_code: string; status: "done" | "abandoned"; started_at: number; effort: number | null }>(sql`
        SELECT w.id, d.code AS day_code, w.status, w.started_at, w.effort
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
        return { id: h.id, dayCode: h.day_code, status: h.status, startedAt: h.started_at, effort: h.effort, exercises: exs };
      });
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
     * від старшої до новішої. Тренування без жодного рядка цієї вправи сесією не є.
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
            AND EXISTS (SELECT 1 FROM workout_sets s2 WHERE s2.workout_id = w2.id AND s2.exercise_id = ${exerciseId})
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
        .where(and(eq(workouts.userId, userId), eq(workouts.status, "done")))
        .orderBy(desc(workouts.startedAt), desc(workouts.id))
        .get();
      return row ?? null;
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
