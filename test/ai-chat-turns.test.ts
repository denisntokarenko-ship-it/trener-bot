import { beforeEach, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0009_ai_proposals.sql?raw";
import { CHAT_HISTORY_MAX_AGE_MS, CHAT_INFLIGHT_MS } from "../src/config";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const A = 111;
const B = 222;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(A, "Денис", 0);
  await repo.upsertUser(B, "Інший", 0);
});

const rows = async (userId: number) =>
  (await env.DB.prepare("SELECT role, text, created_at FROM chat_turns WHERE user_id = ? ORDER BY id").bind(userId).all<{ role: string; text: string; created_at: number }>()).results;

describe("chat_turns (P4.1.7)", () => {
  it("12 пар двох користувачів: у кожного лишається 10 найновіших рядків, чужі не чіпаються", async () => {
    for (let i = 1; i <= 12; i++) {
      expect(await repo.addChatTurns(A, `питання A ${i}`, `відповідь A ${i}`, NOW + i)).toBe(true);
      // Рядки B — серед найновіших глобально: підзапит обрізання без `user_id` вважав би хвіст A «зайвим» і стер би його (M5).
      if (i >= 9 && i <= 11) await repo.addChatTurns(B, `питання B ${i}`, `відповідь B ${i}`, NOW + i);
    }
    const a = await rows(A);
    expect(a).toHaveLength(10);
    expect(a[0]!.text).toBe("питання A 8");
    expect(a[9]!.text).toBe("відповідь A 12");
    expect(a.map((r) => r.role)).toEqual(Array.from({ length: 5 }, () => ["user", "assistant"]).flat());
    expect(await rows(B)).toHaveLength(6); // B не торкнуто видаленням A
  });

  it("контекст: рядки старші за 6 год не беруться, пара не рветься; порядок від старих до нових", async () => {
    await repo.addChatTurns(A, "давно", "давня відповідь", NOW - CHAT_HISTORY_MAX_AGE_MS - 1);
    await repo.addChatTurns(A, "нещодавно", "недавня відповідь", NOW - CHAT_HISTORY_MAX_AGE_MS + 1000);
    await repo.addChatTurns(A, "щойно", "ось", NOW);
    expect(await repo.getChatTurns(A, NOW)).toEqual([
      { role: "user", text: "нещодавно" },
      { role: "assistant", text: "недавня відповідь" },
      { role: "user", text: "щойно" },
      { role: "assistant", text: "ось" },
    ]);
    expect(await repo.getChatTurns(B, NOW)).toEqual([]);
  });

  it("межа: рядок рівно `CHAT_HISTORY_MAX_AGE_MS` тому ще в контексті («не старші 6 год»), на мс старший — ні (Д3)", async () => {
    await repo.addChatTurns(A, "рівно межа", "відповідь межі", NOW - CHAT_HISTORY_MAX_AGE_MS);
    expect((await repo.getChatTurns(A, NOW)).map((t) => t.text)).toEqual(["рівно межа", "відповідь межі"]);
    expect(await repo.getChatTurns(A, NOW + 1)).toEqual([]);
  });

  it("текст 3501 символ обрізається до 3500 і записується; порожній текст — false без рядків; невідомий користувач — false", async () => {
    expect(await repo.addChatTurns(A, "я".repeat(3501), "ї".repeat(4000), NOW)).toBe(true);
    const r = await rows(A);
    expect(Array.from(r[0]!.text)).toHaveLength(3500);
    expect(Array.from(r[1]!.text)).toHaveLength(3500);
    expect(await repo.addChatTurns(A, "", "відповідь", NOW)).toBe(false);
    expect(await repo.addChatTurns(A, "питання", "", NOW)).toBe(false);
    expect(await repo.addChatTurns(999, "питання", "відповідь", NOW)).toBe(false);
    expect(await rows(A)).toHaveLength(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE user_id = 999").first<{ n: number }>())!.n).toBe(0);
  });

  it("збій другого запису пари не лишає першого (один batch)", async () => {
    await env.DB.prepare("CREATE TRIGGER chat_turns_fail BEFORE INSERT ON chat_turns WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    try {
      await expect(repo.addChatTurns(A, "питання", "відповідь", NOW)).rejects.toThrow();
      expect(await rows(A)).toEqual([]);
    } finally {
      await env.DB.prepare("DROP TRIGGER chat_turns_fail").run();
    }
  });
});

describe("chatInFlight", () => {
  const reserve = (userId: number, purpose: string, now: number) =>
    repo.reserveAiUsage(userId, { model: "claude-haiku-5-5", purpose, localDate: "2023-11-15", estMicro: 8000, limitMicro: 300_000 }, now);

  it("є резервування чату з токенами 0/0 молодше 30 с — true; після settle, через 30 с, інший purpose чи інший користувач — false", async () => {
    expect(await repo.chatInFlight(A, NOW)).toBe(false);
    const id = (await reserve(A, "chat", NOW))!;
    expect(await repo.chatInFlight(A, NOW + 1000)).toBe(true);
    expect(await repo.chatInFlight(A, NOW + CHAT_INFLIGHT_MS - 1)).toBe(true);
    expect(await repo.chatInFlight(A, NOW + CHAT_INFLIGHT_MS)).toBe(false); // вбитий Worker «розблоковується» сам
    expect(await repo.chatInFlight(B, NOW + 1000)).toBe(false);
    await repo.settleAiUsage(A, id, { inputTokens: 1000, outputTokens: 200, costMicro: 200 });
    expect(await repo.chatInFlight(A, NOW + 1000)).toBe(false);
    await reserve(B, "food_photo", NOW);
    expect(await repo.chatInFlight(B, NOW + 1000)).toBe(false);
  });
});

describe("міграція 0009 (P4.1.8)", () => {
  it("лише створює ai_proposals і chat_turns та їхні індекси — наявних таблиць (ai_usage, nutrition_targets, program_exercises…) не чіпає", () => {
    const statements = migrationSql
      .replace(/^-- .*$/gm, "")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(5);
    for (const s of statements) {
      expect(s, s.slice(0, 60)).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) `(ai_proposals|chat_turns)|^CREATE (UNIQUE )?INDEX `(ai_proposals|chat_turns)_/);
      // «ON UPDATE/ON DELETE» у зовнішньому ключі — не оператор.
      expect(s.replace(/ON (UPDATE|DELETE) (no action|cascade)/gi, "")).not.toMatch(/\b(DROP|ALTER|INSERT|UPDATE|DELETE)\b/i);
    }
  });

  it("CHECK і частковий UNIQUE працюють: другий pending на предмет, виходи за межі, невалідний JSON — відмова", async () => {
    const ins = (subject: string, status = "pending", payload = "{}", reason = "ok") =>
      env.DB.prepare("INSERT INTO ai_proposals (user_id, kind, subject_key, payload_json, reason, status, expires_at, created_at) VALUES (?, 'adjust_target', ?, ?, ?, ?, 1, 1)")
        .bind(A, subject, payload, reason, status)
        .run();
    await ins("target");
    await expect(ins("target")).rejects.toThrow(); // частковий UNIQUE: один pending на предмет
    await ins("target", "expired"); // не pending — дозволено
    await expect(ins("x", "pending", "не json")).rejects.toThrow();
    await expect(ins("x", "pending", "{}", "")).rejects.toThrow();
    await expect(ins("x", "pending", "{}", "я".repeat(201))).rejects.toThrow();
    await expect(ins("x", "applied")).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO chat_turns (user_id, role, text, created_at) VALUES (?, 'system', 'x', 1)").bind(A).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO chat_turns (user_id, role, text, created_at) VALUES (?, 'user', ?, 1)").bind(A, "я".repeat(3501)).run()).rejects.toThrow();
  });
});
