// Пропозиції ШІ (docs/spec/phase-4.md, розділи 2–3): валідація входу `propose_change`, нормалізація payload, підсумок для картки й
// застосування. Payload будує КОД (поля `from_*` і база для перевірки застарілості беруться з БД, а не від моделі); модель дає лише
// вид, ідентифікатори й `reason`. Доступ до даних — лише через `repo` з `userId`; SQL застосування живе в `repo.applyProposal`.
import { TREND_MAX_DEVIATION_KCAL, TREND_MIN_KCAL } from "../config";
import type { ApplyOutcome, NewProposal, ProposalView, Repo } from "../db/repo";
import { PROPOSAL_KINDS, type ProposalKind } from "../db/schema";

export const REASON_MAX = 200;

/** Допустимі поля входу `propose_change` за видом; усе інше — помилка (`additionalProperties: false`). */
const FIELDS: Record<ProposalKind, readonly string[]> = {
  swap_exercise: ["program_exercise_id", "to_exercise_id"],
  change_sets_reps: ["program_exercise_id", "sets", "rep_min", "rep_max"],
  adjust_target: ["kcal"],
};

export type BuildResult = { ok: true; proposal: NewProposal; summary: string } | { ok: false; error: string };
const fail = (error: string): BuildResult => ({ ok: false, error });

function int(input: Record<string, unknown>, key: string, min: number, max: number): number | string {
  const v = input[key];
  if (typeof v !== "number" || !Number.isInteger(v)) return `поле ${key}: потрібне ціле число`;
  if (v < min || v > max) return `поле ${key}: поза межами ${min}–${max}`;
  return v;
}

/** Валідація й побудова пропозиції. `today` — локальна дата користувача (для чинної норми). */
export async function buildProposal(repo: Repo, userId: number, today: string, input: unknown): Promise<BuildResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("вхід має бути об'єктом");
  const inp = input as Record<string, unknown>;
  const kind = inp.kind;
  if (typeof kind !== "string" || !(PROPOSAL_KINDS as readonly string[]).includes(kind)) return fail(`kind: один із ${PROPOSAL_KINDS.join(", ")}`);
  const k = kind as ProposalKind;
  const extra = Object.keys(inp).filter((x) => x !== "kind" && x !== "reason" && !FIELDS[k].includes(x));
  if (extra.length > 0) return fail(`зайві поля для ${k}: ${extra.join(", ")}`);
  const reasonRaw = inp.reason;
  if (typeof reasonRaw !== "string") return fail("reason: потрібен короткий текст");
  const reason = reasonRaw.trim();
  const reasonLen = Array.from(reason).length;
  if (reasonLen < 1 || reasonLen > REASON_MAX) return fail(`reason: 1–${REASON_MAX} символів`);
  for (const f of FIELDS[k]) if (!(f in inp)) return fail(`немає поля ${f}`);

  if (k === "adjust_target") {
    const kcal = int(inp, "kcal", 1, 100000);
    if (typeof kcal === "string") return fail(kcal);
    const cur = await repo.getTargetOn(userId, today);
    const formula = await repo.getFormulaTarget(userId);
    if (!cur || !formula) return fail("норми ще немає: спершу має з'явитися денна норма (/yizha)");
    if (kcal < TREND_MIN_KCAL) return fail(`kcal не нижче ${TREND_MIN_KCAL}`);
    if (Math.abs(kcal - formula.kcal) > TREND_MAX_DEVIATION_KCAL) return fail(`kcal не далі ±${TREND_MAX_DEVIATION_KCAL} від норми за формулою (${formula.kcal})`);
    if (kcal === cur.kcal) return fail("kcal збігається з чинною нормою");
    const carbsRaw = (kcal - 4 * cur.proteinG - 9 * cur.fatG) / 4;
    if (carbsRaw < 0) return fail("за білка й жиру чинної норми вуглеводи вийшли б від'ємними");
    const payload = { kcal, protein_g: cur.proteinG, fat_g: cur.fatG, carbs_g: Math.round(carbsRaw), base_valid_from: cur.validFrom, from_kcal: cur.kcal };
    return done(k, "target", payload, reason);
  }

  const peId = int(inp, "program_exercise_id", 1, 2_000_000_000);
  if (typeof peId === "string") return fail(peId);
  const slot = await repo.getOwnSlot(userId, peId);
  if (!slot) return fail("слот не знайдено в активній програмі");
  const day = slot.dayTitle ?? slot.dayCode;

  if (k === "swap_exercise") {
    const to = int(inp, "to_exercise_id", 1, 2_000_000_000);
    if (typeof to === "string") return fail(to);
    if (to === slot.exerciseId) return fail("це вже вправа слота");
    const to_ = (await repo.getSubstitutes(slot.exerciseId)).find((e) => e.id === to);
    if (!to_) return fail("ця вправа не входить до замін поточної (див. substitutes у get_program)");
    if (await repo.dayHasExercise(slot.programDayId, to)) return fail("така вправа вже є в цьому дні");
    const payload = { program_exercise_id: peId, to_exercise_id: to, from_exercise_id: slot.exerciseId, program_day_id: slot.programDayId, from_name: slot.exerciseName, to_name: to_.nameUk, day };
    return done(k, `pe:${peId}`, payload, reason);
  }

  const sets = int(inp, "sets", 2, 5);
  const repMin = int(inp, "rep_min", 4, 12);
  const repMax = int(inp, "rep_max", 6, 15);
  for (const v of [sets, repMin, repMax]) if (typeof v === "string") return fail(v);
  const [s, lo, hi] = [sets, repMin, repMax] as number[];
  if (hi! - lo! < 2 || hi! - lo! > 6) return fail("rep_max − rep_min має бути 2–6");
  if (s === slot.sets && lo === slot.repMin && hi === slot.repMax) return fail("значення збігаються з поточними");
  const payload = { program_exercise_id: peId, sets: s, rep_min: lo, rep_max: hi, from_sets: slot.sets, from_rep_min: slot.repMin, from_rep_max: slot.repMax, name: slot.exerciseName };
  return done(k, `pe:${peId}`, payload, reason);
}

function done(kind: ProposalKind, subjectKey: string, payload: Record<string, unknown>, reason: string): BuildResult {
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 1024) return fail("payload завеликий");
  return { ok: true, proposal: { kind, subjectKey, payloadJson, reason }, summary: proposalSummary(kind, payload) };
}

/** Підсумок для картки й відповіді інструмента — з payload, без запитів до БД (звичайний текст; `esc()` — при показі). */
export function proposalSummary(kind: ProposalKind, p: Record<string, unknown>): string {
  if (kind === "swap_exercise") return `Замінити «${p.from_name}» на «${p.to_name}» у дні «${p.day}»`;
  if (kind === "change_sets_reps") return `«${p.name}»: ${p.from_sets} × ${p.from_rep_min}–${p.from_rep_max} → ${p.sets} × ${p.rep_min}–${p.rep_max}`;
  return `Норма ${p.from_kcal} → ${p.kcal} ккал (Б ${p.protein_g} · Ж ${p.fat_g} · В ${p.carbs_g})`;
}

/** Застосувати пропозицію після кнопки: лише `pending`, не прострочена, власна; решта — за `ApplyOutcome` (розділ 3 спеки). */
export function applyProposal(repo: Repo, userId: number, id: number, now: number, today: string): Promise<{ outcome: ApplyOutcome; proposal: ProposalView | null }> {
  return repo.applyProposal(userId, id, now, today);
}

/** `[Ні]`: `pending → rejected`; інакше false без змін. */
export function rejectProposal(repo: Repo, userId: number, id: number, now: number): Promise<boolean> {
  return repo.rejectProposal(userId, id, now);
}
