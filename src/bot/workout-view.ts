// Клавіатури потоку /trening й моделі екранів — чисті функції (phase-1-flow.md). Усі тексти — у texts.ts.
import { InlineKeyboard } from "grammy";
import type { Exercise } from "../db/repo";
import { isVideoUrl } from "../domain/video";
import { MAX_REPS, encodeCb } from "./callbacks";
import { BTN, ANSWER, NOT_UNDERSTOOD, NO_PROGRAM, RATING_TEXT, screenText as renderScreen, summaryText, swapTitle, warmupText, weightPromptText, badWeightText } from "./texts";

// Повторний експорт: решта коду й тести імпортують ці імена звідси.
export { ANSWER, NOT_UNDERSTOOD, NO_PROGRAM, RATING_TEXT, summaryText };
export { TELEGRAM_TEXT_MAX, clip, dayHint, dayLabel, dayName, fmtInt, fmtKg } from "./texts";
export type { SummaryTextModel as SummaryModel } from "./texts";

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
  warmup?: ReadonlyArray<{ weightKg: number; reps: number }>;
}

const isBodyweight = (e: Exercise): boolean => e.equipment === "bodyweight";

export const screenText = (m: ScreenModel): string => renderScreen(m);

export function screenKeyboard(m: ScreenModel): InlineKeyboard {
  const base = { w: m.workoutId, p: m.programExerciseId, e: m.exercise.id, n: m.setNo, g: Math.round(m.weightKg * 10) };
  const kb = new InlineKeyboard().text(`✅ ${m.reps}`, encodeCb("s", { ...base, r: m.reps }));
  if (m.reps > 0) kb.text("−1", encodeCb("a", { ...base, r: m.reps - 1 }));
  if (m.reps < MAX_REPS) kb.text("+1", encodeCb("a", { ...base, r: m.reps + 1 }));
  kb.row();
  if (!isBodyweight(m.exercise)) kb.text(BTN.weight, encodeCb("v", { ...base, r: m.reps }));
  if (m.canSwap) kb.text(BTN.swap, encodeCb("x", { ...base, r: m.reps }));
  kb.text(BTN.skipSet, encodeCb("k", base));
  kb.row().text(BTN.cues, encodeCb("t", { ...base, r: m.reps, t: 1 }));
  // URL-кнопка без callback_data; окремим рядком. Невалідне чи відсутнє посилання — кнопки немає.
  if (isVideoUrl(m.exercise.videoUrl)) kb.row().url(BTN.video, m.exercise.videoUrl);
  return kb;
}

export function swapMenu(m: ScreenModel, subs: readonly Exercise[]): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const s of subs) kb.text(s.nameUk, encodeCb("y", { w: m.workoutId, p: m.programExerciseId, e: s.id })).row();
  const base = { w: m.workoutId, p: m.programExerciseId, e: m.exercise.id, n: m.setNo, r: m.reps, g: Math.round(m.weightKg * 10) };
  kb.text(BTN.backToSet, encodeCb("a", base));
  return { text: swapTitle(m.exercise.nameUk), keyboard: kb };
}

export function ratingKeyboard(workoutId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let q = 1; q <= 5; q++) kb.text(String(q), encodeCb("f", { w: workoutId, q }));
  return kb;
}

export function weightPrompt(e: Exercise, workoutId: number): { text: string; keyboard: InlineKeyboard } {
  return { text: weightPromptText(e), keyboard: new InlineKeyboard().text(BTN.cancel, encodeCb("c", { w: workoutId })) };
}

/** Екран розминки перед першою вправою нового тренування: обидві кнопки однаково ведуть до вправи. */
export function warmupScreen(dayName: string, home: boolean, workoutId: number): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard().text(BTN.warmupDone, encodeCb("u", { w: workoutId, t: 1 })).text(BTN.skip, encodeCb("u", { w: workoutId, t: 0 }));
  return { text: warmupText(dayName, home), keyboard };
}

export const badWeight = (e: Exercise): string => badWeightText(e);
