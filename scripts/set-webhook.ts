// npm run set-webhook -- preview | production
// Змінні TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WORKER_URL — із середовища процесу; скрипт їх не друкує.
import { runSetWebhook } from "./set-webhook-core.ts";

process.exitCode = await runSetWebhook(process.argv.slice(2), {
  env: process.env,
  fetch,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
