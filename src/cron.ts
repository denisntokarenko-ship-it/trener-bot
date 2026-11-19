// Крон прибирання (phase-1-flow.md, P2.6): обірвані тренування й старий дедуп. Нічого не надсилає власнику.
import { createDb } from "./db/client";
import { createRepo } from "./db/repo";
import type { Env } from "./env";

/** Записи дедупу старші за цей вік видаляються (Telegram не повторює апдейт через 3 доби). */
export const PROCESSED_UPDATES_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export async function runCron(env: Env, now: number): Promise<void> {
  const repo = createRepo(createDb(env.DB));
  await repo.abandonStale(now);
  await repo.purgeProcessedUpdates(now - PROCESSED_UPDATES_TTL_MS);
}
