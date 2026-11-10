'use strict';
// Наложения: нормализация, шаблоны, граф ffmpeg; на настоящем ffmpeg — текст, плашка, картинка и видео появляются вовремя.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const O = require('../lib/overlays');

// ---- нормализация
assert.strictEqual(O.normItem({ kind: 'text', text: '   ' }), null, 'пустой текст не нужен');
assert.strictEqual(O.normItem({ kind: 'image', path: 'a.txt' }), null, 'не картинка');
assert.strictEqual(O.normItem({ kind: 'bad', text: 'x' }), null);
const t = O.normItem({ kind: 'text', text: 'Привет', x: 5, y: -9, size: 9999, color: 'red', start: 8, end: 2 });
assert.ok(t.x <= 1 && t.y >= -0.5 && t.size === 400 && t.color === '#ffffff', JSON.stringify(t));
assert.ok(t.start === 2 && t.end === 8, 'начало и конец переставлены');
const pl = O.newItem('plate');
assert.ok(pl.bg && pl.radius > 0 && pl.bgAlpha > 0.5 && pl.kind === 'plate');
assert.strictEqual(O.normItem({ kind: 'image', path: 'c:/x/a.gif' }).kind, 'video', 'гифка — это видео');
assert.strictEqual(O.normItem({ kind: 'video', path: '/x/a.png' }).kind, 'image');
assert.strictEqual(O.normItems(Array.from({ length: 30 }, () => ({ kind: 'text', text: 'a' }))).length, O.MAX_ITEMS);
assert.deepStrictEqual(O.normTemplates([{ id: 'a b', name: ' Мой ', items: [{ kind: 'text', text: 'x' }] }, { id: 'ab' }, null]).map((x) => [x.id, x.name, x.items.length]), [['ab', 'Мой', 1]]);

// ---- шаблон + свои, обрезка по длине ролика
const tpl = [{ kind: 'text', text: 'ШАБЛОН' }, { kind: 'text', text: 'ПОЗЖЕ', start: 50 }];
const own = [{ kind: 'text', text: 'СВОЙ', start: 3, end: 100 }];
const f = O.itemsFor(tpl, own, 30);
assert.deepStrictEqual(f.map((o) => o.text), ['ШАБЛОН', 'СВОЙ']);
assert.strictEqual(f[1].end, null, 'конец за пределами ролика — до конца');

// ---- ключ кэша зависит только от видимого
const a = O.normItem({ kind: 'text', text: 'А', x: 0.1 }), b = O.normItem({ kind: 'text', text: 'А', x: 0.5, start: 3 });
assert.strictEqual(O.visualKey(a), O.visualKey(b), 'позиция и время не меняют картинку');
assert.notStrictEqual(O.visualKey(a), O.visualKey({ ...a, size: 100 }));

// ---- граф
assert.deepStrictEqual(O.overlayGraph([]), { inputs: [], filter: '', vLabel: '[vout]' });
const g = O.overlayGraph([{ ...a, file: '/t/a.png' }, { ...O.normItem({ kind: 'video', path: '/t/v.gif', w: 0.3, start: 2, end: 5, fade: 0.5 }) }], { firstInput: 2 });
assert.ok(g.inputs.join(' ').startsWith('-loop 1 -framerate 30 -i /t/a.png -stream_loop -1 -i /t/v.gif'), g.inputs.join(' '));
assert.ok(g.filter.includes('[2:v]') && g.filter.includes('[3:v]') && g.filter.includes("enable='between(t,2,5)'") && g.filter.includes('fade=t=out:st=4.5') && g.vLabel === '[vfin]', g.filter);

// ---- настоящий ffmpeg
if (process.platform !== 'win32' && spawnSync('ffmpeg', ['-version']).status === 0) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-'));
  const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, `${args.slice(0, 12).join(' ')}\n${r.stderr}`); };
  const fontsDir = path.join(__dirname, '..', 'assets', 'fonts');
  // текст и плашка в PNG
  const it = O.normItem({ kind: 'text', text: 'ЗАНОС\nx1250', x: 0.05, y: 0.4, w: 0.9, h: 0.12, size: 110, color: '#ffff00' });
  const plate = O.normItem({ kind: 'plate', text: 'MEGA WIN', x: 0.2, y: 0.05, w: 0.6, h: 0.07, bg: '#ff0000', bgAlpha: 1, radius: 40, start: 1, end: 3 });
  const pngs = [it, plate].map((o, i) => {
    const tf = path.join(tmp, `t${i}.txt`), out = path.join(tmp, `o${i}.png`);
    fs.writeFileSync(tf, o.text);
    ff(O.textPngArgs(o, { fontsDir, textFile: tf, out }));
    return out;
  });
  // цвет пикселя в кадре PNG/видео
  const px = (file, x, y, at = 0) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    assert.ok(r.stdout.length >= 4, "пиксель не прочитан"); return [...r.stdout].slice(0, 4);
  };
  assert.strictEqual(px(pngs[1], 2, 2)[3], 0, 'угол плашки закруглён (прозрачный)');
  assert.deepStrictEqual(px(pngs[1], 60, 8).slice(0, 4), [255, 0, 0, 255], 'середина плашки красная');
  assert.strictEqual(px(pngs[0], 1, 1)[3], 0, 'у текста фон прозрачный');
  // картинка и «гифка» для наложения
  const img = path.join(tmp, 'sq.png'); ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=200x200', '-frames:v', '1', img]);
  const vid = path.join(tmp, 'blue.mp4'); ff(['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=200x200:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid]);
  const main = path.join(tmp, 'main.mp4'); ff(['-f', 'lavfi', '-i', 'color=c=0x202020:s=1080x1920:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', main]);
  const items = [
    { ...it, file: pngs[0] }, { ...plate, file: pngs[1] },
    { ...O.normItem({ kind: 'image', path: img, x: 0.0, y: 0.8, w: 0.2, start: 2, end: 4, fade: 0.3 }) },
    { ...O.normItem({ kind: 'video', path: vid, x: 0.7, y: 0.8, w: 0.2, start: 3 }) },
  ];
  const gr = O.overlayGraph(items, { firstInput: 1 });
  const out = path.join(tmp, 'out.mp4');
  ff(['-y', '-i', main, ...gr.inputs, '-filter_complex', `[0:v]setsar=1,format=yuv420p[vout]${gr.filter}`, '-map', gr.vLabel, '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  const near = (c, want, tol = 40) => c.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= tol);
  // плашка (красная) только на 1–3 с
  assert.ok(!near(px(out, 300, 100, 0.3), [255, 0, 0]), 'до 1 с плашки нет');
  assert.ok(near(px(out, 300, 100, 2), [255, 0, 0]), 'на 2 с плашка есть');
  assert.ok(!near(px(out, 300, 100, 4), [255, 0, 0]), 'после 3 с плашки нет');
  // картинка (зелёная) 2–4 с, левый нижний угол
  assert.ok(near(px(out, 100, 1600, 3), [0, 255, 0]), 'зелёная картинка на 3 с');
  assert.ok(!near(px(out, 100, 1600, 1), [0, 255, 0]) && !near(px(out, 100, 1600, 5), [0, 255, 0]), 'картинки нет вне 2–4 с');
  // видео-наложение (синее) с 3 с и до конца (повторяется по кругу)
  assert.ok(near(px(out, 860, 1600, 5.5), [0, 0, 255]), 'синее видео на 5,5 с (зациклено)');
  assert.ok(!near(px(out, 860, 1600, 1), [0, 0, 255]), 'до 3 с видео нет');
  // текст: жёлтые пиксели есть в зоне текста
  const crop = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'crop=900:230:90:768', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).stdout;
  let yellow = 0; for (let i = 0; i < crop.length; i += 3) if (crop[i] > 200 && crop[i + 1] > 200 && crop[i + 2] < 80) yellow++;
  assert.ok(yellow > 800, `жёлтый текст виден: ${yellow}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('наложения: все проверки прошли');

// ---- через конвейер: предпросмотр и рендер с наложениями (renderArgs)
(async () => {
  if (process.platform === 'win32' || spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('наложения (конвейер): ffmpeg не найден, пропущено'); return; }
  const { Pipeline } = require('../lib/pipeline');
  const { renderArgs } = require('../lib/render');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovp-'));
  const tools = { ffmpeg: 'ffmpeg', run: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); if (r.status !== 0) throw Object.assign(new Error(r.stderr), { res: r }); return Promise.resolve(r); } };
  const pl = new Pipeline({ tools, dataDir: tmp, fontsDir: path.join(__dirname, '..', 'assets', 'fonts'), settings: () => ({}) });
  const pv = await pl.overlayPreview({ kind: 'plate', text: 'ПЛАШКА', w: 0.5, h: 0.06, bg: '#336699' });
  assert.ok(pv.src.startsWith('data:image/png;base64,') && pv.src.length > 500 && pv.item.kind === 'plate');
  await assert.rejects(() => pl.overlayPreview({ kind: 'image', path: '/нет/такого.png' }), /не найден/);
  assert.strictEqual(await pl.overlayFile({ kind: 'image', path: '/нет/такого.png' }), null);
  const src = path.join(tmp, 'src.mp4');
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', src]).status, 0);
  const warns = [];
  const overlay = await pl.overlayPlan(O.itemsFor([], [{ kind: 'text', text: 'ПРИВЕТ', y: 0.5, start: 1 }, { kind: 'image', path: '/нет/файла.png' }], 4), 1, (w) => warns.push(w));
  assert.strictEqual(warns.length, 1, 'нет файла картинки: пропущено с предупреждением');
  assert.strictEqual(overlay.inputs.length, 6, 'в плане только текст: -loop 1 -framerate 30 -i png');
  const filter = { filter: '[0:v]scale=1080:1920,setsar=1,format=yuv420p[vout]', vLabel: '[vout]', aLabel: '0:a?' };
  const out = path.join(tmp, 'o.mp4');
  await tools.run('ffmpeg', renderArgs({ input: src, start: 0, end: 4, filter, overlay, output: out, encoder: 'cpu', quality: 'fast', fps: 25, maxDur: '4' }));
  assert.ok(fs.statSync(out).size > 1000, 'ролик с наложением собран');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('наложения (конвейер): проверки прошли');
})().catch((e) => { console.error(e); process.exit(1); });
