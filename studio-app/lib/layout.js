'use strict';
// Раскладка кадра 9:16. Все функции чистые: на входе размеры исходника и рамки (доли 0..1),
// на выходе строка filter_complex для ffmpeg и точки, где ставить заголовок и субтитры.
//
// Почти все раскладки собираются одинаково: размытый фон на весь экран, сверху на него кладутся куски
// исходника (вебки и контент). Кусок либо вписывается в своё место целиком (fit, без обрезки краёв),
// либо заполняет его (cover, лишнее по краям обрезается).

const OUT_W = 1080;
const OUT_H = 1920;
const MAX_CAMS = 4;

const LAYOUTS = {
  stream: 'Реакция сверху, видео снизу',
  below: 'Видео сверху, реакция снизу',
  duo: 'Две вебки: сверху и снизу, видео посередине',
  pip: 'Видео по центру, вебки окном над ним',
  camonly: 'Только вебка крупно',
  filler: 'Стрим сверху, мини-игра снизу',
  full: 'Стрим по центру, размытый фон',
  camfull: 'Вебка крупно, видео в окне',
  crop: 'Обрезка 9:16',
};
// раскладки, которым нужна рамка вебки (без неё они собираются как «full»)
const CAM_LAYOUTS = ['stream', 'below', 'duo', 'pip', 'camonly', 'camfull'];
// как класть видео (контент) в раскладках с вебкой
const FITS = { fit: 'Целиком, без обрезки', fill: 'Заполнить, края обрезаются' };

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

/** Все вебки рамки: новый формат {cams: [...]}, старый {cam}. Не больше MAX_CAMS. */
function camsOf(frame) {
  if (!frame) return [];
  const list = Array.isArray(frame.cams) ? frame.cams : frame.cam ? [frame.cam] : [];
  return list.filter((r) => r && r.w > 0 && r.h > 0).slice(0, MAX_CAMS);
}

/**
 * Разложить n вебок по месту box (пиксели вывода) сеткой, у которой клетки ближе всего к пропорции вебок.
 * Неполный последний ряд растягивается на всю ширину. Возвращает клетки {x, y, w, h}, чётные.
 */
function camGrid(n, box, aspect = 16 / 10) {
  if (n <= 1) return [{ ...box }];
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const a = (box.w / cols) / (box.h / rows);
    // лицо выше, чем шире: лучше обрезать вебку по бокам, чем срезать голову, поэтому клетка поуже
    const score = Math.abs(Math.log(a / (aspect * 0.6))) + (rows * cols - n) * 0.15;
    if (!best || score < best.score) best = { cols, rows, score };
  }
  const cells = [];
  const rowH = box.h / best.rows;
  for (let r = 0; r < best.rows; r++) {
    const inRow = Math.min(best.cols, n - r * best.cols);
    const y0 = evenPos(box.y + r * rowH), y1 = r === best.rows - 1 ? box.y + box.h : evenPos(box.y + (r + 1) * rowH);
    for (let c = 0; c < inRow; c++) {
      const x0 = evenPos(box.x + c * box.w / inRow), x1 = c === inRow - 1 ? box.x + box.w : evenPos(box.x + (c + 1) * box.w / inRow);
      cells.push({ x: x0, y: y0, w: even(x1 - x0), h: even(y1 - y0) });
    }
  }
  return cells;
}

/** Вписать кусок src (пиксели) в место box целиком. align: 'center' | 'top' | 'bottom'. */
function fitInto(src, box, align = 'center') {
  const k = Math.min(box.w / src.w, box.h / src.h);
  const w = Math.min(box.w, even(src.w * k)), h = Math.min(box.h, even(src.h * k));
  const x = box.x + evenPos((box.w - w) / 2);
  const free = box.h - h;
  const y = box.y + (align === 'top' ? 0 : align === 'bottom' ? free : evenPos(free / 2));
  return { x, y, w, h };
}

const cropStr = (p) => `crop=${p.w}:${p.h}:${p.x}:${p.y}`;
const cover = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`;

/**
 * Собрать filter_complex.
 * opts: layout, srcW, srcH, cams ([рамки]; или cam — одна), content (доли), split (доля высоты под вебку),
 *       fit ('fit' — видео целиком по ширине, 'fill' — заполнить место с обрезкой краёв),
 *       variant {mirror, zoom, sat, bright, speed}, ass (уже экранированный путь или null), fontsDir.
 * Возвращает { filter, vLabel, aLabel, anchors: {titleY, subsY, contentTop, contentBottom}, layout, cams }.
 */
// ------------------------------------------------------------------ блюр областей
// Блюр задаётся на проект (на всё видео-источник): рамка в долях кадра и время в секундах исходника.
// start/end = null — на всё видео. Ставится до раскладки, поэтому размыто и в вебке, и в контенте, и в фоне.
const MAX_BLURS = 12;

/** Привести список блюров из окна к виду для сохранения: рамка внутри кадра, время по порядку. */
function normBlurs(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_BLURS).map((b, i) => {
    const w = clamp(+b.w || 0.2, 0.02, 1), h = clamp(+b.h || 0.1, 0.02, 1);
    const r = { id: String(b.id || `b${i + 1}`).slice(0, 20), x: clamp(+b.x || 0, 0, 1 - w), y: clamp(+b.y || 0, 0, 1 - h), w, h,
      start: b.start == null || b.start === '' ? null : Math.max(0, +b.start), end: b.end == null || b.end === '' ? null : Math.max(0, +b.end),
      strength: clamp(Math.round(+b.strength || 30), 5, 80) };
    if (r.start != null && r.end != null && r.end < r.start) [r.start, r.end] = [r.end, r.start];
    return r;
  }).filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite));
}

/**
 * Блюры, которые попадают в отрезок [mStart, mEnd] исходника, со временем от начала ролика:
 * {x, y, w, h, strength, from, to} (from/to = null — весь ролик).
 */
function blursFor(list, mStart, mEnd) {
  const dur = mEnd - mStart;
  return normBlurs(list).filter((b) => (b.start == null || b.start < mEnd) && (b.end == null || b.end > mStart)).map((b) => {
    const from = b.start == null ? 0 : Math.max(0, b.start - mStart), to = b.end == null ? dur : Math.min(dur, b.end - mStart);
    return { x: b.x, y: b.y, w: b.w, h: b.h, strength: b.strength, from: from <= 0.01 && to >= dur - 0.01 ? null : +from.toFixed(2), to: from <= 0.01 && to >= dur - 0.01 ? null : +to.toFixed(2) };
  });
}

/** Цепочка фильтров: [0:v] → размытые области → [label]. '' — блюров нет. */
function blurChain(blurs, srcW, srcH, label = 'vb') {
  if (!blurs || !blurs.length) return '';
  const parts = [];
  let cur = '0:v';
  blurs.forEach((b, i) => {
    const r = rectPx(b, srcW, srcH);
    const sigma = Math.max(2, Math.round(b.strength || 30) * Math.min(srcW, srcH) / 1080);
    const en = b.from == null ? '' : `:enable='between(t,${b.from},${b.to})'`;
    const out = i === blurs.length - 1 ? label : `vb${i}`;
    parts.push(`[${cur}]split=2[bm${i}][bs${i}]`);
    parts.push(`[bs${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},gblur=sigma=${sigma}:steps=2[bk${i}]`);
    parts.push(`[bm${i}][bk${i}]overlay=${r.x}:${r.y}${en}[${out}]`);
    cur = out;
  });
  return parts.join(';');
}

function buildFilter(opts) {
  const { srcW, srcH } = opts;
  let layout = LAYOUTS[opts.layout] ? opts.layout : 'stream';
  const v = { mirror: false, zoom: 1, sat: 1, bright: 0, speed: 1, ...(opts.variant || {}) };
  const content = zoomRect(opts.content || { x: 0, y: 0, w: 1, h: 1 }, v.zoom);
  const camRects = (opts.cams ? camsOf({ cams: opts.cams }) : camsOf({ cam: opts.cam })).map((r) => rectPx(r, srcW, srcH));
  const fill = opts.fit === 'fill';
  const flip = v.mirror ? ',hflip' : '';
  const con = rectPx(content, srcW, srcH);
  const camAspect = camRects.length ? camRects.reduce((a, r) => a + r.w / r.h, 0) / camRects.length : 16 / 10;
  const parts = [];
  let anchors;

  // нет вебки — раскладки с вебкой собираются как «full»; «две вебки» с одной — как «реакция сверху»
  if (CAM_LAYOUTS.includes(layout) && !camRects.length) layout = 'full';
  if (layout === 'duo' && camRects.length < 2) layout = 'stream';
  if (layout === 'filler' && !opts.filler) layout = 'full';

  // куски для наложения на размытый фон: {src, box, mode: 'fit'|'cover', align, flip}
  const pieces = [];
  const fitH = Math.min(OUT_H, even(OUT_W * con.h / con.w)); // высота видео, вписанного по ширине
  const putContent = (box, align, forceFit) => {
    const mode = fill && !forceFit ? 'cover' : 'fit';
    const at = mode === 'cover' ? box : fitInto(con, box, align);
    pieces.push({ src: con, box: at, mode, flip: true });
    return at;
  };
  const putCams = (box, list = camRects, mode = 'cover') => {
    const cells = camGrid(list.length, box, camAspect);
    list.forEach((r, i) => pieces.push({ src: r, box: mode === 'cover' ? cells[i] : fitInto(r, cells[i]), mode }));
  };

  if (layout === 'stream') {
    const split = clamp(opts.split || 0.4, 0.2, 0.6);
    const topH = even(OUT_H * split);
    putCams({ x: 0, y: 0, w: OUT_W, h: topH });
    const at = putContent({ x: 0, y: topH, w: OUT_W, h: OUT_H - topH }, 'top');
    const below = OUT_H - (at.y + at.h);
    anchors = { titleY: topH, subsY: below > 260 ? Math.round(at.y + at.h + below * 0.42) : Math.round(at.y + at.h * 0.62), contentTop: at.y, contentBottom: at.y + at.h };
  } else if (layout === 'below') {
    const split = clamp(opts.split || 0.4, 0.2, 0.6);
    const botH = even(OUT_H * split);
    const camTop = OUT_H - botH;
    putCams({ x: 0, y: camTop, w: OUT_W, h: botH });
    const at = putContent({ x: 0, y: 0, w: OUT_W, h: camTop }, 'bottom');
    anchors = { titleY: at.y > 260 ? Math.max(170, Math.round(at.y / 2)) : 220, subsY: camTop, contentTop: at.y, contentBottom: at.y + at.h };
  } else if (layout === 'duo') {
    const midH = fill ? even(OUT_H * 0.4) : Math.min(even(OUT_H * 0.5), fitH);
    const camH = even((OUT_H - midH) / 2);
    putCams({ x: 0, y: 0, w: OUT_W, h: camH }, [camRects[0]]);
    const at = putContent({ x: 0, y: camH, w: OUT_W, h: OUT_H - camH * 2 }, 'center');
    putCams({ x: 0, y: OUT_H - camH, w: OUT_W, h: camH }, camRects.slice(1));
    anchors = { titleY: camH, subsY: Math.round(at.y + at.h * 0.72), contentTop: at.y, contentBottom: at.y + at.h };
  } else if (layout === 'pip') {
    const at = putContent({ x: 0, y: 0, w: OUT_W, h: OUT_H }, 'center', true);
    const top = Math.max(at.y, 420);
    putCams({ x: 60, y: 150, w: OUT_W - 120, h: top - 150 - 24 }, camRects, 'fit');
    anchors = { titleY: top, subsY: Math.min(OUT_H - 330, top + at.h + 150), contentTop: at.y, contentBottom: at.y + at.h };
  } else if (layout === 'camonly') {
    putCams({ x: 0, y: 0, w: OUT_W, h: OUT_H });
    anchors = { titleY: 330, subsY: Math.round(OUT_H * 0.7), contentTop: 0, contentBottom: OUT_H };
  } else if (layout === 'camfull') {
    // вебки на весь экран, видео окном посередине (всегда целиком)
    putCams({ x: 0, y: 0, w: OUT_W, h: OUT_H });
    const winW = 960, winH = Math.min(even(OUT_H * 0.5), even(winW * con.h / con.w));
    const y = evenPos(OUT_H * 0.56 - winH / 2);
    const at = fitInto(con, { x: (OUT_W - winW) / 2, y, w: winW, h: winH });
    pieces.push({ src: con, box: at, mode: 'fit', flip: true });
    anchors = { titleY: Math.max(160, at.y - 90), subsY: Math.min(OUT_H - 300, at.y + at.h + 110), contentTop: at.y, contentBottom: at.y + at.h };
  }

  if (pieces.length) {
    // размытый фон из контента + наложения
    parts.push(`[0:v]split=${pieces.length + 1}[bs]${pieces.map((_, i) => `[p${i}]`).join('')}`);
    parts.push(`[bs]${cropStr(con)},${cover(OUT_W, OUT_H)},boxblur=24:2,eq=brightness=-0.12:saturation=1.15[b0]`);
    pieces.forEach((p, i) => {
      const scale = p.mode === 'cover' ? cover(p.box.w, p.box.h) : `scale=${p.box.w}:${p.box.h}:flags=lanczos`;
      parts.push(`[p${i}]${cropStr(p.src)},${scale},setsar=1${p.flip ? flip : ''}[q${i}]`);
      parts.push(`[b${i}][q${i}]overlay=${p.box.x}:${p.box.y}${i === pieces.length - 1 ? '[stk]' : `[b${i + 1}]`}`);
    });
  } else if (layout === 'filler') {
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
  } else if (layout === 'full') {
    const fgH = fitH;
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
  // блюр областей — до раскладки: кадр источника [0:v] заменяется на уже размытый [vb]
  const bc = blurChain(opts.blurs, srcW, srcH);
  if (bc) {
    const i = parts.findIndex((p) => p.startsWith('[0:v]'));
    parts[i] = `[vb]${parts[i].slice(5)}`;
    parts.unshift(bc);
  }
  let aLabel = opts.hasAudio === false ? null : '0:a?';
  if (aLabel && v.speed !== 1) { parts.push(`[0:a]atempo=${v.speed}[aout]`); aLabel = '[aout]'; }
  return { filter: parts.join(';'), vLabel: '[vout]', aLabel, anchors, layout, cams: camRects.length, pieces };
}

/**
 * Путь для опции фильтра ffmpeg (ass=..., fontsdir=...): прямые слеши, экранированные «:» и кавычки,
 * всё в одинарных кавычках. На Windows без этого «C:» ломает разбор фильтра.
 */
function filterPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/'/g, "'\\\\\\''").replace(/:/g, '\\:');
  return `'${s}'`;
}

module.exports = { MAX_BLURS, normBlurs, blursFor, blurChain, OUT_W, OUT_H, MAX_CAMS, LAYOUTS, CAM_LAYOUTS, FITS, rectPx, zoomRect, fitAspect, camsOf, camGrid, fitInto, buildFilter, filterPath, even };
