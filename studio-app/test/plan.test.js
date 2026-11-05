'use strict';
const assert = require('assert');
const P = require('../lib/plan');

const ms = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, score: 100 - i }));
const opts = { vary: true, formats: ['stream', 'filler', 'full'], subStyles: ['stream', 'neon'] };

// хватает моментов: у каждого канала свои, змейкой по силе
const p = P.planChannels(ms(9), 3, 3, opts);
assert.deepStrictEqual(p.map((c) => c.items.map((x) => x.moment.id)), [['m0', 'm5', 'm6'], ['m1', 'm4', 'm7'], ['m2', 'm3', 'm8']]);
assert.ok(p.every((c) => c.items.every((x) => x.reuse === 0)));
// у каждого канала своя раскладка
assert.deepStrictEqual(p.map((c) => c.items[0].variant.layout), ['stream', 'filler', 'full']);
assert.deepStrictEqual(p.map((c) => c.items[0].variant.subStyle), ['stream', 'neon', 'stream']);

// один момент на 4 канала: повторяется, но в разных форматах и ни разу дважды в одном канале
const one = P.planChannels(ms(1), 4, 1, opts);
assert.ok(one.every((c) => c.items.length === 1 && c.items[0].moment.id === 'm0'));
const looks = one.map((c) => JSON.stringify(c.items[0].variant));
assert.strictEqual(new Set(looks).size, 4, 'все четыре варианта разные');
assert.deepStrictEqual(one.map((c) => c.items[0].reuse), [0, 1, 2, 3]);

// мало моментов: 2 момента, 2 канала по 2 ролика
const two = P.planChannels(ms(2), 2, 2, opts);
for (const c of two) assert.strictEqual(new Set(c.items.map((x) => x.moment.id)).size, c.items.length, 'без повторов внутри канала');
assert.deepStrictEqual(two.map((c) => c.items.length), [2, 2]);
// запрет повторов
assert.deepStrictEqual(P.planChannels(ms(2), 2, 2, { reuse: false }).map((c) => c.items.length), [1, 1]);

// первый ролик без изменений; дальше мелкие отличия
assert.deepStrictEqual(P.variantFor(0, 0, opts), { layout: 'stream', subStyle: 'stream', mirror: false, zoom: 1, sat: 1, bright: 0, speed: 1 });
assert.strictEqual(P.variantFor(1, 0, { vary: false, formats: ['crop'] }).zoom, 1, 'без vary — только раскладка');
assert.strictEqual(P.variantFor(3, 0, { vary: true }).layout, null, 'без списка форматов — общая раскладка');
assert.strictEqual(P.variantFor(1, 0, { vary: true, allowMirror: true }).mirror, true);
assert.strictEqual(P.variantFor(1, 0, { vary: true }).mirror, false, 'зеркало только если разрешено');
assert.strictEqual(P.variantFor(3, 0, { vary: true, allowSpeed: false }).speed, 1);

assert.deepStrictEqual(P.shortage(5, 3, 7), { need: 21, have: 5, missing: 16 });
console.log('раздача по каналам: 16 проверок');
// один момент у двух каналов при двух раскладках — разные раскладки (раньше совпадали)
const p2 = P.planChannels(ms(2), 2, 2, { formats: ['stream', 'filler'], subStyles: ['neon', 'box'] });
const byMoment = {};
for (const c of p2) for (const it of c.items) (byMoment[it.moment.id] = byMoment[it.moment.id] || []).push(it.variant.layout + '/' + it.variant.subStyle);
for (const v of Object.values(byMoment)) assert.strictEqual(new Set(v.map((x) => x.split('/')[0])).size, v.length, 'раскладки момента разные');
for (const v of Object.values(byMoment)) assert.strictEqual(new Set(v.map((x) => x.split('/')[1])).size, v.length, 'стили момента разные');
