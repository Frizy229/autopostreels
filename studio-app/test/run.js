'use strict';
// Запуск всех наборов: node test/run.js [фильтр]. Каждый набор — отдельный процесс, падение одного не прячет другие.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const only = process.argv[2] || '';
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f.includes(only)).sort();
let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f} (${Date.now() - t0} мс)${r.stdout.trim() ? ' — ' + r.stdout.trim().split('\n').pop() : ''}`);
  if (!ok) console.log((r.stderr || r.stdout).split('\n').slice(0, 25).join('\n'));
}
console.log(`\n${files.length - failed} из ${files.length} наборов прошли`);
process.exit(failed ? 1 : 0);
