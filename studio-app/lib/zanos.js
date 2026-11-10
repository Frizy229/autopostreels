'use strict';
// «Заносы» в казино-стримах: большой выигрыш по ставке (иксы). Без нейросетей на входе только числа, слова и текст с экрана.
// Признаки: иксы и суммы на экране (OCR), счётчик выигрыша растёт, слова («занос», «макс вин», «тысяча иксов»), всплеск громкости
// после затишья, реакция чата, оценка нейросети. Момент берётся с подводкой (вращение, ожидание) и концовкой (итог и реакция),
// границы подтягиваются к паузам в речи, чтобы не резать на полуслове. Пустые вращения и дубли отсеиваются.

const { median } = require('./moments');

const BANNER = /\b(MAX|MEGA|EPIC|SUPER|ULTRA|GIANT|HUGE|BIG)\s?WIN\b/i;
const BANNER_TOP = /^(MAX|MEGA|EPIC|SUPER|ULTRA|GIANT)$/i;
const BONUS = /\bFREE\s?SPINS?\b|\bBONUS\b|\bBONUSGAME\b/i;
const CURRENCY = /(?:₽|₸|\$|€|\b(?:RUB|RUR|USD|EUR|KZT|P|РУБ\w*|Р)\b)/i;

/** Число из куска OCR: «1 250 000», «5>000», «1,250», «2.5» → число; мусор между цифрами убирается. */
function parseNumber(str) {
  const t = String(str || '').trim();
  if (/^\d{1,3}(?:[ .,'>:]\d{3})+$/.test(t)) return parseInt(t.replace(/\D/g, ''), 10);
  if (/^\d+[.,]\d{1,2}$/.test(t)) return parseFloat(t.replace(',', '.'));
  const d = t.replace(/\D/g, '');
  return d ? parseInt(d, 10) : NaN;
}

/** Что написано на кадре: максимальный множитель (x1250), сумма, плашка «MEGA WIN», бонус. */
function parseScreen(text) {
  const raw = String(text || '').replace(/[Хх×]/g, 'x');
  const mults = [];
  const take = (re) => {
    for (const m of raw.matchAll(re)) {
      const v = parseNumber(m[1]);
      if (v >= 2 && v <= 500000) mults.push(v);
    }
  };
  take(/(?<![A-Za-z0-9])x\s?(\d[\d .,'>:]{0,10}\d|\d)(?![A-Za-z])/gi);
  take(/(?<![\d.,])(\d[\d .,'>:]{0,10}\d|\d)\s?x(?![A-Za-z0-9])/gi);
  // суммы: с валютой рядом или длинные числа с разрядами; множители не считаем
  const noMult = raw.replace(/(?<![A-Za-z0-9])x\s?\d[\d .,'>:]{0,10}\d?/gi, ' ');
  const amounts = [];
  for (const m of noMult.matchAll(/\d{1,3}(?:[ .,'>:]\d{3})+(?:[.,]\d{1,2})?|\d{5,}/g)) {
    const v = parseNumber(m[0].replace(/[.,]\d{1,2}$/, ''));
    const near = noMult.slice(Math.max(0, m.index - 4), m.index + m[0].length + 6);
    const groups = (m[0].match(/[ .,'>:]\d{3}/g) || []).length;
    if (v >= 1000 && (CURRENCY.test(near) || groups >= 2 || v >= 100000)) amounts.push(v);
  }
  const b = BANNER.exec(raw.replace(/\s+/g, ' '));
  const bannerWord = b ? b[1].toUpperCase() : '';
  return {
    mults, amounts, banner: bannerWord ? (BANNER_TOP.test(bannerWord) ? 'top' : 'big') : '', bannerWord,
    bonus: BONUS.test(raw),
  };
}

/**
 * Сводка по кадрам окна [{t, text}]: множитель принимается, если виден минимум на двух кадрах (одиночная
 * ошибка распознавания не считается) или рядом плашка WIN; счётчик выигрыша «растёт» — сумма по кадрам
 * не убывает и вырастает минимум втрое.
 */
function screenSummary(frames) {
  const parsed = (frames || []).map((f) => ({ t: f.t, ...parseScreen(f.text) }));
  const seen = new Map();
  for (const p of parsed) for (const v of new Set(p.mults)) seen.set(v, (seen.get(v) || 0) + 1);
  const bannerAt = parsed.filter((p) => p.banner);
  let mult = 0;
  for (const p of parsed) {
    for (const v of p.mults) {
      if ((seen.get(v) >= 2 || p.banner) && v > mult) mult = v;
    }
  }
  const amt = parsed.filter((p) => p.amounts.length).map((p) => ({ t: p.t, v: Math.max(...p.amounts) }));
  let rising = false, from = 0, to = 0;
  if (amt.length >= 3) {
    // допускаем одну-две ошибки распознавания: ищем самую длинную неубывающую цепочку
    const best = amt.reduce((chain, cur) => {
      const ext = chain.filter((c) => c[c.length - 1].v <= cur.v).sort((a, b) => b.length - a.length)[0];
      return [...chain, [...(ext || []), cur]];
    }, []).sort((a, b) => b.length - a.length)[0];
    if (best.length >= 3 && best[best.length - 1].v >= best[0].v * 3) { rising = true; from = best[0].v; to = best[best.length - 1].v; }
  }
  const amount = amt.length ? Math.max(...amt.map((a) => a.v)) : 0;
  const bigFrames = parsed.filter((p) => p.banner || p.mults.some((v) => v >= 100 && (seen.get(v) >= 2)));
  return {
    mult, amount, rising, from, to,
    banner: bannerAt.some((p) => p.banner === 'top') ? 'top' : (bannerAt.length ? 'big' : ''),
    bannerWord: (bannerAt[0] || {}).bannerWord || '',
    bonus: parsed.some((p) => p.bonus),
    firstBigT: bigFrames.length ? bigFrames[0].t : null,
    lastBigT: bigFrames.length ? bigFrames[bigFrames.length - 1].t : null,
    frames: parsed.length,
  };
}

// ------------------------------------------------------------------ речь
const clean = (w) => String(w || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}-]/gu, '');

const STRONG = [
  [/занос/, 'занос'], [/макс[- ]?вин|максимал[а-яё]* выигрыш/, 'макс вин'], [/(?:мега|биг|эпик|супер)[- ]?вин/, 'мега вин'],
  [/тысяч[а-яё]* иксов|иксов тысяч|тыщ[а-яё]* иксов/, 'тысячи иксов'], [/миллион/, 'миллион'], [/иксы|иксов|икс(?![а-яё])/, 'иксы'],
  [/выпал[а-яё]* бонус|бонуск|бонус ?ка/, 'бонуска'],
];
const MEDIUM = [
  [/офигет|охренеть|ничего себе|не может быть|не верю|жесть|лют[а-яё]+|имба|ебат[а-яё]+|пиздец|вот это да|вау/, 'реакция'],
  [/давай-?давай|ну давай|дава[а-яё]+ дава[а-яё]+|умоляю|пожалуйста/, 'ожидание'],
  [/ставк[а-яё]+ (?:в )?[а-яё]+ раз|перебор|забрал|заберу|кэшаут|кешаут/, 'ставка'],
];

/** Слова отрезка → {strong, medium, mult (названный вслух множитель), text}. */
function speechSignals(words, start, end) {
  const ws = (words || []).filter((w) => w.e >= start && w.s <= end);
  const text = ws.map((w) => clean(w.w)).filter(Boolean).join(' ');
  const strong = [], medium = [];
  for (const [re, name] of STRONG) if (re.test(text)) strong.push(name);
  for (const [re, name] of MEDIUM) if (re.test(text)) medium.push(name);
  let mult = 0;
  const digits = [...text.matchAll(/(?:x|х)-?(\d{2,6})|(\d{2,6}) ?(?:иксов|икс|x)/g)].map((m) => parseInt(m[1] || m[2], 10));
  for (const d of digits) if (d > mult) mult = d;
  const spoken = /(?:сто|двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|тысяч[а-яё]*|тыщ[а-яё]*) (?:иксов|икс)/.exec(text);
  if (spoken && !mult) mult = /тысяч|тыщ/.test(spoken[0]) ? 1000 : 100;
  return { strong, medium, mult, words: ws.length, text };
}

// ------------------------------------------------------------------ громкость
/**
 * Форма громкости вокруг пика: насколько пик выше «фона» перед ним (rise, дБ), сколько секунд держится выше фона+8 дБ
 * (sustain), и был ли подъём (buildUp: тихо или ровно → резкий рост, а не сплошной крик).
 */
function loudShape(env, winSec, start, end, focus = null) {
  const a = Math.max(0, Math.floor(start / winSec)), b = Math.min(env.length, Math.ceil(end / winSec));
  const seg = env.slice(a, Math.max(a + 1, b)).map((v) => (v > -90 ? v : -90));
  if (seg.length < 6) return { rise: 0, sustain: 0, peakT: (start + end) / 2, endT: end, base: -100, buildUp: false };
  const third = Math.max(2, Math.floor(seg.length / 3));
  const base = median(seg.slice(0, third));
  // focus: [t0, t1] — искать пик только там (в окне кандидата бывает соседний, более громкий крик)
  const fa = focus ? Math.max(0, Math.floor(focus[0] / winSec) - a) : 0, fb = focus ? Math.min(seg.length - 1, Math.ceil(focus[1] / winSec) - a) : seg.length - 1;
  let pi = Math.min(fa, seg.length - 1);
  for (let i = fa; i <= fb; i++) if (seg[i] > seg[pi]) pi = i;
  const peak = seg[pi];
  const rise = peak - base;
  const thr = base + 8;
  const allow = Math.round(2 / winSec);
  let lo = pi, hi = pi, gap = 0;
  for (let j = pi - 1; j >= 0; j--) { if (seg[j] >= thr) { lo = j; gap = 0; } else if (++gap > allow) break; }
  gap = 0;
  for (let j = pi + 1; j < seg.length; j++) { if (seg[j] >= thr) { hi = j; gap = 0; } else if (++gap > allow) break; }
  const sustain = Math.max(0, (hi - lo + 1) * winSec);
  const before = seg.slice(Math.max(0, pi - Math.round(8 / winSec)), pi);
  const buildUp = before.length > 4 && median(before) < peak - 6;
  return { rise: Math.round(rise * 10) / 10, sustain: Math.round(sustain * 10) / 10, peakT: (a + pi) * winSec, endT: (a + hi) * winSec, base: Math.round(base), buildUp };
}

/** Во сколько раз сообщений чата вокруг пика больше обычного (чат отстаёт на секунды: берём [-4, +14] с). */
function chatBurst(chat, peakT, total) {
  if (!chat || chat.length < 20 || !total) return 1;
  const near = chat.filter((t) => t >= peakT - 4 && t <= peakT + 14).length;
  const rate = chat.length / total * 18;
  return rate > 0 ? Math.round(near / rate * 10) / 10 : 1;
}

// ------------------------------------------------------------------ оценка
const MULT_TIERS = [[5000, 5], [2000, 4.2], [1000, 3.6], [500, 3], [200, 2.2], [100, 1.5], [50, 0.8]];
const tierOf = (m) => (MULT_TIERS.find(([x]) => m >= x) || [0, 0])[1];
const fmtNum = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Итог по кандидату. sig: {screen (screenSummary или null), speech (speechSignals), loud (loudShape), chat (кратность), llm (0–10 или null)}.
 * Возвращает {score, hard, qualifies, why: [текст], reject: причина}.
 * «Жёсткий» признак — то, чего у пустого вращения нет: большой иск на экране, плашка WIN, растущий счётчик, иксы словами
 * или крик с ключевыми словами/высокой оценкой нейросети.
 */
function zanosScore(sig) {
  const sc = sig.screen, sp = sig.speech || { strong: [], medium: [], mult: 0 }, ld = sig.loud || { rise: 0, sustain: 0, buildUp: false };
  const why = [];
  let score = 0, hard = false;
  const mult = Math.max(sc ? sc.mult : 0, sp.mult || 0);
  if (sc && sc.mult >= 50) { score += tierOf(sc.mult); why.push(`на экране x${fmtNum(sc.mult)}`); }
  else if (sp.mult >= 100) { score += Math.min(tierOf(sp.mult), 2.2); why.push(`иксы вслух: ~x${fmtNum(sp.mult)}`); }
  if (mult >= 100) hard = true;
  if (sc && sc.banner) { score += sc.banner === 'top' ? 1.5 : 0.8; why.push(sc.bannerWord ? `плашка ${sc.bannerWord} WIN` : 'плашка WIN'); if (sc.banner === 'top') hard = true; }
  if (sc && sc.rising) { score += 1.5 + (sc.to >= 1e6 ? 0.5 : 0); why.push(`счётчик вырос ${fmtNum(sc.from)} → ${fmtNum(sc.to)}`); hard = true; }
  else if (sc && sc.amount >= 100000) { score += 0.6; why.push(`сумма ${fmtNum(sc.amount)}`); }
  if (sc && sc.bonus) { score += 0.3; why.push('бонуска'); }
  if (sp.strong.length) { score += Math.min(3, sp.strong.length) * 0.9; why.push(`слова: ${sp.strong.slice(0, 3).join(', ')}`); }
  if (sp.medium.length) score += Math.min(4, sp.medium.length) * 0.3;
  if (ld.rise >= 12 && ld.sustain >= 3) { score += 1.2; why.push(`громкость +${Math.round(ld.rise)} дБ`); } else if (ld.rise >= 8) { score += 0.6; why.push(`громкость +${Math.round(ld.rise)} дБ`); }
  if (ld.buildUp && ld.rise >= 8) score += 0.4;
  if (sig.chat >= 3) { score += 0.6; why.push(`чат ×${sig.chat}`); } else if (sig.chat >= 2) { score += 0.3; why.push(`чат ×${sig.chat}`); }
  if (sig.llm != null) { score += (sig.llm - 5) * 0.35; why.push(`нейросеть: занос ${sig.llm}/10`); }
  if (sp.strong.length && ld.rise >= 8) hard = true;
  if (sig.llm != null && sig.llm >= 8 && ld.rise >= 6) hard = true;
  score = Math.round(score * 100) / 100;
  const qualifies = hard && score >= 2.5;
  let reject = '';
  if (!qualifies) {
    if (!hard) reject = 'пустое вращение: нет ни больших иксов на экране, ни слов о заносе, ни крика';
    else reject = `слабый занос (оценка ${score})`;
  }
  return { score, hard, qualifies, why, reject, mult };
}

// ------------------------------------------------------------------ границы
const GAP = 0.35;

/** Конец ближайшей паузы в речи не позже t и не раньше t-back: начало момента по паузе, а не по слову. */
function snapStart(words, t, back = 4) {
  const ws = (words || []).slice().sort((a, b) => a.s - b.s);
  let best = null;
  for (let i = 0; i < ws.length - 1; i++) {
    const gapStart = ws[i].e, gapEnd = ws[i + 1].s;
    if (gapEnd - gapStart >= GAP && gapEnd <= t + 0.01 && gapEnd >= t - back) best = Math.max(best == null ? -1 : best, gapEnd - 0.15);
  }
  // t внутри слова: сдвигаем на начало слова, если паузы нет
  if (best == null) { const w = ws.find((x) => x.s < t && x.e > t); if (w) return Math.max(0, w.s - 0.2); return t; }
  return Math.max(0, best);
}

/** Конец ближайшей паузы после t (в пределах forward): момент заканчивается после фразы, а не посреди слова. */
function snapEnd(words, t, forward = 5, total = Infinity) {
  const ws = (words || []).slice().sort((a, b) => a.s - b.s);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], next = ws[i + 1];
    if (w.e < t) continue;
    if (w.s <= t && w.e >= t) { if (!next || next.s - w.e >= GAP) return Math.min(total, w.e + 0.4); continue; }
    if (!next || next.s - w.e >= GAP) { if (w.e - t <= forward) return Math.min(total, w.e + 0.4); break; }
  }
  return Math.min(total, t);
}

/**
 * Границы занос-момента вокруг пика. Подводка lead секунд до пика (вращение, ожидание), концовка — пока держится крик
 * и ещё tail секунд (итог, реакция), но не меньше 8 с после пика. Длина minLen..maxLen. Границы идут по паузам речи.
 * o: {peakT, endT (где кончилась громкость), lastBigT (последний кадр с иксами), total, minLen, maxLen, lead, tail}.
 */
function bounds(words, o) {
  const minLen = o.minLen || 20, maxLen = Math.max(minLen, o.maxLen || 60), total = o.total || Infinity;
  const lead = o.lead ?? 14, tail = o.tail ?? 5;
  let start = Math.max(0, o.peakT - lead);
  let end = Math.max(o.peakT + 8, (o.endT || 0) + tail, (o.lastBigT != null ? o.lastBigT + tail : 0));
  end = Math.min(total, end);
  if (end - start > maxLen) {
    // сначала подводка до 8 с, потом хвост: пик и итог важнее долгого вступления
    start = Math.max(start, Math.min(o.peakT - 8, end - maxLen));
    if (end - start > maxLen) end = start + maxLen;
  }
  if (end - start < minLen) { start = Math.max(0, end - minLen); end = Math.min(total, Math.max(end, start + minLen)); }
  start = snapStart(words, start, 4);
  end = snapEnd(words, end, 5, total);
  if (end - start > maxLen + 4) end = Math.min(total, snapStart(words, start + maxLen, 6) || start + maxLen);
  if (end - start < minLen) end = Math.min(total, start + minLen);
  return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
}

/** Убрать дубли: сильнейший остаётся, остальные, что пересекаются с ним или пик ближе gap секунд, помечаются. */
function dedupe(list, gap = 30) {
  const keep = [], dups = [];
  for (const m of list.slice().sort((a, b) => b.score - a.score)) {
    const over = keep.find((k) => Math.abs(k.peak - m.peak) < gap || (Math.min(k.end, m.end) - Math.max(k.start, m.start)) / Math.max(1, m.end - m.start) > 0.3);
    if (over) dups.push({ m, of: over }); else keep.push(m);
  }
  return { keep, dups };
}

module.exports = { parseNumber, parseScreen, screenSummary, speechSignals, loudShape, chatBurst, zanosScore, bounds, snapStart, snapEnd, dedupe, fmtNum, MULT_TIERS };
