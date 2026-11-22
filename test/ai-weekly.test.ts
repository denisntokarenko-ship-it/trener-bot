// P4.3: недільний коментар ШІ у звіті й прострочення пропозицій у кроні (docs/spec/phase-4-chat.md, розділ 4; phase-4.md, розділ 3).
// Клієнт Anthropic — фейковий fetch під справжнім SDK, реальних викликів немає; час фіксований.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { validateWeeklyComment } from "../src/ai/weekly-comment";
import { WEEKLY_SYSTEM } from "../src/ai/prompts";
import { AI_DAILY_LIMIT_MICRO, CHAT_MODEL, PROPOSAL_TTL_MS, WEEKLY_COMMENT_EST_MICRO } from "../src/config";
import { runCron } from "../src/cron";
import { createDb } from "../src/db/client";
import { createRepo, type Repo } from "../src/db/repo";
import { OWNER, env, outgoingProblems, resetDb, scriptedTelegram } from "./helpers";

const repo = createRepo(createDb(env.DB));
const at = (utc: string): number => Date.parse(utc);
const SUN_1900 = at("2026-10-25T17:00:00Z"); // Нд 19:00 за Києвом (EEST)
const TODAY = "2026-10-25";
const KEY = "sk-ant-test-0000000000";
const strip = (s: string): string => s.replace(/<\/?[a-z]+>/g, "");

let tg = scriptedTelegram();
let spies: ReturnType<typeof vi.spyOn>[] = [];

// --- фейковий Anthropic ---
type AiStep = { content: unknown[]; stop?: string; inTok?: number; outTok?: number; status?: number } | "hang" | "throw";
const text = (t: string, o: { inTok?: number; outTok?: number } = {}): AiStep => ({ content: [{ type: "text", text: t }], ...o });
interface AiReq { body: Record<string, unknown>; raw: string; reportRowsAtRequest: number }
function fakeAi(step: AiStep) {
  const requests: AiReq[] = [];
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? "");
    // Свідок порядку: на момент запиту заявки на звіт ще немає (виклик — до claimReminder).
    const rows = (await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders_sent WHERE kind = 'report'").first<{ n: number }>())!.n;
    requests.push({ body: JSON.parse(raw) as Record<string, unknown>, raw, reportRowsAtRequest: rows });
    if (step === "hang") {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (step === "throw") throw new TypeError("network down");
    if (step.status) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "test" } }), { status: step.status });
    return new Response(
      JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: CHAT_MODEL, content: step.content, stop_reason: step.stop ?? "end_turn", stop_sequence: null,
        usage: { input_tokens: step.inTok ?? 400, output_tokens: step.outTok ?? 90 },
      }),
      { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } },
    );
  }) as typeof fetch;
  return { requests, fetch: fetchFn };
}
let ai = fakeAi(text("ок"));

beforeEach(async () => {
  await resetDb();
  tg = scriptedTelegram();
  ai = fakeAi(text("ок"));
  spies = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
  await env.DB.prepare("UPDATE users SET weigh_time = NULL, remind_time = NULL").run(); // лише звіт
});
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
  for (const s of spies) s.mockRestore();
});

async function addWorkout(day: "A" | "B", startedAt: number, sets: [number, number, number, number][]): Promise<void> {
  const d = (await repo.getProgramDay(OWNER, day))!;
  const w = await env.DB.prepare("INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort) VALUES (?, ?, 'done', ?, ?, 3)").bind(OWNER, d.id, startedAt, startedAt + 3_000_000).run();
  const setNo = new Map<number, number>();
  for (const [weight, reps, slotIdx, skipped] of sets) {
    const slot = d.slots[slotIdx]!;
    const no = (setNo.get(slotIdx) ?? 0) + 1;
    setNo.set(slotIdx, no);
    await env.DB.prepare("INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(w.meta.last_row_id, slot.id, slot.exercise.id, no, skipped ? null : weight, skipped ? null : reps, weight, Math.max(reps, 1), skipped)
      .run();
  }
}
/** Той самий тиждень, що в тесті 2.3: 3 з 3, 7 підходів, 3 065 кг, рекорд 62,5 × 6, вага 79,0 (−0,8). */
async function seedWeek(): Promise<void> {
  await addWorkout("A", at("2026-10-12T07:00:00Z"), [[60, 8, 0, 0]]);
  await addWorkout("A", at("2026-10-19T07:00:00Z"), [[60, 8, 0, 0], [60, 8, 0, 0], [45, 10, 1, 0]]);
  await addWorkout("B", at("2026-10-21T07:00:00Z"), [[40, 10, 0, 0], [40, 10, 0, 0]]);
  await addWorkout("A", at("2026-10-23T07:00:00Z"), [[62.5, 6, 0, 0], [60, 8, 0, 0], [0, 0, 1, 1]]);
  for (const [d, dg] of [["2026-10-13", 800], ["2026-10-15", 796], ["2026-10-20", 792], ["2026-10-22", 790], ["2026-10-24", 788]] as const) await repo.upsertBodyWeight(OWNER, d, dg, 1);
}
const GOOD = "Чудовий тиждень: 3 з 3 тренувань, обсяг 3 065 кг і рекорд 62,5 кг. Середня вага 79,0 кг, мінус 0,8 кг до минулого тижня.";

const tick = (now: number, o: { key?: boolean; commentTimeoutMs?: number; repo?: Repo } = {}) =>
  runCron(env, now, { repo: o.repo, fetch: tg.fetch, timeoutMs: 50, anthropicApiKey: o.key === false ? undefined : KEY, anthropicFetch: ai.fetch, commentTimeoutMs: o.commentTimeoutMs ?? 2000 });
const reports = () => tg.texts().filter((t) => t.startsWith("📊"));
const usage = () => env.DB.prepare("SELECT purpose, input_tokens AS i, output_tokens AS o, cost_micro AS c FROM ai_usage ORDER BY id").all<{ purpose: string; i: number; o: number; c: number }>().then((r) => r.results);
const reportRows = () => env.DB.prepare("SELECT kind, local_date FROM reminders_sent WHERE kind = 'report'").all().then((r) => r.results);

describe("P4.3.1 успішний коментар", () => {
  it("у звіті є блок 💬 перед «Далі»; виклик ШІ — до claimReminder; облік — фактичні токени purpose weekly_comment", async () => {
    await seedWeek();
    ai = fakeAi(text(GOOD, { inTok: 420, outTok: 95 }));
    const c = await tick(SUN_1900);
    expect(c).toMatchObject({ sent: 1, errors: 0 });
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0]!.reportRowsAtRequest).toBe(0); // заявки ще не було
    expect((await reportRows()).length).toBe(1); // а після — є
    const lines = strip(reports()[0]!).split("\n");
    expect(lines.at(-2)).toBe(`💬 ${GOOD}`);
    expect(lines.at(-1)).toBe("Далі: Все тіло B (ноги, спина, груди) — /trening");
    expect(lines.slice(0, 4)).toEqual([
      "📊 Тиждень 19–25 жовтня",
      "Тренувань: 3 з 3 · Підходів: 7 · Обсяг: 3 065 кг",
      "🏆 Нові рекорди: Присідання зі штангою — 62,5 кг × 6",
      "⚖️ Середня вага 79,0 кг (−0,8 до минулого тижня)",
    ]);
    expect(await usage()).toEqual([expect.objectContaining({ purpose: "weekly_comment", i: 420, o: 95 })]);
  });

  it("запит: модель CHAT_MODEL, max_tokens 600, effort low, без інструментів і sampling-параметрів; вхід — лише числа звіту; без токена бота", async () => {
    await seedWeek();
    await tick(SUN_1900);
    const { body, raw } = ai.requests[0]!;
    expect(body.model).toBe(CHAT_MODEL);
    expect(body.max_tokens).toBe(600);
    expect(body.output_config).toEqual({ effort: "low" });
    for (const k of ["tools", "tool_choice", "temperature", "top_p", "thinking"]) expect(body).not.toHaveProperty(k);
    expect(body.system).toBe(WEEKLY_SYSTEM);
    const input = JSON.parse(String((body.messages as { content: string }[])[0]!.content)) as Record<string, unknown>;
    expect(input).toMatchObject({ week: "19–25 жовтня", workouts_done: 3, workouts_planned: 3, sets: 7, volume_kg: 3065, new_records: ["Присідання зі штангою — 62,5 кг × 6"] });
    expect(input.average_weight).toEqual({ kg: "79,0", entries: 3, change_vs_last_week: "−0,8" });
    expect(raw).not.toContain(String(env.TELEGRAM_BOT_TOKEN));
    expect(raw).not.toContain(KEY);
  });

  it("коментар виводиться через esc(): розмітка від моделі не ламає HTML", async () => {
    await seedWeek();
    ai = fakeAi(text("Тиждень <b>3</b> з 3 & усе гаразд"));
    await tick(SUN_1900);
    expect(reports()[0]).toContain("💬 Тиждень &lt;b&gt;3&lt;/b&gt; з 3 &amp; усе гаразд");
  });
});

describe("P4.3.1 збої ШІ — звіт однаково надіслано (без коментаря)", () => {
  const cases: [string, AiStep, { key?: boolean; commentTimeoutMs?: number }, "estimate" | "settled" | "none"][] = [
    ["HTTP 500", { content: [], status: 500 }, {}, "estimate"],
    ["HTTP 429", { content: [], status: 429 }, {}, "estimate"],
    ["обрив мережі", "throw", {}, "estimate"],
    ["дедлайн 10 с (тут 80 мс)", "hang", { commentTimeoutMs: 80 }, "estimate"],
    ["refusal", { content: [], stop: "refusal" }, {}, "settled"],
    ["max_tokens без тексту", { content: [], stop: "max_tokens" }, {}, "settled"],
    ["порожній текст", text("   "), {}, "settled"],
    ["немає ключа", text(GOOD), { key: false }, "none"],
  ];
  for (const [name, step, opts, usageKind] of cases) {
    it(`${name}: звіт надіслано без 💬, рядок report є, помилок немає`, async () => {
      await seedWeek();
      ai = fakeAi(step);
      const c = await tick(SUN_1900, opts);
      expect(c).toMatchObject({ sent: 1, errors: 0 });
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).not.toContain("💬");
      expect(strip(reports()[0]!)).toContain("Тренувань: 3 з 3 · Підходів: 7 · Обсяг: 3 065 кг");
      expect(await reportRows()).toHaveLength(1);
      const u = await usage();
      if (usageKind === "none") {
        expect(u).toEqual([]);
        expect(ai.requests).toHaveLength(0);
      } else if (usageKind === "estimate") {
        expect(u).toEqual([expect.objectContaining({ purpose: "weekly_comment", i: 0, o: 0, c: WEEKLY_COMMENT_EST_MICRO })]); // оцінка лишається
      } else {
        expect(u[0]).toMatchObject({ purpose: "weekly_comment", i: 400, o: 90 }); // відповідь 200 розраховано фактично
      }
    });
  }

  it("ліміт витрат вичерпано: клієнта не викликано, звіт без коментаря, резервування немає", async () => {
    await seedWeek();
    await env.DB.prepare("INSERT INTO ai_usage (user_id, model, input_tokens, output_tokens, cost_micro, purpose, local_date, created_at) VALUES (?, 'x', 100, 100, ?, 'food_photo', ?, ?)")
      .bind(OWNER, AI_DAILY_LIMIT_MICRO - WEEKLY_COMMENT_EST_MICRO + 1, TODAY, SUN_1900)
      .run();
    const c = await tick(SUN_1900);
    expect(c).toMatchObject({ sent: 1, errors: 0 });
    expect(ai.requests).toHaveLength(0);
    expect(reports()[0]).not.toContain("💬");
    expect((await usage()).filter((u) => u.purpose === "weekly_comment")).toEqual([]);
  });

  it("помилка ШІ не перериває надсилання звіту й не лишає заявку без повідомлення (Telegram отримав звіт)", async () => {
    await seedWeek();
    ai = fakeAi("throw");
    await tick(SUN_1900);
    expect(tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
});

describe("P4.3.2 перевірка чисел коментаря", () => {
  const REPORT = "📊 <b>Тиждень 19–25 жовтня</b>\nТренувань: <b>3 з 3</b> · Підходів: <b>7</b> · Обсяг: <b>12 450 кг</b>\n⚖️ Середня вага <b>79,4 кг</b> (−0,5 до минулого тижня)";
  it("числа зі звіту (в т.ч. 12 450 із нерозривним пробілом, 79,4, −0,5) і цілі 0–10 без % проходять", () => {
    const ok = "Обсяг 12 450 кг, вага 79,4 кг, зміна -0,5 кг, двічі 2 рази за 1 тиждень.";
    expect(validateWeeklyComment(ok, REPORT)).toBe(ok);
    const nbsp = "Обсяг 12 450 кг і 12 450 кг, вага 79,4.";
    expect(validateWeeklyComment(nbsp, REPORT)).not.toBeNull(); // пробіли нормалізуються у звичайні
    expect(validateWeeklyComment("Зміна 0,5 кг (без знака)", REPORT)).not.toBeNull();
    expect(validateWeeklyComment("Обсяг 12450 кг без пробілу", REPORT)).not.toBeNull(); // «12450» = «12 450» після нормалізації
  });
  it("«+5 %», вигадане «83,1», понад 500 символів, порожній і «12 460» — відкинуто", () => {
    for (const bad of ["Зросло на +5 %", "Вага 83,1 кг", "я".repeat(501), "", "   ", "Обсяг 12 460 кг", "Було 5 % прогресу", "Вага 79,41 кг"]) expect(validateWeeklyComment(bad, REPORT), bad).toBeNull();
    expect(validateWeeklyComment("я".repeat(500), REPORT)).not.toBeNull();
  });
  it("інтеграція: коментар з вигаданим числом відкидається — звіт без 💬, витрата розрахована", async () => {
    await seedWeek();
    ai = fakeAi(text("Обсяг 3 100 кг — чудово!"));
    const c = await tick(SUN_1900);
    expect(c).toMatchObject({ sent: 1, errors: 0 });
    expect(reports()[0]).not.toContain("💬");
    expect((await usage())[0]).toMatchObject({ purpose: "weekly_comment", i: 400, o: 90 });
  });
});

describe("P4.3.3 прострочення пропозицій у кроні", () => {
  const NOW = SUN_1900;
  async function pending(id: number, createdAt: number, subject: string): Promise<void> {
    await env.DB.prepare("INSERT INTO ai_proposals (id, user_id, kind, subject_key, payload_json, reason, status, expires_at, created_at) VALUES (?, ?, 'change_sets_reps', ?, '{}', 'x', 'pending', ?, ?)")
      .bind(id, OWNER, subject, createdAt + PROPOSAL_TTL_MS, createdAt)
      .run();
  }
  const statuses = () => env.DB.prepare("SELECT id, status FROM ai_proposals ORDER BY id").all<{ id: number; status: string }>().then((r) => r.results);

  it("pending старші за 48 год → expired; свіжі лишаються; applyProposal прострочену не застосовує", async () => {
    const slot = (await repo.getProgramDay(OWNER, "A"))!.slots[0]!;
    await env.DB.prepare("INSERT INTO ai_proposals (id, user_id, kind, subject_key, payload_json, reason, status, expires_at, created_at) VALUES (1, ?, 'change_sets_reps', ?, ?, 'x', 'pending', ?, ?)")
      .bind(OWNER, `pe:${slot.id}`, JSON.stringify({ program_exercise_id: slot.id, sets: 4, rep_min: 6, rep_max: 8, from_sets: slot.sets, from_rep_min: slot.repMin, from_rep_max: slot.repMax }), NOW - 1, NOW - PROPOSAL_TTL_MS - 1)
      .run();
    await pending(2, NOW - 3_600_000, "pe:999");
    await tick(NOW);
    expect(await statuses()).toEqual([{ id: 1, status: "expired" }, { id: 2, status: "pending" }]);
    const before = await env.DB.prepare("SELECT sets, rep_min, rep_max FROM program_exercises WHERE id = ?").bind(slot.id).first();
    expect((await repo.applyProposal(OWNER, 1, NOW, TODAY)).outcome).toBe("expired");
    expect(await env.DB.prepare("SELECT sets, rep_min, rep_max FROM program_exercises WHERE id = ?").bind(slot.id).first()).toEqual(before);
  });

  it("помилка кроку прострочення не зупиняє решту: звіт надіслано, помилка в лічильнику", async () => {
    await seedWeek();
    const broken = { ...repo, expireProposals: async () => { throw new Error("D1 down"); } } as Repo;
    const c = await tick(SUN_1900, { repo: broken });
    expect(c.sent).toBe(1);
    expect(c.errors).toBe(1);
    expect(reports()).toHaveLength(1);
  });
});
