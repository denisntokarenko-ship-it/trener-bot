// Крон `*/15 * * * *` (phase-2.md, розділ 4): прибирання Фази 1 і нагадування — два незалежні try/catch, збій одного
// не зупиняє другого; наприкінці — cron_state (навіть коли нагадування кидали) і один лог із лічильниками без текстів.
import { MEAL_PENDING_TTL_MS } from "./config";
import { createDb } from "./db/client";
import { createRepo, type Repo } from "./db/repo";
import type { Env } from "./env";
import { runReminders, type Counters, type ReminderOptions } from "./reminders";

/** Записи дедупу старші за цей вік видаляються (Telegram не повторює апдейт через 3 доби). */
export const PROCESSED_UPDATES_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

export async function runCron(env: Env, now: number, deps: { repo?: Repo } & ReminderOptions = {}): Promise<Counters> {
  const repo = deps.repo ?? createRepo(createDb(env.DB));
  let counters: Counters = { sent: 0, skipped: 0, released: 0, errors: 0 };
  let cleanupErrors = 0;
  try {
    await repo.abandonStale(now);
    await repo.purgeProcessedUpdates(now - PROCESSED_UPDATES_TTL_MS);
  } catch (e) {
    cleanupErrors++;
    console.error("cron cleanup failed", { error: errorName(e) });
  }
  // Прострочені pending-прийоми → cancelled з чисткою каталогу (phase-3-photo.md, «Прострочення»); окремий try — збій не зупиняє інших кроків.
  try {
    await repo.expirePendingMeals(now - MEAL_PENDING_TTL_MS);
  } catch (e) {
    cleanupErrors++;
    console.error("cron meals expiry failed", { error: errorName(e) });
  }
  try {
    counters = await runReminders(repo, env.TELEGRAM_BOT_TOKEN, now, deps);
  } catch (e) {
    counters.errors++;
    console.error("cron reminders failed", { error: errorName(e) });
  }
  counters.errors += cleanupErrors;
  try {
    // last_ok_at — лише для тіку без помилок (В1 рев'ю 2.3): інакше «крон живий» при мовчазному збої нагадувань.
    await repo.touchCron(now, counters.errors === 0);
  } catch (e) {
    counters.errors++;
    console.error("cron_state failed", { error: errorName(e) });
  }
  console.log("cron tick", counters);
  return counters;
}
