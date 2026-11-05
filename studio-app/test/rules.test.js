'use strict';
const assert = require('assert');
const R = require('../lib/rules');

assert.strictEqual(R.ensureTags('Смешно #fyp'), 'Смешно #fyp\n\ntwitch: evelone2004 #evelone');
assert.strictEqual(R.ensureTags('Смешно', undefined, { short: true }), 'Смешно twitch: evelone2004 #evelone');
assert.strictEqual(R.ensureTags('a twitch.tv/evelone2004 #Evelone'), 'a twitch.tv/evelone2004 #Evelone', 'уже есть (и ссылка, и регистр)');
assert.strictEqual(R.ensureTags(''), 'twitch: evelone2004 #evelone');
assert.strictEqual(R.ensureTags('#evelone2004 twitch: evelone2004'), '#evelone2004 twitch: evelone2004\n\n#evelone', '#evelone2004 не равен #evelone');
assert.deepStrictEqual(R.checkTags('twitch: evelone2004 #evelone, #fyp'), []);
assert.deepStrictEqual(R.checkTags('ничего'), ['нет «twitch: evelone2004»', 'нет #evelone']);
assert.ok(R.hasHashtag('(#evelone)', '#evelone'));
assert.ok(!R.hasHashtag('#evelonefan', '#evelone'));

const words = [{ w: 'а', s: 10, e: 12 }, { w: 'б', s: 12, e: 15 }, { w: 'в', s: 29, e: 31 }];
assert.deepStrictEqual(R.speechStats(words, 10, 30), { ratio: 0.3, words: 3, wpm: 9 });

const m = { start: 10, end: 30 };
assert.strictEqual(R.checkMoment(m, { words, layout: 'full', rules: { minWords: 3 } }).ok, true);
const silent = R.checkMoment(m, { words: words.slice(0, 1), layout: 'full' });
assert.strictEqual(silent.ok, false);
assert.match(silent.issues[0], /мало речи \(10%, 1 слов\)/);
assert.match(R.checkMoment(m, { words: null, layout: 'full' }).warn[0], /не проверена/);
assert.strictEqual(R.checkMoment(m, { words: null, layout: 'full' }).ok, true, 'без модели только предупреждение');
assert.deepStrictEqual(R.checkMoment(m, { words: null, layout: 'stream', hasCam: false }).issues, ['не задана рамка вебки']);
assert.deepStrictEqual(R.checkMoment(m, { words: null, layout: 'stream', hasCam: false, rules: { requireCam: false } }).issues, []);
assert.deepStrictEqual(R.checkMoment(m, { words: null, layout: 'full', rules: { requireOk: true } }).issues, ['не отмечен как «проверено»']);
assert.strictEqual(R.checkMoment({ ...m, ok: true }, { words: null, layout: 'full', rules: { requireOk: true } }).ok, true);
console.log('правила конкурса: 19 проверок');
