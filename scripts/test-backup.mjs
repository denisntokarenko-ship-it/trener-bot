#!/usr/bin/env node
// Тест scripts/backup-prod.sh зі стабом wrangler (рев'ю 1.5, В3). Запуск: node scripts/test-backup.mjs; exit 1, якщо хоч один червоний.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'backup-test-'));
const stub = join(tmp, 'fake-npx.sh');
// Стаб: `d1 export … --output F` пише $STUB_EXPORT у F; `d1 execute … --json` друкує таблиці з $STUB_TABLES (через кому).
writeFileSync(
  stub,
  `#!/usr/bin/env bash
if [ "$3" = export ]; then
  while [ $# -gt 0 ]; do [ "$1" = --output ] && out="$2"; shift; done
  printf '%b' "$STUB_EXPORT" > "$out"
else
  node -e 'const t=(process.env.STUB_TABLES||"").split(",").filter(Boolean);console.log(JSON.stringify([{results:t.map(name=>({name}))}]))'
fi
`,
);
chmodSync(stub, 0o755);

const cases = [
  { name: 'порожня БД + export = рівно PRAGMA → exit 0, файл є', exp: 'PRAGMA defer_foreign_keys=TRUE;\n', tables: '', code: 0, file: true },
  { name: 'порожній список + export з CREATE TABLE → exit 1, файл видалено', exp: 'PRAGMA x;\nCREATE TABLE `users` (id)', tables: '', code: 1, file: false },
  { name: 'порожній список + сміття в export → exit 1', exp: 'x', tables: '', code: 1, file: false },
  { name: 'таблиці є, у бекапі всі → exit 0', exp: 'CREATE TABLE `users` (id);\nCREATE TABLE `exercises` (id);', tables: 'users,exercises', code: 0, file: true },
  { name: 'таблиці є, однієї немає в бекапі → exit 1, файл видалено', exp: 'CREATE TABLE `users` (id);', tables: 'users,exercises', code: 1, file: false },
];

let failed = 0;
cases.forEach((c, i) => {
  const dir = join(tmp, `out${i}`);
  const r = spawnSync('bash', ['scripts/backup-prod.sh', 'preview'], {
    env: { ...process.env, NPX: stub, BACKUP_DIR: dir, STUB_EXPORT: c.exp, STUB_TABLES: c.tables },
    encoding: 'utf8',
  });
  const hasFile = existsSync(dir) && readdirSync(dir).length > 0;
  const ok = r.status === c.code && hasFile === c.file;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status}, файл ${hasFile})`);
});
process.exit(failed ? 1 : 0);
