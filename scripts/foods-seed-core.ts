// Сид каталогу продуктів без process і без мережі — тестується в pool workers (phase-3.md §2, P3.1.6).
// Пайплайн: foods-map.json (ручна мапа) + CSV USDA SR Legacy → foods-seed.json (комітимо) → SQL для D1.
import { normalizeAlias } from "../src/domain/text.ts";

/** Атрибуція FDC (просять вказати джерело); той самий рядок — у docs/spec/decisions.md. */
export const SOURCE_NOTE = "U.S. Department of Agriculture, Agricultural Research Service, FoodData Central, SR Legacy (2018), CC0 1.0";

export interface MapEntry {
  name_uk: string;
  /** Додаткові аліаси (сира форма); `normalizeAlias(name_uk)` додається завжди. */
  aliases: string[];
  fdc_ref: string;
  /** Очікуваний англійський опис у SR: захист від переплутаних рядків («сирий» ↔ «варений»). */
  fdc_desc: string;
}
export interface SeedFood {
  name_uk: string;
  /** Нормалізовані, унікальні в межах продукту; перший — аліас назви. */
  aliases: string[];
  fdc_ref: string;
  kcal_100: number;
  protein_100_dg: number;
  fat_100_dg: number;
  carbs_100_dg: number;
}
export interface FoodsSeed {
  source_note: string;
  /** Дата вибірки з джерела (YYYY-MM-DD). */
  sampled_at: string;
  foods: SeedFood[];
}

// Ідентифікатори нутрієнтів FDC: 1008 — Energy (kcal), 1003 — Protein, 1004 — Total lipid (fat), 1005 — Carbohydrate, by difference.
const NUTRIENT_KCAL = "1008";
const NUTRIENT_PROTEIN = "1003";
const NUTRIENT_FAT = "1004";
const NUTRIENT_CARBS = "1005";

/** CSV за RFC 4180: лапки, `""` усередині, переноси рядків у полі. Порожній хвіст ігнорується. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function column(header: string[], name: string, file: string): number {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`${file}: немає стовпця «${name}»`);
  return i;
}

/**
 * Збирає сид з мапи й двох CSV (food.csv, food_nutrient.csv). Падає — і нічого не повертає — якщо:
 * опис за `fdc_ref` ≠ `fdc_desc`; продукту чи нутрієнта немає в CSV; два нормалізовані аліаси збігаються між продуктами
 * (`alias` — PK, ON CONFLICT DO NOTHING мовчки віддав би його першому); аліас порожній; макроси > 100 г на 100 г; назва задовга.
 * `table` — рядки `name_uk → fdc_desc → ккал` для людського погляду в PR.
 */
export function buildFoodsSeed(map: MapEntry[], foodCsv: string, nutrientCsv: string, sampledAt: string): { seed: FoodsSeed; table: string } {
  const food = parseCsv(foodCsv);
  const fh = food[0] ?? [];
  const fId = column(fh, "fdc_id", "food.csv");
  const fDesc = column(fh, "description", "food.csv");
  const descById = new Map(food.slice(1).map((r) => [r[fId]!, r[fDesc]!]));

  const wanted = new Set(map.map((e) => e.fdc_ref));
  const nut = parseCsv(nutrientCsv);
  const nh = nut[0] ?? [];
  const nFood = column(nh, "fdc_id", "food_nutrient.csv");
  const nNut = column(nh, "nutrient_id", "food_nutrient.csv");
  const nAmount = column(nh, "amount", "food_nutrient.csv");
  const amounts = new Map<string, Map<string, number>>();
  for (const r of nut.slice(1)) {
    const id = r[nFood]!;
    if (!wanted.has(id)) continue;
    const m = amounts.get(id) ?? new Map<string, number>();
    m.set(r[nNut]!, Number(r[nAmount]));
    amounts.set(id, m);
  }

  const owner = new Map<string, string>();
  const refs = new Set<string>();
  const foods: SeedFood[] = [];
  const lines: string[] = [];
  for (const e of map) {
    if (refs.has(e.fdc_ref)) throw new Error(`«${e.name_uk}»: fdc_ref ${e.fdc_ref} вже є в мапі`);
    refs.add(e.fdc_ref);
    if ([...e.name_uk].length < 1 || [...e.name_uk].length > 60) throw new Error(`«${e.name_uk}»: назва має бути 1–60 символів`);
    const desc = descById.get(e.fdc_ref);
    if (desc === undefined) throw new Error(`«${e.name_uk}»: fdc_ref ${e.fdc_ref} немає в food.csv`);
    if (desc !== e.fdc_desc) throw new Error(`«${e.name_uk}»: опис у CSV «${desc}» ≠ fdc_desc «${e.fdc_desc}» (fdc_ref ${e.fdc_ref})`);
    const a = amounts.get(e.fdc_ref);
    const val = (id: string, what: string): number => {
      const v = a?.get(id);
      if (v === undefined || !Number.isFinite(v) || v < 0) throw new Error(`«${e.name_uk}»: у food_nutrient.csv немає значення «${what}» (fdc_ref ${e.fdc_ref})`);
      return v;
    };
    const kcal = Math.round(val(NUTRIENT_KCAL, "kcal"));
    const protein = Math.round(val(NUTRIENT_PROTEIN, "білок") * 10);
    const fat = Math.round(val(NUTRIENT_FAT, "жир") * 10);
    const carbs = Math.round(val(NUTRIENT_CARBS, "вуглеводи") * 10);
    if (protein + fat + carbs > 1000) throw new Error(`«${e.name_uk}»: Б+Ж+В = ${(protein + fat + carbs) / 10} г на 100 г`);
    if (kcal > 900) throw new Error(`«${e.name_uk}»: ${kcal} ккал на 100 г > 900`);

    const aliases: string[] = [];
    for (const raw of [e.name_uk, ...e.aliases]) {
      const key = normalizeAlias(raw);
      if (key === null) throw new Error(`«${e.name_uk}»: аліас «${raw}» порожній після нормалізації`);
      const prev = owner.get(key);
      if (prev !== undefined && prev !== e.name_uk) throw new Error(`аліас «${key}» збігається у «${prev}» і «${e.name_uk}»`);
      owner.set(key, e.name_uk);
      if (!aliases.includes(key)) aliases.push(key);
    }
    foods.push({ name_uk: e.name_uk, aliases, fdc_ref: e.fdc_ref, kcal_100: kcal, protein_100_dg: protein, fat_100_dg: fat, carbs_100_dg: carbs });
    lines.push(`${e.name_uk} → ${desc} → ${kcal} ккал`);
  }
  return { seed: { source_note: SOURCE_NOTE, sampled_at: sampledAt, foods }, table: lines.join("\n") };
}

function q(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * Ідемпотентний SQL сиду. Ключ продукту — `fdc_ref` (унікальний частковий індекс): повтор нічого не змінює,
 * зміна значень у мапі оновлює продукт на місці (id не змінюється, історія тримається на знімках). Аліаси — ON CONFLICT DO NOTHING.
 */
export function foodsSeedStatements(seed: FoodsSeed, now: number): string[] {
  const out: string[] = [];
  for (const f of seed.foods) {
    out.push(
      `INSERT INTO foods (name_uk, kcal_100, protein_100_dg, fat_100_dg, carbs_100_dg, source, fdc_ref, created_at) VALUES (${q(f.name_uk)}, ${f.kcal_100}, ${f.protein_100_dg}, ${f.fat_100_dg}, ${f.carbs_100_dg}, 'seed', ${q(f.fdc_ref)}, ${now}) ` +
        `ON CONFLICT (fdc_ref) WHERE fdc_ref IS NOT NULL DO UPDATE SET name_uk = excluded.name_uk, kcal_100 = excluded.kcal_100, protein_100_dg = excluded.protein_100_dg, fat_100_dg = excluded.fat_100_dg, carbs_100_dg = excluded.carbs_100_dg ` +
        `WHERE foods.name_uk <> excluded.name_uk OR foods.kcal_100 <> excluded.kcal_100 OR foods.protein_100_dg <> excluded.protein_100_dg OR foods.fat_100_dg <> excluded.fat_100_dg OR foods.carbs_100_dg <> excluded.carbs_100_dg`,
    );
    for (const alias of f.aliases) {
      out.push(`INSERT INTO food_aliases (alias, food_id) SELECT ${q(alias)}, id FROM foods WHERE fdc_ref = ${q(f.fdc_ref)} ON CONFLICT (alias) DO NOTHING`);
    }
  }
  return out;
}

export function foodsSeedSql(seed: FoodsSeed, now: number): string {
  return foodsSeedStatements(seed, now).map((s) => s + ";").join("\n") + "\n";
}
