#!/usr/bin/env node
// Тест точок входу set-bot-profile / set-webhook під голим `node` і файлів аватарок. Запуск: node scripts/test-bot-profile.mjs; exit 1, якщо хоч один червоний.
// Чому окремо від vitest: vitest збирає імпорти бандлером і не помітить `import "../domain/plan"` без розширення, на якому голий node падає ERR_MODULE_NOT_FOUND.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'OK ' : 'ЧЕРВОНЕ'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
}

// Без цілі скрипт має дійти до друку «Використання», а не впасти на імпортах.
for (const [script, usage] of [['scripts/set-bot-profile.ts', 'npm run set-bot-profile'], ['scripts/set-webhook.ts', 'npm run set-webhook']]) {
  const r = spawnSync(process.execPath, [root(script)], { encoding: 'utf8', env: { ...process.env, TELEGRAM_BOT_TOKEN: '' } });
  check(`${script}: голий node доходить до «Використання»`, r.status === 1 && r.stderr.includes(usage), `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
}

// Аватарки: PNG 640x640 (IHDR), JPG (Bot API приймає лише .JPG) з сигнатурою FFD8FF; SVG-джерела є.
for (const name of ['prod', 'preview']) {
  const png = readFileSync(root(`assets/bot/${name}.png`));
  const isPng = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  check(`assets/bot/${name}.png: PNG 640x640`, isPng && png.readUInt32BE(16) === 640 && png.readUInt32BE(20) === 640);
  const jpg = readFileSync(root(`assets/bot/${name}.jpg`));
  check(`assets/bot/${name}.jpg: JPEG`, jpg.subarray(0, 3).toString('hex') === 'ffd8ff' && jpg.length < 1_000_000);
  check(`assets/bot/${name}.svg: джерело`, readFileSync(root(`assets/bot/${name}.svg`), 'utf8').includes('viewBox="0 0 640 640"'));
}

process.exit(failed ? 1 : 0);
