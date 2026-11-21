// Обробники grammY. Сюди доходять лише апдейти власника з приватного чату, уже після дедупу.
import { Bot, BotError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Repo } from "../db/repo";
import { FOOD_TIMEOUT_MS } from "../config";
import { createFoodFlow, isFoodCb } from "./food-flow";
import { createMealFlow, isMealCb } from "./meal-flow";
import { createOnboardingFlow } from "./onboarding";
import { createSettingsFlow, isSettingsCb } from "./settings-flow";
import { NOT_UNDERSTOOD, SOMETHING_WRONG } from "./texts";
import { createWeightFlow } from "./weight-flow";
import { createWorkoutFlow } from "./workout-flow";

export interface BotOptions {
  botInfo?: UserFromGetMe;
  fetch?: typeof fetch;
  now?: () => number;
  /** Фонова робота після відповіді вебхука (ctx.waitUntil Worker). Немає — проміс просто запускається. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Ключ Claude (фото їжі); немає — «Розпізнавання ще не підключене». */
  anthropicApiKey?: string;
  /** fetch для SDK Anthropic (лише тести). */
  anthropicFetch?: typeof fetch;
  /** Дедлайн конвеєра фото (тести зменшують). */
  foodTimeoutMs?: number;
}

export function createBot(token: string, repo: Repo, opts: BotOptions = {}): Bot {
  const now = opts.now ?? Date.now;
  const bot = new Bot(token, {
    botInfo: opts.botInfo,
    client: opts.fetch ? { fetch: opts.fetch } : undefined,
  });

  // Усі тексти — HTML (texts.ts): parse_mode ставиться тут, щоб жоден reply/edit не пішов без нього й не показав теги як є.
  bot.api.config.use((prev, method, payload, signal) =>
    (method === "sendMessage" || method === "editMessageText") && !("parse_mode" in payload)
      ? prev(method, { ...payload, parse_mode: "HTML" } as typeof payload, signal)
      : prev(method, payload, signal),
  );

  // Профіль — від першого апдейту власника, не лише від /start (P1.4.3).
  bot.use(async (ctx, next) => {
    if (ctx.from) await repo.upsertUser(ctx.from.id, ctx.from.first_name, now());
    await next();
  });

  const flow = createWorkoutFlow(repo, now);
  const onboarding = createOnboardingFlow(repo, now);
  const weight = createWeightFlow(repo, now);
  const food = createFoodFlow(repo, now);
  const settings = createSettingsFlow(repo, (ctx) => onboarding.profil(ctx));
  const meal = createMealFlow(repo, now, {
    token,
    apiKey: opts.anthropicApiKey,
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    anthropicFetch: opts.anthropicFetch,
    waitUntil: opts.waitUntil ?? ((p) => void p),
    timeoutMs: opts.foodTimeoutMs ?? FOOD_TIMEOUT_MS,
    clearWorkoutAwait: (ctx) => flow.clearAwait(ctx),
    ensureNorm: (userId) => food.ensureNorm(userId),
  });

  // Будь-яка команда знімає очікування ваги (phase-1-flow.md, «Введення ваги», п. 5) і грамів прийому (phase-3-photo.md) й виконується далі.
  bot.use(async (ctx, next) => {
    if (ctx.message?.entities?.some((e) => e.type === "bot_command" && e.offset === 0)) {
      await flow.clearAwait(ctx);
      await meal.clearGrams(ctx);
    }
    await next();
  });

  bot.command("start", (ctx) => onboarding.start(ctx));
  bot.command("profil", (ctx) => onboarding.profil(ctx));
  bot.command("trening", (ctx) => flow.trening(ctx));
  bot.command("progres", (ctx) => flow.progres(ctx));
  bot.command("prohrama", (ctx) => flow.prohrama(ctx));
  bot.command("vaga", (ctx) => weight.vaga(ctx));
  bot.command("nalashtuvannia", (ctx) => settings.command(ctx));
  bot.command("yizha", (ctx) => food.yizha(ctx));
  bot.on("callback_query:data", (ctx) => {
    const d = ctx.callbackQuery.data;
    // f:go|sx|ac:… — питання про профіль для норми (food-flow); f:<число>:<число> — оцінка тренування, її бере flow; m:… — прийом їжі.
    if (d.startsWith("o:")) return onboarding.callback(ctx);
    if (isFoodCb(d)) return food.callback(ctx);
    if (isMealCb(d)) return meal.callback(ctx);
    return isSettingsCb(d) ? settings.callback(ctx) : flow.callback(ctx);
  });
  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery());
  // Текст, число — порядок із phase-2.md, розділ 2 (перший збіг виграє): 1) reply на нагадування про вагу; 1б) reply на питання про профіль для норми (phase-3.md); 2) вага підходу, що
  // чекає; 2б) грами прийому, що їх чекають (phase-3-photo.md); 3) анкета; 4) голе число при відкритому нагадуванні про вагу; 5) «Не зрозумів» (+ підказка для чисел 30–300).
  bot.on("message:text", async (ctx) => {
    if (await weight.replyToReminder(ctx)) return;
    if (await food.replyToQuestion(ctx)) return;
    const awaits = await flow.awaitsWeight(ctx);
    if (!awaits) {
      if (await meal.gramsText(ctx)) return;
      if (await onboarding.text(ctx)) return;
      if (await weight.bareNumber(ctx)) return;
    }
    await flow.text(ctx, awaits ? undefined : weight.hintFor(ctx));
  });
  bot.on("message:photo", (ctx) => meal.photo(ctx));
  bot.on("message:document", async (ctx) => {
    if (!(await meal.document(ctx))) await ctx.reply(NOT_UNDERSTOOD);
  });
  bot.on("message", (ctx) => ctx.reply(NOT_UNDERSTOOD));

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
