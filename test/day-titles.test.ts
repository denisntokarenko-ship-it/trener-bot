import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements } from "../scripts/seed-core";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { DAY_TITLES, type Plan } from "../src/domain/plan";
import { dayName } from "../src/bot/workout-view";
import { env, resetDb } from "./helpers";

const repo = createRepo(createDb(env.DB));
const OWNER = 111;
const CODES = ["FA", "FB", "UP", "LO", "PU", "PL", "LG"] as const;

beforeEach(async () => {
  await resetDb();
  await repo.upsertUser(OWNER, "Денис", 0);
  await env.DB.batch(seedStatements(1_000).map((q) => env.DB.prepare(q)));
});

// Баг 2026-11-20: на живому боті /prohrama показав «День FA». Тести 1b.3 перевіряли показ при заданому title,
// але не те, що шлях «план → activatePlan → program_days.title → читання» доносить назву до екрана.
describe("назви днів: activatePlan → БД → показ", () => {
  it.each(CODES)("%s: activatePlan пише title = DAY_TITLES, показ — назва, не «День <код>»", async (code) => {
    const exerciseId = (await repo.getPlanCatalog())[0]!.id;
    const plan: Plan = { name: "План", days: [{ code, title: DAY_TITLES[code]!, slots: [{ exerciseId, sets: 3, repMin: 8, repMax: 12 }] }] } as Plan;
    expect((await repo.activatePlan(OWNER, plan, 1_000)).ok).toBe(true);
    const program = await repo.getActiveProgram(OWNER);
    expect(program?.days[0]?.title).toBe(DAY_TITLES[code]);
    const day = await repo.getProgramDay(OWNER, code);
    expect(dayName(day!)).toBe(DAY_TITLES[code]);
    expect(dayName(day!)).not.toMatch(/^День /);
  });

  it("невідомий код без title — єдиний випадок fallback «День <код>»", () => {
    expect(dayName({ code: "ZZ", title: null })).toBe("День ZZ");
    expect(dayName({ code: "FA", title: "" })).toBe("День FA");
  });
});

describe("міграція 0003: назви для днів із title IS NULL", () => {
  const migration = () => {
    const m = ((env as unknown as { TEST_MIGRATIONS: unknown }).TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((x) => x.name.startsWith("0003"));
    if (!m) throw new Error("міграції 0003 немає");
    return m.queries;
  };

  it("заповнює NULL за мапою DAY_TITLES, не чіпає чужі назви й невідомі коди, ідемпотентна", async () => {
    const exerciseId = (await repo.getPlanCatalog())[0]!.id;
    const days = [...CODES, "A", "B"].map((code) => ({ code, title: "x", slots: [{ exerciseId, sets: 3, repMin: 8, repMax: 12 }] }));
    // Дні однієї програми з різними кодами; потім імітуємо стару програму: title = NULL.
    await repo.activatePlan(OWNER, { name: "Старий", days } as Plan, 1_000);
    await env.DB.prepare("UPDATE program_days SET title = NULL").run();
    await env.DB.prepare("UPDATE program_days SET title = 'Моє' WHERE code = 'LG'").run();
    await env.DB.prepare("UPDATE program_days SET code = 'ZZ' WHERE code = 'B'").run();
    const run = () => env.DB.batch(migration().map((q) => env.DB.prepare(q)));
    const titles = async () => Object.fromEntries((await env.DB.prepare("SELECT code, title FROM program_days").all<{ code: string; title: string | null }>()).results.map((r) => [r.code, r.title]));
    await run();
    const t = await titles();
    for (const c of ["FA", "FB", "UP", "LO", "PU", "PL", "A"]) expect(t[c]).toBe(DAY_TITLES[c]);
    expect(t.LG).toBe("Моє");
    expect(t.ZZ).toBeNull();
    await run();
    expect(await titles()).toEqual(t);
  });
});
