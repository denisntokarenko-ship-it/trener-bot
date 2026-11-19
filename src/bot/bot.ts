// Обробники grammY. Сюди доходять лише апдейти власника з приватного чату, уже після дедупу.
import { Bot, BotError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Repo } from "../db/repo";
import { ONLY_START, SOMETHING_WRONG, greeting } from "./texts";

export interface BotOptions {
  botInfo?: UserFromGetMe;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createBot(token: string, repo: Repo, opts: BotOptions = {}): Bot {
  const now = opts.now ?? Date.now;
  const bot = new Bot(token, {
    botInfo: opts.botInfo,
    client: opts.fetch ? { fetch: opts.fetch } : undefined,
  });

  // Профіль — від першого апдейту власника, не лише від /start (P1.4.3).
  bot.use(async (ctx, next) => {
    if (ctx.from) await repo.upsertUser(ctx.from.id, ctx.from.first_name, now());
    await next();
  });

  bot.command("start", (ctx) => ctx.reply(greeting(ctx.from?.first_name ?? "")));
  bot.on("message", (ctx) => ctx.reply(ONLY_START));
  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery());

  return bot;
}

/**
 * N9: власнику — «Щось пішло не так», якщо відправка можлива. У вебхук-режимі grammY не кличе bot.catch
 * (лише handleUpdates для polling), а кидає BotError далі — тому цю функцію кличе код, що ловить помилку.
 */
export async function replyFailure(err: unknown): Promise<void> {
  if (!(err instanceof BotError) || !err.ctx.chat) return;
  try {
    await err.ctx.reply(SOMETHING_WRONG);
  } catch {
    // відправка неможлива — лишається лог
  }
}
