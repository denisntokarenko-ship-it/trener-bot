// Міграція 0012 (decisions.md, «Одиниці: гантелі й односторонні вправи» — дані до правила): власник вводив суму двох
// гантелей, тож фактична вага гантельних підходів тренувань до деплою правила ділиться навпіл; решта — без змін.
import { beforeEach, describe, expect, it } from "vitest";
import migration0012 from "../migrations/0012_dumbbell_sum_backfill.sql?raw";
import { seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const CUTOFF = 1795422988697; // деплой правила «кг на гантель» (версія 7920bc19)
const run = () => env.DB.batch(migration0012.split("--> statement-breakpoint").map((s) => env.DB.prepare(s)));

async function workoutWith(startedAt: number, slugs: string[]): Promise<number> {
  const day = (await repo.getProgramDay(111, "A"))!;
  const w = (await repo.startWorkout(111, day.id, startedAt))!.workout.id;
  for (const slug of slugs) {
    const slot = day.slots.find((s) => s.exercise.slug === slug)!;
    await repo.upsertSet(111, { workoutId: w, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 1, weightKg: 18, reps: 10, prescribedWeightKg: 2, prescribedReps: 10, skipped: false });
    await repo.upsertSet(111, { workoutId: w, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 2, weightKg: null, reps: null, prescribedWeightKg: 2, prescribedReps: 10, skipped: true });
  }
  await env.DB.prepare("UPDATE workouts SET status = 'abandoned', finished_at = started_at + 1000 WHERE id = ?").bind(w).run();
  return w;
}

const sets = async (w: number) =>
  (await env.DB.prepare("SELECT e.equipment eq, s.weight_kg w, s.reps r, s.prescribed_weight_kg pw, s.skipped sk FROM workout_sets s JOIN exercises e ON e.id = s.exercise_id WHERE s.workout_id = ? ORDER BY s.id").bind(w).all<{ eq: string; w: number | null; r: number | null; pw: number; sk: number }>()).results;

describe("міграція 0012: гантельні ваги до правила — навпіл", () => {
  beforeEach(async () => {
    await resetDb();
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    await repo.upsertUser(111, "Денис", 0);
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
  });

  it("гантельний підхід тренування до межі: 18 → 9; повтори, prescribed і пропущений — без змін", async () => {
    const day = (await repo.getProgramDay(111, "A"))!;
    const dumbbell = day.slots.find((s) => s.exercise.equipment === "dumbbell")!.exercise.slug;
    const other = day.slots.find((s) => s.exercise.equipment !== "dumbbell" && s.exercise.equipment !== "bodyweight")!.exercise.slug;
    const w = await workoutWith(CUTOFF - 1, [dumbbell, other]);
    await run();
    expect(await sets(w)).toEqual([
      { eq: "dumbbell", w: 9, r: 10, pw: 2, sk: 0 },
      { eq: "dumbbell", w: null, r: null, pw: 2, sk: 1 },
      { eq: expect.not.stringMatching(/^dumbbell$/), w: 18, r: 10, pw: 2, sk: 0 },
      { eq: expect.not.stringMatching(/^dumbbell$/), w: null, r: null, pw: 2, sk: 1 },
    ]);
  });

  it("тренування з межі й пізніше (вже з підписом «кг на гантель») не чіпає", async () => {
    const day = (await repo.getProgramDay(111, "A"))!;
    const dumbbell = day.slots.find((s) => s.exercise.equipment === "dumbbell")!.exercise.slug;
    const w = await workoutWith(CUTOFF, [dumbbell]);
    await run();
    expect((await sets(w))[0]!.w).toBe(18);
  });

  it("непарна сума ділиться без втрати: 5 → 2,5", async () => {
    const day = (await repo.getProgramDay(111, "A"))!;
    const dumbbell = day.slots.find((s) => s.exercise.equipment === "dumbbell")!.exercise.slug;
    const w = await workoutWith(CUTOFF - 1, [dumbbell]);
    await env.DB.prepare("UPDATE workout_sets SET weight_kg = 5 WHERE workout_id = ? AND skipped = 0").bind(w).run();
    await run();
    expect((await sets(w))[0]!.w).toBe(2.5);
  });

  it("SQL міграції пише лише workout_sets.weight_kg", () => {
    const code = migration0012.replace(/^--.*$/gm, "");
    expect(code.match(/UPDATE\s+`?(\w+)`?/gi)).toEqual(["UPDATE `workout_sets`"]);
    expect(code).toMatch(/SET `weight_kg` =/);
    expect(code).not.toMatch(/prescribed_weight_kg|start_weights|INSERT|DELETE|DROP/i);
  });
});
