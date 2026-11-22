#!/usr/bin/env node
// Імпорт дампу даних (`backup-prod.sh` → `…-data.sql`) у D1, де схему вже накотили міграції, зі звіркою.
//   node scripts/import-data.mjs <data.sql> --env production|preview   # remote D1 акаунта з wrangler.jsonc
//   node scripts/import-data.mjs <data.sql> --local <тека з wrangler.json> # локальна D1 (тест, репетиція)
// Порядок: схема цілі → охорона (ціль порожня: дані лише в d1_migrations і cron_state) → файл імпорту
// (import-data-core.ts: INSERT у порядку FK) → `execute --file` (атомарно: збій — база як до імпорту) →
// лічильники всіх таблиць = INSERT дампу → export бази = ті самі оператори INSERT, що в дампі.
// Друкує лише імена таблиць і числа, не вміст. Файл імпорту — у тимчасовій теці ОС, поза репозиторієм.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dumpInserts, importSql, splitStatements } from './import-data-core.ts';

const repo = resolve(import.meta.dirname, '..');
const wranglerJs = join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const [dataFile, flag, value] = process.argv.slice(2);
if (!dataFile || !['--env', '--local'].includes(flag) || !value) {
  console.error('Запуск: node scripts/import-data.mjs <data.sql> --env production|preview  або  --local <тека>');
  process.exit(2);
}
const remote = flag === '--env';
const cwd = remote ? repo : resolve(value);
const target = remote ? ['--remote', '--env', value] : ['--local'];
/** Службові таблиці, у яких свіжа БД може мати рядки ще до імпорту. */
const SERVICE = new Set(['d1_migrations', 'cron_state', 'sqlite_sequence']);

function wrangler(args) {
  const r = spawnSync(process.execPath, [wranglerJs, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} → ${r.status}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`);
  return r.stdout;
}
const query = (sql) => JSON.parse(wrangler(['d1', 'execute', 'DB', ...target, '--json', '--command', sql]))[0].results;
function counts(names) {
  return query('SELECT ' + names.map((t) => `(SELECT count(*) FROM "${t}") AS "${t}"`).join(', '))[0];
}

const dump = readFileSync(dataFile, 'utf8');
const schema = query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name");
const names = schema.map((t) => t.name);
const before = counts(names);
const busy = names.filter((t) => before[t] > 0 && !SERVICE.has(t));
if (busy.length) {
  console.error(`Ціль не порожня (${busy.map((t) => `${t}=${before[t]}`).join(' ')}) — імпорт лише в БД, щойно створену міграціями`);
  process.exit(1);
}

const inserts = dumpInserts(dump);
const expected = Object.fromEntries(names.map((t) => [t, 0]));
for (const { table } of inserts) expected[table] = (expected[table] ?? 0) + 1;
const clear = before.cron_state > 0 ? ['cron_state'] : [];
const tmp = mkdtempSync(join(tmpdir(), 'import-data-'));
try {
  const file = join(tmp, 'import.sql');
  writeFileSync(file, importSql(dump, schema, clear));
  wrangler(['d1', 'execute', 'DB', ...target, '--file', file, '--yes']);

  const after = counts(names);
  // d1_migrations — від migrations apply, не з дампу; sqlite_sequence звіряємо значеннями нижче.
  const check = names.filter((t) => t !== 'd1_migrations' && t !== 'sqlite_sequence');
  const bad = check.filter((t) => after[t] !== expected[t]);
  if (after.d1_migrations !== before.d1_migrations) bad.push('d1_migrations');
  console.log(`Рядки (дамп = БД):${check.map((t) => ` ${t}=${after[t]}`).join('')} d1_migrations=${after.d1_migrations}`);

  // Вміст: export бази — ті самі оператори INSERT, що в дампі (cron_state може вже переписати крон, d1_migrations — не з дампу).
  const out = join(tmp, 'after.sql');
  wrangler(['d1', 'export', 'DB', ...target, '--no-schema', '--output', out]);
  // sqlite_sequence лишається у звірці: дубль імені дав би зайвий оператор.
  const skip = /^INSERT INTO "(d1_migrations|cron_state)"|^INSERT INTO "sqlite_sequence" \("name","seq"\) VALUES\('d1_migrations'/;
  const norm = (stmts) => stmts.filter((s) => s.startsWith('INSERT INTO') && !skip.test(s)).sort();
  const want = norm(inserts.map((i) => i.stmt));
  const got = norm(splitStatements(readFileSync(out, 'utf8')));
  const diff = want.length !== got.length ? Math.abs(want.length - got.length) : want.filter((s, i) => s !== got[i]).length;
  console.log(`${diff === 0 ? 'ok  ' : 'FAIL'} вміст: ${want.length} операторів у дампі, ${got.length} у базі, розбіжних ${diff}`);
  if (bad.length) console.error(`Лічильники не збіглися: ${bad.map((t) => `${t} дамп=${expected[t]} БД=${after[t]}`).join(', ')}`);
  process.exitCode = bad.length || diff ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
