// Файл імпорту дампу даних (`backup-prod.sh` → `…-data.sql`) у D1 зі схемою з міграцій. Чисті функції, без I/O.
// Навіщо (перенос акаунта 2026-11-22): `wrangler d1 export` пише таблиці в порядку sqlite_master — дочірні
// (exercise_substitutes, program_days) раніше за батьківські, — а remote D1 не тримає `PRAGMA defer_foreign_keys`
// на весь `execute --file` і відкидає дамп цілком: FOREIGN KEY constraint failed. Тому INSERT переставляємо
// в порядку FK (батьки першими) і PRAGMA не пишемо зовсім: локальна D1 без PRAGMA перевіряє FK так само суворо.

export interface TableSql {
  name: string;
  sql: string;
}

/** Оператори SQL з тексту дампу: `;` поза лапками ('…' з '' усередині, "…", `…`) закінчує оператор. */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = "";
      }
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === ";") {
      const s = text.slice(start, i + 1).trim();
      if (s) out.push(s);
      start = i + 1;
    }
  }
  if (quote) throw new Error("Дамп обірваний посеред рядка в лапках");
  if (text.slice(start).trim()) throw new Error("Дамп закінчується оператором без «;»");
  return out;
}

/** Батьківські таблиці кожної таблиці — з тексту CREATE TABLE (`REFERENCES …`); `pragma_foreign_key_list` у remote D1 заборонений. */
export function fkParents(tables: TableSql[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const t of tables) {
    const refs = [...t.sql.matchAll(/REFERENCES\s+[`"']?([A-Za-z0-9_]+)/gi)].map((m) => m[1]!).filter((p) => p !== t.name);
    parents.set(t.name, [...new Set(refs)]);
  }
  return parents;
}

const INSERT_RE = /^INSERT INTO "([^"]+)"/;
const PRAGMA = "PRAGMA defer_foreign_keys=TRUE;";

/** Таблиця кожного INSERT дампу (у порядку дампу) — для звірки лічильників і вмісту після імпорту. */
export function dumpInserts(dump: string): { table: string; stmt: string }[] {
  return splitStatements(dump)
    .filter((s) => s !== PRAGMA)
    .map((stmt) => {
      const m = INSERT_RE.exec(stmt);
      if (!m) throw new Error(`У дампі даних не лише INSERT: ${stmt.slice(0, 60)}`);
      return { table: m[1]!, stmt };
    });
}

/**
 * SQL імпорту: DELETE таблиць `clear` (рядок cron_state, який уже записав крон нового Worker) → INSERT таблиць у порядку FK
 * (у межах таблиці — порядок дампу) → рядки sqlite_sequence, кожен після DELETE свого імені (SQLite створює його сам при
 * INSERT в AUTOINCREMENT-таблицю — інакше дубль). Падає на рядках d1_migrations (їх пише `migrations apply`), на таблиці,
 * якої немає в схемі, і на циклі FK.
 */
export function importSql(dump: string, schema: TableSql[], clear: string[] = []): string {
  const inserts = dumpInserts(dump);
  const known = new Set(schema.map((t) => t.name));
  const byTable = new Map<string, string[]>();
  const seq: string[] = [];
  for (const { table, stmt } of inserts) {
    if (table === "d1_migrations") throw new Error("Рядки d1_migrations у дампі даних — це повний дамп, не …-data.sql");
    if (table === "sqlite_sequence") {
      const m = /VALUES\s*\('([A-Za-z0-9_]+)'/.exec(stmt);
      if (!m) throw new Error(`Не розпізнано рядок sqlite_sequence: ${stmt.slice(0, 80)}`);
      seq.push(`DELETE FROM "sqlite_sequence" WHERE name='${m[1]}';`, stmt);
      continue;
    }
    if (!known.has(table)) throw new Error(`Таблиці ${table} немає в схемі цілі — міграції не ті`);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push(stmt);
  }
  const parents = fkParents(schema);
  const order: string[] = [];
  const done = new Set<string>();
  const pending = [...byTable.keys()];
  while (pending.length) {
    // Перша таблиця в порядку дампу, усі батьки якої (з тих, що є в дампі) уже записані.
    const i = pending.findIndex((t) => (parents.get(t) ?? []).every((p) => done.has(p) || !byTable.has(p)));
    if (i < 0) throw new Error(`Цикл FK між таблицями: ${pending.join(", ")}`);
    const t = pending.splice(i, 1)[0]!;
    order.push(t);
    done.add(t);
  }
  const lines = [...clear.map((t) => `DELETE FROM "${t}";`), ...order.flatMap((t) => byTable.get(t)!), ...seq];
  return lines.join("\n") + "\n";
}
