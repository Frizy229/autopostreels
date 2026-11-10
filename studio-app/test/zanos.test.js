'use strict';
// Заносы: разбор текста с экрана, слова, форма громкости, оценка, границы, дубли.
const assert = require('assert');
const Z = require('../lib/zanos');

// ---- числа и экран
assert.strictEqual(Z.parseNumber('1 250 000'), 1250000);
assert.strictEqual(Z.parseNumber('5>000'), 5000, 'мусорный символ вместо разделителя');
assert.strictEqual(Z.parseNumber('1,250'), 1250);
assert.strictEqual(Z.parseNumber('2.5'), 2.5, 'десятичная дробь');
assert.deepStrictEqual(Z.parseScreen('MEGA WIN\nx5>000\n1 250 000 RUB').mults, [5000]);
assert.deepStrictEqual(Z.parseScreen('x1250').mults, [1250]);
assert.deepStrictEqual(Z.parseScreen('х 840').mults, [840], 'кириллическая х');
assert.deepStrictEqual(Z.parseScreen('1250x').mults, [1250], 'число перед иксом');
assert.deepStrictEqual(Z.parseScreen('MAX WIN').mults, [], 'буква x в слове MAX — не множитель');
assert.deepStrictEqual(Z.parseScreen('x2.5 bet 100').mults, [2.5].filter((v) => v >= 2), 'x2.5 — маленький множитель');
const sc1 = Z.parseScreen('MEGA WIN\nx5>000\n1 250 000 RUB FREE SPINS');
assert.strictEqual(sc1.banner, 'top'); assert.strictEqual(sc1.bannerWord, 'MEGA'); assert.ok(sc1.bonus);
assert.deepStrictEqual(sc1.amounts, [1250000], 'сумма отделена от множителя');
assert.strictEqual(Z.parseScreen('BIG WIN').banner, 'big');
assert.strictEqual(Z.parseScreen('balance 1 200').amounts.length, 0, 'маленькое число без валюты — не сумма');
assert.deepStrictEqual(Z.parseScreen('WIN 45 000 $').amounts, [45000]);

// ---- сводка по кадрам
const fr = (arr) => arr.map((text, i) => ({ t: 100 + i * 1.5, text }));
const noise = Z.screenSummary(fr(['spin', 'x9000', 'spin', 'bet', 'spin']));
assert.strictEqual(noise.mult, 0, 'одиночный множитель без плашки — ошибка распознавания');
const real = Z.screenSummary(fr(['spin', 'MEGA WIN', 'MEGA WIN x1250', 'x1250', 'x1250 WIN', 'total']));
assert.strictEqual(real.mult, 1250); assert.strictEqual(real.banner, 'top');
assert.ok(real.firstBigT != null && real.lastBigT > real.firstBigT);
const count = Z.screenSummary(fr(['WIN 12 000 RUB', 'WIN 85 000 RUB', 'WIN 8 000 RUB', 'WIN 240 000 RUB', 'WIN 1 200 000 RUB']));
assert.ok(count.rising && count.from === 12000 && count.to === 1200000, `счётчик: ${JSON.stringify(count)}`);
assert.ok(!Z.screenSummary(fr(['WIN 12 000 RUB', 'WIN 10 000 RUB', 'WIN 9 000 RUB'])).rising, 'сумма падает — не счётчик');
assert.ok(!Z.screenSummary(fr(['WIN 12 000 RUB', 'WIN 13 000 RUB', 'WIN 14 000 RUB'])).rising, 'рост меньше чем втрое');

// ---- слова
const W = (txt, t0 = 0, step = 0.4) => txt.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + 0.3 }));
const sp1 = Z.speechSignals(W('ребята это занос макс вин тысяча иксов ничего себе'), 0, 30);
assert.ok(sp1.strong.includes('занос') && sp1.strong.includes('макс вин') && sp1.strong.includes('тысячи иксов'), JSON.stringify(sp1));
assert.ok(sp1.medium.includes('реакция'));
assert.strictEqual(sp1.mult, 1000);
assert.strictEqual(Z.speechSignals(W('у меня х2500 сейчас'), 0, 10).mult, 2500);
assert.strictEqual(Z.speechSignals(W('1500 иксов'), 0, 10).mult, 1500);
const quiet = Z.speechSignals(W('ну давай ещё раз крутим'), 0, 10);
assert.deepStrictEqual(quiet.strong, []);

// ---- форма громкости: тихо с вращением → резкий крик 5 с → спад
const winSec = 0.5;
const env = [];
for (let i = 0; i < 60; i++) env.push(-30 + (i % 3));            // 30 с обычного звука
for (let i = 0; i < 12; i++) env.push(-12 + (i % 2));            // 6 с крика
for (let i = 0; i < 40; i++) env.push(-30);                      // дальше тихо
const ld = Z.loudShape(env, winSec, 10, 55);
assert.ok(ld.rise >= 14 && ld.sustain >= 5 && ld.sustain <= 8, JSON.stringify(ld));
assert.ok(ld.peakT >= 30 && ld.peakT <= 36 && ld.endT >= 35 && ld.endT <= 37, JSON.stringify(ld));
assert.ok(ld.buildUp, 'был подъём');
// соседний, более громкий крик не перетягивает пик
const two = Z.loudShape([...env, ...env.map((v) => v + 3)], winSec, 0, 120, [28, 38]);
assert.ok(two.peakT >= 30 && two.peakT <= 36, `фокус на своём пике: ${JSON.stringify(two)}`);
const flat = Z.loudShape(Array.from({ length: 100 }, () => -15), winSec, 0, 50);
assert.ok(flat.rise < 1 && flat.sustain === 0 || flat.sustain >= 0, 'ровный звук — подъёма нет');
assert.ok(flat.rise < 1);
assert.strictEqual(Z.chatBurst(Array.from({ length: 200 }, (_, i) => i * 3), 300, 600), 1, 'ровный чат — ×1');
const burst = [...Array.from({ length: 100 }, (_, i) => i * 6), ...Array.from({ length: 80 }, (_, i) => 300 + i * 0.1)];
assert.ok(Z.chatBurst(burst, 298, 600) >= 3, 'всплеск чата');

// ---- оценка
const loud = { rise: 15, sustain: 5, buildUp: true };
const full = Z.zanosScore({ screen: real, speech: sp1, loud, chat: 3.4, llm: 9 });
assert.ok(full.qualifies && full.score > 8, JSON.stringify(full));
assert.ok(full.why.some((w) => /x1 250/.test(w)) && full.why.some((w) => /MEGA WIN/.test(w)) && full.why.some((w) => /чат ×3/.test(w)) && full.why.some((w) => /нейросеть: занос 9/.test(w)), full.why.join(' | '));
// просто громко и смешно — не занос
const funny = Z.zanosScore({ screen: Z.screenSummary(fr(['spin', 'spin', 'bet', 'spin'])), speech: Z.speechSignals(W('ха-ха-ха смешно жесть'), 0, 10), loud, chat: 1, llm: 3 });
assert.ok(!funny.qualifies, JSON.stringify(funny));
assert.match(funny.reject, /пустое вращение/);
// без экрана и OCR: слова + крик достаточно
const noOcr = Z.zanosScore({ screen: null, speech: sp1, loud, chat: 1, llm: null });
assert.ok(noOcr.qualifies, JSON.stringify(noOcr));
// слова без крика — не занос (шутка про «занос» тихо)
const talk = Z.zanosScore({ screen: null, speech: Z.speechSignals(W('вчера был занос а сегодня нет'), 0, 10), loud: { rise: 2, sustain: 0, buildUp: false }, chat: 1, llm: null });
assert.ok(!talk.qualifies, 'разговор про занос без крика');
// большие иксы на экране — занос даже без слов
assert.ok(Z.zanosScore({ screen: real, speech: null, loud: { rise: 4, sustain: 0 }, chat: 1, llm: null }).qualifies);
// крик без иксов, но нейросеть против
assert.ok(!Z.zanosScore({ screen: null, speech: Z.speechSignals([], 0, 1), loud, chat: 1, llm: 2 }).qualifies);

// ---- границы
const talkWords = [...W('смотрим что будет', 14, 0.5), ...W('ну давай давай', 24, 0.5), ...W('а-а-а занос макс вин', 31, 0.5), ...W('иксов тысяча вообще', 36, 0.5)];
const b = Z.bounds(talkWords, { peakT: 33, endT: 36, lastBigT: 38, total: 400, minLen: 20, maxLen: 60 });
assert.ok(b.start <= 33 - 8 && b.start >= 33 - 15, `подводка: ${JSON.stringify(b)}`);
assert.ok(b.end >= 38 + 4, `концовка с итогом: ${JSON.stringify(b)}`);
assert.ok(b.end - b.start >= 20 && b.end - b.start <= 64, `длина: ${JSON.stringify(b)}`);
// начало не посреди слова: попадает в паузу между фразами (слова 14–15.5 и 24–25.5: пауза перед 24 с)
const mid = Z.bounds(talkWords, { peakT: 31, endT: 34, total: 400, minLen: 10, maxLen: 60, lead: 7 });
const inside = (t) => talkWords.some((w) => w.s + 0.05 < t && w.e - 0.05 > t);
assert.ok(!inside(mid.start) && !inside(mid.end), `границы по паузам: ${JSON.stringify(mid)}`);
// длинный крик ужимается до maxLen
const long = Z.bounds([], { peakT: 100, endT: 190, total: 400, minLen: 20, maxLen: 50 });
assert.ok(long.end - long.start <= 50.5 && long.start <= 92 && long.start >= 50, JSON.stringify(long));
// у начала записи и у конца
assert.strictEqual(Z.bounds([], { peakT: 3, endT: 6, total: 400, minLen: 20, maxLen: 60 }).start, 0);
assert.ok(Z.bounds([], { peakT: 395, endT: 398, total: 400, minLen: 20, maxLen: 60 }).end <= 400);

// ---- дубли
const d = Z.dedupe([{ peak: 100, start: 85, end: 130, score: 7 }, { peak: 112, start: 95, end: 140, score: 5 }, { peak: 400, start: 385, end: 430, score: 6 }]);
assert.deepStrictEqual(d.keep.map((x) => x.peak), [100, 400]);
assert.strictEqual(d.dups.length, 1); assert.strictEqual(d.dups[0].of.peak, 100);

console.log('заносы: все проверки прошли');
