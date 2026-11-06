'use strict';
// Интерфейс без запуска Electron: все элементы, к которым обращается app.js, есть в index.html,
// каждый метод window.api из app.js объявлен в preload.js и обработан в main.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = read('renderer/index.html'), app = read('renderer/app.js'), preload = read('preload.js'), main = read('main.js');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...app.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !ids.has(id));
assert.deepStrictEqual(missing, [], `нет в index.html: ${missing.join(', ')}`);

const api = new Set([...app.matchAll(/bridge\.([A-Za-z]+)\(/g)].map((m) => m[1]));
for (const name of api) assert.ok(new RegExp(`\\b${name}:`).test(preload), `preload.js не объявляет ${name}`);
const channels = [...preload.matchAll(/call\('([a-z:A-Z]+)'/g)].map((m) => m[1]);
for (const ch of channels) assert.ok(main.includes(`handle('${ch}'`), `main.js не обрабатывает ${ch}`);

// обе вкладки на месте, по умолчанию Instagram
assert.ok(/data-net="instagram"/.test(html) && /data-net="tiktok"/.test(html));
// модуль lib/accounts в main.js ничем не перекрыт (иначе «accounts.accountHealth is not a function» при обновлении)
assert.strictEqual([...main.matchAll(/\b(?:const|let|var)\s+accounts\b/g)].length, 1, 'в main.js переменная accounts перекрывает модуль lib/accounts');
// синтаксис скриптов
new Function(app); // eslint-disable-line no-new-func
console.log('ui tests ok');
