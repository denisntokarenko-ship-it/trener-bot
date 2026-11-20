import { describe, expect, it } from "vitest";
import { fmtLocalDate, fmtSets, NO_WORKOUTS, programText, progressText } from "../src/bot/progress-view";
import type { ProgramDay, WorkoutSummaryRow } from "../src/db/repo";

const set = (setNo: number, weightKg: number | null, reps: number | null, skipped = false) => ({ setNo, weightKg, reps, skipped });
const ex = (nameUk: string, sets: ReturnType<typeof set>[]) => ({ nameUk, sets });
const wk = (id: number, startedAt: number, over: Partial<WorkoutSummaryRow> = {}): WorkoutSummaryRow => ({
  id,
  dayCode: "A",
  status: "done",
  startedAt,
  effort: 4,
  exercises: [ex("Присідання", [set(1, 60, 8), set(2, 60, 8), set(3, 60, 7)]), ex("Жим лежачи", [set(1, 45, 8), set(2, 45, 8), set(3, 45, 8)])],
  ...over,
});

// 2025-10-23 (чт) 10:00 за Києвом.
const THU = Date.UTC(2025, 9, 23, 7, 0);

describe("fmtLocalDate", () => {
  it("день тижня й дата — локальні", () => {
    expect(fmtLocalDate(THU, "Europe/Kyiv")).toBe("23.10 (чт)");
  });
  it("23:30 UTC — уже наступна доба в Києві, ще та сама в UTC", () => {
    const t = Date.UTC(2025, 9, 23, 23, 30);
    expect(fmtLocalDate(t, "Europe/Kyiv")).toBe("24.10 (пт)");
    expect(fmtLocalDate(t, "UTC")).toBe("23.10 (чт)");
  });
  it("невідомий пояс не валить — Київ", () => {
    expect(fmtLocalDate(THU, "Не/Пояс")).toBe("23.10 (чт)");
  });
});

describe("fmtSets", () => {
  it("однакова вага — повтори через кому", () => {
    expect(fmtSets([set(1, 60, 8), set(2, 60, 8), set(3, 60, 7)])).toBe("60×8,8,7");
  });
  it("зміна ваги в сесії", () => {
    expect(fmtSets([set(1, 45, 5), set(2, 40, 8), set(3, 40, 8)])).toBe("45×5, 40×8,8");
  });
  it("дробова вага з комою", () => {
    expect(fmtSets([set(1, 42.5, 6)])).toBe("42,5×6");
  });
  it("пропуск — «—»", () => {
    expect(fmtSets([set(1, null, null, true), set(2, null, null, true)])).toBe("—,—");
    expect(fmtSets([set(1, 60, 8), set(2, null, null, true)])).toBe("60×8,—");
  });
});

describe("progressText", () => {
  it("немає тренувань", () => {
    expect(progressText([], "Europe/Kyiv")).toBe(NO_WORKOUTS);
    expect(NO_WORKOUTS).toBe("Ще немає тренувань. Почни: /trening");
  });
  it("знімок: нові першими, abandoned — «не завершене»", () => {
    const text = progressText(
      [
        wk(2, THU + 86_400_000 * 2, { dayCode: "B", status: "abandoned", effort: null, exercises: [ex("Румунська тяга зі штангою", [set(1, 50, 7), set(2, null, null, true)])] }),
        wk(1, THU),
      ],
      "Europe/Kyiv",
    );
    expect(text).toBe(
      ["25.10 (сб) · B · не завершене", "Румунська тяга зі штангою 50×7,—", "", "23.10 (чт) · A · 4/5", "Присідання 60×8,8,7 · Жим лежачи 45×8,8,8"].join("\n"),
    );
  });
  it("> 4096 — відкидаються найстаріші, найновіше лишається", () => {
    const long = "Дуже довга назва вправи ".repeat(10).trim();
    const list = Array.from({ length: 5 }, (_, i) =>
      wk(5 - i, THU - i * 86_400_000, { exercises: Array.from({ length: 6 }, () => ex(long, [set(1, 60, 8)])) }),
    );
    const text = progressText(list, "Europe/Kyiv");
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.startsWith("23.10 (чт)")).toBe(true);
    expect(text).not.toContain("19.10");
    expect((text.match(/· A ·/g) ?? []).length).toBeLessThan(5);
  });
});

describe("programText", () => {
  const day = (code: string, names: string[]): ProgramDay => ({
    id: 1,
    programId: 1,
    code,
    position: 1,
    title: null,
    slots: names.map((n, i) => ({ id: i + 1, position: i + 1, sets: 3, repMin: 6, repMax: 10, exercise: { nameUk: n } as never })),
  });
  const model = (activeDayCode: string | null) => ({
    days: [day("A", ["Присідання зі штангою", "Жим лежачи"]), day("B", ["Румунська тяга зі штангою"])],
    next: {
      dayCode: "B",
      lines: [
        { nameUk: "Румунська тяга зі штангою", bodyweight: false, weightKg: 50, targetReps: 7 },
        { nameUk: "Підтягування", bodyweight: true, weightKg: 0, targetReps: 5 },
      ],
    },
    activeDayCode,
  });
  it("знімок без active", () => {
    expect(programText(model(null))).toBe(
      [
        "День A\n1. Присідання зі штангою — 3 × 6–10\n2. Жим лежачи — 3 × 6–10",
        "День B\n1. Румунська тяга зі штангою — 3 × 6–10",
        "➡️ Наступне: день B\nРумунська тяга зі штангою — 50 кг × 7\nПідтягування — власна вага × 5",
      ].join("\n\n"),
    );
  });
  it("є active — додатковий рядок", () => {
    expect(programText(model("A")).endsWith("\n\nЗараз триває: день A — /trening, щоб продовжити")).toBe(true);
  });
});
