// Дані й SQL сиду фази 1 без process і без мережі — тестується в pool workers (phase-1.md, P1.1).
// Ідемпотентно: каталог — upsert за slug (хибне припущення про крок → правка тут, без міграції);
// програма, дні й слоти — лише дописує відсутнє, наявне не чіпає. ON CONFLICT DO NOTHING, а не
// INSERT OR IGNORE: той ковтає й порушення CHECK, тож хибні дані сиду зникли б мовчки.

// Типи — з enum схеми, одне джерело (рев'ю 1.1, дрібниця 4). `import type` node стирає під час запуску.
import type { Equipment, MuscleGroup } from "../src/db/repo.ts";
import { DAY_TITLES } from "../src/domain/plan.ts";
import type { ExerciseKind, Limit, Pattern } from "../src/domain/plan.ts";
import { isVideoUrl } from "../src/domain/video.ts";
import { VIDEOS } from "./seed-videos.ts";

export interface CatalogEntry {
  id: number;
  slug: string;
  nameUk: string;
  equipment: Equipment;
  stepKg: number;
  minKg: number;
  group: MuscleGroup;
  /** Рівно 3 підказки ≤ 60 символів, наказовий спосіб, спершу безпека. */
  cues: [string, string, string];
  /** Слаги замін «чим замінити цю вправу», у порядку з таблиці каталогу. */
  substitutes: string[];
  /** Метадані для генератора плану (phase-1b.md §3). */
  pattern: Pattern;
  kind: ExerciseKind;
  place: "gym" | "both";
  minLevel: 1 | 2 | 3;
  stress: Limit[];
  /** Посилання на відео техніки (§9) або null — тоді рядок у «Борг» PROGRESS.md. */
  videoUrl: string | null;
}

type BaseEntry = Omit<CatalogEntry, "pattern" | "kind" | "place" | "minLevel" | "stress" | "videoUrl">;

// Таблиця «Каталог і програма» в docs/spec/phase-1.md. Кроки блоків і тренажерів — припущення (open-questions.md).
/** Метадані існуючих 18 вправ (phase-1b.md §3): pattern, place, min_level, stress; kind = accessory для 5, 10, 18. */
const META: Record<number, [Pattern, "gym" | "both", 1 | 2 | 3, Limit[]]> = {
  1: ["squat", "gym", 1, ["knee", "back"]],
  2: ["hpush", "gym", 1, ["shoulder"]],
  3: ["vpull", "gym", 1, []],
  4: ["vpush", "gym", 1, ["shoulder"]],
  5: ["core", "gym", 1, ["back"]],
  6: ["hinge", "gym", 1, ["back"]],
  7: ["squat", "gym", 1, ["knee"]],
  8: ["hpull", "gym", 1, []],
  9: ["hpush", "gym", 1, ["shoulder"]],
  10: ["core", "gym", 2, ["shoulder"]],
  11: ["squat", "both", 1, ["knee"]],
  12: ["hpush", "gym", 1, ["shoulder"]],
  13: ["vpull", "gym", 2, ["shoulder"]],
  14: ["vpush", "gym", 2, ["shoulder", "back"]],
  15: ["hinge", "both", 1, ["back"]],
  16: ["hpull", "both", 1, ["back"]],
  17: ["hpush", "gym", 2, ["shoulder", "wrist"]],
  18: ["core", "gym", 1, ["shoulder"]],
};
const ACCESSORY_IDS = new Set([5, 10, 18]);

const BASE: BaseEntry[] = [
  { id: 1, slug: "barbell-squat", nameUk: "Присідання зі штангою", equipment: "barbell", stepKg: 5, minKg: 20, group: "legs",
    cues: ["Спина рівна, корпус напружений, погляд уперед", "Коліна йдуть за носками, не зводь їх усередину", "Опускайся до паралелі, вставай через пʼяти"],
    substitutes: ["leg-press", "goblet-squat"] },
  { id: 2, slug: "barbell-bench-press", nameUk: "Жим лежачи", equipment: "barbell", stepKg: 5, minKg: 20, group: "chest",
    cues: ["Лопатки зведені, стопи впираються в підлогу", "Опускай гриф до низу грудей під контролем", "Лікті під кутом близько 45°, тисни без ривка"],
    substitutes: ["dumbbell-bench-press", "machine-chest-press"] },
  { id: 3, slug: "lat-pulldown", nameUk: "Тяга верхнього блока", equipment: "cable", stepKg: 5, minKg: 5, group: "back",
    cues: ["Не відхиляйся назад більше ніж трохи", "Тягни руківʼя до верху грудей, не за голову", "Зведи лопатки внизу, повертай угору повільно"],
    substitutes: ["pull-up", "dumbbell-row"] },
  { id: 4, slug: "seated-dumbbell-press", nameUk: "Жим гантелей сидячи", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "shoulders",
    cues: ["Спина щільно до спинки, поперек не прогинай", "Опускай гантелі до рівня вух під контролем", "Вижимай угору, не бий гантелями одна об одну"],
    substitutes: ["barbell-overhead-press"] },
  { id: 5, slug: "cable-crunch", nameUk: "Скручування на блоці", equipment: "cable", stepKg: 5, minKg: 5, group: "core",
    cues: ["Не тягни руками — скручуйся силою преса", "Стегна нерухомі, округлюй спину зверху вниз", "Видихай на скручуванні, повертайся повільно"],
    substitutes: ["hanging-knee-raise", "hanging-leg-raise"] },
  { id: 6, slug: "barbell-romanian-deadlift", nameUk: "Румунська тяга зі штангою", equipment: "barbell", stepKg: 5, minKg: 20, group: "legs",
    cues: ["Спина рівна весь рух, не округлюй поперек", "Коліна злегка зігнуті, таз відводь назад", "Гриф ковзає по стегнах до середини гомілки"],
    substitutes: ["dumbbell-romanian-deadlift"] },
  { id: 7, slug: "leg-press", nameUk: "Жим ногами", equipment: "machine", stepKg: 5, minKg: 10, group: "legs",
    cues: ["Поперек притиснутий до спинки весь рух", "Не випрямляй коліна до замка вгорі", "Коліна за носками, опускай платформу до 90°"],
    substitutes: ["goblet-squat", "barbell-squat"] },
  { id: 8, slug: "seated-cable-row", nameUk: "Тяга горизонтального блока", equipment: "cable", stepKg: 5, minKg: 5, group: "back",
    cues: ["Спина рівна, не розгойдуй корпус", "Тягни руківʼя до живота, лікті вздовж тіла", "Зведи лопатки, повертай руки повільно"],
    substitutes: ["dumbbell-row"] },
  { id: 9, slug: "machine-chest-press", nameUk: "Жим від грудей у тренажері", equipment: "machine", stepKg: 5, minKg: 5, group: "chest",
    cues: ["Лопатки притиснуті до спинки весь рух", "Сидіння так, щоб руківʼя були на рівні грудей", "Не випрямляй лікті до замка, повертай повільно"],
    substitutes: ["dips", "dumbbell-bench-press", "barbell-bench-press"] },
  { id: 10, slug: "hanging-leg-raise", nameUk: "Підйом ніг у висі", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "core",
    cues: ["Не розгойдуйся, плечі активні, лопатки вниз", "Піднімай ноги силою преса, без ривка", "Опускай ноги повільно, під контролем"],
    substitutes: ["hanging-knee-raise", "cable-crunch"] },
  { id: 11, slug: "goblet-squat", nameUk: "Гоблет-присідання", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "legs",
    cues: ["Гантель біля грудей, спина рівна", "Коліна за носками, лікті між колінами внизу", "Вставай через пʼяти, корпус вертикальний"],
    substitutes: ["leg-press", "dumbbell-lunge", "glute-bridge"] },
  { id: 12, slug: "dumbbell-bench-press", nameUk: "Жим гантелей лежачи", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "chest",
    cues: ["Лопатки зведені, стопи на підлозі", "Опускай гантелі до рівня грудей під контролем", "Тисни вгору, лікті під кутом близько 45°"],
    substitutes: ["push-up", "incline-dumbbell-press", "machine-chest-press"] },
  { id: 13, slug: "pull-up", nameUk: "Підтягування", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "back",
    cues: ["Опусти плечі від вух перед кожним повтором", "Тягнись грудьми до перекладини, без ривків", "Опускайся повністю, але повільно"],
    substitutes: ["lat-pulldown", "dumbbell-row"] },
  { id: 14, slug: "barbell-overhead-press", nameUk: "Жим штанги стоячи", equipment: "barbell", stepKg: 5, minKg: 20, group: "shoulders",
    cues: ["Сідниці й прес напружені, поперек не прогинай", "Веди гриф угору близько до обличчя", "Вгорі голова під грифом, лікті випрямлені"],
    substitutes: ["seated-dumbbell-press", "dumbbell-overhead-press"] },
  { id: 15, slug: "dumbbell-romanian-deadlift", nameUk: "Румунська тяга з гантелями", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "legs",
    cues: ["Спина рівна весь рух, не округлюй поперек", "Коліна злегка зігнуті, таз відводь назад", "Гантелі ковзають по стегнах до середини гомілки"],
    substitutes: ["barbell-romanian-deadlift", "glute-bridge"] },
  { id: 16, slug: "dumbbell-row", nameUk: "Тяга гантелі в нахилі", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "back",
    cues: ["Спина рівна, упрись рукою й коліном у лаву", "Тягни гантель до пояса, лікоть уздовж тіла", "Не розвертай корпус, опускай гантель повільно"],
    substitutes: ["seated-cable-row", "barbell-row", "dumbbell-reverse-fly"] },
  { id: 17, slug: "dips", nameUk: "Віджимання на брусах", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "chest",
    cues: ["Плечі вниз, не провалюйся в плечах", "Опускайся до 90° у ліктях, не нижче", "Корпус трохи вперед, вижимай без ривків"],
    substitutes: ["push-up", "dumbbell-bench-press", "machine-chest-press"] },
  { id: 18, slug: "hanging-knee-raise", nameUk: "Підйом колін у висі", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "core",
    cues: ["Не розгойдуйся, плечі активні, лопатки вниз", "Підтягуй коліна до грудей силою преса", "Опускай ноги повільно, під контролем"],
    substitutes: ["dead-bug", "cable-crunch"] },
];

/** Нові вправи 19–30 (phase-1b.md §3): кроки за правилом спеки, підказки — безпека спершу. */
const NEW: Omit<CatalogEntry, "videoUrl">[] = [
  { id: 19, slug: "push-up", nameUk: "Віджимання від підлоги", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "chest", pattern: "hpush", kind: "accessory", place: "both", minLevel: 1, stress: ["wrist", "shoulder"],
    cues: ["Тіло рівне, прес і сідниці напружені", "Лікті під кутом близько 45°, не розводь їх убік", "Опускайся до грудей, відштовхуйся без ривка"],
    substitutes: ["dumbbell-bench-press", "machine-chest-press"] },
  { id: 20, slug: "dumbbell-lunge", nameUk: "Випади з гантелями", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "legs", pattern: "squat", kind: "accessory", place: "both", minLevel: 1, stress: ["knee"],
    cues: ["Корпус прямо, гантелі опущені вздовж тіла", "Коліно передньої ноги не виходить за носок далеко", "Опускайся контрольовано, відштовхуйся передньою ногою"],
    substitutes: ["goblet-squat", "leg-press"] },
  { id: 21, slug: "glute-bridge", nameUk: "Ягодичний місток", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "legs", pattern: "hinge", kind: "accessory", place: "both", minLevel: 1, stress: [],
    cues: ["Поперек не прогинай, прес напружений", "Стопи близько до сідниць, спирайся на пʼяти", "Вгорі стисни сідниці, опускайся повільно"],
    substitutes: ["dumbbell-romanian-deadlift", "barbell-romanian-deadlift"] },
  { id: 22, slug: "dumbbell-overhead-press", nameUk: "Жим гантелей стоячи", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "shoulders", pattern: "vpush", kind: "compound", place: "both", minLevel: 1, stress: ["shoulder"],
    cues: ["Прес і сідниці напружені, поперек не прогинай", "Гантелі від рівня плечей, лікті трохи вперед", "Вижимай угору, не бий гантелями одна об одну"],
    substitutes: ["seated-dumbbell-press", "barbell-overhead-press"] },
  { id: 23, slug: "dumbbell-lateral-raise", nameUk: "Розведення гантелей убік", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "shoulders", pattern: "delt", kind: "accessory", place: "both", minLevel: 1, stress: ["shoulder"],
    cues: ["Бери легку вагу, корпус не розгойдуй", "Лікті трохи зігнуті, піднімай до рівня плечей", "Опускай повільно, не скидай гантелі вниз"],
    substitutes: ["face-pull", "dumbbell-reverse-fly"] },
  { id: 24, slug: "incline-dumbbell-press", nameUk: "Жим гантелей на похилій", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "chest", pattern: "hpush", kind: "compound", place: "gym", minLevel: 2, stress: ["shoulder"],
    cues: ["Лопатки зведені, стопи впираються в підлогу", "Опускай гантелі до верху грудей під контролем", "Тисни вгору без ривка, лікті близько 45°"],
    substitutes: ["dumbbell-bench-press", "barbell-bench-press"] },
  { id: 25, slug: "leg-curl", nameUk: "Згинання ніг у тренажері", equipment: "machine", stepKg: 5, minKg: 5, group: "legs", pattern: "legacc", kind: "accessory", place: "gym", minLevel: 1, stress: [],
    cues: ["Налаштуй вісь тренажера на рівень колін", "Притисни таз до опори, рухайся без ривка", "Повертай вагу повільно, не скидай блок"],
    substitutes: ["leg-extension"] },
  { id: 26, slug: "leg-extension", nameUk: "Розгинання ніг у тренажері", equipment: "machine", stepKg: 5, minKg: 5, group: "legs", pattern: "legacc", kind: "accessory", place: "gym", minLevel: 1, stress: ["knee"],
    cues: ["Бери легку вагу, спина притиснута до спинки", "Не випрямляй коліна різко до замка вгорі", "Опускай вагу повільно, під контролем"],
    substitutes: ["leg-curl"] },
  { id: 27, slug: "face-pull", nameUk: "Тяга до обличчя на блоці", equipment: "cable", stepKg: 5, minKg: 5, group: "shoulders", pattern: "delt", kind: "accessory", place: "gym", minLevel: 1, stress: [],
    cues: ["Бери легку вагу, корпус не відхиляй назад", "Тягни канат до рівня обличчя, лікті вгору", "Зведи лопатки, повертай руки повільно"],
    substitutes: ["dumbbell-reverse-fly", "dumbbell-lateral-raise"] },
  { id: 28, slug: "barbell-row", nameUk: "Тяга штанги в нахилі", equipment: "barbell", stepKg: 5, minKg: 20, group: "back", pattern: "hpull", kind: "compound", place: "gym", minLevel: 2, stress: ["back"],
    cues: ["Спина рівна весь рух, поперек не округлюй", "Нахил корпусу близько 45°, коліна зігнуті", "Тягни гриф до живота, опускай повільно"],
    substitutes: ["seated-cable-row", "dumbbell-row"] },
  { id: 29, slug: "dead-bug", nameUk: "«Мертвий жук»", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "core", pattern: "core", kind: "accessory", place: "both", minLevel: 1, stress: [],
    cues: ["Поперек притиснутий до підлоги весь рух", "Рухай протилежні руку й ногу повільно", "Видихай на розгинанні, не прогинай спину"],
    substitutes: ["hanging-knee-raise", "cable-crunch"] },
  { id: 30, slug: "dumbbell-reverse-fly", nameUk: "Розведення гантелей у нахилі", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "back", pattern: "delt", kind: "accessory", place: "both", minLevel: 1, stress: ["back"],
    cues: ["Бери легку вагу, спина рівна, шия нейтральна", "Лікті трохи зігнуті, розводь до рівня плечей", "Зведи лопатки вгорі, опускай повільно"],
    substitutes: ["face-pull", "dumbbell-lateral-raise"] },
];

/** Каталог 1–30: старі 18 (BASE + META) і нові 12 (NEW). videoUrl — зі scripts/seed-videos.ts; хибний формат — виняток. */
export const CATALOG: CatalogEntry[] = [
  ...BASE.map((e): Omit<CatalogEntry, "videoUrl"> => {
    const [pattern, place, minLevel, stress] = META[e.id]!;
    return { ...e, pattern, kind: ACCESSORY_IDS.has(e.id) ? "accessory" : "compound", place, minLevel, stress };
  }),
  ...NEW,
].map((e) => {
  const videoUrl = VIDEOS[e.slug] ?? null;
  if (videoUrl !== null && !isVideoUrl(videoUrl)) throw new Error(`Хибне video_url для ${e.slug}`);
  return { ...e, videoUrl };
});

export interface SlotSeed {
  slug: string;
  sets: number;
  repMin: number;
  repMax: number;
}

export const PROGRAM_NAME = "Full body A/B";

// decisions.md, запис 2026-10-23 «Склад програми»: день A — вправи 1–5 каталогу, день B — 6–10, у тому ж порядку.
export const PROGRAM_DAYS: { code: string; slots: SlotSeed[] }[] = [
  {
    code: "A",
    slots: [
      { slug: "barbell-squat", sets: 3, repMin: 6, repMax: 10 },
      { slug: "barbell-bench-press", sets: 3, repMin: 6, repMax: 10 },
      { slug: "lat-pulldown", sets: 3, repMin: 8, repMax: 12 },
      { slug: "seated-dumbbell-press", sets: 2, repMin: 8, repMax: 12 },
      { slug: "cable-crunch", sets: 3, repMin: 10, repMax: 15 },
    ],
  },
  {
    code: "B",
    slots: [
      { slug: "barbell-romanian-deadlift", sets: 3, repMin: 6, repMax: 10 },
      { slug: "leg-press", sets: 3, repMin: 8, repMax: 12 },
      { slug: "seated-cable-row", sets: 3, repMin: 8, repMax: 12 },
      { slug: "machine-chest-press", sets: 3, repMin: 8, repMax: 12 },
      { slug: "hanging-leg-raise", sets: 3, repMin: 8, repMax: 12 },
    ],
  },
];

/** SQL-літерал рядка: апостроф подвоюється. Лише для даних цього файлу, не для вводу користувача. */
function q(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Не число: ${n}`);
  return String(n);
}

/**
 * Інструкції сиду по одній, без «;» у кінці — для D1 batch у тестах і файлу для `wrangler d1 execute`.
 * Програму отримує кожен користувач з `users` без активної програми: профіль власника створює
 * перший апдейт (/start), тож сид запускається після нього (docs/RUNBOOK.md).
 */
export function seedStatements(now: number): string[] {
  const out: string[] = [];

  for (const e of CATALOG) {
    out.push(
      "INSERT INTO exercises (id, slug, name_uk, equipment, weight_step_kg, min_weight_kg, muscle_group, cues_uk, video_url, pattern, kind, place, min_level, stress) " +
        `VALUES (${num(e.id)}, ${q(e.slug)}, ${q(e.nameUk)}, ${q(e.equipment)}, ${num(e.stepKg)}, ${num(e.minKg)}, ${q(e.group)}, ${q(e.cues.join("\n"))}, ${e.videoUrl === null ? "NULL" : q(e.videoUrl)}, ${q(e.pattern)}, ${q(e.kind)}, ${q(e.place)}, ${num(e.minLevel)}, ${q(e.stress.join(","))}) ` +
        "ON CONFLICT (slug) DO UPDATE SET name_uk = excluded.name_uk, equipment = excluded.equipment, " +
        "weight_step_kg = excluded.weight_step_kg, min_weight_kg = excluded.min_weight_kg, " +
        "muscle_group = excluded.muscle_group, cues_uk = excluded.cues_uk, video_url = excluded.video_url, " +
        "pattern = excluded.pattern, kind = excluded.kind, place = excluded.place, min_level = excluded.min_level, stress = excluded.stress",
    );
  }

  for (const e of CATALOG) {
    for (const sub of e.substitutes) {
      out.push(
        "INSERT INTO exercise_substitutes (exercise_id, substitute_id) " +
          `SELECT e.id, s.id FROM exercises e, exercises s WHERE e.slug = ${q(e.slug)} AND s.slug = ${q(sub)} ` +
          "ON CONFLICT DO NOTHING",
      );
    }
  }

  out.push(
    "INSERT INTO programs (user_id, name, active, created_at) " +
      `SELECT u.id, ${q(PROGRAM_NAME)}, 1, ${num(now)} FROM users u ` +
      "WHERE NOT EXISTS (SELECT 1 FROM programs p WHERE p.user_id = u.id AND p.active = 1)",
  );

  PROGRAM_DAYS.forEach((day, i) => {
    out.push(
      "INSERT INTO program_days (program_id, code, position, title) " +
        `SELECT p.id, ${q(day.code)}, ${num(i + 1)}, ${q(DAY_TITLES[day.code]!)} FROM programs p WHERE p.active = 1 AND p.name = ${q(PROGRAM_NAME)} ` +
        "ON CONFLICT DO NOTHING",
    );
    day.slots.forEach((slot, j) => {
      out.push(
        "INSERT INTO program_exercises (program_day_id, exercise_id, position, sets, rep_min, rep_max) " +
          `SELECT d.id, e.id, ${num(j + 1)}, ${num(slot.sets)}, ${num(slot.repMin)}, ${num(slot.repMax)} ` +
          "FROM program_days d JOIN programs p ON p.id = d.program_id JOIN exercises e " +
          `ON e.slug = ${q(slot.slug)} WHERE p.active = 1 AND p.name = ${q(PROGRAM_NAME)} AND d.code = ${q(day.code)} ` +
          "ON CONFLICT DO NOTHING",
      );
    });
  });

  return out;
}

/** Текст файлу для `wrangler d1 execute --file`. */
export function seedSql(now: number): string {
  return seedStatements(now).map((s) => s + ";").join("\n") + "\n";
}
