'use strict';
const assert = require('assert');
const M = require('../lib/moments');

// громкость из PCM: тишина и полная громкость, куски не по границе отсчёта
const env = new M.Envelope(100, 0.5);
const loud = Buffer.alloc(100 * 2); for (let i = 0; i < 100; i++) loud.writeInt16LE(i % 2 ? 32767 : -32767, i * 2);
env.push(Buffer.alloc(100)); env.push(loud.subarray(0, 51)); env.push(loud.subarray(51));
const vals = env.finish();
assert.strictEqual(vals.length, 3);
assert.strictEqual(vals[0], -100, 'тишина');
assert.ok(vals[2] > -0.1 && vals[2] <= 0, 'полная громкость около 0 dB');

assert.strictEqual(M.median([5, 1, 3]), 3);
assert.strictEqual(M.median([4, 1, 3, 2]), 2.5);
assert.deepStrictEqual(M.smooth([0, 0, 9, 0, 0], 1), [0, 3, 3, 3, 0]);
assert.deepStrictEqual(M.chatDensity([0.1, 0.2, 1.4, 99], 0.5, 4), [2, 0, 1, 0]);

// чат YouTube (по строке) и Twitch (массив)
const yt = [JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: '15000' } }), 'мусор', JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: '2000' } })].join('\n');
assert.deepStrictEqual(M.parseChat(yt), [2, 15]);
assert.deepStrictEqual(M.parseChat(JSON.stringify({ comments: [{ content_offset_seconds: 7 }, { content_offset_seconds: 3.5 }] })), [3.5, 7]);
assert.deepStrictEqual(M.parseChat(''), []);

// поиск: 10 минут тихо (-30 dB) и три всплеска (-8 dB) разной длины
const win = 0.5, n = 1200;
const e = new Array(n).fill(-30).map((v, i) => v + Math.sin(i) * 0.5);
const burst = (t, len, lvl) => { for (let i = t / win; i < (t + len) / win; i++) e[i] = lvl; };
burst(100, 4, -8); burst(300, 10, -5); burst(500, 3, -12);
const found = M.findMoments(e, { winSec: win, minLen: 20, maxLen: 45, count: 5 });
assert.strictEqual(found.length, 3, 'три момента');
assert.ok(found[0].peak >= 300 && found[0].peak < 310, 'самый громкий первый');
for (const f of found) {
  assert.ok(f.end - f.start >= 20 - 1e-9 && f.end - f.start <= 45 + 1e-9, 'длина в пределах');
  assert.ok(f.start < f.peak && f.end > f.peak, 'пик внутри с подводкой');
}
const sorted = [...found].sort((a, b) => a.start - b.start);
for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, 'не пересекаются');
assert.deepStrictEqual(M.findMoments([], {}), []);
assert.strictEqual(M.findMoments(e, { winSec: win, minLen: 20, maxLen: 45, count: 1 }).length, 1, 'лимит количества');
// чат поднимает тихий момент
const quiet = new Array(n).fill(-30).map((v, i) => v + Math.sin(i * 1.7) * 0.5);
const chat = []; for (let k = 0; k < 80; k++) chat.push(400 + k * 0.1);
const withChat = M.findMoments(quiet, { winSec: win, minLen: 20, maxLen: 40, count: 1, chat, chatWeight: 1.5 });
assert.ok(withChat.length === 1 && withChat[0].peak > 385 && withChat[0].peak < 405, 'момент на чате (со сдвигом назад)');

assert.strictEqual(M.parseTime('1:02:03'), 3723);
assert.strictEqual(M.parseTime('62:03'), 3723);
assert.ok(Number.isNaN(M.parseTime('a:b')));
assert.strictEqual(M.fmtTime(3723), '1:02:03');
assert.strictEqual(M.fmtTime(65), '1:05');
console.log('моменты: 25 проверок');
