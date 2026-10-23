import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker", () => {
  it("GET /health → 200 ok", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("ok");
  });

  it("невідомий шлях → 404", async () => {
    const res = await SELF.fetch("https://example.com/nope");
    expect(res.status).toBe(404);
  });

  it("POST /health → 404 (лише GET)", async () => {
    const res = await SELF.fetch("https://example.com/health", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
