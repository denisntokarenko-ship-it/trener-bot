// /vaga: вага тіла (docs/spec/phase-2.md, розділ 2). Дата — завжди «сьогодні за users.tz», заднім числом не пишемо.
import type { Context } from "grammy";
import type { Repo } from "../db/repo";
import { addDays, localDate } from "../domain/time";
import { avg7, formatChange, formatKg, isWeightLike, jumpFrom, parseWeightDg } from "../domain/weight";
import { WEIGHT_BAD, WEIGHT_HINT, WEIGHT_NONE, weightLast, weightSaved } from "./texts";

const DEFAULT_TZ = "Europe/Kyiv";

export function createWeightFlow(repo: Repo, now: () => number) {
  return {
    /** /vaga [число]: із числом — запис за сьогодні, без — остання вага й середнє. */
    async vaga(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      const arg = (typeof ctx.match === "string" ? ctx.match : "").trim();
      const today = localDate(now(), (await repo.getUserTz(userId)) ?? DEFAULT_TZ);
      // 14 днів назад — вікно стрибка; W1 і W0 разом — 14 днів, тож один запит покриває обидва.
      const recent = () => repo.getWeights(userId, addDays(today, -14), today);

      if (arg === "") {
        const last = await repo.getLastWeight(userId);
        if (!last) {
          await ctx.reply(WEIGHT_NONE);
          return;
        }
        const { avgDg, n } = avg7(await recent(), today);
        await ctx.reply(weightLast({ kg: formatKg(last.weightDg), date: `${last.localDate.slice(8)}.${last.localDate.slice(5, 7)}`, avg: avgDg === null ? null : formatKg(avgDg), n }));
        return;
      }

      const dg = parseWeightDg(arg);
      if (dg === null) {
        await ctx.reply(WEIGHT_BAD);
        return;
      }
      const before = await recent(); // до запису: «попередній запис» не бачить сьогоднішнього
      const replaced = await repo.upsertBodyWeight(userId, today, dg, now());
      const entries = [...before.filter((e) => e.localDate !== today), { localDate: today, weightDg: dg }];
      const { avgDg, n } = avg7(entries, today);
      const jump = jumpFrom(before, today, dg);
      await ctx.reply(
        weightSaved({
          kg: formatKg(dg),
          replaced: replaced === null ? null : formatKg(replaced),
          avg: avgDg === null ? null : formatKg(avgDg),
          n,
          jump: jump === null ? null : formatChange(jump),
        }),
      );
    },

    /** Голе число 30–300 без жесту «це вага тіла»: ніколи не пишеться в body_weights; лише підказка до «Не зрозумів» (крок 5). */
    hintFor(ctx: Context): string | null {
      return isWeightLike((ctx.message?.text ?? "").trim()) ? WEIGHT_HINT : null;
    },
  };
}
