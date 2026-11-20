import { describe, expect, it } from "vitest";
import { addDays, localDate } from "../src/domain/time";
import { avg7, formatChange, formatKg, jumpFrom, parseWeightDg, weekChange, type WeightEntry } from "../src/domain/weight";

const e = (localDate: string, weightDg: number): WeightEntry => ({ localDate, weightDg });
const TODAY = "2026-11-20";

describe("localDate (time.ts)", () => {
  it("P2.1.2: 23:30 і 00:30 за Києвом — різні локальні дати, а не UTC", () => {
    expect(localDate(Date.parse("2026-11-10T21:30:00Z"), "Europe/Kyiv")).toBe("2026-11-10"); // 23:30 EET
    expect(localDate(Date.parse("2026-11-10T22:30:00Z"), "Europe/Kyiv")).toBe("2026-11-11"); // 00:30 EET, UTC ще 10-е
  });

  it("25.10.2026 (перехід на зимовий час): дата правильна до, під час і після зсуву", () => {
    expect(localDate(Date.parse("2026-10-24T21:30:00Z"), "Europe/Kyiv")).toBe("2026-10-25"); // 00:30 EEST
    expect(localDate(Date.parse("2026-10-25T00:59:00Z"), "Europe/Kyiv")).toBe("2026-10-25"); // 03:59 EEST
    expect(localDate(Date.parse("2026-10-25T01:00:00Z"), "Europe/Kyiv")).toBe("2026-10-25"); // 03:00 EET (час «повторився»)
    expect(localDate(Date.parse("2026-10-25T21:30:00Z"), "Europe/Kyiv")).toBe("2026-10-25"); // 23:30 EET — ще та сама доба
    expect(localDate(Date.parse("2026-10-25T22:30:00Z"), "Europe/Kyiv")).toBe("2026-10-26"); // 00:30 EET
  });

  it("addDays: через межу місяця, року й високосний день", () => {
    expect(addDays("2026-11-20", -6)).toBe("2026-11-14");
    expect(addDays("2026-03-02", -6)).toBe("2026-02-24");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("parseWeightDg", () => {
  it("P2.1: «78,4» і «78.4» → 784; обрізає пробіли", () => {
    expect(parseWeightDg("78,4")).toBe(784);
    expect(parseWeightDg("78.4")).toBe(784);
    expect(parseWeightDg(" 78.4 ")).toBe(784);
    expect(parseWeightDg("78")).toBe(780);
    expect(parseWeightDg("100.00")).toBe(1000);
  });

  it("P2.1.4: половина вгору до десятих; межі — після округлення", () => {
    expect(parseWeightDg("78,45")).toBe(785);
    expect(parseWeightDg("78,44")).toBe(784);
    expect(parseWeightDg("29,96")).toBe(300); // → 30,0: приймається
    expect(parseWeightDg("29,94")).toBeNull(); // → 29,9: відмова
    expect(parseWeightDg("30")).toBe(300);
    expect(parseWeightDg("300")).toBe(3000);
    expect(parseWeightDg("300.04")).toBe(3000);
    expect(parseWeightDg("300.05")).toBeNull(); // → 300,1
  });

  it("P2.1.3: 29 · 301 · 3000 · abc · 78.456 · «78,» · порожнє → відмова", () => {
    for (const raw of ["29", "301", "3000", "abc", "78.456", "78,", "78.", ".5", "7", "-78", "78 кг", "", "1e2"]) {
      expect(parseWeightDg(raw), raw).toBeNull();
    }
  });
});

describe("avg7 і weekChange", () => {
  it("P2.1.4: 79,0 · 78,8 · 78,6 і минулий тиждень 79,4 · 79,2 → середнє 78,8, зміна −0,5", () => {
    const entries = [e("2026-11-20", 790), e("2026-11-18", 788), e("2026-11-15", 786), e("2026-11-12", 794), e("2026-11-10", 792)];
    expect(avg7(entries, TODAY)).toEqual({ avgDg: 788, n: 3 });
    expect(weekChange(entries, TODAY)).toBe(-5);
    expect(formatChange(-5)).toBe("−0,5");
  });

  it("пропущені дні не рахуються нулями; вікно — рівно 7 локальних дат (−6…0)", () => {
    const entries = [e("2026-11-14", 800), e("2026-11-13", 900), e("2026-11-20", 780)];
    // 11-13 — за межами W0 (W0 = 14…20), у W1
    expect(avg7(entries, TODAY)).toEqual({ avgDg: 790, n: 2 });
    expect(avg7([], TODAY)).toEqual({ avgDg: null, n: 0 });
  });

  it("середнє: половина вгору до десятих", () => {
    expect(avg7([e("2026-11-20", 784), e("2026-11-19", 785)], TODAY).avgDg).toBe(785); // 784,5 → 785
    expect(avg7([e("2026-11-20", 784), e("2026-11-19", 784), e("2026-11-18", 785)], TODAY).avgDg).toBe(784); // 784,33
  });

  it("зміна: потрібно ≥ 2 записи в обох вікнах", () => {
    const one = [e("2026-11-20", 790), e("2026-11-19", 788), e("2026-11-12", 794)];
    expect(weekChange(one, TODAY)).toBeNull(); // у W1 один запис
    const oneNow = [e("2026-11-20", 790), e("2026-11-12", 794), e("2026-11-11", 792)];
    expect(weekChange(oneNow, TODAY)).toBeNull(); // у W0 один запис
    expect(weekChange([], TODAY)).toBeNull();
  });

  it("зміна рахується з неокруглених середніх і округлюється від нуля; −0,04 → «0,0»", () => {
    // W0: 785,785 (avg 785); W1: 786 ×1 + 785 ×... підберемо −0,4 дг: S0=2·n1…
    // W0: 784,785 (S0=1569,n0=2); W1: 785,785,786 (S1=2356,n1=3): (1569·3 − 2356·2)/6 = (4707−4712)/6 = −0,83 дг → −1 дг = −0,1
    const a = [e("2026-11-20", 784), e("2026-11-19", 785), e("2026-11-13", 785), e("2026-11-12", 785), e("2026-11-11", 786)];
    expect(weekChange(a, TODAY)).toBe(-1);
    // W0: 780,780 (S0=1560); W1: 780,780,781 (S1=2341,n1=3): (1560·3−2341·2)/6 = (4680−4682)/6 = −0,33 → 0
    const b = [e("2026-11-20", 780), e("2026-11-19", 780), e("2026-11-13", 780), e("2026-11-12", 780), e("2026-11-11", 781)];
    expect(weekChange(b, TODAY)).toBe(0);
    expect(formatChange(0)).toBe("0,0");
    expect(formatChange(62)).toBe("+6,2");
  });

  it("половина від нуля: −0,5 дг → −1 дг, +0,5 дг → +1 дг", () => {
    // W0: 780,781 (S0=1561,n0=2); W1: 780,780 (S1=1560,n1=2): (1561·2−1560·2)/4 = +0,5 → +1
    expect(weekChange([e("2026-11-20", 780), e("2026-11-19", 781), e("2026-11-13", 780), e("2026-11-12", 780)], TODAY)).toBe(1);
    expect(weekChange([e("2026-11-20", 780), e("2026-11-19", 780), e("2026-11-13", 780), e("2026-11-12", 781)], TODAY)).toBe(-1);
  });
});

describe("formatKg / jumpFrom", () => {
  it("formatKg: десяткова кома", () => {
    expect(formatKg(784)).toBe("78,4");
    expect(formatKg(300)).toBe("30,0");
    expect(formatKg(3000)).toBe("300,0");
  });

  it("стрибок > 5 кг до попереднього запису ≤ 14 днів; рівно 5,0 — не стрибок; сьогоднішній не враховується", () => {
    expect(jumpFrom([e("2026-11-10", 722)], TODAY, 784)).toBe(62);
    expect(jumpFrom([e("2026-11-10", 834)], TODAY, 784)).toBeNull(); // −5,0 — рівно межа, не більше
    expect(jumpFrom([e("2026-11-10", 834)], TODAY, 783)).toBe(-51); // −5,1
    expect(jumpFrom([e("2026-11-10", 722)], TODAY, 772)).toBeNull(); // +5,0 — не більше
    expect(jumpFrom([e("2026-11-05", 722)], TODAY, 784)).toBeNull(); // 15 днів тому
    expect(jumpFrom([e("2026-11-06", 722)], TODAY, 784)).toBe(62); // рівно 14 днів
    expect(jumpFrom([e("2026-11-20", 722)], TODAY, 784)).toBeNull(); // «попередній» — не сьогодні
  });
});
