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
// stream: вебка сверху, 40% высоты, заголовок на стыке
const st = L.buildFilter({ layout: 'stream', srcW: 1920, srcH: 1080, cam, split: 0.4 });
assert.strictEqual(st.layout, 'stream');
assert.match(st.filter, /\[cs\]crop=538:378:1344:54,scale=1080:768/);
assert.match(st.filter, /\[ks\]crop=1920:1080:0:0,scale=1080:1152/);
assert.match(st.filter, /vstack=inputs=2\[stk\]/);
assert.strictEqual(st.anchors.titleY, 768);
assert.strictEqual(st.aLabel, '0:a?');
// без вебки — откат на размытый фон
assert.strictEqual(L.buildFilter({ layout: 'stream', srcW: 1920, srcH: 1080 }).layout, 'full');
assert.strictEqual(L.buildFilter({ layout: 'camfull', srcW: 1920, srcH: 1080 }).layout, 'full');
assert.strictEqual(L.buildFilter({ layout: 'filler', srcW: 1920, srcH: 1080 }).layout, 'full', 'без мини-игры — full');
// filler: второй вход [1:v], короткий по стриму
const fl = L.buildFilter({ layout: 'filler', srcW: 1920, srcH: 1080, filler: true });
assert.match(fl.filter, /\[1:v\]scale=1080:960/);
assert.match(fl.filter, /vstack=inputs=2:shortest=1/);
// camfull: окно 960 шириной
assert.match(L.buildFilter({ layout: 'camfull', srcW: 1920, srcH: 1080, cam }).filter, /scale=960:540/);
// crop: 9:16
assert.match(L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080 }).filter, /crop=608:1080:656:0/);
// вариант: зеркало, цвет, скорость
const v = L.buildFilter({ layout: 'stream', srcW: 1920, srcH: 1080, cam, variant: { mirror: true, sat: 1.1, bright: 0.02, speed: 1.05 } });
assert.match(v.filter, /hflip\[con\]/);
assert.match(v.filter, /eq=saturation=1.1:brightness=0.02/);
assert.match(v.filter, /setpts=PTS\/1.05/);
assert.match(v.filter, /\[0:a\]atempo=1.05\[aout\]/);
assert.strictEqual(v.aLabel, '[aout]');
// без звука — нет дорожки
assert.strictEqual(L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080, hasAudio: false, variant: { speed: 1.05 } }).aLabel, null);
// субтитры
const withAss = L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080, ass: "'a.ass'", fontsDir: "'f'" });
assert.match(withAss.filter, /,ass='a.ass':fontsdir='f',format=yuv420p\[vout\]$/);
// путь Windows для фильтра
assert.strictEqual(L.filterPath('C:\\Users\\Alex\\subs.ass'), "'C\\:/Users/Alex/subs.ass'");
console.log('раскладки: 26 проверок');
