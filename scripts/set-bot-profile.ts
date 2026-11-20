// npm run set-bot-profile — меню команд, опис і короткий опис бота (ідемпотентно).
// Змінна TELEGRAM_BOT_TOKEN — із середовища процесу; скрипт її не друкує.
import { runSetBotProfile } from "./set-bot-profile-core.ts";

process.exitCode = await runSetBotProfile({
  env: process.env,
  fetch,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
