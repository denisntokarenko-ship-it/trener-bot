// /nalashtuvannia (docs/spec/phase-2.md, розділ 5): один екран, що редагується на місці; стану в БД немає.
// callback_data: s:m | s:d | s:d:<1-7> | s:z | s:p | s:t:<r|w> | s:t:<r|w>:<HH> | s:t:<r|w>:<HH>:<MM> | s:t:<r|w>:off.
// Значення з callback перевіряється тут і в repo.updateUserSettings — застаріле чи підроблене нічого не пише.
import { GrammyError, InlineKeyboard, type Context } from "grammy";
import type { Repo } from "../db/repo";
import { DEFAULTS } from "../domain/plan";
import { parseTrainingDays } from "../domain/reminders";
import { parseTimezone, reminderTimeFrom, toggleTrainingDay } from "../domain/settings";
import { SETTINGS_BTN as B, SETTINGS_MSG as M, WEEKDAYS_UK, settingsDaysTitle, settingsText, settingsTimeTitle, settingsTzHint, settingsTzSaved } from "./texts";

const HOURS = Array.from({ length: 18 }, (_, i) => i + 5); // 05…22
const MINUTES = [0, 15, 30, 45] as const;
const pad = (n: number): string => String(n).padStart(2, "0");

type Kind = "r" | "w";
export type SettingsCb =
  | { a: "m" | "d" | "z" | "p" }
  | { a: "dt"; day: number }
  | { a: "t"; kind: Kind; hour?: number; minute?: number; off?: true };

/** Розбір `s:…`; битий формат, невідомий вид чи час поза сіткою — null («застаріло», без запису). */
export function parseSettingsCb(data: string): SettingsCb | null {
  const p = data.split(":");
  if (p[0] !== "s" || p.length < 2) return null;
  const [, a, x, y, z] = p;
  if (p.length === 2 && (a === "m" || a === "d" || a === "z" || a === "p")) return { a };
  if (a === "d" && p.length === 3 && /^[1-7]$/.test(x!)) return { a: "dt", day: Number(x) };
  if (a === "t" && (x === "r" || x === "w") && p.length >= 3 && p.length <= 5) {
    const kind: Kind = x;
    if (p.length === 3) return { a: "t", kind };
    if (y === "off") return p.length === 4 ? { a: "t", kind, off: true } : null;
    if (!/^\d{2}$/.test(y!)) return null;
    const hour = Number(y);
    if (!HOURS.includes(hour)) return null;
    if (p.length === 4) return { a: "t", kind, hour };
    if (!/^\d{2}$/.test(z!) || !(MINUTES as readonly number[]).includes(Number(z))) return null;
    return { a: "t", kind, hour, minute: Number(z) };
  }
  return null;
}

const isNotModified = (e: unknown): boolean => e instanceof GrammyError && /not modified/i.test(e.description);

function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(B.days, "s:d").text(B.remind, "s:t:r").text(B.weigh, "s:t:w").row()
    .text(B.tz, "s:z").text(B.profile, "s:p");
}

function daysKeyboard(days: readonly number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  WEEKDAYS_UK.forEach((name, i) => kb.text(`${days.includes(i + 1) ? "✅ " : ""}${name}`, `s:d:${i + 1}`));
  return kb.row().text(B.done, "s:m");
}

function hoursKeyboard(kind: Kind): InlineKeyboard {
  const kb = new InlineKeyboard();
  HOURS.forEach((h, i) => {
    kb.text(pad(h), `s:t:${kind}:${pad(h)}`);
    if (i % 6 === 5) kb.row();
  });
  return kb.text(B.off, `s:t:${kind}:off`).text(B.back, "s:m");
}

function minutesKeyboard(kind: Kind, hour: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of MINUTES) kb.text(`${pad(hour)}:${pad(m)}`, `s:t:${kind}:${pad(hour)}:${pad(m)}`);
  return kb.row().text(B.back, `s:t:${kind}`);
}

export function createSettingsFlow(repo: Repo, showProfile: (ctx: Context) => Promise<void>) {
  async function mainScreen(userId: number): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
    const [s, program, profile] = await Promise.all([repo.getUserSettings(userId), repo.getActiveProgram(userId), repo.getProfile(userId)]);
    if (!s) return null;
    const days = parseTrainingDays(s.trainingDays) ?? [];
    return { text: settingsText({ days, remindTime: s.remindTime, weighTime: s.weighTime, tz: s.tz, planDays: program ? (profile?.daysPerWeek ?? DEFAULTS.daysPerWeek) : null }), keyboard: mainKeyboard() };
  }

  async function edit(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } catch (e) {
      if (!isNotModified(e)) throw e;
    }
  }

  async function showMain(ctx: Context, userId: number): Promise<string | undefined> {
    const s = await mainScreen(userId);
    if (!s) return M.stale;
    await edit(ctx, s.text, s.keyboard);
    return undefined;
  }

  async function dispatch(ctx: Context): Promise<string | undefined> {
    const userId = ctx.from!.id;
    const cb = parseSettingsCb(ctx.callbackQuery?.data ?? "");
    if (!cb) return M.stale;
    const cur = await repo.getUserSettings(userId);
    if (!cur) return M.stale;

    switch (cb.a) {
      case "m":
        return showMain(ctx, userId);
      case "d":
        await edit(ctx, settingsDaysTitle, daysKeyboard(parseTrainingDays(cur.trainingDays) ?? []));
        return undefined;
      case "dt": {
        const next = toggleTrainingDay(cur.trainingDays, cb.day);
        if (next === null) return M.lastDay;
        const saved = await repo.updateUserSettings(userId, { trainingDays: next });
        if (!saved) return M.failed;
        await edit(ctx, settingsDaysTitle, daysKeyboard(parseTrainingDays(saved.trainingDays) ?? []));
        return undefined;
      }
      case "z":
        return settingsTzHint(cur.tz);
      case "p":
        await showProfile(ctx);
        return undefined;
      case "t": {
        const title = cb.kind === "r" ? "remind" : "weigh";
        if (cb.off || cb.minute !== undefined) {
          const time = cb.off ? null : reminderTimeFrom(cb.hour!, cb.minute!);
          if (!cb.off && time === null) return M.stale;
          const saved = await repo.updateUserSettings(userId, cb.kind === "r" ? { remindTime: time } : { weighTime: time });
          if (!saved) return M.failed;
          await showMain(ctx, userId);
          return M.saved;
        }
        if (cb.hour === undefined) await edit(ctx, settingsTimeTitle(title), hoursKeyboard(cb.kind));
        else await edit(ctx, settingsTimeTitle(title, cb.hour), minutesKeyboard(cb.kind, cb.hour));
        return undefined;
      }
    }
  }

  return {
    /** /nalashtuvannia [зона]: без аргументу — екран; з аргументом — зміна пояса (перевірка через Intl, стану очікування немає). */
    async command(ctx: Context): Promise<void> {
      const userId = ctx.from!.id;
      const arg = (typeof ctx.match === "string" ? ctx.match : "").trim();
      if (arg !== "") {
        const tz = parseTimezone(arg);
        const saved = tz === null ? null : await repo.updateUserSettings(userId, { tz });
        await ctx.reply(saved ? settingsTzSaved(saved.tz) : M.tzBad);
        return;
      }
      const s = await mainScreen(userId);
      if (s) await ctx.reply(s.text, { reply_markup: s.keyboard });
    },

    /** Кожне натискання `s:…` — рівно один answerCallbackQuery. */
    async callback(ctx: Context): Promise<void> {
      let answer: string | undefined;
      try {
        answer = await dispatch(ctx);
      } catch (err) {
        await ctx.answerCallbackQuery({ text: M.failed }).catch(() => undefined);
        throw err;
      }
      await ctx.answerCallbackQuery(answer ? { text: answer } : undefined);
    },
  };
}
