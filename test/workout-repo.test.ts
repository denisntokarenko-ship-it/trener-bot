import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { nextDayCode } from "../src/domain/progression";
import { createRepo, type ProgramDay, type SetInput } from "../src/db/repo";
import { count, env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const A = 111;
const B = 222;
const T0 = 1_700_000_000_000;
// Поріг зі спеки, а не імпорт STALE_AFTER_MS: інакше тест рухався б разом зі зламаною константою.
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

let dayA: ProgramDay; // день A користувача A
let dayB: ProgramDay; // день B користувача A

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(A, "Денис", 0);
  await repo.upsertUser(B, "Інший", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
  dayA = (await repo.getProgramDay(A, "A"))!;
  dayB = (await repo.getProgramDay(A, "B"))!;
});

function set(workoutId: number, day: ProgramDay, slotIdx: number, setNo: number, over: Partial<SetInput> = {}): SetInput {
  const slot = day.slots[slotIdx]!;
  return {
    workoutId,
    programExerciseId: slot.id,
    exerciseId: slot.exercise.id,
    setNo,
    weightKg: 40,
    reps: 8,
    prescribedWeightKg: 40,
    prescribedReps: 8,
    skipped: false,
    ...over,
  };
}

async function start(userId: number, day: ProgramDay, now: number): Promise<number> {
  const r = await repo.startWorkout(userId, day.id, now);
  return r!.workout.id;
}

async function workoutRow(id: number) {
  return env.DB.prepare("SELECT status, finished_at, effort, await_input FROM workouts WHERE id = ?").bind(id).first();
}

describe("upsertSet (P1.1.6)", () => {
  it("двічі той самий (workout, вправа, set_no) → один рядок з останніми значеннями", async () => {
    const w = await start(A, dayA, T0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { reps: 8 }))).toBe(true);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { reps: 10, weightKg: 45, prescribedReps: 9 }))).toBe(true);
    const rows = await env.DB.prepare("SELECT set_no, weight_kg, reps, prescribed_reps, skipped FROM workout_sets").all();
    expect(rows.results).toEqual([{ set_no: 1, weight_kg: 45, reps: 10, prescribed_reps: 9, skipped: 0 }]);
  });

  it("пропущений підхід пишеться з NULL вагою й повторами", async () => {
    const w = await start(A, dayA, T0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 2, { skipped: true, weightKg: null, reps: null }))).toBe(true);
    const row = await env.DB.prepare("SELECT weight_kg, reps, skipped FROM workout_sets").first();
    expect(row).toEqual({ weight_kg: null, reps: null, skipped: 1 });
  });

  it("слот іншого дня → false, без запису", async () => {
    const w = await start(A, dayA, T0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { programExerciseId: dayB.slots[0]!.id }))).toBe(false);
    expect(await count("workout_sets")).toBe(0);
  });

  it("у завершене тренування → false, без запису", async () => {
    const w = await start(A, dayA, T0);
    await repo.finishWorkout(A, w, 3, T0 + 1);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1))).toBe(false);
    expect(await count("workout_sets")).toBe(0);
  });

  // Рев'ю 1.1, В2: exerciseId і setNo з кнопки — клієнтські дані.
  it("вправа не слота й не його заміна → false, без запису", async () => {
    const w = await start(A, dayA, T0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { exerciseId: 17 }))).toBe(false); // бруси для присідань
    expect(await count("workout_sets")).toBe(0);
  });

  it("неіснуюча вправа → false без винятку", async () => {
    const w = await start(A, dayA, T0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { exerciseId: 9999 }))).toBe(false);
    expect(await count("workout_sets")).toBe(0);
  });

  it("set_no понад sets слота → false; рівно sets і заміна слота — записуються", async () => {
    const w = await start(A, dayA, T0);
    const sets = dayA.slots[0]!.sets;
    expect(await repo.upsertSet(A, set(w, dayA, 0, sets + 1))).toBe(false);
    expect(await count("workout_sets")).toBe(0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, sets))).toBe(true);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { exerciseId: 7 }))).toBe(true); // жим ногами — заміна присідань
    expect(await count("workout_sets")).toBe(2);
  });

  // Рев'ю 1.1, дрібниця 2: повтор не переносить записаний підхід в інший слот.
  it("повтор (workout, вправа, set_no) з іншим слотом → false, рядок без змін", async () => {
    // Присідання — і вправа слота 0, і (штучно) заміна жиму в слоті 1: перевірка вправи слота пропускає обидва,
    // тож перенос ловить лише умова ON CONFLICT … WHERE.
    await env.DB.prepare("INSERT INTO exercise_substitutes (exercise_id, substitute_id) VALUES (?, ?)")
      .bind(dayA.slots[1]!.exercise.id, dayA.slots[0]!.exercise.id)
      .run();
    const w = await start(A, dayA, T0);
    expect(await repo.upsertSet(A, set(w, dayA, 0, 1, { reps: 8 }))).toBe(true);
    const moved = set(w, dayA, 0, 1, { reps: 3, programExerciseId: dayA.slots[1]!.id });
    expect(await repo.upsertSet(A, moved)).toBe(false);
    const rows = await env.DB.prepare("SELECT program_exercise_id, reps FROM workout_sets").all();
    expect(rows.results).toEqual([{ program_exercise_id: dayA.slots[0]!.id, reps: 8 }]);
  });
});

describe("startWorkout / getActiveWorkout", () => {
  it("при наявному active → той самий id, нового рядка немає", async () => {
    const first = await repo.startWorkout(A, dayA.id, T0);
    expect(first?.created).toBe(true);
    expect(first?.workout).toMatchObject({ programDayId: dayA.id, dayCode: "A", status: "active", startedAt: T0, finishedAt: null, effort: null, awaitInput: null });
    const again = await repo.startWorkout(A, dayB.id, T0 + 5);
    expect(again?.created).toBe(false);
    expect(again?.workout.id).toBe(first?.workout.id);
    expect(await count("workouts")).toBe(1);
    expect((await repo.getActiveWorkout(A))?.id).toBe(first?.workout.id);
  });

  it("після завершення — нове тренування", async () => {
    const w1 = await start(A, dayA, T0);
    await repo.finishWorkout(A, w1, 3, T0 + 1);
    expect(await repo.getActiveWorkout(A)).toBeNull();
    const w2 = await start(A, dayB, T0 + 2);
    expect(w2).not.toBe(w1);
  });
});

describe("ізоляція користувачів (P1.1.5)", () => {
  it("B не бачить і не змінює тренування A", async () => {
    const w = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w, dayA, 0, 1, { reps: 8 }));
    const before = await env.DB.prepare("SELECT * FROM workout_sets").all();

    expect(await repo.getActiveWorkout(B)).toBeNull();
    expect(await repo.upsertSet(B, set(w, dayA, 0, 1, { reps: 3 }))).toBe(false);
    expect(await repo.upsertSet(B, set(w, dayA, 0, 2))).toBe(false);
    expect(await repo.finishWorkout(B, w, 5, T0 + 1)).toBe(false);

    expect(await env.DB.prepare("SELECT * FROM workout_sets").all()).toMatchObject({ results: before.results });
    expect(await workoutRow(w)).toEqual({ status: "active", finished_at: null, effort: null, await_input: null });
  });

  it("B не починає тренування за днем програми A", async () => {
    expect(await repo.startWorkout(B, dayA.id, T0)).toBeNull();
    expect(await count("workouts")).toBe(0);
  });

  it("історія й останнє done A для B порожні", async () => {
    const w = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w, dayA, 0, 1));
    await repo.finishWorkout(A, w, 3, T0 + 1);
    expect(await repo.getExerciseHistory(B, dayA.slots[0]!.exercise.id, 5)).toEqual([]);
    expect(await repo.getLastDoneWorkout(B)).toBeNull();
    expect(await repo.getExerciseHistory(A, dayA.slots[0]!.exercise.id, 5)).toHaveLength(1);
  });

  it("користувач без програми: getActiveProgram і getProgramDay → null", async () => {
    await repo.upsertUser(333, "Без програми", 0);
    expect(await repo.getActiveProgram(333)).toBeNull();
    expect(await repo.getProgramDay(333, "A")).toBeNull();
    expect(await repo.getProgramDay(A, "Z")).toBeNull();
  });
});

describe("finishWorkout", () => {
  it("active → done з оцінкою; повторна оцінка — false, перша лишається", async () => {
    const w = await start(A, dayA, T0);
    await env.DB.prepare("UPDATE workouts SET await_input = '{\"x\":1}' WHERE id = ?").bind(w).run();
    expect(await repo.finishWorkout(A, w, 4, T0 + 10)).toBe(true);
    expect(await repo.finishWorkout(A, w, 5, T0 + 20)).toBe(false);
    expect(await workoutRow(w)).toEqual({ status: "done", finished_at: T0 + 10, effort: 4, await_input: null });
  });
});

describe("abandonStale", () => {
  it("чіпає лише active, старші за 4 год; рівно 4 год і done — без змін", async () => {
    const now = T0 + 10 * STALE_AFTER_MS;
    const done = await start(A, dayA, now - 3 * STALE_AFTER_MS);
    await repo.finishWorkout(A, done, 3, now - 3 * STALE_AFTER_MS + 1);
    const stale = await start(A, dayB, now - STALE_AFTER_MS - 1);
    await env.DB.prepare("UPDATE workouts SET await_input = '{}' WHERE id = ?").bind(stale).run();
    const edge = await start(B, (await repo.getProgramDay(B, "A"))!, now - STALE_AFTER_MS);

    expect(await repo.abandonStale(A, now)).toBe(1);
    expect(await workoutRow(stale)).toEqual({ status: "abandoned", finished_at: now, effort: null, await_input: null });
    expect(await workoutRow(edge)).toEqual({ status: "active", finished_at: null, effort: null, await_input: null });
    expect(await workoutRow(done)).toEqual({ status: "done", finished_at: now - 3 * STALE_AFTER_MS + 1, effort: 3, await_input: null });
    expect(await repo.abandonStale(A, now)).toBe(0);
  });

  it("[R-1.1] Д3: закриває лише active свого користувача — чужий старий active лишається", async () => {
    const now = T0 + 10 * STALE_AFTER_MS;
    const mine = await start(A, dayA, now - STALE_AFTER_MS - 1);
    const theirs = await start(B, (await repo.getProgramDay(B, "A"))!, now - STALE_AFTER_MS - 1);
    expect(await repo.abandonStale(A, now)).toBe(1);
    expect((await workoutRow(mine))?.status).toBe("abandoned");
    expect((await workoutRow(theirs))?.status).toBe("active");
    expect(await repo.abandonStale(B, now)).toBe(1);
    expect((await workoutRow(theirs))?.status).toBe("abandoned");
  });

  it("свіже active (щойно почате) не чіпає", async () => {
    const w = await start(A, dayA, T0);
    expect(await repo.abandonStale(A, T0 + 1)).toBe(0);
    expect((await workoutRow(w))?.status).toBe("active");
  });
});

describe("getExerciseHistory / getLastDoneWorkout", () => {
  it("сесії done і abandoned від старшої до новішої, останні n, без active", async () => {
    const squat = dayA.slots[0]!;
    const w1 = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w1, dayA, 0, 2, { weightKg: 40, reps: 9 }));
    await repo.upsertSet(A, set(w1, dayA, 0, 1, { weightKg: 40, reps: 10 }));
    await repo.finishWorkout(A, w1, 3, T0 + 1);

    const w2 = await start(A, dayA, T0 + 100);
    await repo.upsertSet(A, set(w2, dayA, 0, 1, { weightKg: 45, reps: 6 }));
    await repo.upsertSet(A, set(w2, dayA, 0, 2, { skipped: true, weightKg: null, reps: null }));
    await repo.abandonStale(A, T0 + 100 + STALE_AFTER_MS + 1);

    const w3 = await start(A, dayB, T0 + STALE_AFTER_MS * 2); // день B — присідань немає
    await repo.finishWorkout(A, w3, 2, T0 + STALE_AFTER_MS * 2 + 1);

    const w4 = await start(A, dayA, T0 + STALE_AFTER_MS * 3); // active — в історію не йде
    await repo.upsertSet(A, set(w4, dayA, 0, 1, { weightKg: 50, reps: 6 }));

    const all = await repo.getExerciseHistory(A, squat.exercise.id, 10);
    expect(all).toEqual([
      { workoutId: w1, status: "done", startedAt: T0, effort: 3, plannedSets: squat.sets, sets: [
        { setNo: 1, weightKg: 40, reps: 10, skipped: false },
        { setNo: 2, weightKg: 40, reps: 9, skipped: false },
      ] },
      { workoutId: w2, status: "abandoned", startedAt: T0 + 100, effort: null, plannedSets: squat.sets, sets: [
        { setNo: 1, weightKg: 45, reps: 6, skipped: false },
        { setNo: 2, weightKg: null, reps: null, skipped: true },
      ] },
    ]);
    expect((await repo.getExerciseHistory(A, squat.exercise.id, 1)).map((s) => s.workoutId)).toEqual([w2]);
    expect(await repo.getExerciseHistory(A, squat.exercise.id, 0)).toEqual([]);

    const last = await repo.getLastDoneWorkout(A);
    expect(last).toMatchObject({ id: w3, dayCode: "B", status: "done", effort: 2 });
  });

  // Рев'ю 1.1, В1: у тренуванні кілька вправ — історія бере лише свою.
  it("підходи інших вправ того самого тренування в історію не потрапляють", async () => {
    const squat = dayA.slots[0]!;
    const w = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w, dayA, 0, 1, { weightKg: 40, reps: 8 }));
    await repo.upsertSet(A, set(w, dayA, 1, 1, { weightKg: 30, reps: 10 }));
    await repo.upsertSet(A, set(w, dayA, 1, 2, { weightKg: 30, reps: 10 }));
    await repo.finishWorkout(A, w, 3, T0 + 1);
    const history = await repo.getExerciseHistory(A, squat.exercise.id, 5);
    expect(history.map((s) => s.sets)).toEqual([[{ setNo: 1, weightKg: 40, reps: 8, skipped: false }]]);
  });

  it("заміна йде в історію фактичної вправи, не вправи слота", async () => {
    const slot = dayA.slots[0]!; // присідання; заміна — жим ногами (7)
    const w = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w, dayA, 0, 1, { exerciseId: 7 }));
    await repo.finishWorkout(A, w, 3, T0 + 1);
    expect(await repo.getExerciseHistory(A, slot.exercise.id, 5)).toEqual([]);
    expect((await repo.getExerciseHistory(A, 7, 5))[0]?.plannedSets).toBe(slot.sets);
  });

  it("немає done → getLastDoneWorkout null (abandoned не рахується)", async () => {
    await start(A, dayA, T0);
    await repo.abandonStale(A, T0 + STALE_AFTER_MS + 1);
    expect(await repo.getLastDoneWorkout(A)).toBeNull();
  });

  it("P1.2.3: done B, пізніше abandoned A → наступний день A (abandoned черговість не зсуває)", async () => {
    const days = [dayA, dayB];
    expect(nextDayCode(await repo.getLastDoneWorkout(A), days)).toBe("A");
    const b = await start(A, dayB, T0);
    await repo.finishWorkout(A, b, 3, T0 + 1);
    expect(nextDayCode(await repo.getLastDoneWorkout(A), days)).toBe("A");
    await start(A, dayA, T0 + 10);
    await repo.abandonStale(A, T0 + 10 + STALE_AFTER_MS + 1);
    expect(nextDayCode(await repo.getLastDoneWorkout(A), days)).toBe("A");
  });
});

describe("рев'ю Фази 1: вікно історії рахує лише зараховані сесії", () => {
  it("повністю пропущені сесії не витісняють зараховані з вікна n (В1)", async () => {
    const squat = dayA.slots[0]!;
    const w1 = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w1, dayA, 0, 1, { weightKg: 60, reps: 6 }));
    await repo.finishWorkout(A, w1, 4, T0 + 1);
    for (const [i, t] of [T0 + 100, T0 + 200].entries()) {
      const w = await start(A, dayA, t);
      for (let n = 1; n <= squat.sets; n++) await repo.upsertSet(A, set(w, dayA, 0, n, { skipped: true, weightKg: null, reps: null }));
      await repo.finishWorkout(A, w, 3, t + 1 + i);
    }
    const w4 = await start(A, dayA, T0 + 300);
    await repo.upsertSet(A, set(w4, dayA, 0, 1, { weightKg: 60, reps: 5 }));
    await repo.upsertSet(A, set(w4, dayA, 0, 2, { skipped: true, weightKg: null, reps: null }));
    await repo.finishWorkout(A, w4, 4, T0 + 301);

    const two = await repo.getExerciseHistory(A, squat.exercise.id, 2);
    expect(two.map((s) => s.workoutId)).toEqual([w1, w4]);
    expect(two[1]!.sets).toHaveLength(2); // зарахована сесія лишається з пропущеним підходом
  });

  it("getWorkoutSets чужого тренування → [] (P1.1.5, N8)", async () => {
    const w = await start(A, dayA, T0);
    await repo.upsertSet(A, set(w, dayA, 0, 1));
    expect(await repo.getWorkoutSets(A, w)).toHaveLength(1);
    expect(await repo.getWorkoutSets(B, w)).toEqual([]);
  });
});
