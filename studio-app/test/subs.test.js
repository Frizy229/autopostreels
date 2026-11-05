'use strict';
const assert = require('assert');
const S = require('../lib/subs');

assert.strictEqual(S.assColor('#FF8000'), '&H000080FF');
assert.strictEqual(S.assColor('#00ff00', 255), '&HFF00FF00');
assert.strictEqual(S.assColor('мусор'), '&H00FFFFFF');
assert.strictEqual(S.assTime(3723.456), '1:02:03.46');
assert.strictEqual(S.assTime(-1), '0:00:00.00');
assert.strictEqual(S.assText('a{b}\\c\nd'), 'ab\u29F5c\\Nd');

const W = (arr) => arr.map(([w, s, e]) => ({ w, s, e }));
// группы: по 3 слова, пауза, конец фразы
const ch = S.chunkWords(W([['раз', 0, 0.3], ['два', 0.3, 0.6], ['три', 0.6, 0.9], ['четыре', 0.9, 1.2], ['пять.', 1.2, 1.5], ['шесть', 3, 3.3]]));
assert.deepStrictEqual(ch.map((c) => c.words.map((w) => w.w).join(' ')), ['раз два три', 'четыре пять.', 'шесть']);
assert.strictEqual(ch[0].e, 0.9, 'группа держится до следующей');
assert.strictEqual(ch[1].e, 2.0, 'но не дольше +0.5 с перед паузой');
assert.deepStrictEqual(S.chunkWords(W([['оченьдлинноеслово', 0, 1], ['ещёоднодлинное', 1, 2]])).length, 2, 'по символам');
assert.deepStrictEqual(S.chunkWords(W([['', 0, 1], ['x', 2, 1]])), [], 'пустые и битые слова пропускаются');

// заголовок в две строки
assert.deepStrictEqual(S.splitTitle('Контратака | хорошая'), ['Контратака', 'хорошая']);
assert.deepStrictEqual(S.splitTitle('Обиделся как человек'), ['Обиделся', 'как человек']);
assert.deepStrictEqual(S.splitTitle('Вы'), ['Вы']);
assert.deepStrictEqual(S.splitTitle(''), []);
// размер под ширину
assert.strictEqual(S.fitSize('КОРОТКО', 120), 120);
assert.ok(S.fitSize('ОЧЕНЬ ДЛИННЫЙ ЗАГОЛОВОК ДЛЯ ОДНОЙ СТРОКИ', 120) < 60);

const ass = S.buildAss({
  words: W([['тот', 10, 10.3], ['самый', 10.3, 10.7], ['кент', 10.7, 11], ['вне', 40, 41]]),
  clipStart: 9, clipEnd: 30, style: 'neon', title: 'Тот самый | кент', titleStyle: 'glow_blue', anchors: { titleY: 768, subsY: 1400 },
});
assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
assert.match(ass, /Style: Sub,Montserrat Black,96,/);
const ev = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
const subs = ev.filter((l) => l.includes(',Sub,'));
assert.strictEqual(subs.length, 6, '3 слова × (свечение + текст); слово вне отрезка не попало');
assert.match(subs[1], /^Dialogue: 1,0:00:01.00,0:00:01.30,Sub,/, 'время от начала отрезка');
assert.match(subs[1], /\{\\1c&H3AFF7C&\}ТОТ\{\\1c&HFFFFFF&\} САМЫЙ КЕНТ/, 'первое слово подсвечено');
assert.match(subs[3], /ТОТ \{\\1c&H3AFF7C&\}САМЫЙ/, 'потом второе');
assert.match(subs[1], /\\fscx118/, 'первое появление с «прыжком»');
assert.doesNotMatch(subs[3], /\\fscx118/);
const titles = ev.filter((l) => l.includes(',Title,'));
assert.strictEqual(titles.length, 3, 'две строки + свечение второй');
assert.ok(titles.some((l) => l.includes('ТОТ САМЫЙ')) && titles.some((l) => l.includes('КЕНТ')));
assert.match(titles[0], /0:00:00.00,0:00:21.00/, 'заголовок на весь ролик');
// скорость сжимает время
const fast = S.buildAss({ words: W([['а', 2, 3]]), clipStart: 0, clipEnd: 10, speed: 2, style: 'clean', titleStyle: 'none' });
assert.match(fast, /Dialogue: 1,0:00:01.00,0:00:01.65,Sub/);
assert.doesNotMatch(fast, /Style: Title/);
// плашка: BorderStyle 3 с полупрозрачным фоном
assert.match(S.buildAss({ words: [], style: 'box', titleStyle: 'none' }), /Style: Sub,Rubik Black,74,.*,&H46000000,.*,3,14,0,5,/);
// у всех стилей есть шрифт из assets/fonts
const fonts = ['Montserrat Black', 'Unbounded Black', 'Rubik Black', 'Russo One'];
for (const [k, st] of Object.entries(S.SUB_STYLES)) assert.ok(fonts.includes(st.font), `шрифт стиля ${k}`);
console.log(`субтитры: ${Object.keys(S.SUB_STYLES).length} стилей, 30 проверок`);
