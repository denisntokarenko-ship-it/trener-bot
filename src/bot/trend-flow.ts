// Кнопки корекції норми за трендом (docs/spec/phase-3.md, розділ 4): `n:a:<±100>:<YYYYMMDD>` — прийняти, `n:d:<YYYYMMDD>` — відхилити.
// Дельта й дата пропозиції — у даних кнопки; прийняття — один умовний INSERT у repo (повторне натискання не створює другу норму).
import type { Context } from "grammy";
import type { Repo } from "../db/repo";
import { localDate } from "../domain/time";
import { TREND_ALREADY, TREND_BTN_ACCEPT, TREND_BTN_NO, TREND_DECLINED, TREND_STALE, trendAppliedText } from "./texts";

const DEFAULT_TZ = "Europe/Kyiv";
const TREND_CB = /^n:(?:a:(-?100):(\d{8})|d:(\d{8}))$/;
export const isTrendCb = (data: string): boolean => TREND_CB.test(data);

const compact = (date: string): string => date.replaceAll("-", "");
const dashed = (c: string): string => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`;

/** Клавіатура пропозиції (сира JSON-розмітка Telegram — для `sendMessage` у кроні). */
export function trendKeyboard(delta: number, proposalDate: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [[{ text: TREND_BTN_ACCEPT, callback_data: `n:a:${delta}:${compact(proposalDate)}` }, { text: TREND_BTN_NO, callback_data: `n:d:${compact(proposalDate)}` }]],
  };
}

export function createTrendFlow(repo: Repo, now: () => number) {
  async function dropKeyboard(ctx: Context): Promise<void> {
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // повідомлення вже не редагується — відповідь опрацьована, кнопки лишаться нешкідливими (повтор = «Вже застосовано»)
    }
  }

  return {
    async callback(ctx: Context): Promise<void> {
      const m = TREND_CB.exec(ctx.callbackQuery?.data ?? "");
      if (!m) return void (await ctx.answerCallbackQuery());
      if (m[3]) {
        await ctx.answerCallbackQuery({ text: TREND_DECLINED });
        await dropKeyboard(ctx);
        return;
      }
      const userId = ctx.from!.id;
      const tz = (await repo.getUserTz(userId)) ?? DEFAULT_TZ;
      const today = localDate(now(), tz);
      const res = await repo.applyTrendTarget(userId, { sourceDate: dashed(m[2]!), delta: Number(m[1]), today }, now());
      if (res !== "applied") {
        await ctx.answerCallbackQuery({ text: res === "already" ? TREND_ALREADY : TREND_STALE });
        await dropKeyboard(ctx);
        return;
      }
      await ctx.answerCallbackQuery();
      await dropKeyboard(ctx);
      const norm = await repo.getTargetOn(userId, today);
      if (norm) await ctx.reply(trendAppliedText(norm));
    },
  };
}
