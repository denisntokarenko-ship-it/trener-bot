// Потік /trening (phase-1-flow.md). Стан тренування — лише в D1: позиція рахується з рядків workout_sets,
// тож перезапуск клієнта, повтор доставки й подвійне натискання нічого не гублять і не дублюють (N3).
import { GrammyError, type Context } from "grammy";
import type { Exercise, ProgramDay, Repo, Slot, Workout, WorkoutSetRow } from "../db/repo";
import { nextDayCode, type Prescription } from "../domain/progression";
import { MAX_WEIGHT_KG, parseCb, type Cb } from "./callbacks";
import { prescribeSlot } from "./prescribe";
import { buildProgress } from "../domain/records";
import { isWarmupExercise, warmupSets } from "../domain/warmup";
import { addDays, localDate } from "../domain/time";
import { PROGRESS_BACK_CB, PROGRESS_RECENT_CB, fullProgressText, programText, progressKeyboard, progressText, recentKeyboard, weightModel } from "./progress-view";
import { PROGRESS_EMPTY, recordReps, recordWeight, weightEcho } from "./texts";
import {
  ANSWER,
  NOT_UNDERSTOOD,
  NO_PROGRAM,
  RATING_TEXT,
  badWeight,
  dayLabel,
  dayName,
  ratingKeyboard,
  screenKeyboard,
  screenText,
  summaryText,
  swapMenu,
  warmupScreen,
  weightPrompt,
  type ScreenModel,
  type SummaryModel,
} from "./workout-view";
import type { InlineKeyboard } from "grammy";

interface Rendered {
  text: string;
  /** Без клавіатури — Telegram прибирає її при редагуванні тексту. */
  keyboard?: InlineKeyboard;
}

type Memo = Map<string, Promise<Prescription>>;

interface ScreenOpts {
  memo?: Memo;
  /** Вправа-заміна, якщо в слоті ще немає підходів. */
  exercise?: Exercise;
  /** Вага в десятих кг з кнопки. */
  g?: number;
  r?: number;
  cues?: boolean;
}

interface Resolved {
  slot: Slot;
  rows: WorkoutSetRow[];
  exercise: Exercise;
}

interface AwaitState {
  p: number;
  e: number;
  n: number;
  r: number;
  /** message_id екрана, що став підказкою. */
  m: number;
}

/** Поточна позиція з БД: перший слот, де рядків менше за sets (phase-1-flow.md, «Поточна позиція»). */
function position(day: ProgramDay, sets: readonly WorkoutSetRow[]): { index: number; slot: Slot; rows: WorkoutSetRow[] } | null {
  for (const [index, slot] of day.slots.entries()) {
    const rows = sets.filter((s) => s.programExerciseId === slot.id);
    if (rows.length < slot.sets) return { index, slot, rows };
  }
  return null;
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes("message is not modified");
}

function parseAwait(raw: string | null): AwaitState | null {
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as Partial<AwaitState>;
    const ok = [a.p, a.e, a.n, a.r, a.m].every((v) => typeof v === "number" && Number.isSafeInteger(v));
    return ok ? (a as AwaitState) : null;
  } catch {
    return null;
  }
}

export function createWorkoutFlow(repo: Repo, now: () => number) {
  /** memo — на один апдейт: призначення вправи в межах натискання рахується один раз (рев'ю Фази 1, В2). */
  const prescribe = (userId: number, exercise: Exercise, slot: Slot, memo?: Memo): Promise<Prescription> => {
    const key = `${exercise.id}:${slot.id}`;
    const hit = memo?.get(key);
    if (hit) return hit;
    const p = prescribeSlot(repo, userId, exercise, slot);
    memo?.set(key, p);
    return p;
  };

  /** Заміни, доступні слоту: каталог мінус вправи дня мінус уже виконані в тренуванні. */
  async function available(day: ProgramDay, sets: readonly WorkoutSetRow[], slot: Slot): Promise<Exercise[]> {
    const used = new Set([...day.slots.map((s) => s.exercise.id), ...sets.map((s) => s.exerciseId)]);
    return (await repo.getSubstitutes(slot.exercise.id)).filter((x) => !used.has(x.id));
  }

  /** Перевірка p/e з кнопки за таблицею «Перевірка кнопки»; null — «Кнопка застаріла». */
  async function resolve(day: ProgramDay, sets: readonly WorkoutSetRow[], p: number, e: number): Promise<Resolved | null> {
    const slot = day.slots.find((s) => s.id === p);
    if (!slot) return null;
    const rows = sets.filter((s) => s.programExerciseId === slot.id);
    const first = rows[0];
    if (first) {
      if (e !== first.exerciseId) return null; // заміну закріплено першим записаним підходом
      const exercise = first.exerciseId === slot.exercise.id ? slot.exercise : await repo.getExercise(first.exerciseId);
      return exercise ? { slot, rows, exercise } : null;
    }
    if (e === slot.exercise.id) return { slot, rows, exercise: slot.exercise };
    const sub = (await available(day, sets, slot)).find((x) => x.id === e);
    return sub ? { slot, rows, exercise: sub } : null;
  }

  async function model(userId: number, w: Workout, day: ProgramDay, sets: readonly WorkoutSetRow[], o: ScreenOpts): Promise<ScreenModel | null> {
    const pos = position(day, sets);
    if (!pos) return null;
    const { slot, rows, index } = pos;
    const first = rows[0];
    const exercise = first
      ? first.exerciseId === slot.exercise.id
        ? slot.exercise
        : ((await repo.getExercise(first.exerciseId)) ?? slot.exercise)
      : (o.exercise ?? slot.exercise);
    const pres = await prescribe(userId, exercise, slot, o.memo);
    const lastWorked = rows.filter((r) => !r.skipped).at(-1);
    const weightKg = o.g !== undefined ? o.g / 10 : (lastWorked?.weightKg ?? pres.weightKg);
    // Розминкові підходи — підказка до першого підходу слота, лише база з вагою; нічого не пишемо. Калібрування без
    // стартової ваги показує мінімум, а він ≥ будь-якого розминкового підходу (warmupSets → порожньо) — рядка немає само.
    const warmup =
      rows.length === 0 && isWarmupExercise(exercise)
        ? warmupSets({ workingKg: weightKg, stepKg: exercise.weightStepKg, minKg: exercise.minWeightKg })
        : [];
    return {
      workoutId: w.id,
      dayName: dayName(day),
      slotIndex: index,
      slotCount: day.slots.length,
      programExerciseId: slot.id,
      sets: slot.sets,
      exercise,
      setNo: rows.length + 1,
      weightKg,
      reps: o.r ?? pres.targetReps,
      calibration: pres.reason === "calibration",
      done: [...rows].sort((a, b) => a.setNo - b.setNo),
      canSwap: rows.length === 0 && (await available(day, sets, slot)).length > 0,
      showCues: o.cues ?? false,
      warmup,
    };
  }

  async function screen(userId: number, w: Workout, day: ProgramDay, sets: readonly WorkoutSetRow[], o: ScreenOpts = {}): Promise<Rendered> {
    const m = await model(userId, w, day, sets, o);
    if (!m) return { text: RATING_TEXT, keyboard: ratingKeyboard(w.id) };
    return { text: screenText(m), keyboard: screenKeyboard(m) };
  }

  async function edit(ctx: Context, r: Rendered): Promise<void> {
    try {
      await ctx.editMessageText(r.text, { reply_markup: r.keyboard });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }

  async function dropKeyboard(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }

  async function summary(userId: number, w: Workout, day: ProgramDay, sets: readonly WorkoutSetRow[]): Promise<string> {
    const worked = sets.filter((s) => !s.skipped);
    const program = await repo.getActiveProgram(userId);
    const records: string[] = [];
    const seen = new Set<number>();
    // Рекорд — по всій історії без вікна, тим самим агрегатом, що /progres і недільний звіт (спека §3; R-2 В2).
    // Попередні підходи — без цього тренування; немає жодного → перша сесія вправи (калібрування), рекорду немає.
    const history = (await repo.getProgressSets(userId)).filter((x) => x.workoutId !== w.id);
    for (const s of worked) {
      if (seen.has(s.exerciseId)) continue;
      seen.add(s.exerciseId);
      const exercise = day.slots.find((x) => x.exercise.id === s.exerciseId)?.exercise ?? (await repo.getExercise(s.exerciseId));
      if (!exercise) continue;
      const prev = history.filter((x) => x.exerciseId === exercise.id);
      if (prev.length === 0) continue;
      const mine = worked.filter((x) => x.exerciseId === exercise.id && (x.reps ?? 0) >= 1);
      if (mine.length === 0) continue;
      if (exercise.equipment === "bodyweight") {
        const cur = Math.max(...mine.map((x) => x.reps ?? 0));
        if (cur > Math.max(-1, ...prev.map((x) => x.reps ?? 0))) records.push(recordReps(exercise.nameUk, cur));
      } else {
        const cur = Math.max(...mine.map((x) => x.weightKg ?? 0));
        if (cur > Math.max(-1, ...prev.map((x) => x.weightKg ?? 0))) {
          const reps = Math.max(...mine.filter((x) => x.weightKg === cur).map((x) => x.reps ?? 0));
          records.push(recordWeight(exercise.nameUk, cur, reps));
        }
      }
    }
    const nextCode = program && program.days.length > 0 ? nextDayCode({ dayCode: w.dayCode }, program.days) : w.dayCode;
    const nextDay = program?.days.some((d) => d.code === nextCode) ? await repo.getProgramDay(userId, nextCode) : null;
    const model: SummaryModel = {
      dayName: dayName(day),
      minutes: Math.floor(((w.finishedAt ?? now()) - w.startedAt) / 60000),
      setsTotal: day.slots.reduce((a, s) => a + s.sets, 0),
      setsDone: worked.length,
      setsSkipped: sets.length - worked.length,
      volumeKg: worked.reduce((a, s) => a + (s.weightKg ?? 0) * (s.reps ?? 0), 0),
      effort: w.effort ?? 0,
      records,
      nextDayName: nextDay ? dayLabel(nextDay) : dayLabel(day),
    };
    return summaryText(model);
  }

  /** Екран /progres: вага, агрегат за вправами за всю історію й (кнопкою) останні 5 тренувань. */
  async function progressScreen(userId: number): Promise<Rendered> {
    const tz = (await repo.getUserTz(userId)) ?? "Europe/Kyiv";
    const today = localDate(now(), tz);
    const [sets, recent, first, last, profile] = await Promise.all([
      repo.getProgressSets(userId),
      repo.getWeights(userId, addDays(today, -20), today),
      repo.getFirstWeight(userId),
      repo.getLastWeight(userId),
      repo.getProfile(userId),
    ]);
    const exercises = buildProgress(sets);
    const weight = weightModel({ profileKg: profile?.weightKg ?? null, recent, first, last, today });
    const text = fullProgressText(exercises, weight, tz);
    // Порожній екран («Ще немає даних») — без кнопки.
    return { text, keyboard: text !== PROGRESS_EMPTY ? progressKeyboard() : undefined };
  }

  /** [📜 Останні тренування] ↔ [⬅️ Назад]: редагують те саме повідомлення. */
  async function progressNav(ctx: Context, data: string): Promise<void> {
    const userId = ctx.from!.id;
    if (data === PROGRESS_RECENT_CB) {
      const [workouts, tz] = await Promise.all([repo.getRecentWorkouts(userId, 5), repo.getUserTz(userId)]);
      await edit(ctx, { text: progressText(workouts, tz ?? "Europe/Kyiv"), keyboard: recentKeyboard() });
    } else {
      await edit(ctx, await progressScreen(userId));
    }
  }

  async function dispatch(ctx: Context): Promise<string | undefined> {
    const userId = ctx.from!.id;
    const cb = parseCb(ctx.callbackQuery?.data ?? "");
    if (!cb) return ANSWER.stale;
    const workout = await repo.getWorkout(userId, cb.w);
    if (!workout) {
      await dropKeyboard(ctx);
      return ANSWER.finished;
    }
    const day = await repo.getProgramDay(userId, workout.dayCode);
    if (!day) {
      await dropKeyboard(ctx);
      return ANSWER.finished;
    }
    const sets = await repo.getWorkoutSets(userId, workout.id);

    if (workout.status !== "active") {
      if (cb.a === "f" && workout.status === "done") {
        await edit(ctx, { text: await summary(userId, workout, day, sets) });
        return ANSWER.ratedAlready;
      }
      await dropKeyboard(ctx);
      return ANSWER.finished;
    }

    /** Показати поточний екран замість застарілого й відповісти text. */
    const memo: Memo = new Map();
    const current = async (text: string): Promise<string> => {
      await edit(ctx, await screen(userId, workout, day, sets, { memo }));
      return text;
    };

    switch (cb.a) {
      case "s":
        return recordSet(ctx, userId, cb, workout, day, sets, current, memo);
      case "k":
        return skip(ctx, userId, cb, workout, day, sets, current, memo);
      case "v": {
        const v = await resolve(day, sets, cb.p, cb.e);
        if (!v || v.exercise.equipment === "bodyweight") return current(ANSWER.stale);
        if (cb.n !== v.rows.length + 1) return current(ANSWER.staleShowCurrent);
        const messageId = ctx.callbackQuery?.message?.message_id ?? 0;
        const state: AwaitState = { p: cb.p, e: cb.e, n: cb.n, r: cb.r, m: messageId };
        await repo.setAwaitInput(userId, workout.id, JSON.stringify(state));
        const prompt = weightPrompt(v.exercise, workout.id);
        await edit(ctx, prompt);
        return undefined;
      }
      case "c":
        await repo.setAwaitInput(userId, workout.id, null);
        await edit(ctx, await screen(userId, workout, day, sets));
        return undefined;
      case "x": {
        const v = await resolve(day, sets, cb.p, cb.e);
        if (!v || v.rows.length > 0) return current(ANSWER.stale);
        const m = await model(userId, workout, day, sets, { exercise: v.exercise, g: cb.g, r: cb.r });
        if (!m) return current(ANSWER.stale);
        await edit(ctx, swapMenu(m, await available(day, sets, v.slot)));
        return undefined;
      }
      case "y": {
        const v = await resolve(day, sets, cb.p, cb.e);
        if (!v || v.rows.length > 0 || v.exercise.id === v.slot.exercise.id) return current(ANSWER.stale);
        await edit(ctx, await screen(userId, workout, day, sets, { exercise: v.exercise }));
        return undefined;
      }
      case "a":
      case "t": {
        const v = await resolve(day, sets, cb.p, cb.e);
        if (!v) return current(ANSWER.stale);
        if (cb.n !== v.rows.length + 1) return current(ANSWER.staleShowCurrent);
        await edit(ctx, await screen(userId, workout, day, sets, { exercise: v.exercise, g: cb.g, r: cb.r, cues: cb.a === "t" && cb.t === 1 }));
        return undefined;
      }
      case "u":
        // Розминка нічого не пише: перемальовуємо поточну позицію, тож повтор і стара кнопка безпечні.
        await edit(ctx, await screen(userId, workout, day, sets, { memo }));
        return undefined;
      case "f": {
        if (position(day, sets)) return current(ANSWER.stale);
        if (!(await repo.finishWorkout(userId, workout.id, cb.q, now()))) return ANSWER.ratedAlready;
        const done = (await repo.getWorkout(userId, workout.id)) ?? workout;
        await edit(ctx, { text: await summary(userId, done, day, sets) });
        return undefined;
      }
    }
  }

  async function recordSet(
    ctx: Context,
    userId: number,
    cb: Cb,
    workout: Workout,
    day: ProgramDay,
    sets: readonly WorkoutSetRow[],
    current: (text: string) => Promise<string>,
    memo: Memo,
  ): Promise<string | undefined> {
    const v = await resolve(day, sets, cb.p, cb.e);
    if (!v) return current(ANSWER.stale);
    const { slot, rows, exercise } = v;
    // set_no — з кнопки, а не з лічильника в БД: повторне натискання влучає в той самий рядок.
    const setNo = cb.n;
    const existing = sets.find((x) => x.exerciseId === cb.e && x.setNo === setNo);
    if (existing) {
      const same = !existing.skipped && existing.reps === cb.r && Math.round((existing.weightKg ?? -1) * 10) === cb.g;
      return current(same ? ANSWER.recorded : ANSWER.staleShowCurrent);
    }
    if (setNo !== rows.length + 1 || setNo > slot.sets) return current(ANSWER.staleShowCurrent);
    const pres = await prescribe(userId, exercise, slot, memo);
    const row: WorkoutSetRow = {
      programExerciseId: slot.id,
      exerciseId: exercise.id,
      setNo,
      weightKg: cb.g / 10,
      reps: cb.r,
      skipped: false,
      prescribedWeightKg: pres.weightKg,
      prescribedReps: pres.targetReps,
    };
    const ok = await repo.upsertSet(userId, { workoutId: workout.id, ...toInput(row) });
    if (!ok) return current(ANSWER.stale);
    await edit(ctx, await screen(userId, workout, day, [...sets, row], { memo }));
    return undefined;
  }

  async function skip(
    ctx: Context,
    userId: number,
    cb: Cb,
    workout: Workout,
    day: ProgramDay,
    sets: readonly WorkoutSetRow[],
    current: (text: string) => Promise<string>,
    memo: Memo,
  ): Promise<string | undefined> {
    const v = await resolve(day, sets, cb.p, cb.e);
    if (!v) return current(ANSWER.stale);
    const { slot, rows, exercise } = v;
    if (cb.n === rows.length + 1 && cb.n <= slot.sets) {
      const pres = await prescribe(userId, exercise, slot, memo);
      const added: WorkoutSetRow[] = [];
      for (let n = cb.n; n <= slot.sets; n++) {
        const row: WorkoutSetRow = {
          programExerciseId: slot.id,
          exerciseId: exercise.id,
          setNo: n,
          weightKg: null,
          reps: null,
          skipped: true,
          prescribedWeightKg: pres.weightKg,
          prescribedReps: pres.targetReps,
        };
        if (!(await repo.upsertSet(userId, { workoutId: workout.id, ...toInput(row) }))) return current(ANSWER.stale);
        added.push(row);
      }
      await edit(ctx, await screen(userId, workout, day, [...sets, ...added], { memo }));
      return undefined;
    }
    // Повтор: підходи cb.n…sets уже пропущено — нічого не пишемо.
    const tail = rows.filter((r) => r.setNo >= cb.n);
    const repeated = cb.n <= slot.sets && tail.length === slot.sets - cb.n + 1 && tail.every((r) => r.skipped);
    return current(repeated ? ANSWER.recorded : ANSWER.staleShowCurrent);
  }

  return {
    /** /prohrama: обидва дні, наступний день із призначеннями й, якщо є, поточне тренування. */
    async prohrama(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      await repo.abandonStale(userId, now());
      const program = await repo.getActiveProgram(userId);
      if (!program || program.days.length === 0) {
        await ctx.reply(NO_PROGRAM);
        return;
      }
      const days: ProgramDay[] = [];
      for (const d of program.days) {
        const day = await repo.getProgramDay(userId, d.code);
        if (day) days.push(day);
      }
      const nextCode = nextDayCode(await repo.getLastDoneWorkout(userId), program.days);
      const nextDay = days.find((d) => d.code === nextCode);
      if (!nextDay) {
        await ctx.reply(NO_PROGRAM);
        return;
      }
      const lines = [];
      for (const slot of nextDay.slots) {
        const p = await prescribe(userId, slot.exercise, slot);
        lines.push({ nameUk: slot.exercise.nameUk, bodyweight: slot.exercise.equipment === "bodyweight", weightKg: p.weightKg, targetReps: p.targetReps });
      }
      const active = await repo.getActiveWorkout(userId);
      const activeDay = active ? days.find((d) => d.code === active.dayCode) : undefined;
      await ctx.reply(programText({ name: program.name, days, next: { dayName: dayLabel(nextDay), lines }, activeDayName: activeDay ? dayName(activeDay) : null }));
    },

    /** /progres: вага тіла + вправи (старт → зараз, рекорд, e1RM); історія тренувань — кнопкою. */
    async progres(ctx: Context): Promise<void> {
      const { text, keyboard } = await progressScreen(ctx.from!.id);
      await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
    },

    /** /trening: старт наступного дня або продовження active — завжди новим повідомленням-екраном. */
    async trening(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      await repo.abandonStale(userId, now());
      let workout = await repo.getActiveWorkout(userId);
      let fresh = false;
      if (!workout) {
        const program = await repo.getActiveProgram(userId);
        if (!program || program.days.length === 0) {
          await ctx.reply(NO_PROGRAM);
          return;
        }
        const code = nextDayCode(await repo.getLastDoneWorkout(userId), program.days);
        const next = await repo.getProgramDay(userId, code);
        // Конфлікт workouts_one_active повертає наявне тренування — продовження.
        const started = next ? await repo.startWorkout(userId, next.id, now()) : null;
        if (!started) {
          await ctx.reply(NO_PROGRAM);
          return;
        }
        workout = started.workout;
        // Розминка — лише для щойно створеного тренування; конфлікт workouts_one_active — продовження.
        fresh = started.created;
      }
      if (workout.awaitInput) await repo.setAwaitInput(userId, workout.id, null);
      const day = await repo.getProgramDay(userId, workout.dayCode);
      if (!day) {
        await ctx.reply(NO_PROGRAM);
        return;
      }
      if (fresh) {
        const home = (await repo.getProfile(userId))?.place === "home";
        const w = warmupScreen(dayName(day), home, workout.id);
        await ctx.reply(w.text, { reply_markup: w.keyboard });
        return;
      }
      const r = await screen(userId, workout, day, await repo.getWorkoutSets(userId, workout.id));
      await ctx.reply(r.text, { reply_markup: r.keyboard });
    },

    /** Кожне натискання: рівно один answerCallbackQuery (P1.5.6), навіть коли обробка впала. */
    async callback(ctx: Context): Promise<void> {
      let text: string | undefined;
      try {
        const data = ctx.callbackQuery?.data ?? "";
        if (data === PROGRESS_RECENT_CB || data === PROGRESS_BACK_CB) await progressNav(ctx, data);
        else text = await dispatch(ctx);
      } finally {
        await ctx.answerCallbackQuery(text ? { text } : undefined);
      }
    },

    /** Чи тренування чекає вагу тексту: тоді текст належить підходу, не анкеті. */
    async awaitsWeight(ctx: Context): Promise<boolean> {
      const workout = await repo.getActiveWorkout(ctx.from!.id);
      return parseAwait(workout?.awaitInput ?? null) !== null;
    },

    /** Будь-яка команда при очікуванні ваги знімає його (і виконується далі). */
    async clearAwait(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      const w = await repo.getActiveWorkout(userId);
      if (w?.awaitInput) await repo.setAwaitInput(userId, w.id, null);
    },

    /** Не-команда: вага, якщо чекаємо її; інакше підказка про команди (+ `hint`: «вагу тіла записують так…»). */
    async text(ctx: Context, hint?: string | null): Promise<void> {
      const userId = ctx.from!.id;
      const workout = await repo.getActiveWorkout(userId);
      const state = parseAwait(workout?.awaitInput ?? null);
      if (!workout || !state) {
        if (workout?.awaitInput) await repo.setAwaitInput(userId, workout.id, null);
        await ctx.reply(hint ? `${NOT_UNDERSTOOD}\n${hint}` : NOT_UNDERSTOOD);
        return;
      }
      const day = await repo.getProgramDay(userId, workout.dayCode);
      const sets = await repo.getWorkoutSets(userId, workout.id);
      const v = day ? await resolve(day, sets, state.p, state.e) : null;
      if (!day || !v) {
        await repo.setAwaitInput(userId, workout.id, null);
        await ctx.reply(hint ? `${NOT_UNDERSTOOD}\n${hint}` : NOT_UNDERSTOOD);
        return;
      }
      const raw = (ctx.message?.text ?? "").trim();
      const grams = /^\d{1,3}([.,]\d{1,2})?$/.test(raw) ? Math.round(Number(raw.replace(",", ".")) * 1000) : NaN;
      const { minWeightKg, weightStepKg } = v.exercise;
      const valid =
        Number.isFinite(grams) &&
        weightStepKg > 0 &&
        grams >= Math.round(minWeightKg * 1000) &&
        grams <= MAX_WEIGHT_KG * 1000 &&
        grams % Math.round(weightStepKg * 1000) === 0;
      if (!valid) {
        await ctx.reply(badWeight(v.exercise));
        return;
      }
      await repo.setAwaitInput(userId, workout.id, null);
      const kg = grams / 1000;
      try {
        await ctx.api.editMessageText(ctx.chat!.id, state.m, weightEcho(kg));
      } catch (err) {
        if (!isNotModified(err)) throw err;
      }
      const r = await screen(userId, workout, day, sets, { exercise: v.exercise, g: Math.round(kg * 10), r: state.r });
      await ctx.reply(r.text, { reply_markup: r.keyboard });
    },
  };
}

function toInput(row: WorkoutSetRow) {
  return {
    programExerciseId: row.programExerciseId,
    exerciseId: row.exerciseId,
    setNo: row.setNo,
    weightKg: row.weightKg,
    reps: row.reps,
    prescribedWeightKg: row.prescribedWeightKg,
    prescribedReps: row.prescribedReps,
    skipped: row.skipped,
  };
}
