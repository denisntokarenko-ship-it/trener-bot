// Єдиний вхід у D1. Функції над даними користувача приймають userId (N8): чужий рядок для них не існує —
// читання дає null / [], запис — false без змін (phase-1.md, «Ізоляція»). Винятки без userId:
// processed_updates (службова, ключ — update_id) і abandonStale (крон по всіх користувачах).
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { exercises, processedUpdates, programDays, programExercises, programs, users, workouts } from "./schema";

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
  /** sets слота, за яким записано підходи. */
  plannedSets: number;
  /** За set_no. Відсутні підходи обірваного тренування тут не з'являються — їх добудовує рушій. */
  sets: HistorySet[];
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
     * Пише лише в active-тренування користувача й лише в слот його дня; інакше false без змін.
     * Відмову застарілій кнопці робить потік (1.3), не repo.
     */
    async upsertSet(userId: number, s: SetInput): Promise<boolean> {
      const res = await db.run(sql`
        INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped)
        SELECT w.id, pe.id, ${s.exerciseId}, ${s.setNo}, ${s.weightKg}, ${s.reps}, ${s.prescribedWeightKg}, ${s.prescribedReps}, ${s.skipped ? 1 : 0}
        FROM workouts w JOIN program_exercises pe ON pe.program_day_id = w.program_day_id
        WHERE w.id = ${s.workoutId} AND w.user_id = ${userId} AND w.status = 'active' AND pe.id = ${s.programExerciseId}
        ON CONFLICT (workout_id, exercise_id, set_no) DO UPDATE SET program_exercise_id = excluded.program_exercise_id, weight_kg = excluded.weight_kg, reps = excluded.reps, prescribed_weight_kg = excluded.prescribed_weight_kg, prescribed_reps = excluded.prescribed_reps, skipped = excluded.skipped`);
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
