'use strict';
// Сквозной тест на настоящем ffmpeg: файл стрима → моменты → проверка правил → 2 канала → папка автозалива.
// whisper подменён скриптом, который «распознаёт» слова. Без ffmpeg набор пропускается.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  const ff = (args) => assert.strictEqual(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  // «стрим» 80 с: тихо, громко на 30–34 с и на 60–63 с
  const src = path.join(tmp, 'stream.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=80', '-f', 'lavfi', '-i', 'sine=f=300:d=80',
    '-filter_complex', "[1:a]volume='if(between(t,30,34)+between(t,60,63),1,0.03)':eval=frame[a]", '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src]);
  const fillerDir = path.join(tmp, 'games'); fs.mkdirSync(fillerDir);
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=320x240:r=25', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(fillerDir, 'game.mp4')]);

  // поддельный whisper: слова каждые 0.4 с
  const bin = path.join(tmp, 'bin');
  const fake = path.join(tmp, 'whisper.js');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a=process.argv;const of=a[a.indexOf('-of')+1];const t=[];for(let i=0;i<40;i++)t.push({offsets:{from:i*400,to:i*400+350},text:' слово'+i});require('fs').writeFileSync(of+'.json',JSON.stringify({transcription:t}));`);
  fs.chmodSync(fake, 0o755);
  class T extends Tools { get whisper() { return fake; } }
  const tools = new T(bin);
  fs.mkdirSync(path.join(bin, 'models'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'models', 'ggml-large-v3-turbo.bin'), 'x');

  let settings = normalize({ channels: ['evelon185', 'second'], perChannel: 2, minLen: 8, maxLen: 12, encoder: 'cpu', quality: 'fast',
    formats: ['stream', 'filler'], subStyles: ['neon', 'box'], fillerDir, outputDir: path.join(tmp, 'out'), rules: { minWords: 5 } });
  const pl = new Pipeline({ tools, dataDir: path.join(tmp, 'data'), fontsDir: path.join(__dirname, '..', 'assets', 'fonts'), settings: () => settings });

  const pr = await pl.addFile(src);
  assert.strictEqual(pr.source.width, 640);
  assert.ok(Math.abs(pr.source.duration - 80) < 0.5);
  const steps = [];
  const an = await pl.analyze(pr.id, (p, t) => steps.push(t));
  assert.ok(steps.includes('Слушаю звук'));
  assert.ok(an.moments.length >= 2, `моменты: ${an.moments.length}`);
  const peaks = an.moments.map((m) => m.peak).sort((a, b) => a - b);
  assert.ok(peaks.some((p) => p >= 29 && p <= 35) && peaks.some((p) => p >= 59 && p <= 64), `пики ${peaks}`);
  assert.ok(an.envelope.length > 10);

  // без рамки вебки раскладка stream не пройдёт проверку
  await assert.rejects(pl.build({ projectIds: [pr.id], name: 'Тест' }), (e) => /Ни один момент не прошёл/.test(e.message) && e.rejected[0].projectId === pr.id);
  const chk = pl.get(pr.id).moments.find((m) => m.selected).check;
  assert.deepStrictEqual(chk.issues, ['не задана рамка вебки']);
  assert.ok(pl.get(pr.id).moments.find((m) => m.selected).words.length > 5, 'слова распознаны и сохранены');

  // «Без вебки» (рамка сохранена без вебки) — проверка проходит, ролики соберутся без неё
  pl.update(pr.id, { frame: { cam: null, content: { x: 0, y: 0, w: 1, h: 1 } } });
  await pl.check(pr.id);
  assert.ok(pl.get(pr.id).moments.filter((m) => m.selected).every((m) => m.check.ok), 'без вебки — не ошибка');

  pl.update(pr.id, { frame: { cam: { x: 0.65, y: 0, w: 0.35, h: 0.4 }, content: { x: 0, y: 0, w: 1, h: 1 } } });
  const sel = pl.get(pr.id).moments.filter((m) => m.selected).slice(0, 2);
  pl.update(pr.id, { moments: pl.get(pr.id).moments.map((m) => ({ ...m, selected: sel.some((x) => x.id === m.id), title: m.id === sel[0].id ? 'Контратака | хорошая' : '' })) });
  const events = [];
  const res = await pl.build({ projectIds: [pr.id], name: 'Эвелон тест', onEvent: (e) => events.push(e) });
  assert.deepStrictEqual(res.problems, []);
  assert.strictEqual(res.videos, 4, '2 канала × 2 ролика');
  assert.strictEqual(path.basename(res.folder), '001_evelon-test');
  assert.ok(fs.existsSync(path.join(res.folder, 'evelon185', 'short-1-kontrataka-horoshaya.mp4')));
  const done = events.filter((e) => e.stage === 'Готово');
  assert.deepStrictEqual(done.map((e) => e.layout), ['stream', 'stream', 'filler', 'filler'], 'один момент у двух каналов в разных раскладках');
  for (const e of done) {
    const pr2 = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', e.file], { encoding: 'utf8' }).stdout;
    assert.match(pr2, /video,1080,1920/);
    assert.match(pr2, /audio/);
    const dur = parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', e.file], { encoding: 'utf8' }).stdout);
    assert.ok(dur > 6 && dur < 14, `длина ${dur}`);
  }
  const txt = fs.readFileSync(path.join(res.folder, 'evelon185', 'short-1-kontrataka-horoshaya.txt'), 'utf8');
  assert.match(txt, /twitch: evelone2004/);
  assert.match(txt, /#evelone/);
  // вторая сборка — следующий номер папки
  const res2 = await pl.build({ projectIds: [pr.id], name: 'ещё' });
  assert.strictEqual(path.basename(res2.folder), '002_esche');
  if (process.env.KEEP) console.log('папка:', res.folder); else fs.rmSync(tmp, { recursive: true, force: true });
  console.log('конвейер: 25 проверок на настоящем ffmpeg');
})().catch((e) => { console.error(e); process.exit(1); });
