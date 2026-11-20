import { describe, expect, it } from "vitest";
import { CATALOG } from "../scripts/seed-core";
import { DEFAULTS, GOALS, GOAL_PARAMS, buildPlan, splitFor, type Goal, type Level, type Plan, type PlanCatalogItem, type PlanProfile } from "../src/domain/plan";
import { isVideoUrl } from "../src/domain/video";

const catalog: PlanCatalogItem[] = CATALOG.map((e) => ({
  id: e.id,
  pattern: e.pattern,
  kind: e.kind,
  place: e.place,
  minLevel: e.minLevel,
  stress: e.stress,
  equipment: e.equipment,
}));
const byId = new Map(catalog.map((c) => [c.id, c]));

function plan(profile: PlanProfile, variant = 0): Plan {
  const r = buildPlan(profile, catalog, variant);
  if (!r.ok) throw new Error(`план не вийшов: ${r.error}`);
  return r.plan;
}

describe("buildPlan: ціль обов'язкова (P2.3)", () => {
  it("без цілі — NO_GOAL, плану немає", () => {
    expect(buildPlan({ goal: null }, catalog, 0)).toEqual({ ok: false, error: "NO_GOAL" });
  });
});

describe("спліт: кожен рядок «днів × рівень» (P2.1)", () => {
  const rows: [number, Level, string[]][] = [
    [2, "novice", ["FA", "FB"]],
    [2, "mid", ["FA", "FB"]],
    [2, "adv", ["FA", "FB"]],
    [3, "novice", ["FA", "FB"]],
    [3, "mid", ["FA", "FB"]],
    [3, "adv", ["PU", "PL", "LG"]],
    [4, "novice", ["UP", "LO"]],
    [4, "mid", ["UP", "LO"]],
    [4, "adv", ["UP", "LO"]],
    [5, "novice", ["PU", "PL", "LG", "UP", "LO"]],
    [5, "mid", ["PU", "PL", "LG", "UP", "LO"]],
    [5, "adv", ["PU", "PL", "LG", "UP", "LO"]],
  ];
  it.each(rows)("%i дн., %s → %j і назви", (days, level, codes) => {
    const p = plan({ goal: "recomp", daysPerWeek: days, level });
    expect(p.days.map((d) => d.code)).toEqual(codes);
    expect(splitFor(days, level)).toEqual(codes);
    const titles: Record<string, string> = { FA: "Все тіло A", FB: "Все тіло B", UP: "Верх", LO: "Низ", PU: "Штовх", PL: "Тяга", LG: "Ноги" };
    expect(p.days.map((d) => d.title)).toEqual(codes.map((c) => titles[c]));
    for (const c of codes) expect(c.length).toBeLessThanOrEqual(8);
  });

  it("4 дні — саме Верх/Низ, не Все тіло (мутація: спліт для 4 днів)", () => {
    expect(plan({ goal: "muscle", daysPerWeek: 4 }).days.map((d) => d.title)).toEqual(["Верх", "Низ"]);
  });

  it("дефолти зі спеки: 3 дні, novice, 60 хв, зал", () => {
    const p = plan({ goal: "recomp" });
    expect(p.days.map((d) => d.code)).toEqual(["FA", "FB"]);
    expect(p.days[0]!.slots).toHaveLength(6);
    expect(DEFAULTS).toMatchObject({ level: "novice", daysPerWeek: 3, sessionMin: 60, place: "gym" });
  });
});

describe("детермінованість і варіанти (P2.2)", () => {
  it("двічі — той самий план; назва програми — за ціллю", () => {
    const p = { goal: "muscle", daysPerWeek: 4, level: "mid" } as const;
    expect(plan(p, 1)).toEqual(plan(p, 1));
    expect(plan(p).name).toBe("План: набрати мʼязи");
  });
  it("gym: варіанти 0/1/2 дають різні плани, 3 = 0", () => {
    const p = { goal: "recomp", daysPerWeek: 4, level: "mid" } as const;
    const [a, b, c] = [plan(p, 0), plan(p, 1), plan(p, 2)];
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    expect(a).not.toEqual(c);
    expect(plan(p, 3)).toEqual(a);
  });
  it("вправа не повторюється в межах дня", () => {
    for (const v of [0, 1, 2]) {
      for (const d of plan({ goal: "muscle", daysPerWeek: 5, level: "adv" }, v).days) {
        const ids = d.slots.map((s) => s.exerciseId);
        expect(new Set(ids).size, d.code).toBe(ids.length);
      }
    }
  });
});

describe("ціль → параметри (P2.3)", () => {
  const base = { daysPerWeek: 4, level: "mid" } as const;
  const squat = (p: Plan) => p.days[1]!.slots.find((s) => byId.get(s.exerciseId)!.kind === "compound")!;

  it("кожна ціль дає свій діапазон повторів compound/accessory за таблицею", () => {
    for (const goal of GOALS) {
      const p = plan({ ...base, goal });
      const gp = GOAL_PARAMS[goal];
      for (const s of p.days.flatMap((d) => d.slots)) {
        const item = byId.get(s.exerciseId)!;
        const range = item.kind === "compound" && item.equipment !== "bodyweight" ? gp.compound : gp.accessory;
        expect([s.repMin, s.repMax], `${goal} #${s.exerciseId}`).toEqual([...range]);
      }
    }
  });

  it("strength / muscle / lose_fat при однакових днях і рівні — різні повтори", () => {
    const r = (g: Goal) => [squat(plan({ ...base, goal: g })).repMin, squat(plan({ ...base, goal: g })).repMax];
    expect(r("strength")).toEqual([4, 6]);
    expect(r("muscle")).toEqual([6, 10]);
    expect(r("lose_fat")).toEqual([8, 12]);
    expect(r("health")).toEqual([10, 15]);
    expect(r("other")).toEqual(r("recomp"));
  });

  it("підходи: muscle/strength mid +1 compound; novice без бонусу; health −1 (мін. 2)", () => {
    const setsOf = (g: Goal, level: Level) => squat(plan({ goal: g, daysPerWeek: 4, level })).sets;
    expect(setsOf("recomp", "mid")).toBe(3);
    expect(setsOf("muscle", "mid")).toBe(4);
    expect(setsOf("strength", "mid")).toBe(4);
    expect(setsOf("muscle", "novice")).toBe(3);
    expect(setsOf("recomp", "adv")).toBe(4);
    expect(setsOf("muscle", "adv")).toBe(5);
    expect(setsOf("health", "mid")).toBe(2);
    const novice = plan({ goal: "health", daysPerWeek: 4, level: "novice" });
    for (const s of novice.days.flatMap((d) => d.slots)) expect(s.sets).toBeGreaterThanOrEqual(2);
  });

  it("strength: не більше 2 accessory на день", () => {
    const p = plan({ goal: "strength", daysPerWeek: 3, level: "adv", sessionMin: 90 });
    for (const d of p.days) {
      expect(d.slots.filter((s) => byId.get(s.exerciseId)!.kind === "accessory").length, d.code).toBeLessThanOrEqual(2);
    }
  });

  it("lose_fat: +1 слот core понад N, якщо слотів ≥ 6; на 45 хв — без додаткового", () => {
    const core = (p: Plan) => p.days[0]!.slots.filter((s) => byId.get(s.exerciseId)!.pattern === "core").length;
    expect(core(plan({ goal: "lose_fat", daysPerWeek: 2 }))).toBe(2);
    expect(plan({ goal: "lose_fat", daysPerWeek: 2 }).days[0]!.slots).toHaveLength(7);
    expect(plan({ goal: "recomp", daysPerWeek: 2 }).days[0]!.slots).toHaveLength(6);
    expect(plan({ goal: "lose_fat", daysPerWeek: 2, sessionMin: 45 }).days[0]!.slots).toHaveLength(5);
  });

  it("health: без штанги; вправи з вагою тіла беруть діапазон accessory", () => {
    const p = plan({ goal: "health", daysPerWeek: 3, level: "mid" });
    for (const s of p.days.flatMap((d) => d.slots)) expect(byId.get(s.exerciseId)!.equipment).not.toBe("barbell");
    const home = plan({ goal: "strength", daysPerWeek: 4, place: "home", level: "mid" });
    for (const s of home.days.flatMap((d) => d.slots)) {
      if (byId.get(s.exerciseId)!.equipment === "bodyweight") expect([s.repMin, s.repMax]).toEqual([8, 10]);
    }
  });
});

describe("обмеження й місце (P2.4–P2.6)", () => {
  it("knee: жодної вправи зі stress ∋ knee, у жодному варіанті й дні", () => {
    for (const v of [0, 1, 2]) {
      for (const days of [2, 4, 5]) {
        const p = plan({ goal: "muscle", daysPerWeek: days, level: "adv", limits: ["knee"] }, v);
        for (const s of p.days.flatMap((d) => d.slots)) expect(byId.get(s.exerciseId)!.stress, `v${v} d${days}`).not.toContain("knee");
      }
    }
  });
  it("кілька обмежень діють разом; без обмежень ті самі вправи доступні", () => {
    const limits = ["knee", "back", "shoulder", "wrist"] as const;
    const p = buildPlan({ goal: "recomp", daysPerWeek: 3, limits }, catalog, 0);
    if (p.ok) {
      for (const s of p.plan.days.flatMap((d) => d.slots)) expect(byId.get(s.exerciseId)!.stress).toEqual([]);
    }
    const free = plan({ goal: "recomp", daysPerWeek: 3, level: "adv" });
    const ids = new Set(free.days.flatMap((d) => d.slots.map((s) => s.exerciseId)));
    expect([...ids].some((id) => byId.get(id)!.stress.includes("knee"))).toBe(true);
  });
  it("home: лише place = both; vpull замінено на hpull", () => {
    for (const v of [0, 1, 2]) {
      const p = plan({ goal: "recomp", daysPerWeek: 3, place: "home", level: "adv" }, v);
      for (const s of p.days.flatMap((d) => d.slots)) expect(byId.get(s.exerciseId)!.place).toBe("both");
      expect(p.days.flatMap((d) => d.slots).some((s) => byId.get(s.exerciseId)!.pattern === "vpull")).toBe(false);
    }
    const fa = plan({ goal: "recomp", daysPerWeek: 2, place: "home" }).days[0]!;
    // Все тіло A: squat, hpush, vpull→hpull, vpush, core, hinge
    expect(fa.slots.map((s) => byId.get(s.exerciseId)!.pattern)).toEqual(["squat", "hpush", "hpull", "vpush", "core", "hinge"]);
  });
  it("новачок не отримує вправ min_level 2", () => {
    for (const v of [0, 1, 2]) {
      const p = plan({ goal: "muscle", daysPerWeek: 5, level: "novice" }, v);
      for (const s of p.days.flatMap((d) => d.slots)) expect(byId.get(s.exerciseId)!.minLevel).toBe(1);
    }
  });
  it("session_min: 30/45/60/90 → 4/5/6/7 слотів у Все тіло A (recomp)", () => {
    const n = (m: number) => plan({ goal: "recomp", daysPerWeek: 2, level: "mid", sessionMin: m }).days[0]!.slots.length;
    expect([n(30), n(45), n(60), n(90)]).toEqual([4, 5, 6, 7]);
  });
  it("коротший за N день (Штовх: 5 патернів) лишається коротшим", () => {
    expect(plan({ goal: "recomp", daysPerWeek: 5, level: "mid", sessionMin: 90 }).days[0]!.slots.length).toBeLessThanOrEqual(5);
  });
});

describe("EMPTY_DAY (P2.12)", () => {
  it("gym, novice, 30 хв, shoulder, 5 днів: Штовх лишається з 1 слотом → EMPTY_DAY, плану немає", () => {
    const r = buildPlan({ goal: "recomp", daysPerWeek: 5, level: "novice", sessionMin: 30, place: "gym", limits: ["shoulder"] }, catalog, 0);
    expect(r).toEqual({ ok: false, error: "EMPTY_DAY", dayCode: "PU" });
  });
  it("порожній каталог — EMPTY_DAY, а не виняток", () => {
    expect(buildPlan({ goal: "recomp" }, [], 0)).toMatchObject({ ok: false, error: "EMPTY_DAY" });
  });
});

describe("каталог і відео (§3, §9)", () => {
  it("30 вправ з id 1–30; нові (19–30) мають ≥ 1 заміну", () => {
    expect(CATALOG).toHaveLength(30);
    expect(CATALOG.map((e) => e.id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const e of CATALOG.filter((x) => x.id >= 19)) expect(e.substitutes.length, e.slug).toBeGreaterThanOrEqual(1);
  });
  it("рев'ю 1b.1: face-pull без непідтвердженого відео; підказка leg-curl не прив'язана до лави (відео — згинання сидячи)", () => {
    const by = new Map(CATALOG.map((e) => [e.slug, e]));
    expect(by.get("face-pull")!.videoUrl).toBeNull();
    expect(by.get("leg-curl")!.cues.join(" ")).not.toContain("лави");
  });
  it("заміни нових вправ — той самий pattern, і слаги існують", () => {
    const by = new Map(CATALOG.map((e) => [e.slug, e]));
    for (const e of CATALOG.filter((x) => x.id >= 19)) {
      for (const s of e.substitutes) {
        expect(by.get(s), `${e.slug} → ${s}`).toBeDefined();
        expect(by.get(s)!.pattern, `${e.slug} → ${s}`).toBe(e.pattern);
      }
    }
  });
  it("кожне непусте video_url — youtube.com/watch?v= або youtu.be/ і ≤ 200 символів; унікальні", () => {
    const urls = CATALOG.flatMap((e) => (e.videoUrl === null ? [] : [e.videoUrl]));
    for (const u of urls) {
      expect(isVideoUrl(u), u).toBe(true);
      expect(u.length).toBeLessThanOrEqual(200);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
  it("isVideoUrl: хибні формати відхиляє", () => {
    for (const bad of [
      "http://www.youtube.com/watch?v=5Lm6U4zNzi0",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/shorts/5Lm6U4zNzi0",
      "https://evil.com/?https://www.youtube.com/watch?v=5Lm6U4zNzi0",
      "https://www.youtube.com/watch?v=5Lm6U4zNzi0&list=x",
      "https://youtu.be/5Lm6U4zNzi0/",
      "",
      null,
    ]) {
      expect(isVideoUrl(bad), String(bad)).toBe(false);
    }
    expect(isVideoUrl("https://youtu.be/5Lm6U4zNzi0")).toBe(true);
  });
});
