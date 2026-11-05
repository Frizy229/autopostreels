'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/tools');

(async () => {
  const assets = [{ name: 'whisper-bin-Win32.zip' }, { name: 'whisper-bin-x64.zip', browser_download_url: 'cpu' },
    { name: 'whisper-cublas-11.8.0-bin-x64.zip', browser_download_url: 'c11' }, { name: 'whisper-cublas-12.4.0-bin-x64.zip', browser_download_url: 'c12' }];
  assert.strictEqual(T.pickWhisperAsset(assets, true), 'c12', 'свежая CUDA');
  assert.strictEqual(T.pickWhisperAsset(assets, false), 'cpu');
  assert.strictEqual(T.pickWhisperAsset(assets.slice(0, 2), true), 'cpu', 'нет CUDA — процессорная');
  assert.throws(() => T.pickWhisperAsset([{ name: 'x.zip' }], true), /нет сборки/);
  assert.strictEqual(T.unpacked(path.join('a', 'app.asar', 'node_modules', 'ff')), path.join('a', 'app.asar.unpacked', 'node_modules', 'ff'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  fs.mkdirSync(path.join(dir, 'whisper', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'whisper', 'Release', T.exe('whisper-cli')), '');
  const tools = new T.Tools(dir);
  assert.strictEqual(tools.whisper, path.join(dir, 'whisper', 'Release', T.exe('whisper-cli')), 'whisper-cli во вложенной папке архива');
  assert.ok(tools.modelPath('m.bin').endsWith(path.join('models', 'm.bin')));
  assert.strictEqual(tools.status('m.bin').model, null);

  // запуск процессов: вывод, код ошибки, отмена
  const r = await tools.run(process.execPath, ['-e', 'console.log("привет")']);
  assert.strictEqual(r.stdout.toString().trim(), 'привет');
  await assert.rejects(tools.run(process.execPath, ['-e', 'console.error("плохо"); process.exit(3)']), /код 3[\s\S]*плохо/);
  assert.strictEqual((await tools.run(process.execPath, ['-e', 'process.exit(2)'], { allowFail: true })).code, 2);
  await assert.rejects(tools.run(path.join(dir, 'нет-такой'), []), /Не найдена программа/);
  const lines = [];
  await tools.run(process.execPath, ['-e', 'process.stdout.write("a\\nb\\r\\nc")'], { onLine: (l) => lines.push(l) });
  assert.deepStrictEqual(lines, ['a', 'b'], 'строки по мере вывода');
  const ac = new AbortController();
  const p = tools.run(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.code === 'ABORT');

  // скачивание: прогресс, временный .part, ошибка HTTP
  const body = Buffer.alloc(5000, 7);
  const fakeFetch = async (url) => (url === 'bad' ? { ok: false, status: 404 } : {
    ok: true, headers: { get: () => String(body.length) },
    body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(body) })) }; } },
  });
  const prog = [];
  const dest = path.join(dir, 'dl', 'f.bin');
  await T.download(fakeFetch, 'ok', dest, (p) => prog.push(p));
  assert.strictEqual(fs.statSync(dest).size, 5000);
  assert.ok(!fs.existsSync(dest + '.part'));
  assert.strictEqual(prog[prog.length - 1], 1);
  await assert.rejects(T.download(fakeFetch, 'bad', path.join(dir, 'x')), /HTTP 404/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('компоненты и процессы: 18 проверок');
})().catch((e) => { console.error(e); process.exit(1); });
// бинарник без права на выполнение (npm ci --ignore-scripts): право выдаётся, иначе берётся системный
if (process.platform !== 'win32') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-'));
  const b = path.join(d, 'ffprobe');
  fs.writeFileSync(b, '#!/bin/sh\n'); fs.chmodSync(b, 0o644);
  assert.strictEqual(T.runnable(b), b);
  fs.accessSync(b, fs.constants.X_OK);
  assert.strictEqual(T.runnable(path.join(d, 'нет')), null);
  fs.rmSync(d, { recursive: true, force: true });
}
