import { describe, expect, it } from "vitest";
import { nextDayCode, nextPrescription, type ProgressionExercise, type ProgressionSession } from "../src/domain/progression";

// Спека підтягується сирим текстом: тест звіряє власні рядки з таблицею phase-1.md, а не з пам'яттю автора.
const specRaw = import.meta.glob("../docs/spec/phase-1.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const spec = Object.values(specRaw)[0] ?? "";

type Slot = { sets: number; repMin: number; repMax: number };
type Preset = { ex: ProgressionExercise; slot: Slot };

const SLOT_3x6_10: Slot = { sets: 3, repMin: 6, repMax: 10 };
const SLOT_2x8_12: Slot = { sets: 2, repMin: 8, repMax: 12 };
const base: Preset = { ex: { weightStepKg: 5, minWeightKg: 20 }, slot: SLOT_3x6_10 };
const step25: Preset = { ex: { weightStepKg: 2.5, minWeightKg: 20 }, slot: SLOT_3x6_10 };
const dumbbell: Preset = { ex: { weightStepKg: 2, minWeightKg: 2 }, slot: SLOT_2x8_12 };
const bodyweight: Preset = { ex: { weightStepKg: 0, minWeightKg: 0 }, slot: { sets: 3, repMin: 8, repMax: 12 } };

/** Запис сесії зі спеки: `60×6,60×5,—` + `[e]`; `(з N)` — заплановані підходи. */
function parseHistory(h: string, defaultSets: number): ProgressionSession[] {
  if (h === "—") return [];
  return h.split("; ").map((part) => {
    const m = part.match(/^(\S+)(?: \(з (\d+)\))? \[(\d|—)\]$/);
    if (!m) throw new Error(`не розібрано: ${part}`);
    const sets = m[1]!.split(",").map((x, i) => {
      if (x === "—") return { setNo: i + 1, weightKg: null, reps: null, skipped: true };
      const [w, r] = x.split("×");
      return { setNo: i + 1, weightKg: Number(w), reps: Number(r), skipped: false };
    });
    return { plannedSets: m[2] ? Number(m[2]) : defaultSets, effort: m[3] === "—" ? null : Number(m[3]), sets };
  });
}

// [№ рядка, назва, історія (як у спеці, без бектиків), призначення, правило, пресет]
const CASES: [number, string, string, string, string, Preset][] = [
  [1, "немає історії", "—", "20 × 6", "1", base],
  [2, "лише пропущені", "—,—,— [3]", "20 × 6", "1", base],
  [3, "калібрування завершене", "50×8,50×8,50×8 [3]", "50 × 9", "3", base],
  [4, "рівно rep_max", "40×10,40×10,40×10 [3]", "45 × 6", "2", base],
  [5, "rep_max − 1", "40×9,40×9,40×9 [3]", "40 × 10", "3", base],
  [6, "один підхід rep_min − 1, одна невдача", "40×6,40×6,40×5 [4]", "40 × 7", "3", base],
  [7, "невдача + rep_max у тій самій сесії", "40×10,40×10,40×5 [4]", "40 × 10", "3", base],
  [8, "дві невдачі поспіль, крок 5", "60×6,60×6,60×5 [4]; 60×6,60×5,60×5 [4]", "50 × 6", "4", base],
  [9, "невдача, норма, невдача", "60×5,60×6,60×6 [4]; 60×8,60×8,60×7 [3]; 60×6,60×6,60×5 [4]", "60 × 7", "3", base],
  [10, "розвантаження скидає лічильник", "60×6,60×6,60×5 [4]; 60×6,60×5,60×5 [4]; 50×6,50×6,50×5 [4]", "50 × 7", "3", base],
  [11, "дві невдачі на мінімальній вазі", "20×5,20×5,20×5 [4]; 20×4,20×4,20×4 [5]", "20 × 6", "4 + 6", base],
  [12, "оцінка 5", "40×10,40×10,40×10 [5]", "40 × 10", "5", base],
  [13, "оцінка 5 двічі поспіль", "40×10,40×10,40×10 [5]; 40×10,40×10,40×10 [5]", "45 × 6", "2", base],
  [14, "пропущений підхід блокує підвищення", "40×10,40×10,— [3]", "40 × 10", "3", base],
  [15, "пропущений підхід — не невдача", "60×7,60×7,— [3]; 60×7,60×7,— [3]", "60 × 8", "3", base],
  [16, "тренування обірвалось (abandoned)", "40×10,40×10 (з 3) [—]", "40 × 10", "3", base],
  [17, "вагу змінено посеред вправи", "45×5,40×8,40×8 [3]", "40 × 9", "3", base],
  [18, "крок 2,5 (мін 20), підвищення", "40×10,40×10,40×10 [3]", "42,5 × 6", "2", step25],
  [19, "крок 2,5, розвантаження", "60×6,60×6,60×5 [4]; 60×6,60×5,60×5 [4]", "52,5 × 6", "4", step25],
  [20, "гантелі, крок 2, слот 2 × 8–12", "12×12,12×12 [3]", "14 × 8", "2", dumbbell],
  [21, "гантелі, розвантаження", "20×7,20×8 [4]; 20×7,20×7 [4]", "18 × 8", "4", dumbbell],
  [22, "вага тіла, слот 3 × 8–12, стеля", "0×12,0×12,0×12 [3]", "0 × 12", "2", bodyweight],
  [23, "W поза кроком (крок у каталозі змінили)", "42×8,42×8,42×8 [3]", "40 × 9", "3 + 6", base],
  [24, "rep_min — не невдача", "60×6,60×6,60×6 [3]; 60×6,60×6,60×6 [3]", "60 × 7", "3", base],
  [25, "правило 3 не опускає повтори нижче rep_min", "40×4,40×4,40×4 [3]", "40 × 6", "3", base],
  [26, "повністю пропущена сесія між невдачами", "60×6,60×6,60×5 [4]; —,—,— [3]; 60×6,60×5,60×5 [4]", "50 × 6", "4", base],
  [27, "оцінка 5 двічі, але W різна", "40×10,40×10,40×10 [5]; 45×10,45×10,45×10 [5]", "45 × 10", "5", base],
];

const REASON_BY_RULE: Record<string, string> = { "1": "calibration", "2": "increase", "3": "reps", "4": "deload", "5": "hold" };
const fmt = (kg: number) => String(kg).replace(".", ",");

describe("nextPrescription — рядки таблиці «історія → призначення» (phase-1.md)", () => {
  for (const [n, title, hist, want, rule, p] of CASES) {
    it(`рядок ${n}: ${title}`, () => {
      const got = nextPrescription(parseHistory(hist, p.slot.sets), p.ex, p.slot);
      expect(`${fmt(got.weightKg)} × ${got.targetReps}`).toBe(want);
      expect(got.reason).toBe(REASON_BY_RULE[rule.slice(0, 1)]);
    });
  }

  it("таблиця у спеці збігається з рядками тесту (проти дрейфу)", () => {
    const start = spec.indexOf("**Таблиця «історія → призначення».**");
    expect(start).toBeGreaterThan(0);
    const rows = spec
      .slice(start)
      .split("\n")
      .filter((l) => /^\| \d+ \|/.test(l))
      .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
    expect(rows.length).toBe(CASES.length);
    for (const [num, , hist, prescription, rule] of rows) {
      const c = CASES.find((x) => x[0] === Number(num));
      expect(c, `рядок ${num} є в тесті`).toBeDefined();
      expect(hist!.replace(/`/g, ""), `історія рядка ${num}`).toBe(c![2]);
      expect(prescription, `призначення рядка ${num}`).toBe(c![3]);
      expect(rule, `правило рядка ${num}`).toBe(c![4]);
    }
  });
});

describe("nextPrescription — вага кратна кроку й ≥ мінімуму (P1.2.2)", () => {
  const check = (w: number, p: Preset) => {
    const step = p.ex.weightStepKg;
    expect(w).toBeGreaterThanOrEqual(p.ex.minWeightKg);
    if (step > 0) expect(Math.round(w * 1000) % Math.round(step * 1000)).toBe(0);
  };
  it("усі входи таблиці", () => {
    for (const [, , hist, , , p] of CASES) check(nextPrescription(parseHistory(hist, p.slot.sets), p.ex, p.slot).weightKg, p);
  });
  it("детермінований розгін випадкових історій", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const presets = [base, step25, dumbbell, bodyweight];
    for (let i = 0; i < 2000; i++) {
      const p = presets[rnd(presets.length)]!;
      const sessions: ProgressionSession[] = Array.from({ length: rnd(5) }, () => ({
        plannedSets: p.slot.sets,
        effort: [null, 1, 3, 5][rnd(4)]!,
        sets: Array.from({ length: rnd(p.slot.sets + 1) }, (_, k) =>
          rnd(5) === 0
            ? { setNo: k + 1, weightKg: null, reps: null, skipped: true }
            : { setNo: k + 1, weightKg: 7 + rnd(90) + (rnd(2) ? 0.5 : 0), reps: rnd(p.slot.repMax + 3), skipped: false },
        ),
      }));
      check(nextPrescription(sessions, p.ex, p.slot).weightKg, p);
    }
  });
});

describe("nextDayCode (P1.2.3)", () => {
  const days = [
    { code: "B", position: 2 },
    { code: "A", position: 1 },
  ];
  it("немає done-тренувань → перший день за position", () => expect(nextDayCode(null, days)).toBe("A"));
  it("останнє done — A → B", () => expect(nextDayCode({ dayCode: "A" }, days)).toBe("B"));
  it("останнє done — B → A по колу", () => expect(nextDayCode({ dayCode: "B" }, days)).toBe("A"));
  it("невідомий код останнього дня → перший день", () => expect(nextDayCode({ dayCode: "Z" }, days)).toBe("A"));
  it("порожня програма — помилка, не мовчазне значення", () => expect(() => nextDayCode(null, [])).toThrow(RangeError));
});
