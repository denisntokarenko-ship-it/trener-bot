// Потік анкети в Telegram (docs/spec/phase-1b.md, §1 і §5). Стан — лише крок у `onboarding_state`; відповіді
// пишуться в профіль одразу. План будує код (`buildPlan`) і застосовує лише після [✅ Прийняти] (`activatePlan`).
import { GrammyError, type Context } from "grammy";
import { parseLimits, type Exercise, type OnboardingRow, type ProfileRow, type Repo } from "../db/repo";
import {
  SKIP_DEFAULTS, anchorCandidates, nextStep, parseBirthYear, parseBodyWeight, parseHeight, parseLift, parseNote,
  type Step, TEXT_STEPS,
} from "../domain/onboarding";
import { DEFAULTS, buildPlan, type Level, type Place, type PlanProfile } from "../domain/plan";
import { nextDayCode } from "../domain/progression";
import {
  ENUMS, MSG, PROFILE_CODE, RESUME_CODE, LIMIT_OPTS, badLift, emptyDayScreen, enumScreen, goalNoteScreen, isEnumStep,
  liftScreen, limitsScreen, newPlanKeyboard, noteScreen, numberScreen, parseOb, planAcceptedText, planScreen, profileScreen,
  resumeScreen, welcomeScreen, type Screen,
} from "./onboarding-view";
import { SOMETHING_WRONG, esc, greeting } from "./texts";

const HTML = "HTML" as const;
const isNotModified = (e: unknown): boolean => e instanceof GrammyError && /not modified/i.test(e.description);

/** Куди йти далі: крок і підкрок (для `days`/`minutes`/`limits` sub = 1 означає «потім назад до плану»). */
interface Target {
  step: Step;
  sub: number;
}
const RETURN_TO_PLAN = 1;

export function createOnboardingFlow(repo: Repo, now: () => number) {
  // --- Допоміжне: профіль, вправи-якорі, збереження стану ---

  const planProfile = (p: ProfileRow | null): PlanProfile => ({
    goal: p?.goal ?? null,
    level: p?.level ?? null,
    daysPerWeek: p?.daysPerWeek ?? null,
    sessionMin: p?.sessionMin ?? null,
    place: p?.place ?? null,
    limits: parseLimits(p?.limits),
  });

  /** Якорі, що проходять фільтри плану й без done-історії власника (питання 7). */
  async function anchors(userId: number, p: ProfileRow | null): Promise<Exercise[]> {
    const catalog = await repo.getPlanCatalog();
    const level: Level = p?.level ?? DEFAULTS.level;
    const place: Place = p?.place ?? DEFAULTS.place;
    const ids = anchorCandidates({ level, place, limits: parseLimits(p?.limits), goal: p?.goal ?? null }, catalog);
    const found = await repo.getExercises(ids);
    const out: Exercise[] = [];
    for (const id of ids) {
      const ex = found.find((e) => e.id === id);
      if (ex && (await repo.getExerciseHistory(userId, id, 1)).length === 0) out.push(ex);
    }
    return out;
  }

  type StatePatch = Partial<Pick<OnboardingRow, "status" | "step" | "sub" | "msgId" | "planVariant">>;
  async function save(userId: number, st: OnboardingRow, patch: StatePatch): Promise<OnboardingRow> {
    await repo.upsertOnboarding(userId, patch, now());
    return { ...st, ...patch };
  }

  /** Перехід на крок: у `lifts` без доступних якорів — одразу далі; у `plan` варіант скидається. */
  async function enter(userId: number, st: OnboardingRow, to: Target): Promise<OnboardingRow> {
    let { step, sub } = to;
    if (step === "lifts") {
      const list = await anchors(userId, await repo.getProfile(userId));
      if (list.length === 0) {
        step = "sex";
        sub = 0;
      } else sub = Math.min(sub, list.length - 1);
    }
    return save(userId, st, { step, sub, ...(step === "plan" ? { planVariant: 0 } : {}) });
  }

  /** Приводить збережений стан до дійсного: без цілі далі за `goal` не пускає; зниклий якір — пропускає блок. */
  async function normalize(userId: number, st: OnboardingRow): Promise<OnboardingRow> {
    const profile = await repo.getProfile(userId);
    if (st.step !== "welcome" && st.step !== "goal" && !profile?.goal) return enter(userId, st, { step: "goal", sub: 0 });
    if (st.step === "lifts") {
      const list = await anchors(userId, profile);
      if (!list[st.sub]) return enter(userId, st, { step: "sex", sub: 0 });
    }
    return st;
  }

  // --- Показ екранів ---

  async function renderPlan(userId: number, st: OnboardingRow, profile: ProfileRow | null): Promise<Screen> {
    const catalog = await repo.getPlanCatalog();
    const res = buildPlan(planProfile(profile), catalog, st.planVariant);
    if (!res.ok) return emptyDayScreen();
    const ids = [...new Set(res.plan.days.flatMap((d) => d.slots.map((s) => s.exerciseId)))];
    const names = new Map((await repo.getExercises(ids)).map((e) => [e.id, e.nameUk]));
    const weights = await repo.getStartWeights(userId);
    const inPlan = new Set(ids);
    return planScreen({
      plan: res.plan,
      names,
      daysPerWeek: profile?.daysPerWeek ?? DEFAULTS.daysPerWeek,
      sessionMin: profile?.sessionMin ?? DEFAULTS.sessionMin,
      limits: parseLimits(profile?.limits),
      variant: st.planVariant,
      weightsUsed: weights.filter((w) => inPlan.has(w.exerciseId)).length,
      weightsTotal: weights.length,
    });
  }

  async function render(userId: number, st: OnboardingRow, hint?: string): Promise<Screen> {
    const profile = await repo.getProfile(userId);
    const back = true;
    switch (st.step) {
      case "welcome":
        return welcomeScreen();
      case "goal":
        return enumScreen("goal", profile, { hint, back: false, skip: false });
      case "goal_note":
        return goalNoteScreen(profile);
      case "limits":
        return limitsScreen(profile, back);
      case "limits_note":
        return noteScreen("limits_note", profile?.limitsNote ?? null);
      case "diet":
        return noteScreen("diet", profile?.dietNote ?? null);
      case "birth":
      case "height":
      case "weight":
        return numberScreen(st.step, profile);
      case "lifts": {
        const list = await anchors(userId, profile);
        const ex = list[st.sub]!;
        return liftScreen(ex, st.sub, list.length, await repo.getStartWeight(userId, ex.id), false);
      }
      case "plan":
        return renderPlan(userId, st, profile);
      default:
        return enumScreen(st.step, profile, { back, skip: true });
    }
  }

  const markup = (s: Screen) => ({ parse_mode: HTML, reply_markup: s.keyboard });

  /** Редагує повідомлення, на кнопку якого натиснули; запам'ятовує його як екран анкети. */
  async function editTapped(ctx: Context, userId: number, st: OnboardingRow, s: Screen): Promise<void> {
    try {
      await ctx.editMessageText(s.text, markup(s));
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
    const mid = ctx.callbackQuery?.message?.message_id;
    if (mid !== undefined && mid !== st.msgId) await repo.upsertOnboarding(userId, { msgId: mid }, now());
  }

  async function dropKeyboard(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // повідомлення вже без кнопок чи недоступне — нічого прибирати
    }
  }

  /** Новий екран-повідомлення; попередній екран анкети лишається без кнопок. */
  async function sendNew(ctx: Context, userId: number, s: Screen, oldMsgId: number | null): Promise<void> {
    if (oldMsgId !== null) {
      try {
        await ctx.api.editMessageReplyMarkup(ctx.chat!.id, oldMsgId, { reply_markup: undefined });
      } catch {
        // старого екрана вже немає — не страшно
      }
    }
    const m = await ctx.reply(s.text, markup(s));
    await repo.upsertOnboarding(userId, { msgId: m.message_id }, now());
  }

  /** Перехід + показ екрана на місці натиснутої кнопки. */
  async function moveAndShow(ctx: Context, userId: number, st: OnboardingRow, to: Target): Promise<void> {
    const next = await enter(userId, st, to);
    await editTapped(ctx, userId, next, await render(userId, next));
  }

  /** Перехід після текстової відповіді: екран — новим повідомленням. */
  async function moveAndSend(ctx: Context, userId: number, st: OnboardingRow, to: Target): Promise<void> {
    const next = await enter(userId, st, to);
    await sendNew(ctx, userId, await render(userId, next), st.msgId);
  }

  // --- Куди далі / назад ---

  function forward(st: OnboardingRow): Target {
    const back = st.sub === RETURN_TO_PLAN;
    switch (st.step) {
      case "days":
        return { step: "minutes", sub: st.sub };
      case "minutes":
        return back ? { step: "plan", sub: 0 } : { step: "place", sub: 0 };
      case "limits":
        return back ? { step: "plan", sub: 0 } : { step: "limits_note", sub: 0 };
      case "limits_note":
        return { step: "lifts", sub: 0 };
      default:
        return { step: nextStep(st.step), sub: 0 };
    }
  }

  async function backTarget(userId: number, st: OnboardingRow): Promise<Target | null> {
    const ret = st.sub === RETURN_TO_PLAN;
    switch (st.step) {
      case "goal_note": return { step: "goal", sub: 0 };
      case "level": return { step: "goal_note", sub: 0 };
      case "days": return ret ? { step: "plan", sub: 0 } : { step: "level", sub: 0 };
      case "minutes": return { step: "days", sub: st.sub };
      case "place": return { step: "minutes", sub: 0 };
      case "limits": return ret ? { step: "plan", sub: 0 } : { step: "place", sub: 0 };
      case "limits_note": return { step: "limits", sub: 0 };
      case "lifts": return st.sub > 0 ? { step: "lifts", sub: st.sub - 1 } : { step: "limits_note", sub: 0 };
      case "sex": {
        const list = await anchors(userId, await repo.getProfile(userId));
        return list.length > 0 ? { step: "lifts", sub: list.length - 1 } : { step: "limits_note", sub: 0 };
      }
      case "birth": return { step: "sex", sub: 0 };
      case "height": return { step: "birth", sub: 0 };
      case "weight": return { step: "height", sub: 0 };
      case "meals": return { step: "weight", sub: 0 };
      case "diet": return { step: "meals", sub: 0 };
      case "sleep": return { step: "diet", sub: 0 };
      case "activity": return { step: "sleep", sub: 0 };
      default: return null; // welcome, goal (питання 1 без «Назад»), plan
    }
  }

  /** «Пропустити» = дефолт зі спеки, але наявну відповідь не стирає; решта пропущеного лишається NULL. */
  async function skipDefaults(userId: number, step: Step): Promise<void> {
    const p = await repo.getProfile(userId);
    const patch =
      step === "level" && !p?.level ? { level: SKIP_DEFAULTS.level }
      : step === "days" && !p?.daysPerWeek ? { daysPerWeek: SKIP_DEFAULTS.daysPerWeek }
      : step === "minutes" && !p?.sessionMin ? { sessionMin: SKIP_DEFAULTS.sessionMin }
      : step === "place" && !p?.place ? { place: SKIP_DEFAULTS.place }
      : step === "limits" && p?.limits == null ? { limits: SKIP_DEFAULTS.limits }
      : null;
    if (patch) await repo.upsertProfile(userId, patch, now());
  }

  const CAN_SKIP: ReadonlySet<Step> = new Set<Step>([
    "level", "days", "minutes", "place", "limits", "lifts", "sex", "birth", "height", "weight", "meals", "diet", "sleep", "activity",
  ]);

  // --- Кнопки ---

  async function plan(ctx: Context, userId: number, st: OnboardingRow, value: string): Promise<string | undefined> {
    switch (value) {
      case "alt": {
        const next = await save(userId, st, { planVariant: (st.planVariant + 1) % 3 });
        await editTapped(ctx, userId, next, await render(userId, next));
        return;
      }
      case "days": {
        const base = await save(userId, st, { planVariant: 0 }); // новий план — з першого варіанта
        await moveAndShow(ctx, userId, base, { step: "days", sub: RETURN_TO_PLAN });
        return;
      }
      case "lim":
        await moveAndShow(ctx, userId, st, { step: "limits", sub: RETURN_TO_PLAN });
        return;
      case "dur":
        await moveAndShow(ctx, userId, st, { step: "minutes", sub: RETURN_TO_PLAN });
        return;
      case "new":
        await moveAndShow(ctx, userId, st, { step: "welcome", sub: 0 });
        return;
      case "ok0":
      case "ok1":
      case "ok2":
        // Кнопка несе варіант екрана: інший варіант у стані — це застарілий екран (рев'ю В1).
        if (Number(value.slice(2)) !== st.planVariant) {
          await editTapped(ctx, userId, st, await render(userId, st));
          return MSG.stale;
        }
        return accept(ctx, userId, st);
      default:
        return MSG.stale;
    }
  }

  async function accept(ctx: Context, userId: number, st: OnboardingRow): Promise<string | undefined> {
    const profile = await repo.getProfile(userId);
    const built = buildPlan(planProfile(profile), await repo.getPlanCatalog(), st.planVariant);
    if (!built.ok) {
      await editTapped(ctx, userId, st, built.error === "EMPTY_DAY" ? emptyDayScreen() : await render(userId, st));
      return MSG.stale;
    }
    const res = await repo.activatePlan(userId, built.plan, now());
    if (!res.ok) return res.error === "ACTIVE_WORKOUT" ? MSG.activeWorkout : MSG.failed;
    await save(userId, st, { status: "done" });
    const program = await repo.getActiveProgram(userId);
    const code = program ? nextDayCode(await repo.getLastDoneWorkout(userId), program.days) : null;
    const day = program?.days.find((d) => d.code === code);
    const dayName = day ? (day.title ?? `День ${day.code}`) : "—";
    await editTapped(ctx, userId, st, { text: planAcceptedText(built.plan.name, dayName) });
    return undefined;
  }

  async function dispatch(ctx: Context): Promise<string | undefined> {
    const userId = ctx.from!.id;
    const cb = parseOb(ctx.callbackQuery?.data ?? "");
    if (!cb) return MSG.stale;
    let st = await repo.getOnboarding(userId);

    if (cb.code === PROFILE_CODE) {
      if (cb.value !== "new") return MSG.stale;
      return restart(ctx, userId, st);
    }
    if (!st || st.status !== "active") {
      await dropKeyboard(ctx);
      return MSG.stale;
    }
    st = await normalize(userId, st);

    if (cb.code === RESUME_CODE) {
      if (cb.value === "go") await editTapped(ctx, userId, st, await render(userId, st));
      else if (cb.value === "new") return restart(ctx, userId, st);
      else return MSG.stale;
      return undefined;
    }
    if (cb.step !== st.step) {
      await editTapped(ctx, userId, st, await render(userId, st));
      return MSG.stale;
    }
    return handle(ctx, userId, st, cb.value);
  }

  /** Анкета з нуля (кроку «привітання»); відповіді профілю лишаються й позначені ✅. */
  async function restart(ctx: Context, userId: number, st: OnboardingRow | null): Promise<undefined> {
    const base = st ?? ({ userId, status: "active", step: "welcome", sub: 0, msgId: null, planVariant: 0, startedAt: now(), updatedAt: now() } as OnboardingRow);
    const next = await save(userId, base, { status: "active", step: "welcome", sub: 0, planVariant: 0 });
    await editTapped(ctx, userId, next, welcomeScreen());
    return undefined;
  }

  async function handle(ctx: Context, userId: number, st: OnboardingRow, value: string): Promise<string | undefined> {
    const step = st.step;
    const show = (to: Target) => moveAndShow(ctx, userId, st, to);

    if (step === "plan") return plan(ctx, userId, st, value);
    if (step === "welcome") {
      if (value !== "go") return MSG.stale;
      await show({ step: "goal", sub: 0 });
      return;
    }

    if (value === "b") {
      const to = await backTarget(userId, st);
      if (!to) return MSG.stale;
      await show(to);
      return;
    }
    if (value === "s") {
      if (!CAN_SKIP.has(step)) return MSG.stale;
      await skipDefaults(userId, step);
      await show(step === "lifts" ? { step: "sex", sub: 0 } : forward(st));
      return;
    }

    if (isEnumStep(step)) {
      const opt = ENUMS[step].opts.find((o) => o.value === value);
      if (!opt) return MSG.stale;
      const leavingOther = step === "goal" && opt.stored !== "other" && (await repo.getProfile(userId))?.goal === "other";
      await repo.upsertProfile(userId, { [ENUMS[step].field]: opt.stored, ...(leavingOther ? { goalNote: null } : {}) }, now());
      await show(forward(st));
      return;
    }

    switch (step) {
      case "goal_note": {
        if (value !== "n") return MSG.stale;
        const p = await repo.getProfile(userId);
        if (p?.goal === "other" && !p.goalNote) return MSG.otherNeedsNote;
        await show(forward(st));
        return;
      }
      case "limits": {
        if (value === "ok") {
          if ((await repo.getProfile(userId))?.limits == null) await repo.upsertProfile(userId, { limits: "" }, now());
          await show(forward(st));
          return;
        }
        const m = /^([a-z]{2})([01])$/.exec(value);
        const opt = m && LIMIT_OPTS.find((o) => o.code === m[1]);
        if (!m || !opt) return MSG.stale;
        const have = new Set((await repo.getProfile(userId))?.limits?.split(",").filter(Boolean) ?? []);
        if (m[2] === "1") have.add(opt.flag);
        else have.delete(opt.flag);
        // Порядок — як у переліку обмежень, щоб запис не залежав від порядку натискань.
        const limits = LIMIT_OPTS.filter((o) => have.has(o.flag)).map((o) => o.flag).join(",");
        await repo.upsertProfile(userId, { limits }, now());
        await editTapped(ctx, userId, st, await render(userId, st));
        return;
      }
      case "limits_note":
        if (value !== "n") return MSG.stale;
        await show(forward(st));
        return;
      case "lifts":
        return lifts(ctx, userId, st, value);
      default:
        return MSG.stale;
    }
  }

  async function lifts(ctx: Context, userId: number, st: OnboardingRow, value: string): Promise<string | undefined> {
    const m = /^([ni])(\d)$/.exec(value);
    if (!m || Number(m[2]) !== st.sub) return MSG.stale;
    const profile = await repo.getProfile(userId);
    const list = await anchors(userId, profile);
    const ex = list[st.sub];
    if (!ex) return MSG.stale;
    if (m[1] === "i") {
      await editTapped(ctx, userId, st, liftScreen(ex, st.sub, list.length, await repo.getStartWeight(userId, ex.id), true));
      return;
    }
    await repo.clearStartWeight(userId, ex.id); // «Не знаю» — калібрування як раніше
    await moveAndShow(ctx, userId, st, st.sub + 1 < list.length ? { step: "lifts", sub: st.sub + 1 } : { step: "sex", sub: 0 });
    return;
  }

  // --- Текст ---

  /** true — текст належав анкеті; false — не за станом (викликач скаже «Не зрозумів»). */
  async function text(ctx: Context): Promise<boolean> {
    const userId = ctx.from!.id;
    const raw = (ctx.message?.text ?? "").trim();
    let st = await repo.getOnboarding(userId);
    if (!st || st.status !== "active") return false;
    st = await normalize(userId, st);

    if (st.step === "goal") {
      await sendNew(ctx, userId, await render(userId, st, MSG.pickGoal), st.msgId);
      return true;
    }
    if (!TEXT_STEPS.has(st.step)) return false;

    const reply = (html: string) => ctx.reply(html, { parse_mode: HTML });
    const next = (to: Target) => moveAndSend(ctx, userId, st, to);
    const target = forward(st);

    switch (st.step) {
      case "goal_note":
      case "limits_note":
      case "diet": {
        const note = parseNote(raw);
        if (note === null) {
          await reply(MSG.badNote);
          return true;
        }
        const field = st.step === "goal_note" ? "goalNote" : st.step === "limits_note" ? "limitsNote" : "dietNote";
        await repo.upsertProfile(userId, { [field]: note }, now());
        await next(target);
        return true;
      }
      case "birth": {
        const y = parseBirthYear(raw, new Date(now()).getUTCFullYear());
        if (y === null) {
          await reply(MSG.badYear);
          return true;
        }
        await repo.upsertProfile(userId, { birthYear: y }, now());
        await next(target);
        return true;
      }
      case "height": {
        const h = parseHeight(raw);
        if (h === null) {
          await reply(MSG.badHeight);
          return true;
        }
        await repo.upsertProfile(userId, { heightCm: h }, now());
        await next(target);
        return true;
      }
      case "weight": {
        const w = parseBodyWeight(raw);
        if (w === null) {
          await reply(MSG.badWeight);
          return true;
        }
        await repo.upsertProfile(userId, { weightKg: w }, now());
        await next(target);
        return true;
      }
      case "lifts": {
        const list = await anchors(userId, await repo.getProfile(userId));
        const ex = list[st.sub];
        if (!ex) return false;
        const res = parseLift(raw, ex);
        if (!res.ok) {
          await reply(badLift(res.error, ex));
          return true;
        }
        await repo.setStartWeight(userId, ex.id, res.weightKg, res.reps, now());
        await next(st.sub + 1 < list.length ? { step: "lifts", sub: st.sub + 1 } : { step: "sex", sub: 0 });
        return true;
      }
      default:
        return false;
    }
  }

  // --- Команди ---

  return {
    /** /start: новий користувач — в анкету; перервана анкета — «Продовжити?»; власник із програмою — пропозиція, не примус. */
    async start(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      const name = ctx.from?.first_name ?? "";
      const st = await repo.getOnboarding(userId);
      if (st?.status === "active") {
        const fresh = st.step === "welcome";
        await sendNew(ctx, userId, fresh ? welcomeScreen(esc(greeting(name))) : resumeScreen(), st.msgId);
        return;
      }
      if (!st && !(await repo.getActiveProgram(userId))) {
        await repo.upsertOnboarding(userId, { status: "active", step: "welcome", sub: 0, planVariant: 0 }, now());
        await sendNew(ctx, userId, welcomeScreen(esc(greeting(name))), null);
        return;
      }
      await ctx.reply(greeting(name), { reply_markup: newPlanKeyboard() });
    },

    /** /profil: перегляд профілю й активного плану, повторне проходження. */
    async profil(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      const [profile, st, program, weights] = await Promise.all([
        repo.getProfile(userId),
        repo.getOnboarding(userId),
        repo.getActiveProgram(userId),
        repo.getStartWeights(userId),
      ]);
      const names = new Map((await repo.getExercises(weights.map((w) => w.exerciseId))).map((e) => [e.id, e.nameUk]));
      const s = profileScreen(
        profile,
        program?.name ?? null,
        weights.map((w) => ({ name: names.get(w.exerciseId) ?? "?", weight: w })),
        st?.status === "active" && st.step !== "welcome",
      );
      await ctx.reply(s.text, markup(s));
    },

    /** Кожне натискання `o:…` — рівно один answerCallbackQuery. */
    async callback(ctx: Context): Promise<void> {
      let answer: string | undefined;
      try {
        answer = await dispatch(ctx);
      } catch (err) {
        await ctx.answerCallbackQuery({ text: SOMETHING_WRONG }).catch(() => undefined);
        throw err;
      }
      await ctx.answerCallbackQuery(answer ? { text: answer } : undefined);
    },

    text,
  };
}
