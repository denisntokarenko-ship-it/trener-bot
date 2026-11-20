// Генератор плану (docs/spec/phase-1b.md, §1 «Ціль → параметри плану» і §3). Чиста функція:
// без I/O, без Date.now, без випадковості — ті самі профіль, каталог і variant дають той самий план.

export const GOALS = ["lose_fat", "muscle", "recomp", "strength", "health", "other"] as const;
export type Goal = (typeof GOALS)[number];
export const LEVELS = ["novice", "mid", "adv"] as const;
export type Level = (typeof LEVELS)[number];
export const PLACES = ["gym", "home"] as const;
export type Place = (typeof PLACES)[number];
export const LIMITS = ["knee", "back", "shoulder", "wrist"] as const;
export type Limit = (typeof LIMITS)[number];
export const PATTERNS = ["squat", "hinge", "hpush", "vpush", "hpull", "vpull", "core", "delt", "legacc"] as const;
export type Pattern = (typeof PATTERNS)[number];
export type ExerciseKind = "compound" | "accessory";

export const GOAL_LABELS: Record<Goal, string> = {
  lose_fat: "схуднути",
  muscle: "набрати мʼязи",
  recomp: "рекомпозиція",
  strength: "сила",
  health: "здоровʼя й форма",
  other: "інше",
};

/** Профіль для генератора. Пропущене в анкеті (null/undefined) = дефолт зі спеки §1. */
export interface PlanProfile {
  goal: Goal | null;
  level?: Level | null;
  daysPerWeek?: number | null;
  sessionMin?: number | null;
  place?: Place | null;
  limits?: readonly Limit[] | null;
}

/** Вправа каталогу в тому вигляді, який потрібен генератору. Вправи без `pattern` до нього не потрапляють. */
export interface PlanCatalogItem {
  id: number;
  pattern: Pattern;
  kind: ExerciseKind;
  place: "gym" | "both";
  minLevel: number;
  stress: readonly Limit[];
  equipment: "barbell" | "dumbbell" | "machine" | "cable" | "bodyweight";
}

export interface PlanSlot {
  exerciseId: number;
  sets: number;
  repMin: number;
  repMax: number;
}
export interface PlanDay {
  code: string;
  title: string;
  slots: PlanSlot[];
}
export interface Plan {
  name: string;
  days: PlanDay[];
}

export type PlanError = "NO_GOAL" | "EMPTY_DAY";
export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: PlanError; dayCode?: string };

export const DEFAULTS = { level: "novice", daysPerWeek: 3, sessionMin: 60, place: "gym" } as const satisfies {
  level: Level;
  daysPerWeek: number;
  sessionMin: number;
  place: Place;
};

export const VARIANTS = 3;
const MIN_DAY_SLOTS = 2;

/** Назви днів за кодом (§4). Код — ключ у callback_data, назва — лише показ. */
export const DAY_TITLES: Record<string, string> = {
  A: "Все тіло A",
  B: "Все тіло B",
  FA: "Все тіло A",
  FB: "Все тіло B",
  UP: "Верх",
  LO: "Низ",
  PU: "Штовх",
  PL: "Тяга",
  LG: "Ноги",
};

type DayCode = "FA" | "FB" | "UP" | "LO" | "PU" | "PL" | "LG";

// Спліт (§3): днів на тиждень × рівень. Дні крутяться по колу, кількість днів на тиждень впливає лише на текст.
const SPLITS: Record<number, { low: readonly DayCode[]; adv: readonly DayCode[] }> = {
  2: { low: ["FA", "FB"], adv: ["FA", "FB"] },
  3: { low: ["FA", "FB"], adv: ["PU", "PL", "LG"] },
  4: { low: ["UP", "LO"], adv: ["UP", "LO"] },
  5: { low: ["PU", "PL", "LG", "UP", "LO"], adv: ["PU", "PL", "LG", "UP", "LO"] },
};

// Патерни дня: порядок = пріоритет, день обрізається до N слотів.
const DAY_PATTERNS: Record<DayCode, readonly Pattern[]> = {
  FA: ["squat", "hpush", "vpull", "vpush", "core", "hinge", "delt"],
  FB: ["hinge", "squat", "hpull", "hpush", "core", "vpull", "delt"],
  UP: ["hpush", "hpull", "vpush", "vpull", "delt", "core", "hpull"],
  LO: ["squat", "hinge", "legacc", "squat", "core", "legacc", "hinge"],
  PU: ["hpush", "vpush", "hpush", "delt", "core"],
  PL: ["vpull", "hpull", "hpull", "delt", "core"],
  LG: ["squat", "hinge", "squat", "legacc", "core"],
};

const SLOTS_BY_MINUTES: Record<number, number> = { 30: 4, 45: 5, 60: 6, 90: 7 };

const FALLBACK: Partial<Record<Pattern, Pattern>> = { vpull: "hpull", legacc: "hinge", vpush: "hpush" };

const LEVEL_NUM: Record<Level, number> = { novice: 1, mid: 2, adv: 3 };

interface GoalParams {
  compound: readonly [number, number];
  accessory: readonly [number, number];
  /** +1 підхід compound для mid/adv. */
  extraCompoundSet: boolean;
  /** -1 підхід усюди (мін. 2). */
  fewerSets: boolean;
  /** accessory ≤ 2 на день. */
  accessoryCap: number | null;
  /** +1 слот core понад N, якщо слотів ≥ 6. */
  extraCore: boolean;
  noBarbell: boolean;
}

const RECOMP: GoalParams = { compound: [8, 12], accessory: [10, 15], extraCompoundSet: false, fewerSets: false, accessoryCap: null, extraCore: false, noBarbell: false };

/** Єдина таблиця «ціль → параметри» (§1). */
export const GOAL_PARAMS: Record<Goal, GoalParams> = {
  lose_fat: { ...RECOMP, accessory: [12, 15], extraCore: true },
  muscle: { ...RECOMP, compound: [6, 10], accessory: [8, 12], extraCompoundSet: true },
  recomp: RECOMP,
  strength: { ...RECOMP, compound: [4, 6], accessory: [8, 10], extraCompoundSet: true, accessoryCap: 2 },
  health: { ...RECOMP, compound: [10, 15], accessory: [12, 15], fewerSets: true, noBarbell: true },
  other: RECOMP,
};

/** Дні програми для (днів, рівня) — коди за порядком. */
export function splitFor(daysPerWeek: number, level: Level): readonly string[] {
  const row = SPLITS[daysPerWeek] ?? SPLITS[DEFAULTS.daysPerWeek]!;
  return level === "adv" ? row.adv : row.low;
}

function baseSets(level: Level, kind: ExerciseKind): number {
  if (kind === "accessory") return level === "novice" ? 2 : 3;
  return level === "adv" ? 4 : 3;
}

export function buildPlan(profile: PlanProfile, catalog: readonly PlanCatalogItem[], variant: number): PlanResult {
  if (!profile.goal) return { ok: false, error: "NO_GOAL" };
  const goal = profile.goal;
  const params = GOAL_PARAMS[goal];
  const level = profile.level ?? DEFAULTS.level;
  const place = profile.place ?? DEFAULTS.place;
  const minutes = profile.sessionMin ?? DEFAULTS.sessionMin;
  const limits = new Set<Limit>(profile.limits ?? []);
  const maxSlots = SLOTS_BY_MINUTES[minutes] ?? SLOTS_BY_MINUTES[DEFAULTS.sessionMin]!;
  const v = ((variant % VARIANTS) + VARIANTS) % VARIANTS;

  // Кандидати за патерном: порядок — id зростаючи.
  const candidates = new Map<Pattern, PlanCatalogItem[]>();
  for (const item of [...catalog].sort((a, b) => a.id - b.id)) {
    if (place === "home" && item.place !== "both") continue;
    if (item.minLevel > LEVEL_NUM[level]) continue;
    if (item.stress.some((s) => limits.has(s))) continue;
    if (params.noBarbell && item.equipment === "barbell") continue;
    const list = candidates.get(item.pattern) ?? [];
    list.push(item);
    candidates.set(item.pattern, list);
  }

  /** n-те входження патерну в дні бере кандидата (n + variant + d) mod len; зайнятого — наступний за колом. */
  const pick = (pattern: Pattern, n: number, d: number, used: Set<number>): PlanCatalogItem | null => {
    let list = candidates.get(pattern) ?? [];
    if (list.length === 0) {
      const fb = FALLBACK[pattern];
      list = fb ? (candidates.get(fb) ?? []) : [];
    }
    for (let i = 0; i < list.length; i++) {
      const item = list[(n + v + d + i) % list.length]!;
      if (!used.has(item.id)) return item;
    }
    return null;
  };

  const toSlot = (item: PlanCatalogItem): PlanSlot => {
    // Вправи з вагою тіла завжди беруть діапазон accessory.
    const range = item.kind === "compound" && item.equipment !== "bodyweight" ? params.compound : params.accessory;
    let sets = baseSets(level, item.kind);
    if (item.kind === "compound" && params.extraCompoundSet && level !== "novice") sets += 1;
    if (params.fewerSets) sets = Math.max(2, sets - 1);
    return { exerciseId: item.id, sets, repMin: range[0], repMax: range[1] };
  };

  const codes = splitFor(profile.daysPerWeek ?? DEFAULTS.daysPerWeek, level);
  const days: PlanDay[] = [];
  for (const [d, code] of codes.entries()) {
    const used = new Set<number>();
    const seen = new Map<Pattern, number>();
    const built: { item: PlanCatalogItem }[] = [];
    for (const pattern of DAY_PATTERNS[code as DayCode].slice(0, maxSlots)) {
      const n = seen.get(pattern) ?? 0;
      seen.set(pattern, n + 1);
      const item = pick(pattern, n, d, used);
      if (!item) continue;
      used.add(item.id);
      built.push({ item });
    }

    let chosen = built.map((b) => b.item);
    if (params.accessoryCap !== null) {
      let acc = 0;
      chosen = chosen.filter((it) => it.kind !== "accessory" || ++acc <= params.accessoryCap!);
    }
    if (params.extraCore && chosen.length >= 6 && chosen.filter((it) => it.pattern === "core").length === 1) {
      const extra = pick("core", 1, d, new Set(chosen.map((it) => it.id)));
      if (extra) chosen.push(extra);
    }

    if (chosen.length < MIN_DAY_SLOTS) return { ok: false, error: "EMPTY_DAY", dayCode: code };
    days.push({ code, title: DAY_TITLES[code]!, slots: chosen.map(toSlot) });
  }

  return { ok: true, plan: { name: `План: ${GOAL_LABELS[goal]}`, days } };
}
