// Таблиці з'являються міграцією у фазі, яка ними користується. Час — UTC мс.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey(), // Telegram ID
    firstName: text("first_name").notNull(),
    tz: text("tz").notNull().default("Europe/Kyiv"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [check("users_first_name_len", sql`length(${t.firstName}) <= 64`)],
);

export const processedUpdates = sqliteTable(
  "processed_updates",
  {
    updateId: integer("update_id").primaryKey(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("processed_updates_created_at").on(t.createdAt)],
);
