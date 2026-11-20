// Тексти й клавіатури потоку /trening — чисті функції (phase-1-flow.md, «Екран вправи», «Оцінка й підсумок»).
import { InlineKeyboard } from "grammy";
import type { Exercise } from "../db/repo";
import { MAX_REPS, encodeCb } from "./callbacks";
import { MUSCLE_UK } from "./texts";

/** N6: ліміт тексту повідомлення Telegram. */
export const TELEGRAM_TEXT_MAX = 4096;

export const clip = (text: string): string => (text.length <= TELEGRAM_TEXT_MAX ? text : text.slice(0, TELEGRAM_TEXT_MAX - 1) + "…");

/** 42.5 → «42,5». */
export const fmtKg = (kg: number): string => String(kg).replace(".", ",");

/** 6240 → «6 240». */
export const fmtInt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export interface ScreenSet {
  setNo: number;
  weightKg: number | null;
  reps: number | null;
  skipped: boolean;
}

export interface ScreenModel {
  workoutId: number;
  /** Назва дня для показу (`dayName`), не код. */
  dayName: string;
  slotIndex: number;
  slotCount: number;
  programExerciseId: number;
  sets: number;
  exercise: Exercise;
  setNo: number;
  weightKg: number;
  reps: number;
  calibration: boolean;
  done: ScreenSet[];
  canSwap: boolean;
  showCues: boolean;
}

/** Назва дня для показу: `title`, інакше «День <code>». Код у callback_data лишається, назва туди не йде. */
export function dayName(d: { code: string; title: string | null }): string {
  return d.title && d.title.trim() !== "" ? d.title : `День ${d.code}`;
}

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

const isBodyweight = (e: Exercise): boolean => e.equipment === "bodyweight";

export function screenText(m: ScreenModel): string {
  const load = isBodyweight(m.exercise) ? "власна вага" : `${fmtKg(m.weightKg)} кг`;
  const lines = [
    `${m.dayName} · вправа ${m.slotIndex + 1}/${m.slotCount}`,
    m.exercise.nameUk,
    `${load} × ${m.reps} · підхід ${m.setNo}/${m.sets}`,
  ];
  if (m.calibration && m.setNo === 1 && !isBodyweight(m.exercise)) {
    lines.push("Калібрування: підбери робочу вагу кнопкою ⚖️");
  }
  for (const s of m.done) {
    lines.push(s.skipped ? `✔ ${s.setNo}: пропущено` : `✔ ${s.setNo}: ${fmtKg(s.weightKg ?? 0)} × ${s.reps}`);
  }
  if (m.showCues) lines.push("", "💡 Техніка:", ...m.exercise.cues);
  return clip(lines.join("\n"));
}

export function screenKeyboard(m: ScreenModel): InlineKeyboard {
  const base = { w: m.workoutId, p: m.programExerciseId, e: m.exercise.id, n: m.setNo, g: Math.round(m.weightKg * 10) };
  const kb = new InlineKeyboard().text(`✅ ${m.reps}`, encodeCb("s", { ...base, r: m.reps }));
  if (m.reps > 0) kb.text("−1", encodeCb("a", { ...base, r: m.reps - 1 }));
  if (m.reps < MAX_REPS) kb.text("+1", encodeCb("a", { ...base, r: m.reps + 1 }));
  kb.row();
  if (!isBodyweight(m.exercise)) kb.text("⚖️ Вага", encodeCb("v", { ...base, r: m.reps }));
  if (m.canSwap) kb.text("🔁 Замінити", encodeCb("x", { ...base, r: m.reps }));
  kb.text("⏭ Пропустити", encodeCb("k", base));
  kb.row().text("💡 Техніка", encodeCb("t", { ...base, r: m.reps, t: 1 }));
  return kb;
}

export function swapMenu(m: ScreenModel, subs: readonly Exercise[]): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const s of subs) kb.text(s.nameUk, encodeCb("y", { w: m.workoutId, p: m.programExerciseId, e: s.id })).row();
  const base = { w: m.workoutId, p: m.programExerciseId, e: m.exercise.id, n: m.setNo, r: m.reps, g: Math.round(m.weightKg * 10) };
  kb.text("↩️ Назад", encodeCb("a", base));
  return { text: `Чим замінити «${m.exercise.nameUk}»?`, keyboard: kb };
}

export const RATING_TEXT = "Готово! Як тяжко було? 1 — легко, 5 — на межі.";

export function ratingKeyboard(workoutId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let q = 1; q <= 5; q++) kb.text(String(q), encodeCb("f", { w: workoutId, q }));
  return kb;
}

export function weightPrompt(e: Exercise, workoutId: number): { text: string; keyboard: InlineKeyboard } {
  const example = fmtKg(e.minWeightKg + e.weightStepKg * 5);
  return {
    text: `Надішли вагу для «${e.nameUk}», кг. Крок ${fmtKg(e.weightStepKg)} кг, від ${fmtKg(e.minWeightKg)} кг. Наприклад: ${example}`,
    keyboard: new InlineKeyboard().text("↩️ Скасувати", encodeCb("c", { w: workoutId })),
  };
}

export function badWeight(e: Exercise): string {
  return `Не схоже на вагу. Крок ${fmtKg(e.weightStepKg)} кг, від ${fmtKg(e.minWeightKg)} кг — наприклад ${fmtKg(e.minWeightKg + e.weightStepKg * 5)}.`;
}

export interface SummaryModel {
  dayName: string;
  minutes: number;
  setsTotal: number;
  setsDone: number;
  setsSkipped: number;
  volumeKg: number;
  effort: number;
  /** Рекорди: «Назва — 60 кг × 8» (для ваги тіла — «12 повт.»). */
  records: string[];
  nextDayName: string;
}

export function summaryText(m: SummaryModel): string {
  const lines = [
    `🏁 ${m.dayName} · ${m.minutes} хв`,
    m.setsSkipped > 0 ? `Підходів: ${m.setsDone} з ${m.setsTotal} (пропущено ${m.setsSkipped})` : `Підходів: ${m.setsDone} з ${m.setsTotal}`,
    `Обсяг: ${fmtInt(m.volumeKg)} кг`,
    `Тяжкість: ${m.effort}/5`,
  ];
  if (m.records.length > 0) lines.push("🏆 Рекорди:", ...m.records.map((r) => `• ${r}`));
  lines.push(`Наступного разу: ${m.nextDayName}`);
  return clip(lines.join("\n"));
}

/** Відповіді answerCallbackQuery за таблицею «Перевірка кнопки» (N6: ≤ 200 символів). */
export const ANSWER = {
  stale: "Кнопка застаріла",
  staleShowCurrent: "Кнопка застаріла — показую поточний підхід",
  finished: "Тренування вже завершене. /trening — нове",
  ratedAlready: "Оцінку вже записано",
  recorded: "Записано",
} as const;

export const NO_PROGRAM = "Програму не знайдено — запусти сид (docs/RUNBOOK.md).";
export const NOT_UNDERSTOOD = "Не розумію 🙂 Команди: /trening, /progres, /prohrama.";
