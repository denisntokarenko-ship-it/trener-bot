// Єдине місце текстів бота (docs/spec/phase-1b.md, §6 «Гайд оформлення»). Тест-греп: українських літералів
// у src/bot/** поза цим файлом немає. Усе — для parse_mode HTML; користувацькі рядки (імʼя, нотатки, назви)
// проходять через esc(). Файл без I/O: лише рядки й чисті функції, що їх збирають.
//
// Тон: на «ти», коротко, тепло без награності. Помилка = що сталося + що робити.
// Емодзі: 🏋️ тренування · 🎯 ціль · 📋 програма · 📈 прогрес · ✅ записано · ⚠️ увага · ❌ помилка · 💡 техніка ·
//         🎥 відео · ⚖️ вага · 🔁 заміна · ⏭ пропуск · 🏆 рекорд · 🍽 їжа · 😴 сон.
import type { Exercise, ProfileRow, ProgramDay, StartWeight } from "../db/repo";
import { GOAL_LABELS, type Goal, type Plan } from "../domain/plan";

// --- Форматування ---

/** N6: ліміт тексту повідомлення Telegram. */
export const TELEGRAM_TEXT_MAX = 4096;

/** Екранування користувацьких рядків для parse_mode HTML (нотатки, імʼя, назви). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Ліміт 4096. Тег ніколи не перетинає рядок, тож різати можна лише по межі рядка: так ні тег, ні HTML-сутність
 * не лишаються розірваними (Telegram відхилив би весь запит).
 */
export function clip(text: string): string {
  if (text.length <= TELEGRAM_TEXT_MAX) return text;
  const cut = text.slice(0, TELEGRAM_TEXT_MAX - 1);
  const nl = cut.lastIndexOf("\n");
  return `${nl > 0 ? cut.slice(0, nl) : cut.replace(/<[^>]*$|&[#a-z0-9]*$/i, "")}…`;
}

/** 42.5 → «42,5». */
export const fmtKg = (kg: number): string => String(kg).replace(".", ",");

/** 6240 → «6 240» . */
export const fmtInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Назва дня для показу: `title`, інакше «День <code>». Код у callback_data лишається, назва туди не йде. */
export function dayName(d: { code: string; title: string | null }): string {
  return d.title && d.title.trim() !== "" ? d.title : `День ${d.code}`;
}

// --- Меню, опис, привітання ---

/** Меню команд (`setMyCommands`): імена без «/», опис ≤ 256 символів за вимогою Telegram. */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "start", description: "Почати" },
  { command: "trening", description: "Тренування" },
  { command: "prohrama", description: "Програма й наступне заняття" },
  { command: "progres", description: "Останні тренування" },
  { command: "profil", description: "Профіль і план" },
];

/** `setMyDescription` ≤ 512 символів: показується в порожньому чаті до першого /start. */
export const BOT_DESCRIPTION =
  "Щоденник тренувань у Telegram. Дай відповіді на кілька питань — і бот складе план під твою ціль, рівень і обмеження. У залі лише натискаєш кнопки: бот підказує вагу й повтори, записує підходи та показує прогрес.";

/** `setMyShortDescription` ≤ 120 символів: рядок у профілі бота. */
export const BOT_SHORT_DESCRIPTION = "Щоденник тренувань: персональний план, ваги й повтори в кілька натискань.";

export function greeting(firstName: string): string {
  const list = BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n");
  return `👋 <b>Привіт, ${esc(firstName)}!</b>\nЯ записую твої тренування й підказую ваги.\n\n${list}`;
}

// --- Помилки й загальні відповіді ---

export const SOMETHING_WRONG = "❌ Щось пішло не так. Спробуй ще раз.";
export const NOT_UNDERSTOOD = "🤔 Не зрозумів. Обери команду з меню: /trening, /prohrama або /progres.";
export const NO_PROGRAM = "❌ Програму не знайдено. Запусти сид (docs/RUNBOOK.md) або пройди анкету: /start.";
export const NO_WORKOUTS = "📈 Тренувань ще немає.\nПочни перше: /trening";

/** Відповіді answerCallbackQuery (N6: ≤ 200 символів). Без розмітки: тост показує текст як є. */
export const ANSWER = {
  stale: "Кнопка застаріла",
  staleShowCurrent: "Кнопка застаріла — показую поточний підхід",
  finished: "Тренування вже завершене. /trening — нове",
  ratedAlready: "Оцінку вже записано",
  recorded: "Записано",
} as const;

// --- Кнопки (одна емодзі на кнопці, ≤ 24 символи) ---

export const BTN = {
  start: "▶️ Почати",
  back: "⬅️ Назад",
  skip: "⏭ Пропустити",
  next: "➡️ Далі",
  done: "✅ Готово",
  unknown: "🤷 Не знаю",
  enter: "✍️ Ввести",
  accept: "✅ Прийняти",
  otherVariant: "🔁 Інший варіант",
  changeDays: "✏️ Змінити дні",
  changeLimits: "🦵 Змінити обмеження",
  changeDuration: "⏱ Змінити тривалість",
  restart: "🔄 Спочатку",
  resume: "▶️ Продовжити",
  resumeSurvey: "▶️ Продовжити анкету",
  newPlan: "📝 Налаштувати план",
  again: "🔄 Пройти знову",
  survey: "📝 Пройти анкету",
  weight: "⚖️ Вага",
  swap: "🔁 Замінити",
  skipSet: "⏭ Пропустити",
  cues: "💡 Техніка",
  video: "🎥 Відео",
  cancel: "↩️ Скасувати",
  backToSet: "↩️ Назад",
} as const;

// --- Тренування: екран вправи ---

export interface ScreenTextModel {
  dayName: string;
  slotIndex: number;
  slotCount: number;
  exercise: Pick<Exercise, "nameUk" | "equipment" | "cues">;
  setNo: number;
  sets: number;
  weightKg: number;
  reps: number;
  calibration: boolean;
  done: ReadonlyArray<{ setNo: number; weightKg: number | null; reps: number | null; skipped: boolean }>;
  showCues: boolean;
}

const isBodyweight = (e: Pick<Exercise, "equipment">): boolean => e.equipment === "bodyweight";

export function screenText(m: ScreenTextModel): string {
  const load = isBodyweight(m.exercise) ? "власна вага" : `${fmtKg(m.weightKg)} кг`;
  const lines = [
    `🏋️ <i>${esc(m.dayName)} · вправа ${m.slotIndex + 1}/${m.slotCount}</i>`,
    `<b>${esc(m.exercise.nameUk)}</b>`,
    `Підхід ${m.setNo}/${m.sets} · ціль <b>${load} × ${m.reps}</b>`,
  ];
  if (m.calibration && m.setNo === 1 && !isBodyweight(m.exercise)) {
    lines.push("<i>Калібрування: підбери робочу вагу кнопкою ⚖️</i>");
  }
  for (const s of m.done) {
    lines.push(s.skipped ? `⏭ ${s.setNo}: пропущено` : `✅ ${s.setNo}: ${fmtKg(s.weightKg ?? 0)} × ${s.reps}`);
  }
  if (m.showCues) lines.push("", "💡 <b>Техніка</b>", ...m.exercise.cues.map((c) => `• <i>${esc(c)}</i>`));
  return clip(lines.join("\n"));
}

export const swapTitle = (name: string): string => `🔁 Чим замінити <b>${esc(name)}</b>?`;
export const RATING_TEXT = "✅ <b>Готово!</b> Як тяжко було?\n<i>1 — легко, 5 — на межі.</i>";

const weightHint = (e: Pick<Exercise, "weightStepKg" | "minWeightKg">): string =>
  `Крок ${fmtKg(e.weightStepKg)} кг, від ${fmtKg(e.minWeightKg)} кг`;
const weightExample = (e: Pick<Exercise, "weightStepKg" | "minWeightKg">): string => fmtKg(e.minWeightKg + e.weightStepKg * 5);

export const weightPromptText = (e: Pick<Exercise, "nameUk" | "weightStepKg" | "minWeightKg">): string =>
  `⚖️ Яка вага для <b>${esc(e.nameUk)}</b>, кг?\n${weightHint(e)}. Наприклад: <code>${weightExample(e)}</code>`;

export const badWeightText = (e: Pick<Exercise, "weightStepKg" | "minWeightKg">): string =>
  `❌ Не схоже на вагу. ${weightHint(e)}. Наприклад: <code>${weightExample(e)}</code>`;

/** Підтвердження на місці запиту ваги після того, як вагу введено. */
export const weightEcho = (kg: number): string => `⚖️ <b>${fmtKg(kg)} кг</b>`;

// --- Тренування: підсумок ---

export interface SummaryTextModel {
  dayName: string;
  minutes: number;
  setsTotal: number;
  setsDone: number;
  setsSkipped: number;
  volumeKg: number;
  effort: number;
  /** Готові рядки рекордів (`recordReps` / `recordWeight`). */
  records: string[];
  nextDayName: string;
}

export const recordReps = (name: string, reps: number): string => `${esc(name)} — <b>${reps} повт.</b>`;
export const recordWeight = (name: string, kg: number, reps: number): string => `${esc(name)} — <b>${fmtKg(kg)} кг × ${reps}</b>`;

export function summaryText(m: SummaryTextModel): string {
  const lines = [
    `🏋️ <b>${esc(m.dayName)}</b> · ${m.minutes} хв`,
    m.setsSkipped > 0
      ? `Підходів: <b>${m.setsDone} з ${m.setsTotal}</b> (пропущено ${m.setsSkipped})`
      : `Підходів: <b>${m.setsDone} з ${m.setsTotal}</b>`,
    `Обсяг: <b>${fmtInt(m.volumeKg)} кг</b>`,
    `Тяжкість: <b>${m.effort}/5</b>`,
  ];
  if (m.records.length > 0) lines.push("", "🏆 <b>Рекорди</b>", ...m.records.map((r) => `• ${r}`));
  lines.push("", `Наступне: <b>${esc(m.nextDayName)}</b>`);
  return clip(lines.join("\n"));
}

// --- /progres і /prohrama ---

export interface WorkoutBlockText {
  date: string;
  dayName: string;
  /** Оцінка тяжкості 1–5 для завершеного; null — обірване. */
  effort: number | null;
  /** Вправи: готові пари «назва», «підходи». */
  exercises: ReadonlyArray<{ name: string; sets: string }>;
}

export function workoutBlock(w: WorkoutBlockText): string {
  const head = `<b>${w.date} · ${esc(w.dayName)}</b> · ${w.effort !== null ? `${w.effort}/5` : "не завершене"}`;
  const body = w.exercises.map((e) => `${esc(e.name)} ${e.sets}`).join(" · ");
  return body ? `${head}\n${body}` : head;
}

export const progressTitle = "📈 <b>Останні тренування</b>";

export interface NextSlotLine {
  nameUk: string;
  bodyweight: boolean;
  weightKg: number;
  targetReps: number;
}

export interface ProgramTextModel {
  name: string;
  days: ProgramDay[];
  next: { dayName: string; lines: NextSlotLine[] };
  /** Назва дня активного тренування, якщо воно є. */
  activeDayName: string | null;
}

export function programText(m: ProgramTextModel): string {
  const parts: string[] = [`📋 <b>${esc(m.name)}</b>`];
  for (const d of m.days) {
    const slots = d.slots.map((s, i) => `${i + 1}. ${esc(s.exercise.nameUk)} — ${s.sets} × ${s.repMin}–${s.repMax}`);
    parts.push([`<b>${esc(dayName(d))}</b>`, ...slots].join("\n"));
  }
  const next = m.next.lines.map(
    (l) => `${esc(l.nameUk)} — ${l.bodyweight ? "власна вага" : `${fmtKg(l.weightKg)} кг`} × ${l.targetReps}`,
  );
  parts.push([`➡️ <b>Наступне: ${esc(m.next.dayName)}</b>`, ...next].join("\n"));
  if (m.activeDayName) parts.push(`🏋️ Зараз триває: <b>${esc(m.activeDayName)}</b> — /trening, щоб продовжити`);
  return clip(parts.join("\n\n"));
}

// --- Анкета: питання з варіантами ---

export const SURVEY_TOTAL = 15;

export type EnumStep = "goal" | "level" | "days" | "minutes" | "place" | "sex" | "meals" | "sleep" | "activity";
export type EnumField = "goal" | "level" | "daysPerWeek" | "sessionMin" | "place" | "sex" | "mealsPerDay" | "sleepBand" | "activity";

export interface Opt {
  value: string;
  stored: string | number;
  text: string;
  emoji?: string;
}
export interface EnumQuestion {
  n: number;
  field: EnumField;
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
      { value: "novice", stored: "novice", text: "Новачок · до 6 міс" },
      { value: "mid", stored: "mid", text: "Середній · 6–24 міс" },
      { value: "adv", stored: "adv", text: "Досвідчений · 2+ роки" },
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

export const LIMIT_OPTS = [
  { flag: "knee", code: "kn", label: "Коліна", emoji: "🦵" },
  { flag: "back", code: "bk", label: "Спина", emoji: "🔙" },
  { flag: "shoulder", code: "sh", label: "Плечі", emoji: "💪" },
  { flag: "wrist", code: "wr", label: "Запʼястя", emoji: "✋" },
] as const;
export const LIMIT_LABELS: Record<string, string> = { knee: "коліна", back: "спина", shoulder: "плечі", wrist: "запʼястя" };

/** Нотатка для екрана профілю: скорочується до екранування, щоб clip() не різав HTML-сутність. */
export const short = (s: string, n = 100): string => (s.length > n ? `${[...s].slice(0, n).join("")}…` : s);
/** Шапка питання: назва жирним, номер курсивом. */
export const head = (n: number, title: string): string => `<b>${title}</b>\n<i>Питання ${n} з ${SURVEY_TOTAL}</i>`;

export const daysWord = (n: number): string => (n >= 5 ? "днів" : "дні");

export function welcomeText(intro = ""): string {
  return (
    (intro ? `${intro}\n\n` : "") +
    "🎯 <b>Налаштуємо тренування під тебе</b>\n" +
    "Кілька питань, ~3 хвилини: ціль, рівень, дні, обмеження. З відповідей я складу план, а ти його підтвердиш.\n" +
    "Відповіді можна змінити будь-коли в /profil."
  );
}

export function enumText(step: EnumStep, hint: string | undefined): string {
  const q = ENUMS[step];
  const lines = [hint, head(q.n, q.title), q.hint ? `<i>${q.hint}</i>` : ""].filter(Boolean);
  if (step === "goal") lines.push("Без цілі я не складу план, тому це питання не пропустити.");
  return lines.join("\n");
}

export function goalNoteText(other: boolean, current: string | null | undefined): string {
  const note = current ? `\nЗараз: <i>${esc(short(current))}</i>` : "";
  return (
    (other
      ? "✍️ <b>Опиши свою ціль</b>\nНапиши кількома словами, чого хочеш."
      : "✍️ <b>Хочеш уточнити?</b>\nМожеш описати ціль своїми словами (до 300 символів) або йти далі.") + note
  );
}

export const limitsText = (): string =>
  `${head(6, "🩹 Є обмеження чи травми?")}\n<i>Познач, що болить або заважає. Я не братиму для тебе вправи, які це навантажують.</i>`;

export function noteText(isDiet: boolean, current: string | null): string {
  const title = isDiet ? head(13, "🍽 Харчові обмеження, алергії") : "📝 <b>Хочеш додати нотатку?</b>";
  const body = isDiet
    ? "Напиши одним повідомленням (до 300 символів) або пропусти."
    : "Напиши одним повідомленням (до 300 символів), що ще варто знати. Без діагнозів — я лише збережу її.";
  return `${title}\n${body}${current ? `\nЗараз: <i>${esc(current)}</i>` : ""}`;
}

export const NUMBER_SPECS = {
  birth: { n: 9, title: "🎂 Рік народження", example: "1995" },
  height: { n: 10, title: "📏 Зріст, см", example: "178" },
  weight: { n: 11, title: "⚖️ Вага тіла, кг", example: "80,5" },
} as const;

export function numberText(step: keyof typeof NUMBER_SPECS, current: number | null | undefined): string {
  const spec = NUMBER_SPECS[step];
  const cur = current != null ? `\nЗараз: <b>${fmtKg(current)}</b> ✅` : "";
  return `${head(spec.n, spec.title)}\nНапиши число, наприклад <code>${spec.example}</code>.${cur}`;
}

export function liftText(ex: Pick<Exercise, "nameUk" | "weightStepKg">, sub: number, total: number, current: StartWeight | null, prompt: boolean): string {
  const cur = current ? `\nЗараз: <b>${fmtKg(current.weightKg)} кг × ${current.reps}</b> ✅` : "";
  const head7 = `⚖️ <b>Робочі ваги</b>\n<i>Питання 7 з ${SURVEY_TOTAL} · вправа ${sub + 1} з ${total}</i>`;
  return prompt
    ? `${head7}\n<b>${esc(ex.nameUk)}</b>\nНапиши вагу й повтори: <code>60x8</code> або <code>42,5x10</code>. Крок ваги — ${fmtKg(ex.weightStepKg)} кг.${cur}`
    : `${head7}\nЗнаєш свою вагу у вправі <b>${esc(ex.nameUk)}</b>? Вона стане стартовою. Можеш одразу написати, наприклад, <code>60x8</code>.${cur}`;
}

// --- Анкета: відповіді на ввід ---

export const MSG = {
  stale: "Це вже неактуально",
  pickGoal: "Обери ціль кнопкою 👇",
  otherNeedsNote: "Для «Інше» напиши кілька слів про ціль",
  badNote: "❌ Напиши від 1 до 300 символів — одним повідомленням.",
  badYear: "❌ Не схоже на рік народження. Напиши чотири цифри, наприклад <code>1995</code> (вік 14–80).",
  badHeight: "❌ Не схоже на зріст. Напиши число від 120 до 230, наприклад <code>178</code>.",
  badWeight: "❌ Не схоже на вагу. Напиши число від 30 до 300, наприклад <code>80,5</code>.",
  activeWorkout: "Спершу заверши тренування (/trening), потім повтори",
  failed: "Не вдалося застосувати план. Спробуй ще раз.",
  noText: "Зараз обери відповідь кнопкою.",
};

export function badLift(error: "format" | "weight" | "reps" | "min", ex: Pick<Exercise, "minWeightKg" | "weightStepKg">): string {
  const base = `Напиши вагу й повтори, наприклад <code>${fmtKg(ex.minWeightKg + ex.weightStepKg * 5)}x8</code>.`;
  switch (error) {
    case "weight":
      return `❌ Вага має бути більшою за 0 і не більшою за 400 кг. ${base}`;
    case "reps":
      return `❌ Повторів має бути від 1 до 30. ${base}`;
    case "min":
      return `❌ У цій вправі мінімум ${fmtKg(ex.minWeightKg)} кг, крок ${fmtKg(ex.weightStepKg)} кг. ${base}`;
    default:
      return `❌ Не зрозумів. ${base}`;
  }
}

// --- Анкета: план ---

export interface PlanTextModel {
  plan: Plan;
  names: ReadonlyMap<number, string>;
  daysPerWeek: number;
  sessionMin: number;
  limits: readonly string[];
  variant: number;
  weightsUsed: number;
  weightsTotal: number;
}

export function planText(v: PlanTextModel): string {
  const lines = [`📋 <b>${esc(v.plan.name)}</b>`, `${v.daysPerWeek} ${daysWord(v.daysPerWeek)} на тиждень · ~${v.sessionMin} хв`];
  if (v.limits.length > 0) lines.push(`⚠️ Враховано: ${v.limits.map((l) => LIMIT_LABELS[l] ?? l).join(", ")}`);
  if (v.weightsTotal > 0) lines.push(`⚖️ Ваги враховано для ${v.weightsUsed} із ${v.weightsTotal}`);
  for (const day of v.plan.days) {
    lines.push("", `<b>${esc(day.title)}</b>`);
    for (const s of day.slots) lines.push(`• ${esc(v.names.get(s.exerciseId) ?? "?")} · ${s.sets}×${s.repMin}–${s.repMax}`);
  }
  lines.push("", `<i>Варіант ${v.variant + 1} з 3. Нічого не зміниться, поки не натиснеш «Прийняти».</i>`);
  return clip(lines.join("\n"));
}

export const EMPTY_DAY_TEXT =
  "⚠️ <b>Не вдалося скласти план із такими обмеженнями</b>\nДля одного з днів не вистачає вправ. Змінімо обмеження чи тривалість — або почнімо спочатку.";

export const planAcceptedText = (planName: string, nextDay: string): string =>
  `✅ <b>Готово!</b> Активовано: ${esc(planName)}.\nНаступне тренування: <b>${esc(nextDay)}</b>. Почати — /trening`;

export const RESUME_TEXT = "📝 <b>Анкета не завершена</b>\nПродовжити з місця, де зупинився, чи почати спочатку? Відповіді збережуться.";

// --- Профіль ---

const LEVEL_TEXT: Record<string, string> = { novice: "новачок", mid: "середній", adv: "досвідчений" };
const SLEEP_TEXT: Record<string, string> = { lt6: "до 6 год", "6_7": "6–7 год", "7_8": "7–8 год", "8p": "понад 8 год" };
const ACTIVITY_TEXT: Record<string, string> = { low: "сидяча", mid: "помірна", high: "на ногах" };

export function profileText(
  profile: ProfileRow | null,
  activePlanName: string | null,
  weights: { name: string; weight: StartWeight }[],
): string {
  const lines: string[] = ["👤 <b>Профіль</b>"];
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
    if (profile.limitsNote) lines.push(`<i>${esc(short(profile.limitsNote))}</i>`);
    const body: string[] = [];
    if (profile.sex) body.push(profile.sex === "m" ? "чоловік" : "жінка");
    if (profile.birthYear) body.push(`${profile.birthYear} р. н.`);
    if (profile.heightCm) body.push(`${profile.heightCm} см`);
    if (profile.weightKg) body.push(`${fmtKg(profile.weightKg)} кг`);
    if (body.length) lines.push(`👤 ${body.join(" · ")}`);
    const life: string[] = [];
    if (profile.mealsPerDay) life.push(`${profile.mealsPerDay === 5 ? "5+" : profile.mealsPerDay} прийомів їжі`);
    if (profile.sleepBand) life.push(`сон ${SLEEP_TEXT[profile.sleepBand] ?? profile.sleepBand}`);
    if (profile.activity) life.push(`активність ${ACTIVITY_TEXT[profile.activity] ?? profile.activity}`);
    if (life.length) lines.push(`🍽 ${life.join(" · ")}`);
    if (profile.dietNote) lines.push(`<i>${esc(short(profile.dietNote))}</i>`);
  }
  if (weights.length) lines.push(`⚖️ Робочі ваги: ${weights.map((w) => `${esc(w.name)} ${fmtKg(w.weight.weightKg)}×${w.weight.reps}`).join("; ")}`);
  return clip(lines.join("\n"));
}
