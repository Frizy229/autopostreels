'use strict';
// Наложения на ролик: текст, плашки, картинки, гифки и видео. Координаты в долях кадра 1080×1920 (левый верхний угол),
// время в секундах от начала готового ролика (после ускорения). Текст и плашки рисует ffmpeg в PNG (один и тот же код
// для предпросмотра и для рендера), потом PNG и медиа накладываются цепочкой overlay. Чистые функции, без запуска ffmpeg.

const { filterPath } = require('./layout');

const OUT_W = 1080, OUT_H = 1920;
const MAX_ITEMS = 12;
const KINDS = { text: 'Текст', plate: 'Плашка', image: 'Картинка', video: 'Видео / гифка' };
const FONTS = {
  montserrat: { name: 'Montserrat Black', file: 'Montserrat_900Black.ttf' },
  rubik: { name: 'Rubik Black', file: 'Rubik_900Black.ttf' },
  russo: { name: 'Russo One', file: 'RussoOne_400Regular.ttf' },
  unbounded: { name: 'Unbounded Black', file: 'Unbounded_900Black.ttf' },
};
const ALIGNS = { left: 'Слева', center: 'По центру', right: 'Справа' };
const MEDIA_EXT = {
  image: /\.(png|jpe?g|webp|bmp)$/i,
  video: /\.(gif|mp4|mov|webm|mkv|m4v|avi)$/i,
};

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : d);
const time = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? Math.max(0, Math.round(+v * 100) / 100) : null));

/** Вид по расширению файла: картинка / видео-гифка; '' — не подходит. */
function mediaKind(file) {
  const f = String(file || '');
  if (MEDIA_EXT.image.test(f)) return 'image';
  if (MEDIA_EXT.video.test(f)) return 'video';
  return '';
}

/** Новый элемент нужного вида с разумными значениями (для кнопок «Добавить»). */
function newItem(kind, extra = {}) {
  const id = `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  if (kind === 'text') return normItem({ id, kind, text: 'Текст', x: 0.1, y: 0.62, w: 0.8, h: 0.1, size: 90, color: '#ffffff', bg: '', outline: true, align: 'center', ...extra });
  if (kind === 'plate') return normItem({ id, kind, text: 'Плашка', x: 0.15, y: 0.08, w: 0.7, h: 0.07, size: 56, color: '#ffffff', bg: '#c8102e', bgAlpha: 0.9, radius: 24, align: 'center', ...extra });
  return normItem({ id, kind, x: 0.62, y: 0.1, w: 0.3, opacity: 1, ...extra });
}

/** Один элемент к допустимому виду; null — выбросить. */
function normItem(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const kind = KINDS[r.kind] ? r.kind : null;
  if (!kind) return null;
  const o = {
    id: String(r.id || `o${Math.random().toString(36).slice(2, 8)}`).replace(/[^\w-]/g, '').slice(0, 24) || 'o1',
    kind,
    x: num(r.x, -0.5, 1, 0.1), y: num(r.y, -0.5, 1, 0.1), w: num(r.w, 0.03, 1.5, 0.4),
    start: time(r.start), end: time(r.end),
    fade: num(r.fade, 0, 3, 0), opacity: num(r.opacity, 0.05, 1, 1),
  };
  if (o.start != null && o.end != null && o.end < o.start) [o.start, o.end] = [o.end, o.start];
  if (kind === 'text' || kind === 'plate') {
    o.h = num(r.h, 0.02, 1.5, kind === 'plate' ? 0.07 : 0.1);
    o.text = String(r.text == null ? '' : r.text).replace(/\r/g, '').slice(0, 300);
    o.font = FONTS[r.font] ? r.font : 'montserrat';
    o.size = Math.round(num(r.size, 16, 400, 80));
    o.color = color(r.color, '#ffffff');
    o.align = ALIGNS[r.align] ? r.align : 'center';
    o.outline = r.outline === undefined ? kind === 'text' : !!r.outline;
    o.bg = kind === 'plate' ? color(r.bg, '#c8102e') : color(r.bg, '');
    o.bgAlpha = o.bg ? num(r.bgAlpha, 0.05, 1, 0.9) : 0;
    o.radius = Math.round(num(r.radius, 0, 300, kind === 'plate' ? 24 : 0));
    if (!o.text.trim()) return null;
  } else {
    o.path = String(r.path || '');
    if (!o.path || mediaKind(o.path) === '') return null;
    o.kind = mediaKind(o.path);   // вид по файлу: гифка — всегда «видео»
    // удаление фона: цвет (#rrggbb) становится прозрачным; допуск — насколько похожие цвета тоже, мягкость — края
    o.keyColor = color(r.keyColor, '');
    o.keyTol = Math.round(num(r.keyTol, 0.01, 0.8, 0.15) * 100) / 100;
    o.keySoft = Math.round(num(r.keySoft, 0, 0.6, 0.08) * 100) / 100;
  }
  return o;
}

/** Список элементов; не больше MAX_ITEMS. */
function normItems(list) {
  return (Array.isArray(list) ? list : []).map(normItem).filter(Boolean).slice(0, MAX_ITEMS);
}

/** Шаблоны: [{id, name, items}] с уникальными id. */
function normTemplates(list) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').replace(/[^\w-]/g, '').slice(0, 24);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(t.name || 'Шаблон').trim().slice(0, 40) || 'Шаблон', items: normItems(t.items) });
  }
  return out.slice(0, 30);
}

/**
 * Элементы для ролика длиной dur секунд: шаблон + свои у момента. Те, что начинаются уже после конца, отбрасываются,
 * конец подрезается по длине.
 */
function itemsFor(template, own, dur) {
  const all = [...normItems(template), ...normItems(own)].slice(0, MAX_ITEMS);
  return all.filter((o) => o.start == null || o.start < dur - 0.2).map((o) => ({ ...o, end: o.end != null && o.end >= dur ? null : o.end }));
}

/** Ключ кэша картинки текста/плашки: меняется только вместе с тем, что видно на ней. */
function visualKey(o) {
  const pick = o.kind === 'text' || o.kind === 'plate'
    ? [o.kind, o.w, o.h, o.text, o.font, o.size, o.color, o.align, o.outline, o.bg, o.bgAlpha, o.radius]
    : [o.kind, o.path, o.w, o.keyColor, o.keyTol, o.keySoft];
  let h = 2166136261;
  for (const c of JSON.stringify(pick)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

const hex = (c) => `0x${c.slice(1)}`;
const boxPx = (o) => ({ w: Math.max(8, Math.round(o.w * OUT_W)), h: Math.max(8, Math.round((o.h || 0.1) * OUT_H)) });

/**
 * Аргументы ffmpeg: нарисовать текст/плашку в PNG (прозрачный фон, шрифт из fontsDir).
 * textFile — файл с текстом (так не нужно экранировать символы), out — PNG.
 */
function textPngArgs(o, { fontsDir, textFile, out }) {
  const { w, h } = boxPx(o);
  const font = FONTS[o.font] || FONTS.montserrat;
  const fontPath = `${String(fontsDir).replace(/[\\/]+$/, '')}/${font.file}`;
  const pad = Math.round(o.size * 0.35);
  const x = o.align === 'left' ? String(pad) : o.align === 'right' ? `w-text_w-${pad}` : '(w-text_w)/2';
  const bw = o.outline ? Math.max(2, Math.round(o.size / 14)) : 0;
  const dt = [
    `fontfile=${filterPath(fontPath)}`, `textfile=${filterPath(textFile)}`, `fontsize=${o.size}`, `fontcolor=${hex(o.color)}`,
    `x=${x}`, 'y=(h-text_h)/2', 'line_spacing=4',
    ...(bw ? [`borderw=${bw}`, 'bordercolor=0x000000'] : []),
  ].join(':');
  const base = o.bg ? `${hex(o.bg)}@${o.bgAlpha}` : '0x000000@0.0';
  let vf = `format=rgba,drawtext=${dt}`;
  if (o.bg && o.radius > 0) {
    const R = Math.min(o.radius, Math.floor(Math.min(w, h) / 2));
    vf += `,format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*lt(hypot(max(abs(X+0.5-W/2)-(W/2-${R}),0),max(abs(Y+0.5-H/2)-(H/2-${R}),0)),${R})',format=rgba`;
  }
  return ['-hide_banner', '-y', '-nostdin', '-f', 'lavfi', '-i', `color=c=${base}:s=${w}x${h}:r=1,format=rgba`, '-vf', vf, '-frames:v', '1', out];
}

/** Фильтр «сделать цвет прозрачным» (у наложения с keyColor); '' — фон не убирают. */
function keyFilter(o) {
  return o && o.keyColor ? `colorkey=${hex(o.keyColor)}:${o.keyTol}:${o.keySoft}` : '';
}

/**
 * WebM с прозрачностью штатный декодер ffmpeg читает без альфа-канала (фон выходит чёрным/серым): нужен libvpx-vp9.
 * libvpx — true, если такой декодер есть в сборке ffmpeg.
 */
function decoderArgs(o, libvpx) {
  return libvpx && /\.webm$/i.test(o.path || '') ? ['-c:v', 'libvpx-vp9'] : [];
}

/**
 * Первый кадр медиа как PNG нужной ширины (для предпросмотра). raw — без удаления фона (для пипетки: надо видеть,
 * какой цвет у фона на самом деле).
 */
function mediaPngArgs(o, out, { maxW = 540, raw = false, libvpx = false } = {}) {
  const w = Math.min(maxW, Math.max(8, Math.round(o.w * OUT_W)));
  const key = raw ? '' : keyFilter(o);
  return ['-hide_banner', '-y', '-nostdin', ...decoderArgs(o, libvpx), '-i', o.path, '-frames:v', '1', '-vf', `scale=${w}:-2,format=rgba${key ? `,${key}` : ''}`, out];
}

/** Первый кадр 64×64 как сырые RGBA-байты (для автоопределения цвета фона по углам). */
function rawFrameArgs(o, out, libvpx = false) {
  return ['-hide_banner', '-y', '-nostdin', ...decoderArgs(o, libvpx), '-i', o.path, '-frames:v', '1', '-vf', 'scale=64:64,format=rgba', '-f', 'rawvideo', out];
}

/**
 * Цвет фона по углам кадра 64×64 RGBA: среднее по четырём углам (по 3×3 пикселя).
 * Возвращает {color, same, transparent}: same — углы одного цвета (похоже на однотонный фон),
 * transparent — углы уже прозрачные (убирать нечего).
 */
function cornerColor(buf, w = 64, h = 64) {
  const at = (x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]; };
  const avg = (x0, y0) => {
    const s = [0, 0, 0, 0];
    for (let y = y0; y < y0 + 3; y++) for (let x = x0; x < x0 + 3; x++) at(x, y).forEach((v, k) => { s[k] += v; });
    return s.map((v) => v / 9);
  };
  const cs = [avg(0, 0), avg(w - 3, 0), avg(0, h - 3), avg(w - 3, h - 3)];
  const mean = [0, 1, 2, 3].map((k) => cs.reduce((a, c) => a + c[k], 0) / 4);
  const dist = Math.max(...cs.map((c) => Math.max(Math.abs(c[0] - mean[0]), Math.abs(c[1] - mean[1]), Math.abs(c[2] - mean[2]))));
  const h2 = (v) => Math.round(v).toString(16).padStart(2, '0');
  return { color: `#${h2(mean[0])}${h2(mean[1])}${h2(mean[2])}`, same: dist < 24, transparent: mean[3] < 40 };
}

/**
 * Часть графа фильтров: накладывает элементы на кадр vIn. items — после itemsFor, у каждого file (PNG для текста/плашки,
 * иначе path). firstInput — номер первого входного файла среди входов ffmpeg. Возвращает {inputs, filter, vLabel};
 * filter начинается с «;», пустой — если накладывать нечего.
 */
function overlayGraph(items, { vIn = '[vout]', firstInput = 1, vOut = '[vfin]' } = {}) {
  const list = (items || []).filter((o) => o.file || o.path);
  if (!list.length) return { inputs: [], filter: '', vLabel: vIn };
  const inputs = [], parts = [];
  let cur = vIn;
  list.forEach((o, j) => {
    const src = o.file || o.path;
    const live = o.kind === 'video';
    inputs.push(...(live ? ['-stream_loop', '-1', '-i', src] : ['-loop', '1', '-framerate', '30', '-i', src]));
    const k = firstInput + j;
    const dec = decoderArgs(o, o.libvpx);
    if (dec.length) inputs.splice(inputs.length - 2, 0, ...dec);   // перед «-i файл»
    const s = o.start == null ? 0 : o.start;
    const px = Math.round(o.x * OUT_W), py = Math.round(o.y * OUT_H);
    const media = o.kind === 'image' || o.kind === 'video';
    const w = Math.max(2, Math.round(o.w * OUT_W / 2) * 2);
    const chain = [`[${k}:v]format=rgba`];
    const kf = keyFilter(o);
    if (media && kf) chain.push(kf);
    if (media) chain.push(`scale=${w}:-2`); else chain.push('setsar=1');
    if (o.opacity < 1) chain.push(`colorchannelmixer=aa=${o.opacity}`);
    chain.push(`setpts=PTS-STARTPTS+${s}/TB`);
    if (o.fade > 0) {
      chain.push(`fade=t=in:st=${s}:d=${o.fade}:alpha=1`);
      if (o.end != null) chain.push(`fade=t=out:st=${Math.max(s, o.end - o.fade)}:d=${o.fade}:alpha=1`);
    }
    parts.push(`${chain.join(',')}[ov${j}]`);
    const out = j === list.length - 1 ? vOut : `[vo${j}]`;
    const en = o.start == null && o.end == null ? '' : `:enable='between(t,${s},${o.end == null ? 1e6 : o.end})'`;
    parts.push(`${cur}[ov${j}]overlay=x=${px}:y=${py}:shortest=1:format=auto${en}[${out.slice(1, -1)}]`);
    cur = out;
  });
  return { inputs, filter: `;${parts.join(';')}`, vLabel: vOut };
}

module.exports = { OUT_W, OUT_H, MAX_ITEMS, KINDS, FONTS, ALIGNS, mediaKind, newItem, normItem, normItems, normTemplates, itemsFor, visualKey, boxPx, textPngArgs, mediaPngArgs, rawFrameArgs, cornerColor, keyFilter, decoderArgs, overlayGraph };
