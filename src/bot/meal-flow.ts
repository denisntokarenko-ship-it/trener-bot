// Фото їжі → один виклик Claude → pending-прийом із кнопками → людина підтверджує (docs/spec/phase-3-photo.md §1).
// ШІ лише пропонує: запис у знімок робить confirmMeal після [✅ Вірно]. Робота з ШІ — у waitUntil (вебхук уже відповів 200).
import Anthropic from "@anthropic-ai/sdk";
import type { Api, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { PhotoSize } from "grammy/types";
import { classifyAiError, foodRequest, toBase64, type AiFailure } from "../ai/food-prompt";
import {
  AI_DAILY_LIMIT_MICRO,
  FOOD_CALL_EST_MICRO,
  FOOD_CAPTION_MAX,
  FOOD_KNOWN_NAMES_MAX,
  FOOD_MODEL,
  FOOD_PHOTO_MAX_BYTES,
  FOOD_PRICE_IN_MICRO,
  FOOD_PRICE_OUT_MICRO,
  GRAMS_AWAIT_TTL_MS,
  MEAL_PENDING_TTL_MS,
} from "../config";
import type { MealView, Repo } from "../db/repo";
import { costMicro, estimateOf, itemNutrients, parseFoodResponse, parseGrams } from "../domain/meal";
import { localDate } from "../domain/time";
import {
  MEAL_ALL_ZERO,
  MEAL_ALREADY_CANCELLED,
  MEAL_ALREADY_CONFIRMED,
  MEAL_BTN_CANCEL,
  MEAL_BTN_CONFIRM,
  MEAL_BTN_GRAMS,
  MEAL_BTN_UNDO,
  MEAL_BUSY,
  MEAL_CANCELLED,
  MEAL_GONE,
  MEAL_INVALID,
  MEAL_LIMIT,
  MEAL_NO_KEY,
  MEAL_NOT_FOOD,
  MEAL_PHOTO_AS_FILE,
  MEAL_STALE,
  MEAL_TIMEOUT,
  MEAL_UNAVAILABLE,
  MEAL_UNREADABLE,
  SOMETHING_WRONG,
  mealConfirmedText,
  mealGramsHint,
  mealGramsPrompt,
  mealPreviewText,
  type MealLine,
  type MealTotal,
} from "./texts";

const DEFAULT_TZ = "Europe/Kyiv";
const RAW_JSON_MAX = 8192;

/** `m:y:<id>` — вірно, `m:g:<id>` — грами, `m:x:<id>` — скасувати. Префікс `m:` не зайнятий іншими потоками. */
const MEAL_CB = /^m:([ygx]):(\d{1,10})$/;
export const isMealCb = (data: string): boolean => MEAL_CB.test(data);
export const mealCb = (action: "y" | "g" | "x", mealId: number): string => `m:${action}:${mealId}`;

const FAIL_TEXT: Record<AiFailure, string> = { busy: MEAL_BUSY, unavailable: MEAL_UNAVAILABLE, invalid: MEAL_INVALID };

type GrammySignal = NonNullable<Parameters<Api["getFile"]>[1]>;

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export interface MealDeps {
  /** Токен бота — лише для адреси завантаження файлу всередині Worker; ця адреса нікуди не передається й не логується. */
  token: string;
  apiKey: string | undefined;
  /** fetch для завантаження файлу Telegram (той самий, що в клієнта grammY). */
  fetch: typeof fetch;
  /** fetch для SDK Anthropic (тести підставляють фейк); undefined — глобальний. */
  anthropicFetch?: typeof fetch;
  waitUntil: (p: Promise<unknown>) => void;
  timeoutMs: number;
  /** Зняти очікування ваги підходу активного тренування ([✏️ Грами] забирає текст собі). */
  clearWorkoutAwait: (ctx: Context) => Promise<void>;
  /** Ліниво створити норму на сьогодні, як /yizha. */
  ensureNorm: (userId: number) => Promise<void>;
}

interface PhotoJob {
  userId: number;
  chatId: number;
  photos: readonly PhotoSize[];
  caption: string | null;
  eatenAt: number;
}

/** Найбільший PhotoSize, не більший за ліміт (розмір невідомий — кандидат). */
function pickPhoto(photos: readonly PhotoSize[]): PhotoSize | null {
  let best: PhotoSize | null = null;
  for (const p of photos) {
    if ((p.file_size ?? 0) > FOOD_PHOTO_MAX_BYTES) continue;
    if (!best || p.width * p.height > best.width * best.height) best = p;
  }
  return best;
}

/** Рядки показу й «Разом»: знімок, якщо є, інакше наживо з foods — та сама формула округлення. */
function view(meal: MealView): { lines: MealLine[]; total: MealTotal } {
  const total: MealTotal = { kcal: 0, proteinDg: 0, fatDg: 0, carbsDg: 0 };
  const lines = meal.items.map((it) => {
    const v = it.snapshot ?? itemNutrients(it.grams, it.food);
    total.kcal += v.kcal;
    total.proteinDg += v.proteinDg;
    total.fatDg += v.fatDg;
    total.carbsDg += v.carbsDg;
    return { nameUk: it.nameUk, grams: it.grams, kcal: v.kcal, low: it.confidence === "low", estimate: it.source === "ai_estimate" };
  });
  return { lines, total };
}

const pendingKb = (id: number) => new InlineKeyboard().text(MEAL_BTN_CONFIRM, mealCb("y", id)).text(MEAL_BTN_GRAMS, mealCb("g", id)).text(MEAL_BTN_CANCEL, mealCb("x", id));
const undoKb = (id: number) => new InlineKeyboard().text(MEAL_BTN_UNDO, mealCb("x", id));

export function createMealFlow(repo: Repo, now: () => number, deps: MealDeps) {
  /** typing → getFile → завантаження → перевірка JPEG → base64. Немає фото / помилка Telegram — null; дедлайн — виняток. */
  async function download(api: Api, job: PhotoJob, signal: AbortSignal): Promise<{ base64: string; fileId: string } | null> {
    // grammY типізує сигнал своїм поліфілом abort-controller; у Workers це той самий стандартний AbortSignal.
    const tgSignal = signal as unknown as GrammySignal;
    try {
      await api.sendChatAction(job.chatId, "typing", undefined, tgSignal);
    } catch (e) {
      if (signal.aborted) throw e;
    }
    const photo = pickPhoto(job.photos);
    if (!photo) return null;
    let path: string | undefined;
    try {
      path = (await api.getFile(photo.file_id, tgSignal)).file_path;
    } catch (e) {
      if (signal.aborted) throw e;
      console.error("photo getFile failed", { error: errorName(e) });
      return null;
    }
    if (!path) return null;
    // Адреса містить токен бота: лише тут, лише для fetch; у лог іде тільки статус (N7).
    let res: Response;
    try {
      res = await deps.fetch(`https://api.telegram.org/file/bot${deps.token}/${path}`, { signal });
    } catch (e) {
      if (signal.aborted) throw e;
      console.error("photo download failed", { error: errorName(e) });
      return null;
    }
    if (!res.ok) {
      console.error("photo download failed", { status: res.status });
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 3 || bytes.length > FOOD_PHOTO_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
    return { base64: toBase64(bytes), fileId: photo.file_id };
  }

  async function recognize(api: Api, job: PhotoJob): Promise<void> {
    const say = async (text: string) => void (await api.sendMessage(job.chatId, text));
    const tz = (await repo.getUserTz(job.userId)) ?? DEFAULT_TZ;
    // Крок 0: атомарне резервування проти ліміту; немає місця — клієнт Anthropic не створюється й не викликається.
    const usageId = await repo.reserveAiUsage(
      job.userId,
      { model: FOOD_MODEL, purpose: "food_photo", localDate: localDate(now(), tz), estMicro: FOOD_CALL_EST_MICRO, limitMicro: AI_DAILY_LIMIT_MICRO },
      now(),
    );
    if (usageId === null) return say(MEAL_LIMIT);
    const release = () => repo.releaseAiUsage(job.userId, usageId);

    // Один дедлайн на весь конвеєр до відповіді Anthropic.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs);
    let sent = false;
    let res!: Anthropic.Message;
    let fileId: string;
    try {
      const image = await download(api, job, ac.signal);
      if (!image) {
        await release();
        return say(MEAL_UNREADABLE);
      }
      fileId = image.fileId;
      const names = await repo.knownFoodNames(FOOD_KNOWN_NAMES_MAX);
      const client = new Anthropic({ apiKey: deps.apiKey, maxRetries: 0, fetch: deps.anthropicFetch });
      sent = true;
      res = await client.messages.create(foodRequest(image.base64, job.caption, names), { signal: ac.signal });
    } catch (e) {
      // Дедлайн до відправки — резервування знято; після — оцінка лишається (запит міг бути оплачений).
      if (ac.signal.aborted) {
        if (!sent) await release();
        return say(MEAL_TIMEOUT);
      }
      const f = sent ? classifyAiError(e) : null;
      if (!f) {
        if (!sent) await release();
        throw e;
      }
      if (f.refund) await release();
      console.error(f.kind === "unavailable" ? "anthropic unavailable" : "anthropic call failed", { status: f.status, error: errorName(e) });
      return say(FAIL_TEXT[f.kind]);
    } finally {
      clearTimeout(timer);
    }

    // Відповідь 200 — облік фактичною ціною завжди, навіть якщо далі INVALID.
    const { input_tokens: inTok, output_tokens: outTok } = res.usage;
    await repo.settleAiUsage(job.userId, usageId, { inputTokens: inTok, outputTokens: outTok, costMicro: costMicro(inTok, outTok, FOOD_PRICE_IN_MICRO, FOOD_PRICE_OUT_MICRO) });
    const parsed = parseFoodResponse(res);
    if (parsed.kind === "not_food") return say(MEAL_NOT_FOOD);
    if (parsed.kind === "invalid") {
      console.error("food response invalid", { stop_reason: res.stop_reason });
      return say(MEAL_INVALID);
    }

    // Зіставлення: збіг аліаса — цифри з таблиці; немає — новий ai_estimate (ідемпотентно за аліасом).
    const items: { foodId: number; grams: number; confidence: (typeof parsed.items)[number]["confidence"] }[] = [];
    for (const g of parsed.items) {
      const food = (await repo.findFoodByAlias(g.nameUk)) ?? (await repo.insertEstimatedFood({ nameUk: g.nameUk, ...estimateOf(g) }, now()));
      if (!food) return say(MEAL_INVALID);
      items.push({ foodId: food.id, grams: g.grams, confidence: g.confidence });
    }
    const raw = res.content.find((b) => b.type === "text")?.text ?? "";
    const mealId = await repo.createPendingMeal(
      job.userId,
      { eatenAt: job.eatenAt, localDate: localDate(job.eatenAt, tz), photoFileId: fileId, caption: job.caption, aiModel: FOOD_MODEL, aiRawJson: [...raw].slice(0, RAW_JSON_MAX).join(""), items },
      now(),
    );
    const meal = mealId === null ? null : await repo.getMeal(job.userId, mealId);
    if (!meal) return say(MEAL_INVALID);
    const { lines, total } = view(meal);
    const msg = await api.sendMessage(job.chatId, mealPreviewText(lines, total), { reply_markup: pendingKb(meal.id) });
    await repo.setMealMessageId(job.userId, meal.id, msg.message_id);
  }

  const isExpired = (meal: MealView): boolean => meal.status === "pending" && now() - meal.createdAt > MEAL_PENDING_TTL_MS;

  async function edit(ctx: Context, text: string, kb?: InlineKeyboard): Promise<void> {
    try {
      await ctx.editMessageText(text, kb ? { reply_markup: kb } : undefined);
    } catch {
      // повідомлення не змінилось або вже не редагується — дані записані
    }
  }

  return {
    /** message:photo — відповідь вебхука не чекає ШІ: робота йде у waitUntil. */
    async photo(ctx: Context): Promise<void> {
      const msg = ctx.message!;
      if (!deps.apiKey) {
        console.warn("food photo: ANTHROPIC_API_KEY is not set");
        await ctx.reply(MEAL_NO_KEY);
        return;
      }
      const caption = msg.caption ? [...msg.caption].slice(0, FOOD_CAPTION_MAX).join("") : null;
      const job: PhotoJob = { userId: ctx.from!.id, chatId: ctx.chat!.id, photos: msg.photo ?? [], caption, eatenAt: msg.date * 1000 };
      const api = ctx.api;
      deps.waitUntil(
        recognize(api, job).catch(async (e: unknown) => {
          console.error("food photo failed", { error: errorName(e) });
          try {
            await api.sendMessage(job.chatId, SOMETHING_WRONG);
          } catch {
            // відправка неможлива — лишається лог
          }
        }),
      );
    },

    /** Картинка файлом: просимо фото (стиснене JPEG). true — оброблено. */
    async document(ctx: Context): Promise<boolean> {
      if (!ctx.message?.document?.mime_type?.startsWith("image/")) return false;
      await ctx.reply(MEAL_PHOTO_AS_FILE);
      return true;
    },

    async callback(ctx: Context): Promise<void> {
      const m = MEAL_CB.exec(ctx.callbackQuery?.data ?? "");
      if (!m) return void (await ctx.answerCallbackQuery());
      const action = m[1] as "y" | "g" | "x";
      const mealId = Number(m[2]);
      const userId = ctx.from!.id;
      const meal = await repo.getMeal(userId, mealId);
      if (!meal) return void (await ctx.answerCallbackQuery({ text: MEAL_GONE }));
      // Ледача перевірка прострочення: не залежить від крону й нічого не змінює.
      if (isExpired(meal)) return void (await ctx.answerCallbackQuery({ text: MEAL_STALE }));

      if (action === "y") {
        if (meal.status !== "pending") return void (await ctx.answerCallbackQuery({ text: meal.status === "confirmed" ? MEAL_ALREADY_CONFIRMED : MEAL_ALREADY_CANCELLED }));
        if (!(await repo.confirmMeal(userId, mealId, now()))) return void (await ctx.answerCallbackQuery({ text: MEAL_ALREADY_CONFIRMED }));
        await ctx.answerCallbackQuery();
        await deps.ensureNorm(userId);
        const [after, day, norm] = await Promise.all([repo.getMeal(userId, mealId), repo.dayTotals(userId, meal.localDate), repo.getTargetOn(userId, meal.localDate)]);
        const { lines, total } = view(after ?? meal);
        await edit(ctx, mealConfirmedText(lines, total, { kcal: day.kcal, normKcal: norm?.kcal ?? null }), undoKb(mealId));
        return;
      }

      if (action === "g") {
        if (meal.status !== "pending") return void (await ctx.answerCallbackQuery({ text: meal.status === "confirmed" ? MEAL_ALREADY_CONFIRMED : MEAL_ALREADY_CANCELLED }));
        if (!(await repo.setAwaitGrams(userId, mealId, now()))) return void (await ctx.answerCallbackQuery({ text: MEAL_STALE }));
        await deps.clearWorkoutAwait(ctx);
        await ctx.answerCallbackQuery();
        await edit(ctx, mealGramsPrompt(view(meal).lines), pendingKb(mealId));
        return;
      }

      if (meal.status === "cancelled" || !(await repo.cancelMeal(userId, mealId))) return void (await ctx.answerCallbackQuery({ text: MEAL_ALREADY_CANCELLED }));
      await ctx.answerCallbackQuery();
      await edit(ctx, MEAL_CANCELLED);
    },

    /** Крок (2б) маршрутизації тексту: грами для прийому, що їх чекає. Не чекаємо — false. */
    async gramsText(ctx: Context): Promise<boolean> {
      const userId = ctx.from!.id;
      const meal = await repo.awaitingGramsMeal(userId, now(), GRAMS_AWAIT_TTL_MS);
      if (!meal) return false;
      if (isExpired(meal)) {
        await repo.clearAwaitGrams(userId);
        await ctx.reply(MEAL_STALE);
        return true;
      }
      const n = meal.items.length;
      const p = parseGrams(ctx.message?.text ?? "", n);
      if (!p.ok) {
        await ctx.reply(p.reason === "all_zero" ? MEAL_ALL_ZERO : mealGramsHint(n, p.reason === "count" ? p.got : null));
        return true;
      }
      const changes = meal.items.map((it, i) => ({ position: it.position, grams: p.grams[i]! }));
      const after = (await repo.updateMealGrams(userId, meal.id, changes)) ? await repo.getMeal(userId, meal.id) : null;
      if (!after || after.status !== "pending") {
        await ctx.reply(MEAL_STALE);
        return true;
      }
      const { lines, total } = view(after);
      const text = mealPreviewText(lines, total);
      const chatId = ctx.chat!.id;
      try {
        if (after.messageId === null) throw new Error("no message");
        await ctx.api.editMessageText(chatId, after.messageId, text, { reply_markup: pendingKb(after.id) });
      } catch {
        const msg = await ctx.api.sendMessage(chatId, text, { reply_markup: pendingKb(after.id) });
        await repo.setMealMessageId(userId, after.id, msg.message_id);
      }
      return true;
    },

    /** Будь-яка команда знімає очікування грамів. */
    async clearGrams(ctx: Context): Promise<void> {
      await repo.clearAwaitGrams(ctx.from!.id);
    },
  };
}
