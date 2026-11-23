import { NO_UNITS } from "../src/domain/units";
import { describe, expect, it } from "vitest";
import { buildProgress, epley, roundHalfKg, type ProgressSetRow } from "../src/domain/records";
import { fullProgressText, weightModel } from "../src/bot/progress-view";
import { TELEGRAM_TEXT_MAX } from "../src/bot/texts";

const row = (o: Partial<ProgressSetRow> & { weightKg: number; reps: number }): ProgressSetRow => ({
  exerciseId: 1,
  nameUk: "Присідання зі штангою",
  bodyweight: false,
  units: NO_UNITS,
  workoutId: 1,
  startedAt: 1_000,
  ...o,
});
const DAY = 86_400_000;

describe("e1RM за Еплі (P2.2.1, P2.2.3)", () => {
  it("відомі значення: 60×8 → 76, 62,5×6 → 75, 100×10 → 133,3", () => {
    expect(epley(60, 8)).toBeCloseTo(76, 10);
    expect(epley(62.5, 6)).toBeCloseTo(75, 10);
    expect(epley(100, 10)).toBeCloseTo(133.333, 3);
  });

  it("один повтор → e1RM = вага", () => {
    expect(epley(100, 1)).toBe(100);
    expect(epley(82.5, 1)).toBe(82.5);
  });

  it("відображення до 0,5 кг", () => {
    expect(roundHalfKg(76)).toBe(76);
    expect(roundHalfKg(133.33)).toBe(133.5);
    expect(roundHalfKg(75.2)).toBe(75);
    expect(roundHalfKg(75.8)).toBe(76);
  });
});

describe("buildProgress", () => {
  const sessions: ProgressSetRow[] = [
    row({ workoutId: 1, startedAt: 1 * DAY, weightKg: 40, reps: 8 }),
    row({ workoutId: 2, startedAt: 4 * DAY, weightKg: 62.5, reps: 6 }),
    row({ workoutId: 2, startedAt: 4 * DAY, weightKg: 60, reps: 8 }),
  ];

  it("P2.2.1: старт 40×8 → зараз 60×8 (найкращий за e1RM), рекорд 62,5×6 з датою, e1RM 76", () => {
    const [e] = buildProgress(sessions);
    expect(e!.start).toEqual({ weightKg: 40, reps: 8 });
    expect(e!.now).toEqual({ weightKg: 60, reps: 8 });
    expect(e!.record).toEqual({ weightKg: 62.5, reps: 6, at: 4 * DAY });
    expect(e!.e1rm).toBe(76);
  });

  it("рекорд за рівної ваги — з більшою кількістю повторів", () => {
    const [e] = buildProgress([
      row({ workoutId: 1, startedAt: 1 * DAY, weightKg: 60, reps: 5 }),
      row({ workoutId: 1, startedAt: 1 * DAY, weightKg: 60, reps: 8 }),
      row({ workoutId: 1, startedAt: 1 * DAY, weightKg: 60, reps: 6 }),
      row({ workoutId: 2, startedAt: 2 * DAY, weightKg: 50, reps: 12 }),
    ]);
    expect(e!.record).toEqual({ weightKg: 60, reps: 8, at: 1 * DAY });
  });

  it("рекорд за рівної ваги: більше повторів пізніше витісняє менше раніше", () => {
    const [e] = buildProgress([row({ workoutId: 1, startedAt: 1 * DAY, weightKg: 60, reps: 5 }), row({ workoutId: 2, startedAt: 2 * DAY, weightKg: 60, reps: 9 })]);
    expect(e!.record).toEqual({ weightKg: 60, reps: 9, at: 2 * DAY });
  });

  it("P2.2.2: лише підходи з r > 10 — без e1RM; рекорд і «зараз» — за вагою", () => {
    const [e] = buildProgress([row({ weightKg: 20, reps: 15 }), row({ weightKg: 25, reps: 12 })]);
    expect(e!.e1rm).toBeNull();
    expect(e!.now).toEqual({ weightKg: 25, reps: 12 });
    expect(e!.record.weightKg).toBe(25);
  });

  it("підхід 20×15 не бере участі в e1RM, коли є інший з r ≤ 10", () => {
    const [e] = buildProgress([row({ weightKg: 50, reps: 15 }), row({ weightKg: 40, reps: 8 })]);
    expect(e!.now).toEqual({ weightKg: 40, reps: 8 });
    expect(e!.e1rm).toBe(roundHalfKg(epley(40, 8)));
  });

  it("P2.2.3: 40 сесій — рекорд із першої не залежить від вікна", () => {
    const rows: ProgressSetRow[] = [];
    for (let i = 1; i <= 40; i++) rows.push(row({ workoutId: i, startedAt: i * DAY, weightKg: i === 1 ? 100 : 20, reps: i === 1 ? 5 : 8 }));
    const [e] = buildProgress(rows);
    expect(e!.record).toEqual({ weightKg: 100, reps: 5, at: 1 * DAY });
    expect(e!.start).toEqual({ weightKg: 100, reps: 5 });
    expect(e!.now).toEqual({ weightKg: 20, reps: 8 });
  });

  it("вага тіла: повтори, без e1RM", () => {
    const [e] = buildProgress([
      row({ bodyweight: true, workoutId: 1, startedAt: 1 * DAY, weightKg: 0, reps: 8 }),
      row({ bodyweight: true, workoutId: 2, startedAt: 2 * DAY, weightKg: 0, reps: 12 }),
    ]);
    expect(e!.e1rm).toBeNull();
    expect(e!.record).toEqual({ weightKg: 0, reps: 12, at: 2 * DAY });
    expect(e!.start.reps).toBe(8);
  });

  it("порожня історія → порожній список; підходи з 0 повторів не рахуються", () => {
    expect(buildProgress([])).toEqual([]);
    expect(buildProgress([row({ weightKg: 50, reps: 0 })])).toEqual([]);
  });

  it("порядок: нові зверху за датою останньої сесії", () => {
    const out = buildProgress([
      row({ exerciseId: 1, nameUk: "А", workoutId: 1, startedAt: 1 * DAY, weightKg: 10, reps: 5 }),
      row({ exerciseId: 2, nameUk: "Б", workoutId: 2, startedAt: 3 * DAY, weightKg: 10, reps: 5 }),
      row({ exerciseId: 1, nameUk: "А", workoutId: 3, startedAt: 5 * DAY, weightKg: 10, reps: 5 }),
    ]);
    expect(out.map((e) => e.nameUk)).toEqual(["А", "Б"]);
  });
});

describe("текст екрана", () => {
  const emptyWeight = weightModel({ profileKg: null, recent: [], first: null, last: null, today: "2025-10-30" });
  const e = (d: string, dg: number) => ({ localDate: d, weightDg: dg });

  it("фіксовані дані: рядки старт → зараз, рекорд з датою, e1RM", () => {
    const ex = buildProgress([
      row({ workoutId: 1, startedAt: Date.UTC(2025, 9, 20, 6), weightKg: 40, reps: 8 }),
      row({ workoutId: 2, startedAt: Date.UTC(2025, 9, 23, 6), weightKg: 62.5, reps: 6 }),
      row({ workoutId: 2, startedAt: Date.UTC(2025, 9, 23, 6), weightKg: 60, reps: 8 }),
    ]);
    expect(fullProgressText(ex, emptyWeight, "Europe/Kyiv")).toBe(
      "📈 <b>Прогрес</b>\n<b>Присідання зі штангою</b>\n   Старт 40 × 8 → зараз 60 × 8 · рекорд 62,5 × 6 (23.10)\n   e1RM ≈ 76 кг",
    );
  });

  it("вага тіла: анкета → середнє, зміна, три вікна (приклад зі спеки)", () => {
    const m = weightModel({
      profileKg: 82,
      recent: [e("2025-10-10", 800), e("2025-10-12", 802), e("2025-10-18", 798), e("2025-10-20", 798), e("2025-10-26", 794), e("2025-10-28", 794), e("2025-10-30", 794)],
      first: null,
      last: e("2025-10-30", 794),
      today: "2025-10-30",
    });
    expect(fullProgressText([], m, "Europe/Kyiv")).toBe(
      "📈 <b>Прогрес</b>\n⚖️ Вага: 82,0 (анкета) → 79,4 (середнє 7 днів) · −2,6 кг\n   Тиждень до тижня: −0,4 кг · 7-денні вікна: 80,1 · 79,8 · 79,4",
    );
  });

  it("1–2 зважування — з приміткою; без записів у W0 — остання вага з датою", () => {
    const a = weightModel({ profileKg: null, recent: [e("2025-10-30", 790)], first: e("2025-10-30", 790), last: e("2025-10-30", 790), today: "2025-10-30" });
    expect(fullProgressText([], a, "Europe/Kyiv")).toContain("⚖️ Вага: 79,0 (середнє 7 днів · 1 зваж.)");
    const b = weightModel({ profileKg: 82, recent: [], first: e("2025-09-01", 800), last: e("2025-09-01", 800), today: "2025-10-30" });
    expect(fullProgressText([], b, "Europe/Kyiv")).toContain("82,0 (анкета) → 80,0 (остання 01.09) · −2,0 кг");
  });

  it("> 4096 → відкинуто вправи зі старішою останньою сесією, найновіша лишається", () => {
    const rows: ProgressSetRow[] = [];
    for (let i = 1; i <= 80; i++) rows.push(row({ exerciseId: i, nameUk: `Вправа з довгою назвою номер ${i}`, workoutId: i, startedAt: i * DAY, weightKg: 50, reps: 8 }));
    const text = fullProgressText(buildProgress(rows), emptyWeight, "Europe/Kyiv");
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(text).toContain("номер 80<");
    expect(text).not.toContain("номер 1<");
    expect(text.endsWith("…")).toBe(false); // відкинуто цілими блоками, а не обрізано clip-ом
  });
});
