// Друкує SQL ідемпотентного сиду продуктів (scripts/foods-seed.json) у stdout.
// Запуск — npm run seed:foods:local | seed:foods:preview | seed:foods:prod: SQL іде у .seed-foods.sql, далі `wrangler d1 execute --file`.
import { readFileSync } from "node:fs";
import { foodsSeedSql, type FoodsSeed } from "./foods-seed-core.ts";

const seed = JSON.parse(readFileSync(new URL("./foods-seed.json", import.meta.url), "utf8")) as FoodsSeed;
process.stdout.write(foodsSeedSql(seed, Date.now()));
