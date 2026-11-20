// Збирає scripts/foods-seed.json з scripts/foods-map.json і CSV USDA FoodData Central SR Legacy (CSV не комітимо).
//   node scripts/build-foods-seed.ts <папка з food.csv і food_nutrient.csv> [YYYY-MM-DD дата вибірки]
// Падає на розбіжності опису й на дубль аліаса; у stdout — таблиця `name_uk → fdc_desc → ккал` для PR.
import { readFileSync, writeFileSync } from "node:fs";
import { buildFoodsSeed, type MapEntry } from "./foods-seed-core.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("Використання: node scripts/build-foods-seed.ts <папка CSV SR Legacy> [YYYY-MM-DD]");
  process.exit(2);
}
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const map = JSON.parse(readFileSync(new URL("./foods-map.json", import.meta.url), "utf8")) as MapEntry[];
try {
  const { seed, table } = buildFoodsSeed(map, readFileSync(`${dir}/food.csv`, "utf8"), readFileSync(`${dir}/food_nutrient.csv`, "utf8"), date);
  // Один продукт — один рядок: дифф сиду читається.
  const foods = seed.foods.map((f) => "    " + JSON.stringify(f)).join(",\n");
  const json = `{\n  "source_note": ${JSON.stringify(seed.source_note)},\n  "sampled_at": ${JSON.stringify(seed.sampled_at)},\n  "foods": [\n${foods}\n  ]\n}\n`;
  writeFileSync(new URL("./foods-seed.json", import.meta.url), json);
  console.log(table);
  console.error(`foods-seed.json: ${seed.foods.length} продуктів, вибірка ${date}`);
} catch (e) {
  console.error("ПОМИЛКА:", e instanceof Error ? e.message : e);
  process.exit(1);
}
