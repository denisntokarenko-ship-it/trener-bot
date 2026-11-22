import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import worker from "../src/index";
import { OWNER, count, env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const NOW = 1_760_000_000_000;
const H4 = 4 * 3_600_000;
const D3 = 3 * 86_400_000;

const runScheduled = (now: number) =>
  worker.scheduled!({ scheduledTime: now, cron: "*/15 * * * *", noRetry() {} } as ScheduledController, env);

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
});

async function insertActive(startedAt: number): Promise<number> {
  const day = (await repo.getProgramDay(OWNER, "A"))!;
  const r = await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, await_input) VALUES (?, ?, 'active', ?, ?)")
    .bind(OWNER, day.id, startedAt, '{"p":1}')
    .run();
  return r.meta.last_row_id;
}
const row = (id: number) =>
  env.DB.prepare("SELECT status, finished_at, await_input FROM workouts WHERE id = ?").bind(id).first<{ status: string; finished_at: number | null; await_input: string | null }>();

describe("scheduled(): abandonStale", () => {
  it("старше 4 год — abandoned (finished_at = now, await_input NULL)", async () => {
    const stale = await insertActive(NOW - H4 - 1);
    await runScheduled(NOW);
    expect(await row(stale)).toEqual({ status: "abandoned", finished_at: NOW, await_input: null });
  });
  it("[R-1.1] Д3: крон проходить по всіх користувачах — старий active кожного закрито", async () => {
    const other = OWNER + 1;
    await repo.upsertUser(other, "Інша", 0);
    const otherDay = (await env.DB.prepare("SELECT id FROM program_days LIMIT 1").first<{ id: number }>())!.id;
    const r = await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at) VALUES (?, ?, 'active', ?)").bind(other, otherDay, NOW - H4 - 1).run();
    const mine = await insertActive(NOW - H4 - 1);
    await runScheduled(NOW);
    expect((await row(mine))?.status).toBe("abandoned");
    expect((await row(r.meta.last_row_id))?.status).toBe("abandoned");
  });
  it("рівно 4 год — не чіпає", async () => {
    const edge = await insertActive(NOW - H4);
    await runScheduled(NOW);
    expect(await row(edge)).toEqual({ status: "active", finished_at: null, await_input: '{"p":1}' });
  });
  it("повторний запуск з тим самим now — без змін", async () => {
    const stale = await insertActive(NOW - H4 - 1);
    await runScheduled(NOW);
    const first = await row(stale);
    await runScheduled(NOW);
    expect(await row(stale)).toEqual(first);
  });
});

describe("scheduled(): purgeProcessedUpdates", () => {
  it("видаляє старші за 3 доби, межа лишається", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (1, ?)").bind(NOW - D3 - 1),
      env.DB.prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (2, ?)").bind(NOW - D3 + 1),
      env.DB.prepare("INSERT INTO processed_updates (update_id, created_at) VALUES (3, ?)").bind(NOW - D3),
    ]);
    await runScheduled(NOW);
    const ids = (await env.DB.prepare("SELECT update_id FROM processed_updates ORDER BY update_id").all<{ update_id: number }>()).results.map((r) => r.update_id);
    expect(ids).toEqual([2, 3]);
    await runScheduled(NOW);
    expect(await count("processed_updates")).toBe(2);
  });
});

describe("scheduled(): тиша", () => {
  it("не звертається до мережі (Telegram)", async () => {
    await insertActive(NOW - H4 - 1);
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.reject(new Error("мережа заборонена"));
    }) as typeof fetch;
    try {
      await runScheduled(NOW);
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
  });
});
