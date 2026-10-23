import { beforeEach, describe, expect, it, vi } from "vitest";
import { type UpdateHandler, handleRequest, telegramHandler } from "../src/app";
import { ONLY_START } from "../src/bot/texts";
import {
  OWNER,
  SECRET,
  STRANGER,
  botInfo,
  callbackUpdate,
  count,
  env,
  fakeTelegram,
  resetDb,
  textUpdate,
  webhookRequest,
} from "./helpers";

const NOW = 1_760_000_000_000;

function realHandler(tg = fakeTelegram(), e = env) {
  return { tg, handler: telegramHandler(e, { fetch: tg.fetch, botInfo, now: () => NOW }) };
}

beforeEach(resetDb);

describe("P1.1 вебхук приймає лише Telegram", () => {
  it.each([
    ["без заголовка", null],
    ["інший секрет", "wrong"],
    ["той самий розмір і префікс", SECRET.slice(0, -1) + "X"],
    ["порожній", ""],
  ])("секрет %s → 401, 0 записів, обробник не викликано", async (_name, secret) => {
    const { tg, handler } = realHandler();
    const res = await handleRequest(webhookRequest(textUpdate(1, OWNER, "/start"), secret), env, handler);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(await count("users")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
    expect(tg.calls).toHaveLength(0);
  });

  it("секрет у env не заданий → 401 навіть на порожній заголовок (fail closed)", async () => {
    const handler = vi.fn<UpdateHandler>();
    const res = await handleRequest(webhookRequest(textUpdate(1, OWNER, "/start"), ""), { ...env, TELEGRAM_WEBHOOK_SECRET: "" }, handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("правильний секрет і апдейт від власника → 200", async () => {
    const { handler } = realHandler();
    const res = await handleRequest(webhookRequest(textUpdate(1, OWNER, "/start")), env, handler);
    expect(res.status).toBe(200);
  });

  it("інші шляхи → 404, GET на вебхук → 405", async () => {
    const handler = vi.fn<UpdateHandler>();
    const other = new Request("https://example.com/tg/other", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: "{}" });
    expect((await handleRequest(other, env, handler)).status).toBe(404);
    expect((await handleRequest(new Request("https://example.com/"), env, handler)).status).toBe(404);
    expect((await handleRequest(webhookRequest(null, SECRET, "GET"), env, handler)).status).toBe(405);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([["not json"], ['{"message":{}}'], ["null"]])("тіло %s → 200 і 0 записів", async (body) => {
    const handler = vi.fn<UpdateHandler>();
    const res = await handleRequest(webhookRequest(body), env, handler);
    expect(res.status).toBe(200);
    expect(await count("processed_updates")).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("P1.2 білий список", () => {
  it("/start від чужого ID → 200, жодного sendMessage, 0 рядків у users і processed_updates", async () => {
    const { tg, handler } = realHandler();
    const res = await handleRequest(webhookRequest(textUpdate(1, STRANGER, "/start")), env, handler);
    expect(res.status).toBe(200);
    expect(tg.calls).toHaveLength(0);
    expect(await count("users")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
  });

  it("callback_query від чужого → answerCallbackQuery не викликається, 0 записів", async () => {
    const { tg, handler } = realHandler();
    const res = await handleRequest(webhookRequest(callbackUpdate(2, STRANGER)), env, handler);
    expect(res.status).toBe(200);
    expect(tg.calls).toHaveLength(0);
    expect(await count("processed_updates")).toBe(0);
  });

  it("пробіли навколо ID обрізаються: /start від 222 обробляється", async () => {
    const { tg, handler } = realHandler();
    await handleRequest(webhookRequest(textUpdate(3, 222, "/start")), env, handler);
    expect(tg.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(await count("users")).toBe(1);
  });

  it.each([[""], [undefined], [" , "]])("список %j → тиша для власника, 0 записів", async (list) => {
    const e = { ...env, ALLOWED_TELEGRAM_IDS: list };
    const { tg, handler } = realHandler(fakeTelegram(), e);
    await handleRequest(webhookRequest(textUpdate(4, OWNER, "/start")), e, handler);
    expect(tg.calls).toHaveLength(0);
    expect(await count("users")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
  });

  it.each([
    ["channel_post", { update_id: 5, channel_post: { message_id: 1, date: 0, chat: { id: -1, type: "channel", title: "к" }, text: "/start" } }],
    ["my_chat_member без from", { update_id: 6, my_chat_member: { chat: { id: OWNER, type: "private" }, date: 0 } }],
  ])("апдейт без відправника (%s) → 200, 0 записів", async (_n, update) => {
    const handler = vi.fn<UpdateHandler>();
    const res = await handleRequest(webhookRequest(update), env, handler);
    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    expect(await count("processed_updates")).toBe(0);
  });

  it.each([["group"], ["supergroup"]] as const)("власник пише /start у %s → тиша, 0 записів", async (chatType) => {
    const { tg, handler } = realHandler();
    await handleRequest(webhookRequest(textUpdate(7, OWNER, "/start", { chatType })), env, handler);
    expect(tg.calls).toHaveLength(0);
    expect(await count("users")).toBe(0);
    expect(await count("processed_updates")).toBe(0);
  });
});

describe("P1.3 апдейт обробляється один раз", () => {
  it("той самий update_id двічі → обробник рівно один раз, один рядок, обидва 200", async () => {
    const handler = vi.fn<UpdateHandler>(async () => {});
    const update = textUpdate(1000, OWNER, "/start");
    const r1 = await handleRequest(webhookRequest(update), env, handler);
    const r2 = await handleRequest(webhookRequest(update), env, handler);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await count("processed_updates")).toBe(1);
  });

  it("різні update_id з однаковим текстом → обробник двічі", async () => {
    const handler = vi.fn<UpdateHandler>(async () => {});
    await handleRequest(webhookRequest(textUpdate(1, OWNER, "привіт")), env, handler);
    await handleRequest(webhookRequest(textUpdate(2, OWNER, "привіт")), env, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("обробник кинув на 1001 → повтор не викликає його вдруге, обидва 200", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn<UpdateHandler>(async () => {
      throw new Error("boom");
    });
    const update = textUpdate(1001, OWNER, "/start");
    const r1 = await handleRequest(webhookRequest(update), env, handler);
    const r2 = await handleRequest(webhookRequest(update), env, handler);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("/start");
    errors.mockRestore();
  });

  it("апдейт від чужого ID не лишає рядка дедупу", async () => {
    const handler = vi.fn<UpdateHandler>();
    await handleRequest(webhookRequest(textUpdate(1002, STRANGER, "/start")), env, handler);
    expect(await count("processed_updates")).toBe(0);
  });
});

describe("P1.4 /start", () => {
  async function userRow(id: number) {
    return env.DB.prepare("SELECT id, first_name, tz, created_at FROM users WHERE id = ?").bind(id).first();
  }

  it("новий власник → рядок у users і привітання", async () => {
    const { tg, handler } = realHandler();
    await handleRequest(webhookRequest(textUpdate(1, OWNER, "/start", { firstName: "Денис" })), env, handler);
    expect(await userRow(OWNER)).toEqual({ id: OWNER, first_name: "Денис", tz: "Europe/Kyiv", created_at: NOW });
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.method).toBe("sendMessage");
    expect(tg.calls[0]!.payload.text).toBe("Привіт, Денис! Я записую твої тренування.\n/start — привітання й список команд");
  });

  it("наявний рядок: first_name оновлено, tz і created_at не змінені", async () => {
    await env.DB.prepare("INSERT INTO users (id, first_name, tz, created_at) VALUES (?, 'Старе', 'Europe/Warsaw', 5)").bind(OWNER).run();
    const { handler } = realHandler();
    await handleRequest(webhookRequest(textUpdate(2, OWNER, "/start", { firstName: "Нове" })), env, handler);
    expect(await count("users")).toBe(1);
    expect(await userRow(OWNER)).toEqual({ id: OWNER, first_name: "Нове", tz: "Europe/Warsaw", created_at: 5 });
  });

  it("перший апдейт — не /start: профіль створюється, відповідь «лише /start»", async () => {
    const { tg, handler } = realHandler();
    await handleRequest(webhookRequest(textUpdate(3, OWNER, "привіт")), env, handler);
    expect(await count("users")).toBe(1);
    expect(tg.calls.map((c) => c.payload.text)).toEqual([ONLY_START]);
  });

  it("first_name довший за 64 символи обрізається", async () => {
    const { handler } = realHandler();
    await handleRequest(webhookRequest(textUpdate(4, OWNER, "/start", { firstName: "я".repeat(70) })), env, handler);
    expect(await userRow(OWNER)).toMatchObject({ first_name: "я".repeat(64) });
  });
});
