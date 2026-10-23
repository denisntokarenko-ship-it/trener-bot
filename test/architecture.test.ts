import { describe, expect, it } from "vitest";

// Сирі тексти файлів підтягує Vite під час збирання тесту (у workerd немає доступу до диска).
const botFiles = import.meta.glob("../src/bot/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const FORBIDDEN = [/from\s+["']drizzle-orm(\/[^"']*)?["']/, /from\s+["'][./]*\/?db\/client["']/, /import\(\s*["']drizzle-orm/];

describe("архітектура", () => {
  it("src/bot/** знайдено (позитивний контроль глоба)", () => {
    expect(Object.keys(botFiles).length).toBeGreaterThan(0);
    expect(Object.values(botFiles).join("\n")).toContain("from \"grammy\"");
  });

  it("src/bot/** не імпортує drizzle-orm і src/db/client", () => {
    const offenders = Object.entries(botFiles).filter(([, src]) => FORBIDDEN.some((re) => re.test(src)));
    expect(offenders.map(([path]) => path)).toEqual([]);
  });

  it("шаблон ловить заборонені імпорти (позитивний контроль)", () => {
    for (const line of ['import { eq } from "drizzle-orm";', "import { sqliteTable } from 'drizzle-orm/sqlite-core';", 'import { createDb } from "../db/client";']) {
      expect(FORBIDDEN.some((re) => re.test(line)), line).toBe(true);
    }
    expect(FORBIDDEN.some((re) => re.test('import type { Repo } from "../db/repo";'))).toBe(false);
  });
});
