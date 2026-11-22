import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { HEALTH_CACHE_MS, handleRequest, resetHealthCache, versionSuffix } from "../src/app";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import type { Env } from "../src/env";
import { env, resetDb } from "./helpers";

describe("Worker", () => {
  it("GET /health → 200 ok", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    // Формат: `ok cron=… ok=…`, далі (з binding version_metadata) ` v=<8 символів id версії>`; оркестратор читає початок рядка.
    expect(await res.text()).toMatch(/^ok cron=\? ok=\?( v=[0-9a-zA-Z-]{1,8})?$/);
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

const T = Date.parse("2026-11-22T12:00:00Z");
const MIN = 60_000;

/** env із D1, що рахує prepare() і вміє «падати» (читання /health — один prepare на запит до D1). */
function countingEnv(extra: Partial<Env> = {}): { env: Env; reads: () => number; fail: (v: boolean) => void } {
  let n = 0;
  let failing = false;
  const DB = new Proxy(env.DB, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "prepare") {
        return (...args: unknown[]) => {
          n++;
          if (failing) throw new Error("D1 недоступна");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, CF_VERSION_METADATA: undefined, ...extra, DB }, reads: () => n, fail: (v) => void (failing = v) };
}

const get = async (e: Env, now: number): Promise<string> => (await handleRequest(new Request("https://example.com/health"), e, async () => {}, () => now)).text();

describe("Д8 рев'ю 2.3: /health не б'є D1 на кожен запит", () => {
  beforeEach(async () => {
    await resetDb();
    resetHealthCache();
  });

  it("багато запитів у межах TTL → одне читання D1", async () => {
    const c = countingEnv();
    for (let i = 0; i < 5; i++) await get(c.env, T + i * 1000);
    expect(c.reads()).toBe(1);
  });

  it("після TTL — нове читання; вік рахується від поточного часу, а не від часу кешу", async () => {
    await createRepo(createDb(env.DB)).touchCron(T);
    const c = countingEnv();
    expect(await get(c.env, T + MIN)).toBe("ok cron=1m ok=1m");
    expect(await get(c.env, T + MIN + HEALTH_CACHE_MS - 1000)).toBe("ok cron=1m ok=1m");
    expect(c.reads()).toBe(1);
    expect(await get(c.env, T + 10 * MIN)).toBe("ok cron=10m ok=10m"); // кеш старший за TTL: читання, свіжий тік не потрібен — вік від T
    expect(c.reads()).toBe(2);
  });

  it("кеш бачить новий тік не пізніше за TTL", async () => {
    const repo = createRepo(createDb(env.DB));
    await repo.touchCron(T - 30 * MIN);
    const c = countingEnv();
    expect(await get(c.env, T)).toBe("ok cron=30m ok=30m");
    await repo.touchCron(T + 1000);
    expect(await get(c.env, T + 2000)).toBe("ok cron=30m ok=30m"); // ще з кешу
    expect(await get(c.env, T + HEALTH_CACHE_MS + 1000)).toBe("ok cron=0m ok=0m");
  });

  it("збій читання D1 → `cron=? ok=?`, 200; збій не кешується — одужання видно одразу", async () => {
    await createRepo(createDb(env.DB)).touchCron(T);
    const c = countingEnv();
    c.fail(true);
    expect(await get(c.env, T)).toBe("ok cron=? ok=?");
    c.fail(false);
    expect(await get(c.env, T + 1000)).toBe("ok cron=0m ok=0m");
  });

  it("годинник «назад» (now раніше за кеш) → кеш недійсний, нове читання", async () => {
    const c = countingEnv();
    await get(c.env, T);
    await get(c.env, T - 5000);
    expect(c.reads()).toBe(2);
  });
});

describe("рев'ю 2.5 В1: версія деплою у /health", () => {
  beforeEach(async () => {
    await resetDb();
    resetHealthCache();
  });
  const meta = (id: string, tag = "") => ({ CF_VERSION_METADATA: { id, tag, timestamp: "2026-11-22T12:00:00Z" } });

  it("є binding → ` v=<перші 8 символів id>` після старих полів", async () => {
    const c = countingEnv(meta("95478ee1-1111-4222-8333-444455556666"));
    expect(await get(c.env, T)).toBe("ok cron=? ok=? v=95478ee1");
  });

  it("тег деплою (wrangler deploy --tag <sha>) показується; сміттєвий тег — ні", async () => {
    expect(versionSuffix({ ...env, ...meta("95478ee1-1111", "78529d5") })).toBe(" v=95478ee1 tag=78529d5");
    expect(versionSuffix({ ...env, ...meta("95478ee1-1111", "a b;<x>") })).toBe(" v=95478ee1");
    expect(versionSuffix({ ...env, ...meta("95478ee1-1111", "x".repeat(41)) })).toBe(" v=95478ee1");
  });

  it("binding немає → формат без змін", async () => {
    const c = countingEnv();
    expect(await get(c.env, T)).toBe("ok cron=? ok=?");
    expect(versionSuffix({ ...env, CF_VERSION_METADATA: undefined })).toBe("");
  });
});

describe("кеш /health прив'язаний до D1", () => {
  it("інша D1 (інший binding) кеш не підхоплює", async () => {
    resetHealthCache();
    await resetDb();
    const a = countingEnv();
    const b = countingEnv();
    await get(a.env, T);
    await get(b.env, T + 1000);
    expect([a.reads(), b.reads()]).toEqual([1, 1]);
  });
});
