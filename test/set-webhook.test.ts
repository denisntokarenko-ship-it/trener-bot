import { describe, expect, it } from "vitest";
import { type SetWebhookIo, runSetWebhook } from "../scripts/set-webhook-core.ts";

const TOKEN = "123456:SECRET-BOT-TOKEN";
const SECRET = "webhook-secret-xyz";
const BASE_ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, WORKER_URL: "https://trener-preview.example.workers.dev/" };

function harness(env: Record<string, string | undefined> = BASE_ENV, fail?: string) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  let webhookUrl = "";
  const io: SetWebhookIo = {
    env,
    log: (l) => out.push(l),
    error: (l) => out.push(l),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === fail) return Response.json({ ok: false, description: `Bad Request: token ${TOKEN} secret ${SECRET}` });
      if (method === "setWebhook") webhookUrl = String(body.url);
      const result =
        method === "getMe"
          ? { id: 1, is_bot: true, username: "trener_preview_bot" }
          : method === "getWebhookInfo"
            ? { url: webhookUrl, pending_update_count: 0 }
            : true;
      return Response.json({ ok: true, result });
    }) as typeof fetch,
  };
  return { io, calls, out };
}

describe("P2.1 set-webhook", () => {
  it("викликає setWebhook з потрібними параметрами, далі getWebhookInfo і getMe", async () => {
    const h = harness();
    expect(await runSetWebhook(["preview"], h.io)).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(["setWebhook", "setMyCommands", "getWebhookInfo", "getMe"]);
    expect(h.calls[0]!.body).toEqual({
      url: "https://trener-preview.example.workers.dev/tg/webhook",
      secret_token: SECRET,
      allowed_updates: ["message", "callback_query"],
      max_connections: 1,
      drop_pending_updates: false,
    });
    expect(h.calls[1]!.body).toEqual({
      commands: [
        { command: "start", description: "Почати" },
        { command: "trening", description: "Тренування" },
        { command: "prohrama", description: "Програма й наступне заняття" },
        { command: "progres", description: "Останні тренування" },
        { command: "profil", description: "Профіль і план" },
      ],
    });
    expect(h.out).toContain("Середовище: preview");
    expect(h.out).toContain("Бот: @trener_preview_bot");
    expect(h.out).toContain("Хост вебхука: trener-preview.example.workers.dev");
  });

  it("повторний запуск — той самий стан, код 0", async () => {
    const h = harness();
    expect(await runSetWebhook(["preview"], h.io)).toBe(0);
    expect(await runSetWebhook(["preview"], h.io)).toBe(0);
    expect(h.calls[4]!.body).toEqual(h.calls[0]!.body);
  });

  it.each(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "WORKER_URL"])("без %s → код 1, назва змінної, жодного запиту", async (name) => {
    const h = harness({ ...BASE_ENV, [name]: undefined });
    expect(await runSetWebhook(["preview"], h.io)).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.out.join("\n")).toContain(name);
  });

  it.each([[[]], [["staging"]]])("аргумент %j → код 1", async (args) => {
    const h = harness();
    expect(await runSetWebhook(args, h.io)).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  it.each([[undefined], ["setWebhook"], ["getMe"]])("вивід без токена й секрету (збій: %s)", async (fail) => {
    const h = harness(BASE_ENV, fail);
    await runSetWebhook(["production"], h.io);
    const all = h.out.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(SECRET);
  });
});
