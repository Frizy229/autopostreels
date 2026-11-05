'use strict';
// Раскладка кадра 9:16. Все функции чистые: на входе размеры исходника и рамки (доли 0..1),
// на выходе строка filter_complex для ffmpeg и точки, где ставить заголовок и субтитры.

const OUT_W = 1080;
const OUT_H = 1920;

const LAYOUTS = {
  stream: 'Реакция сверху, видео снизу',
  filler: 'Стрим сверху, мини-игра снизу',
  full: 'Стрим по центру, размытый фон',
  camfull: 'Вебка крупно, видео в окне',
  crop: 'Обрезка 9:16',
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const evenPos = (n) => Math.max(0, Math.floor(n / 2) * 2); // координата: может быть 0, вниз — чтобы не вылезти за край
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Рамка в долях → пиксели исходника, чётные, внутри кадра. */
function rectPx(r, srcW, srcH) {
  const box = { x: 0, y: 0, w: 1, h: 1, ...(r || {}) };
  const w = even(clamp(box.w, 0.02, 1) * srcW);
  const h = even(clamp(box.h, 0.02, 1) * srcH);
  const x = evenPos(clamp(box.x * srcW, 0, srcW - w));
  const y = evenPos(clamp(box.y * srcH, 0, srcH - h));
  return { x: Math.min(x, srcW - w), y: Math.min(y, srcH - h), w, h };
}

/** Приблизить рамку к центру (zoom ≥ 1) — для «другого» варианта ролика. */
function zoomRect(r, zoom) {
  const z = Math.max(1, zoom || 1);
  if (z === 1) return { ...r };
  const w = r.w / z, h = r.h / z;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Рамка 9:16 (или другой пропорции) внутри области, по центру по x. */
function fitAspect(r, srcW, srcH, aspect) {
  const pw = r.w * srcW, ph = r.h * srcH;
  let w = pw, h = ph;
  if (pw / ph > aspect) w = ph * aspect; else h = pw / aspect;
  return { x: r.x + (pw - w) / 2 / srcW, y: r.y + (ph - h) / 2 / srcH, w: w / srcW, h: h / srcH };
}

const cropStr = (p) => `crop=${p.w}:${p.h}:${p.x}:${p.y}`;
const cover = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`;

/**
 * Собрать filter_complex.
 * opts: layout, srcW, srcH, cam, content (доли), split (доля высоты под вебку),
 *       variant {mirror, zoom, sat, bright, speed}, ass (уже экранированный путь или null), fontsDir.
 * Возвращает { filter, vLabel, aLabel, anchors: {titleY, subsY, contentTop, contentBottom} }.
 */
function buildFilter(opts) {
  const { srcW, srcH } = opts;
  const layout = LAYOUTS[opts.layout] ? opts.layout : 'stream';
  const v = { mirror: false, zoom: 1, sat: 1, bright: 0, speed: 1, ...(opts.variant || {}) };
  const content = zoomRect(opts.content || { x: 0, y: 0, w: 1, h: 1 }, v.zoom);
  const parts = [];
  let anchors;
  const flip = v.mirror ? ',hflip' : '';

  if (layout === 'stream' && opts.cam) {
    const split = clamp(opts.split || 0.4, 0.2, 0.6);
    const topH = even(OUT_H * split);
    const botH = OUT_H - topH;
    const cam = rectPx(opts.cam, srcW, srcH);
    const con = rectPx(content, srcW, srcH);
    parts.push('[0:v]split=2[cs][ks]');
    parts.push(`[cs]${cropStr(cam)},${cover(OUT_W, topH)}[cam]`);
    parts.push(`[ks]${cropStr(con)},${cover(OUT_W, botH)}${flip}[con]`);
    parts.push('[cam][con]vstack=inputs=2[stk]');
    anchors = { titleY: topH, subsY: Math.round(topH + botH * 0.62), contentTop: topH, contentBottom: OUT_H };
  } else if (layout === 'filler' && opts.filler) {
    // сверху весь кадр стрима (как есть, с вебкой) на размытом фоне, снизу мини-игра из папки
    const topH = even(OUT_H * 0.5), botH = OUT_H - topH;
    const fgH = Math.min(topH, even(OUT_W * srcH / srcW));
    parts.push(`[0:v]split=2[bs][fs]`);
    parts.push(`[bs]${cover(OUT_W, topH)},boxblur=24:2,eq=brightness=-0.15[bg]`);
    parts.push(`[fs]scale=${OUT_W}:${fgH}:flags=lanczos,setsar=1[fg]`);
    parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2[top]`);
    parts.push(`[1:v]${cover(OUT_W, botH)},setsar=1[game]`);
    parts.push('[top][game]vstack=inputs=2:shortest=1[stk]');
    const fgTop = Math.round((topH - fgH) / 2);
    anchors = { titleY: Math.max(120, fgTop - 10), subsY: topH, contentTop: 0, contentBottom: topH };
    if (fgTop < 140) anchors.titleY = 160;
  } else if (layout === 'camfull' && opts.cam) {
    // вебка на весь экран, видео окном посередине
    const cam = rectPx(opts.cam, srcW, srcH);
    const con = rectPx(content, srcW, srcH);
    const winW = 960, winH = even(winW * con.h / con.w);
    const y = Math.round(OUT_H * 0.56 - winH / 2);
    parts.push('[0:v]split=2[cs][ks]');
    parts.push(`[cs]${cropStr(cam)},${cover(OUT_W, OUT_H)}[cam]`);
    parts.push(`[ks]${cropStr(con)},scale=${winW}:${winH}:flags=lanczos,setsar=1${flip}[win]`);
    parts.push(`[cam][win]overlay=(W-w)/2:${y}[stk]`);
    anchors = { titleY: Math.max(160, y - 90), subsY: Math.min(OUT_H - 300, y + winH + 110), contentTop: y, contentBottom: y + winH };
  } else if (layout !== 'crop') {
    // full, а также stream/camfull без рамки вебки и filler без мини-игры
    const con = rectPx(content, srcW, srcH);
    const fgH = Math.min(OUT_H, even(OUT_W * con.h / con.w));
    const top = Math.round((OUT_H - fgH) / 2);
    parts.push(`[0:v]${cropStr(con)}${flip},split=2[bs][fs]`);
    parts.push(`[bs]${cover(OUT_W, OUT_H)},boxblur=24:2,eq=brightness=-0.12:saturation=1.15[bg]`);
    parts.push(`[fs]scale=${OUT_W}:${fgH}:flags=lanczos,setsar=1[fg]`);
    parts.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[stk]');
    anchors = { titleY: Math.max(150, top - 40), subsY: Math.min(OUT_H - 330, top + fgH + 120), contentTop: top, contentBottom: top + fgH };
    if (fgH > OUT_H * 0.7) anchors = { ...anchors, titleY: 300, subsY: Math.round(OUT_H * 0.7) };
  } else {
    const box = rectPx(fitAspect(content, srcW, srcH, OUT_W / OUT_H), srcW, srcH);
    parts.push(`[0:v]${cropStr(box)},${cover(OUT_W, OUT_H)}${flip}[stk]`);
    anchors = { titleY: 330, subsY: Math.round(OUT_H * 0.7), contentTop: 0, contentBottom: OUT_H };
  }

  // цвет, скорость, субтитры
  let tail = '[stk]setsar=1';
  if (v.sat !== 1 || v.bright !== 0) tail += `,eq=saturation=${v.sat}:brightness=${v.bright}`;
  if (v.speed !== 1) tail += `,setpts=PTS/${v.speed}`;
  if (opts.ass) tail += `,ass=${opts.ass}${opts.fontsDir ? `:fontsdir=${opts.fontsDir}` : ''}`;
  tail += ',format=yuv420p[vout]';
  parts.push(tail);
  let aLabel = opts.hasAudio === false ? null : '0:a?';
  if (aLabel && v.speed !== 1) { parts.push(`[0:a]atempo=${v.speed}[aout]`); aLabel = '[aout]'; }
  const used = layout === 'stream' && !opts.cam ? 'full' : layout === 'camfull' && !opts.cam ? 'full' : layout === 'filler' && !opts.filler ? 'full' : layout;
  return { filter: parts.join(';'), vLabel: '[vout]', aLabel, anchors, layout: used };
}

/**
 * Путь для опции фильтра ffmpeg (ass=..., fontsdir=...): прямые слеши, экранированные «:» и кавычки,
 * всё в одинарных кавычках. На Windows без этого «C:» ломает разбор фильтра.
 */
function filterPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/'/g, "'\\\\\\''").replace(/:/g, '\\:');
  return `'${s}'`;
}

module.exports = { OUT_W, OUT_H, LAYOUTS, rectPx, zoomRect, fitAspect, buildFilter, filterPath, even };
