// Борги [R-0] Д2 і [0.4] Д3: продова зв'язка `src/index.ts` → `telegramHandler(env)` → grammY.
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UpdateHandler, handleRequest, telegramHandler } from "../src/app";
import { OWNER, SECRET, botInfo, count, env, fakeTelegram, resetDb, textUpdate, webhookRequest } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("[R-0] Д2: Worker.fetch з index.ts доносить апдейт до обробника grammY", () => {
  it("POST /tg/webhook через SELF.fetch: 200, рядок дедупу, а обробник справді кликав Telegram (getMe → sendMessage)", async () => {
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.telegram.org/")) return realFetch(input, init);
      urls.push(url);
      const method = url.slice(url.lastIndexOf("/") + 1);
      const result = method === "getMe" ? { ...botInfo } : method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 1, type: "private" } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
    });
    const res = await SELF.fetch("https://example.com/tg/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
      body: JSON.stringify(textUpdate(7001, OWNER, "/start")),
    });
    expect(res.status).toBe(200);
    expect(await count("processed_updates")).toBe(1); // дедуп: крок 5 дійшов до БД
    expect(await count("users")).toBe(1); // і обробник (крок 6) справді виконався
    expect(urls.some((u) => u.endsWith("/sendMessage"))).toBe(true);
  });
});

describe("[0.4] Д3: апдейт іде в bot.handleUpdate без другого Request і без таймауту webhookCallback", () => {
  it("повільна відповідь Telegram (> 10 с, межа webhookCallback) — не помилка: обробник дочекався, у лозі немає «update failed»", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const tg = fakeTelegram();
    const slow = (async (input, init) => {
      await new Promise((r) => setTimeout(r, 10_500));
      return tg.fetch(input, init);
    }) as typeof fetch;
    const handler: UpdateHandler = telegramHandler(env, { fetch: slow, botInfo, now: () => 1_760_000_000_000 });
    const pending = handleRequest(webhookRequest(textUpdate(7002, OWNER, "/start")), env, handler);
    await vi.advanceTimersByTimeAsync(11_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(errors.mock.calls.filter((c) => c[0] === "update failed")).toEqual([]);
    expect(tg.calls.some((c) => c.method === "sendMessage")).toBe(true);
  });
});
