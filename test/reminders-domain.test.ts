import { describe, expect, it } from "vitest";
import { dueReminders, parseReminderTime, parseTrainingDays, type ReminderKind, type ReminderUser } from "../src/domain/reminders";
import { isoWeekday, localDayStartUtc, localParts, localTimeUtc, usableTz } from "../src/domain/time";
import { weekRecords } from "../src/domain/week-report";
import type { ProgressSetRow } from "../src/domain/records";

const iso = (ms: number): string => new Date(ms).toISOString();
const KYIV: ReminderUser = { tz: "Europe/Kyiv", trainingDays: "1,3,5", remindTime: "08:00", weighTime: "07:30" };
const kinds = (user: ReminderUser, utc: string): ReminderKind[] => dueReminders(user, Date.parse(utc));

describe("P2.3.11 localDayStartUtc: локальна північ, а не UTC-північ ± 24 год", () => {
  it.each([
    ["2026-10-25", "2026-10-24T21:00:00.000Z"], // доба переходу (25 год): EEST → EET
    ["2026-10-26", "2026-10-25T22:00:00.000Z"],
    ["2027-03-28", "2027-03-27T22:00:00.000Z"], // доба переходу (23 год): EET → EEST
    ["2027-03-29", "2027-03-28T21:00:00.000Z"],
  ])("%s → %s", (date, utc) => {
    expect(iso(localDayStartUtc(date, "Europe/Kyiv"))).toBe(utc);
  });

  it("доба переходу триває 25 і 23 години", () => {
    const hours = (a: string, b: string): number => (localDayStartUtc(b, "Europe/Kyiv") - localDayStartUtc(a, "Europe/Kyiv")) / 3_600_000;
    expect(hours("2026-10-25", "2026-10-26")).toBe(25);
    expect(hours("2027-03-28", "2027-03-29")).toBe(23);
    expect(hours("2026-11-20", "2026-11-21")).toBe(24);
  });

  it("пояс без літнього часу і з додатним зсувом, і західний", () => {
    expect(iso(localDayStartUtc("2026-06-01", "UTC"))).toBe("2026-06-01T00:00:00.000Z");
    expect(iso(localDayStartUtc("2026-06-01", "Asia/Tokyo"))).toBe("2026-05-31T15:00:00.000Z");
    expect(iso(localDayStartUtc("2026-06-01", "America/New_York"))).toBe("2026-06-01T04:00:00.000Z");
  });

  it("опівночі немає (Сантьяго: перехід о 24:00 → 01:00): перший наявний момент дати", () => {
    // Чилі, 2026-09-06: годинники 00:00 → 01:00, локальної опівночі не існує.
    const t = localDayStartUtc("2026-09-06", "America/Santiago");
    expect(localParts(t, "America/Santiago")).toMatchObject({ date: "2026-09-06", minutes: 60 });
    expect(localParts(t - 60_000, "America/Santiago").date).toBe("2026-09-05");
  });
});

describe("localParts / isoWeekday", () => {
  it("дата, хвилини й день тижня — за поясом, не за UTC", () => {
    // 2026-10-25 21:30Z — у Києві (EET, +2) уже 23:30 Нд; о 22:30Z — вже Пн 00:30.
    expect(localParts(Date.parse("2026-10-25T21:30:00Z"), "Europe/Kyiv")).toEqual({ date: "2026-10-25", minutes: 23 * 60 + 30, isoWeekday: 7 });
    expect(localParts(Date.parse("2026-10-25T22:30:00Z"), "Europe/Kyiv")).toEqual({ date: "2026-10-26", minutes: 30, isoWeekday: 1 });
  });
  it("опівніч — година 0, а не 24", () => {
    expect(localParts(Date.parse("2026-11-20T22:00:00Z"), "Europe/Kyiv")).toMatchObject({ date: "2026-11-21", minutes: 0 });
  });
  it("isoWeekday: Пн = 1, Нд = 7", () => {
    expect(isoWeekday("2026-10-19")).toBe(1);
    expect(isoWeekday("2026-10-25")).toBe(7);
  });
  it("невалідний пояс — RangeError (ловить виконавець)", () => {
    expect(() => localParts(0, "Bad/Zone")).toThrow(RangeError);
  });
});

describe("parseTrainingDays / parseReminderTime", () => {
  it.each(["2,1", "1,1", "", "8", "0", "1,,3", "1,3,", ",1", "a", "1;3"])("%j → null", (raw) => {
    expect(parseTrainingDays(raw)).toBeNull();
  });
  it("коректні дні", () => {
    expect(parseTrainingDays("1,3,5")).toEqual([1, 3, 5]);
    expect(parseTrainingDays("7")).toEqual([7]);
  });
  it("час: кратне 15 хв, 05:00–22:00; NULL і зайве — null", () => {
    expect(parseReminderTime("08:15")).toBe(495);
    expect(parseReminderTime("05:00")).toBe(300);
    expect(parseReminderTime("22:00")).toBe(1320);
    for (const bad of [null, "04:45", "22:15", "08:10", "8:00", "08:00:00", "ab:cd", "25:00"]) expect(parseReminderTime(bad), String(bad)).toBeNull();
  });
});

describe("P2.3.4 вікно тіка: T−1, T, T+45, T+60", () => {
  // Пн 2026-10-19, EEST (+3): 08:00 за Києвом = 05:00Z.
  const train = (utc: string) => kinds(KYIV, utc).includes("train");
  it("T−1 — ні; T — так; T+45 — так (без T шле); T+60 — ні", () => {
    expect(train("2026-10-19T04:59:00Z")).toBe(false);
    expect(train("2026-10-19T05:00:00Z")).toBe(true);
    expect(train("2026-10-19T05:45:00Z")).toBe(true);
    expect(train("2026-10-19T06:00:00Z")).toBe(false);
  });
  it("зважування о 07:30 — те саме вікно", () => {
    const weigh = (utc: string) => kinds(KYIV, utc).includes("weigh");
    expect(weigh("2026-10-19T04:29:00Z")).toBe(false);
    expect(weigh("2026-10-19T04:30:00Z")).toBe(true);
    expect(weigh("2026-10-19T05:15:00Z")).toBe(true);
    expect(weigh("2026-10-19T05:30:00Z")).toBe(false);
  });
  it("хвилини всередині вікна рахуються до хвилини (T+59 — так)", () => {
    expect(kinds(KYIV, "2026-10-19T05:59:00Z")).toContain("train");
  });
  it("не день тренування — train немає, weigh є", () => {
    // Вт 2026-10-20
    expect(kinds(KYIV, "2026-10-20T05:00:00Z")).toEqual(["weigh"]);
  });
  it("вимкнено (NULL) — нічого", () => {
    const off = { ...KYIV, remindTime: null, weighTime: null };
    expect(kinds(off, "2026-10-19T05:00:00Z")).toEqual([]);
  });
  it("два нагадування в один тік — обидва в списку (окремі повідомлення)", () => {
    expect(kinds(KYIV, "2026-10-19T05:00:00Z").sort()).toEqual(["train", "weigh"]);
  });
  it("битий training_days — train немає, решта працює", () => {
    expect(kinds({ ...KYIV, trainingDays: "5,1" }, "2026-10-19T05:00:00Z")).toEqual(["weigh"]);
  });
  it("невалідний tz кидає RangeError", () => {
    expect(() => kinds({ ...KYIV, tz: "Bad/Zone" }, "2026-10-19T05:00:00Z")).toThrow(RangeError);
  });
});

describe("P2.3.4 недільний звіт: з 19:00 до кінця доби", () => {
  // Нд 2026-10-25, EET (+2): 19:00 = 17:00Z.
  it("18:59 — ні; 19:00 — так; 20:30 — так; 23:59 — так; Пн 00:00 — ні", () => {
    expect(kinds(KYIV, "2026-10-25T16:59:00Z")).not.toContain("report");
    expect(kinds(KYIV, "2026-10-25T17:00:00Z")).toContain("report");
    expect(kinds(KYIV, "2026-10-25T18:30:00Z")).toContain("report");
    expect(kinds(KYIV, "2026-10-25T21:59:00Z")).toContain("report");
    expect(kinds(KYIV, "2026-10-25T22:00:00Z")).not.toContain("report");
  });
  it("інший день тижня — звіту немає", () => {
    expect(kinds(KYIV, "2026-10-24T17:30:00Z")).not.toContain("report");
  });
});

describe("P2.3.5 переходи часу Europe/Kyiv", () => {
  it("2026-10-25 (EEST → EET): weigh 07:30 = 05:30Z у Нд; у Сб було 04:30Z; remind 08:00 = 06:00Z", () => {
    const weigh = (utc: string) => kinds(KYIV, utc).includes("weigh");
    expect(weigh("2026-10-24T04:30:00Z")).toBe(true); // Сб
    expect(weigh("2026-10-25T04:30:00Z")).toBe(false); // Нд: ще 06:30 за EET… вікно ще не відкрилось: 04:30Z = 06:30 локально
    expect(weigh("2026-10-25T05:29:00Z")).toBe(false);
    expect(weigh("2026-10-25T05:30:00Z")).toBe(true);
    expect(weigh("2026-10-25T05:45:00Z")).toBe(true); // повторний тік у вікні: due (дубль гасить заявка)
    const sunday = { ...KYIV, trainingDays: "7" };
    const train = (utc: string) => kinds(sunday, utc).includes("train");
    expect(train("2026-10-25T05:45:00Z")).toBe(false);
    expect(train("2026-10-25T06:00:00Z")).toBe(true);
    expect(train("2026-10-25T06:45:00Z")).toBe(true); // тік 06:00Z, що випав, покривають 06:15–06:45Z
    expect(train("2026-10-25T07:00:00Z")).toBe(false);
  });

  it("2027-03-28 (EET → EEST): weigh 07:30 = 04:30Z; тіки 04:45–05:15Z компенсують, 05:30Z уже ні; remind 08:00 = 05:00Z", () => {
    const weigh = (utc: string) => kinds(KYIV, utc).includes("weigh");
    expect(weigh("2027-03-28T04:15:00Z")).toBe(false);
    expect(weigh("2027-03-28T04:30:00Z")).toBe(true);
    expect(weigh("2027-03-28T05:15:00Z")).toBe(true); // T+45
    expect(weigh("2027-03-28T05:30:00Z")).toBe(false); // T+60
    const sunday = { ...KYIV, trainingDays: "7" };
    expect(kinds(sunday, "2027-03-28T04:45:00Z")).not.toContain("train");
    expect(kinds(sunday, "2027-03-28T05:00:00Z")).toContain("train");
  });

  it("25.10.2026 08:00 за Києвом — нагадування в правильному вікні (UTC-«08:00» було б хибним)", () => {
    const sunday = { ...KYIV, trainingDays: "7" };
    // 08:00Z — це 10:00 за Києвом: за вікном; 06:00Z — рівно 08:00.
    expect(kinds(sunday, "2026-10-25T08:00:00Z")).not.toContain("train");
    expect(kinds(sunday, "2026-10-25T06:00:00Z")).toContain("train");
  });
});

describe("weekRecords: нові рекорди тижня", () => {
  const T0 = Date.parse("2026-10-19T00:00:00Z");
  const DAY = 86_400_000;
  const row = (exerciseId: number, nameUk: string, workoutId: number, day: number, weightKg: number, reps: number, bodyweight = false): ProgressSetRow => ({
    exerciseId,
    nameUk,
    bodyweight,
    workoutId,
    startedAt: T0 + day * DAY,
    weightKg,
    reps,
  });
  const from = T0;
  const to = T0 + 7 * DAY;

  it("перша сесія вправи — калібрування: рекордом не вважається", () => {
    expect(weekRecords([row(1, "Присідання", 1, 1, 60, 8)], from, to)).toEqual([]);
  });
  it("вага вища за все до тижня — рекорд, повтори — найбільші на цій вазі; приріст у gain", () => {
    const r = weekRecords([row(1, "Присідання", 1, -7, 60, 8), row(1, "Присідання", 2, 1, 62.5, 5), row(1, "Присідання", 2, 1, 62.5, 6)], from, to);
    expect(r).toEqual([{ nameUk: "Присідання", bodyweight: false, weightKg: 62.5, reps: 6, gain: 2.5 }]);
  });
  it("рівна вага — не рекорд; сесія після тижня не впливає", () => {
    const rows = [row(1, "Присідання", 1, -7, 60, 8), row(1, "Присідання", 2, 1, 60, 10), row(1, "Присідання", 3, 9, 70, 5)];
    expect(weekRecords(rows, from, to)).toEqual([]);
  });
  it("друга сесія в тому ж тижні, що й перша, може побити першу", () => {
    const rows = [row(1, "Присідання", 1, 0, 40, 8), row(1, "Присідання", 2, 2, 45, 8)];
    expect(weekRecords(rows, from, to).map((x) => x.weightKg)).toEqual([45]);
  });
  it("перша сесія тижня задає базу: друга, легша за першу, рекордом не є", () => {
    const rows = [row(1, "Присідання", 1, 0, 60, 8), row(1, "Присідання", 2, 2, 50, 8)];
    expect(weekRecords(rows, from, to)).toEqual([]);
  });
  it("вага тіла — рекорд за повторами", () => {
    const r = weekRecords([row(2, "Віджимання", 1, -7, 0, 10, true), row(2, "Віджимання", 2, 1, 0, 12, true)], from, to);
    expect(r).toEqual([{ nameUk: "Віджимання", bodyweight: true, weightKg: 0, reps: 12, gain: 2 }]);
  });
  it("≤ 3: за приростом спадно, за рівності — за назвою", () => {
    const rows = [
      row(1, "Ґ", 1, -7, 10, 5),
      row(1, "Ґ", 2, 1, 15, 5), // +5
      row(2, "Б", 3, -7, 10, 5),
      row(2, "Б", 4, 1, 12.5, 5), // +2,5
      row(3, "А", 5, -7, 10, 5),
      row(3, "А", 6, 1, 12.5, 5), // +2,5
      row(4, "В", 7, -7, 10, 5),
      row(4, "В", 8, 1, 11, 5), // +1 — четвертий, відсікається
    ];
    expect(weekRecords(rows, from, to).map((x) => x.nameUk)).toEqual(["Ґ", "А", "Б"]);
  });
});

describe("localTimeUtc: локальний час доби, у т.ч. доба переходу (межа тижня звіту, Д4 рев'ю 2.3)", () => {
  it.each([
    ["2026-10-18", 19 * 60, "2026-10-18T16:00:00.000Z"], // EEST +3
    ["2026-10-25", 19 * 60, "2026-10-25T17:00:00.000Z"], // доба переходу на EET: 19:00 уже +2
    ["2027-03-28", 19 * 60, "2027-03-28T16:00:00.000Z"], // доба переходу на EEST: 19:00 уже +3
    ["2026-10-25", 0, "2026-10-24T21:00:00.000Z"], // опівночі ще EEST
    ["2026-11-20", 90, "2026-11-19T23:30:00.000Z"],
  ])("Київ %s %i хв → %s", (date, minutes, utc) => {
    expect(iso(localTimeUtc(date, minutes, "Europe/Kyiv"))).toBe(utc);
  });
  it("на захід від UTC: Нью-Йорк 19:00 EDT = 23:00Z, після переходу (EST) = 00:00Z наступної доби", () => {
    expect(iso(localTimeUtc("2026-10-25", 19 * 60, "America/New_York"))).toBe("2026-10-25T23:00:00.000Z");
    expect(iso(localTimeUtc("2026-11-01", 19 * 60, "America/New_York"))).toBe("2026-11-02T00:00:00.000Z");
  });
  it("нуль хвилин збігається з localDayStartUtc", () => {
    expect(localTimeUtc("2026-10-25", 0, "Europe/Kyiv")).toBe(localDayStartUtc("2026-10-25", "Europe/Kyiv"));
  });
});

describe("usableTz: збережений пояс, якого рантайм не приймає, → null", () => {
  it.each([["Europe/Kyiv", "Europe/Kyiv"], ["UTC", "UTC"], ["Mars/Base", null], ["", null], [null, null], [undefined, null]])("%j → %j", (tz, out) => {
    expect(usableTz(tz)).toBe(out);
  });
});
