'use strict';
// Заносы на настоящем ffmpeg и настоящем чтении экрана: громкий кусок с плашкой «MEGA WIN x1250» — занос,
// такой же громкий без выигрыша — пустое вращение. Whisper подменён скриптом, который слышит громкость.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Tools } = require('../lib/tools');
const { Pipeline } = require('../lib/pipeline');
const { normalize } = require('../lib/settings');
const { ocrAvailable } = require('../lib/ocr');

if (process.platform === 'win32' || spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('пропущено: нужен ffmpeg в PATH (Linux/macOS)'); process.exit(0); }
const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf'].find((f) => fs.existsSync(f));
const realOcr = !!font && ocrAvailable();

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-'));
  const ff = (args) => assert.strictEqual(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0);
  // 130 с: ровный звук; занос 60–67 с (громко, плашка с 58 по 72 с); громкий кусок без выигрыша 100–104 с
  const src = path.join(tmp, 'stream.mp4');
  const vf = realOcr
    ? `drawtext=fontfile=${font}:text='MEGA WIN':fontsize=90:fontcolor=yellow:x=(w-tw)/2:y=180:enable='between(t,58,72)',drawtext=fontfile=${font}:text='x1250':fontsize=120:fontcolor=white:x=(w-tw)/2:y=330:enable='between(t,58,72)'`
    : 'null';
  // занос — тон 300 Гц, пустой громкий кусок — тон 900 Гц (поддельный whisper различает их по частоте)
  ff(['-f', 'lavfi', '-i', 'color=c=0x203060:s=1280x720:r=5:d=130', '-f', 'lavfi', '-i', 'sine=f=300:d=130', '-f', 'lavfi', '-i', 'sine=f=900:d=130',
    '-filter_complex', `[0:v]${vf}[v];[1:a]volume='if(between(t,60,67),0.9,0.03)':eval=frame[a1];[2:a]volume='if(between(t,100,104),0.9,0)':eval=frame[a2];[a1][a2]amix=inputs=2:duration=first,volume=2[a]`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src]);

  // поддельный whisper: слышит громкость wav; где громко (rms > 0.05, sine в ffmpeg тихий: 0,125 амплитуды) — «занос», иначе «слово»
  const bin = path.join(tmp, 'bin'), fake = path.join(tmp, 'whisper.js');
  fs.writeFileSync(fake, `#!${process.execPath}
const a=process.argv,fs=require('fs');const of=a[a.indexOf('-of')+1],f=a[a.indexOf('-f')+1];
const b=fs.readFileSync(f);const d=b.indexOf('data')+8;const n=(b.length-d)>>1;const t=[];
for(let s=0;s+6400<=n;s+=6400){let e=0;for(let i=0;i<6400;i++){const v=b.readInt16LE(d+(s+i)*2)/32768;e+=v*v;}const rms=Math.sqrt(e/6400);let z=0;for(let i=1;i<6400;i++){if((b.readInt16LE(d+(s+i)*2)>0)!==(b.readInt16LE(d+(s+i-1)*2)>0))z++;}const ms=s/16;
t.push({offsets:{from:ms,to:ms+350},text:rms>0.05&&z<400?' занос':' слово'});}
fs.writeFileSync(of+'.json',JSON.stringify({transcription:t}));`);
  fs.chmodSync(fake, 0o755);
  class T extends Tools { get whisper() { return fake; } }
  const tools = new T(bin);
  fs.mkdirSync(path.join(bin, 'models'), { recursive: true });
  const settings = normalize({ minLen: 20, maxLen: 50, encoder: 'cpu', perChannel: 2, channels: ['a'], outputDir: path.join(tmp, 'out') });
  fs.writeFileSync(path.join(bin, 'models', require('../lib/transcribe').MODELS[settings.whisperModel].file), 'x');
  const pl = new Pipeline({ tools, dataDir: path.join(tmp, 'data'), fontsDir: path.join(__dirname, '..', 'assets', 'fonts'), settings: () => settings });

  const p1 = await pl.addFile(src);
  const steps = [];
  const a1 = await pl.analyze(p1.id, (p, t) => steps.push(t), null, { mode: 'zanos' });
  assert.strictEqual(a1.mode, 'zanos');
  assert.ok(steps.some((t) => /Слушаю кандидатов/.test(t)), 'прогресс по кандидатам');
  const good = a1.moments.filter((m) => !m.junk);
  assert.strictEqual(good.length, 1, `один занос: ${JSON.stringify(a1.moments.map((m) => [m.peak, m.junk, m.why]))}`);
  const z = good[0];
  assert.ok(z.peak >= 55 && z.peak <= 68, `пик заноса: ${z.peak}`);
  // подводка до крика и концовка после: момент охватывает 60–67 с целиком
  assert.ok(z.start <= 52 && z.start >= 36, `подводка: ${z.start}`);
  assert.ok(z.end >= 71 && z.end <= 90, `концовка: ${z.end}`);
  assert.ok(z.end - z.start >= 20 && z.end - z.start <= 54, `длина: ${z.end - z.start}`);
  assert.ok(z.selected && z.kind === 'zanos');
  assert.ok(z.why.some((w) => /слова: .*занос/.test(w)), z.why.join(' | '));
  if (realOcr) {
    assert.ok(z.zanos.mult >= 1000, `иксы с экрана: ${JSON.stringify(z.zanos)}`);
    assert.ok(z.why.some((w) => /x1 ?250/.test(w)) && z.why.some((w) => /MEGA/.test(w)), z.why.join(' | '));
  }
  assert.ok(z.excerpt.includes('занос'));
  // громкий кусок без выигрыша — пустое вращение: слов о заносе нет, экран пустой
  const bad = a1.moments.filter((m) => m.junk);
  assert.ok(bad.length >= 1 && bad.every((m) => !m.selected), 'пустые отсеяны и не выбраны');
  assert.ok(bad.some((m) => /пустое вращение/.test(m.junk)), bad.map((m) => m.junk).join(' | '));
  assert.match(a1.judgeNote, /Найдено заносов: 1/);
  assert.ok(Math.abs(z.words[0].s - z.start) < 6, 'слова подрезаны под границы момента');

  // экран выключен — занос всё равно находится по словам и громкости
  Object.assign(settings, { ocr: false });
  const p2 = await pl.addFile(src);
  const a2 = await pl.analyze(p2.id, () => {}, null, { mode: 'zanos' });
  assert.strictEqual(a2.moments.filter((m) => !m.junk).length, 1, 'без экрана тоже найден');
  assert.ok(!a2.moments.find((m) => !m.junk).why.some((w) => /на экране/.test(w)));

  // обычный поиск после заносов работает как раньше
  Object.assign(settings, { ocr: true });
  const a3 = await pl.analyze(p1.id, () => {});
  assert.notStrictEqual(a3.mode, 'zanos');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`заносы на ffmpeg: все проверки прошли${realOcr ? ' (с настоящим чтением экрана)' : ' (экран пропущен: нет шрифта или tesseract)'}`);
})().catch((e) => { console.error(e); process.exit(1); });
