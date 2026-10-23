import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { count, env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));

beforeEach(resetDb);

describe("repo", () => {
  it("markUpdateProcessed: true для нового, false для повтору", async () => {
    expect(await repo.markUpdateProcessed(1, 10)).toBe(true);
    expect(await repo.markUpdateProcessed(1, 20)).toBe(false);
    expect(await count("processed_updates")).toBe(1);
  });

  it("purgeProcessedUpdates видаляє лише старші за межу", async () => {
    await repo.markUpdateProcessed(1, 100);
    await repo.markUpdateProcessed(2, 200);
    await repo.markUpdateProcessed(3, 300);
    expect(await repo.purgeProcessedUpdates(200)).toBe(1);
    const rows = await env.DB.prepare("SELECT update_id FROM processed_updates ORDER BY update_id").all();
    expect(rows.results).toEqual([{ update_id: 2 }, { update_id: 3 }]);
  });

  it("upsertUser з тим самим іменем не записує рядків", async () => {
    await repo.upsertUser(111, "Денис", 1);
    const res = await env.DB.prepare(
      "INSERT INTO users (id, first_name, created_at) VALUES (111, 'Денис', 2) ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name WHERE users.first_name <> excluded.first_name",
    ).run();
    expect(res.meta.changes).toBe(0);
  });

  it("CHECK: first_name понад 64 символи БД не приймає", async () => {
    await expect(
      env.DB.prepare("INSERT INTO users (id, first_name, created_at) VALUES (1, ?, 0)").bind("x".repeat(65)).run(),
    ).rejects.toThrow();
  });
});
