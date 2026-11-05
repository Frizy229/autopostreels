'use strict';
const assert = require('assert');
const T = require('../lib/transcribe');

assert.ok(T.modelUrl('small').endsWith('/ggml-small.bin'));
assert.ok(T.modelUrl('нет').endsWith('/ggml-small.bin'));
const a = T.whisperArgs({ model: 'm.bin', wav: 'a.wav', outBase: 'o', lang: 'ru', threads: 6, gpu: false });
assert.deepStrictEqual(a, ['-m', 'm.bin', '-f', 'a.wav', '-l', 'ru', '-ml', '1', '-sow', '-oj', '-of', 'o', '-t', '6', '-pp', '-ng']);
assert.ok(!T.whisperArgs({ model: 'm', wav: 'w', outBase: 'o' }).includes('-ng'), 'GPU по умолчанию');
assert.deepStrictEqual(T.wavArgs('in.mp4', 'o.wav', 5, 9), ['-hide_banner', '-y', '-ss', '5', '-to', '9', '-i', 'in.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'o.wav']);

const json = { transcription: [
  { offsets: { from: 0, to: 400 }, text: ' Тот' },
  { offsets: { from: 400, to: 800 }, text: ' сам' },
  { offsets: { from: 800, to: 1000 }, text: 'ый' },
  { offsets: { from: 1000, to: 1100 }, text: ',' },
  { offsets: { from: 1200, to: 1500 }, text: ' [музыка]' },
  { offsets: { from: 1500, to: 1900 }, text: ' кент!' },
  { offsets: { from: 2000, to: 2100 }, text: '  ' },
] };
assert.deepStrictEqual(T.parseWhisperJson(json, 100), [
  { w: 'Тот', s: 100, e: 100.4 }, { w: 'самый,', s: 100.4, e: 101.1 }, { w: 'кент!', s: 101.5, e: 101.9 },
]);
assert.deepStrictEqual(T.parseWhisperJson('{}'), []);
const words = [{ w: 'а', s: 0 }, { w: 'б', s: 5 }, { w: 'в', s: 16 }];
assert.strictEqual(T.wordsToText(words), '[0] а б \n[16] в');
console.log('распознавание речи: 9 проверок');
