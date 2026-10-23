// Єдиний вхід у D1. Функції над даними користувача приймають userId (N8);
// processed_updates — службова таблиця Telegram, ключ у неї — update_id.
import { lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { processedUpdates, users } from "./schema";

export const FIRST_NAME_MAX = 64;

export function createRepo(db: Db) {
  return {
    /** Створює профіль або оновлює first_name; tz і created_at не чіпає. Без зміни імені — 0 записаних рядків. */
    async upsertUser(userId: number, firstName: string, now: number): Promise<void> {
      const name = [...firstName].slice(0, FIRST_NAME_MAX).join("");
      await db
        .insert(users)
        .values({ id: userId, firstName: name, createdAt: now })
        .onConflictDoUpdate({
          target: users.id,
          set: { firstName: sql`excluded.first_name` },
          setWhere: sql`${users.firstName} <> excluded.first_name`,
        })
        .run();
    },

    /** true — апдейт новий і щойно записаний; false — уже оброблявся. */
    async markUpdateProcessed(updateId: number, now: number = Date.now()): Promise<boolean> {
      const res = await db
        .insert(processedUpdates)
        .values({ updateId, createdAt: now })
        .onConflictDoNothing()
        .run();
      return res.meta.changes === 1;
    },

    /** Видаляє записи дедупу, старші за olderThan (UTC мс). Повертає кількість видалених. */
    async purgeProcessedUpdates(olderThan: number): Promise<number> {
      const res = await db.delete(processedUpdates).where(lt(processedUpdates.createdAt, olderThan)).run();
      return res.meta.changes;
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
