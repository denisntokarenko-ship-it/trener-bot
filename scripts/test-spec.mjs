#!/usr/bin/env node
// Перевірки спеки за рев'ю 0.2 (docs/reviews/0.2.md): кожна носить id зауваження.
// Запуск: node scripts/test-spec.mjs [корінь репозиторію]; exit 1, якщо хоч одна червона.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const read = (p) => readFileSync(join(root, p), 'utf8');
const flow = read('docs/spec/phase-1-flow.md');
const phase1 = read('docs/spec/phase-1.md');
const phase0 = read('docs/spec/phase-0.md');
const decisions = read('docs/spec/decisions.md');
const prompts1 = read('docs/prompts/phase-1.md');

const results = [];
function check(id, name, fn) {
  try {
    fn();
    results.push({ id, name, ok: true });
  } catch (e) {
    results.push({ id, name, ok: false, why: e.message });
  }
}
function assert(cond, why) {
  if (!cond) throw new Error(why);
}

// Текст від заголовка до наступного заголовка того самого або вищого рівня.
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  assert(start >= 0, `немає розділу «${heading}»`);
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// Рядки першої markdown-таблиці в тексті, без заголовка й роздільника.
function tableRows(text) {
  const rows = text.split('\n').filter((l) => l.startsWith('|'));
  return rows.slice(2).map((l) => l.slice(1, -1).split('|').map((c) => c.trim()));
}

// Пункт N нумерованого списку в тексті.
function item(text, n) {
  const m = text.match(new RegExp(`^${n}\\. (.*)$`, 'm'));
  assert(m, `немає пункту ${n}`);
  return m[1];
}

// ---------- Таблиця «Перевірка кнопки» (phase-1-flow.md) ----------

const buttonRows = tableRows(section(flow, '### Перевірка кнопки')).map(([situation, answer]) => {
  const prefix = situation.match(/^((?:`[a-z]`, )*`[a-z]`):/);
  const actions = prefix ? prefix[1].match(/[a-z]/g) : null; // null — рядок для всіх дій
  return { situation, answer, actions };
});
const appliesTo = (row, a) => row.actions === null || row.actions.includes(a);

check('контроль', 'таблиця «Перевірка кнопки» читається', () => {
  assert(buttonRows.length >= 8, `рядків ${buttonRows.length} < 8`);
  assert(buttonRows.every((r) => r.answer.startsWith('«')), 'є рядок без тексту відповіді');
  assert(buttonRows.some((r) => r.actions?.includes('f')), 'жодного рядка з префіксом дії');
});

check('Б1', 'допустима `e`: у слоті вже є рядки → їхня вправа, а не список замін', () => {
  const row = buttonRows.find((r) => r.actions === null && r.situation.includes('`e`'));
  assert(row, 'немає рядка з перевіркою `e`');
  assert(/є рядки[^|]*їхня вправа/.test(row.situation),
    `рядок не допускає вправу, якою закріплено слот: «${row.situation}»`);
  assert(/рядків немає[^|]*заміна/.test(row.situation),
    `рядок не каже, що до першого підходу допустима заміна: «${row.situation}»`);
});

check('Д1', '`x`/`y` після першого підходу слота — застаріла', () => {
  const row = buttonRows.find((r) => appliesTo(r, 'x') && appliesTo(r, 'y') && r.actions !== null
    && /вже є підхід/.test(r.situation));
  assert(row, 'немає рядка `x`, `y`: у слоті вже є підхід');
  assert(row.answer.startsWith('«Кнопка застаріла'), `відповідь «${row.answer}»`);
});

check('В1', 'повторна оцінка після `done` досяжна й не відкриває чуже', () => {
  const doneIdx = buttonRows.findIndex((r) => appliesTo(r, 'f') && r.situation.includes('`done`'));
  assert(doneIdx >= 0, 'немає рядка про `done` для `f`');
  assert(buttonRows[doneIdx].answer.includes('Оцінку вже записано'),
    `для [5] після done першим спрацює «${buttonRows[doneIdx].answer}»`);
  const foreignIdx = buttonRows.findIndex((r) => appliesTo(r, 'f') && r.situation.includes('чуже'));
  assert(foreignIdx >= 0 && foreignIdx < doneIdx, 'чуже `done`-тренування з `f` відкриє підсумок (IDOR)');
  assert(buttonRows[foreignIdx].answer.includes('завершене'), 'чуже тренування — не «завершене»');
  const p152 = item(section(flow, '### P1.5'), 2);
  assert(!/будь-яка кнопка/.test(p152) || /крім оцінки/.test(p152),
    `P1.5.2 суперечить P2.3.4: «${p152}»`);
});

check('Б2', 'вага на екрані: `g` з кнопки має пріоритет над записаним підходом', () => {
  const p = flow.split('\n').find((l) => l.startsWith('**Вага на екрані:**'));
  assert(p, 'немає абзацу «Вага на екрані»');
  const iBtn = p.indexOf('з кнопки');
  const iLast = p.indexOf('останнього непропущеного');
  const iPresc = p.lastIndexOf('призначення');
  assert(iBtn >= 0 && iLast >= 0 && iPresc >= 0, `абзац не називає трьох джерел: «${p}»`);
  assert(iBtn < iLast && iLast < iPresc, `порядок джерел не «кнопка → підхід → призначення»: «${p}»`);
  const cancel = item(section(flow, '### Введення ваги'), 5);
  assert(!/призначеною вагою/.test(cancel), `[↩️ Скасувати] обіцяє призначену вагу всупереч правилу: «${cancel}»`);
});

check('Д2', 'CHECK не «обнуляє» `await_input` — обнуляє код явно', () => {
  for (const [name, text] of [['phase-1-flow.md', flow], ['decisions.md', decisions]]) {
    assert(!/обнуля\S* CHECK|CHECK обнуля/.test(text), `${name}: «обнуляється CHECK»`);
  }
  assert(/обнуляє `await_input` явно/.test(flow), 'flow не вимагає явного обнулення `await_input`');
});

// ---------- phase-0.md ----------

check('В2', 'не-приватні чати відсікаються до обробника', () => {
  const step4 = item(section(phase0, '## Порядок обробки запиту'), 4);
  assert(/chat\.type/.test(step4) && /`private`/.test(step4), `крок 4 не перевіряє тип чату: «${step4}»`);
  const outside = section(phase0, '## Поза межами');
  assert(!/Групи[^\n]*їх не просить/.test(outside), '«Поза межами» досі каже, що групи фільтрує allowed_updates');
  const p12 = section(phase0, '### P1.2');
  assert(/6\. \*\*Given\*\*[^\n]*(group|не приватн)/.test(p12), 'немає історії P1.2.6 про груповий чат');
});

check('Д3', 'аргумент set-webhook видно у виводі разом із ботом', () => {
  const p21 = section(phase0, '### P2.1');
  assert(/getMe/.test(p21), 'скрипт не показує, якого бота оновлено (getMe)');
  assert(/друкує[^\n]*середовище/.test(p21), 'скрипт не друкує середовище з аргументу');
});

// ---------- prompts/phase-1.md ----------

check('Д4', 'промпти потоку й рев\'ю фази 1 читають phase-1-flow.md', () => {
  const need = [
    '## 1.3 ', '## 1.4 ', '### ↳ Рев\'ю 1.5', '### ↳ Рев\'ю Фази 1',
  ];
  for (const h of need) {
    assert(section(prompts1, h).includes('phase-1-flow.md'), `«${h.trim()}» не згадує phase-1-flow.md`);
  }
  assert(!/callback_data за форматом phase-1\.md/.test(prompts1), '1.3 шукає callback_data у phase-1.md');
});

// ---------- phase-1.md ----------

check('Д5', 'кожне поле `workout_sets` має споживача поза схемою', () => {
  const start = phase1.indexOf('**`workout_sets`**');
  assert(start >= 0, 'немає таблиці `workout_sets`');
  const tail = phase1.slice(start);
  const tableText = tail.slice(0, tail.indexOf('\n\n', tail.indexOf('|')));
  const fields = tableRows(tableText).flatMap(([f]) => f.match(/`[a-z_]+`/g) ?? []).map((f) => f.slice(1, -1));
  assert(fields.length >= 9, `розібрано полів ${fields.length} < 9`);
  const elsewhere = phase1.replace(tableText, '') + flow;
  const unused = fields.filter((f) => f !== 'id' && !elsewhere.includes(`\`${f}\``)
    && !elsewhere.includes(`\`${f.replace(/_[a-z]+(_[a-z]+)?$/, '')}_*\``));
  assert(unused.length === 0, `поля без споживача: ${unused.join(', ')}`);
});

check('Д6', 'decisions не наводить неперевірюваний розмір файлу до розрізу', () => {
  assert(!/40,7 КБ/.test(decisions), 'decisions.md: «40,7 КБ» розходиться з 42 929 Б автора');
});

// ---------- В3: таблиця прогресії як оракул ----------

// Еталон правил phase-1.md «Правила прогресії»; m — увімкнений мутант.
function nextPrescription(history, ex, slot, m = {}) {
  const norm = (x) => (ex.step === 0 ? Math.max(ex.min, x)
    : Math.max(ex.min, Math.floor(x / ex.step + 1e-9) * ex.step));
  const analyzed = history
    .filter((s) => !(m.noAbandoned && s.effort === null))
    .map((s) => {
      const planned = s.sets ?? slot.sets;
      const all = [...s.items, ...Array(Math.max(0, planned - s.items.length)).fill(null)];
      const done = all.filter((x) => x !== null);
      const skipped = all.length - done.length;
      const W = done.length ? (m.wMax ? Math.max(...done.map((x) => x.w)) : done.at(-1).w) : undefined;
      const working = done.filter((x) => x.w === W);
      const complete = m.skipIgnoredForIncrease
        ? done.length > 0 && working.length === done.length
        : working.length === planned && skipped === 0;
      const success = complete && working.every((x) => (m.successGt ? x.r > slot.repMax : x.r >= slot.repMax));
      const failure = working.some((x) => (m.failLe ? x.r <= slot.repMin : x.r < slot.repMin))
        || (m.skipIsFailure && skipped > 0);
      const maxReps = working.length ? Math.max(...working.map((x) => x.r)) : 0;
      return { counted: done.length > 0, W, success, failure, maxReps, effort: s.effort };
    });
  const anyCounted = analyzed.some((s) => s.counted);
  const sessions = analyzed.filter((s) => s.counted || (m.fullySkippedCounts && anyCounted));
  if (sessions.length === 0) return { w: ex.min, r: slot.repMin, rule: 1 };
  const last = sessions.at(-1);
  const prev = sessions.at(-2);
  let res;
  if (prev && last.failure && prev.failure && (m.failCounterAnyW || prev.W === last.W)) {
    res = { w: last.W * (m.deload95 ? 0.95 : 0.9), r: slot.repMin, rule: 4 };
  } else if (last.success && last.effort === 5
    && !(prev && prev.success && prev.effort === 5 && (m.holdNoSameW || prev.W === last.W))) {
    res = { w: last.W, r: slot.repMax, rule: 5 };
  } else if (last.success) {
    res = ex.step === 0 ? { w: last.W, r: slot.repMax, rule: 2 } : { w: last.W + ex.step, r: slot.repMin, rule: 2 };
  } else {
    const lo = m.rule3NoLowerBound ? -Infinity : slot.repMin;
    res = { w: last.W, r: Math.min(slot.repMax, Math.max(lo, last.maxReps + 1)), rule: 3 };
  }
  return { ...res, w: norm(res.w) };
}

const MUTANTS = {
  deload95: '0,95 замість 0,9',
  successGt: '`>` замість `>=` в успіху',
  skipIsFailure: 'пропуск = невдача',
  skipIgnoredForIncrease: 'пропуск ігнорується для підвищення',
  wMax: 'W = максимальна вага',
  noAbandoned: 'без `abandoned`',
  failCounterAnyW: 'лічильник невдач без «тієї самої W»',
  failLe: 'невдача `<= rep_min`',
  rule3NoLowerBound: 'правило 3 без нижньої межі `rep_min`',
  fullySkippedCounts: 'повністю пропущена сесія зараховується, якщо є інша історія',
  holdNoSameW: 'правило 5 без «тієї самої W»',
};

const num = (s) => Number(s.replace(',', '.'));

function parseCase(c) {
  const ex = { step: 5, min: 20 };
  const slot = { sets: 3, repMin: 6, repMax: 10 };
  if (/гантелі/.test(c)) ex.min = 2;
  if (/вага тіла/.test(c)) Object.assign(ex, { step: 0, min: 0 });
  const step = c.match(/крок (\d+(?:,\d+)?)/);
  if (step) ex.step = num(step[1]);
  const min = c.match(/мін (\d+(?:,\d+)?)/);
  if (min) ex.min = num(min[1]);
  const sl = c.match(/слот (\d+) × (\d+)–(\d+)/);
  if (sl) Object.assign(slot, { sets: +sl[1], repMin: +sl[2], repMax: +sl[3] });
  return { ex, slot };
}

// «`60×6,60×5` (з 3) [4]; …» → сесії; null, якщо запис не формальний.
function parseHistory(h) {
  if (h === '—') return [];
  const sessions = [];
  for (const part of h.split('; ')) {
    const m = part.match(/^`([^`]+)`(?: \(з (\d+)\))? \[(\d|—)\]$/);
    if (!m) return null;
    const items = [];
    for (const x of m[1].split(',')) {
      if (x === '—') { items.push(null); continue; }
      const wr = x.match(/^(\d+(?:\.\d+)?)×(\d+)$/);
      if (!wr) return null;
      items.push({ w: Number(wr[1]), r: Number(wr[2]) });
    }
    sessions.push({ items, sets: m[2] ? +m[2] : undefined, effort: m[3] === '—' ? null : +m[3] });
  }
  return sessions;
}

const tStart = phase1.indexOf('**Таблиця «історія → призначення».**');
const progRows = tStart < 0 ? [] : tableRows(phase1.slice(tStart, phase1.indexOf('\n\n', phase1.indexOf('|', tStart))));
const cases = [];
const informal = [];
for (const [n, c, h, p, rule] of progRows) {
  const history = parseHistory(h);
  const pm = p.match(/^(\d+(?:,\d+)?) × (\d+)$/);
  if (!history || !pm) { informal.push(n); continue; }
  cases.push({ n, ...parseCase(c), history, want: { w: num(pm[1]), r: +pm[2], rule: +rule.match(/\d+/)[0] } });
}
const run = (cs, m) => cs.filter(({ history, ex, slot, want }) => {
  const got = nextPrescription(history, ex, slot, m);
  return got.w !== want.w || got.r !== want.r || got.rule !== want.rule;
});

check('В3', 'кожен рядок таблиці прогресії записаний формально', () => {
  assert(progRows.length >= 23, `рядків ${progRows.length} < 23`);
  assert(informal.length === 0, `рядки без формального запису (оракул їх не бачить): ${informal.join(', ')}`);
});
check('В3', 'еталон правил збігається з усіма рядками таблиці', () => {
  assert(cases.length >= 23, `розібрано ${cases.length} рядків`);
  const bad = run(cases, {});
  assert(bad.length === 0, `еталон розходиться з рядками ${bad.map((c) => c.n).join(', ')}`);
});
for (const [key, label] of Object.entries(MUTANTS)) {
  check('В3', `мутант убитий: ${label}`, () => {
    assert(run(cases, { [key]: true }).length > 0, 'вижив — таблиця його не ловить');
  });
}

// ---------- Звіт ----------

for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.id} — ${r.name}${r.ok ? '' : `\n     ${r.why}`}`);
}
const red = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - red}/${results.length} зелених`);
process.exit(red ? 1 : 0);
