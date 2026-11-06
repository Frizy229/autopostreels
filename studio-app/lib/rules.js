'use strict';
const { CAM_LAYOUTS } = require('./layout');
// Правила конкурса нарезок: обязательные хэштег и ссылка на Twitch в описании и названии,
// стример должен говорить в отрезке (а не молча смотреть), у раскладок с вебкой должна быть рамка вебки.
// Проверить, что именно он «главное лицо», программа не может — это последняя галочка человека.

const DEFAULT_RULES = {
  hashtag: '#evelone',
  twitch: 'evelone2004',
  minSpeech: 0.25,   // доля времени отрезка, когда звучит речь
  minWords: 12,      // минимум слов в отрезке
  requireCam: true,
  requireOk: false,  // собирать только моменты, отмеченные «проверено»
};

const twitchLine = (r) => `twitch: ${r.twitch}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Хэштег целиком: #evelone2004 не считается за #evelone. */
const hasHashtag = (text, tag) => new RegExp(`(^|[\\s,.(])${escapeRe(tag.toLowerCase())}(?![\\wа-яё])`, 'i').test(String(text || '').toLowerCase());

/** Дописать в текст хэштег и ссылку на Twitch, если их нет. */
function ensureTags(text, rules = DEFAULT_RULES, { short = false } = {}) {
  let t = String(text || '').trim();
  const r = { ...DEFAULT_RULES, ...rules };
  const low = t.toLowerCase();
  const add = [];
  if (r.twitch && !low.includes(String(r.twitch).toLowerCase())) add.push(twitchLine(r));
  if (r.hashtag && !hasHashtag(t, r.hashtag)) add.push(r.hashtag);
  if (!add.length) return t;
  return t ? `${t}${short ? ' ' : '\n\n'}${add.join(' ')}` : add.join(' ');
}
/** Проверить текст: есть ли хэштег и ссылка. */
function checkTags(text, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...rules };
  const low = String(text || '').toLowerCase();
  const errs = [];
  if (r.twitch && !low.includes(String(r.twitch).toLowerCase())) errs.push(`нет «${twitchLine(r)}»`);
  if (r.hashtag && !hasHashtag(low, r.hashtag)) errs.push(`нет ${r.hashtag}`);
  return errs;
}

/** Доля речи и число слов в отрезке по словам whisper. */
function speechStats(words, start, end) {
  const len = Math.max(0.1, end - start);
  let talk = 0, n = 0;
  for (const w of words || []) {
    const s = Math.max(start, w.s), e = Math.min(end, w.e);
    if (e > s) { talk += e - s; n++; }
  }
  return { ratio: Math.min(1, talk / len), words: n, wpm: Math.round(n / (len / 60)) };
}

/**
 * Проверить момент. Возвращает {ok, issues: [текст], warn: [текст]}.
 * words: null, если речь не распознавалась (тогда только предупреждение).
 */
function checkMoment(m, { words, layout, hasCam, rules } = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  const issues = [], warn = [];
  if (words) {
    const st = speechStats(words, m.start, m.end);
    if (st.ratio < r.minSpeech || st.words < r.minWords) issues.push(`мало речи (${Math.round(st.ratio * 100)}%, ${st.words} слов): похоже, молча смотрит`);
  } else warn.push('речь не проверена (нет модели распознавания)');
  if (r.requireCam && CAM_LAYOUTS.includes(layout) && !hasCam) issues.push('не задана рамка вебки');
  if (r.requireOk && !m.ok) issues.push('не отмечен как «проверено»');
  return { ok: issues.length === 0, issues, warn };
}

module.exports = { hasHashtag, DEFAULT_RULES, ensureTags, checkTags, speechStats, checkMoment, twitchLine };
