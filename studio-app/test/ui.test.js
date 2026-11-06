'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../renderer/helpers');

assert.strictEqual(H.esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
assert.strictEqual(H.fmtTime(3723), '1:02:03');
assert.strictEqual(H.parseTime('12:30'), 750);
assert.ok(Number.isNaN(H.parseTime('12:xx')));
assert.strictEqual(H.fmtViews(1530000), '1.5 млн');
assert.strictEqual(H.fmtViews(25400), '25 тыс.');
assert.strictEqual(H.plural(1, 'ролик', 'ролика', 'роликов'), 'ролик');
assert.strictEqual(H.plural(3, 'ролик', 'ролика', 'роликов'), 'ролика');
assert.strictEqual(H.plural(11, 'ролик', 'ролика', 'роликов'), 'роликов');
assert.strictEqual(H.plural(21, 'ролик', 'ролика', 'роликов'), 'ролик');
assert.deepStrictEqual(H.clampRect({ x: 0.9, y: -0.2, w: 0.3, h: 0.01 }), { x: 0.7, y: 0, w: 0.3, h: 0.04 });

// лицо 100×100 в правом верхнем углу кадра 1280×720 → рамка вокруг, внутри кадра
const cam = H.faceToCam({ x: 1100, y: 40, width: 100, height: 100 }, 1280, 720);
assert.ok(cam.x + cam.w <= 1 + 1e-9 && cam.y >= 0, 'внутри кадра');
assert.ok(cam.w * 1280 >= 250, 'шире лица');
assert.ok(cam.x * 1280 <= 1100 && (cam.x + cam.w) * 1280 >= 1200, 'лицо внутри рамки');
assert.deepStrictEqual(H.biggestFace([{ boundingBox: { width: 10, height: 10 } }, { boundingBox: { width: 50, height: 40 } }]), { width: 50, height: 40 });
assert.strictEqual(H.biggestFace([]), null);

assert.match(H.subCss({ font: 'Montserrat Black', italic: true, color: '#fff', bord: 6, outline: '#000', glow: '#0f0', shadow: 0, upper: true }), /font-style:italic.*-webkit-text-stroke:5px #000.*0 0 14px #0f0/);
assert.match(H.subCss({ font: 'Rubik Black', color: '#fff', box: '#000', upper: false }), /background:rgba/);
assert.deepStrictEqual(H.layoutBands('stream', 0.4).map((b) => b.kind), ['cam', 'video']);
assert.deepStrictEqual(H.layoutBands('filler').map((b) => b.kind), ['stream', 'game']);
for (const k of Object.keys(require('../lib/layout').LAYOUTS)) assert.ok(Math.abs(H.layoutBands(k).reduce((a, b) => a + b.h, 0) - 1) < 1e-9, `полосы ${k} = 100%`);

const rules = { hashtag: '#evelone', twitch: 'evelone2004' };
assert.strictEqual(H.captionPreview('{title} {hashtags}', { title: 'Т', hashtags: '#fyp' }, rules), 'Т #fyp twitch: evelone2004 #evelone');
assert.strictEqual(H.captionPreview('{title} twitch: evelone2004 #evelone', { title: 'Т' }, rules), 'Т twitch: evelone2004 #evelone');
assert.deepStrictEqual(H.buildSummary(3, 7, 5), { need: 21, selected: 5, repeats: 16, uniq: 5, ok: true });

// страница: все id из app.js, которые ищутся через $('#…'), есть в разметке, которую рисует сам app.js или index.html
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const used = new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
const declared = new Set([...(app + html).matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !declared.has(id));
assert.deepStrictEqual(missing, [], 'элементы без разметки');
// иконки, которые использует окно, скопированы
const icons = new Set([...app.matchAll(/ic\('([\w-]+)'/g)].map((m) => m[1]));
for (const x of [...app.matchAll(/icon: '([\w-]+)'/g)]) icons.add(x[1]);
for (const i of icons) assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'icons', `${i}.svg`)), `иконка ${i}`);
// окно не объявляет глобальное имя api (его занимает preload) — из-за этого окно было пустым
assert.doesNotMatch(app, /^(async )?function api\b|^(const|let|var) api\b/m);

// несколько вебок
assert.deepStrictEqual(H.camsOf({ cam: { x: 0, y: 0, w: 0.3, h: 0.3 } }).length, 1, 'старая рамка {cam}');
assert.deepStrictEqual(H.camsOf({ cams: [], cam: null }), []);
assert.deepStrictEqual(H.camsOf(null), []);
const fc = H.facesToCams([{ x: 100, y: 400, width: 80, height: 80 }, { x: 1100, y: 40, width: 100, height: 100 }, { x: 1105, y: 45, width: 90, height: 90 }], 1280, 720);
assert.strictEqual(fc.length, 2, 'перекрывающиеся лица — одна вебка');
assert.ok(fc[0].x < fc[1].x, 'слева направо');
const slot2 = H.nextCamSlot([H.nextCamSlot([])]);
assert.ok(slot2.x < 0.3, 'вторая вебка не поверх первой');
for (const k of Object.keys(require('../lib/layout').LAYOUTS)) assert.ok(H.layoutBands(k).length >= 1);
console.log(`окно: 37 проверок, ${icons.size} иконок`);
