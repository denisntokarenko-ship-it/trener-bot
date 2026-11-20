// /yizha: підсумок дня проти норми й питання про прогалини профілю (docs/spec/phase-3.md, розділ 3).
// Анкету 1b не запускаємо й onboarding_state не чіпаємо: бракуюче поле питається окремим повідомленням —
// кнопки `f:go|sx|ac:<значення>` або число у reply (заголовок питання впізнає відповідь, стан не потрібен).
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Repo } from "../db/repo";
import { parseBirthYear, parseBodyWeight, parseHeight } from "../domain/onboarding";
import { firstMissing, normWeightKg, targets, type MissingField, type NormProfile } from "../domain/nutrition";
import { addDays, localDate, localParts } from "../domain/time";
import { avg7 } from "../domain/weight";
import { ENUMS, FOOD_ASK_BAD, FOOD_ASK_HEAD, FOOD_ASK_SAVED, FOOD_ASK_STALE, foodAskFieldOf, foodAskText, yizhaText, type EnumStep } from "./texts";

const DEFAULT_TZ = "Europe/Kyiv";

/** `f:go:<значення>` · `f:sx:<m|f>` · `f:ac:<low|mid|high>`; дії тренування (`f:<число>:<число>`) сюди не потрапляють. */
const FOOD_CB = /^f:(go|sx|ac):([a-z_]{1,10})$/;
export const isFoodCb = (data: string): boolean => FOOD_CB.test(data);

const KIND = { go: { step: "goal", field: "goal" }, sx: { step: "sex", field: "sex" }, ac: { step: "activity", field: "activity" } } as const satisfies Record<string, { step: EnumStep; field: "goal" | "sex" | "activity" }>;
const CODE_OF = { goal: "go", sex: "sx", activity: "ac" } as const;

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function createFoodFlow(repo: Repo, now: () => number) {
  async function context(userId: number) {
    const tz = (await repo.getUserTz(userId)) ?? DEFAULT_TZ;
    const today = localDate(now(), tz);
    const profile = await repo.getProfile(userId);
    const [recent, last] = await Promise.all([repo.getWeights(userId, addDays(today, -6), today), repo.getLastWeight(userId)]);
    const kg = normWeightKg({ avgDg: avg7(recent, today).avgDg, lastDg: last?.weightDg ?? null, profileKg: profile?.weightKg ?? null });
    return { tz, today, profile, kg };
  }

  /** Питання про одне бракуюче поле — окреме повідомлення. */
  async function ask(ctx: Context, field: MissingField): Promise<void> {
    const text = foodAskText(field);
    if (field === "goal" || field === "sex" || field === "activity") {
      const q = ENUMS[KIND[CODE_OF[field]].step];
      const kb = new InlineKeyboard();
      q.opts.forEach((o, i) => {
        kb.text(o.emoji ? `${o.emoji} ${o.text}` : o.text, `f:${CODE_OF[field]}:${o.value}`);
        if ((i + 1) % q.cols === 0) kb.row();
      });
      await ctx.reply(text, { reply_markup: kb });
    } else {
      await ctx.reply(text, { reply_markup: { force_reply: true } });
    }
  }

  /**
   * Норма на сьогодні (створюється ліниво, лише якщо її ще немає й профіль повний), підсумок дня, питання про бракуюче.
   * `afterAnswer` — після відповіді на питання: бракує ще щось → лише наступне питання, без повторного підсумку.
   */
  async function run(ctx: Context, userId: number, afterAnswer: boolean): Promise<void> {
    const { tz, today, profile, kg } = await context(userId);
    let norm = await repo.getTargetOn(userId, today);
    const missing = firstMissing(profile, kg);
    let profileCheck = false;
    if (!norm && missing === null) {
      const n = targets(profile as unknown as NormProfile, kg!, Number(today.slice(0, 4)));
      if (n === null) profileCheck = true;
      else {
        await repo.insertTarget(userId, { validFrom: today, kcal: n.kcal, proteinG: n.proteinG, fatG: n.fatG, carbsG: n.carbsG, reason: "formula", sourceDate: null }, now());
        norm = await repo.getTargetOn(userId, today);
      }
    }
    const ask1 = !norm && missing !== null ? missing : null;
    if (afterAnswer && ask1) {
      await ask(ctx, ask1);
      return;
    }
    const [total, meals, pending] = await Promise.all([repo.dayTotals(userId, today), repo.dayMeals(userId, today), repo.countPendingMeals(userId, today)]);
    await ctx.reply(
      yizhaText({
        total,
        norm: norm ? { kcal: norm.kcal, proteinG: norm.proteinG, fatG: norm.fatG, carbsG: norm.carbsG, validFrom: norm.validFrom } : null,
        meals: meals.map((m) => ({ time: hhmm(localParts(m.eatenAt, tz).minutes), items: m.items, kcal: m.kcal })),
        pending,
        profileCheck,
      }),
    );
    if (ask1) await ask(ctx, ask1);
  }

  return {
    async yizha(ctx: Context): Promise<void> {
      await run(ctx, ctx.from!.id, false);
    },

    /** Кнопки `f:go|sx|ac`: пише лише порожнє поле; застаріла кнопка (поле вже заповнене) — без змін. */
    async callback(ctx: Context): Promise<void> {
      const m = FOOD_CB.exec(ctx.callbackQuery?.data ?? "");
      if (!m) return void (await ctx.answerCallbackQuery());
      const { step, field } = KIND[m[1] as keyof typeof KIND];
      const value = m[2]!;
      const opt = ENUMS[step].opts.find((o) => o.value === value);
      const userId = ctx.from!.id;
      const profile = await repo.getProfile(userId);
      if (!opt || profile?.[field] != null) {
        await ctx.answerCallbackQuery({ text: FOOD_ASK_STALE });
        return;
      }
      await repo.upsertProfile(userId, { [field]: opt.stored } as Parameters<Repo["upsertProfile"]>[1], now());
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(`${FOOD_ASK_HEAD[field]}\n${FOOD_ASK_SAVED}: ${opt.emoji ? `${opt.emoji} ` : ""}${opt.text}`);
      } catch {
        // повідомлення вже не редагується — відповідь записана, йдемо далі
      }
      await run(ctx, userId, true);
    },

    /**
     * Крок (1б) маршрутизації тексту: reply на питання про рік / зріст / вагу. Не наше питання → false.
     * Поза межами — підказка, нічого не пишеться; поле вже заповнене — без змін.
     */
    async replyToQuestion(ctx: Context): Promise<boolean> {
      const field = foodAskFieldOf(ctx.message?.reply_to_message?.text);
      if (!field) return false;
      const userId = ctx.from!.id;
      const { today, profile, kg } = await context(userId);
      const filled = field === "birth_year" ? profile?.birthYear != null : field === "height_cm" ? profile?.heightCm != null : kg !== null;
      if (filled) {
        await ctx.reply(FOOD_ASK_STALE);
        return true;
      }
      const raw = (ctx.message?.text ?? "").trim();
      const value = field === "birth_year" ? parseBirthYear(raw, Number(today.slice(0, 4))) : field === "height_cm" ? parseHeight(raw) : parseBodyWeight(raw);
      if (value === null) {
        await ctx.reply(FOOD_ASK_BAD[field === "weight" ? "weight" : field]);
        return true;
      }
      const patch = field === "birth_year" ? { birthYear: value } : field === "height_cm" ? { heightCm: value } : { weightKg: value };
      await repo.upsertProfile(userId, patch, now());
      await run(ctx, userId, true);
      return true;
    },
  };
}
