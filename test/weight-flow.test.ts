import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { seedStatements } from "../scripts/seed-core";
import { handleRequest, telegramHandler } from "../src/app";
import { BOT_COMMANDS } from "../src/bot/texts";
import { createDb } from "../src/db/client";
import { createRepo } from "../src/db/repo";
import { OWNER, STRANGER, botInfo, env, fakeTelegram, outgoingProblems, resetDb, textUpdate, webhookRequest } from "./helpers";

const repo = createRepo(createDb(env.DB));
const NOON = Date.parse("2026-11-20T10:00:00Z"); // 12:00 за Києвом
let nowMs = NOON;
let tg = fakeTelegram();
let updateId = 1;

async function send(update: Update): Promise<void> {
  const handler = telegramHandler(env, { fetch: tg.fetch, botInfo, now: () => nowMs });
  await handleRequest(webhookRequest(update), env, handler);
}
const say = (text: string) => send(textUpdate(updateId++, OWNER, text));
const reply = () => String([...tg.calls].reverse().find((c) => c.method === "sendMessage")!.payload.text);
const rows = () =>
  env.DB.prepare("SELECT user_id, local_date, weight_dg, updated_at FROM body_weights ORDER BY local_date")
    .all<{ user_id: number; local_date: string; weight_dg: number; updated_at: number }>()
    .then((r) => r.results);

beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  nowMs = NOON;
  updateId = 1;
  await repo.upsertUser(OWNER, "Денис", 0);
});
afterEach(() => {
  expect(outgoingProblems(tg.calls)).toEqual([]);
});

describe("P2.1.1 /vaga: запис і перезапис", () => {
  it("перший запис: рядок за локальну дату, відповідь з середнім і приміткою «1 зваж.»", async () => {
    await say("/vaga 78,4");
    expect(await rows()).toEqual([{ user_id: OWNER, local_date: "2026-11-20", weight_dg: 784, updated_at: NOON }]);
    expect(reply()).toBe("⚖️ 78,4 кг записано (середнє за 7 днів: 78,4 кг (1 зваж.))");
  });

  it("два зважування за день → один рядок з останнім значенням, відповідь «замінило 78,4»", async () => {
    await say("/vaga 78,4");
    nowMs += 3_600_000;
    await say("/vaga 78.0");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ weight_dg: 780, updated_at: nowMs });
    // В1 рев'ю: сьогоднішнє старе значення не входить у середнє вдруге
    expect(reply()).toBe("⚖️ 78,0 кг записано, замінило 78,4 (середнє за 7 днів: 78,0 кг (1 зваж.))");
  });

  it("«78,4» і «78.4» дають однаковий запис; 78,45 → 78,5", async () => {
    await say("/vaga 78,4");
    const a = (await rows())[0]!.weight_dg;
    await resetDb();
    await repo.upsertUser(OWNER, "Денис", 0);
    await say("/vaga 78.4");
    expect((await rows())[0]!.weight_dg).toBe(a);
    await say("/vaga 78,45");
    expect((await rows())[0]!.weight_dg).toBe(785);
    expect(reply()).toContain("78,5 кг записано");
  });

  it("середнє за 7 днів із пропущеними днями; з трьох записів — без примітки", async () => {
    await repo.upsertBodyWeight(OWNER, "2026-11-14", 790, 0);
    await repo.upsertBodyWeight(OWNER, "2026-11-17", 786, 0);
    await say("/vaga 78.2"); // (790 + 786 + 782) / 3 = 786
    expect(reply()).toBe("⚖️ 78,2 кг записано (середнє за 7 днів: 78,6 кг)");
  });
});

describe("P2.1.2 локальна дата, не UTC", () => {
  it("23:30 і 00:30 за Києвом → різні дати; запис 00:30 не перезаписує 23:30", async () => {
    nowMs = Date.parse("2026-11-10T21:30:00Z"); // 23:30 EET, UTC — ще 10-е
    await say("/vaga 80");
    nowMs = Date.parse("2026-11-10T22:30:00Z"); // 00:30 EET 11-го, UTC — ще 10-е
    await say("/vaga 79");
    expect((await rows()).map((r) => [r.local_date, r.weight_dg])).toEqual([
      ["2026-11-10", 800],
      ["2026-11-11", 790],
    ]);
  });

  it("25.10.2026 (перехід на зимовий час): 00:30 EEST і 23:30 EET — одна дата, 00:30 наступної доби — нова", async () => {
    nowMs = Date.parse("2026-10-24T21:30:00Z");
    await say("/vaga 80");
    nowMs = Date.parse("2026-10-25T21:30:00Z");
    await say("/vaga 79");
    nowMs = Date.parse("2026-10-25T22:30:00Z");
    await say("/vaga 78");
    expect((await rows()).map((r) => [r.local_date, r.weight_dg])).toEqual([
      ["2026-10-25", 790],
      ["2026-10-26", 780],
    ]);
  });

  it("часовий пояс береться з users.tz", async () => {
    await env.DB.prepare("UPDATE users SET tz = 'America/New_York' WHERE id = ?").bind(OWNER).run();
    nowMs = Date.parse("2026-11-20T03:00:00Z"); // у Нью-Йорку ще 19-те
    await say("/vaga 80");
    expect((await rows())[0]!.local_date).toBe("2026-11-19");
  });

  // Рев'ю 2.1, дрібниця 3: рядок users.tz, якого Intl не приймає (запис у БД поза ботом), не має ламати /vaga на кожному виклику.
  it.each(["Mars/Base", "Europe/Kiev2", ""])("невалідний users.tz «%s» → /vaga працює з дефолтним поясом, без «Щось пішло не так»", async (tz) => {
    await env.DB.prepare("UPDATE users SET tz = ? WHERE id = ?").bind(tz, OWNER).run();
    await say("/vaga 78,4");
    expect(reply()).toBe("⚖️ 78,4 кг записано (середнє за 7 днів: 78,4 кг (1 зваж.))");
    expect((await rows())[0]!.local_date).toBe("2026-11-20"); // 12:00 за Києвом (дефолт)
    await say("/vaga");
    expect(reply()).toContain("78,4");
    expect(await repo.getUserTz(OWNER)).toBeNull();
  });

  it("getUserTz: валідний пояс повертається як є, користувача немає — null", async () => {
    await env.DB.prepare("UPDATE users SET tz = 'America/New_York' WHERE id = ?").bind(OWNER).run();
    expect(await repo.getUserTz(OWNER)).toBe("America/New_York");
    expect(await repo.getUserTz(STRANGER)).toBeNull();
  });
});

// Рев'ю 2.1, дрібниця 1: читання «попереднього» й запис не мають розходитися між запитами.
describe("атомарність запису ваги", () => {
  it("паралельні дубль-апдейти: «замінило» йде ланцюжком (кожен бачить значення попереднього запису), а не обидва — старе", async () => {
    await repo.upsertBodyWeight(OWNER, "2026-11-20", 790, 1);
    const [a, b] = await Promise.all([repo.upsertBodyWeight(OWNER, "2026-11-20", 780, 2), repo.upsertBodyWeight(OWNER, "2026-11-20", 770, 3)]);
    expect([a, b].sort()).toEqual([780, 790]);
    expect(await repo.getLastWeight(OWNER)).toMatchObject({ weightDg: 770 });
  });

  it("saveBodyWeight: вікно ДО запису (зі старим значенням дня) і replaced з того самого знімка; вікно ≤ localDate, лише свої рядки", async () => {
    await repo.upsertUser(STRANGER, "Інший", 0);
    await repo.upsertBodyWeight(STRANGER, "2026-11-19", 500, 1);
    for (const [d, v] of [["2026-11-05", 810], ["2026-11-08", 800], ["2026-11-20", 790], ["2026-11-21", 700]] as const) await repo.upsertBodyWeight(OWNER, d, v, 1);
    const r = await repo.saveBodyWeight(OWNER, "2026-11-20", 780, 5, "2026-11-06");
    expect(r).toEqual({
      before: [
        { localDate: "2026-11-08", weightDg: 800 },
        { localDate: "2026-11-20", weightDg: 790 },
      ],
      replaced: 790,
    });
    expect(await repo.getWeights(OWNER, "2026-11-20", "2026-11-20")).toEqual([{ localDate: "2026-11-20", weightDg: 780 }]);
    expect((await repo.saveBodyWeight(OWNER, "2026-12-01", 770, 6, "2026-11-17")).replaced).toBeNull();
  });
});

describe("P2.1.3 невалідне", () => {
  it.each(["29", "301", "3000", "abc", "78.456", "78,", "29,94", "300.05"])("«/vaga %s» → жодного запису, підказка формату", async (arg) => {
    await say(`/vaga ${arg}`);
    expect(await rows()).toEqual([]);
    expect(reply()).toBe("Не схоже на вагу. Приклад: /vaga 78.4");
  });

  it("29,96 → 30,0 приймається; 300 приймається", async () => {
    await say("/vaga 29,96");
    expect((await rows())[0]!.weight_dg).toBe(300);
    await say("/vaga 300");
    expect((await rows())[0]!.weight_dg).toBe(3000);
  });

  it("CHECK у БД: 29,9 і 300,1 не пройдуть навіть повз домен", async () => {
    await expect(repo.upsertBodyWeight(OWNER, "2026-11-20", 299, 0)).rejects.toThrow();
    await expect(repo.upsertBodyWeight(OWNER, "2026-11-20", 3001, 0)).rejects.toThrow();
  });
});

describe("/vaga без числа і стрибок", () => {
  it("немає записів → підказка; є — остання вага з датою, середнє й приклад", async () => {
    await say("/vaga");
    expect(reply()).toBe("⚖️ Ще немає записів ваги.\nЗаписати: /vaga 78.4");
    await repo.upsertBodyWeight(OWNER, "2026-11-01", 800, 0); // давно: поза вікном середнього
    await say("/vaga");
    expect(reply()).toBe("⚖️ Остання вага: 80,0 кг (01.11)\nСереднє за 7 днів: —\nЗаписати: /vaga 78.4");
    expect(await rows()).toHaveLength(1); // читання нічого не пише
  });

  it("стрибок > 5 кг до попереднього запису ≤ 14 днів тому — приймається з рядком про різницю", async () => {
    await repo.upsertBodyWeight(OWNER, "2026-11-15", 722, 0);
    await say("/vaga 78.4");
    expect((await rows()).at(-1)!.weight_dg).toBe(784);
    expect(reply()).toContain("\nРізниця +6,2 кг — якщо помилка, надішли ще раз: /vaga 78.4");
  });

  it("різниця рівно 5,0 кг і запис старший за 14 днів — без попередження", async () => {
    await repo.upsertBodyWeight(OWNER, "2026-11-15", 734, 0);
    await say("/vaga 78.4");
    expect(reply()).not.toContain("Різниця");
    await resetDb();
    await repo.upsertUser(OWNER, "Денис", 0);
    await repo.upsertBodyWeight(OWNER, "2026-11-05", 700, 0);
    await say("/vaga 78.4");
    expect(reply()).not.toContain("Різниця");
  });
});

describe("P2.1.5 і крок 5: число без команди", () => {
  it("голе число без очікування ваги вправи — лише підказка, у body_weights нічого", async () => {
    await say("78.4");
    expect(reply()).toContain("Вагу тіла записують так: /vaga 78.4");
    await say("45");
    expect(reply()).toContain("/vaga 78.4");
    expect(await rows()).toEqual([]);
  });

  it("не число — звичайне «Не зрозумів» без підказки про вагу", async () => {
    await say("привіт");
    expect(reply()).not.toContain("/vaga");
  });

  it("await_input ≠ NULL і число → це вага вправи, body_weights порожня", async () => {
    await env.DB.batch(seedStatements(0).map((s) => env.DB.prepare(s)));
    await say("/trening");
    const cbFrom = (data: string): Update =>
      ({
        update_id: updateId++,
        callback_query: {
          id: "c0",
          from: { id: OWNER, is_bot: false, first_name: "Д" },
          chat_instance: "ci",
          data,
          message: { message_id: 7, date: 0, chat: { id: OWNER, type: "private", first_name: "Д" }, text: "екран" },
        },
      }) as Update;
    // Новий день починається з екрана розминки: [⏭ Пропустити] веде до першої вправи.
    const warmupKb = [...tg.calls].reverse().find((c) => c.method === "sendMessage")!.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    await send(cbFrom(warmupKb.inline_keyboard.flat().find((b) => b.text.includes("Пропустити"))!.callback_data));
    const markup = [...tg.calls].reverse().find((c) => c.method === "editMessageText")!.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const data = markup.inline_keyboard.flat().find((b) => b.text.startsWith("⚖️"))!.callback_data;
    await send({
      update_id: updateId++,
      callback_query: {
        id: "c1",
        from: { id: OWNER, is_bot: false, first_name: "Д" },
        chat_instance: "ci",
        data,
        message: { message_id: 7, date: 0, chat: { id: OWNER, type: "private", first_name: "Д" }, text: "екран" },
      },
    } as Update);
    await say("45");
    expect(await rows()).toEqual([]);
    const w = await env.DB.prepare("SELECT await_input FROM workouts").first<{ await_input: string | null }>();
    expect(w?.await_input).toBeNull(); // число прийняла вправа
    expect(tg.calls.some((c) => c.method === "editMessageText" && String(c.payload.text).includes("45 кг"))).toBe(true);
  });
});

describe("репо й меню", () => {
  it("N8: getWeights/getLastWeight бачать лише рядки свого userId; діапазон включний", async () => {
    await repo.upsertUser(STRANGER, "Інший", 0);
    await repo.upsertBodyWeight(OWNER, "2026-11-10", 800, 0);
    await repo.upsertBodyWeight(OWNER, "2026-11-12", 790, 0);
    await repo.upsertBodyWeight(STRANGER, "2026-11-11", 500, 0);
    expect(await repo.getWeights(OWNER, "2026-11-10", "2026-11-12")).toEqual([
      { localDate: "2026-11-10", weightDg: 800 },
      { localDate: "2026-11-12", weightDg: 790 },
    ]);
    expect(await repo.getWeights(OWNER, "2026-11-11", "2026-11-11")).toEqual([]);
    expect(await repo.getLastWeight(STRANGER)).toEqual({ localDate: "2026-11-11", weightDg: 500 });
  });

  it("upsertBodyWeight повертає попереднє значення дня", async () => {
    expect(await repo.upsertBodyWeight(OWNER, "2026-11-20", 784, 1)).toBeNull();
    expect(await repo.upsertBodyWeight(OWNER, "2026-11-20", 780, 2)).toBe(784);
    // В2 рев'ю (N8): чужий рядок за ту саму дату не видно як «попереднє»
    await repo.upsertUser(STRANGER, "Інший", 0);
    expect(await repo.upsertBodyWeight(STRANGER, "2026-11-20", 700, 3)).toBeNull();
    expect(await repo.getLastWeight(OWNER)).toEqual({ localDate: "2026-11-20", weightDg: 780 });
  });

  it("/vaga у BOT_COMMANDS", () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toContain("vaga");
  });
});
