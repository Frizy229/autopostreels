'use strict';
const assert = require('assert');
const L = require('../lib/layout');

// рамка в пиксели: чётные, внутри кадра
assert.deepStrictEqual(L.rectPx({ x: 0.7, y: 0, w: 0.3, h: 0.35 }, 1920, 1080), { x: 1344, y: 0, w: 576, h: 378 });
const edge = L.rectPx({ x: 0.95, y: 0.95, w: 0.3, h: 0.3 }, 1920, 1080);
assert.ok(edge.x + edge.w <= 1920 && edge.y + edge.h <= 1080, 'рамка у края не вылезает за кадр');
assert.ok([edge.x, edge.y, edge.w, edge.h].every((n) => n % 2 === 0), 'всё чётное (yuv420p)');
// зум к центру
assert.deepStrictEqual(L.zoomRect({ x: 0, y: 0, w: 1, h: 1 }, 2), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
assert.deepStrictEqual(L.zoomRect({ x: 0, y: 0, w: 1, h: 1 }, 0.5), { x: 0, y: 0, w: 1, h: 1 }, 'зум < 1 не уменьшает');
// 9:16 из 16:9
const fit = L.fitAspect({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080, 9 / 16);
assert.ok(Math.abs(fit.w * 1920 / (fit.h * 1080) - 9 / 16) < 1e-9);
assert.ok(Math.abs(fit.x - (1 - fit.w) / 2) < 1e-9, 'по центру');

const cam = { x: 0.7, y: 0.05, w: 0.28, h: 0.35 };
const cam2 = { x: 0.02, y: 0.6, w: 0.25, h: 0.35 };
const W = (o) => L.buildFilter({ srcW: 1920, srcH: 1080, ...o });
// stream: вебка сверху 40%, видео целиком по ширине сразу под ней (без обрезки краёв), снизу размытый фон
const st = W({ layout: 'stream', cam, split: 0.4 });
assert.strictEqual(st.layout, 'stream');
assert.match(st.filter, /\[p0\]crop=538:378:1344:54,scale=1080:768:force_original_aspect_ratio=increase/);
assert.match(st.filter, /\[p1\]crop=1920:1080:0:0,scale=1080:608:flags=lanczos,setsar=1\[q1\];\[b1\]\[q1\]overlay=0:768\[stk\]/, 'видео 1080x608 под вебкой');
assert.match(st.filter, /boxblur=24:2/);
assert.strictEqual(st.anchors.titleY, 768);
assert.ok(st.anchors.subsY > 768 + 608 && st.anchors.subsY < 1920 - 150, 'субтитры под видео, на фоне');
assert.strictEqual(st.aLabel, '0:a?');
// fill: как раньше, видео заполняет низ с обрезкой краёв
assert.match(W({ layout: 'stream', cam, fit: 'fill' }).filter, /\[p1\]crop=1920:1080:0:0,scale=1080:1152:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1152/);
// старый формат рамки {cam} и новый {cams} дают одно и то же
assert.strictEqual(W({ layout: 'stream', cam }).filter, W({ layout: 'stream', cams: [cam] }).filter);
// несколько вебок: в «реакции сверху» — рядом, по 540 в ширину
const two = W({ layout: 'stream', cams: [cam, cam2] });
assert.strictEqual(two.cams, 2);
assert.match(two.filter, /scale=540:768:force_original_aspect_ratio=increase[^;]*\[q0\];\[b0\]\[q0\]overlay=0:0/);
assert.match(two.filter, /scale=540:768[^;]*\[q1\];\[b1\]\[q1\]overlay=540:0/);
// сетка вебок
assert.deepStrictEqual(L.camGrid(2, { x: 0, y: 0, w: 1080, h: 768 }), [{ x: 0, y: 0, w: 540, h: 768 }, { x: 540, y: 0, w: 540, h: 768 }]);
assert.deepStrictEqual(L.camGrid(2, { x: 0, y: 0, w: 1080, h: 1920 }).map((c) => c.h), [960, 960], 'высокое место — друг под другом');
const g3 = L.camGrid(3, { x: 0, y: 0, w: 1080, h: 1920 });
assert.strictEqual(g3.length, 3);
for (const c of g3) assert.ok(c.x + c.w <= 1080 && c.y + c.h <= 1920 && [c.x, c.y, c.w, c.h].every((n) => n % 2 === 0), 'клетки внутри и чётные');
assert.deepStrictEqual(L.camsOf({ cams: [cam, cam2, cam, cam2, cam] }).length, 4, 'не больше 4 вебок');
assert.deepStrictEqual(L.camsOf({ cam: null }), []);
assert.deepStrictEqual(L.camsOf(null), []);
// вписать целиком
assert.deepStrictEqual(L.fitInto({ w: 1920, h: 1080 }, { x: 0, y: 768, w: 1080, h: 1152 }, 'top'), { x: 0, y: 768, w: 1080, h: 608 });
assert.deepStrictEqual(L.fitInto({ w: 1920, h: 1080 }, { x: 0, y: 0, w: 1080, h: 1152 }, 'bottom'), { x: 0, y: 544, w: 1080, h: 608 });
// без вебки — откат на размытый фон, «две вебки» с одной — как «реакция сверху»
for (const k of L.CAM_LAYOUTS) assert.strictEqual(W({ layout: k }).layout, 'full', `${k} без вебки — full`);
assert.strictEqual(W({ layout: 'filler' }).layout, 'full', 'без мини-игры — full');
assert.strictEqual(W({ layout: 'duo', cam }).layout, 'stream');
// below: видео сверху, вебка снизу
const bl = W({ layout: 'below', cam, split: 0.4 });
assert.match(bl.filter, /scale=1080:768:force_original_aspect_ratio=increase[^;]*\[q0\];\[b0\]\[q0\]overlay=0:1152/);
assert.match(bl.filter, /scale=1080:608:flags=lanczos,setsar=1\[q1\];\[b1\]\[q1\]overlay=0:544\[stk\]/);
// duo: вебка 1 сверху, видео, вебка 2 снизу
const du = W({ layout: 'duo', cams: [cam, cam2] });
assert.strictEqual(du.layout, 'duo');
assert.match(du.filter, /scale=1080:656:force_original_aspect_ratio=increase[^;]*\[q0\];\[b0\]\[q0\]overlay=0:0/);
assert.match(du.filter, /\[q1\];\[b1\]\[q1\]overlay=0:656/);
assert.match(du.filter, /\[q2\];\[b2\]\[q2\]overlay=0:1264\[stk\]/);
// pip: видео по центру целиком, вебки вписаны над ним
const pp = W({ layout: 'pip', cams: [cam, cam2] });
assert.match(pp.filter, /scale=1080:608:flags=lanczos,setsar=1\[q0\];\[b0\]\[q0\]overlay=0:656/);
for (const p of pp.pieces.slice(1)) assert.ok(p.box.y >= 150 && p.box.y + p.box.h <= 656, 'вебки над видео');
// camonly: две вебки друг под другом на весь экран
assert.match(W({ layout: 'camonly', cams: [cam, cam2] }).filter, /scale=1080:960:force_original_aspect_ratio=increase[^;]*\[q1\];\[b1\]\[q1\]overlay=0:960\[stk\]/);
// filler: второй вход [1:v], короткий по стриму
const fl = W({ layout: 'filler', filler: true });
assert.match(fl.filter, /\[1:v\]scale=1080:960/);
assert.match(fl.filter, /vstack=inputs=2:shortest=1/);
// camfull: окно 960 шириной, видео целиком
assert.match(W({ layout: 'camfull', cam }).filter, /scale=960:540:flags=lanczos/);
// crop: 9:16
assert.match(W({ layout: 'crop' }).filter, /crop=608:1080:656:0/);
// вариант: зеркало (только у видео), цвет, скорость
const v = W({ layout: 'stream', cam, variant: { mirror: true, sat: 1.1, bright: 0.02, speed: 1.05 } });
assert.match(v.filter, /setsar=1,hflip\[q1\]/);
assert.doesNotMatch(v.filter, /hflip\[q0\]/, 'вебку не зеркалим');
assert.match(v.filter, /eq=saturation=1.1:brightness=0.02/);
assert.match(v.filter, /setpts=PTS\/1.05/);
assert.match(v.filter, /\[0:a\]atempo=1.05\[aout\]/);
assert.strictEqual(v.aLabel, '[aout]');
// все куски внутри кадра и чётные во всех раскладках
for (const k of Object.keys(L.LAYOUTS)) for (const fit of ['fit', 'fill']) for (const cams of [[cam], [cam, cam2], [cam, cam2, cam]]) {
  const r = W({ layout: k, cams, fit, filler: true });
  for (const p of r.pieces || []) {
    const b = p.box;
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 1080 && b.y + b.h <= 1920, `${k}/${fit}/${cams.length}: кусок внутри кадра`);
    assert.ok([b.x, b.y, b.w, b.h].every((n) => n % 2 === 0), `${k}/${fit}: чётные`);
  }
  assert.ok(r.anchors.subsY > 0 && r.anchors.subsY < 1920 && r.anchors.titleY > 0 && r.anchors.titleY < 1920, `${k}: якоря в кадре`);
}
// без звука — нет дорожки
assert.strictEqual(L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080, hasAudio: false, variant: { speed: 1.05 } }).aLabel, null);
// субтитры
const withAss = L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080, ass: "'a.ass'", fontsDir: "'f'" });
assert.match(withAss.filter, /,ass='a.ass':fontsdir='f',format=yuv420p\[vout\]$/);
// путь Windows для фильтра
assert.strictEqual(L.filterPath('C:\\Users\\Alex\\subs.ass'), "'C\\:/Users/Alex/subs.ass'");
// блюр областей
const nb = L.normBlurs([{ x: 0.9, y: 0.5, w: 0.3, h: 0.2, start: 10, end: 5 }, { x: 0, y: 0, w: 1, h: 1, start: '', end: null }]);
assert.deepStrictEqual([nb[0].x, nb[0].start, nb[0].end], [0.7, 5, 10], 'рамка в кадре, время по порядку');
assert.ok(nb[1].start === null && nb[1].end === null, 'пусто — на всё видео');
assert.strictEqual(L.normBlurs(Array.from({ length: 20 }, () => ({}))).length, L.MAX_BLURS);
const bf = L.blursFor([{ x: 0, y: 0, w: 0.5, h: 0.5, start: 100, end: 110 }, { x: 0, y: 0, w: 0.1, h: 0.1, start: 200, end: 210 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }], 95, 125);
assert.deepStrictEqual(bf.map((b) => [b.from, b.to]), [[5, 15], [null, null]], 'время от начала ролика; чужой отрезок не попал; весь ролик — null');
const blurF = L.buildFilter({ layout: 'full', srcW: 1920, srcH: 1080, blurs: bf });
assert.match(blurF.filter, /^\[0:v\]split=2\[bm0\]\[bs0\];\[bs0\]crop=960:540:0:0,gblur=sigma=30:steps=2\[bk0\];\[bm0\]\[bk0\]overlay=0:0:enable='between\(t,5,15\)'\[vb0\]/);
assert.match(blurF.filter, /overlay=960:540\[vb\];\[vb\]crop=/, 'раскладка берёт уже размытый кадр');
assert.strictEqual((blurF.filter.match(/\[0:v\]/g) || []).length, 1, '[0:v] берётся один раз');
for (const lay of Object.keys(L.LAYOUTS)) {
  const f = L.buildFilter({ layout: lay, srcW: 1920, srcH: 1080, cams: [{ x: 0.7, y: 0, w: 0.3, h: 0.3 }], filler: true, blurs: bf }).filter;
  assert.ok(f.includes('[vb]') && (f.match(/\[0:v\]/g) || []).length === 1, `блюр в раскладке ${lay}`);
}
assert.doesNotMatch(L.buildFilter({ layout: 'full', srcW: 1920, srcH: 1080, blurs: [] }).filter, /gblur/);
console.log('раскладки: 76 проверок');
