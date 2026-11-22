// Реєстр інструментів ШІ-тренера (docs/spec/phase-4.md, розділ 2): п'ять читальних + `propose_change`.
// Інваріанти: `userId` лише з контексту обробника (у схемах інструментів його немає, зайві поля — помилка); читальні інструменти
// не змінюють жодної таблиці; єдиний «пишучий» — `propose_change`, він лише вставляє `ai_proposals.pending`. Доступ до даних — лише repo.
import { TOOL_RESULT_MAX_CHARS } from "../config";
import type { Repo, Slot } from "../db/repo";
import { nextDayCode } from "../domain/progression";
import { addDays, localDate, localParts } from "../domain/time";
import { avg7, weekChange } from "../domain/weight";
import { prescribeSlot } from "../bot/prescribe";
import { buildProposal, proposalSummary } from "./proposals";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

export interface ToolContext {
  repo: Repo;
  userId: number;
  tz: string;
  /** UTC мс «зараз». */
  now: number;
}

/** Результат інструмента: `content` іде в `tool_result`; `proposal` — для обробника чату (картка з кнопками). */
export interface ToolResult {
  content: string;
  isError: boolean;
  proposal?: { id: number; created: boolean; messageId: number | null };
}

const intProp = (description: string) => ({ type: "integer", description });

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "get_recent_workouts",
    description: "Останні завершені тренування користувача: дата, день програми, оцінка тяжкості 1–5, вправи з підходами (вага w кг × повтори r).",
    input_schema: { type: "object", properties: { n: intProp("Скільки тренувань, 1–8 (типово 3)") }, additionalProperties: false },
  },
  {
    name: "get_exercise_history",
    description:
      "Історія вправи користувача (останні сесії) і наступне призначення від рушія прогресії (next_prescription) для слота програми. Вагу на наступне заняття називай лише звідси.",
    input_schema: {
      type: "object",
      properties: {
        exercise_id: intProp("id вправи (з get_program)"),
        n: intProp("Скільки сесій, 1–10 (типово 5)"),
        program_exercise_id: intProp("id слота програми; без нього — перший слот цієї вправи за порядком днів"),
      },
      required: ["exercise_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_weight_trend",
    description: "Вага тіла: записи за період, середні за 7 днів (w0 — цей тиждень, w1, w2 — попередні) і зміна до минулого тижня, кг.",
    input_schema: { type: "object", properties: { days: intProp("Період у днях, 7–90 (типово 28)") }, additionalProperties: false },
  },
  {
    name: "get_program",
    description: "Активна програма: дні, вправи зі слотами (program_exercise_id, exercise_id, підходи × повтори) і доступні заміни (substitutes), наступний день.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_today_food",
    description: "Харчування за сьогодні: денна норма, з'їдене (лише підтверджені прийоми), прийоми з позиціями, кількість непідтверджених.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_change",
    description:
      "Запропонувати зміну, яку користувач підтвердить кнопкою. Нічого не застосовує. kind: swap_exercise (program_exercise_id, to_exercise_id з substitutes), change_sets_reps (program_exercise_id, sets 2–5, rep_min 4–12, rep_max 6–15, різниця 2–6), adjust_target (kcal, не далі ±300 від норми за формулою, не нижче 1200). reason — коротке пояснення до 200 символів.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["swap_exercise", "change_sets_reps", "adjust_target"] },
        reason: { type: "string", description: "Чому (1–200 символів)" },
        program_exercise_id: intProp("id слота програми"),
        to_exercise_id: intProp("id вправи-заміни (swap_exercise)"),
        sets: intProp("Підходи (change_sets_reps)"),
        rep_min: intProp("Мінімум повторів (change_sets_reps)"),
        rep_max: intProp("Максимум повторів (change_sets_reps)"),
        kcal: intProp("Нова денна норма, ккал (adjust_target)"),
      },
      required: ["kind", "reason"],
      additionalProperties: false,
    },
  },
] as const;

export const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name);

const ok = (value: Record<string, unknown>, listKey: string | null = null): ToolResult => ({ content: fitJson(value, listKey), isError: false });
const err = (message: string): ToolResult => ({ content: JSON.stringify({ error: message }), isError: true });

/** JSON ≤ `TOOL_RESULT_MAX_CHARS`: переповнення — відкидаємо хвостові елементи списку `listKey` і ставимо `truncated` (посередині не ріжемо). */
export function fitJson(value: Record<string, unknown>, listKey: string | null, max = TOOL_RESULT_MAX_CHARS): string {
  const whole = JSON.stringify(value);
  if (whole.length <= max) return whole;
  const list = listKey ? value[listKey] : null;
  if (listKey && Array.isArray(list)) {
    const rest = [...list];
    while (rest.length > 0) {
      rest.pop();
      const s = JSON.stringify({ ...value, [listKey]: rest, truncated: true });
      if (s.length <= max) return s;
    }
  }
  return JSON.stringify({ truncated: true });
}

/** Вхід — об'єкт із дозволеними полями; невідоме поле (зокрема `user_id`) — помилка. */
function args(input: unknown, allowed: readonly string[]): Record<string, unknown> | string {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return "вхід має бути об'єктом";
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `невідомі поля: ${extra.join(", ")}` : (input as Record<string, unknown>);
}

function optInt(o: Record<string, unknown>, key: string, def: number, min: number, max: number): number | string {
  if (o[key] === undefined) return def;
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return `${key}: ціле ${min}–${max}`;
  return v;
}

const kg = (x: number): number => Math.round(x * 10) / 10;
const dgToKg = (dg: number | null): number | null => (dg === null ? null : dg / 10);

async function recentWorkouts(c: ToolContext, input: unknown): Promise<ToolResult> {
  const a = args(input, ["n"]);
  if (typeof a === "string") return err(a);
  const n = optInt(a, "n", 3, 1, 8);
  if (typeof n === "string") return err(n);
  const rows = await c.repo.getRecentWorkouts(c.userId, n);
  const workouts = rows.map((w) => ({
    date: localDate(w.startedAt, c.tz),
    day: w.dayTitle ?? w.dayCode,
    status: w.status,
    effort: w.effort,
    exercises: w.exercises.map((e) => ({ name: e.nameUk, sets: e.sets.map((s) => (s.skipped ? { skipped: true } : { w: s.weightKg === null ? null : kg(s.weightKg), r: s.reps })) })),
  }));
  return ok({ workouts }, "workouts");
}

/** Слоти активної програми за порядком днів і позицій. */
async function programSlots(c: ToolContext): Promise<{ day: { code: string; title: string | null }; slot: Slot }[]> {
  const program = await c.repo.getActiveProgram(c.userId);
  if (!program) return [];
  const out: { day: { code: string; title: string | null }; slot: Slot }[] = [];
  for (const d of program.days) {
    const day = await c.repo.getProgramDay(c.userId, d.code);
    for (const slot of day?.slots ?? []) out.push({ day: { code: d.code, title: d.title }, slot });
  }
  return out;
}

async function exerciseHistory(c: ToolContext, input: unknown): Promise<ToolResult> {
  const a = args(input, ["exercise_id", "n", "program_exercise_id"]);
  if (typeof a === "string") return err(a);
  const exerciseId = a.exercise_id;
  if (typeof exerciseId !== "number" || !Number.isInteger(exerciseId) || exerciseId < 1) return err("exercise_id: потрібне ціле ≥ 1");
  const n = optInt(a, "n", 5, 1, 10);
  if (typeof n === "string") return err(n);
  const peId = a.program_exercise_id;
  if (peId !== undefined && (typeof peId !== "number" || !Number.isInteger(peId) || peId < 1)) return err("program_exercise_id: ціле ≥ 1");
  const exercise = await c.repo.getExercise(exerciseId);
  if (!exercise) return err("вправу не знайдено");

  const slots = await programSlots(c);
  let found = peId === undefined ? slots.find((s) => s.slot.exercise.id === exerciseId) : slots.find((s) => s.slot.id === peId);
  if (found && found.slot.exercise.id !== exerciseId) found = undefined;
  if (peId !== undefined && !found) return err("слот не знайдено в активній програмі для цієї вправи");

  const sessions = (await c.repo.getExerciseHistory(c.userId, exerciseId, n)).map((s) => ({
    date: localDate(s.startedAt, c.tz),
    planned_sets: s.plannedSets,
    sets: s.sets.map((x) => (x.skipped ? { skipped: true } : { w: x.weightKg === null ? null : kg(x.weightKg), r: x.reps })),
    effort: s.effort,
  }));
  let slot: { program_exercise_id: number; day: string } | null = null;
  let next: { weight_kg: number; reps: number; reason: string } | null = null;
  if (found) {
    slot = { program_exercise_id: found.slot.id, day: found.day.title ?? found.day.code };
    const p = await prescribeSlot(c.repo, c.userId, found.slot.exercise, found.slot);
    next = { weight_kg: p.weightKg, reps: p.targetReps, reason: p.reason };
  }
  return ok({ name: exercise.nameUk, sessions, slot, next_prescription: next }, "sessions");
}

async function weightTrend(c: ToolContext, input: unknown): Promise<ToolResult> {
  const a = args(input, ["days"]);
  if (typeof a === "string") return err(a);
  const days = optInt(a, "days", 28, 7, 90);
  if (typeof days === "string") return err(days);
  const today = localDate(c.now, c.tz);
  const entries = await c.repo.getWeights(c.userId, addDays(today, -(Math.max(days, 21) - 1)), today);
  const from = addDays(today, -(days - 1));
  const inPeriod = entries.filter((e) => e.localDate >= from);
  const w = (end: string): number | null => dgToKg(avg7(entries, end).avgDg);
  return ok(
    {
      entries: inPeriod.slice(-30).map((e) => ({ date: e.localDate, kg: e.weightDg / 10 })),
      avg7: { w0: w(today), w1: w(addDays(today, -7)), w2: w(addDays(today, -14)) },
      change_kg: dgToKg(weekChange(entries, today)),
      n: inPeriod.length,
    },
    "entries",
  );
}

async function program(c: ToolContext): Promise<ToolResult> {
  const prog = await c.repo.getActiveProgram(c.userId);
  if (!prog) return ok({ program: null });
  const days = [];
  for (const d of prog.days) {
    const day = await c.repo.getProgramDay(c.userId, d.code);
    const exercises = [];
    for (const slot of day?.slots ?? []) {
      const subs = await c.repo.getSubstitutes(slot.exercise.id);
      exercises.push({
        program_exercise_id: slot.id,
        exercise_id: slot.exercise.id,
        name: slot.exercise.nameUk,
        sets: slot.sets,
        rep_min: slot.repMin,
        rep_max: slot.repMax,
        substitutes: subs.map((e) => ({ exercise_id: e.id, name: e.nameUk })),
      });
    }
    days.push({ code: d.code, title: d.title, exercises });
  }
  const nextCode = prog.days.length > 0 ? nextDayCode(await c.repo.getLastDoneWorkout(c.userId), prog.days) : null;
  const next = prog.days.find((d) => d.code === nextCode);
  return ok({ name: prog.name, next_day: next ? { code: next.code, title: next.title } : null, days }, "days");
}

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

async function todayFood(c: ToolContext): Promise<ToolResult> {
  const today = localDate(c.now, c.tz);
  const [target, totals, meals, pending] = await Promise.all([
    c.repo.getTargetOn(c.userId, today),
    c.repo.dayTotals(c.userId, today),
    c.repo.dayMeals(c.userId, today),
    c.repo.countPendingMeals(c.userId, today),
  ]);
  return ok(
    {
      date: today,
      target: target ? { kcal: target.kcal, protein_g: target.proteinG, fat_g: target.fatG, carbs_g: target.carbsG, valid_from: target.validFrom } : null,
      eaten: { kcal: totals.kcal, protein_g: totals.proteinDg / 10, fat_g: totals.fatDg / 10, carbs_g: totals.carbsDg / 10 },
      meals: meals.map((m) => ({ time: hhmm(localParts(m.eatenAt, c.tz).minutes), items: m.items.map((i) => ({ name: i.nameUk, g: i.grams, kcal: i.kcal })) })),
      pending,
    },
    "meals",
  );
}

async function proposeChange(c: ToolContext, input: unknown): Promise<ToolResult> {
  const built = await buildProposal(c.repo, c.userId, localDate(c.now, c.tz), input);
  if (!built.ok) return err(built.error);
  const res = await c.repo.createProposal(c.userId, built.proposal, c.now);
  if (!res) return err("користувача не знайдено");
  if (res.result === "limit") return err("забагато відкритих пропозицій: дочекайся рішення за попередніми");
  const created = res.result === "created";
  // Для наявної відкритої пропозиції — її власний підсумок (вона може відрізнятись від щойно запитаної).
  const summary = proposalSummary(res.proposal.kind, res.proposal.payload);
  return {
    content: JSON.stringify({ proposal_id: res.proposal.id, status: created ? "pending_user_confirmation" : "already_pending", summary }),
    isError: false,
    proposal: { id: res.proposal.id, created, messageId: res.proposal.messageId },
  };
}

/** Виконати інструмент за ім'ям. Помилки входу й невідомий інструмент — `is_error`, не виняток (кожен `tool_use` мусить отримати `tool_result`). */
export async function runTool(c: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  switch (name) {
    case "get_recent_workouts":
      return recentWorkouts(c, input);
    case "get_exercise_history":
      return exerciseHistory(c, input);
    case "get_weight_trend":
      return weightTrend(c, input);
    case "get_program": {
      const a = args(input, []);
      return typeof a === "string" ? err(a) : program(c);
    }
    case "get_today_food": {
      const a = args(input, []);
      return typeof a === "string" ? err(a) : todayFood(c);
    }
    case "propose_change":
      return proposeChange(c, input);
    default:
      return err(`невідомий інструмент ${name}`);
  }
}
