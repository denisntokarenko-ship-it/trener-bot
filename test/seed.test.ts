import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG, PROGRAM_DAYS, seedSql, seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import migration0010 from "../migrations/0010_gym_substitutes.sql?raw";
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
    // Пари вправ 1–10 лишились як були (спека 1.1); для 11–30 — за каталогом (1b.1 і борг [4.2], див. нижче).
    expect(subs.results.map((r) => [r.e, r.s]).filter(([e]) => Number(e) <= 10)).toEqual(expected);
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
    expect(first).toMatchObject({ exercises: 30, exercise_substitutes: 60, programs: 1, program_days: 2, program_exercises: 10 });
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

// Борг [4.2]: у 8 вправ каталог мав «—» у «Заміни», тож у слоті гоблета (день «Все тіло B») не було чим замінити.
// Пари напрямлені: «чим замінити ключ». Очікування — зі спеки (phase-1.md, колонка «Заміни»), не з коду.
const GYM_WEEK_SUBS: Record<string, string[]> = {
  "goblet-squat": ["leg-press", "dumbbell-lunge", "glute-bridge"],
  "dumbbell-bench-press": ["push-up", "incline-dumbbell-press", "machine-chest-press"],
  "pull-up": ["lat-pulldown", "dumbbell-row"],
  "barbell-overhead-press": ["seated-dumbbell-press", "dumbbell-overhead-press"],
  "dumbbell-romanian-deadlift": ["barbell-romanian-deadlift", "glute-bridge"],
  "dumbbell-row": ["seated-cable-row", "barbell-row", "dumbbell-reverse-fly"],
  dips: ["push-up", "dumbbell-bench-press", "machine-chest-press"],
  "hanging-knee-raise": ["dead-bug", "cable-crunch"],
};

async function subsOf(slug: string): Promise<string[]> {
  const r = await env.DB.prepare(
    "SELECT s.slug AS slug FROM exercise_substitutes x JOIN exercises e ON e.id = x.exercise_id JOIN exercises s ON s.id = x.substitute_id WHERE e.slug = ? ORDER BY s.slug",
  )
    .bind(slug)
    .all<{ slug: string }>();
  return r.results.map((x) => x.slug);
}

describe("заміни 8 вправ (борг [4.2])", () => {
  it("сид: кожна з 8 має 1–3 заміни, кожна заміна — вправа каталогу, не сама вона, є варіант без тренажера (place both)", async () => {
    const bySlug = new Map(CATALOG.map((e) => [e.slug, e]));
    for (const [slug, expected] of Object.entries(GYM_WEEK_SUBS)) {
      const entry = bySlug.get(slug);
      expect(entry, slug).toBeDefined();
      expect([...(entry?.substitutes ?? [])].sort(), slug).toEqual([...expected].sort());
      expect(entry!.substitutes.length, slug).toBeGreaterThanOrEqual(1);
      for (const sub of entry!.substitutes) {
        expect(bySlug.has(sub), `${slug} → ${sub}`).toBe(true);
        expect(sub).not.toBe(slug);
      }
      // «Дім»: хоч одна заміна не з тренажера й не з блока (place both, обладнання не machine/cable).
      expect(
        entry!.substitutes.some((s) => bySlug.get(s)!.place === "both" && !["machine", "cable"].includes(bySlug.get(s)!.equipment)),
        slug + ": немає домашньої заміни",
      ).toBe(true);
    }
  });

  it("міграція 0010 на БД, де вправи вже засіяні, а замін 8 вправ ще нема (стан прода), дає рівно очікувані пари і ідемпотентна", async () => {
    await seed();
    const ids = Object.keys(GYM_WEEK_SUBS).map((s) => CATALOG.find((e) => e.slug === s)!.id);
    await env.DB.prepare(`DELETE FROM exercise_substitutes WHERE exercise_id IN (${ids.join(",")})`).run();
    for (const slug of Object.keys(GYM_WEEK_SUBS)) expect(await subsOf(slug), slug).toEqual([]);

    const run = () => env.DB.batch(migration0010.split("--> statement-breakpoint").map((s) => env.DB.prepare(s)));
    await run();
    for (const [slug, expected] of Object.entries(GYM_WEEK_SUBS)) expect(await subsOf(slug), slug).toEqual([...expected].sort());
    expect(await count("exercise_substitutes")).toBe(60);

    await run(); // повтор — без дублів і без помилки PK
    expect(await count("exercise_substitutes")).toBe(60);
  });

  it("міграція 0010 на порожньому каталозі (свіжа БД до сиду) нічого не вставляє і не падає", async () => {
    await env.DB.batch(migration0010.split("--> statement-breakpoint").map((s) => env.DB.prepare(s)));
    expect(await count("exercise_substitutes")).toBe(0);
  });
});
