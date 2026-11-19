// Друкує SQL ідемпотентного сиду каталогу й програми (scripts/seed-core.ts) у stdout.
// Запуск — npm run seed:local | seed:preview | seed:prod: SQL іде у .seed.sql, далі `wrangler d1 execute --file`.
// Програму отримує кожен профіль з `users` без активної програми — спершу /start боту, потім сид (docs/RUNBOOK.md).
import { seedSql } from "./seed-core.ts";

process.stdout.write(seedSql(Date.now()));
