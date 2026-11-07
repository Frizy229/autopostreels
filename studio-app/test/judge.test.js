'use strict';
// Оценка моментов: отсев мусора и признаки «смешного». Чистые функции + настоящий ffmpeg для blackdetect/freezedetect.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const J = require('../lib/judge');
const { whisperTags } = require('../lib/transcribe');
const { normalize } = require('../lib/settings');

const W = (txt, t0, step = 0.4) => txt.split(' ').map((w, i) => ({ w, s: t0 + i * step, e: t0 + i * step + 0.3 }));
const talk = W('ну смотри что тут происходит вообще я не понимаю как это работает давай ещё раз попробуем', 0);
const speechEnv = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? -40 : -18 + (i % 3) * 5));   // громкость прыгает, есть паузы
const flatEnv = Array.from({ length: 40 }, () => -12);                                                 // ровный гул

// ---- смех в словах
assert.ok(J.LAUGH_WORD.test('ха-ха-ха') && J.LAUGH_WORD.test('ахахах') && J.LAUGH_WORD.test('ору') && J.LAUGH_WORD.test('лол'));
assert.ok(!J.LAUGH_WORD.test('хорошо') && !J.LAUGH_WORD.test('ходить') && !J.LAUGH_WORD.test('привет'));
assert.strictEqual(J.laughStats(W('ха-ха-ха-ха ору', 0), 0, 10).laughs, 5, 'ха-ха-ха-ха считается за несколько');
assert.strictEqual(J.laughStats(talk, 0, 10).laughs, 0);

// ---- галлюцинации whisper на музыке
assert.ok(J.hallucinated(W('Субтитры сделал DimaTorzok', 0)));
assert.ok(J.hallucinated(W('да да да да да да да да да да', 0)));
assert.ok(!J.hallucinated(talk));

// ---- ровность звука
assert.ok(J.flatness(flatEnv, 0.5, 0, 20).std < 0.5);
assert.ok(J.flatness(speechEnv, 0.5, 0, 20).std > 4);

// ---- разбор ffmpeg
const pv = J.parseVisual('[blackdetect @ 0x1] black_start:0 black_end:6 black_duration:6\nlavfi.freezedetect.freeze_duration: 3', 10);
assert.deepStrictEqual(pv, { black: 0.6, frozen: 0.3 });
assert.deepStrictEqual(J.parseVisual('', 10), { black: 0, frozen: 0 });
assert.ok(J.visualArgs('a.mp4', { start: 5, dur: 20 }).join(' ').includes('-ss 5 -t 20 -i a.mp4'));

// ---- итог по моменту
const m = { start: 0, end: 20 };
const ctx = { env: speechEnv, winSec: 0.5 };
assert.strictEqual(J.judgeMoment(m, { ...ctx, words: talk, visual: { black: 0.9, frozen: 0 } }).junk.startsWith('чёрный экран'), true);
assert.match(J.judgeMoment(m, { ...ctx, words: talk, visual: { black: 0, frozen: 0.8 } }).junk, /замерла/);
assert.match(J.judgeMoment(m, { ...ctx, words: [], visual: { black: 0, frozen: 0 } }).junk, /нет речи/);
assert.match(J.judgeMoment(m, { ...ctx, words: W('Субтитры сделал DimaTorzok', 1) }).junk, /музыка/);
assert.match(J.judgeMoment(m, { env: flatEnv, winSec: 0.5, words: talk }).junk, /ровный звук/);
assert.strictEqual(J.judgeMoment(m, { ...ctx, words: talk, visual: { black: 0, frozen: 0 } }).junk, '', 'нормальная речь — не мусор');
// речь не слушали: мусор не объявляем, только предупреждаем
const noSpeech = J.judgeMoment(m, { env: flatEnv, winSec: 0.5, words: null });
assert.strictEqual(noSpeech.junk, '');
assert.ok(noSpeech.warn.length === 1);
// смех поднимает оценку, музыка без слов — нет
const funny = J.judgeMoment(m, { ...ctx, words: [...talk, ...W('ха-ха-ха ахахах ору', 4)], tags: { laugh: 1 } });
assert.ok(funny.bonus > 1 && funny.why.some((x) => /смех/.test(x)), JSON.stringify(funny));
assert.ok(funny.bonus > J.judgeMoment(m, { ...ctx, words: talk }).bonus);
// смех спасает ровный звук от отсева
assert.strictEqual(J.judgeMoment(m, { env: flatEnv, winSec: 0.5, words: [...talk, ...W('ахахах ха-ха', 4)] }).junk, '');

// ---- выдержка
assert.strictEqual(J.excerpt(W('раз два три', 0), 0, 5), 'раз два три');
assert.ok(J.excerpt(talk, 0, 20, 30).length <= 30);

// ---- подписи whisper
const tags = whisperTags({ transcription: [{ text: ' [музыка]' }, { text: ' (смех)' }, { text: ' [Аплодисменты]' }, { text: ' привет' }, { text: ' ♪' }] });
assert.deepStrictEqual(tags, { music: 2, laugh: 1, applause: 1 });

// ---- настройка
assert.strictEqual(normalize({}).smartPick, true);
assert.strictEqual(normalize({ smartPick: false }).smartPick, false);

// ---- настоящий ffmpeg: чёрный кусок и замерший кадр находятся
if (process.platform !== 'win32' && spawnSync('ffmpeg', ['-version']).status === 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-'));
  const ff = (a) => assert.strictEqual(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]).status, 0);
  const black = path.join(tmp, 'black.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', black]);
  const live = path.join(tmp, 'live.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', live]);
  const frozen = path.join(tmp, 'frozen.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180:r=25:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', frozen]);
  const run = (f) => J.parseVisual(spawnSync('ffmpeg', ['-v', 'info', ...J.visualArgs(f)], { encoding: 'utf8' }).stderr, 12);
  const b = run(black), l = run(live), z = run(frozen);
  assert.ok(b.black > 0.9, `чёрное: ${JSON.stringify(b)}`);
  assert.ok(l.black < 0.1 && l.frozen < 0.1, `живая картинка: ${JSON.stringify(l)}`);
  assert.ok(z.frozen > 0.6, `замершая: ${JSON.stringify(z)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('оценка моментов: все проверки прошли');
