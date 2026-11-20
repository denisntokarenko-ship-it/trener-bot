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

/** Групи мʼязів у підказці складу дня. Ключі = exercises.muscle_group. */
export const MUSCLE_UK: Record<string, string> = {
  legs: "ноги",
  chest: "груди",
  back: "спина",
  shoulders: "плечі",
  core: "кор",
};

/** Підказка складу дня: до 3 різних груп мʼязів за порядком вправ (детерміновано, з каталогу; у БД не зберігається). */
export function dayHint(slots: readonly { exercise: { muscleGroup: string } }[]): string {
  const seen: string[] = [];
  for (const s of slots) {
    const g = MUSCLE_UK[s.exercise.muscleGroup];
    if (g && !seen.includes(g)) seen.push(g);
  }
  return seen.slice(0, 3).join(", ");
}

/** Самодостатня назва дня: «Все тіло A (ноги, груди, спина)»; без слотів — лише назва. */
export function dayLabel(d: { code: string; title: string | null; slots?: readonly { exercise: { muscleGroup: string } }[] }): string {
  const h = d.slots ? dayHint(d.slots) : "";
  return h ? `${dayName(d)} (${h})` : dayName(d);
}

/** Єдиний підпис «що далі» для підсумку, програми й екрана після анкети. */
export const NEXT_WORKOUT = "Наступне тренування";

// --- Меню, опис, привітання ---

/** Меню команд (`setMyCommands`): імена без «/», опис ≤ 256 символів за вимогою Telegram. */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "start", description: "Почати" },
  { command: "trening", description: "Тренування" },
  { command: "prohrama", description: "Програма й наступне заняття" },
  { command: "progres", description: "Прогрес: вага, рекорди, e1RM" },
  { command: "vaga", description: "Записати вагу тіла" },
  { command: "profil", description: "Профіль і план" },
  { command: "nalashtuvannia", description: "Дні, час нагадувань, часовий пояс" },
  { command: "yizha", description: "Їжа за день і норма" },
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
export const NO_PROGRAM = "❌ Програму не знайдено. Пройди анкету: /start.";
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
export const RATING_TEXT = "✅ <b>Готово!</b> Наскільки було важко?\n<i>1 — легко, 5 — на межі.</i>";

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
    `Складність: <b>${m.effort}/5</b>`,
  ];
  if (m.records.length > 0) lines.push("", "🏆 <b>Рекорди</b>", ...m.records.map((r) => `• ${r}`));
  lines.push("", `${NEXT_WORKOUT}: <b>${esc(m.nextDayName)}</b>`);
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

// --- Повний /progres (docs/spec/phase-2.md, розділ 3) ---

export const PROGRESS_FULL_TITLE = "📈 <b>Прогрес</b>";
export const PROGRESS_EMPTY = "📈 Ще немає даних.\nПочни: /trening, вага: /vaga 78.4";
export const PROGRESS_RECENT_BTN = "📜 Останні тренування";
export const PROGRESS_BACK_BTN = "⬅️ Назад";

/** Підписи до чисел блоку ваги. */
export const WEIGHT_LABEL_PROFILE = "анкета";
export const weightLabelFirst = (date: string): string => `перший запис ${date}`;
export const weightLabelLast = (date: string): string => `остання ${date}`;
/** Середнє 7 днів; менше 3 зважувань — з приміткою (n зваж.). */
export const weightLabelAvg = (n: number): string => (n < 3 ? `середнє 7 днів · ${n} зваж.` : "середнє 7 днів");

export interface WeightBlockModel {
  /** Старт тренду: вага з анкети чи перший запис; null — немає. */
  start: { kg: string; label: string } | null;
  /** «Зараз»: середнє 7 днів (з приміткою, якщо зважувань < 3) або остання вага з датою. */
  now: { kg: string; label: string } | null;
  /** Зміна «зараз» проти старту, уже зі знаком; null — не показується. */
  total: string | null;
  /** Зміна до минулого тижня зі знаком; null — «—» не друкуємо. */
  weekChange: string | null;
  /** Середні W2 · W1 · W0 від старого до нового; вікна без записів пропущено. */
  windows: readonly string[];
}

/** Рядок(и) ваги тіла; без жодної цифри — порожній рядок. */
export function weightBlock(m: WeightBlockModel): string {
  const parts: string[] = [];
  if (m.start) parts.push(`${m.start.kg} (${m.start.label})`);
  if (m.now) parts.push(`${m.now.kg} (${m.now.label})`);
  if (parts.length === 0) return "";
  let head = `⚖️ Вага: ${parts.join(" → ")}`;
  if (m.total) head += ` · ${m.total} кг`;
  const second: string[] = [];
  if (m.weekChange) second.push(`Тиждень до тижня: ${m.weekChange} кг`);
  if (m.windows.length >= 2) second.push(`7-денні вікна: ${m.windows.join(" · ")}`);
  return second.length > 0 ? `${head}
   ${second.join(" · ")}` : head;
}

export interface ExerciseBlockModel {
  name: string;
  bodyweight: boolean;
  start: { weightKg: number; reps: number };
  now: { weightKg: number; reps: number };
  record: { weightKg: number; reps: number; date: string };
  e1rm: number | null;
}

/** Блок вправи: «Старт 40 × 8 → зараз 60 × 8 · рекорд 62,5 × 6 (23.10)» + e1RM; для ваги тіла — лише повтори. */
export function exerciseBlock(m: ExerciseBlockModel): string {
  const fmt = (x: { weightKg: number; reps: number }): string => (m.bodyweight ? `${x.reps} повт.` : `${fmtKg(x.weightKg)} × ${x.reps}`);
  const lines = [`<b>${esc(m.name)}</b>`, `   Старт ${fmt(m.start)} → зараз ${fmt(m.now)} · рекорд ${fmt(m.record)} (${m.record.date})`];
  if (m.e1rm !== null) lines.push(`   e1RM ≈ ${fmtKg(m.e1rm)} кг`);
  return lines.join("\n");
}

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
    const hint = dayHint(d.slots);
    parts.push([`<b>${esc(dayName(d))}</b>${hint ? ` · ${hint}` : ""}`, ...slots].join("\n"));
  }
  const next = m.next.lines.map(
    (l) => `${esc(l.nameUk)} — ${l.bodyweight ? "власна вага" : `${fmtKg(l.weightKg)} кг`} × ${l.targetReps}`,
  );
  parts.push([`➡️ <b>${NEXT_WORKOUT}: ${esc(m.next.dayName)}</b>`, ...next].join("\n"));
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

/** 1 прийом їжі · 2–4 прийоми · 5+ прийомів (відмінювання за числом). */
export const mealsText = (n: number): string => (n >= 5 ? "5+ прийомів їжі" : n === 1 ? "1 прийом їжі" : `${n} прийоми їжі`);

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
  if (step === "goal") lines.push("Без цілі я не складу план, тому його не можна пропустити.");
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
  `${head(6, "🩹 Є обмеження чи травми?")}\n<i>Познач, що болить або заважає. Не включатиму вправи, що навантажують ці місця.</i>`;

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
  `✅ <b>Готово!</b> Активовано: ${esc(planName)}.\n${NEXT_WORKOUT}: <b>${esc(nextDay)}</b>. Почати — /trening`;

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
    if (profile.mealsPerDay) life.push(`${mealsText(profile.mealsPerDay)}`);
    if (profile.sleepBand) life.push(`сон ${SLEEP_TEXT[profile.sleepBand] ?? profile.sleepBand}`);
    if (profile.activity) life.push(`активність ${ACTIVITY_TEXT[profile.activity] ?? profile.activity}`);
    if (life.length) lines.push(`🍽 ${life.join(" · ")}`);
    if (profile.dietNote) lines.push(`<i>${esc(short(profile.dietNote))}</i>`);
  }
  if (weights.length) lines.push(`⚖️ Робочі ваги: ${weights.map((w) => `${esc(w.name)} ${fmtKg(w.weight.weightKg)}×${w.weight.reps}`).join("; ")}`);
  return clip(lines.join("\n"));
}

// --- Вага тіла (docs/spec/phase-2.md, розділ 2) ---

export const WEIGHT_HINT = "Вагу тіла записують так: /vaga 78.4";
export const WEIGHT_BAD = "Не схоже на вагу. Приклад: /vaga 78.4";
export const WEIGHT_NONE = "⚖️ Ще немає записів ваги.\nЗаписати: /vaga 78.4";

/** `(середнє за 7 днів: 78,9 кг)`; 1–2 записи — з приміткою `(n зваж.)`; 0 — «—». */
function avgLabel(avg: string | null, n: number): string {
  if (avg === null) return "—";
  return n < 3 ? `${avg} кг (${n} зваж.)` : `${avg} кг`;
}

export function weightSaved(a: { kg: string; replaced: string | null; avg: string | null; n: number; jump: string | null }): string {
  const lines = [`⚖️ ${a.kg} кг записано${a.replaced ? `, замінило ${a.replaced}` : ""} (середнє за 7 днів: ${avgLabel(a.avg, a.n)})`];
  if (a.jump) lines.push(`Різниця ${a.jump} кг — якщо помилка, надішли ще раз: /vaga 78.4`);
  return lines.join("\n");
}

export function weightLast(a: { kg: string; date: string; avg: string | null; n: number }): string {
  return `⚖️ Остання вага: ${a.kg} кг (${a.date})\nСереднє за 7 днів: ${avgLabel(a.avg, a.n)}\nЗаписати: /vaga 78.4`;
}

// --- Нагадування й недільний звіт (docs/spec/phase-2.md, розділ 4) ---

export const WEIGH_REMINDER = "⚖️ Доброго ранку! Вага? Надішли число у відповідь (наприклад 78.4) або /vaga 78.4";
/** Відповідь на нагадування про зважування за минулу дату (крок 1 маршрутизації числа). */
export const WEIGH_REMINDER_STALE = "Це нагадування за вчора. Надішли /vaga 78.4 — запишу на сьогодні";

export interface TrainReminderLine {
  nameUk: string;
  bodyweight: boolean;
  weightKg: number;
  targetReps: number;
  /** Вправа без історії: показується «калібрування, старт ≈ N кг». */
  calibration: boolean;
}

function trainLine(l: TrainReminderLine): string {
  if (l.bodyweight) return `${esc(l.nameUk)} — власна вага × ${l.targetReps}`;
  return l.calibration
    ? `${esc(l.nameUk)} — калібрування, старт ≈ ${fmtKg(l.weightKg)} кг × ${l.targetReps}`
    : `${esc(l.nameUk)} — ${fmtKg(l.weightKg)} кг × ${l.targetReps}`;
}

/** Нагадування про тренування. Не влізло в 4096 — список різався з кінця (N6), «Почати» лишається. */
export function trainReminderText(m: { dayLabel: string; lines: readonly TrainReminderLine[] }): string {
  const head = `🏋️ <b>Сьогодні тренування — ${esc(m.dayLabel)}</b>`;
  const foot = "Почати: /trening";
  const lines = m.lines.map(trainLine);
  const join = (l: readonly string[]): string => [head, ...l, foot].join("\n");
  while (lines.length > 0 && join(lines).length > TELEGRAM_TEXT_MAX) lines.pop();
  return clip(join(lines));
}

const MONTHS_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];

/** `19–25 жовтня`; через місяць — `28 жовтня – 3 листопада` (родовий відмінок). */
export function weekRangeLabel(startDate: string, endDate: string): string {
  const day = (d: string): number => Number(d.slice(8));
  const month = (d: string): string => MONTHS_GEN[Number(d.slice(5, 7)) - 1]!;
  return startDate.slice(0, 7) === endDate.slice(0, 7)
    ? `${day(startDate)}–${day(endDate)} ${month(endDate)}`
    : `${day(startDate)} ${month(startDate)} – ${day(endDate)} ${month(endDate)}`;
}

export interface WeeklyReportTextModel {
  weekStart: string;
  weekEnd: string;
  workouts: number;
  planned: number;
  sets: number;
  volumeKg: number;
  /** Готові рядки рекордів (`recordWeight` / `recordReps`), ≤ 3. */
  records: string[];
  /** Середня вага, її кількість записів і зміна до минулого тижня — вже відформатовані; null — рядка немає. */
  weight: { avg: string; n: number; change: string | null } | null;
  next: string | null;
}

export function weeklyReportText(m: WeeklyReportTextModel): string {
  const lines = [`📊 <b>Тиждень ${weekRangeLabel(m.weekStart, m.weekEnd)}</b>`];
  const next = m.next ? `${esc(m.next)} — /trening` : "";
  if (m.workouts === 0) {
    lines.push(`Цього тижня тренувань не було. Нічого страшного${next ? ` — далі: ${next}` : "."}`);
  } else {
    lines.push(`Тренувань: <b>${m.planned > 0 ? `${m.workouts} з ${m.planned}` : m.workouts}</b> · Підходів: <b>${m.sets}</b> · Обсяг: <b>${fmtInt(m.volumeKg)} кг</b>`);
    if (m.records.length > 0) lines.push(`🏆 Нові рекорди: ${m.records.join("; ")}`);
  }
  if (m.weight) {
    const note = m.weight.n < 3 ? ` (${m.weight.n} зваж.)` : "";
    lines.push(`⚖️ Середня вага <b>${m.weight.avg} кг</b>${note}${m.weight.change ? ` (${m.weight.change} до минулого тижня)` : ""}`);
  }
  if (m.workouts > 0 && next) lines.push(`Далі: ${next}`);
  return clip(lines.join("\n"));
}

// --- /nalashtuvannia (docs/spec/phase-2.md, розділ 5) ---

export const WEEKDAYS_UK = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"] as const;

export const SETTINGS_BTN = {
  days: "📅 Дні",
  remind: "🏋️ Час",
  weigh: "⚖️ Час",
  tz: "🌍 Пояс",
  profile: "👤 Профіль",
  done: "✅ Готово",
  back: "⬅️ Назад",
  off: "🔕 Вимкнути",
} as const;

export const SETTINGS_MSG = {
  stale: "Це вже неактуально",
  lastDay: "Потрібен хоча б один день",
  failed: "Щось пішло не так",
  saved: "Збережено",
  tzBad: "Не знаю такого поясу. Приклад: Europe/Kyiv, Europe/Warsaw",
} as const;

export const settingsTzHint = (current: string): string => `Надішли: /nalashtuvannia Europe/Warsaw (зараз ${current})`;
export const settingsTzSaved = (tz: string): string => `🌍 Часовий пояс: <b>${esc(tz)}</b>`;
export const settingsDaysTitle = "📅 <b>Дні тренувань</b>\nНатисни день, щоб додати чи зняти.";
export const settingsTimeTitle = (kind: "remind" | "weigh", hour?: number): string =>
  `${kind === "remind" ? "🏋️ <b>Нагадування про тренування</b>" : "⚖️ <b>Нагадування про вагу</b>"}\n${hour === undefined ? "Обери годину." : `Година ${String(hour).padStart(2, "0")}:__ — обери хвилини.`}`;

export function settingsText(s: { days: readonly number[]; remindTime: string | null; weighTime: string | null; tz: string; planDays: number | null }): string {
  const lines = [
    "⚙️ <b>Налаштування</b>",
    `📅 Дні тренувань: ${s.days.map((d) => WEEKDAYS_UK[d - 1]).join(", ")}`,
    `🏋️ Нагадування про тренування: ${s.remindTime ?? "вимкнено"}`,
    `⚖️ Нагадування про вагу: ${s.weighTime ?? "вимкнено"}`,
    `🌍 Часовий пояс: ${esc(s.tz)}`,
  ];
  if (s.planDays !== null && s.planDays !== s.days.length) {
    lines.push("", `<i>План розрахований на ${s.planDays} дн., обрано ${s.days.length} — це лише нагадування.</i>`);
  }
  return lines.join("\n");
}

/** Рядок після активації плану з іншим числом днів: дні нагадувань скинуто. */
export const settingsDaysReset = (n: number, days: readonly number[]): string =>
  `📅 Дні нагадувань скинув під ${n} трен. на тиждень: ${days.map((d) => WEEKDAYS_UK[d - 1]).join(", ")}. Змінити — /nalashtuvannia`;

// --- Фаза 3: норма КБЖУ, питання про прогалини профілю, /yizha (docs/spec/phase-3.md, розділ 3) ---

export type FoodAskField = "goal" | "sex" | "birth_year" | "height_cm" | "activity" | "weight";

/** Заголовок питання — перший рядок повідомлення; за ним впізнається reply (стан не потрібен). */
export const FOOD_ASK_HEAD: Record<FoodAskField, string> = {
  goal: "🎯 Для норми калорій потрібна ціль",
  sex: "👤 Для норми калорій потрібна стать",
  birth_year: "🎂 Для норми калорій потрібен рік народження",
  height_cm: "📏 Для норми калорій потрібен зріст",
  activity: "🚶 Для норми калорій потрібна активність поза залом",
  weight: "⚖️ Для норми калорій потрібна вага",
};
export const FOOD_ASK_EXAMPLE = { birth_year: "1995", height_cm: "178", weight: "80,5" } as const;
export const FOOD_ASK_BAD = {
  birth_year: "❌ Рік народження — чотири цифри, від 1930 до 2020 (вік 14–80). Спробуй ще раз у reply на питання.",
  height_cm: "❌ Зріст — число від 120 до 230 см. Спробуй ще раз у reply на питання.",
  weight: "❌ Вага — число від 30 до 300 кг. Спробуй ще раз у reply на питання.",
} as const;
export const FOOD_ASK_STALE = "Це вже заповнено — зміни профіль через /profil.";
export const FOOD_ASK_SAVED = "✅ Записав";

/** Текст питання: для числових полів — прохання відповісти reply; для кнопкових кнопки йдуть окремо (f:go|sx|ac). */
export function foodAskText(field: FoodAskField): string {
  if (field === "birth_year" || field === "height_cm" || field === "weight") {
    return `${FOOD_ASK_HEAD[field]}\nНапиши відповіддю (reply) на це повідомлення число, наприклад <code>${FOOD_ASK_EXAMPLE[field]}</code>.`;
  }
  return FOOD_ASK_HEAD[field];
}

/** Поле питання за заголовком повідомлення, на яке відповіли (лише числові поля); інакше null. */
export function foodAskFieldOf(repliedText: string | undefined): "birth_year" | "height_cm" | "weight" | null {
  const first = (repliedText ?? "").split("\n", 1)[0];
  for (const f of ["birth_year", "height_cm", "weight"] as const) if (first === FOOD_ASK_HEAD[f]) return f;
  return null;
}

export const FOOD_PROFILE_CHECK = "⚠️ Перевір профіль: норма виходить за межі 800–6000 ккал. Зміни дані через /profil.";
export const FOOD_NOTHING_YET = "Сьогодні ще нічого не підтверджено.";

export interface YizhaView {
  /** Сума підтверджених за день: ккал, макроси — десяті грама. */
  total: { kcal: number; proteinDg: number; fatDg: number; carbsDg: number };
  norm: { kcal: number; proteinG: number; fatG: number; carbsG: number; validFrom: string } | null;
  /** Підтверджені прийоми: час «HH:MM» за tz користувача, позиції, ккал. */
  meals: { time: string; items: { nameUk: string; grams: number }[]; kcal: number }[];
  pending: number;
  profileCheck: boolean;
}

const YIZHA_MEALS_MAX = 12;
const gram = (dg: number): number => Math.round(dg / 10);

/** Підсумок дня проти норми, чинної на цю дату. Текст ≤ 4096 (clip). */
export function yizhaText(v: YizhaView): string {
  const lines: string[] = ["🍽 <b>Їжа за сьогодні</b>"];
  const { total, norm } = v;
  if (norm) {
    const pct = Math.round((total.kcal * 100) / norm.kcal);
    lines.push(`З'їдено <b>${fmtInt(total.kcal)} / ${fmtInt(norm.kcal)}</b> ккал (${pct} %)`);
    lines.push(`Б ${gram(total.proteinDg)} / ${norm.proteinG} г · Ж ${gram(total.fatDg)} / ${norm.fatG} г · В ${gram(total.carbsDg)} / ${norm.carbsG} г`);
    if (total.kcal > norm.kcal) lines.push(`⚠️ +${fmtInt(total.kcal - norm.kcal)} ккал понад норму`);
    lines.push(`<i>норма від ${norm.validFrom.slice(8)}.${norm.validFrom.slice(5, 7)}</i>`);
  } else {
    lines.push(`З'їдено <b>${fmtInt(total.kcal)}</b> ккал`);
    lines.push(`Б ${gram(total.proteinDg)} г · Ж ${gram(total.fatDg)} г · В ${gram(total.carbsDg)} г`);
    if (v.profileCheck) lines.push("", FOOD_PROFILE_CHECK);
  }
  if (v.meals.length === 0) {
    lines.push("", FOOD_NOTHING_YET);
  } else {
    lines.push("");
    for (const m of v.meals.slice(0, YIZHA_MEALS_MAX)) {
      lines.push(`• ${m.time} — ${m.items.map((i) => `${esc(i.nameUk)} ${i.grams} г`).join(", ")} · ${fmtInt(m.kcal)} ккал`);
    }
    if (v.meals.length > YIZHA_MEALS_MAX) lines.push(`…ще ${v.meals.length - YIZHA_MEALS_MAX}`);
  }
  if (v.pending > 0) lines.push("", `⏳ Не підтверджено: ${v.pending}`);
  return clip(lines.join("\n"));
}
