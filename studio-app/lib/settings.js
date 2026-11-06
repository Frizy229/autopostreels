'use strict';
// Настройки приложения: значения по умолчанию и приведение к допустимым значениям.

const { LAYOUTS, FITS } = require('./layout');
const { SUB_STYLES, TITLE_STYLES } = require('./subs');
const { ENCODERS } = require('./render');
const { MODELS } = require('./transcribe');
const { DEFAULT_RULES } = require('./rules');
const { BROWSERS, COOKIE_MODES, FILLER_QUERIES, parseQueryLine, NET_MODES } = require('./sources');

const DEFAULTS = {
  theme: 'dark', material: 'acrylic',
  // каналы: сколько каналов, столько уникальных нарезок на выходе (у каждого свои ролики)
  channels: [{ name: 'evelon185' }, { name: 'channel2' }, { name: 'channel3' }],
  perChannel: 7,
  minLen: 20, maxLen: 60,
  layout: 'stream', split: 0.4,
  fit: 'fit',            // видео в раскладках с вебкой: fit — целиком по ширине (без обрезки), fill — заполнить с обрезкой краёв
  // раскладки и стили субтитров по кругу: канал 1 — первая, канал 2 — вторая...
  formats: ['stream', 'filler', 'full', 'camfull'],
  subStyles: ['stream', 'neon', 'ice', 'sunset', 'pink', 'yellow'],
  fillerDir: '',         // папка с мини-играми/фоновыми роликами для раскладки «стрим сверху, игра снизу»
  fillerQueries: FILLER_QUERIES,  // быстрые запросы в разделе «Фон»: «Название = запрос»
  fillerCC: false,       // искать фон только под лицензией Creative Commons
  subStyle: 'stream', titleStyle: 'glow_blue', maxWords: 3, titleDur: 0, subsOn: true,
  vary: true, allowMirror: false, allowSpeed: true,
  lang: 'ru', whisperModel: 'large-v3-turbo', gpu: true,
  encoder: 'nvenc', quality: 'best', loudnorm: true, fps: 30,
  outputDir: '', lane: 'queue',
  autoSend: true,        // после сборки сразу отдать папку виджету автопостера (он загрузит её в очередь)
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
  // вход в YouTube для yt-dlp: auto — при «докажи, что не бот» пробовать cookies браузеров
  cookies: { mode: 'auto', browser: 'firefox', file: '' },
  // сеть для yt-dlp: system — прокси/VPN из Windows (если есть), manual — свой адрес, none — напрямую
  net: { mode: 'system', proxy: '' },
};

const MAX_CHANNELS = 60;
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
  const fq = (Array.isArray(s.fillerQueries) ? s.fillerQueries : String(s.fillerQueries || '').split(/\r?\n/))
    .map((l) => String(l || '').trim()).filter((l) => parseQueryLine(l)).slice(0, 40);
  s.fillerQueries = fq.length ? fq : [...FILLER_QUERIES];
  s.fillerCC = !!s.fillerCC;
  let ch = Array.isArray(s.channels) ? s.channels : [];
  ch = ch.slice(0, MAX_CHANNELS).map((c, i) => {
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
  s.fit = pick(s.fit, FITS, 'fit');
  s.subStyle = pick(s.subStyle, SUB_STYLES, DEFAULTS.subStyle);
  s.titleStyle = pick(s.titleStyle, TITLE_STYLES, DEFAULTS.titleStyle);
  s.encoder = pick(s.encoder, ENCODERS, 'cpu');
  s.quality = s.quality === 'fast' ? 'fast' : 'best';
  s.whisperModel = pick(s.whisperModel, MODELS, DEFAULTS.whisperModel);
  s.lane = pick(s.lane, LANES, 'queue');
  s.lang = /^[a-z]{2}$|^auto$/.test(s.lang) ? s.lang : 'ru';
  s.theme = pick(s.theme, { dark: 1, light: 1, system: 1 }, 'dark');
  s.searchMinMin = num(s.searchMinMin, 0, 600, DEFAULTS.searchMinMin);
  for (const k of ['vary', 'allowMirror', 'allowSpeed', 'gpu', 'loudnorm', 'subsOn', 'autoSend']) s[k] = !!s[k];
  const ck = { ...DEFAULTS.cookies, ...((raw && raw.cookies && typeof raw.cookies === 'object') ? raw.cookies : {}) };
  s.cookies = { mode: pick(ck.mode, COOKIE_MODES, 'auto'), browser: pick(ck.browser, BROWSERS, 'firefox'), file: typeof ck.file === 'string' ? ck.file : '' };
  if (s.cookies.mode === 'file' && !s.cookies.file) s.cookies.mode = 'auto';
  const nt = { ...DEFAULTS.net, ...((raw && raw.net && typeof raw.net === 'object') ? raw.net : {}) };
  s.net = { mode: pick(nt.mode, NET_MODES, 'system'), proxy: typeof nt.proxy === 'string' ? nt.proxy.trim().slice(0, 200) : '' };
  if (!s.presets || typeof s.presets !== 'object') s.presets = {};
  return s;
}

module.exports = { DEFAULTS, LANES, MAX_CHANNELS, normalize };
