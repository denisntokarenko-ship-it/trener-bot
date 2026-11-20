import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { isSettingsCb, parseSettingsCb } from "../src/bot/settings-flow";
import { BOT_COMMANDS, settingsText } from "../src/bot/texts";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { dueReminders } from "../src/domain/reminders";
import { defaultTrainingDays, parseTimezone, reminderTimeFrom, toggleTrainingDay } from "../src/domain/settings";
import { OWNER, botInfo, env, fakeTelegram, outgoingProblems, resetDb, textUpdate, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const OTHER = 222;
const NOON = Date.parse("2026-11-20T10:00:00Z");
let tg = fakeTelegram();
let updateId = 1;

async function send(update: Update): Promise<void> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => NOON });
  await handleRequest(webhookRequest(update), env, handler);
}
const say = (text: string) => send(textUpdate(updateId++, OWNER, text));
function cb(data: string): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: "cb" + updateId,
      from: { id: OWNER, is_bot: false, first_name: "Денис" },
      chat_instance: "ci",
      data,
      message: { message_id: 7, date: 0, chat: { id: OWNER, type: "private", first_name: "Денис" }, text: "екран" },
    },
  } as Update;
}
const tap = (data: string) => send(cb(data));
const answers = () => tg.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text as string | undefined);
const lastScreen = () => {
  const c = [...tg.calls].reverse().find((x) => (x.method === "sendMessage" || x.method === "editMessageText") && x.payload.reply_markup)!;
  return { text: String(c.payload.text), buttons: (c.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat() };
};
const settings = () => repo.getUserSettings(OWNER);

beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  updateId = 1;
  await repo.upsertUser(OWNER, "Денис", 0);
  await repo.upsertUser(OTHER, "Інший", 0);
  await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
});
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
});

describe("P2.4 домен", () => {
  it("HH:MM: валідний сітці 15 хв у 05–22, невалідний — ні", () => {
    expect(reminderTimeFrom(8, 15)).toBe("08:15");
    expect(reminderTimeFrom(22, 0)).toBe("22:00");
    expect(reminderTimeFrom(5, 0)).toBe("05:00");
    for (const [h, m] of [[7, 11], [4, 45], [22, 15], [23, 0], [8, 60], [8.5, 0]] as const) expect(reminderTimeFrom(h, m)).toBeNull();
  });

  it("пояс: канонічний регістр; Mars/Base, Etc/*, офсет, 100 символів — відмова", () => {
    expect(parseTimezone("Europe/Warsaw")).toBe(new Intl.DateTimeFormat("en", { timeZone: "Europe/Warsaw" }).resolvedOptions().timeZone);
    expect(parseTimezone("europe/warsaw")).toBe(new Intl.DateTimeFormat("en", { timeZone: "europe/warsaw" }).resolvedOptions().timeZone);
    expect(parseTimezone("europe/warsaw")).toBe("Europe/Warsaw");
    for (const bad of ["Mars/Base", "Etc/GMT+3", "etc/gmt+3", "+02:00", "UTC", "", "A".repeat(100), `Europe/${"a".repeat(40)}`]) expect(parseTimezone(bad)).toBeNull();
  });

  it("дні: перемикач додає за порядком, останній день не знімається", () => {
    expect(toggleTrainingDay("1,3,5", 2)).toBe("1,2,3,5");
    expect(toggleTrainingDay("1,3,5", 3)).toBe("1,5");
    expect(toggleTrainingDay("3", 3)).toBeNull();
    expect(toggleTrainingDay("1,3", 8)).toBeNull();
    expect(defaultTrainingDays(4)).toBe("1,2,4,5");
  });
});

describe("P2.4 repo.updateUserSettings", () => {
  it("невалідне — нічого не пишемо; частковий патч не чіпає решту; null вимикає", async () => {
    expect(await repo.updateUserSettings(OWNER, { remindTime: "07:11" })).toBeNull();
    expect(await repo.updateUserSettings(OWNER, { trainingDays: "3,1" })).toBeNull();
    expect(await repo.updateUserSettings(OWNER, { tz: "Mars/Base" })).toBeNull();
    expect(await repo.updateUserSettings(OWNER, { weighTime: "07:00", tz: "Mars/Base" })).toBeNull();
    expect(await settings()).toEqual({ tz: "Europe/Kyiv", trainingDays: "1,3,5", remindTime: "08:00", weighTime: "07:30" });
    expect(await repo.updateUserSettings(OWNER, { weighTime: null })).toEqual({ tz: "Europe/Kyiv", trainingDays: "1,3,5", remindTime: "08:00", weighTime: null });
  });

  it("неіснуючий користувач → null", async () => {
    expect(await repo.updateUserSettings(999, { remindTime: "09:00" })).toBeNull();
  });
});

describe("P2.4 екран і кнопки", () => {
  it("/nalashtuvannia показує екран без даних профілю; у BOT_COMMANDS", async () => {
    await say("/nalashtuvannia");
    const s = lastScreen();
    expect(s.text).toContain("Дні тренувань: Пн, Ср, Пт");
    expect(s.text).toContain("08:00");
    expect(s.text).toContain("Europe/Kyiv");
    expect(s.text).not.toMatch(/ціль|зріст|стать/i);
    expect(s.buttons.map((b) => b.text)).toEqual(["📅 Дні", "🏋️ Час", "⚖️ Час", "🌍 Пояс", "👤 Профіль"]);
    expect(BOT_COMMANDS.map((c) => c.command)).toContain("nalashtuvannia");
  });

  it("P2.4.1: [Вт] додає день у training_days; останній день не знімається", async () => {
    await tap("s:d:2");
    expect((await settings())!.trainingDays).toBe("1,2,3,5");
    expect(lastScreen().buttons.find((b) => b.text.includes("Вт"))!.text).toContain("✅");
    await repo.updateUserSettings(OWNER, { trainingDays: "4" });
    await tap("s:d:4");
    expect((await settings())!.trainingDays).toBe("4");
    expect(answers().at(-1)).toBe("Потрібен хоча б один день");
  });

  it("P2.4.2: година → хвилини → 08:15; [Вимкнути] → NULL", async () => {
    await tap("s:t:r");
    expect(lastScreen().buttons.map((b) => b.callback_data)).toContain("s:t:r:08");
    await tap("s:t:r:08");
    expect(lastScreen().buttons.map((b) => b.callback_data)).toContain("s:t:r:08:15");
    await tap("s:t:r:08:15");
    expect((await settings())!.remindTime).toBe("08:15");
    await tap("s:t:w:off");
    expect((await settings())!.weighTime).toBeNull();
    expect(lastScreen().text).toContain("Нагадування про вагу: вимкнено");
  });

  it("P2.4.3: /nalashtuvannia Europe/Warsaw змінює tz; europe/warsaw — канонічне; невалідне — відмова без запису", async () => {
    await say("/nalashtuvannia europe/warsaw");
    expect((await settings())!.tz).toBe("Europe/Warsaw");
    for (const bad of ["Mars/Base", "Etc/GMT+3", "+02:00", "x".repeat(100)]) {
      await say(`/nalashtuvannia ${bad}`);
      expect((await settings())!.tz).toBe("Europe/Warsaw");
      expect(String([...tg.calls].reverse().find((c) => c.method === "sendMessage")!.payload.text)).toContain("Не знаю такого поясу");
    }
  });

  it("P2.4.4: застарілі й підроблені callback-и нічого не пишуть", async () => {
    const before = await settings();
    for (const bad of ["s:t:07:11", "s:t:r:07:11", "s:t:r:04", "s:t:r:23", "s:t:x:08", "s:t:r:off:1", "s:d:0", "s:d:8", "s:d:1:2", "s:x", "s:", "s:t:r:8:15", "s:t:r:08:5"]) {
      await tap(bad);
    }
    expect(await settings()).toEqual(before);
    expect(answers().every((a) => a === "Це вже неактуально")).toBe(true);
    await tap("s:t:r:08:15:00"); // 6 сегментів — уже не налаштування; без запису
    expect(await settings()).toEqual(before);
    expect(isSettingsCb("s:1:2:3:4:5:6")).toBe(false); // дія «підхід» потоку /trening
    expect(isSettingsCb("s:t:r:08:15")).toBe(true);
    expect(parseSettingsCb("s:t:r:08:15")).toEqual({ a: "t", kind: "r", hour: 8, minute: 15 });
  });

  it("[🌍 Пояс] підказує команду, [👤 Профіль] відкриває /profil", async () => {
    await tap("s:z");
    expect(answers().at(-1)).toContain("/nalashtuvannia Europe/Warsaw");
    await tap("s:p");
    expect(String([...tg.calls].reverse().find((c) => c.method === "sendMessage")!.payload.text)).toMatch(/Профіль|профіл/i);
  });

  it("різниця днів і плану — примітка лише під екраном", () => {
    const base = { days: [1, 3, 5], remindTime: "08:00", weighTime: null, tz: "Europe/Kyiv" };
    expect(settingsText({ ...base, planDays: 3 })).not.toContain("лише нагадування");
    expect(settingsText({ ...base, days: [1, 2, 3, 5], planDays: 3 })).toContain("План розрахований на 3 дн., обрано 4 — це лише нагадування");
  });
});

describe("P2.4 вплив на нагадування 2.3", () => {
  const MON_0800_KYIV = Date.parse("2026-10-19T05:00:00Z"); // Пн, EEST
  const TUE_0800_KYIV = Date.parse("2026-10-20T05:00:00Z");
  const due = async (t: number) => dueReminders((await repo.getReminderUsers()).find((u) => u.id === OWNER)!, t);

  it("змінені дні: Вт додано — у Вт є train; Пн знято — у Пн немає", async () => {
    expect(await due(TUE_0800_KYIV)).not.toContain("train");
    await tap("s:d:2");
    expect(await due(TUE_0800_KYIV)).toContain("train");
    await tap("s:d:1");
    expect(await due(MON_0800_KYIV)).not.toContain("train");
  });

  it("змінений час нагадування зсуває вікно; вимкнення — нагадування немає", async () => {
    await tap("s:t:r:09:00");
    expect(await due(MON_0800_KYIV)).not.toContain("train");
    expect(await due(MON_0800_KYIV + 3_600_000)).toContain("train");
    await tap("s:t:r:off");
    expect(await due(MON_0800_KYIV + 3_600_000)).not.toContain("train");
  });

  it("змінений пояс зсуває момент нагадування", async () => {
    await say("/nalashtuvannia Europe/Warsaw"); // у жовтні Варшава на годину позаду Києва
    expect(await due(MON_0800_KYIV)).not.toContain("train");
    expect(await due(MON_0800_KYIV + 3_600_000)).toContain("train");
  });
});

describe("P2.4 активація плану скидає дні", () => {
  const accept = async (days: number) => {
    await repo.upsertOnboarding(OWNER, { status: "active", step: "activity" }, 1);
    await repo.upsertProfile(OWNER, { goal: "muscle", level: "mid", daysPerWeek: days }, 1);
    await say("/start");
    const press = (prefix: string) => tap(lastScreen().buttons.find((b) => b.text.includes(prefix))!.callback_data);
    await press("▶️ Продовжити");
    await press("⏭");
    await press("✅ Прийняти");
  };

  it("перший план на 4 дні при дефолтних «1,3,5» → скинуто до 1,2,4,5 з рядком у відповіді", async () => {
    await accept(4);
    expect((await settings())!.trainingDays).toBe("1,2,4,5");
    expect(String([...tg.calls].reverse().find((c) => c.method === "editMessageText")!.payload.text)).toContain("Дні нагадувань скинув");
  });

  it("власні дні при збігу кількості з N не чіпаємо; при розбіжності — скидаємо", async () => {
    await repo.updateUserSettings(OWNER, { trainingDays: "2,3,6,7" });
    await accept(4);
    expect((await settings())!.trainingDays).toBe("2,3,6,7");
    await accept(3);
    expect((await settings())!.trainingDays).toBe("1,3,5");
  });
});
