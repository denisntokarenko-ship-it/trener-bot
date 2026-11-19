// Дані й SQL сиду фази 1 без process і без мережі — тестується в pool workers (phase-1.md, P1.1).
// Ідемпотентно: каталог — upsert за slug (хибне припущення про крок → правка тут, без міграції);
// програма, дні й слоти — лише дописує відсутнє, наявне не чіпає. ON CONFLICT DO NOTHING, а не
// INSERT OR IGNORE: той ковтає й порушення CHECK, тож хибні дані сиду зникли б мовчки.

export type Equipment = "barbell" | "dumbbell" | "machine" | "cable" | "bodyweight";
export type MuscleGroup = "legs" | "chest" | "back" | "shoulders" | "core";

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
}

// Таблиця «Каталог і програма» в docs/spec/phase-1.md. Кроки блоків і тренажерів — припущення (open-questions.md).
export const CATALOG: CatalogEntry[] = [
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
    substitutes: [] },
  { id: 12, slug: "dumbbell-bench-press", nameUk: "Жим гантелей лежачи", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "chest",
    cues: ["Лопатки зведені, стопи на підлозі", "Опускай гантелі до рівня грудей під контролем", "Тисни вгору, лікті під кутом близько 45°"],
    substitutes: [] },
  { id: 13, slug: "pull-up", nameUk: "Підтягування", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "back",
    cues: ["Опусти плечі від вух перед кожним повтором", "Тягнись грудьми до перекладини, без ривків", "Опускайся повністю, але повільно"],
    substitutes: [] },
  { id: 14, slug: "barbell-overhead-press", nameUk: "Жим штанги стоячи", equipment: "barbell", stepKg: 5, minKg: 20, group: "shoulders",
    cues: ["Сідниці й прес напружені, поперек не прогинай", "Веди гриф угору близько до обличчя", "Вгорі голова під грифом, лікті випрямлені"],
    substitutes: [] },
  { id: 15, slug: "dumbbell-romanian-deadlift", nameUk: "Румунська тяга з гантелями", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "legs",
    cues: ["Спина рівна весь рух, не округлюй поперек", "Коліна злегка зігнуті, таз відводь назад", "Гантелі ковзають по стегнах до середини гомілки"],
    substitutes: [] },
  { id: 16, slug: "dumbbell-row", nameUk: "Тяга гантелі в нахилі", equipment: "dumbbell", stepKg: 2, minKg: 2, group: "back",
    cues: ["Спина рівна, упрись рукою й коліном у лаву", "Тягни гантель до пояса, лікоть уздовж тіла", "Не розвертай корпус, опускай гантель повільно"],
    substitutes: [] },
  { id: 17, slug: "dips", nameUk: "Віджимання на брусах", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "chest",
    cues: ["Плечі вниз, не провалюйся в плечах", "Опускайся до 90° у ліктях, не нижче", "Корпус трохи вперед, вижимай без ривків"],
    substitutes: [] },
  { id: 18, slug: "hanging-knee-raise", nameUk: "Підйом колін у висі", equipment: "bodyweight", stepKg: 0, minKg: 0, group: "core",
    cues: ["Не розгойдуйся, плечі активні, лопатки вниз", "Підтягуй коліна до грудей силою преса", "Опускай ноги повільно, під контролем"],
    substitutes: [] },
];

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
      "INSERT INTO exercises (id, slug, name_uk, equipment, weight_step_kg, min_weight_kg, muscle_group, cues_uk, video_url) " +
        `VALUES (${num(e.id)}, ${q(e.slug)}, ${q(e.nameUk)}, ${q(e.equipment)}, ${num(e.stepKg)}, ${num(e.minKg)}, ${q(e.group)}, ${q(e.cues.join("\n"))}, NULL) ` +
        "ON CONFLICT (slug) DO UPDATE SET name_uk = excluded.name_uk, equipment = excluded.equipment, " +
        "weight_step_kg = excluded.weight_step_kg, min_weight_kg = excluded.min_weight_kg, " +
        "muscle_group = excluded.muscle_group, cues_uk = excluded.cues_uk",
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
      "INSERT INTO program_days (program_id, code, position) " +
        `SELECT p.id, ${q(day.code)}, ${num(i + 1)} FROM programs p WHERE p.active = 1 AND p.name = ${q(PROGRAM_NAME)} ` +
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
