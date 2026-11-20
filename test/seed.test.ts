import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG, PROGRAM_DAYS, seedSql, seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { TABLES, count, env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));

async function seed(now = 1_000): Promise<void> {
  await env.DB.batch(seedStatements(now).map((s) => env.DB.prepare(s)));
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await count(t);
  return out;
}

beforeEach(resetDb);

describe("сид (P1.1.1–2)", () => {
  it("чиста БД + профіль власника → 30 вправ, заміни за таблицею, одна активна програма A/B зі слотами", async () => {
    await repo.upsertUser(111, "Денис", 0);
    await seed();

    const ex = await env.DB.prepare("SELECT id, slug, equipment, weight_step_kg, min_weight_kg, muscle_group, video_url FROM exercises ORDER BY id").all();
    expect(ex.results).toHaveLength(30);
    expect(ex.results).toEqual(
      CATALOG.map((e) => ({ id: e.id, slug: e.slug, equipment: e.equipment, weight_step_kg: e.stepKg, min_weight_kg: e.minKg, muscle_group: e.group, video_url: e.videoUrl })),
    );

    // Таблиця каталогу phase-1.md, стовпчик «Заміни» — номерами.
    const subs = await env.DB.prepare("SELECT exercise_id AS e, substitute_id AS s FROM exercise_substitutes ORDER BY e, s").all();
    const expected = [[1, 7], [1, 11], [2, 9], [2, 12], [3, 13], [3, 16], [4, 14], [5, 10], [5, 18], [6, 15], [7, 1], [7, 11], [8, 16], [9, 2], [9, 12], [9, 17], [10, 5], [10, 18]];
    // Старі 18 пар лишились як були (спека 1.1); нові — за каталогом 1b.1.
    expect(subs.results.map((r) => [r.e, r.s]).filter(([e]) => Number(e) <= 18)).toEqual(expected);
    expect(subs.results.length).toBeGreaterThan(expected.length);

    const program = await repo.getActiveProgram(111);
    expect(program?.name).toBe("Full body A/B");
    expect(program?.days.map((d) => [d.code, d.position])).toEqual([["A", 1], ["B", 2]]);

    // decisions.md «Склад програми»: A — вправи 1–5, B — 6–10, у тому ж порядку.
    const dayA = await repo.getProgramDay(111, "A");
    const dayB = await repo.getProgramDay(111, "B");
    const shape = (d: typeof dayA) => d?.slots.map((s) => [s.position, s.exercise.id, s.sets, s.repMin, s.repMax]);
    expect(shape(dayA)).toEqual([[1, 1, 3, 6, 10], [2, 2, 3, 6, 10], [3, 3, 3, 8, 12], [4, 4, 2, 8, 12], [5, 5, 3, 10, 15]]);
    expect(shape(dayB)).toEqual([[1, 6, 3, 6, 10], [2, 7, 3, 8, 12], [3, 8, 3, 8, 12], [4, 9, 3, 8, 12], [5, 10, 3, 8, 12]]);
    expect(dayA?.slots[0]?.exercise.cues).toEqual(CATALOG[0]?.cues);
  });

  it("сид двічі → кількість рядків кожної таблиці та сама", async () => {
    await repo.upsertUser(111, "Денис", 0);
    await seed(1_000);
    const first = await counts();
    await seed(2_000);
    expect(await counts()).toEqual(first);
    expect(first).toMatchObject({ exercises: 30, exercise_substitutes: 40, programs: 1, program_days: 2, program_exercises: 10 });
  });

  it("повторний сид оновлює крок вправи (хибне припущення → правка сида), програму не чіпає", async () => {
    await repo.upsertUser(111, "Денис", 0);
    await seed(1_000);
    await env.DB.prepare("UPDATE exercises SET weight_step_kg = 2.5 WHERE slug = 'barbell-squat'").run();
    await seed(2_000);
    const row = await env.DB.prepare("SELECT weight_step_kg FROM exercises WHERE slug = 'barbell-squat'").first();
    expect(row).toEqual({ weight_step_kg: 5 });
    const prog = await env.DB.prepare("SELECT created_at FROM programs").all();
    expect(prog.results).toEqual([{ created_at: 1_000 }]);
  });

  it("без профілю в users сид кладе каталог, програми не створює", async () => {
    await seed();
    expect(await count("exercises")).toBe(30);
    expect(await count("programs")).toBe(0);
  });

  it("підказки: рівно 3, кожна ≤ 60 символів; програма — за decisions.md", () => {
    for (const e of CATALOG) {
      expect(e.cues, e.slug).toHaveLength(3);
      for (const c of e.cues) expect([...c].length, `${e.slug}: ${c}`).toBeLessThanOrEqual(60);
    }
    expect(PROGRAM_DAYS.map((d) => d.code)).toEqual(["A", "B"]);
  });

  it("seedSql — ті самі інструкції з «;» для wrangler --file", () => {
    const sql = seedSql(5);
    expect(sql.split(";\n").length - 1).toBe(seedStatements(5).length);
  });
});

describe("обмеження БД (P1.1.3–4)", () => {
  beforeEach(async () => {
    await repo.upsertUser(111, "Денис", 0);
    await seed();
  });

  const insertSet = (skipped: number, weight: number | null, reps: number | null) =>
    env.DB.prepare(
      `INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped)
       SELECT w.id, pe.id, pe.exercise_id, 1, ?, ?, 20, 6, ? FROM workouts w JOIN program_exercises pe ON pe.program_day_id = w.program_day_id LIMIT 1`,
    )
      .bind(weight, reps, skipped)
      .run();

  async function startA(): Promise<void> {
    const day = await repo.getProgramDay(111, "A");
    await repo.startWorkout(111, day!.id, 1_000);
  }

  it("друга active = 1 програма того самого user → помилка обмеження", async () => {
    await expect(
      env.DB.prepare("INSERT INTO programs (user_id, name, active, created_at) VALUES (111, 'Друга', 1, 0)").run(),
    ).rejects.toThrow(/UNIQUE/);
    await env.DB.prepare("INSERT INTO programs (user_id, name, active, created_at) VALUES (111, 'Архів', 0, 0)").run();
  });

  it("друге active-тренування того самого user → помилка обмеження", async () => {
    await startA();
    await expect(
      env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at) SELECT 111, program_day_id, 'active', 2 FROM workouts").run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("skipped = 1 з reps = 8 → CHECK", async () => {
    await startA();
    await expect(insertSet(1, null, 8)).rejects.toThrow(/CHECK/);
  });

  it("skipped = 0 без ваги → CHECK (NULL не проскакує крізь >= 0)", async () => {
    await startA();
    await expect(insertSet(0, null, 8)).rejects.toThrow(/CHECK/);
    await expect(insertSet(0, 20, null)).rejects.toThrow(/CHECK/);
    await insertSet(0, 20, 8);
    expect(await count("workout_sets")).toBe(1);
  });

  it("status = 'done' без effort → CHECK", async () => {
    await startA();
    await expect(env.DB.prepare("UPDATE workouts SET status = 'done', finished_at = 2").run()).rejects.toThrow(/CHECK/);
  });

  it("await_input у не-active → CHECK", async () => {
    await startA();
    await expect(
      env.DB.prepare("UPDATE workouts SET status = 'abandoned', finished_at = 2, await_input = '{}'").run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("bodyweight з кроком 2,5 → CHECK", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO exercises (slug, name_uk, equipment, weight_step_kg, min_weight_kg, muscle_group, cues_uk) VALUES ('x', 'Х', 'bodyweight', 2.5, 0, 'core', 'a\nb\nc')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("rep_max < rep_min → CHECK", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO program_exercises (program_day_id, exercise_id, position, sets, rep_min, rep_max) SELECT id, 11, 9, 3, 10, 8 FROM program_days WHERE code = 'A'",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });

  // Рев'ю 1.1, дрібниця 1: три «рядки», з яких частина порожня, — не три підказки.
  it("порожня підказка (два \\n поспіль, \\n на краю) → CHECK", async () => {
    for (const cues of ["a\n\nb", "a\n\n", "\na\nb", "a\nb\n"]) {
      await expect(
        env.DB.prepare(
          "INSERT INTO exercises (slug, name_uk, equipment, weight_step_kg, min_weight_kg, muscle_group, cues_uk) VALUES ('z', 'З', 'cable', 5, 5, 'core', ?)",
        )
          .bind(cues)
          .run(),
        JSON.stringify(cues),
      ).rejects.toThrow(/CHECK/);
    }
  });

  it("підказок не 3 → CHECK", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO exercises (slug, name_uk, equipment, weight_step_kg, min_weight_kg, muscle_group, cues_uk) VALUES ('y', 'У', 'cable', 5, 5, 'core', 'a\nb')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});
