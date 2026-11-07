'use strict';
// Оценка моментов без нейросетей и ключей: отсев мусора (чёрный экран, замершая картинка, музыка без речи)
// и поиск «смешного» по признакам (смех в речи, реакция чата, громкость). Всё чистое: на входе числа и слова.

const stat = (arr) => {
  const n = arr.length || 1;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  return { mean, std: Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) };
};

/**
 * Ровность звука отрезка [start, end]: у речи, смеха и крика громкость скачет (std большой, есть паузы),
 * у музыки и шума она ровная. env — громкость в dB по окнам winSec.
 */
function flatness(env, winSec, start, end) {
  const a = Math.max(0, Math.floor(start / winSec)), b = Math.min(env.length, Math.ceil(end / winSec));
  const seg = env.slice(a, Math.max(a + 1, b)).filter((v) => v > -90);
  if (seg.length < 4) return { std: 0, dips: 0, level: -100 };
  const { mean, std } = stat(seg);
  const dips = seg.filter((v) => v < mean - 6).length / seg.length;   // доля «провалов» (паузы между словами)
  return { std: Math.round(std * 10) / 10, dips: Math.round(dips * 100) / 100, level: Math.round(mean) };
}

// смех, как его пишет распознавание: «ха-ха-ха», «ахах», «хех», «хы», «ору», «ржу», «угар»…
const LAUGH_WORD = /^(?:[аоэ]?х[аеиыо]+(?:-?х?[аеиыо]+)*х*|[аоэ]х[ах]+\w*|лол\w*|кек\w*|ору|ржу\w*|ржач\w*|ржа\w*|угар\w*|смешн\w*|пха\w*)$/i;

const clean = (w) => String(w || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}-]/gu, '').replace(/^-+|-+$/g, '');

/** Сколько «смеха» в словах отрезка: «ха-ха-ха-ха» считается за несколько (до 5). */
function laughStats(words, start, end) {
  let laughs = 0, n = 0;
  for (const w of words || []) {
    if (w.e < start || w.s > end) continue;
    n++;
    const t = clean(w.w);
    if (!t || !LAUGH_WORD.test(t)) continue;
    laughs += Math.max(1, Math.min(5, (t.match(/х/g) || []).length));
  }
  return { laughs, words: n };
}

// что whisper «слышит» на музыке и тишине: подписи и «спасибо за просмотр» из обучающих данных
const HALLUCINATION = /субтитры (?:сделал|создавал|подготовил)|редактор субтитров|корректор [а-я]\.|продолжение следует|спасибо за (?:просмотр|внимание)|подписывайтесь на (?:канал|мой)|dimatorzok|amara\.org|thanks for watching/i;

/** Распознавание на музыке выдаёт мусор: известные подписи или одно слово подряд. */
function hallucinated(words) {
  const ws = (words || []).map((w) => clean(w.w)).filter(Boolean);
  if (!ws.length) return false;
  if (HALLUCINATION.test(ws.join(' '))) return true;
  if (ws.length >= 8) {
    const top = Object.values(ws.reduce((m, w) => { m[w] = (m[w] || 0) + 1; return m; }, {})).sort((x, y) => y - x)[0];
    if (top / ws.length >= 0.7) return true;      // «да да да да да…» на ровном звуке
  }
  return false;
}

/** Доля речи и число слов (как speechStats в rules.js, но без зависимости от него). */
function speech(words, start, end) {
  const len = Math.max(0.1, end - start);
  let talk = 0, n = 0;
  for (const w of words || []) {
    const s = Math.max(start, w.s), e = Math.min(end, w.e);
    if (e > s) { talk += e - s; n++; }
  }
  return { ratio: Math.min(1, talk / len), words: n };
}

/**
 * Разбор вывода ffmpeg blackdetect + freezedetect: какая доля отрезка чёрная и какая замерла.
 * stderr — текст ffmpeg, dur — длина отрезка в секундах.
 */
function parseVisual(stderr, dur) {
  const text = String(stderr || '');
  let black = 0, frozen = 0, m;
  const bre = /black_duration:\s*([\d.]+)/g, fre = /freeze_duration:\s*([\d.]+)/g;
  while ((m = bre.exec(text))) black += parseFloat(m[1]);
  while ((m = fre.exec(text))) frozen += parseFloat(m[1]);
  const d = Math.max(0.1, dur);
  // если картинка замерла до самого конца, ffmpeg пишет только freeze_start без длительности
  const starts = [...text.matchAll(/freeze_start:\s*([\d.]+)/g)].map((x) => parseFloat(x[1]));
  const ends = (text.match(/freeze_duration:/g) || []).length;
  if (starts.length > ends) frozen += Math.max(0, d - starts[starts.length - 1]);
  return { black: Math.min(1, Math.round(black / d * 100) / 100), frozen: Math.min(1, Math.round(frozen / d * 100) / 100) };
}

/** Аргументы ffmpeg для проверки картинки отрезка: чёрный кадр и замершая картинка (звук не нужен). */
function visualArgs(input, { start = null, dur = null } = {}) {
  const a = ['-hide_banner', '-nostdin'];
  if (start != null) a.push('-ss', String(start));
  if (dur != null) a.push('-t', String(dur));
  a.push('-i', input, '-an', '-vf', 'scale=320:-2,blackdetect=d=0.5:pix_th=0.12,freezedetect=n=-55dB:d=2', '-f', 'null', '-');
  return a;
}

const LIMITS = { black: 0.4, frozen: 0.6, minWords: 5, minRatio: 0.1, flatStd: 1.8 };

/**
 * Итог по моменту. ctx: {env, winSec, words (null — речь не слушали), visual ({black, frozen} или null),
 * tags ({music, laugh, applause} из подписей whisper), minWords}.
 * Возвращает {junk: причина или '', warn: [текст], why: [текст: за что ценим], bonus: число к оценке, flat}.
 */
function judgeMoment(m, ctx = {}) {
  const why = [], warn = [];
  const flat = ctx.env ? flatness(ctx.env, ctx.winSec || 0.5, m.start, m.end) : null;
  const sp = ctx.words ? speech(ctx.words, m.start, m.end) : null;
  const lg = ctx.words ? laughStats(ctx.words, m.start, m.end) : { laughs: 0, words: 0 };
  const tags = ctx.tags || {};
  let junk = '';
  const v = ctx.visual;
  if (v && v.black >= LIMITS.black) junk = `чёрный экран (${Math.round(v.black * 100)}% отрезка)`;
  else if (v && v.frozen >= LIMITS.frozen) junk = `картинка замерла (${Math.round(v.frozen * 100)}%): стрим завис или заставка`;
  else if (ctx.words) {
    const minW = ctx.minWords ?? LIMITS.minWords;
    if (hallucinated(ctx.words)) junk = 'музыка или шум без речи';
    else if (sp.words < minW || sp.ratio < LIMITS.minRatio) junk = `нет речи (${sp.words} слов): музыка или шум`;
    else if (flat && flat.std < LIMITS.flatStd && flat.dips < 0.05 && !lg.laughs) junk = 'ровный звук без пауз, похоже на музыку';
  } else if (flat && flat.std < LIMITS.flatStd && flat.dips < 0.03) warn.push('ровный звук: возможно, музыка (речь не слушали)');
  if (v && v.black >= 0.15 && !junk) warn.push(`чёрный экран ${Math.round(v.black * 100)}%`);
  if (v && v.frozen >= 0.3 && !junk) warn.push(`картинка стоит ${Math.round(v.frozen * 100)}%`);

  let bonus = 0;
  if (!junk) {
    if (lg.laughs >= 2) { bonus += Math.min(8, lg.laughs) * 0.25; why.push(`смех в речи ×${lg.laughs}`); }
    if (tags.laugh) { bonus += 0.5; why.push('смех в записи'); }
    if (tags.applause) { bonus += 0.2; why.push('аплодисменты'); }
    if (sp && sp.ratio >= 0.5 && sp.words >= 15) { bonus += 0.3; why.push(`речь ${Math.round(sp.ratio * 100)}%`); }
    if (flat && flat.dips >= 0.1 && flat.std >= 4) { bonus += 0.15; why.push('громкость скачет'); }
    if (tags.music && sp && sp.words < 15) bonus -= 0.3;
  }
  return { junk, warn, why, bonus: Math.round(bonus * 100) / 100, flat, laughs: lg.laughs };
}

/** Начало речи отрезка одной строкой (для списка моментов). */
function excerpt(words, start, end, max = 120) {
  const t = (words || []).filter((w) => w.e >= start && w.s <= end).map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

module.exports = { LIMITS, LAUGH_WORD, flatness, laughStats, hallucinated, speech, parseVisual, visualArgs, judgeMoment, excerpt };
