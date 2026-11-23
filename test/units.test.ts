// Одиниці вправи (docs/spec/phase-1-flow.md, «Одиниці вправи»; decisions.md, «Одиниці: гантелі й односторонні вправи»):
// гантельна вправа — вага ОДНІЄЇ гантелі, одностороння — повтори НА КОЖНУ сторону. Кожна така вправа сиду
// має підпис на екрані, у запиті ваги, в калібруванні, в підсумку, нагадуванні, /prohrama і /progres.
import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG, UNILATERAL_SLUGS, seedStatements, type CatalogEntry } from "../scripts/seed-core";
import migration0011 from "../migrations/0011_exercise_unilateral.sql?raw";
import { createDb } from "../src/db/client";
import { exerciseBlock } from "../src/bot/texts";
import {
  badLift,
  badWeightText,
  liftText,
  prescriptionText,
  programText,
  recordReps,
  recordWeight,
  trainReminderText,
  weightEcho,
  weightPromptText,
} from "../src/bot/texts";
import { screenText } from "../src/bot/workout-view";
import { createRepo, type Exercise } from "../src/db/repo";
import { NO_UNITS, kgUnit, repsTail, unitsNote, unitsOf } from "../src/domain/units";
import { env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));

/** Гантельні вправи сиду: вага — одна гантель. Список — з рішення (decisions.md), не з коду. */
const DUMBBELL = [
  "seated-dumbbell-press",
  "goblet-squat",
  "dumbbell-bench-press",
  "dumbbell-romanian-deadlift",
  "dumbbell-row",
  "dumbbell-lunge",
  "dumbbell-overhead-press",
  "dumbbell-lateral-raise",
  "incline-dumbbell-press",
  "dumbbell-reverse-fly",
].sort();
/** Односторонні: слаг → іменник сторони. «Мертвий жук» — чергування, тут його немає навмисно. */
const UNILATERAL: Record<string, string> = { "dumbbell-lunge": "ногу", "dumbbell-row": "руку" };

const toExercise = (e: CatalogEntry): Exercise => ({
  id: e.id,
  slug: e.slug,
  nameUk: e.nameUk,
  equipment: e.equipment,
  weightStepKg: e.stepKg,
  minWeightKg: e.minKg,
  muscleGroup: e.group,
  cues: e.cues,
  videoUrl: e.videoUrl,
  unilateral: e.unilateral,
});
const bySlug = (slug: string): Exercise => toExercise(CATALOG.find((e) => e.slug === slug)!);

function screen(e: Exercise, weightKg = 20, reps = 10): string {
  return screenText({
    workoutId: 1,
    dayName: "Все тіло A",
    slotIndex: 0,
    slotCount: 5,
    programExerciseId: 1,
    sets: 3,
    exercise: e,
    setNo: 1,
    weightKg,
    reps,
    calibration: false,
    done: [],
    canSwap: false,
    showCues: false,
  });
}

describe("мапінг каталогу: які вправи гантельні й односторонні", () => {
  it("гантельні — рівно за списком рішення", () => {
    expect(CATALOG.filter((e) => e.equipment === "dumbbell").map((e) => e.slug).sort()).toEqual(DUMBBELL);
  });

  it("односторонні — рівно випади й тяга гантелі; решта (зокрема «мертвий жук») — ні", () => {
    expect(CATALOG.filter((e) => e.unilateral).map((e) => e.slug).sort()).toEqual(Object.keys(UNILATERAL).sort());
    expect([...UNILATERAL_SLUGS].sort()).toEqual(Object.keys(UNILATERAL).sort());
    expect(CATALOG.find((e) => e.slug === "dead-bug")!.unilateral).toBe(false);
  });

  it("unitsOf: іменник сторони за групою м'язів; без unilateral сторони немає", () => {
    expect(unitsOf({ equipment: "dumbbell", muscleGroup: "legs", unilateral: true })).toEqual({ dumbbell: true, side: "ногу" });
    expect(unitsOf({ equipment: "dumbbell", muscleGroup: "back", unilateral: true })).toEqual({ dumbbell: true, side: "руку" });
    expect(unitsOf({ equipment: "bodyweight", muscleGroup: "core", unilateral: true })).toEqual({ dumbbell: false, side: "сторону" });
    expect(unitsOf({ equipment: "barbell", muscleGroup: "legs", unilateral: false })).toEqual(NO_UNITS);
  });

  it("підписи: «кг на гантель», «на кожну ногу», пояснення з крапкою-розділювачем", () => {
    const lunge = unitsOf(bySlug("dumbbell-lunge"));
    expect(kgUnit(lunge)).toBe("кг на гантель");
    expect(repsTail(lunge)).toBe(" на кожну ногу");
    expect(unitsNote(lunge)).toBe("вага — однієї гантелі · повтори — на кожну ногу");
    expect(unitsNote(unitsOf(bySlug("dumbbell-bench-press")))).toBe("вага — однієї гантелі");
    expect(unitsNote(NO_UNITS)).toBeNull();
    expect(kgUnit(NO_UNITS)).toBe("кг");
    expect(repsTail(NO_UNITS)).toBe("");
  });
});

describe("екран вправи: кожна гантельна й одностороння вправа підписана", () => {
  it.each(CATALOG.filter((e) => e.equipment === "dumbbell").map((e) => [e.slug]))("%s: «кг на гантель» у рядку цілі", (slug) => {
    const t = screen(bySlug(slug!));
    expect(t).toContain("ціль <b>20 кг на гантель × 10");
  });

  it.each(Object.entries(UNILATERAL))("%s: повтори «на кожну %s»", (slug, noun) => {
    expect(screen(bySlug(slug))).toContain(`ціль <b>20 кг на гантель × 10 на кожну ${noun}</b>`);
  });

  it("двостороння гантельна вправа: «на кожну» немає", () => {
    const t = screen(bySlug("dumbbell-bench-press"));
    expect(t).toContain("кг на гантель");
    expect(t).not.toContain("на кожну");
  });

  it("штанга, тренажер, блок, вага тіла: текст без підписів одиниць (як раніше)", () => {
    for (const slug of ["barbell-squat", "leg-press", "lat-pulldown"]) {
      const t = screen(bySlug(slug), 60, 8);
      expect(t, slug).toContain("ціль <b>60 кг × 8</b>");
      expect(t, slug).not.toMatch(/на гантель|на кожну/);
    }
    expect(screen(bySlug("pull-up"), 0, 8)).toContain("ціль <b>власна вага × 8</b>");
  });
});

describe("запит ваги й калібрування", () => {
  it("гантельна: запит і помилка ваги кажуть «однієї гантелі», штанга — без змін", () => {
    const db = bySlug("dumbbell-bench-press");
    expect(weightPromptText(db)).toContain("<b>однієї гантелі</b>");
    expect(weightPromptText(db)).toContain("не сума двох");
    expect(badWeightText(db)).toContain("не сума двох");
    const bb = bySlug("barbell-bench-press");
    expect(weightPromptText(bb)).not.toMatch(/гантел/);
    expect(badWeightText(bb)).not.toMatch(/гантел/);
    expect(weightPromptText(bb)).toBe("⚖️ Яка вага для <b>Жим лежачи</b>, кг?\nКрок 5 кг, від 20 кг. Наприклад: <code>45</code>");
  });

  it("weightEcho: гантель — «кг на гантель», інакше «кг»", () => {
    expect(weightEcho(22, unitsOf(bySlug("dumbbell-lunge")))).toBe("⚖️ <b>22 кг на гантель</b>");
    expect(weightEcho(60)).toBe("⚖️ <b>60 кг</b>");
  });

  it("калібрування стартової ваги в анкеті: підказка про одиниці, обидва екрани й помилка", () => {
    const lunge = bySlug("dumbbell-lunge");
    expect(liftText(lunge, 0, 3, null, true)).toContain("Вага — однієї гантелі · повтори — на кожну ногу.");
    expect(liftText(lunge, 0, 3, null, false)).toContain("Вага — однієї гантелі · повтори — на кожну ногу.");
    expect(liftText(lunge, 0, 3, { weightKg: 12, reps: 10 } as never, true)).toContain("Зараз: <b>12 кг на гантель × 10 на кожну ногу</b>");
    expect(badLift("format", lunge)).toContain("Вага — однієї гантелі · повтори — на кожну ногу.");
    expect(liftText(bySlug("dumbbell-bench-press"), 0, 3, null, true)).toContain("Вага — однієї гантелі.");
    expect(liftText(bySlug("barbell-squat"), 0, 3, null, true)).not.toMatch(/гантел|на кожну/);
    expect(badLift("weight", bySlug("barbell-squat"))).not.toMatch(/гантел|на кожну/);
  });
});

describe("підсумок, нагадування, /prohrama, /progres, картка ШІ", () => {
  const lunge = unitsOf(bySlug("dumbbell-lunge"));
  const press = unitsOf(bySlug("dumbbell-bench-press"));

  it("рекорди: вага — «на гантель», повтори — «на кожну ногу»", () => {
    expect(recordWeight("Випади з гантелями", 14, 10, lunge)).toBe("Випади з гантелями — <b>14 кг на гантель × 10 на кожну ногу</b>");
    expect(recordWeight("Жим", 30, 8, press)).toBe("Жим — <b>30 кг на гантель × 8</b>");
    expect(recordWeight("Присідання", 60, 8)).toBe("Присідання — <b>60 кг × 8</b>");
    expect(recordReps("Випади", 12, { dumbbell: false, side: "ногу" })).toBe("Випади — <b>12 повт. на кожну ногу</b>");
    expect(recordReps("Підтягування", 12)).toBe("Підтягування — <b>12 повт.</b>");
  });

  it("нагадування про тренування: калібрування й звичайний рядок", () => {
    const base = { bodyweight: false, weightKg: 12, targetReps: 10 };
    const t = trainReminderText({
      dayLabel: "Все тіло A",
      lines: [
        { nameUk: "Випади з гантелями", units: lunge, calibration: true, ...base },
        { nameUk: "Жим гантелей лежачи", units: press, calibration: false, ...base },
        { nameUk: "Жим лежачи", units: NO_UNITS, calibration: false, ...base },
      ],
    });
    expect(t).toContain("Випади з гантелями — калібрування, старт ≈ 12 кг на гантель × 10 на кожну ногу");
    expect(t).toContain("Жим гантелей лежачи — 12 кг на гантель × 10");
    expect(t).not.toContain("Жим гантелей лежачи — 12 кг на гантель × 10 на кожну");
    expect(t).toContain("Жим лежачи — 12 кг × 10");
  });

  it("/prohrama: діапазон повторів слота й наступне призначення", () => {
    const lungeEx = bySlug("dumbbell-lunge");
    const day = { id: 1, programId: 1, code: "A", position: 1, title: "Все тіло A", slots: [{ id: 1, position: 1, sets: 3, repMin: 8, repMax: 12, exercise: lungeEx }] };
    const t = programText({
      name: "План",
      days: [day],
      next: { dayName: "Все тіло A", lines: [{ nameUk: lungeEx.nameUk, bodyweight: false, units: lunge, weightKg: 12, targetReps: 10 }] },
      activeDayName: null,
    });
    expect(t).toContain("1. Випади з гантелями — 3 × 8–12 на кожну ногу");
    expect(t).toContain("Випади з гантелями — 12 кг на гантель × 10 на кожну ногу");
  });

  it("/progres: блок вправи має пояснення одиниць у заголовку; штанга — без нього", () => {
    const m = { name: "Випади з гантелями", bodyweight: false, start: { weightKg: 8, reps: 8 }, now: { weightKg: 12, reps: 10 }, record: { weightKg: 12, reps: 10, date: "23.11" }, e1rm: 16 };
    expect(exerciseBlock({ ...m, units: lunge })).toContain("<b>Випади з гантелями</b> <i>(вага — однієї гантелі · повтори — на кожну ногу)</i>");
    expect(exerciseBlock({ ...m, name: "Присідання зі штангою", units: NO_UNITS })).not.toMatch(/гантел|на кожну|<i>/);
  });

  it("картка пропозиції ШІ: призначення з одиницями", () => {
    const p = { weightKg: 12, targetReps: 10, reason: "progress" };
    expect(prescriptionText(p, false, lunge)).toBe("12 кг на гантель × 10 на кожну ногу");
    expect(prescriptionText(p, false)).toBe("12 × 10");
    expect(prescriptionText({ ...p, reason: "calibration" }, false, lunge)).toBe("калібрування");
  });
});

describe("БД: колонка unilateral і міграція 0011", () => {
  beforeEach(resetDb);

  it("сид кладе unilateral = 1 лише для двох вправ; repo.getExercise віддає булеве поле", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const rows = await env.DB.prepare("SELECT slug FROM exercises WHERE unilateral = 1 ORDER BY slug").all<{ slug: string }>();
    expect(rows.results.map((r) => r.slug)).toEqual(Object.keys(UNILATERAL).sort());
    expect((await repo.getExercise(bySlug("dumbbell-lunge").id))!.unilateral).toBe(true);
    expect((await repo.getExercise(bySlug("barbell-squat").id))!.unilateral).toBe(false);
  });

  it("повторний сид повертає ознаку, якщо її стерли (джерело — сид)", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    await env.DB.prepare("UPDATE exercises SET unilateral = 0").run();
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const rows = await env.DB.prepare("SELECT slug FROM exercises WHERE unilateral = 1 ORDER BY slug").all<{ slug: string }>();
    expect(rows.results.map((r) => r.slug)).toEqual(Object.keys(UNILATERAL).sort());
  });

  it("CHECK: unilateral = 2 відхиляється", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    await expect(env.DB.prepare("UPDATE exercises SET unilateral = 2 WHERE slug = 'barbell-squat'").run()).rejects.toThrow();
  });

  it("міграція 0011 на копії таблиці «як на проді»: усі 0 → 1 лише у двох слагів; інших таблиць не чіпає", async () => {
    // Колонки нема на проді до 0011: будуємо таблицю без неї, у ній слаги каталогу, і проганяємо SQL міграції з підміною імені.
    await env.DB.prepare("CREATE TABLE ex_prod (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE)").run();
    await env.DB.batch(CATALOG.map((e) => env.DB.prepare("INSERT INTO ex_prod (id, slug) VALUES (?, ?)").bind(e.id, e.slug)));
    const sql = migration0011.replaceAll("`exercises`", "`ex_prod`");
    expect(sql).not.toBe(migration0011);
    await env.DB.batch(sql.split("--> statement-breakpoint").map((s) => env.DB.prepare(s)));
    const rows = await env.DB.prepare("SELECT slug, unilateral FROM ex_prod ORDER BY id").all<{ slug: string; unilateral: number }>();
    expect(rows.results).toHaveLength(30);
    expect(rows.results.filter((r) => r.unilateral === 1).map((r) => r.slug).sort()).toEqual(Object.keys(UNILATERAL).sort());
    expect(rows.results.filter((r) => r.unilateral === 0)).toHaveLength(28);
    // Записані підходи й стартові ваги міграція не зачіпає: у її SQL цих таблиць немає (змінюється лише підпис).
    expect(migration0011.replace(/^--.*$/gm, "")).not.toMatch(/workout_sets|start_weights|program_exercises/);
    await env.DB.prepare("DROP TABLE ex_prod").run();
  });

  it("getProgressSets: units із колонок exercises (гантель; сторона за групою)", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    await repo.upsertUser(111, "Денис", 0);
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const day = (await repo.getProgramDay(111, "A"))!;
    const slot = day.slots.find((s) => s.exercise.slug === "seated-dumbbell-press")!;
    const w = (await repo.startWorkout(111, day.id, 1_700_000_000_000))!.workout.id;
    await repo.upsertSet(111, { workoutId: w, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: 1, weightKg: 12, reps: 10, prescribedWeightKg: 12, prescribedReps: 10, skipped: false });
    await env.DB.prepare("UPDATE workouts SET status = 'abandoned', finished_at = started_at + 1000 WHERE id = ?").bind(w).run();
    expect((await repo.getProgressSets(111))[0]!.units).toEqual({ dumbbell: true, side: null });
    await env.DB.prepare("UPDATE exercises SET unilateral = 1 WHERE slug = 'seated-dumbbell-press'").run();
    expect((await repo.getProgressSets(111))[0]!.units).toEqual({ dumbbell: true, side: "руку" });
  });
});
