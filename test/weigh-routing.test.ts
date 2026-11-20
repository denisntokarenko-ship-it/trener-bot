// P2.3.10: куди йде число — reply на нагадування (крок 1), вага вправи (2), анкета (3), голе число при відкритому нагадуванні (4), підказка (5).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { NOT_UNDERSTOOD, WEIGHT_BAD, WEIGHT_HINT, WEIGH_REMINDER_STALE } from "../src/bot/texts";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { OWNER, botInfo, env, fakeTelegram, outgoingProblems, resetDb, textUpdate, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const NOON = Date.parse("2026-11-20T10:00:00Z"); // 12:00 за Києвом, Пт
const TODAY = "2026-11-20";
const YESTERDAY = "2026-11-19";
let nowMs = NOON;
let tg = fakeTelegram();
let updateId = 1;

async function send(update: Update): Promise<void> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => nowMs });
  await handleRequest(webhookRequest(update), env, handler);
}
const say = (text: string) => send(textUpdate(updateId++, OWNER, text));
/** Текст як reply на повідомлення `messageId`. */
function sayReply(text: string, messageId: number): Promise<void> {
  const u = textUpdate(updateId++, OWNER, text) as Update & { message: { reply_to_message?: unknown } };
  u.message.reply_to_message = { message_id: messageId, date: 1, chat: { id: OWNER, type: "private", first_name: "Денис" }, from: { id: botInfo.id, is_bot: true, first_name: "Тренер" }, text: "⚖️ Доброго ранку!" } as never;
  return send(u);
}
const reply = () => String([...tg.calls].reverse().find((c) => c.method === "sendMessage")!.payload.text);
const weights = () =>
  env.DB.prepare("SELECT local_date, weight_dg FROM body_weights ORDER BY local_date").all<{ local_date: string; weight_dg: number }>().then((r) => r.results);
/** Нагадування про вагу, надіслане кроном: заявка + message_id. */
async function weighReminder(localDate: string, messageId: number | null): Promise<void> {
  await repo.claimReminder(OWNER, "weigh", localDate, 1);
  if (messageId !== null) await repo.setReminderMessageId(OWNER, "weigh", localDate, messageId);
}

beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  nowMs = NOON;
  updateId = 1;
  await repo.upsertUser(OWNER, "Денис", 0);
});
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
});

describe("крок 1: reply на нагадування про зважування", () => {
  it("reply на нагадування за сьогодні → вага тіла, `await_input` не чіпається (явний жест виграє над вагою вправи)", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    const slot = day.slots[0]!;
    const w = await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, await_input) VALUES (?, ?, 'active', ?, ?)")
      .bind(OWNER, day.id, NOON - 600_000, JSON.stringify({ p: slot.id, e: slot.exercise.id, n: 1, r: 8, m: 5 }))
      .run();
    await weighReminder(TODAY, 777);
    await sayReply("78.4", 777);
    expect(await weights()).toEqual([{ local_date: TODAY, weight_dg: 784 }]);
    expect(reply()).toBe("⚖️ 78,4 кг записано (середнє за 7 днів: 78,4 кг (1 зваж.))");
    const row = await env.DB.prepare("SELECT await_input FROM workouts WHERE id = ?").bind(w.meta.last_row_id).first<{ await_input: string }>();
    expect(JSON.parse(row!.await_input)).toMatchObject({ e: slot.exercise.id, n: 1, m: 5 }); // очікування ваги вправи на місці
  });

  it("reply на нагадування за вчора → нічого не пишемо, підказка", async () => {
    await weighReminder(YESTERDAY, 777);
    await sayReply("78.4", 777);
    expect(await weights()).toEqual([]);
    expect(reply()).toBe(WEIGH_REMINDER_STALE);
  });

  it("reply на нагадування, але не число → «Не схоже на вагу», запису немає", async () => {
    await weighReminder(TODAY, 777);
    await sayReply("щось", 777);
    expect(await weights()).toEqual([]);
    expect(reply()).toBe(WEIGHT_BAD);
  });

  it("reply на довільне повідомлення (не нагадування) — звичайна маршрутизація: підказка, запису немає", async () => {
    await sayReply("78.4", 12345);
    expect(await weights()).toEqual([]);
    expect(reply()).toBe(`${NOT_UNDERSTOOD}\n${WEIGHT_HINT}`);
  });

  it("reply на нагадування про тренування (інший kind) — не вага", async () => {
    await repo.claimReminder(OWNER, "train", TODAY, 1);
    await repo.setReminderMessageId(OWNER, "train", TODAY, 888);
    await sayReply("78.4", 888);
    expect(await weights()).toEqual([]);
  });

  it("повторний reply того ж дня перезаписує вагу", async () => {
    await weighReminder(TODAY, 777);
    await sayReply("78.4", 777);
    await sayReply("78.0", 777);
    expect(await weights()).toEqual([{ local_date: TODAY, weight_dg: 780 }]);
    expect(reply()).toContain("замінило 78,4");
  });
});

describe("крок 4: голе число при відкритому нагадуванні", () => {
  it("є нагадування за сьогодні й немає ваги → вага тіла (навіть якщо message_id NULL — крах між кроками)", async () => {
    await weighReminder(TODAY, null);
    await say("78,4");
    expect(await weights()).toEqual([{ local_date: TODAY, weight_dg: 784 }]);
    expect(reply()).toContain("78,4 кг записано");
  });

  it("без нагадування голе число НІКОЛИ не пишеться: «Не розумію» + підказка", async () => {
    await say("78.4");
    expect(await weights()).toEqual([]);
    expect(reply()).toBe(`${NOT_UNDERSTOOD}\n${WEIGHT_HINT}`);
  });

  it("нагадування лише за вчора — вікно закрите о кінці локальної доби", async () => {
    await weighReminder(YESTERDAY, 777);
    await say("78.4");
    expect(await weights()).toEqual([]);
    expect(reply()).toBe(`${NOT_UNDERSTOOD}\n${WEIGHT_HINT}`);
  });

  it("після зважування голе число — підказка, вага не перезаписується", async () => {
    await weighReminder(TODAY, 777);
    await say("78.4");
    await say("45");
    expect(await weights()).toEqual([{ local_date: TODAY, weight_dg: 784 }]);
    expect(reply()).toBe(`${NOT_UNDERSTOOD}\n${WEIGHT_HINT}`);
  });

  it("«сьогодні» за tz користувача: 23:30 за Києвом (UTC уже наступна доба) — нагадування цієї дати відкрите", async () => {
    nowMs = Date.parse("2026-11-20T21:30:00Z"); // Пт 23:30 EET
    await weighReminder(TODAY, 777);
    await say("78.4");
    expect(await weights()).toEqual([{ local_date: TODAY, weight_dg: 784 }]);
  });

  it("число не схоже на вагу (29, 301, 5) при відкритому нагадуванні — не пишеться", async () => {
    await weighReminder(TODAY, 777);
    for (const n of ["29", "301", "5"]) await say(n);
    expect(await weights()).toEqual([]);
    expect(reply()).toContain(NOT_UNDERSTOOD);
  });

  it("текст, не число, при відкритому нагадуванні — звичайна відповідь", async () => {
    await weighReminder(TODAY, 777);
    await say("привіт");
    expect(await weights()).toEqual([]);
    expect(reply()).toBe(NOT_UNDERSTOOD);
  });
});

describe("порядок кроків 2, 3 і 4", () => {
  it("крок 2 перед 4: тренування чекає вагу вправи → голе число це вага підходу, а не тіла", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    const day = (await repo.getProgramDay(OWNER, "A"))!;
    const slot = day.slots[0]!;
    await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, await_input) VALUES (?, ?, 'active', ?, ?)")
      .bind(OWNER, day.id, NOON - 600_000, JSON.stringify({ p: slot.id, e: slot.exercise.id, n: 1, r: 8, m: 5 }))
      .run();
    await weighReminder(TODAY, 777);
    await say("60");
    expect(await weights()).toEqual([]);
    // число пішло вазі вправи: очікування знято, екран-підказка відредаговано на «⚖️ 60 кг»
    expect((await env.DB.prepare("SELECT await_input FROM workouts").first<{ await_input: string | null }>())!.await_input).toBeNull();
    expect(tg.calls.some((c) => c.method === "editMessageText" && c.payload.text === "⚖️ <b>60 кг</b>")).toBe(true);
  });

  it("крок 3 перед 4: активна анкета забирає число (зріст 180), вага тіла не пишеться", async () => {
    await repo.upsertOnboarding(OWNER, { status: "active", step: "height" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle" }, 1);
    await weighReminder(TODAY, 777);
    await say("180");
    expect(await weights()).toEqual([]);
    expect((await repo.getProfile(OWNER))?.heightCm).toBe(180);
  });

  it("команда при відкритому нагадуванні виконується як зазвичай (/vaga)", async () => {
    await weighReminder(TODAY, 777);
    await say("/vaga 80");
    expect(await weights()).toEqual([{ local_date: TODAY, weight_dg: 800 }]);
  });
});
