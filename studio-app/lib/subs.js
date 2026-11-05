'use strict';
// Субтитры ASS: слова → группы по 1–3 слова, текущее слово подсвечено, заголовок на стыке кадра.
// Всё чистое и проверяется тестами; ffmpeg рисует файл фильтром ass (libass) нашими шрифтами из assets/fonts.

const { OUT_W, OUT_H } = require('./layout');

/** Стили субтитров. Цвета — #RRGGBB. Шрифты лежат в assets/fonts (имя семейства как внутри файла). */
const SUB_STYLES = {
  stream: { name: 'Стрим', font: 'Montserrat Black', italic: false, size: 92, color: '#FFFFFF', active: '#FFE433',
    outline: '#000000', bord: 7, shadow: 3, glow: null, upper: true, pop: true },
  neon: { name: 'Неон', font: 'Montserrat Black', italic: true, size: 96, color: '#FFFFFF', active: '#7CFF3A',
    outline: '#0B0B0B', bord: 6, shadow: 0, glow: '#3BFF6E', upper: true, pop: true },
  ice: { name: 'Лёд', font: 'Montserrat Black', italic: true, size: 94, color: '#FFFFFF', active: '#5AB4FF',
    outline: '#06142B', bord: 6, shadow: 0, glow: '#2E8BFF', upper: true, pop: true },
  bold: { name: 'Жирный', font: 'Unbounded Black', italic: false, size: 74, color: '#FFFFFF', active: '#FF4D4D',
    outline: '#000000', bord: 8, shadow: 4, glow: null, upper: true, pop: true },
  clean: { name: 'Чистый', font: 'Rubik Black', italic: false, size: 80, color: '#FFFFFF', active: '#FFFFFF',
    outline: '#000000', bord: 5, shadow: 2, glow: null, upper: false, pop: false },
  sunset: { name: 'Закат', font: 'Montserrat Black', italic: false, size: 90, color: '#FFFFFF', active: '#FF9F1C',
    outline: '#1A0E00', bord: 6, shadow: 4, glow: null, upper: true, pop: true },
  pink: { name: 'Розовый', font: 'Montserrat Black', italic: true, size: 92, color: '#FFFFFF', active: '#FF5CA8',
    outline: '#22000F', bord: 6, shadow: 0, glow: '#FF2E8A', upper: true, pop: true },
  yellow: { name: 'Жёлтый', font: 'Rubik Black', italic: false, size: 86, color: '#FFE600', active: '#FFFFFF',
    outline: '#000000', bord: 7, shadow: 3, glow: null, upper: true, pop: true },
  box: { name: 'Плашка', font: 'Rubik Black', italic: false, size: 74, color: '#FFFFFF', active: '#FFD43B',
    outline: '#000000', bord: 14, shadow: 0, glow: null, upper: false, pop: false, box: '#000000', boxAlpha: 70 },
  russo: { name: 'Русский шрифт', font: 'Russo One', italic: false, size: 88, color: '#FFFFFF', active: '#39E5FF',
    outline: '#001A22', bord: 6, shadow: 3, glow: null, upper: true, pop: true },
};

/** Заголовок: первая строка белая, вторая цветная со свечением (как «КОНТРАТАКА / ХОРОШАЯ»). */
const TITLE_STYLES = {
  glow_blue: { name: 'Синее свечение', font: 'Montserrat Black', italic: true, size: 110, line1: '#FFFFFF', line2: '#4F8BFF', glow: '#2F6BFF', outline: '#0A0F1F' },
  glow_red: { name: 'Красное', font: 'Montserrat Black', italic: true, size: 110, line1: '#FFFFFF', line2: '#FF3B3B', glow: '#FF1E1E', outline: '#1F0A0A' },
  plain: { name: 'Плашка', font: 'Rubik Black', italic: false, size: 76, line1: '#FFFFFF', line2: '#FFFFFF', glow: null, outline: '#000000', box: '#000000' },
  none: { name: 'Без заголовка' },
};

/** '#RRGGBB' → '&H00BBGGRR' (формат цвета ASS). */
function assColor(hex, alpha = 0) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const h = m ? m[1].toUpperCase() : 'FFFFFF';
  const a = Math.max(0, Math.min(255, alpha)).toString(16).toUpperCase().padStart(2, '0');
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

/** Цвет для тега внутри текста: \\1c&HBBGGRR& (без альфы, с закрывающим &). */
function tagColor(hex) { return `&H${assColor(hex).slice(4)}&`; }

/** Время ASS: H:MM:SS.cc */
function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Текст для ASS: фигурные скобки и обратный слеш ломают теги, переносы → \N. */
function assText(t) {
  return String(t || '').replace(/\\/g, '⧵').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').replace(/\s+/g, ' ').trim();
}

const PUNCT_END = /[.!?…]$/;

/** Размер шрифта, чтобы строка влезла в ширину кадра (оценка ширины жирных заглавных ≈ 0.66 кегля на символ). */
function fitSize(text, size, maxW = OUT_W - 90, k = 0.66) {
  const len = String(text || '').length || 1;
  return Math.max(36, Math.min(size, Math.floor(maxW / (len * k))));
}

/**
 * Группы слов для показа. words: [{w, s, e}] (секунды). Новая группа при: maxWords, maxChars,
 * паузе больше maxGap, конце предложения.
 */
function chunkWords(words, opt = {}) {
  const maxWords = opt.maxWords || 3, maxChars = opt.maxChars || 18, maxGap = opt.maxGap ?? 0.6;
  const out = [];
  let cur = null;
  for (const raw of words || []) {
    const w = { w: String(raw.w || '').trim(), s: +raw.s, e: +raw.e };
    if (!w.w || !(w.e >= w.s)) continue;
    const len = cur ? cur.words.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length : 0;
    const prev = cur && cur.words[cur.words.length - 1];
    if (!cur || cur.words.length >= maxWords || len > maxChars || w.s - cur.e > maxGap || PUNCT_END.test(prev.w)) {
      cur = { words: [], s: w.s, e: w.e };
      out.push(cur);
    }
    cur.words.push(w);
    cur.e = Math.max(cur.e, w.e);
  }
  // держим группу на экране до следующей (без мигания), но не дольше +0.5 с
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    const hold = next ? Math.min(next.s, out[i].e + 0.5) : out[i].e + 0.3;
    out[i].e = Math.max(out[i].e, hold);
  }
  return out;
}

/** Разбить заголовок на 2 строки: по «|» или переносу, иначе по середине по символам. */
function splitTitle(title) {
  const t = String(title || '').trim();
  if (!t) return [];
  const explicit = t.split(/\s*(?:\||\n)\s*/).filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, 2);
  const words = t.split(/\s+/);
  if (words.length < 2 || t.length <= 12) return [t];
  let best = 1, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length, b = words.slice(i).join(' ').length;
    const d = Math.abs(a - b);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

function styleLine(name, f) {
  // Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  return `Style: ${name},${f.font},${f.size},${assColor(f.color)},${assColor(f.color)},${assColor(f.outline, f.outlineAlpha || 0)},${assColor(f.back || '#000000', f.backAlpha ?? 96)},` +
    `0,${f.italic ? -1 : 0},0,0,100,100,${f.spacing || 0},0,${f.borderStyle || 1},${f.bord},${f.shadow},5,40,40,0,1`;
}

/**
 * Собрать ASS.
 * o: words (время от начала исходника), clipStart, clipEnd, speed, style (ключ SUB_STYLES или объект),
 *    title, titleStyle, titleDur (0 = весь ролик), anchors {titleY, subsY}, maxWords.
 */
function buildAss(o) {
  const st = typeof o.style === 'object' ? o.style : (SUB_STYLES[o.style] || SUB_STYLES.stream);
  const ts = typeof o.titleStyle === 'object' ? o.titleStyle : (TITLE_STYLES[o.titleStyle] || TITLE_STYLES.glow_blue);
  const speed = o.speed || 1;
  const clipStart = o.clipStart || 0;
  const dur = ((o.clipEnd ?? Infinity) - clipStart) / speed;
  const rel = (t) => (t - clipStart) / speed;
  const anchors = o.anchors || { titleY: 768, subsY: 1400 };
  const x = OUT_W / 2;

  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${OUT_W}`, `PlayResY: ${OUT_H}`, 'WrapStyle: 2',
    'ScaledBorderAndShadow: yes', 'YCbCr Matrix: TV.709', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine('Sub', st.box ? { ...st, outline: st.box, outlineAlpha: st.boxAlpha ?? 80, borderStyle: 3, back: st.box, backAlpha: st.boxAlpha ?? 80, shadow: 0 } : { ...st, back: '#000000', backAlpha: 128 }),
  ];
  if (ts.font) {
    head.push(styleLine('Title', { font: ts.font, size: ts.size, italic: ts.italic, color: ts.line1, outline: ts.outline,
      bord: ts.box ? 18 : 7, shadow: ts.box ? 0 : 2, borderStyle: ts.box ? 3 : 1, back: ts.box || '#000000', backAlpha: ts.box ? 0 : 96 }));
  }
  head.push('', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');
  const ev = [];
  const push = (layer, s, e, style, text) => {
    if (e <= s) return;
    ev.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},${style},,0,0,0,,${text}`);
  };

  // заголовок
  const lines = splitTitle(o.title);
  if (ts.font && lines.length) {
    const tEnd = o.titleDur > 0 ? Math.min(dur, o.titleDur) : (Number.isFinite(dur) ? dur : 3600);
    const tSize = Math.min(...lines.map((ln) => fitSize(ln, Math.round(ts.size * 1.15))));
    const lh = Math.round(tSize * 0.98);
    const y0 = anchors.titleY - (lines.length === 2 ? lh / 2 : 0);
    lines.forEach((ln, i) => {
      const y = Math.round(y0 + i * lh);
      const txt = assText(ln).toUpperCase();
      const col = i === 0 ? ts.line1 : ts.line2;
      if (ts.glow && (i === 1 || lines.length === 1)) {
        push(0, 0, tEnd, 'Title', `{\\an5\\pos(${x},${y})\\fs${tSize}\\bord16\\blur12\\3c${tagColor(ts.glow)}\\1a&HFF&\\shad0}${txt}`);
      }
      push(1, 0, tEnd, 'Title', `{\\an5\\pos(${x},${y})\\fs${tSize}\\1c${tagColor(col)}\\fad(120,0)}${txt}`);
    });
  }

  // субтитры
  const chunks = chunkWords((o.words || []).filter((w) => w.e > clipStart && w.s < (o.clipEnd ?? Infinity)), { maxWords: o.maxWords });
  const y = anchors.subsY;
  for (const c of chunks) {
    const words = c.words.map((w) => (st.upper ? assText(w.w).toUpperCase() : assText(w.w)));
    const fs = fitSize(words.join(' '), st.size, OUT_W - 110, st.font.startsWith('Unbounded') ? 0.82 : 0.66);
    const fsTag = fs < st.size ? `\\fs${fs}` : '';
    for (let i = 0; i < c.words.length; i++) {
      const s = rel(i === 0 ? c.s : c.words[i].s);
      const e = rel(i + 1 < c.words.length ? c.words[i + 1].s : c.e);
      const s0 = Math.max(0, s), e0 = Math.min(dur, e);
      const pop = st.pop && i === 0 ? '\\fscx118\\fscy118\\t(0,90,\\fscx100\\fscy100)' : '';
      const body = words.map((w, j) => (j === i && st.active !== st.color ? `{\\1c${tagColor(st.active)}}${w}{\\1c${tagColor(st.color)}}` : w)).join(' ');
      if (st.glow) push(0, s0, e0, 'Sub', `{\\an5\\pos(${x},${y})${fsTag}${pop}\\bord${st.bord + 10}\\blur10\\3c${tagColor(st.glow)}\\1a&HFF&\\shad0}${words.join(' ')}`);
      push(1, s0, e0, 'Sub', `{\\an5\\pos(${x},${y})${fsTag}${pop}}${body}`);
    }
  }
  return head.concat(ev).join('\n') + '\n';
}

module.exports = { tagColor, fitSize, SUB_STYLES, TITLE_STYLES, assColor, assTime, assText, chunkWords, splitTitle, buildAss };
