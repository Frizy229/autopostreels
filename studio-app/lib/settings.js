'use strict';
// Настройки приложения: значения по умолчанию и приведение к допустимым значениям.

const { LAYOUTS } = require('./layout');
const { SUB_STYLES, TITLE_STYLES } = require('./subs');
const { ENCODERS } = require('./render');
const { MODELS } = require('./transcribe');
const { DEFAULT_RULES } = require('./rules');

const DEFAULTS = {
  theme: 'dark', material: 'acrylic',
  // каналы: сколько каналов, столько уникальных нарезок на выходе (у каждого свои ролики)
  channels: [{ name: 'evelon185' }, { name: 'channel2' }, { name: 'channel3' }],
  perChannel: 7,
  minLen: 20, maxLen: 60,
  layout: 'stream', split: 0.4,
  // раскладки и стили субтитров по кругу: канал 1 — первая, канал 2 — вторая...
  formats: ['stream', 'filler', 'full', 'camfull'],
  subStyles: ['stream', 'neon', 'ice', 'sunset', 'pink', 'yellow'],
  fillerDir: '',         // папка с мини-играми/фоновыми роликами для раскладки «стрим сверху, игра снизу»
  subStyle: 'stream', titleStyle: 'glow_blue', maxWords: 3, titleDur: 0, subsOn: true,
  vary: true, allowMirror: false, allowSpeed: true,
  lang: 'ru', whisperModel: 'large-v3-turbo', gpu: true,
  encoder: 'nvenc', quality: 'best', loudnorm: true, fps: 30,
  outputDir: '', lane: 'queue',
  texts: {
    captionInstagram: '{title}\n\ntwitch: evelone2004\n{hashtags}',
    captionTiktok: '{title} twitch: evelone2004 {hashtags}',
    hashtags: '#evelone #evelone2004 #эвелон #fyp',
    defaultTitle: 'Эвелон на стриме',  // для подписи, если у момента нет заголовка (на экране тогда без заголовка)
    comment: '',
    footer: '',
    source: '',
  },
  rules: { ...DEFAULT_RULES },
  presets: {},           // рамки вебки/контента по стримерам: { "evelone2004": {cam, content, layout} }
  searchMinMin: 20,      // поиск лонгов: от N минут
};

const LANES = { queue: 'Общая очередь (все сети)', 'queue-instagram': 'Только Instagram', 'queue-tiktok': 'Только TikTok' };

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const pick = (v, obj, d) => (Object.prototype.hasOwnProperty.call(obj, v) ? v : d);

function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  s.texts = { ...DEFAULTS.texts, ...((raw && raw.texts) || {}) };
  s.rules = { ...DEFAULT_RULES, ...((raw && raw.rules) || {}) };
  s.rules.minSpeech = num(s.rules.minSpeech, 0, 1, DEFAULT_RULES.minSpeech);
  s.rules.minWords = Math.round(num(s.rules.minWords, 0, 500, DEFAULT_RULES.minWords));
  s.rules.requireCam = !!s.rules.requireCam; s.rules.requireOk = !!s.rules.requireOk;
  const fm = (Array.isArray(s.formats) ? s.formats : []).filter((f) => LAYOUTS[f]);
  s.formats = fm.length ? [...new Set(fm)] : [s.layout || 'stream'];
  const ss = (Array.isArray(s.subStyles) ? s.subStyles : []).filter((f) => SUB_STYLES[f]);
  s.subStyles = ss.length ? [...new Set(ss)] : ['stream'];
  s.fillerDir = typeof s.fillerDir === 'string' ? s.fillerDir : '';
  let ch = Array.isArray(s.channels) ? s.channels : [];
  ch = ch.slice(0, 20).map((c, i) => {
    const o = typeof c === 'string' ? { name: c } : (c && typeof c === 'object' ? c : {});
    return { ...o, name: String(o.name || '').trim().replace(/^@+/, '') || `channel${i + 1}` };
  });
  if (!ch.length) ch = [{ name: 'channel1' }];
  s.channels = ch;
  s.perChannel = Math.round(num(s.perChannel, 1, 20, DEFAULTS.perChannel));
  s.minLen = num(s.minLen, 5, 170, DEFAULTS.minLen);
  s.maxLen = Math.max(s.minLen, num(s.maxLen, 5, 180, DEFAULTS.maxLen));
  s.split = num(s.split, 0.2, 0.6, DEFAULTS.split);
  s.maxWords = Math.round(num(s.maxWords, 1, 6, DEFAULTS.maxWords));
  s.titleDur = num(s.titleDur, 0, 60, 0);
  s.fps = pick(String(s.fps), { 30: 1, 60: 1 }, '30') | 0;
  s.layout = pick(s.layout, LAYOUTS, DEFAULTS.layout);
  s.subStyle = pick(s.subStyle, SUB_STYLES, DEFAULTS.subStyle);
  s.titleStyle = pick(s.titleStyle, TITLE_STYLES, DEFAULTS.titleStyle);
  s.encoder = pick(s.encoder, ENCODERS, 'cpu');
  s.quality = s.quality === 'fast' ? 'fast' : 'best';
  s.whisperModel = pick(s.whisperModel, MODELS, DEFAULTS.whisperModel);
  s.lane = pick(s.lane, LANES, 'queue');
  s.lang = /^[a-z]{2}$|^auto$/.test(s.lang) ? s.lang : 'ru';
  s.theme = pick(s.theme, { dark: 1, light: 1, system: 1 }, 'dark');
  s.searchMinMin = num(s.searchMinMin, 0, 600, DEFAULTS.searchMinMin);
  for (const k of ['vary', 'allowMirror', 'allowSpeed', 'gpu', 'loudnorm', 'subsOn']) s[k] = !!s[k];
  if (!s.presets || typeof s.presets !== 'object') s.presets = {};
  return s;
}

module.exports = { DEFAULTS, LANES, normalize };
