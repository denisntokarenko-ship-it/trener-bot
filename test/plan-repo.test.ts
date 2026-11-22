import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { buildPlan, type Plan } from "../src/domain/plan";
import { count, env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const OWNER = 111;
const OTHER = 222;

async function seed(now = 1_000): Promise<void> {
  await env.DB.batch(seedStatements(now).map((s) => env.DB.prepare(s)));
}

async function planFor(goal: "muscle" | "strength" = "muscle", days = 4): Promise<Plan> {
  const catalog = await repo.getPlanCatalog();
  const r = buildPlan({ goal, daysPerWeek: days, level: "mid" }, catalog, 0);
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}

/** Знімок історії власника: усі рядки workouts і workout_sets. */
async function historySnapshot(): Promise<string> {
  const w = await env.DB.prepare("SELECT * FROM workouts ORDER BY id").all();
  const s = await env.DB.prepare("SELECT * FROM workout_sets ORDER BY id").all();
  return JSON.stringify([w.results, s.results]);
}

/** Власник із програмою A/B і одним завершеним тренуванням з підходами. */
async function ownerWithHistory(): Promise<void> {
  await repo.upsertUser(OWNER, "Денис", 0);
  await seed();
  const day = await repo.getProgramDay(OWNER, "A");
  const started = await repo.startWorkout(OWNER, day!.id, 5_000);
  const slot = day!.slots[0]!;
  await repo.upsertSet(OWNER, { workoutId: started!.workout.id, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 1, weightKg: 60, reps: 8, prescribedWeightKg: 60, prescribedReps: 8, skipped: false });
  await repo.finishWorkout(OWNER, started!.workout.id, 3, 6_000);
}

async function activePrograms(userId: number): Promise<{ id: number; name: string }[]> {
  const r = await env.DB.prepare("SELECT id, name FROM programs WHERE user_id = ? AND active = 1").bind(userId).all<{ id: number; name: string }>();
  return r.results;
}

beforeEach(resetDb);

describe("activatePlan (P2.7, P2.11)", () => {
  it("стара програма архівується, нова — одна активна; історія тренувань не змінюється", async () => {
    await ownerWithHistory();
    const before = await historySnapshot();
    const oldProgram = (await activePrograms(OWNER))[0]!;
    const plan = await planFor();

    const res = await repo.activatePlan(OWNER, plan, 9_000);
    expect(res.ok).toBe(true);

    const active = await activePrograms(OWNER);
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe(plan.name);
    expect(active[0]!.id).not.toBe(oldProgram.id);
    const archived = await env.DB.prepare("SELECT active FROM programs WHERE id = ?").bind(oldProgram.id).first<{ active: number }>();
    expect(archived?.active).toBe(0);
    expect(await historySnapshot()).toBe(before);
    // Старі дні лишились (workouts.program_day_id цілі), /progres бачить їхні коди.
    expect(await count("program_days")).toBe(2 + plan.days.length);
    const last = await repo.getRecentWorkouts(OWNER, 5);
    expect(last[0]?.dayCode).toBe("A");
  });

  it("дні мають назви, позиції 1..N і слоти за планом; getProgramDay/getActiveProgram повертають title", async () => {
    await ownerWithHistory();
    const plan = await planFor("strength", 4);
    await repo.activatePlan(OWNER, plan, 9_000);

    const prog = await repo.getActiveProgram(OWNER);
    expect(prog?.days.map((d) => [d.code, d.position, d.title])).toEqual([["UP", 1, "Верх"], ["LO", 2, "Низ"]]);
    for (const d of plan.days) {
      const day = await repo.getProgramDay(OWNER, d.code);
      expect(day?.title).toBe(d.title);
      expect(day?.slots.map((s) => [s.exercise.id, s.sets, s.repMin, s.repMax])).toEqual(d.slots.map((s) => [s.exerciseId, s.sets, s.repMin, s.repMax]));
      expect(day?.slots.map((s) => s.position)).toEqual(d.slots.map((_, i) => i + 1));
    }
  });

  it("активне тренування → ACTIVE_WORKOUT, у programs нічого не змінилось", async () => {
    await repo.upsertUser(OWNER, "Денис", 0);
    await seed();
    const day = await repo.getProgramDay(OWNER, "B");
    await repo.startWorkout(OWNER, day!.id, 5_000);
    const programsBefore = JSON.stringify((await env.DB.prepare("SELECT * FROM programs ORDER BY id").all()).results);
    const daysBefore = await count("program_days");

    const res = await repo.activatePlan(OWNER, await planFor(), 9_000);
    expect(res).toEqual({ ok: false, error: "ACTIVE_WORKOUT" });
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM programs ORDER BY id").all()).results)).toBe(programsBefore);
    expect(await count("program_days")).toBe(daysBefore);
  });

  it("повторна активація: завжди рівно одна активна програма, попередні архівні", async () => {
    await ownerWithHistory();
    for (let i = 0; i < 3; i++) expect((await repo.activatePlan(OWNER, await planFor(), 9_000 + i)).ok).toBe(true);
    expect(await activePrograms(OWNER)).toHaveLength(1);
    expect(await count("programs")).toBe(4);
  });

  it("користувача немає в users → NO_USER, нічого не записано", async () => {
    await seed();
    const res = await repo.activatePlan(999, await planFor(), 9_000);
    expect(res).toEqual({ ok: false, error: "NO_USER" });
    expect(await count("programs")).toBe(0);
    expect(await count("program_days")).toBe(0);
  });

  it("два паралельні виклики одного користувача (подвійне [✅]): жодного винятку, одна нова програма, без напівзаписаних днів", async () => {
    await ownerWithHistory();
    const plan = await planFor();
    const [a, b] = await Promise.all([repo.activatePlan(OWNER, plan, 9_000), repo.activatePlan(OWNER, plan, 9_001)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: "CONCURRENT" });
    expect(await activePrograms(OWNER)).toHaveLength(1);
    expect(await count("programs")).toBe(2);
    expect(await count("program_days")).toBe(2 + plan.days.length);
  });

  it("паралельні виклики двох користувачів беруть той самий MAX+1: обидва успішні з різними id (повтор із новим id)", async () => {
    await ownerWithHistory();
    await repo.upsertUser(OTHER, "Інший", 0);
    const plan = await planFor();
    const [a, b] = await Promise.all([repo.activatePlan(OWNER, plan, 9_000), repo.activatePlan(OTHER, plan, 9_001)]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.programId).not.toBe(b.programId);
    expect(await activePrograms(OWNER)).toHaveLength(1);
    expect(await activePrograms(OTHER)).toHaveLength(1);
    expect(await count("program_days")).toBe(2 + 2 * plan.days.length);
  });

  it("помилка в слоті (вправи 999 немає) відкочує весь батч: стара програма лишається активною", async () => {
    await ownerWithHistory();
    const plan = await planFor();
    plan.days[1]!.slots[0]!.exerciseId = 999;
    await expect(repo.activatePlan(OWNER, plan, 9_000)).rejects.toThrow();
    const active = await activePrograms(OWNER);
    expect(active.map((p) => p.name)).toEqual(["Full body A/B"]);
    expect(await count("program_days")).toBe(2);
  });

  it("порожній план → BAD_PLAN без запису", async () => {
    await ownerWithHistory();
    expect(await repo.activatePlan(OWNER, { name: "x", days: [] }, 1)).toEqual({ ok: false, error: "BAD_PLAN" });
    expect((await activePrograms(OWNER))[0]!.name).toBe("Full body A/B");
  });

  it("ізоляція userId: активація одного не чіпає програму й історію іншого", async () => {
    await ownerWithHistory();
    await repo.upsertUser(OTHER, "Інший", 0);
    await seed(2_000);
    const otherBefore = (await activePrograms(OTHER))[0]!;
    const history = await historySnapshot();

    await repo.activatePlan(OWNER, await planFor(), 9_000);
    expect(await activePrograms(OTHER)).toEqual([otherBefore]);
    expect(await historySnapshot()).toBe(history);
    expect(await repo.getActiveProgram(OTHER)).toMatchObject({ id: otherBefore.id });
    // Чужа програма недоступна: день плану власника для OTHER не існує.
    expect(await repo.getProgramDay(OTHER, "UP")).toBeNull();
  });
});

describe("міграція 0002: назви днів A/B (P3.1)", () => {
  const migration = () => {
    const m = ((env as unknown as { TEST_MIGRATIONS: unknown }).TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((x) => x.name.startsWith("0002"));
    if (!m) throw new Error("міграції 0002 немає");
    return m.queries.filter((q) => q.includes("UPDATE `program_days`"));
  };

  it("UPDATE-и міграції називають A/B, не чіпають історію й ідемпотентні; чужу назву не затирають", async () => {
    await ownerWithHistory();
    await env.DB.prepare("UPDATE program_days SET title = NULL").run();
    const before = await historySnapshot();
    const run = () => env.DB.batch(migration().map((q) => env.DB.prepare(q)));
    expect(migration()).toHaveLength(2);

    await run();
    const titles = async () => (await env.DB.prepare("SELECT code, title FROM program_days ORDER BY code").all()).results;
    expect(await titles()).toEqual([{ code: "A", title: "Все тіло A" }, { code: "B", title: "Все тіло B" }]);
    await run();
    expect(await titles()).toEqual([{ code: "A", title: "Все тіло A" }, { code: "B", title: "Все тіло B" }]);
    expect(await historySnapshot()).toBe(before);

    await env.DB.prepare("UPDATE program_days SET title = 'Моє' WHERE code = 'A'").run();
    await run();
    expect((await titles())[0]).toEqual({ code: "A", title: "Моє" });
  });

  it("свіжий сид одразу дає A/B назви", async () => {
    await repo.upsertUser(OWNER, "Денис", 0);
    await seed();
    expect((await repo.getActiveProgram(OWNER))?.days.map((d) => d.title)).toEqual(["Все тіло A", "Все тіло B"]);
  });

  it("title довший за 40 символів → CHECK", async () => {
    await repo.upsertUser(OWNER, "Денис", 0);
    await seed();
    await expect(env.DB.prepare("UPDATE program_days SET title = ? WHERE code = 'A'").bind("я".repeat(41)).run()).rejects.toThrow(/CHECK/);
  });
});

describe("профіль, анкета, стартові ваги", () => {
  beforeEach(async () => {
    await repo.upsertUser(OWNER, "Денис", 0);
    await repo.upsertUser(OTHER, "Інший", 0);
  });

  it("upsertProfile пише лише передані поля, повтор не дублює; goal NULL = анкета не пройдена", async () => {
    expect(await repo.getProfile(OWNER)).toBeNull();
    await repo.upsertProfile(OWNER, { goal: "strength", goalNote: "жим 100" }, 10);
    await repo.upsertProfile(OWNER, { level: "mid", limits: "knee,back" }, 20);
    await repo.upsertProfile(OWNER, { level: "adv" }, 30);
    const p = await repo.getProfile(OWNER);
    expect(p).toMatchObject({ goal: "strength", goalNote: "жим 100", level: "adv", limits: "knee,back", createdAt: 10, updatedAt: 30, heightCm: null });
    expect(await count("user_profiles")).toBe(1);
    expect(await repo.getProfile(OTHER)).toBeNull();
  });

  it("CHECK-и профілю: хибна ціль, дні, обмеження, зріст, довга нотатка", async () => {
    const bad = [
      { goal: "x" }, { daysPerWeek: 7 }, { sessionMin: 50 }, { limits: "knee,,back" }, { limits: "knee,gym" }, { limits: ",knee" },
      { heightCm: 100 }, { weightKg: 20 }, { birthYear: 1900 }, { goalNote: "я".repeat(301) }, { sleepBand: "9" },
    ];
    for (const patch of bad) {
      await expect(repo.upsertProfile(OWNER, patch as never, 1), JSON.stringify(patch)).rejects.toThrow();
    }
    for (const ok of ["", "knee", "knee,back,shoulder,wrist"]) await repo.upsertProfile(OWNER, { limits: ok }, 1);
  });

  it("onboarding_state: створення, оновлення кроку без зміни started_at, CHECK-и", async () => {
    await repo.upsertOnboarding(OWNER, { step: "goal", msgId: 77 }, 100);
    await repo.upsertOnboarding(OWNER, { step: "height" }, 200);
    expect(await repo.getOnboarding(OWNER)).toMatchObject({ status: "active", step: "height", msgId: 77, sub: 0, planVariant: 0, startedAt: 100, updatedAt: 200 });
    expect(await repo.getOnboarding(OTHER)).toBeNull();
    await expect(repo.upsertOnboarding(OWNER, { planVariant: 3 }, 300)).rejects.toThrow();
    await expect(repo.upsertOnboarding(OWNER, { sub: 4 }, 300)).rejects.toThrow();
    await expect(repo.upsertOnboarding(OWNER, { step: "nope" as never }, 300)).rejects.toThrow();
  });

  it("start_weights: upsert, читання лише своїх, видалення", async () => {
    await seed();
    await repo.setStartWeight(OWNER, 1, 60, 8, 10);
    await repo.setStartWeight(OWNER, 1, 62.5, 6, 20);
    await repo.setStartWeight(OTHER, 1, 100, 5, 30);
    expect(await repo.getStartWeight(OWNER, 1)).toEqual({ exerciseId: 1, weightKg: 62.5, reps: 6 });
    expect(await repo.getStartWeights(OWNER)).toHaveLength(1);
    expect(await repo.getStartWeight(OTHER, 1)).toMatchObject({ weightKg: 100 });
    await repo.clearStartWeight(OWNER, 1);
    expect(await repo.getStartWeight(OWNER, 1)).toBeNull();
    expect(await repo.getStartWeight(OTHER, 1)).not.toBeNull();
    await expect(repo.setStartWeight(OWNER, 1, 60, 31, 1)).rejects.toThrow();
    await expect(repo.setStartWeight(OWNER, 999, 60, 8, 1)).rejects.toThrow();
  });

  it("getPlanCatalog: усі 30 вправ з метаданими; stress розібрано в масив", async () => {
    await seed();
    const cat = await repo.getPlanCatalog();
    expect(cat).toHaveLength(30);
    expect(cat.find((c) => c.id === 1)).toMatchObject({ pattern: "squat", kind: "compound", place: "gym", minLevel: 1, stress: ["knee", "back"], equipment: "barbell" });
    expect(cat.find((c) => c.id === 11)?.place).toBe("both");
  });

  it("CHECK-и нових стовпців exercises: хибний pattern/kind/min_level", async () => {
    await seed();
    await expect(env.DB.prepare("UPDATE exercises SET pattern = 'arms' WHERE id = 1").run()).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare("UPDATE exercises SET kind = 'x' WHERE id = 1").run()).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare("UPDATE exercises SET min_level = 4 WHERE id = 1").run()).rejects.toThrow(/CHECK/);
  });
});
