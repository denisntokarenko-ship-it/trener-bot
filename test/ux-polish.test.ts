// Завдання 1b.4: оформлення бота й текстів (docs/spec/phase-1b.md, §6 і історії P3.4–P3.6).
// Екрани — чисті функції, тож перевіряємо їх напряму: ліміти, екранування HTML, знімки, відео-кнопка, мова.
import { NO_UNITS } from "../src/domain/units";
import { describe, expect, it } from "vitest";
import { AVATAR_FILES, runSetBotProfile, type SetBotProfileIo } from "../scripts/set-bot-profile-core.ts";
import { ENUMS, LIMIT_OPTS, emptyDayScreen, enumScreen, goalNoteScreen, limitsScreen, liftScreen, noteScreen, numberScreen, planScreen, profileScreen, resumeScreen, welcomeScreen, type Screen } from "../src/bot/onboarding-view";
import { fmtSets, progressText } from "../src/bot/progress-view";
import {
  BOT_COMMANDS, BOT_DESCRIPTION, BOT_PROFILES, NEXT_WORKOUT, PREVIEW_BOT_USERNAME, dayLabel, BOT_SHORT_DESCRIPTION, BTN, RATING_TEXT, TELEGRAM_TEXT_MAX, badLift, badWeightText, clip, dayName, esc, greeting,
  programText, recordReps, recordWeight, summaryText, swapTitle, weightPromptText,
} from "../src/bot/texts";
import { screenKeyboard, screenText, swapMenu, weightPrompt, type ScreenModel } from "../src/bot/workout-view";
import type { Exercise, ProfileRow, WorkoutSummaryRow } from "../src/db/repo";
import type { Plan } from "../src/domain/plan";
import { htmlProblems } from "./helpers";

// Сирі тексти файлів підтягує Vite під час збирання тесту (у workerd немає доступу до диска).
const botFiles = import.meta.glob("../src/bot/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const EVIL = `<b>Жим</b> & "x" <script>`;
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;

const exercise = (over: Partial<Exercise> = {}): Exercise => ({
  id: 1,
  slug: "squat",
  nameUk: "Присідання зі штангою",
  equipment: "barbell",
  weightStepKg: 5,
  minWeightKg: 20,
  muscleGroup: "legs",
  cues: ["Тримай спину рівно", "Коліна — за носками", "Опускайся контрольовано"],
  videoUrl: VIDEO,
  unilateral: false,
  ...over,
});

const model = (over: Partial<ScreenModel> = {}): ScreenModel => ({
  workoutId: 999_999,
  dayName: "Все тіло A",
  slotIndex: 1,
  slotCount: 6,
  programExerciseId: 999_999,
  sets: 3,
  exercise: exercise({ id: 999_999 }),
  setNo: 2,
  weightKg: 62.5,
  reps: 8,
  calibration: false,
  done: [{ setNo: 1, weightKg: 62.5, reps: 8, skipped: false }],
  canSwap: true,
  showCues: false,
  ...over,
});

const buttons = (s: Screen | { keyboard?: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } }): { text: string; callback_data?: string; url?: string }[] =>
  ((s as Screen).keyboard?.inline_keyboard ?? []).flat();

function expectValid(text: string, label = ""): void {
  expect(htmlProblems(text), label).toEqual([]);
}

describe("htmlProblems (контроль перевірки)", () => {
  it("ловить голі символи, непарні теги й довжину", () => {
    expect(htmlProblems("<b>ок</b> &amp; &lt;")).toEqual([]);
    expect(htmlProblems("a < b")).not.toEqual([]);
    expect(htmlProblems("<b>без закриття")).not.toEqual([]);
    expect(htmlProblems("<b>x</i>")).not.toEqual([]);
    expect(htmlProblems("Tom & Jerry")).not.toEqual([]);
    expect(htmlProblems("я".repeat(4097))).not.toEqual([]);
  });
});

describe("esc і clip", () => {
  it("esc: & < > → сутності, & першим (без подвійного екранування)", () => {
    expect(esc(EVIL)).toBe("&lt;b&gt;Жим&lt;/b&gt; &amp; \"x\" &lt;script&gt;");
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("clip: ≤ 4096; різання по межі рядка — теги не розриваються", () => {
    const line = "<b>рядок</b> &amp; ще трохи тексту для довжини";
    const text = Array.from({ length: 200 }, () => line).join("\n");
    const out = clip(text);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(out.endsWith("…")).toBe(true);
    expectValid(out);
    expect(clip("коротко")).toBe("коротко");
  });
});

describe("P3.5 екранування користувацьких рядків", () => {
  const bad = (name: string) => name;

  it("екран вправи, підсумок, заміна, ввід ваги: назва з < не ламає розмітку", () => {
    const e = exercise({ nameUk: bad(EVIL), cues: [EVIL, "ок", "ок"] });
    expectValid(screenText(model({ exercise: e, showCues: true, dayName: EVIL })), "екран");
    expectValid(summaryText({ dayName: EVIL, minutes: 5, setsTotal: 3, setsDone: 3, setsSkipped: 0, volumeKg: 1, effort: 3, records: [recordReps(EVIL, 5), recordWeight(EVIL, 60, 8)], nextDayName: EVIL }), "підсумок");
    expectValid(swapTitle(EVIL), "заміна");
    expectValid(swapMenu(model({ exercise: e }), [e]).text, "меню заміни");
    expectValid(weightPromptText(e), "запит ваги");
    expectValid(badWeightText(e), "відмова ваги");
    expectValid(badLift("min", e), "відмова ваги в анкеті");
    expectValid(greeting(EVIL), "привітання");
    expect(screenText(model({ exercise: e }))).not.toContain("<script>");
  });

  it("програма, /progres, план, профіль", () => {
    const e = exercise({ nameUk: EVIL });
    const day = { id: 1, programId: 1, code: "A", position: 1, title: EVIL, slots: [{ id: 1, position: 1, sets: 3, repMin: 6, repMax: 10, exercise: e }] };
    expectValid(programText({ name: EVIL, days: [day], next: { dayName: EVIL, lines: [{ nameUk: EVIL, bodyweight: false, units: NO_UNITS, weightKg: 20, targetReps: 6 }] }, activeDayName: EVIL }), "програма");
    const w: WorkoutSummaryRow = {
      id: 1, startedAt: 1_700_000_000_000, status: "done", effort: 3, dayCode: "A", dayTitle: EVIL,
      exercises: [{ nameUk: EVIL, sets: [{ weightKg: 20, reps: 8, skipped: false }] }],
    } as unknown as WorkoutSummaryRow;
    expectValid(progressText([w], "Europe/Kyiv"), "прогрес");
    const plan: Plan = { name: EVIL, days: [{ code: "FA", title: EVIL, slots: [{ exerciseId: 1, sets: 3, repMin: 6, repMax: 10 }] }] };
    expectValid(planScreen({ plan, names: new Map([[1, EVIL]]), daysPerWeek: 3, sessionMin: 60, limits: ["knee"], variant: 0, weightsUsed: 1, weightsTotal: 2 }).text, "план");
    expectValid(profileScreen({ goal: "other", goalNote: EVIL, limitsNote: EVIL, dietNote: EVIL, limits: "knee" } as ProfileRow, EVIL, [{ name: EVIL, weight: { weightKg: 60, reps: 8 } as never }], false).text, "профіль");
    expectValid(noteScreen("diet", EVIL).text, "нотатка");
    expectValid(goalNoteScreen({ goal: "other", goalNote: EVIL } as ProfileRow).text, "ціль");
    expectValid(liftScreen(e, 0, 4, null, false).text, "якір");
  });

  it("dayName: назва дня без title — «День <код>»", () => {
    expect(dayName({ code: "A", title: null })).toBe("День A");
  });
});

describe("ліміти Telegram", () => {
  const long = "Ш".repeat(300);

  it("найгірші екрани ≤ 4096: план 5×7, профіль із нотатками 300+300+300, програма й прогрес", () => {
    const names = new Map(Array.from({ length: 35 }, (_, i) => [i + 1, `${long.slice(0, 150)} ${i}`] as const));
    const plan: Plan = {
      name: long,
      days: Array.from({ length: 5 }, (_, d) => ({
        code: `D${d}`,
        title: long.slice(0, 40),
        slots: Array.from({ length: 7 }, (_, s) => ({ exerciseId: d * 7 + s + 1, sets: 4, repMin: 10, repMax: 15 })),
      })),
    };
    const text = planScreen({ plan, names, daysPerWeek: 5, sessionMin: 90, limits: ["knee", "back", "shoulder", "wrist"], variant: 2, weightsUsed: 4, weightsTotal: 4 }).text;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expectValid(text, "план 5×7");

    const note = "<&>".repeat(100);
    const p = profileScreen(
      { goal: "other", goalNote: note, limits: "knee,back,shoulder,wrist", limitsNote: note, dietNote: note, level: "adv", daysPerWeek: 5, sessionMin: 90, place: "home", sex: "f", birthYear: 1990, heightCm: 170, weightKg: 60, mealsPerDay: 5, sleepBand: "8p", activity: "high" } as ProfileRow,
      long,
      Array.from({ length: 4 }, () => ({ name: long.slice(0, 80), weight: { weightKg: 100, reps: 10 } as never })),
      true,
    );
    expect(p.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expectValid(p.text, "профіль");

    const e = exercise({ nameUk: long, cues: [long, long, long] });
    const s = screenText(model({ exercise: e, showCues: true, dayName: long, done: Array.from({ length: 10 }, (_, i) => ({ setNo: i + 1, weightKg: 100, reps: 10, skipped: false })) }));
    expect(s.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expectValid(s, "екран із cues");

    const sum = summaryText({ dayName: long, minutes: 90, setsTotal: 30, setsDone: 30, setsSkipped: 0, volumeKg: 123456, effort: 5, records: Array.from({ length: 40 }, (_, i) => recordWeight(`${long.slice(0, 80)} ${i}`, 100, 10)), nextDayName: long });
    expect(sum.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expectValid(sum, "підсумок");
  });

  it("callback_data ≤ 64 байти при максимальних id, вазі й повторах", () => {
    const m = model({ workoutId: 2_147_483_647, programExerciseId: 2_147_483_647, exercise: exercise({ id: 2_147_483_647 }), setNo: 10, weightKg: 500, reps: 49 });
    for (const b of buttons(swapMenu(m, [exercise({ id: 2_147_483_647 })]))) {
      if (b.callback_data !== undefined) expect(new TextEncoder().encode(b.callback_data).length, b.callback_data).toBeLessThanOrEqual(64);
    }
    for (const b of buttons({ keyboard: screenKeyboard(m) })) {
      if (b.callback_data !== undefined) expect(new TextEncoder().encode(b.callback_data).length, b.callback_data).toBeLessThanOrEqual(64);
    }
    for (const b of buttons({ keyboard: weightPrompt(m.exercise, m.workoutId).keyboard })) {
      expect(new TextEncoder().encode(b.callback_data!).length).toBeLessThanOrEqual(64);
    }
  });

  it("кнопки: підпис ≤ 24 символи, ≤ 3 в рядку — на всіх екранах анкети й тренування", () => {
    const profile = { goal: "muscle", level: "mid", limits: "knee" } as ProfileRow;
    const screens: Screen[] = [
      welcomeScreen(), goalNoteScreen(profile), limitsScreen(profile, true), noteScreen("limits_note", null), noteScreen("diet", null),
      numberScreen("birth", null), liftScreen(exercise(), 0, 4, null, false), emptyDayScreen(), resumeScreen(),
      profileScreen(profile, "План", [], true),
      ...(Object.keys(ENUMS) as (keyof typeof ENUMS)[]).map((step) => enumScreen(step, profile, { back: true, skip: true })),
    ];
    const kbs = [...screens.map((s) => s.keyboard!), screenKeyboard(model()), weightPrompt(exercise(), 1).keyboard];
    for (const kb of kbs) {
      for (const row of kb.inline_keyboard) {
        expect(row.length, "порожній рядок клавіатури").toBeGreaterThan(0);
        expect(row.length, row.map((b) => b.text).join("|")).toBeLessThanOrEqual(3);
        for (const b of row) expect([...b.text].length, b.text).toBeLessThanOrEqual(24);
      }
    }
    for (const o of LIMIT_OPTS) expect([...o.label].length).toBeLessThanOrEqual(24);
    for (const v of Object.values(BTN)) expect([...v].length, v).toBeLessThanOrEqual(24);
  });
});

describe("P3.4 кнопка [🎥 Відео]", () => {
  const video = (m: ScreenModel) => buttons({ keyboard: screenKeyboard(m) }).filter((b) => b.text === BTN.video);

  it("валідне посилання: URL-кнопка окремим рядком, без callback_data", () => {
    const kb = screenKeyboard(model());
    const last = kb.inline_keyboard.at(-1)!;
    expect(last).toHaveLength(1);
    expect(last[0]).toEqual({ text: BTN.video, url: VIDEO });
    expect(last[0]).not.toHaveProperty("callback_data");
  });

  it("є й на екрані з «Техніка» (cues відкриті)", () => {
    expect(video(model({ showCues: true }))).toHaveLength(1);
  });

  it("NULL, порожнє, чуже чи зіпсоване посилання — кнопки немає", () => {
    for (const url of [null, "", "http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short", `${VIDEO}"><b>`]) {
      expect(video(model({ exercise: exercise({ videoUrl: url }) })), String(url)).toHaveLength(0);
    }
  });
});

describe("знімки ключових екранів", () => {
  const sn = (s: { text: string; keyboard?: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } }): string =>
    [s.text, "", ...(s.keyboard?.inline_keyboard ?? []).map((r) => r.map((b) => `[${b.text}]`).join(" "))].join("\n");

  it("вправа (калібрування), вправа з історією й Технікою, підсумок з рекордами", () => {
    expect(sn({ text: screenText(model({ setNo: 1, done: [], calibration: true, weightKg: 20, reps: 6 })), keyboard: screenKeyboard(model({ setNo: 1, done: [], calibration: true, weightKg: 20, reps: 6 })) })).toMatchInlineSnapshot(`
      "🏋️ <i>Все тіло A · вправа 2/6</i>
      <b>Присідання зі штангою</b>
      Підхід 1/3 · ціль <b>20 кг × 6</b>
      <i>Калібрування: підбери робочу вагу кнопкою ⚖️</i>

      [✅ 6] [−1] [+1]
      [⚖️ Вага] [🔁 Замінити] [⏭ Пропустити]
      [💡 Техніка]
      [🎥 Відео]"
    `);
    expect(screenText(model({ showCues: true, done: [{ setNo: 1, weightKg: 62.5, reps: 8, skipped: false }] }))).toMatchInlineSnapshot(`
      "🏋️ <i>Все тіло A · вправа 2/6</i>
      <b>Присідання зі штангою</b>
      Підхід 2/3 · ціль <b>62,5 кг × 8</b>
      ✅ 1: 62,5 × 8

      💡 <b>Техніка</b>
      • <i>Тримай спину рівно</i>
      • <i>Коліна — за носками</i>
      • <i>Опускайся контрольовано</i>"
    `);
    expect(summaryText({ dayName: "Все тіло A", minutes: 52, setsTotal: 14, setsDone: 13, setsSkipped: 1, volumeKg: 6240, effort: 4, records: [recordWeight("Жим лежачи", 60, 8), recordReps("Підтягування", 6)], nextDayName: "Все тіло B" })).toMatchInlineSnapshot(`
      "🏋️ <b>Все тіло A</b> · 52 хв
      Підходів: <b>13 з 14</b> (пропущено 1)
      Обсяг: <b>6 240 кг</b>
      Складність: <b>4/5</b>

      🏆 <b>Рекорди</b>
      • Жим лежачи — <b>60 кг × 8</b>
      • Підтягування — <b>6 повт.</b>

      Наступне тренування: <b>Все тіло B</b>"
    `);
  });

  it("програма, прогрес, порожні стани, помилка, привітання", () => {
    const day = (code: string, title: string | null, names: string[]) => ({
      id: 1, programId: 1, code, position: 1, title,
      slots: names.map((n, i) => ({ id: i + 1, position: i + 1, sets: 3, repMin: 6, repMax: 10, exercise: exercise({ nameUk: n }) })),
    });
    expect(programText({ name: "План: сила", days: [day("FA", "Все тіло A", ["Присідання зі штангою", "Жим лежачи"]), day("FB", "Все тіло B", ["Румунська тяга"])], next: { dayName: "Все тіло A", lines: [{ nameUk: "Присідання зі штангою", bodyweight: false, units: NO_UNITS, weightKg: 60, targetReps: 6 }] }, activeDayName: null })).toMatchInlineSnapshot(`
      "📋 <b>План: сила</b>

      <b>Все тіло A</b> · ноги
      1. Присідання зі штангою — 3 × 6–10
      2. Жим лежачи — 3 × 6–10

      <b>Все тіло B</b> · ноги
      1. Румунська тяга — 3 × 6–10

      ➡️ <b>Наступне тренування: Все тіло A</b>
      Присідання зі штангою — 60 кг × 6"
    `);
    expect(progressText([], "Europe/Kyiv")).toMatchInlineSnapshot(`
      "📈 Тренувань ще немає.
      Почни перше: /trening"
    `);
    expect(RATING_TEXT).toMatchInlineSnapshot(`
      "✅ <b>Готово!</b> Наскільки було важко?
      <i>1 — легко, 5 — на межі.</i>"
    `);
    expect(greeting("Денис")).toMatchInlineSnapshot(`
      "👋 <b>Привіт, Денис!</b>
      Я записую твої тренування й підказую ваги.

      /start — Почати
      /trening — Тренування
      /prohrama — Програма й наступне заняття
      /progres — Прогрес: вага, рекорди, e1RM
      /vaga — Записати вагу тіла
      /profil — Профіль і план
      /nalashtuvannia — Дні, час нагадувань, часовий пояс
      /yizha — Їжа за день і норма"
    `);
    expect(sn(emptyDayScreen())).toMatchInlineSnapshot(`
      "⚠️ <b>Не вдалося скласти план із такими обмеженнями</b>
      Для одного з днів не вистачає вправ. Змінімо обмеження чи тривалість — або почнімо спочатку.

      [🦵 Змінити обмеження]
      [⏱ Змінити тривалість]
      [🔄 Спочатку]"
    `);
    expect(fmtSets([])).toBe("");
  });

  it("анкета: привітання, ціль, рівень, ваги-якорі", () => {
    expect(sn(welcomeScreen())).toMatchInlineSnapshot(`
      "🎯 <b>Налаштуємо тренування під тебе</b>
      Кілька питань, ~3 хвилини: ціль, рівень, дні, обмеження. З відповідей я складу план, а ти його підтвердиш.
      Відповіді можна змінити будь-коли в /profil.

      [▶️ Почати]"
    `);
    expect(sn(enumScreen("goal", null, { back: false, skip: false }))).toMatchInlineSnapshot(`
      "<b>🎯 Чого хочеш від тренувань?</b>
      <i>Питання 1 з 15</i>
      Без цілі я не складу план, тому його не можна пропустити.

      [🔥 Схуднути] [💪 Набрати мʼязи]
      [🔄 Рекомпозиція] [🏋️ Сила]
      [❤️ Здоровʼя й форма] [✍️ Інше]"
    `);
    expect(sn(enumScreen("level", { level: "mid" } as ProfileRow, { back: true, skip: true }))).toMatchInlineSnapshot(`
      "<b>🌱 Який у тебе рівень?</b>
      <i>Питання 2 з 15</i>
      <i>Скільки ти тренуєшся регулярно.</i>

      [Новачок · до 6 міс]
      [✅ Середній · 6–24 міс]
      [Досвідчений · 2+ роки]
      [⬅️ Назад] [⏭ Пропустити]"
    `);
  });
});

describe("мова: літералів поза texts.ts немає", () => {
  // Прибирає блокові й рядкові коментарі, щоб перевіряти лише виконуваний код.
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("українські літерали в src/bot/** — лише у texts.ts", () => {
    const offenders = Object.entries(botFiles)
      .filter(([path]) => !path.endsWith("/texts.ts"))
      .filter(([, src]) => CYRILLIC.test(code(src)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("позитивний контроль: texts.ts має кирилицю, а прибирання коментарів працює", () => {
    const texts = Object.entries(botFiles).find(([path]) => path.endsWith("/texts.ts"))!;
    expect(CYRILLIC.test(code(texts[1]))).toBe(true);
    expect(CYRILLIC.test(code("// коментар\nconst a = 1; /* ще */"))).toBe(false);
    expect(CYRILLIC.test(code('const a = "рядок";'))).toBe(true);
  });

  it("у texts.ts немає типових русизмів і суржику (контроль мови)", () => {
    const src = botFiles["../src/bot/texts.ts"]!;
    // слідуючий → наступний; приймати участь → брати участь; на протязі → протягом; відноситься → стосується
    for (const bad of ["слідуюч", "приймат", "на протязі", "відноситься", "відбувається", "являється", "чекати з нетерпінням"]) {
      expect(src.toLowerCase(), bad).not.toContain(bad);
    }
    // «Прийняти» як кнопка плану — доречне; перевірка вище ловить лише дієслово «приймати участь».
    expect(BTN.accept).toBe("✅ Прийняти");
  });

  it("жодного поля title/value не втрачає Telegram-ліміт: опис ≤ 512, короткий ≤ 120, команди валідні", () => {
    expect([...BOT_DESCRIPTION].length).toBeLessThanOrEqual(512);
    expect([...BOT_SHORT_DESCRIPTION].length).toBeLessThanOrEqual(120);
    expect(BOT_COMMANDS.length).toBeGreaterThan(0);
    for (const c of BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThanOrEqual(3);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(["start", "trening", "prohrama", "progres", "vaga", "profil", "nalashtuvannia", "yizha"]);
  });
});

describe("P3.6 set-bot-profile", () => {
  const TOKEN = "123456:SECRET-BOT-TOKEN";
  const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  /** Фейковий Telegram зі станом: set* змінюють те, що повертають get*. `username` — кому належить токен. */
  function harness(opts: { fail?: string; username?: string } = {}) {
    const calls: string[] = [];
    const out: string[] = [];
    const photos: { photo: string; avatar: Blob | string | null }[] = [];
    const reads: string[] = [];
    const state = { name: "", commands: [] as { command: string; description: string }[], description: "", short: "" };
    const io: SetBotProfileIo = {
      env: { TELEGRAM_BOT_TOKEN: TOKEN },
      log: (l) => out.push(l),
      error: (l) => out.push(l),
      readFile: (path) => {
        reads.push(path);
        return PHOTO;
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = String(input).slice(String(input).lastIndexOf("/") + 1);
        calls.push(method);
        if (method === opts.fail) return Response.json({ ok: false, description: `Bad Request: token ${TOKEN}` });
        let result: unknown = true;
        if (init?.body instanceof FormData) {
          photos.push({ photo: String(init.body.get("photo")), avatar: init.body.get("avatar") as Blob | string | null });
          return Response.json({ ok: true, result });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (method === "getMe") result = { username: opts.username ?? PREVIEW_BOT_USERNAME };
        else if (method === "getMyName") result = { name: state.name };
        else if (method === "getMyCommands") result = state.commands;
        else if (method === "getMyDescription") result = { description: state.description };
        else if (method === "getMyShortDescription") result = { short_description: state.short };
        else if (method === "setMyName") state.name = String(body.name);
        else if (method === "setMyCommands") state.commands = body.commands as typeof state.commands;
        else if (method === "setMyDescription") state.description = String(body.description);
        else if (method === "setMyShortDescription") state.short = String(body.short_description);
        return Response.json({ ok: true, result });
      }) as typeof fetch,
    };
    return { io, calls, out, state, photos, reads };
  }
  const writes = (calls: string[]) => calls.filter((c) => c.startsWith("setMy"));

  it("перший прогін пише все (з аватаркою); другий — лише аватарка (її не прочитати) і код 0", async () => {
    const h = harness();
    expect(await runSetBotProfile(["preview"], h.io)).toBe(0);
    expect(writes(h.calls).sort()).toEqual(["setMyCommands", "setMyDescription", "setMyName", "setMyProfilePhoto", "setMyShortDescription"]);
    expect(h.state).toEqual({ name: BOT_PROFILES.preview.name, commands: [...BOT_COMMANDS], description: BOT_PROFILES.preview.description, short: BOT_PROFILES.preview.shortDescription });
    h.calls.length = 0;
    h.out.length = 0;
    expect(await runSetBotProfile(["preview"], h.io)).toBe(0);
    expect(writes(h.calls)).toEqual(["setMyProfilePhoto"]);
    expect(h.out.slice(1, 5)).toEqual(["Назва: без змін", "Меню команд: без змін", "Опис: без змін", "Короткий опис: без змін"]);
  });

  it("--no-photo: аватарку не чіпає і файл не читає", async () => {
    const h = harness();
    expect(await runSetBotProfile(["preview", "--no-photo"], h.io)).toBe(0);
    expect(h.calls).not.toContain("setMyProfilePhoto");
    expect(h.reads).toEqual([]);
  });

  it("аватарка: multipart, photo = static + attach://, файл — JPG цього середовища", async () => {
    const h = harness();
    await runSetBotProfile(["preview"], h.io);
    expect(h.reads).toEqual([AVATAR_FILES.preview]);
    expect(AVATAR_FILES).toEqual({ preview: "assets/bot/preview.jpg", production: "assets/bot/prod.jpg" });
    const [p] = h.photos;
    expect(JSON.parse(p!.photo)).toEqual({ type: "static", photo: "attach://avatar" });
    const blob = p!.avatar as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PHOTO);
  });

  it("production: профіль робочого бота — інша назва, опис і аватарка, ніж у тестового", async () => {
    const h = harness({ username: "Trener_prod_bot" });
    expect(await runSetBotProfile(["production"], h.io)).toBe(0);
    expect(h.state.name).toBe(BOT_PROFILES.production.name);
    expect(h.state.description).toBe(BOT_DESCRIPTION);
    expect(h.state.short).toBe(BOT_SHORT_DESCRIPTION);
    expect(h.reads).toEqual([AVATAR_FILES.production]);
    expect(BOT_PROFILES.production.name).not.toBe(BOT_PROFILES.preview.name);
  });

  it("токен не того середовища: нічого не пишемо (ні назву, ні аватарку), код 1", async () => {
    const wrongProd = harness(); // токен тестового бота, ціль production
    expect(await runSetBotProfile(["production"], wrongProd.io)).toBe(1);
    expect(writes(wrongProd.calls)).toEqual([]);
    const wrongPreview = harness({ username: "Trener_prod_bot" }); // токен робочого, ціль preview
    expect(await runSetBotProfile(["preview"], wrongPreview.io)).toBe(1);
    expect(writes(wrongPreview.calls)).toEqual([]);
    expect(wrongPreview.out.join("\n")).not.toContain(TOKEN);
  });

  it("без цілі або з чужою ціллю — код 1 без жодного запиту", async () => {
    for (const args of [[], ["dev"], ["--no-photo"]]) {
      const h = harness();
      expect(await runSetBotProfile(args, h.io)).toBe(1);
      expect(h.calls).toEqual([]);
    }
  });

  it("змінений опис — оновлюється лише він (і аватарка)", async () => {
    const h = harness();
    await runSetBotProfile(["preview"], h.io);
    h.state.description = "старий опис";
    h.calls.length = 0;
    expect(await runSetBotProfile(["preview"], h.io)).toBe(0);
    expect(writes(h.calls).sort()).toEqual(["setMyDescription", "setMyProfilePhoto"]);
  });

  it("помилка Telegram — код 1, токен не потрапляє в вивід; без токена — код 1", async () => {
    const h = harness({ fail: "setMyCommands" });
    expect(await runSetBotProfile(["preview"], h.io)).toBe(1);
    expect(h.out.join("\n")).not.toContain(TOKEN);
    const h2 = harness();
    expect(await runSetBotProfile(["preview"], { ...h2.io, env: {} })).toBe(1);
    expect(h2.calls).toEqual([]);
  });

  it("два бота відрізняються з першого погляду: назва, обидва описи; ліміти Telegram", () => {
    const { preview, production } = BOT_PROFILES;
    expect(preview.name).toContain("тест");
    expect(preview.name.startsWith("🧪")).toBe(true);
    expect(production.name).not.toMatch(/тест/i);
    expect(preview.description).not.toBe(production.description);
    expect(preview.shortDescription).not.toBe(production.shortDescription);
    for (const p of [preview, production]) {
      expect([...p.name].length).toBeLessThanOrEqual(64);
      expect([...p.description].length).toBeLessThanOrEqual(512);
      expect([...p.shortDescription].length).toBeLessThanOrEqual(120);
    }
  });
});

describe("рев'ю 1b.4: мова й межі", () => {
  it("В1: «прийом їжі» відмінюється за числом", () => {
    const text = (n: number) => profileScreen({ goal: "muscle", limits: null, mealsPerDay: n } as ProfileRow, null, [], false).text;
    expect(text(1)).toContain("1 прийом їжі");
    for (const n of [2, 3, 4]) expect(text(n)).toContain(`${n} прийоми їжі`);
    expect(text(5)).toContain("5+ прийомів їжі");
    expect(text(3)).not.toContain("3 прийомів");
  });

  it("Д8: clip одного довгого рядка без переносів не рве сутність і вкладається в ліміт", () => {
    const out = clip("я".repeat(4094) + "&amp;" + "я".repeat(10));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
    expect(out.endsWith("&…")).toBe(false);
    expectValid(out);
  });

  it("/prohrama: підказка складу дня й єдиний підпис «Наступне тренування» (злиття з #24 не може їх прибрати)", () => {
    const e = (g: string) => exercise({ muscleGroup: g as never });
    const day = { id: 1, programId: 1, code: "FA", position: 1, title: "Все тіло A", slots: ["legs", "chest", "back"].map((g, i) => ({ id: i + 1, position: i + 1, sets: 3, repMin: 6, repMax: 10, exercise: e(g) })) };
    const text = programText({ name: "План", days: [day], next: { dayName: dayLabel(day), lines: [] }, activeDayName: null });
    expect(text).toContain("<b>Все тіло A</b> · ноги, груди, спина");
    expect(text).toContain(`➡️ <b>${NEXT_WORKOUT}: Все тіло A (ноги, груди, спина)</b>`);
    expect(summaryText({ dayName: "x", minutes: 1, setsTotal: 1, setsDone: 1, setsSkipped: 0, volumeKg: 1, effort: 3, records: [], nextDayName: "Все тіло B" })).toContain(`${NEXT_WORKOUT}: <b>Все тіло B</b>`);
  });
});
