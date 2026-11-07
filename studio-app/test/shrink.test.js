'use strict';
// Страховка перед отправкой: тяжёлые ролики сжимаются под лимит GitHub (на настоящем ffmpeg).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Tools } = require('../lib/tools');
const { Pipeline } = require('../lib/pipeline');
const { normalize } = require('../lib/settings');

if (process.platform === 'win32' || spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('пропущено: нужен ffmpeg в PATH (Linux/macOS)'); process.exit(0); }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const ff = (args) => assert.strictEqual(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  const folder = path.join(tmp, '001_test');
  fs.mkdirSync(path.join(folder, 'acc'), { recursive: true });
  const big = path.join(folder, 'acc', 'short-1-moment.mp4'), small = path.join(folder, 'short-2-small.mp4');
  // «тяжёлый» ролик: шумная картинка на высоком битрейте
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4,noise=alls=60:allf=t', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-c:v', 'libx264', '-b:v', '8M', '-c:a', 'aac', big]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1', '-c:v', 'libx264', small]);
  const before = fs.statSync(big).size, smallBefore = fs.statSync(small).size;
  assert.ok(before > 2.5 * 1048576, `исходник тяжёлый: ${before}`);
  const pl = new Pipeline({ tools: new Tools(path.join(tmp, 'bin')), dataDir: path.join(tmp, 'data'), fontsDir: tmp, settings: () => normalize({}) });
  const steps = [];
  const r = await pl.shrinkLarge(folder, { limitMb: 1.5, onProgress: (p, t) => steps.push(t) });
  assert.deepStrictEqual(r, { shrunk: [path.join('acc', 'short-1-moment.mp4')], failed: [] }, 'сжат только тяжёлый');
  assert.ok(fs.statSync(big).size <= 1.5 * 1048576 && fs.statSync(big).size < before / 2, `стало ${fs.statSync(big).size}`);
  assert.strictEqual(fs.statSync(small).size, smallBefore, 'лёгкий не тронут');
  assert.ok(steps.some((t) => /Сжимаю acc/.test(t)));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', big], { encoding: 'utf8' }).stdout;
  assert.match(probe, /video/); assert.match(probe, /audio/);
  assert.ok(!fs.readdirSync(path.join(folder, 'acc')).some((f) => f.endsWith('.shrink.mp4')), 'временный файл убран');
  assert.deepStrictEqual(await pl.shrinkLarge(folder, { limitMb: 1.5 }), { shrunk: [], failed: [] }, 'второй раз ничего не делает');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('сжатие перед отправкой: 8 проверок');
})().catch((e) => { console.error(e); process.exit(1); });
