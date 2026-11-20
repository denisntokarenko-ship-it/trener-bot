// Тексти, клавіатури й callback_data анкети (docs/spec/phase-1b.md, §1 і §5). Чисті функції без I/O.
// Загальне оформлення (шаблони, гайд) — завдання 1b.4; тут — мінімум, потрібний потоку: HTML і esc() на користувацьких рядках.
import { InlineKeyboard } from "grammy";
import type { Exercise, ProfileRow, StartWeight } from "../db/repo";
import { GOAL_LABELS, type Goal, type Plan } from "../domain/plan";
import type { Step } from "../domain/onboarding";
import { esc } from "./texts";
import { clip, fmtKg } from "./workout-view";

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
  if (new TextEncoder().encode(data).byteLength > 64) throw new RangeError("callback_data довше за 64 байти");
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

export type EnumStep = "goal" | "level" | "days" | "minutes" | "place" | "sex" | "meals" | "sleep" | "activity";
type Field = "goal" | "level" | "daysPerWeek" | "sessionMin" | "place" | "sex" | "mealsPerDay" | "sleepBand" | "activity";

interface Opt {
  value: string;
  stored: string | number;
  text: string;
  emoji?: string;
}
interface EnumQuestion {
  n: number;
  field: Field;
  title: string;
  hint?: string;
  cols: number;
  opts: readonly Opt[];
}

export const ENUMS: Record<EnumStep, EnumQuestion> = {
  goal: {
    n: 1, field: "goal", title: "🎯 Чого хочеш від тренувань?", cols: 2,
    opts: [
      { value: "lose_fat", stored: "lose_fat", text: "Схуднути", emoji: "🔥" },
      { value: "muscle", stored: "muscle", text: "Набрати мʼязи", emoji: "💪" },
      { value: "recomp", stored: "recomp", text: "Рекомпозиція", emoji: "🔄" },
      { value: "strength", stored: "strength", text: "Сила", emoji: "🏋️" },
      { value: "health", stored: "health", text: "Здоровʼя й форма", emoji: "❤️" },
      { value: "other", stored: "other", text: "Інше", emoji: "✍️" },
    ],
  },
  level: {
    n: 2, field: "level", title: "🌱 Який у тебе рівень?", hint: "Скільки ти тренуєшся регулярно.", cols: 1,
    opts: [
      { value: "novice", stored: "novice", text: "Новачок — менше 6 місяців" },
      { value: "mid", stored: "mid", text: "Середній — 6–24 місяці" },
      { value: "adv", stored: "adv", text: "Досвідчений — понад 2 роки" },
    ],
  },
  days: {
    n: 3, field: "daysPerWeek", title: "📅 Скільки днів на тиждень?", cols: 2,
    opts: [
      { value: "2", stored: 2, text: "2 дні" },
      { value: "3", stored: 3, text: "3 дні" },
      { value: "4", stored: 4, text: "4 дні" },
      { value: "5", stored: 5, text: "5 днів" },
    ],
  },
  minutes: {
    n: 4, field: "sessionMin", title: "⏱ Скільки триває заняття?", cols: 2,
    opts: [
      { value: "30", stored: 30, text: "30 хв" },
      { value: "45", stored: 45, text: "45 хв" },
      { value: "60", stored: 60, text: "60 хв" },
      { value: "90", stored: 90, text: "90 хв" },
    ],
  },
  place: {
    n: 5, field: "place", title: "📍 Де займаєшся?", cols: 1,
    opts: [
      { value: "gym", stored: "gym", text: "Зал", emoji: "🏢" },
      { value: "home", stored: "home", text: "Вдома з гантелями", emoji: "🏠" },
    ],
  },
  sex: {
    n: 8, field: "sex", title: "👤 Стать", hint: "Потрібна для норми калорій у наступних версіях.", cols: 2,
    opts: [
      { value: "m", stored: "m", text: "Чоловік", emoji: "👨" },
      { value: "f", stored: "f", text: "Жінка", emoji: "👩" },
    ],
  },
  meals: {
    n: 12, field: "mealsPerDay", title: "🍽 Скільки разів на день їси?", cols: 3,
    opts: [
      { value: "1", stored: 1, text: "1" },
      { value: "2", stored: 2, text: "2" },
      { value: "3", stored: 3, text: "3" },
      { value: "4", stored: 4, text: "4" },
      { value: "5", stored: 5, text: "5+" },
    ],
  },
  sleep: {
    n: 14, field: "sleepBand", title: "😴 Скільки спиш?", cols: 2,
    opts: [
      { value: "lt6", stored: "lt6", text: "до 6 год" },
      { value: "6_7", stored: "6_7", text: "6–7 год" },
      { value: "7_8", stored: "7_8", text: "7–8 год" },
      { value: "8p", stored: "8p", text: "понад 8 год" },
    ],
  },
  activity: {
    n: 15, field: "activity", title: "🚶 Активність поза залом", cols: 1,
    opts: [
      { value: "low", stored: "low", text: "Сидяча робота", emoji: "🪑" },
      { value: "mid", stored: "mid", text: "Помірна", emoji: "🚶" },
      { value: "high", stored: "high", text: "Весь день на ногах", emoji: "🏃" },
    ],
  },
};

export const isEnumStep = (s: Step): s is EnumStep => Object.hasOwn(ENUMS, s);

export const LIMIT_OPTS = [
  { flag: "knee", code: "kn", label: "Коліна", emoji: "🦵" },
  { flag: "back", code: "bk", label: "Спина", emoji: "🔙" },
  { flag: "shoulder", code: "sh", label: "Плечі", emoji: "💪" },
  { flag: "wrist", code: "wr", label: "Зап'ястя", emoji: "✋" },
] as const;
export const LIMIT_LABELS: Record<string, string> = { knee: "коліна", back: "спина", shoulder: "плечі", wrist: "зап'ястя" };

const TOTAL = 15;
const head = (n: number, title: string): string => `<b>${title}</b>\n<i>Питання ${n} з ${TOTAL}</i>`;

export interface Screen {
  text: string;
  keyboard?: InlineKeyboard;
}

/** Рядок навігації: ⬅️ Назад (лише якщо дозволено) і ⏭ Пропустити. */
function nav(step: Step, o: { back?: boolean; skip?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (o.back) kb.text("⬅️ Назад", obStep(step, "b"));
  if (o.skip) kb.text("⏭ Пропустити", obStep(step, "s"));
  return kb;
}

function withNav(kb: InlineKeyboard, step: Step, o: { back?: boolean; skip?: boolean }): InlineKeyboard {
  if (o.back || o.skip) {
    kb.row();
    if (o.back) kb.text("⬅️ Назад", obStep(step, "b"));
    if (o.skip) kb.text("⏭ Пропустити", obStep(step, "s"));
  }
  return kb;
}

export function welcomeScreen(intro = ""): Screen {
  const text =
    (intro ? `${intro}\n\n` : "") +
    "<b>🎯 Налаштуємо тренування під тебе</b>\n" +
    "Кілька питань, ~3 хвилини: ціль, рівень, дні, обмеження. З відповідей я складу план, а ти його підтвердиш.\n" +
    "Відповіді можна змінити будь-коли в /profil.";
  return { text, keyboard: new InlineKeyboard().text("▶️ Почати", obStep("welcome", "go")) };
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
  const lines = [o.hint, head(q.n, q.title), q.hint ? `<i>${q.hint}</i>` : ""].filter(Boolean);
  if (step === "goal") lines.push("Без цілі я не складу план, тому це питання не пропустити.");
  return { text: lines.join("\n"), keyboard: kb };
}

export function goalNoteScreen(profile: ProfileRow | null): Screen {
  const other = profile?.goal === "other";
  const note = profile?.goalNote ? `\nЗараз: <i>${esc(profile.goalNote)}</i>` : "";
  const text =
    (other
      ? "<b>✍️ Опиши свою ціль</b>\nНапиши кількома словами, чого хочеш."
      : "<b>✍️ Хочеш уточнити?</b>\nМожеш описати ціль своїми словами (до 300 символів) або йти далі.") + note;
  const kb = new InlineKeyboard();
  if (!other || profile?.goalNote) kb.text("➡️ Далі", obStep("goal_note", "n"));
  return { text, keyboard: withNav(kb, "goal_note", { back: true }) };
}

export function limitsScreen(profile: ProfileRow | null, back: boolean): Screen {
  const on = new Set((profile?.limits ?? "").split(",").filter(Boolean));
  const kb = new InlineKeyboard();
  LIMIT_OPTS.forEach((o, i) => {
    const active = on.has(o.flag);
    kb.text(active ? `✅ ${o.label}` : `${o.emoji} ${o.label}`, obStep("limits", `${o.code}${active ? 0 : 1}`));
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("✅ Готово", obStep("limits", "ok"));
  withNav(kb, "limits", { back, skip: true });
  return {
    text: `${head(6, "🩹 Є обмеження чи травми?")}\n<i>Познач, що болить або заважає. Я не братиму для тебе вправи, які це навантажують.</i>`,
    keyboard: kb,
  };
}

export function noteScreen(step: "limits_note" | "diet", current: string | null): Screen {
  const isDiet = step === "diet";
  const title = isDiet ? head(13, "🍽 Харчові обмеження, алергії") : "<b>📝 Хочеш додати нотатку?</b>";
  const body = isDiet
    ? "Напиши одним повідомленням (до 300 символів) або пропусти."
    : "Напиши одним повідомленням (до 300 символів), що ще варто знати. Без діагнозів — я лише збережу її.";
  const note = current ? `\nЗараз: <i>${esc(current)}</i>` : "";
  const kb = new InlineKeyboard();
  if (!isDiet) kb.text("➡️ Далі", obStep(step, "n"));
  return { text: `${title}\n${body}${note}`, keyboard: withNav(kb, step, { back: true, skip: isDiet }) };
}

export function numberScreen(step: "birth" | "height" | "weight", profile: ProfileRow | null): Screen {
  const spec = {
    birth: { n: 9, title: "🎂 Рік народження", example: "1995", cur: profile?.birthYear },
    height: { n: 10, title: "📏 Зріст, см", example: "178", cur: profile?.heightCm },
    weight: { n: 11, title: "⚖️ Вага тіла, кг", example: "80,5", cur: profile?.weightKg },
  }[step];
  const cur = spec.cur != null ? `\nЗараз: <b>${fmtKg(spec.cur)}</b> ✅` : "";
  return {
    text: `${head(spec.n, spec.title)}\nНапиши число, наприклад <code>${spec.example}</code>.${cur}`,
    keyboard: nav(step, { back: true, skip: true }),
  };
}

export function liftScreen(ex: Exercise, sub: number, total: number, current: StartWeight | null, prompt: boolean): Screen {
  const cur = current ? `\nЗараз: <b>${fmtKg(current.weightKg)} кг × ${current.reps}</b> ✅` : "";
  const head7 = `<b>⚖️ Робочі ваги</b>\n<i>Питання 7 з ${TOTAL} · вправа ${sub + 1} з ${total}</i>`;
  const text = prompt
    ? `${head7}\n<b>${esc(ex.nameUk)}</b>\nНапиши вагу й повтори: <code>60x8</code> або <code>42,5x10</code>. Крок ваги — ${fmtKg(ex.weightStepKg)} кг.${cur}`
    : `${head7}\nЗнаєш свою вагу у вправі <b>${esc(ex.nameUk)}</b>? Вона стане стартовою. Можеш одразу написати, наприклад, <code>60x8</code>.${cur}`;
  const kb = new InlineKeyboard().text("🤷 Не знаю", obStep("lifts", `n${sub}`));
  if (!prompt) kb.text("✍️ Ввести", obStep("lifts", `i${sub}`));
  return { text, keyboard: withNav(kb, "lifts", { back: true, skip: true }) };
}

// --- Повідомлення про помилки вводу ---

export const MSG = {
  stale: "Це вже неактуально",
  pickGoal: "Обери ціль кнопкою 👇",
  otherNeedsNote: "Для «Інше» напиши кілька слів про ціль",
  badNote: "Напиши від 1 до 300 символів — одним повідомленням.",
  badYear: "Не схоже на рік народження. Напиши чотири цифри, наприклад <code>1995</code> (вік 14–80).",
  badHeight: "Не схоже на зріст. Напиши число від 120 до 230, наприклад <code>178</code>.",
  badWeight: "Не схоже на вагу. Напиши число від 30 до 300, наприклад <code>80,5</code>.",
  activeWorkout: "Заверши тренування (/trening) і повтори",
  failed: "Не вдалося застосувати план. Спробуй ще раз.",
  noText: "Зараз обери відповідь кнопкою.",
};

export function badLift(error: "format" | "weight" | "reps" | "min", ex: Exercise): string {
  const base = `Напиши вагу й повтори, наприклад <code>${fmtKg(ex.minWeightKg + ex.weightStepKg * 5)}x8</code>.`;
  switch (error) {
    case "weight":
      return `Вага має бути більшою за 0 і не більшою за 400 кг. ${base}`;
    case "reps":
      return `Повторів має бути від 1 до 30. ${base}`;
    case "min":
      return `У цій вправі мінімум ${fmtKg(ex.minWeightKg)} кг, крок ${fmtKg(ex.weightStepKg)} кг. ${base}`;
    default:
      return `Не зрозумів. ${base}`;
  }
}

// --- План ---

const daysWord = (n: number): string => (n >= 5 ? "днів" : "дні");

export interface PlanView {
  plan: Plan;
  names: ReadonlyMap<number, string>;
  daysPerWeek: number;
  sessionMin: number;
  limits: readonly string[];
  variant: number;
  weightsUsed: number;
  weightsTotal: number;
}

export function planScreen(v: PlanView): Screen {
  const lines = [`📋 <b>${esc(v.plan.name)}</b>`, `${v.daysPerWeek} ${daysWord(v.daysPerWeek)} на тиждень · ~${v.sessionMin} хв`];
  if (v.limits.length > 0) lines.push(`⚠️ Враховано: ${v.limits.map((l) => LIMIT_LABELS[l] ?? l).join(", ")}`);
  if (v.weightsTotal > 0) lines.push(`⚖️ Ваги враховано для ${v.weightsUsed} із ${v.weightsTotal}`);
  for (const day of v.plan.days) {
    lines.push("", `<b>${esc(day.title)}</b>`);
    for (const s of day.slots) lines.push(`• ${esc(v.names.get(s.exerciseId) ?? "?")} · ${s.sets}×${s.repMin}–${s.repMax}`);
  }
  lines.push("", `<i>Варіант ${v.variant + 1} з 3. Нічого не зміниться, поки не натиснеш «Прийняти».</i>`);
  const kb = new InlineKeyboard()
    .text("✅ Прийняти", obStep("plan", "ok"))
    .row()
    .text("🔁 Інший варіант", obStep("plan", "alt"))
    .text("✏️ Змінити дні", obStep("plan", "days"));
  return { text: clip(lines.join("\n")), keyboard: kb };
}

export function emptyDayScreen(): Screen {
  return {
    text: "<b>⚠️ Не вдалося скласти план із такими обмеженнями</b>\nДля одного з днів не вистачає вправ. Змінімо обмеження чи тривалість — або почнімо спочатку.",
    keyboard: new InlineKeyboard()
      .text("🦵 Змінити обмеження", obStep("plan", "lim"))
      .row()
      .text("⏱ Змінити тривалість", obStep("plan", "dur"))
      .row()
      .text("🔄 Спочатку", obStep("plan", "new")),
  };
}

export function planAcceptedText(planName: string, nextDay: string): string {
  return `✅ <b>Готово!</b> План активовано: ${esc(planName)}.\nНаступне тренування: <b>${esc(nextDay)}</b>. Почати — /trening`;
}

// --- Продовження, профіль ---

export function resumeScreen(): Screen {
  return {
    text: "<b>📝 Анкета не завершена</b>\nПродовжити з місця, де зупинився, чи почати спочатку? Відповіді збережуться.",
    keyboard: new InlineKeyboard().text("▶️ Продовжити", ob(RESUME_CODE, "go")).text("🔄 Спочатку", ob(RESUME_CODE, "new")),
  };
}

export const NEW_PLAN_BUTTON = "📝 Налаштувати персональний план";
export const newPlanKeyboard = (): InlineKeyboard => new InlineKeyboard().text(NEW_PLAN_BUTTON, ob(PROFILE_CODE, "new"));

const LEVEL_TEXT: Record<string, string> = { novice: "новачок", mid: "середній", adv: "досвідчений" };
const SLEEP_TEXT: Record<string, string> = { lt6: "до 6 год", "6_7": "6–7 год", "7_8": "7–8 год", "8p": "понад 8 год" };
const ACTIVITY_TEXT: Record<string, string> = { low: "сидяча", mid: "помірна", high: "на ногах" };

export function profileScreen(
  profile: ProfileRow | null,
  activePlanName: string | null,
  weights: { name: string; weight: StartWeight }[],
  canResume: boolean,
): Screen {
  const lines: string[] = ["<b>👤 Профіль</b>"];
  if (!profile?.goal) {
    lines.push("🎯 Ціль: не вказана");
  } else {
    lines.push(`🎯 Ціль: <b>${GOAL_LABELS[profile.goal as Goal]}</b>`);
    if (profile.goalNote) lines.push(`<i>${esc(profile.goalNote)}</i>`);
  }
  lines.push(`📋 Активний план: ${activePlanName ? `<b>${esc(activePlanName)}</b>` : "немає"}`);
  if (profile) {
    const facts: string[] = [];
    if (profile.level) facts.push(LEVEL_TEXT[profile.level] ?? profile.level);
    if (profile.daysPerWeek) facts.push(`${profile.daysPerWeek} ${daysWord(profile.daysPerWeek)}/тиж`);
    if (profile.sessionMin) facts.push(`${profile.sessionMin} хв`);
    if (profile.place) facts.push(profile.place === "gym" ? "зал" : "вдома");
    if (facts.length) lines.push(`🏋️ ${facts.join(" · ")}`);
    if (profile.limits !== null) {
      const l = profile.limits.split(",").filter(Boolean).map((x) => LIMIT_LABELS[x] ?? x);
      lines.push(`🩹 Обмеження: ${l.length ? l.join(", ") : "немає"}`);
    }
    if (profile.limitsNote) lines.push(`<i>${esc(profile.limitsNote)}</i>`);
    const body: string[] = [];
    if (profile.sex) body.push(profile.sex === "m" ? "чоловік" : "жінка");
    if (profile.birthYear) body.push(`${profile.birthYear} р.н.`);
    if (profile.heightCm) body.push(`${profile.heightCm} см`);
    if (profile.weightKg) body.push(`${fmtKg(profile.weightKg)} кг`);
    if (body.length) lines.push(`👤 ${body.join(" · ")}`);
    const life: string[] = [];
    if (profile.mealsPerDay) life.push(`${profile.mealsPerDay === 5 ? "5+" : profile.mealsPerDay} прийомів їжі`);
    if (profile.sleepBand) life.push(`сон ${SLEEP_TEXT[profile.sleepBand] ?? profile.sleepBand}`);
    if (profile.activity) life.push(`активність ${ACTIVITY_TEXT[profile.activity] ?? profile.activity}`);
    if (life.length) lines.push(`🍽 ${life.join(" · ")}`);
    if (profile.dietNote) lines.push(`<i>${esc(profile.dietNote)}</i>`);
  }
  if (weights.length) lines.push(`⚖️ Робочі ваги: ${weights.map((w) => `${esc(w.name)} ${fmtKg(w.weight.weightKg)}×${w.weight.reps}`).join("; ")}`);
  const kb = new InlineKeyboard();
  if (canResume) kb.text("▶️ Продовжити анкету", ob(RESUME_CODE, "go")).row();
  kb.text(profile?.goal ? "🔄 Пройти знову" : "📝 Пройти анкету", ob(PROFILE_CODE, "new"));
  return { text: clip(lines.join("\n")), keyboard: kb };
}
