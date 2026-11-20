#!/usr/bin/env node
// Тест scripts/backup-prod.sh зі стабом wrangler (рев'ю 1.5, В3; R-2 В1). Запуск: node scripts/test-backup.mjs; exit 1, якщо хоч один червоний.
// Відновлення з реального дампу в чисту БД — scripts/test-restore.mjs (локальна D1).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'backup-test-'));
const stub = join(tmp, 'fake-npx.sh');
// Стаб: `d1 export … --output F` пише $STUB_EXPORT у F (з --no-schema — $STUB_DATA);
// `d1 execute … --json`: запит із count( → $STUB_COUNTS (JSON-об'єкт), інакше — таблиці з $STUB_TABLES (через кому).
writeFileSync(
  stub,
  `#!/usr/bin/env bash
if [ "$3" = export ]; then
  body="$STUB_EXPORT"
  while [ $# -gt 0 ]; do [ "$1" = --output ] && out="$2"; [ "$1" = --no-schema ] && body="$STUB_DATA"; shift; done
  printf '%b' "$body" > "$out"
elif printf '%s ' "$@" | grep -q 'count('; then
  node -e 'console.log(JSON.stringify([{results:[JSON.parse(process.env.STUB_COUNTS||"{}")]}]))'
else
  node -e 'const t=(process.env.STUB_TABLES||"").split(",").filter(Boolean);console.log(JSON.stringify([{results:t.map(name=>({name}))}]))'
fi
`,
);
chmodSync(stub, 0o755);

const schema = 'CREATE TABLE `users` (id);\nCREATE TABLE `exercises` (id);\nCREATE TABLE IF NOT EXISTS "d1_migrations" (id);';
const data = 'PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "d1_migrations" VALUES(1,\'0000.sql\',\'t\');\nINSERT INTO "users" VALUES(1);\nINSERT INTO "exercises" VALUES(1);\nINSERT INTO "exercises" VALUES(2);\nINSERT INTO "sqlite_sequence" ("name","seq") VALUES(\'d1_migrations\',1);\n';
const tables = 'users,exercises,d1_migrations';
const cases = [
  { name: 'порожня БД + export = рівно PRAGMA → exit 0, файл є', exp: 'PRAGMA defer_foreign_keys=TRUE;\n', tables: '', code: 0, files: 2 },
  { name: 'порожній список + export з CREATE TABLE → exit 1, файли видалено', exp: 'PRAGMA x;\nCREATE TABLE `users` (id)', tables: '', code: 1, files: 0 },
  { name: 'порожній список + сміття в export → exit 1', exp: 'x', tables: '', code: 1, files: 0 },
  { name: 'таблиці є, у бекапі всі → exit 0', exp: 'CREATE TABLE `users` (id);\nCREATE TABLE `exercises` (id);', tables: 'users,exercises', code: 0, files: 2 },
  { name: 'таблиці є, однієї немає в бекапі → exit 1, файли видалено', exp: 'CREATE TABLE `users` (id);', tables: 'users,exercises', code: 1, files: 0 },
  // R-2 В1: дамп даних і звірка з COUNT(*).
  { name: 'дані: рядки дампу = COUNT(*) → exit 0, у дампі даних немає d1_migrations', exp: schema, data, tables, counts: { users: 1, exercises: 2 }, code: 0, files: 2, noMigrations: true },
  { name: 'дані: у БД більше рядків, ніж у дампі → exit 1, обидва файли видалено', exp: schema, data, tables, counts: { users: 1, exercises: 3 }, code: 1, files: 0 },
  { name: 'дані: дамп даних порожній, а в БД є рядки → exit 1', exp: schema, data: 'PRAGMA defer_foreign_keys=TRUE;\n', tables, counts: { users: 1, exercises: 2 }, code: 1, files: 0 },
];

let failed = 0;
cases.forEach((c, i) => {
  const dir = join(tmp, `out${i}`);
  const r = spawnSync('bash', ['scripts/backup-prod.sh', 'preview'], {
    env: { ...process.env, NPX: stub, BACKUP_DIR: dir, STUB_EXPORT: c.exp, STUB_DATA: c.data ?? c.exp, STUB_TABLES: c.tables, STUB_COUNTS: JSON.stringify(c.counts ?? {}) },
    encoding: 'utf8',
  });
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const dataFile = files.find((f) => f.endsWith('-data.sql'));
  const migrationsGone = !c.noMigrations || (dataFile !== undefined && !readFileSync(join(dir, dataFile), 'utf8').includes('d1_migrations'));
  const ok = r.status === c.code && files.length === c.files && migrationsGone;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status}, файлів ${files.length})${ok ? '' : '\n' + r.stderr}`);
});
process.exit(failed ? 1 : 0);
