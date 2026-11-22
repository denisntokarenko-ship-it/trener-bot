import { beforeEach, describe, expect, it } from "vitest";
import { prescribeSlot } from "../src/bot/prescribe";
import { seedStatements } from "../scripts/seed-core";
import { PROPOSAL_TTL_MS } from "../src/config";
import { TOOL_DEFS, TOOL_NAMES, fitJson, runTool, type ToolContext } from "../src/ai/tools";
import { createDb } from "../src/db/client";
import { createRepo, type NutritionTarget, type ProgramDay, type Repo } from "../src/db/repo";
import { addDays, localDate } from "../src/domain/time";
import { env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const A = 111;
const B = 222;
const NOW = 1_700_000_000_000; // 2023-11-14 22:13 UTC → локальна дата Києва 2023-11-15
const TZ = "Europe/Kyiv";
const TODAY = localDate(NOW, TZ);

let dayA: ProgramDay;
let dayB: ProgramDay;

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(A, "Денис", 0);
  await repo.upsertUser(B, "Інший", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
  dayA = (await repo.getProgramDay(A, "A"))!;
  dayB = (await repo.getProgramDay(A, "B"))!;
});

const ctx = (userId = A, now = NOW): ToolContext => ({ repo, userId, tz: TZ, now });
const call = async (name: string, input: unknown, userId = A, now = NOW) => runTool(ctx(userId, now), name, input);
const json = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

/** Кількість рядків усіх таблиць (крім службових) — для доказу «читальні інструменти нічого не пишуть». */
async function counts(): Promise<Record<string, number>> {
  const names = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
  const out: Record<string, number> = {};
  for (const { name } of names.results) out[name] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>())!.n;
  return out;
}

const target = (validFrom: string, kcal = 2480, p = 144, f = 64, c = 332, reason: NutritionTarget["reason"] = "formula"): NutritionTarget => ({ validFrom, kcal, proteinG: p, fatG: f, carbsG: c, reason, sourceDate: null });

async function slotRow(id: number) {
  return env.DB.prepare("SELECT exercise_id, sets, rep_min, rep_max FROM program_exercises WHERE id = ?").bind(id).first<{ exercise_id: number; sets: number; rep_min: number; rep_max: number }>();
}
async function proposalRow(id: number) {
  return env.DB.prepare("SELECT status, applied_at, decided_at FROM ai_proposals WHERE id = ?").bind(id).first<{ status: string; applied_at: number | null; decided_at: number | null }>();
}
const proposalsCount = async (): Promise<number> => (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_proposals").first<{ n: number }>())!.n;

/** Заміна слота дня A (присідання) на вправу зі списку замін. */
async function squatSwap(): Promise<{ slotId: number; fromId: number; toId: number }> {
  const slot = dayA.slots[0]!;
  const subs = await repo.getSubstitutes(slot.exercise.id);
  const to = subs.find((s) => !dayA.slots.some((x) => x.exercise.id === s.id))!;
  return { slotId: slot.id, fromId: slot.exercise.id, toId: to.id };
}

async function seedWorkout(userId: number, day: ProgramDay, at: number, weight: number, reps = 8): Promise<void> {
  const r = await repo.startWorkout(userId, day.id, at);
  const slot = day.slots[0]!;
  for (let n = 1; n <= 3; n++) {
    await repo.upsertSet(userId, { workoutId: r!.workout.id, programExerciseId: slot.id, exerciseId: slot.exercise.id, setNo: n, weightKg: weight, reps, prescribedWeightKg: weight, prescribedReps: reps, skipped: false });
  }
  await repo.finishWorkout(userId, r!.workout.id, 3, at + 3_000_000);
}

describe("реєстр інструментів (P4.1.2)", () => {
  it("рівно 6 інструментів, жодна схема не має user_id, additionalProperties: false", () => {
    expect([...TOOL_NAMES].sort()).toEqual(["get_exercise_history", "get_program", "get_recent_workouts", "get_today_food", "get_weight_trend", "propose_change"]);
    for (const t of TOOL_DEFS) {
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(Object.keys(t.input_schema.properties)).not.toContain("user_id");
    }
  });

  it("невідомий інструмент і чужі поля (user_id) — is_error, не виняток", async () => {
    expect((await call("delete_everything", {})).isError).toBe(true);
    for (const name of TOOL_NAMES) {
      const r = await call(name, { user_id: B, kind: "swap_exercise", reason: "x", exercise_id: 1 });
      expect(r.isError, name).toBe(true);
    }
    expect((await call("get_program", [])).isError).toBe(true);
  });
});

describe("читальні інструменти (P4.1.1)", () => {
  it("не змінюють жодної таблиці й повертають лише власні рядки", async () => {
    // Дані A.
    await seedWorkout(A, dayA, NOW - 5 * 86_400_000, 60);
    await repo.upsertBodyWeight(A, TODAY, 790, NOW);
    await repo.insertTarget(A, target("2023-11-01"), NOW);
    // Дані B — впізнавані значення, яких A бачити не має.
    await seedWorkout(B, (await repo.getProgramDay(B, "A"))!, NOW - 4 * 86_400_000, 77.5, 9);
    await repo.upsertBodyWeight(B, TODAY, 555, NOW);
    await repo.insertTarget(B, target("2023-11-01", 1999), NOW);
    const food = (await env.DB.prepare("INSERT INTO foods (name_uk, kcal_100, protein_100_dg, fat_100_dg, carbs_100_dg, source, created_at) VALUES ('ЧужаЇжа', 100, 10, 10, 10, 'seed', 0)").run()).meta.last_row_id;
    const mealId = await repo.createPendingMeal(B, { eatenAt: NOW, localDate: TODAY, photoFileId: null, caption: null, aiModel: "m", aiRawJson: "{}", items: [{ foodId: food, grams: 100, confidence: "high" }] }, NOW);
    await repo.confirmMeal(B, mealId!, NOW);

    const before = await counts();
    const outs = [
      await call("get_recent_workouts", {}),
      await call("get_exercise_history", { exercise_id: dayA.slots[0]!.exercise.id }),
      await call("get_weight_trend", {}),
      await call("get_program", {}),
      await call("get_today_food", {}),
    ];
    expect(await counts()).toEqual(before);
    for (const r of outs) expect(r.isError).toBe(false);
    const all = outs.map((o) => o.content).join("\n");
    for (const foreign of ["77.5", "555", "1999", "ЧужаЇжа"]) expect(all).not.toContain(foreign);
    // Свої дані на місці.
    expect(json(outs[0]!).workouts).toHaveLength(1);
    expect(all).toContain("79"); // вага тіла A
    expect(json(outs[4]!).target).toMatchObject({ kcal: 2480 });
    // Те саме від імені B — дані B, а не A.
    const asB = await call("get_today_food", {}, B);
    expect(json(asB).target).toMatchObject({ kcal: 1999 });
    expect(JSON.stringify(json(asB))).toContain("ЧужаЇжа");
  });

  it("get_program дає слоти, заміни й наступний день; get_weight_trend — вікна W0/W1/W2 і зміну", async () => {
    const p = json(await call("get_program", {})) as { name: string; next_day: { code: string }; days: { code: string; exercises: { program_exercise_id: number; substitutes: unknown[] }[] }[] };
    expect(p.days.map((d) => d.code)).toEqual(["A", "B"]);
    expect(p.next_day.code).toBe("A");
    expect(p.days[0]!.exercises[0]!.program_exercise_id).toBe(dayA.slots[0]!.id);
    expect(p.days[0]!.exercises[0]!.substitutes.length).toBeGreaterThan(0);

    await repo.upsertBodyWeight(A, TODAY, 800, NOW);
    await repo.upsertBodyWeight(A, "2023-11-14", 800, NOW);
    await repo.upsertBodyWeight(A, "2023-11-08", 810, NOW);
    await repo.upsertBodyWeight(A, "2023-11-07", 810, NOW);
    const t = json(await call("get_weight_trend", { days: 14 })) as { avg7: { w0: number; w1: number; w2: number | null }; change_kg: number; n: number; entries: unknown[] };
    expect(t.avg7).toEqual({ w0: 80, w1: 81, w2: null });
    expect(t.change_kg).toBe(-1);
    expect(t.n).toBe(4);
    expect((await call("get_weight_trend", { days: 6 })).isError).toBe(true);
    expect((await call("get_recent_workouts", { n: 9 })).isError).toBe(true);
  });

  it("get_weight_trend: 40 записів → 30 найновіших, n = 40 (Д3)", async () => {
    for (let i = 0; i < 40; i++) await repo.upsertBodyWeight(A, addDays(TODAY, -i), 800 + i, NOW);
    const t = json(await call("get_weight_trend", { days: 60 })) as { entries: { date: string }[]; n: number };
    expect(t.n).toBe(40);
    expect(t.entries).toHaveLength(30);
    expect(t.entries[0]!.date).toBe(addDays(TODAY, -29));
    expect(t.entries[29]!.date).toBe(TODAY);
  });

  it("get_exercise_history: next_prescription збігається з prescribeSlot; нема в програмі — null; чужої історії немає (P4.1.3)", async () => {
    await seedWorkout(A, dayA, NOW - 3 * 86_400_000, 60);
    const slot = dayA.slots[0]!;
    const r = json(await call("get_exercise_history", { exercise_id: slot.exercise.id })) as { sessions: { sets: { w: number; r: number }[] }[]; slot: { program_exercise_id: number }; next_prescription: { weight_kg: number; reps: number; reason: string } };
    const engine = await prescribeSlot(repo, A, slot.exercise, slot);
    expect(r.slot.program_exercise_id).toBe(slot.id);
    expect(r.next_prescription).toEqual({ weight_kg: engine.weightKg, reps: engine.targetReps, reason: engine.reason });
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.sets[0]).toEqual({ w: 60, r: 8 });

    // Вправа поза програмою: історія є (каталог спільний), призначення немає.
    const inProgram = new Set((await Promise.all(["A", "B"].map((c) => repo.getProgramDay(A, c)))).flatMap((d) => d!.slots.map((s) => s.exercise.id)));
    const outside = (await repo.getSubstitutes(slot.exercise.id)).find((e) => !inProgram.has(e.id))!;
    const o = json(await call("get_exercise_history", { exercise_id: outside.id })) as { slot: unknown; next_prescription: unknown; sessions: unknown[] };
    expect(o.slot).toBeNull();
    expect(o.next_prescription).toBeNull();

    // B не бачить сесій A, навіть із id вправи A; слот A для B — помилка.
    const asB = json(await call("get_exercise_history", { exercise_id: slot.exercise.id }, B)) as { sessions: unknown[] };
    expect(asB.sessions).toEqual([]);
    expect((await call("get_exercise_history", { exercise_id: slot.exercise.id, program_exercise_id: slot.id }, B)).isError).toBe(true);
    expect((await call("get_exercise_history", { exercise_id: dayA.slots[1]!.exercise.id, program_exercise_id: slot.id })).isError).toBe(true);
    expect((await call("get_exercise_history", { exercise_id: 999_999 })).isError).toBe(true);
  });

  it("вихід > 4000 символів — валідний JSON із truncated: true (P4.1.3)", async () => {
    const big = { list: Array.from({ length: 200 }, (_, i) => ({ i, text: "x".repeat(40) })), other: 1 };
    const s = fitJson(big, "list");
    expect(s.length).toBeLessThanOrEqual(4000);
    const parsed = JSON.parse(s) as { list: unknown[]; truncated: boolean; other: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.other).toBe(1);
    expect(parsed.list.length).toBeGreaterThan(0);
    expect(parsed.list.length).toBeLessThan(200);
    expect(JSON.parse(fitJson({ list: [1, 2], other: 1 }, "list"))).toEqual({ list: [1, 2], other: 1 }); // малий — без truncated
    expect(JSON.parse(fitJson({ big: "y".repeat(5000) }, null))).toEqual({ truncated: true });

    // Крізь інструмент: підроблений repo з величезним списком тренувань.
    const row = { id: 1, dayCode: "A", dayTitle: null, status: "done" as const, startedAt: NOW, effort: 3, exercises: Array.from({ length: 8 }, (_, i) => ({ nameUk: `Вправа ${i}`, sets: Array.from({ length: 10 }, () => ({ setNo: 1, weightKg: 100, reps: 10, skipped: false })) })) };
    const fake = { getRecentWorkouts: async () => Array.from({ length: 8 }, (_, i) => ({ ...row, id: i })) } as unknown as Repo;
    const r = await runTool({ repo: fake, userId: A, tz: TZ, now: NOW }, "get_recent_workouts", { n: 8 });
    expect(r.content.length).toBeLessThanOrEqual(4000);
    expect((JSON.parse(r.content) as { truncated?: boolean }).truncated).toBe(true);
  });
});

describe("propose_change: валідація (P4.1.4)", () => {
  beforeEach(async () => {
    await repo.insertTarget(A, target("2023-11-01"), NOW); // норма за формулою 2480
  });

  const propose = (input: Record<string, unknown>, userId = A, now = NOW) => call("propose_change", { reason: "бо так краще", ...input }, userId, now);

  it("невалідні входи → is_error і 0 рядків ai_proposals", async () => {
    const { slotId, fromId, toId } = await squatSwap();
    const dayBSlot = dayB.slots[0]!;
    const otherSlot = (await repo.getProgramDay(B, "A"))!.slots[0]!; // слот чужої програми
    const sub2 = (await repo.getSubstitutes(fromId))[0]!;
    // дубль у тому ж дні: друга вправа дня A стає заміною присідання
    const dupSlot = dayA.slots[1]!;
    await env.DB.prepare("UPDATE program_exercises SET exercise_id = ? WHERE id = ?").bind(toId, dupSlot.id).run();
    const cur = (await repo.getProgramDay(A, "A"))!.slots[0]!;
    const bad: [string, Record<string, unknown>][] = [
      ["слот чужої програми", { kind: "swap_exercise", program_exercise_id: otherSlot.id, to_exercise_id: toId }],
      ["неіснуючий слот", { kind: "swap_exercise", program_exercise_id: 999_999, to_exercise_id: toId }],
      ["to не з замін", { kind: "swap_exercise", program_exercise_id: dayBSlot.id, to_exercise_id: slotId }],
      ["та сама вправа", { kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: fromId }],
      ["вправа вже є в дні", { kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId }],
      ["sets 1", { kind: "change_sets_reps", program_exercise_id: slotId, sets: 1, rep_min: 6, rep_max: 10 }],
      ["sets 6", { kind: "change_sets_reps", program_exercise_id: slotId, sets: 6, rep_min: 6, rep_max: 10 }],
      ["rep_min 3", { kind: "change_sets_reps", program_exercise_id: slotId, sets: 3, rep_min: 3, rep_max: 8 }],
      ["rep_max 16", { kind: "change_sets_reps", program_exercise_id: slotId, sets: 3, rep_min: 12, rep_max: 16 }],
      ["різниця 1", { kind: "change_sets_reps", program_exercise_id: slotId, sets: 3, rep_min: 6, rep_max: 7 }],
      ["різниця 7", { kind: "change_sets_reps", program_exercise_id: slotId, sets: 3, rep_min: 5, rep_max: 12 }],
      ["без змін", { kind: "change_sets_reps", program_exercise_id: slotId, sets: cur.sets, rep_min: cur.repMin, rep_max: cur.repMax }],
      ["kcal 1199", { kind: "adjust_target", kcal: 1199 }],
      ["формула +301", { kind: "adjust_target", kcal: 2781 }],
      ["формула −301", { kind: "adjust_target", kcal: 2179 }],
      ["kcal = чинна", { kind: "adjust_target", kcal: 2480 }],
      ["kcal дробове", { kind: "adjust_target", kcal: 2400.5 }],
      ["невідомий kind", { kind: "delete_program" }],
      ["зайве поле from_exercise_id (payload — не вхід моделі)", { kind: "swap_exercise", program_exercise_id: dayBSlot.id, to_exercise_id: sub2.id, from_exercise_id: 1 }],
      ["поле іншого виду", { kind: "adjust_target", kcal: 2400, sets: 3 }],
      ["немає поля", { kind: "swap_exercise", program_exercise_id: slotId }],
    ];
    for (const [name, input] of bad) {
      const r = await propose(input);
      expect(r.isError, name).toBe(true);
    }
    expect((await call("propose_change", { kind: "adjust_target", kcal: 2400 })).isError).toBe(true); // немає reason
    expect((await call("propose_change", { kind: "adjust_target", kcal: 2400, reason: "   " })).isError).toBe(true);
    expect((await call("propose_change", { kind: "adjust_target", kcal: 2400, reason: "я".repeat(201) })).isError).toBe(true);
    expect(await proposalsCount()).toBe(0);
    // Межі ±300 включно — проходять.
    expect((await propose({ kind: "adjust_target", kcal: 2780 })).isError).toBe(false);
  });

  it("від'ємні вуглеводи й відсутня норма — помилка", async () => {
    await env.DB.prepare("DELETE FROM nutrition_targets WHERE user_id = ?").bind(A).run();
    expect((await propose({ kind: "adjust_target", kcal: 2400 })).isError).toBe(true); // норми немає
    await repo.insertTarget(A, target("2023-11-01", 2000, 300, 120, 0), NOW); // 4·300 + 9·120 = 2280 > 2000
    expect((await propose({ kind: "adjust_target", kcal: 1900 })).isError).toBe(true);
    expect(await proposalsCount()).toBe(0);
  });

  it("валідна пропозиція — рівно один pending; payload збудовано з БД; нічого більше не змінилось", async () => {
    const { slotId, fromId, toId } = await squatSwap();
    const before = await counts();
    const slotBefore = await slotRow(slotId);
    const r = await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId });
    expect(r.isError).toBe(false);
    const out = json(r) as { proposal_id: number; status: string; summary: string };
    expect(out.status).toBe("pending_user_confirmation");
    expect(out.summary).toContain("Замінити");
    const after = await counts();
    expect(after.ai_proposals).toBe(before.ai_proposals! + 1);
    expect({ ...after, ai_proposals: 0 }).toEqual({ ...before, ai_proposals: 0 }); // жодна інша таблиця не змінилась
    expect(await slotRow(slotId)).toEqual(slotBefore); // програма не змінена (P4.1.2)
    const p = (await repo.getProposal(A, out.proposal_id))!;
    expect(p).toMatchObject({ kind: "swap_exercise", status: "pending", subjectKey: `pe:${slotId}`, appliedAt: null, messageId: null });
    expect(p.payload).toMatchObject({ from_exercise_id: fromId, to_exercise_id: toId, program_exercise_id: slotId });
    expect(p.expiresAt).toBe(NOW + PROPOSAL_TTL_MS);
    expect(r.proposal).toEqual({ id: p.id, created: true, messageId: null });

    const t = await propose({ kind: "adjust_target", kcal: 2300 });
    const tp = (await repo.getProposal(A, (json(t) as { proposal_id: number }).proposal_id))!;
    expect(tp.payload).toEqual({ kcal: 2300, protein_g: 144, fat_g: 64, carbs_g: 287, base_valid_from: "2023-11-01", from_kcal: 2480 });
  });

  it("другий pending на той самий слот повертає наявну (already_pending), нових рядків немає; четверта відкрита — помилка", async () => {
    const { slotId, toId } = await squatSwap();
    const first = json(await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId })) as { proposal_id: number };
    const again = await propose({ kind: "change_sets_reps", program_exercise_id: slotId, sets: 4, rep_min: 6, rep_max: 8 }); // інший вид, той самий слот
    expect(again.isError).toBe(false);
    expect(json(again)).toMatchObject({ proposal_id: first.proposal_id, status: "already_pending" });
    expect(again.proposal).toMatchObject({ id: first.proposal_id, created: false });
    expect(await proposalsCount()).toBe(1);

    await repo.setProposalMessageId(A, first.proposal_id, 77);
    expect((await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId })).proposal).toMatchObject({ created: false, messageId: 77 });

    const s2 = dayA.slots[1]!;
    expect((await propose({ kind: "change_sets_reps", program_exercise_id: s2.id, sets: 4, rep_min: 8, rep_max: 12 })).isError).toBe(false);
    expect((await propose({ kind: "adjust_target", kcal: 2300 })).isError).toBe(false);
    const fourth = await propose({ kind: "change_sets_reps", program_exercise_id: dayA.slots[2]!.id, sets: 4, rep_min: 8, rep_max: 12 });
    expect(fourth.isError).toBe(true);
    expect(await proposalsCount()).toBe(3);
  });

  it("прострочений pending (крон ще не пройшов) не блокує предмет: стара → expired, нова створена", async () => {
    const { slotId, toId } = await squatSwap();
    const old = json(await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId })) as { proposal_id: number };
    const later = NOW + PROPOSAL_TTL_MS + 1000;
    const fresh = await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId }, A, later);
    expect(json(fresh).status).toBe("pending_user_confirmation");
    expect((await proposalRow(old.proposal_id))!.status).toBe("expired");
    expect(await proposalsCount()).toBe(2);
  });

  it("межа: pending з expires_at == now уже прострочений — стара → expired, нова створена (Д3)", async () => {
    const { slotId, toId } = await squatSwap();
    const old = json(await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId })) as { proposal_id: number };
    const fresh = await propose({ kind: "swap_exercise", program_exercise_id: slotId, to_exercise_id: toId }, A, NOW + PROPOSAL_TTL_MS);
    expect(json(fresh).status).toBe("pending_user_confirmation");
    expect((await proposalRow(old.proposal_id))!.status).toBe("expired");
  });

  it("ізоляція: `target` спільний для всіх subject_key — чужа відкрита пропозиція не повертається як наявна (В2)", async () => {
    await repo.insertTarget(B, target("2023-11-01"), NOW);
    const theirs = json(await propose({ kind: "adjust_target", kcal: 2300 }, B)) as { proposal_id: number };
    expect(theirs.proposal_id).toBeGreaterThan(0);
    // A заповнює ліміт іншими предметами: INSERT дає 0 змін, пошук «наявної» мусить фільтрувати user_id.
    expect((await propose({ kind: "swap_exercise", program_exercise_id: (await squatSwap()).slotId, to_exercise_id: (await squatSwap()).toId })).isError).toBe(false);
    expect((await propose({ kind: "change_sets_reps", program_exercise_id: dayA.slots[1]!.id, sets: 4, rep_min: 8, rep_max: 12 })).isError).toBe(false);
    expect((await propose({ kind: "change_sets_reps", program_exercise_id: dayA.slots[2]!.id, sets: 4, rep_min: 8, rep_max: 12 })).isError).toBe(false);
    const mine = await propose({ kind: "adjust_target", kcal: 2300 });
    expect(mine.isError).toBe(true);
    expect(mine.content).not.toContain(String(theirs.proposal_id));
    expect(mine.proposal).toBeUndefined();
    expect(await proposalsCount()).toBe(4); // 3 в A + 1 у B
  });
});

describe("applyProposal (P4.1.5–6)", () => {
  beforeEach(async () => {
    await repo.insertTarget(A, target("2023-11-01"), NOW);
  });

  async function makeSwap(): Promise<{ id: number; slotId: number; fromId: number; toId: number }> {
    const s = await squatSwap();
    const r = await call("propose_change", { kind: "swap_exercise", program_exercise_id: s.slotId, to_exercise_id: s.toId, reason: "коліно" });
    return { id: (json(r) as { proposal_id: number }).proposal_id, ...s };
  }
  async function makeSets(slotIdx = 0): Promise<{ id: number; slotId: number }> {
    const slot = dayA.slots[slotIdx]!;
    const r = await call("propose_change", { kind: "change_sets_reps", program_exercise_id: slot.id, sets: 4, rep_min: 6, rep_max: 8, reason: "сила" });
    return { id: (json(r) as { proposal_id: number }).proposal_id, slotId: slot.id };
  }
  async function makeTarget(kcal = 2300): Promise<number> {
    return (json(await call("propose_change", { kind: "adjust_target", kcal, reason: "повільніше схуднення" })) as { proposal_id: number }).proposal_id;
  }

  it("двічі: одна зміна, accepted + applied_at; друге — already (P4.1.5)", async () => {
    const { id, slotId, toId } = await makeSwap();
    const r1 = await repo.applyProposal(A, id, NOW + 1000, TODAY);
    expect(r1.outcome).toBe("applied");
    expect(r1.proposal).toMatchObject({ status: "accepted", appliedAt: NOW + 1000 });
    expect((await slotRow(slotId))!.exercise_id).toBe(toId);
    const r2 = await repo.applyProposal(A, id, NOW + 2000, TODAY);
    expect(r2.outcome).toBe("already");
    expect((await proposalRow(id))).toMatchObject({ status: "accepted", applied_at: NOW + 1000 });

    const sets = await makeSets(1);
    expect((await repo.applyProposal(A, sets.id, NOW + 1000, TODAY)).outcome).toBe("applied");
    expect(await slotRow(sets.slotId)).toMatchObject({ sets: 4, rep_min: 6, rep_max: 8 });

    const t = await makeTarget();
    expect((await repo.applyProposal(A, t, NOW + 1000, "2023-11-15")).outcome).toBe("applied");
    expect((await repo.applyProposal(A, t, NOW + 1000, "2023-11-15")).outcome).toBe("already");
    const rows = (await env.DB.prepare("SELECT valid_from, kcal, protein_g, fat_g, carbs_g, reason, source_date FROM nutrition_targets WHERE user_id = ? ORDER BY valid_from").bind(A).all()).results;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ valid_from: "2023-11-15", kcal: 2300, protein_g: 144, fat_g: 64, carbs_g: 287, reason: "manual", source_date: null });
    // Інваріант: accepted ⇒ applied_at.
    const bad = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_proposals WHERE status = 'accepted' AND applied_at IS NULL").first<{ n: number }>();
    expect(bad!.n).toBe(0);
  });

  it("паралельні натискання: рівно одне applied (гонка — на SQL-страж, не на читання)", async () => {
    const { id, slotId, toId } = await makeSwap();
    const res = await Promise.all([repo.applyProposal(A, id, NOW + 1000, TODAY), repo.applyProposal(A, id, NOW + 1000, TODAY), repo.applyProposal(A, id, NOW + 1000, TODAY)]);
    expect(res.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect(res.filter((r) => r.outcome === "already")).toHaveLength(2);
    expect((await slotRow(slotId))!.exercise_id).toBe(toId);
    const t = await makeTarget();
    const rt = await Promise.all([repo.applyProposal(A, t, NOW + 1000, "2023-11-15"), repo.applyProposal(A, t, NOW + 1000, "2023-11-15")]);
    expect(rt.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nutrition_targets WHERE user_id = ?").bind(A).first<{ n: number }>())!.n).toBe(2);
  });

  it("чужий userId не застосовує й не гасить; rejected не застосовується; reject лише pending", async () => {
    const { id, slotId, fromId } = await makeSwap();
    expect((await repo.applyProposal(B, id, NOW + 1000, TODAY)).outcome).toBe("missing");
    expect((await slotRow(slotId))!.exercise_id).toBe(fromId);
    expect((await proposalRow(id))!.status).toBe("pending");
    expect(await repo.rejectProposal(B, id, NOW)).toBe(false);
    expect(await repo.getProposal(B, id)).toBeNull();

    expect(await repo.rejectProposal(A, id, NOW + 500)).toBe(true);
    expect(await repo.rejectProposal(A, id, NOW + 600)).toBe(false);
    expect((await repo.applyProposal(A, id, NOW + 1000, TODAY)).outcome).toBe("rejected");
    expect((await slotRow(slotId))!.exercise_id).toBe(fromId);
  });

  it("прострочена: expired, зміни немає; ледаче прострочення працює без крону", async () => {
    const { id, slotId, fromId } = await makeSwap();
    const r = await repo.applyProposal(A, id, NOW + PROPOSAL_TTL_MS, TODAY); // рівно expires_at
    expect(r.outcome).toBe("expired");
    expect((await proposalRow(id))!.status).toBe("expired");
    expect((await slotRow(slotId))!.exercise_id).toBe(fromId);
    expect((await repo.applyProposal(A, id, NOW + 1000, TODAY)).outcome).toBe("expired"); // уже expired
  });

  it("слот чи норму змінено після пропозиції — stale/duplicate, expired, зміни немає", async () => {
    const sw = await makeSwap();
    await env.DB.prepare("UPDATE program_exercises SET sets = sets + 1 WHERE id = ?").bind(sw.slotId).run(); // слот змінився — але вправа та сама: swap лишається чинним
    expect((await repo.applyProposal(A, sw.id, NOW + 1000, TODAY)).outcome).toBe("applied");

    const sets = await makeSets(1);
    await env.DB.prepare("UPDATE program_exercises SET rep_max = rep_max + 1 WHERE id = ?").bind(sets.slotId).run();
    const before = await slotRow(sets.slotId);
    expect((await repo.applyProposal(A, sets.id, NOW + 1000, TODAY)).outcome).toBe("stale");
    expect(await slotRow(sets.slotId)).toEqual(before);
    expect((await proposalRow(sets.id))!.status).toBe("expired");

    const t = await makeTarget();
    await repo.insertTarget(A, target("2023-11-10", 2400, 144, 64, 300, "trend"), NOW); // нова норма після пропозиції
    expect((await repo.applyProposal(A, t, NOW + 1000, TODAY)).outcome).toBe("stale");
    expect((await proposalRow(t))!.status).toBe("expired");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nutrition_targets WHERE reason = 'manual'").first<{ n: number }>())!.n).toBe(0);
  });

  it("у дні слота з'явилась та сама вправа — duplicate, expired, batch не падає", async () => {
    const { id, slotId, fromId, toId } = await makeSwap();
    await env.DB.prepare("UPDATE program_exercises SET exercise_id = ? WHERE id = ?").bind(toId, dayA.slots[1]!.id).run();
    const r = await repo.applyProposal(A, id, NOW + 1000, TODAY);
    expect(r.outcome).toBe("duplicate");
    expect((await proposalRow(id))!.status).toBe("expired");
    expect((await slotRow(slotId))!.exercise_id).toBe(fromId);
  });

  it("активне тренування — busy, pending лишається; після завершення застосовується (swap і sets)", async () => {
    const sw = await makeSwap();
    const sets = await makeSets(1);
    const w = await repo.startWorkout(A, dayB.id, NOW);
    expect((await repo.applyProposal(A, sw.id, NOW + 1000, TODAY)).outcome).toBe("busy");
    expect((await repo.applyProposal(A, sets.id, NOW + 1000, TODAY)).outcome).toBe("busy");
    expect((await proposalRow(sw.id))!.status).toBe("pending");
    expect((await slotRow(sw.slotId))!.exercise_id).toBe(sw.fromId);
    await repo.finishWorkout(A, w!.workout.id, 3, NOW + 2000);
    expect((await repo.applyProposal(A, sw.id, NOW + 3000, TODAY)).outcome).toBe("applied");
    expect((await repo.applyProposal(A, sets.id, NOW + 3000, TODAY)).outcome).toBe("applied");
  });

  it("норма вже створена сьогодні — target_today, pending; наступного дня застосовується (adjust_target)", async () => {
    await env.DB.prepare("DELETE FROM nutrition_targets WHERE user_id = ?").bind(A).run();
    await repo.insertTarget(A, target(TODAY), NOW); // формула створена сьогодні — це і база
    const t = await makeTarget();
    const r = await repo.applyProposal(A, t, NOW + 1000, TODAY);
    expect(r.outcome).toBe("target_today");
    expect((await proposalRow(t))!.status).toBe("pending");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nutrition_targets WHERE user_id = ?").bind(A).first<{ n: number }>())!.n).toBe(1);
    expect((await repo.applyProposal(A, t, NOW + 1000, "2023-11-16")).outcome).toBe("applied");
    expect((await env.DB.prepare("SELECT valid_from, reason FROM nutrition_targets WHERE user_id = ? ORDER BY valid_from DESC LIMIT 1").bind(A).first())).toEqual({ valid_from: "2023-11-16", reason: "manual" });
  });

  it("expireProposals (крон): pending з expires_at ≤ now → expired; applyProposal їх не застосовує", async () => {
    const { id, slotId, fromId } = await makeSwap();
    expect(await repo.expireProposals(NOW + PROPOSAL_TTL_MS - 1)).toBe(0);
    expect(await repo.expireProposals(NOW + PROPOSAL_TTL_MS)).toBe(1);
    expect((await repo.applyProposal(A, id, NOW + PROPOSAL_TTL_MS, TODAY)).outcome).toBe("expired");
    expect((await slotRow(slotId))!.exercise_id).toBe(fromId);
  });

  it("expireOwnProposals гасить лише власні pending зі списку", async () => {
    const { id } = await makeSwap();
    expect(await repo.expireOwnProposals(B, [id], NOW)).toBe(0);
    expect(await repo.expireOwnProposals(A, [], NOW)).toBe(0);
    expect(await repo.expireOwnProposals(A, [id, 99999], NOW)).toBe(1);
    expect((await proposalRow(id))!.status).toBe("expired");
  });

  it("програму змінено (стара неактивна): нова пропозиція на її слот — помилка, створена раніше — stale, зміни немає (В1)", async () => {
    const sw = await makeSwap();
    const sets = await makeSets(1);
    await env.DB.prepare("UPDATE programs SET active = 0 WHERE user_id = ?").bind(A).run(); // активним став би інший план
    const r = await call("propose_change", { kind: "change_sets_reps", program_exercise_id: dayA.slots[2]!.id, sets: 4, rep_min: 8, rep_max: 12, reason: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("активній програмі");
    const before = [await slotRow(sw.slotId), await slotRow(sets.slotId)];
    expect((await repo.applyProposal(A, sw.id, NOW + 1000, TODAY)).outcome).toBe("stale");
    expect((await repo.applyProposal(A, sets.id, NOW + 1000, TODAY)).outcome).toBe("stale");
    expect([await slotRow(sw.slotId), await slotRow(sets.slotId)]).toEqual(before);
    expect((await proposalRow(sw.id))!.status).toBe("expired");
  });

  it("тренування завершилось між batch і з'ясуванням причини — повтор застосовує, а не гасить дійсну пропозицію (Д1)", async () => {
    const { id, slotId, toId } = await makeSwap();
    const w = await repo.startWorkout(A, dayB.id, NOW);
    let hook = true;
    const raced = new Proxy(env.DB, {
      get(t, p) {
        if (p === "batch")
          return async (...a: Parameters<D1Database["batch"]>) => {
            const res = await t.batch(...a);
            if (hook) {
              hook = false;
              await repo.finishWorkout(A, w!.workout.id, 3, NOW + 500); // тап у ту саму мить, коли тренування закінчилось
            }
            return res;
          };
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const racedRepo = createRepo(createDb(raced));
    const r = await racedRepo.applyProposal(A, id, NOW + 1000, TODAY);
    expect(r.outcome).toBe("applied");
    expect((await slotRow(slotId))!.exercise_id).toBe(toId);
  });
});
