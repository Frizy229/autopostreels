'use strict';
// Умный отбор на настоящем ffmpeg: чёрный экран с громкой музыкой — мусор, живой кадр с речью — остаётся.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const ff = (args) => assert.strictEqual(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  const aud = "[1:a]volume='if(between(t,30,34)+between(t,60,63),1,0.03)':eval=frame[a]";
  const mk = (name, vsrc) => { const f = path.join(tmp, name); ff(['-f', 'lavfi', '-i', vsrc, '-f', 'lavfi', '-i', 'sine=f=300:d=80', '-filter_complex', aud, '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', f]); return f; };
  const dead = mk('dead.mp4', 'color=c=black:s=320x180:r=25:d=80');
  const live = mk('live.mp4', 'testsrc2=s=320x180:r=25:d=80');

  // поддельный whisper: слова из FAKE_WORDS (число) каждые 0.4 с, иначе пусто
  const bin = path.join(tmp, 'bin'), fake = path.join(tmp, 'whisper.js');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a=process.argv;const of=a[a.indexOf('-of')+1];const n=+(process.env.FAKE_WORDS||0);const t=[];for(let i=0;i<n;i++)t.push({offsets:{from:i*400,to:i*400+350},text:i%9===8?' ха-ха-ха':' слово'+i});require('fs').writeFileSync(of+'.json',JSON.stringify({transcription:t}));`);
  fs.chmodSync(fake, 0o755);
  class T extends Tools { get whisper() { return fake; } }
  const tools = new T(bin);
  fs.mkdirSync(path.join(bin, 'models'), { recursive: true });
  const settings = normalize({ minLen: 8, maxLen: 12, encoder: 'cpu', perChannel: 2, channels: ['a'], outputDir: path.join(tmp, 'out') });
  fs.writeFileSync(path.join(bin, 'models', require('../lib/transcribe').MODELS[settings.whisperModel].file), 'x');
  const pl = new Pipeline({ tools, dataDir: path.join(tmp, 'data'), fontsDir: path.join(__dirname, '..', 'assets', 'fonts'), settings: () => settings });

  // 1. чёрный экран: всё мусор, ничего не выбрано, объяснение есть
  process.env.FAKE_WORDS = '40';
  const p1 = await pl.addFile(dead);
  const a1 = await pl.analyze(p1.id, () => {});
  assert.ok(a1.moments.length >= 2);
  assert.ok(a1.moments.every((m) => /чёрный экран/.test(m.junk)), JSON.stringify(a1.moments.map((m) => m.junk)));
  assert.ok(a1.moments.every((m) => !m.selected), 'мусор не выбран');
  assert.match(a1.judgeNote, /Отсеяно мусора/);

  // 2. живая картинка, но без слов — «музыка без речи»
  process.env.FAKE_WORDS = '0';
  const p2 = await pl.addFile(live);
  const a2 = await pl.analyze(p2.id, () => {});
  assert.ok(a2.moments.every((m) => /нет речи/.test(m.junk)), JSON.stringify(a2.moments.map((m) => m.junk)));

  // 3. живая картинка со словами и смехом — остаётся, с причиной и выдержкой
  process.env.FAKE_WORDS = '40';
  const p3 = await pl.addFile(live);
  const a3 = await pl.analyze(p3.id, () => {});
  const good = a3.moments.filter((m) => !m.junk);
  assert.ok(good.length >= 2 && good.every((m) => m.selected));
  assert.ok(good[0].excerpt.includes('слово'));
  assert.ok(good.some((m) => m.why.some((w) => /смех/.test(w))), JSON.stringify(good.map((m) => m.why)));

  // 4. выключено в настройках — прежний поиск, без оценки
  Object.assign(settings, { smartPick: false });
  const p4 = await pl.addFile(dead);
  const a4 = await pl.analyze(p4.id, () => {});
  assert.ok(a4.moments.every((m) => !m.junk && !m.judge));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('умный отбор: все проверки прошли');
})().catch((e) => { console.error(e); process.exit(1); });
