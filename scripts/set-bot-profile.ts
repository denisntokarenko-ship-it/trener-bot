// npm run set-bot-profile -- preview | production [--no-photo]
// Змінна TELEGRAM_BOT_TOKEN — із середовища процесу; скрипт її не друкує. Людині — scripts/set-bot-profile.ps1 (токен вводиться прихованим вводом).
import { readFileSync } from "node:fs";
import { runSetBotProfile } from "./set-bot-profile-core.ts";

process.exitCode = await runSetBotProfile(process.argv.slice(2), {
  env: process.env,
  fetch,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  readFile: (path) => readFileSync(new URL(`../${path}`, import.meta.url)),
});
