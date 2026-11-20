// Клавіатури й callback_data анкети (docs/spec/phase-1b.md, §1 і §5). Чисті функції без I/O; усі тексти — у texts.ts.
import { InlineKeyboard } from "grammy";
import type { Exercise, ProfileRow, StartWeight } from "../db/repo";
import type { Step } from "../domain/onboarding";
import {
  BTN, ENUMS, EMPTY_DAY_TEXT, LIMIT_OPTS, RESUME_TEXT, enumText, goalNoteText, limitsText, liftText, noteText, numberText, planText, profileText, welcomeText,
  type EnumStep, type PlanTextModel,
} from "./texts";

// --- callback_data: o:<код кроку>:<значення> ---

export const STEP_CODE: Record<Step, string> = {
  welcome: "w", goal: "g", goal_note: "gn", level: "lv", days: "d", minutes: "mi", place: "pc", limits: "l",
  limits_note: "ln", lifts: "lf", sex: "sx", birth: "b", height: "h", weight: "wt", meals: "m", diet: "df",
  sleep: "sl", activity: "a", plan: "pl",
};
/** Службові «кроки», що не є кроками анкети: «продовжити?» після /start і кнопка з /profil. */
export const RESUME_CODE = "rs";
export const PROFILE_CODE = "pf";

const CODE_STEP = new Map<string, Step>(Object.entries(STEP_CODE).map(([s, c]) => [c, s as Step]));

export function ob(code: string, value: string): string {
  const data = `o:${code}:${value}`;
  if (new TextEncoder().encode(data).byteLength > 64) throw new RangeError("callback_data exceeds 64 bytes");
  return data;
}
export const obStep = (step: Step, value: string): string => ob(STEP_CODE[step], value);

export type ObCallback = { code: string; step: Step | null; value: string };

/** Розбір `o:<код>:<значення>`; чуже, биті чи невідомі коди — null. */
export function parseOb(data: string): ObCallback | null {
  const m = /^o:([a-z]{1,2}):([a-z0-9_]{1,16})$/.exec(data);
  if (!m) return null;
  const code = m[1]!;
  const step = CODE_STEP.get(code) ?? null;
  if (!step && code !== RESUME_CODE && code !== PROFILE_CODE) return null;
  return { code, step, value: m[2]! };
}

// --- Питання з варіантами ---

export { ENUMS, LIMIT_LABELS, LIMIT_OPTS, MSG, badLift, planAcceptedText } from "./texts";
export type { EnumStep } from "./texts";
export type PlanView = PlanTextModel;

export const isEnumStep = (s: Step): s is EnumStep => Object.hasOwn(ENUMS, s);

export interface Screen {
  text: string;
  keyboard?: InlineKeyboard;
}

/** Рядок навігації: ⬅️ Назад (лише якщо дозволено) і ⏭ Пропустити. */
function nav(step: Step, o: { back?: boolean; skip?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (o.back) kb.text(BTN.back, obStep(step, "b"));
  if (o.skip) kb.text(BTN.skip, obStep(step, "s"));
  return kb;
}

/** Telegram не любить порожні рядки клавіатури: прибираємо їх (grammY лишає порожній рядок після зайвого row()). */
function tidy(kb: InlineKeyboard): InlineKeyboard {
  const rows = kb.inline_keyboard.filter((r) => r.length > 0);
  kb.inline_keyboard.splice(0, kb.inline_keyboard.length, ...rows);
  return kb;
}

function withNav(kb: InlineKeyboard, step: Step, o: { back?: boolean; skip?: boolean }): InlineKeyboard {
  if (o.back || o.skip) {
    kb.row();
    if (o.back) kb.text(BTN.back, obStep(step, "b"));
    if (o.skip) kb.text(BTN.skip, obStep(step, "s"));
  }
  return tidy(kb);
}

export function welcomeScreen(intro = ""): Screen {
  return { text: welcomeText(intro), keyboard: new InlineKeyboard().text(BTN.start, obStep("welcome", "go")) };
}

/** Питання з кнопками-варіантами; поточна відповідь профілю позначена ✅. */
export function enumScreen(step: EnumStep, profile: ProfileRow | null, o: { hint?: string; back: boolean; skip: boolean }): Screen {
  const q = ENUMS[step];
  const current = profile ? profile[q.field] : null;
  const kb = new InlineKeyboard();
  q.opts.forEach((opt, i) => {
    const label = current === opt.stored ? `✅ ${opt.text}` : opt.emoji ? `${opt.emoji} ${opt.text}` : opt.text;
    kb.text(label, obStep(step, opt.value));
    if ((i + 1) % q.cols === 0) kb.row();
  });
  withNav(kb, step, o);
  return { text: enumText(step, o.hint), keyboard: kb };
}

export function goalNoteScreen(profile: ProfileRow | null): Screen {
  const other = profile?.goal === "other";
  const kb = new InlineKeyboard();
  if (!other || profile?.goalNote) kb.text(BTN.next, obStep("goal_note", "n"));
  return { text: goalNoteText(other, profile?.goalNote), keyboard: withNav(kb, "goal_note", { back: true }) };
}

export function limitsScreen(profile: ProfileRow | null, back: boolean): Screen {
  const on = new Set((profile?.limits ?? "").split(",").filter(Boolean));
  const kb = new InlineKeyboard();
  LIMIT_OPTS.forEach((o, i) => {
    const active = on.has(o.flag);
    kb.text(active ? `✅ ${o.label}` : `${o.emoji} ${o.label}`, obStep("limits", `${o.code}${active ? 0 : 1}`));
    if (i % 2 === 1) kb.row();
  });
  kb.row().text(BTN.done, obStep("limits", "ok"));
  withNav(kb, "limits", { back, skip: true });
  return { text: limitsText(), keyboard: kb };
}

export function noteScreen(step: "limits_note" | "diet", current: string | null): Screen {
  const isDiet = step === "diet";
  const kb = new InlineKeyboard();
  if (!isDiet) kb.text(BTN.next, obStep(step, "n"));
  return { text: noteText(isDiet, current), keyboard: withNav(kb, step, { back: true, skip: isDiet }) };
}

export function numberScreen(step: "birth" | "height" | "weight", profile: ProfileRow | null): Screen {
  const cur = { birth: profile?.birthYear, height: profile?.heightCm, weight: profile?.weightKg }[step];
  return { text: numberText(step, cur), keyboard: nav(step, { back: true, skip: true }) };
}

export function liftScreen(ex: Exercise, sub: number, total: number, current: StartWeight | null, prompt: boolean): Screen {
  const kb = new InlineKeyboard().text(BTN.unknown, obStep("lifts", `n${sub}`));
  if (!prompt) kb.text(BTN.enter, obStep("lifts", `i${sub}`));
  return { text: liftText(ex, sub, total, current, prompt), keyboard: withNav(kb, "lifts", { back: true, skip: true }) };
}

// --- План ---

export function planScreen(v: PlanView): Screen {
  const kb = new InlineKeyboard()
    .text(BTN.accept, obStep("plan", `ok${v.variant}`))
    .row()
    .text(BTN.otherVariant, obStep("plan", "alt"))
    .text(BTN.changeDays, obStep("plan", "days"));
  return { text: planText(v), keyboard: kb };
}

export function emptyDayScreen(): Screen {
  return {
    text: EMPTY_DAY_TEXT,
    keyboard: new InlineKeyboard()
      .text(BTN.changeLimits, obStep("plan", "lim"))
      .row()
      .text(BTN.changeDuration, obStep("plan", "dur"))
      .row()
      .text(BTN.restart, obStep("plan", "new")),
  };
}

// --- Продовження, профіль ---

export function resumeScreen(): Screen {
  return {
    text: RESUME_TEXT,
    keyboard: new InlineKeyboard().text(BTN.resume, ob(RESUME_CODE, "go")).text(BTN.restart, ob(RESUME_CODE, "new")),
  };
}

export const NEW_PLAN_BUTTON = BTN.newPlan;
export const newPlanKeyboard = (): InlineKeyboard => new InlineKeyboard().text(NEW_PLAN_BUTTON, ob(PROFILE_CODE, "new"));

export function profileScreen(
  profile: ProfileRow | null,
  activePlanName: string | null,
  weights: { name: string; weight: StartWeight }[],
  canResume: boolean,
): Screen {
  const kb = new InlineKeyboard();
  if (canResume) kb.text(BTN.resumeSurvey, ob(RESUME_CODE, "go")).row();
  kb.text(profile?.goal ? BTN.again : BTN.survey, ob(PROFILE_CODE, "new"));
  return { text: profileText(profile, activePlanName, weights), keyboard: kb };
}
