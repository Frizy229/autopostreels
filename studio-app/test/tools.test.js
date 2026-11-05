'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/tools');
const which = (n) => String(process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, T.exe(n))));

(async () => {
  // как сейчас на GitHub: «Latest» v1.9.5 только с исходниками, сборки в пре-релизе b5454
  const A = (n) => ({ name: n, browser_download_url: `u/${n}` });
  const rels = [
    { tag_name: 'v1.9.5', assets: [] },
    { tag_name: 'b5454', assets: ['whisper-b5454-xcframework.zip', 'whisper-bin-ubuntu-x64.tar.gz', 'whisper-bin-win-cpu-arm64.zip',
      'whisper-bin-win-cuda-11.8.0-x64.zip', 'whisper-bin-win-cuda-12.4.0-x64.zip', 'whisper-bin-win-cuda-13.4-arm64.zip',
      'whisper-bin-Win32.zip', 'whisper-bin-x64.zip', 'whisper-blas-bin-Win32.zip', 'whisper-blas-bin-x64.zip'].map(A) },
  ];
  assert.deepStrictEqual(T.pickWhisperAssets(rels, true).map((x) => `${x.kind}:${x.name}`),
    ['cuda:whisper-bin-win-cuda-12.4.0-x64.zip', 'cpu:whisper-blas-bin-x64.zip', 'cpu:whisper-bin-x64.zip'], 'CUDA 12 x64, запасные — процессорные');
  assert.deepStrictEqual(T.pickWhisperAssets(rels, false).map((x) => x.name), ['whisper-blas-bin-x64.zip', 'whisper-bin-x64.zip']);
  // CUDA 13 x64 появится — всё равно 12 (работает со старыми драйверами); старые имена cublas тоже понимаем
  const r2 = [{ assets: ['whisper-bin-win-cuda-13.1-x64.zip', 'whisper-bin-win-cuda-12.8.0-x64.zip', 'whisper-bin-x64.zip'].map(A) }];
  assert.strictEqual(T.pickWhisperAssets(r2, true)[0].name, 'whisper-bin-win-cuda-12.8.0-x64.zip');
  assert.strictEqual(T.pickWhisperAssets([{ assets: ['whisper-cublas-12.4.0-bin-x64.zip', 'whisper-bin-x64.zip'].map(A) }], true)[0].kind, 'cuda');
  assert.strictEqual(T.pickWhisperAssets([{ assets: [A('whisper-bin-x64.zip')] }], true)[0].kind, 'cpu', 'нет CUDA — процессорная');
  assert.throws(() => T.pickWhisperAssets([{ assets: [] }, { assets: [A('x.zip')] }], true), /нет сборки для Windows x64/);
  assert.strictEqual(T.unpacked(path.join('a', 'app.asar', 'node_modules', 'ff')), path.join('a', 'app.asar.unpacked', 'node_modules', 'ff'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  fs.mkdirSync(path.join(dir, 'whisper', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'whisper', 'Release', T.exe('whisper-cli')), '');
  const tools = new T.Tools(dir);
  assert.strictEqual(tools.whisper, path.join(dir, 'whisper', 'Release', T.exe('whisper-cli')), 'whisper-cli во вложенной папке архива');
  // настоящий архив whisper.cpp: рядом лежит main.exe-заглушка (выходит с кодом 1) — брать нельзя, даже если она первая
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const rel = path.join(stubDir, 'whisper', 'Release');
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, T.exe('main')), "MZ...WARNING: The binary '%s' is deprecated.\n Please use '%s' instead.");
  assert.ok(T.isDeprecationStub(path.join(rel, T.exe('main'))));
  const stubTools = new T.Tools(stubDir);
  if (!which('whisper-cli')) assert.strictEqual(stubTools.whisper, null, 'одна заглушка main — whisper не найден');
  fs.writeFileSync(path.join(rel, T.exe('whisper-cli')), 'MZ');
  assert.strictEqual(stubTools.whisper, path.join(rel, T.exe('whisper-cli')), 'whisper-cli, а не main-заглушка');
  // очень старая сборка: только настоящий main
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  fs.mkdirSync(path.join(oldDir, 'whisper'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'whisper', T.exe('main')), 'MZ whisper usage: main [options] file0.wav');
  if (!which('whisper-cli')) assert.strictEqual(new T.Tools(oldDir).whisper, path.join(oldDir, 'whisper', T.exe('main')));
  // понятные ошибки запуска
  assert.match(T.exitHint(-1073741515), /DLL/, '0xC0000135 как отрицательное число');
  assert.match(T.exitHint(3221225781), /DLL/, '0xC0000135 как беззнаковое');
  assert.strictEqual(T.exitHint(1), '');
  assert.strictEqual(T.errorTail('\nload ok\n\nerror: no model\n  bye \n'), 'load ok · error: no model · bye');

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
  console.log('компоненты и процессы: 27 проверок');
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
