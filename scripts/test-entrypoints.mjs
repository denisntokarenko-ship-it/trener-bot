#!/usr/bin/env node
// Кожен scripts/*.ts — справжнім `node` (нативне зняття типів), як його запускають npm-скрипти й setup-secrets.ps1.
// Навіщо (2026-11-22): `set-webhook` упав у людини з ERR_MODULE_NOT_FOUND `src/domain/plan` — node не дописує
// розширень, а vitest розв'язує шляхи сам, тож юніт-тести цього не бачили. Точки входу — без секретів до першої
// власної помилки валідації (мережі й запису немає); решта модулів — імпортом. Новий файл без запису тут — червоне.
// Запуск: node scripts/test-entrypoints.mjs (у npm run test:scripts).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scripts = resolve(import.meta.dirname);
/** Точки входу: аргументи, очікуваний код виходу і фрагмент виводу. */
const ENTRY = {
  'set-webhook.ts': { args: ['preview'], code: 1, out: 'Не задано змінну середовища TELEGRAM_BOT_TOKEN' },
  'set-bot-profile.ts': { args: [], code: 1, out: 'Не задано змінну середовища TELEGRAM_BOT_TOKEN' },
  'seed.ts': { args: [], code: 0, out: 'INSERT' },
  'seed-foods.ts': { args: [], code: 0, out: 'INSERT' },
  'build-foods-seed.ts': { args: [], code: 2, out: 'Використання' },
};
/** Модулі без побічних дій — лише імпорт. */
const MODULES = ['seed-core.ts', 'seed-videos.ts', 'foods-seed-core.ts', 'set-webhook-core.ts', 'set-bot-profile-core.ts', 'import-data-core.ts'];

const env = { ...process.env };
for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'WORKER_URL']) delete env[k];
let failed = 0;
const files = readdirSync(scripts).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).sort();
for (const f of files) {
  const e = ENTRY[f];
  const args = e ? [join(scripts, f), ...e.args] : ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(scripts, f)).href)})`];
  if (!e && !MODULES.includes(f)) {
    failed++;
    console.log(`FAIL ${f}: новий файл — додай у ENTRY або MODULES`);
    continue;
  }
  const r = spawnSync(process.execPath, args, { cwd: resolve(scripts, '..'), encoding: 'utf8', env, input: '' });
  const out = r.stdout + r.stderr;
  const want = e ?? { code: 0, out: '' };
  const ok = r.status === want.code && out.includes(want.out) && !/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED|Cannot find module/.test(out);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}${e ? ' ' + e.args.join(' ') : ' (import)'} → exit ${r.status}${ok ? '' : '\n' + out.slice(0, 600)}`);
}
process.exit(failed ? 1 : 0);
