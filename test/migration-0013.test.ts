// Міграція 0013 (decisions.md, «Одиниці: гантелі й односторонні вправи» — дані до правила): власник вводив повтори
// односторонніх вправ загалом на обидві сторони, тож повтори таких підходів до деплою правила діляться навпіл.
import { beforeEach, describe, expect, it } from "vitest";
import migration0013 from "../migrations/0013_unilateral_reps_backfill.sql?raw";
import { seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const CUTOFF = 1795422988697; // деплой правила «на кожну ногу/руку» (версія 7920bc19)
const run = () => env.DB.batch(migration0013.split("--> statement-breakpoint").map((s) => env.DB.prepare(s)));

/** Тренування дня A: перша вправа слота стає односторонньою, друга лишається двосторонньою. */
async function workout(startedAt: number, reps: number): Promise<number> {
  const day = (await repo.getProgramDay(111, "A"))!;
  const [uni, both] = [day.slots[0]!, day.slots[1]!];
  await env.DB.prepare("UPDATE exercises SET unilateral = CASE id WHEN ? THEN 1 ELSE 0 END").bind(uni.exercise.id).run();
  const w = (await repo.startWorkout(111, day.id, startedAt))!.workout.id;
  for (const slot of [uni, both]) {
    await repo.upsertSet(111, { workoutId: w, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 1, weightKg: 4, reps, prescribedWeightKg: 2, prescribedReps: 12, skipped: false });
    await repo.upsertSet(111, { workoutId: w, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 2, weightKg: null, reps: null, prescribedWeightKg: 2, prescribedReps: 12, skipped: true });
  }
  await env.DB.prepare("UPDATE workouts SET status = 'abandoned', finished_at = started_at + 1000 WHERE id = ?").bind(w).run();
  return w;
}

const sets = async (w: number) =>
  (await env.DB.prepare("SELECT e.unilateral u, s.weight_kg w, s.reps r, s.prescribed_reps pr, s.skipped sk FROM workout_sets s JOIN exercises e ON e.id = s.exercise_id WHERE s.workout_id = ? ORDER BY s.id").bind(w).all<{ u: number; w: number | null; r: number | null; pr: number; sk: number }>()).results;

describe("міграція 0013: повтори односторонніх до правила — навпіл", () => {
  beforeEach(async () => {
    await resetDb();
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    await repo.upsertUser(111, "Денис", 0);
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
  });

  it("односторонній підхід до межі: 12 → 6; вага, prescribed, пропущений і двостороння — без змін", async () => {
    const w = await workout(CUTOFF - 1, 12);
    await run();
    expect(await sets(w)).toEqual([
      { u: 1, w: 4, r: 6, pr: 12, sk: 0 },
      { u: 1, w: null, r: null, pr: 12, sk: 1 },
      { u: 0, w: 4, r: 12, pr: 12, sk: 0 },
      { u: 0, w: null, r: null, pr: 12, sk: 1 },
    ]);
  });

  it("тренування з межі й пізніше (вже з підписом «на кожну ногу») не чіпає", async () => {
    const w = await workout(CUTOFF, 12);
    await run();
    expect((await sets(w))[0]!.r).toBe(12);
  });

  it("непарне загалом — вниз: 13 → 6 (ціле, пів повтору не буває)", async () => {
    const w = await workout(CUTOFF - 1, 13);
    await run();
    expect((await sets(w))[0]!.r).toBe(6);
  });

  it("SQL міграції пише лише workout_sets.reps", () => {
    const code = migration0013.replace(/^--.*$/gm, "");
    expect(code.match(/UPDATE\s+`?(\w+)`?/gi)).toEqual(["UPDATE `workout_sets`"]);
    expect(code).toMatch(/SET `reps` =/);
    expect(code).not.toMatch(/weight_kg|prescribed_reps|start_weights|INSERT|DELETE|DROP/i);
  });
});
