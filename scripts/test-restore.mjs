#!/usr/bin/env node
// Репетиція відновлення (R-2 В1) на локальній D1 справжнім wrangler: міграції → дані (сид, тренування, підходи, вага,
// заявка нагадування) → scripts/backup-prod.sh (wrangler підмінено: --remote → --local) → рецепт RUNBOOK
// «Відкат пізніше ніж за 7 днів»: міграції в чисту БД → execute --file <дамп даних> → лічильники всіх таблиць = джерело.
// Запуск: node scripts/test-restore.mjs (у npm run test:scripts). Нічого не пише в remote D1.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedSql } from './seed-core.ts';

const repo = resolve(import.meta.dirname, '..');
const wranglerJs = join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const tmp = mkdtempSync(join(tmpdir(), 'restore-test-'));
const DB = 'trener-preview';
/** Шлях для bash і wrangler-конфігу: прямі слеші й на Windows. */
const fwd = (p) => p.split(String.fromCharCode(92)).join('/');

/** Окремий «проєкт» зі своєю локальною D1 (.wrangler/state поруч із конфігом) і міграціями репозиторію. */
function project(name) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  const config = { name: 'restore-test', compatibility_date: '2026-10-19', d1_databases: [{ binding: 'DB', database_name: DB, database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: fwd(join(repo, 'migrations')) }] };
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(config));
  return dir;
}
function wrangler(dir, args) {
  const r = spawnSync(process.execPath, [wranglerJs, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} → ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
const sql = (dir, command) => wrangler(dir, ['d1', 'execute', DB, '--local', '--command', command]);
function counts(dir) {
  const tables = JSON.parse(wrangler(dir, ['d1', 'execute', DB, '--local', '--json', '--command', "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name"]))[0].results.map((r) => r.name);
  const q = 'SELECT ' + tables.map((t) => `(SELECT count(*) FROM "${t}") AS "${t}"`).join(', ');
  return JSON.parse(wrangler(dir, ['d1', 'execute', DB, '--local', '--json', '--command', q]))[0].results[0];
}

// 1. Джерело: схема й дані, що мають FK у різні боки (exercise_substitutes → exercises, workout_sets → workouts → program_days).
const src = project('src');
wrangler(src, ['d1', 'migrations', 'apply', DB, '--local']);
sql(src, "INSERT INTO users (id, first_name, created_at) VALUES (369, 'Власник', 0)");
writeFileSync(join(tmp, 'seed.sql'), seedSql(0));
wrangler(src, ['d1', 'execute', DB, '--local', '--file', join(tmp, 'seed.sql')]);
sql(src, `INSERT INTO workouts (user_id, program_day_id, status, started_at, finished_at, effort)
  SELECT 369, id, 'done', 1000, 2000, 3 FROM program_days WHERE code = 'A' LIMIT 1;
INSERT INTO workout_sets (workout_id, program_exercise_id, exercise_id, set_no, weight_kg, reps, prescribed_weight_kg, prescribed_reps, skipped)
  SELECT w.id, pe.id, pe.exercise_id, n.n, 60, 8, 60, 8, 0 FROM workouts w JOIN program_exercises pe ON pe.program_day_id = w.program_day_id AND pe.position = (SELECT MIN(position) FROM program_exercises WHERE program_day_id = w.program_day_id)
  JOIN (SELECT 1 AS n UNION ALL SELECT 2) n;
INSERT INTO body_weights (user_id, local_date, weight_dg, updated_at) VALUES (369, '2026-11-20', 935, 1);
INSERT INTO reminders_sent (user_id, kind, local_date, sent_at, message_id) VALUES (369, 'weigh', '2026-11-21', 1, 42);`);
const before = counts(src);
for (const t of ['users', 'exercises', 'exercise_substitutes', 'programs', 'workouts', 'workout_sets', 'body_weights', 'reminders_sent']) {
  if (!(before[t] > 0)) throw new Error(`фікстура: у джерелі ${t} = ${before[t]}`);
}

// 2. Бекап справжнім скриптом; wrangler — стаб, що переводить --remote/--env у --local цього проєкту.
const stub = join(tmp, 'local-npx.sh');
writeFileSync(stub, `#!/usr/bin/env bash
shift # "wrangler"
args=()
while [ $# -gt 0 ]; do
  case "$1" in --remote) args+=(--local) ;; --env) shift ;; *) args+=("$1") ;; esac
  shift
done
cd "${fwd(src)}" && exec "${fwd(process.execPath)}" "${fwd(wranglerJs)}" "\${args[@]}"
`);
chmodSync(stub, 0o755);
const outDir = join(tmp, 'backups');
const b = spawnSync('bash', [join(repo, 'scripts', 'backup-prod.sh'), 'preview'], { cwd: repo, encoding: 'utf8', env: { ...process.env, NPX: stub, BACKUP_DIR: outDir, CI: '1' } });
if (b.status !== 0) throw new Error(`backup-prod.sh → ${b.status}\n${b.stdout}\n${b.stderr}`);
const dataFile = readdirSync(outDir).find((f) => f.endsWith('-data.sql'));
if (!dataFile) throw new Error('немає дампу даних');

// 3. Рецепт RUNBOOK: міграції в нову БД → дамп даних.
const dst = project('dst');
wrangler(dst, ['d1', 'migrations', 'apply', DB, '--local']);
wrangler(dst, ['d1', 'execute', DB, '--local', '--file', join(outDir, dataFile), '--yes']);
const after = counts(dst);

const diff = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
console.log(`${diff.length === 0 ? 'ok  ' : 'FAIL'} відновлення дампу даних у чисту БД: ${Object.entries(before).map(([t, n]) => `${t}=${n}→${after[t]}`).join(' ')}`);
process.exit(diff.length === 0 ? 0 : 1);
