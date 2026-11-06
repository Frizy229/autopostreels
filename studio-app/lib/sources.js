'use strict';
// Источники: ссылки YouTube/Twitch и файлы с диска. Здесь только аргументы yt-dlp и разбор его ответа,
// запуск — в tools.js. Для длинных стримов сначала качается только звук (поиск моментов),
// потом видео лишь нужных отрезков (--download-sections), а не все 3 часа.

const VIDEO_EXT = /\.(mp4|mkv|mov|webm|avi|flv|ts)$/i;

function platformOf(url) {
  const u = String(url || '').toLowerCase();
  if (/twitch\.tv/.test(u)) return 'twitch';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/kick\.com/.test(u)) return 'kick';
  if (/vkvideo\.ru|vk\.com\/video/.test(u)) return 'vk';
  if (/^https?:\/\//.test(u)) return 'web';
  if (VIDEO_EXT.test(u)) return 'file';
  return null;
}
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());

/** Запрос → что передать yt-dlp: ссылка как есть, иначе поиск YouTube. */
function searchTarget(q, limit = 20) {
  const s = String(q || '').trim();
  if (isUrl(s)) return s;
  return `ytsearch${limit}:${s}`;
}

/** Список видео (поиск, канал, плейлист) без скачивания. */
function listArgs(q, limit = 20) {
  const target = searchTarget(q, limit);
  const a = ['--flat-playlist', '-J', '--no-warnings', '--ignore-errors'];
  if (isUrl(target)) a.push('--playlist-end', String(limit));
  a.push(target);
  return a;
}

/** Канал Twitch → список записей стримов. */
function channelUrl(input) {
  const s = String(input || '').trim();
  const tw = /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([\w]+)\/?$/i.exec(s);
  if (tw) return `https://www.twitch.tv/${tw[1]}/videos?filter=archives&sort=time`;
  const yt = /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(@[\w.-]+)\/?$/i.exec(s);
  if (yt) return `https://www.youtube.com/${yt[1]}/videos`;
  return s;
}

function normEntry(e) {
  const url = e.webpage_url || e.url || (e.id ? (e.ie_key === 'Youtube' || /^[\w-]{11}$/.test(e.id) ? `https://www.youtube.com/watch?v=${e.id}` : e.id) : '');
  const thumbs = Array.isArray(e.thumbnails) ? e.thumbnails : [];
  const thumb = e.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : '');
  return {
    id: String(e.id || url),
    title: e.title || '(без названия)',
    url,
    duration: Number(e.duration) || 0,
    channel: e.channel || e.uploader || '',
    views: Number(e.view_count) || 0,
    thumb,
    date: e.upload_date || (e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '') : ''),
    platform: platformOf(url) || 'web',
  };
}

/** Разбор `yt-dlp -J`: одиночное видео или плейлист. */
function parseList(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o) return [];
  const entries = Array.isArray(o.entries) ? o.entries : [o];
  return entries.filter((e) => e && (e.id || e.url)).map(normEntry);
}

/** Сортировка/фильтр найденного: длинные видео (лонги) — от minDur секунд. */
function filterLongs(list, { minDur = 0, sort = 'views' } = {}) {
  const out = list.filter((e) => !minDur || !e.duration || e.duration >= minDur);
  if (sort === 'views') out.sort((a, b) => b.views - a.views);
  else if (sort === 'date') out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  else if (sort === 'duration') out.sort((a, b) => b.duration - a.duration);
  return out;
}

/** Скачивание. o: audioOnly, sections [[start,end]], maxHeight, out (шаблон пути), chat. */
function downloadArgs(url, o = {}) {
  const a = ['--no-warnings', '--newline', '--no-playlist', '--progress', '-o', o.out || '%(id)s.%(ext)s'];
  if (o.ffmpeg) a.push('--ffmpeg-location', o.ffmpeg);
  // звук как есть, без перекодирования (раньше -x --audio-format m4a: долгая обработка 3-часового стрима без прогресса)
  if (o.audioOnly) a.push('-f', 'ba[ext=m4a]/ba/b');
  else if (o.videoOnly) a.push('-f', `bv*[height<=${o.maxHeight || 1080}][ext=mp4]/bv*[height<=${o.maxHeight || 1080}]/b[height<=${o.maxHeight || 1080}]`);
  else {
    const h = o.maxHeight || 1080;
    a.push('-f', `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4');
  }
  for (const [s, e] of o.sections || []) a.push('--download-sections', `*${s}-${e}`);
  if (o.sections && o.sections.length) a.push('--force-keyframes-at-cuts');
  if (o.chat) a.push('--write-subs', '--sub-langs', 'live_chat,rechat', '--skip-download');
  a.push(url);
  return a;
}

/** Что yt-dlp делает сейчас (строки без процентов): для подписи под полосой. null — не интересно. */
function statusOf(line) {
  const l = String(line || '');
  if (/^\[download\]\s+[\d.]+%/.test(l)) return null;
  if (/^\[(ExtractAudio|FFmpegExtractAudio)\]/.test(l)) return 'Перевожу звук';
  if (/^\[(Merger|VideoConvertor|FixupM3u8|FixupM4a|FixupDuplicateMoov|FixupTimestamp)\]/.test(l)) return 'Склеиваю файл';
  if (/^\[download\] Destination/.test(l)) return 'Скачиваю';
  if (/^\[(youtube|twitch|info)[^\]]*\]/i.test(l)) return 'Получаю данные видео';
  if (/^WARNING:/i.test(l)) return l.replace(/^WARNING:\s*/i, 'yt-dlp: ').slice(0, 120);
  return null;
}

/** Прогресс из строки yt-dlp: «[download]  42.3% of ...» → 0.423. */
function parseProgress(line) {
  const m = /\[download\]\s+([\d.]+)%/.exec(line);
  return m ? Math.min(1, parseFloat(m[1]) / 100) : null;
}

// ------------------------------------------------------------------ вход в YouTube (cookies)
// YouTube всё чаще отвечает «Sign in to confirm you're not a bot». Тогда yt-dlp нужны cookies браузера,
// в котором выполнен вход в YouTube, или файл cookies.txt. Twitch, Kick, VK и файлы с диска идут без cookies.

const BROWSERS = { firefox: 'Firefox', edge: 'Edge', chrome: 'Chrome', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', chromium: 'Chromium' };
// Firefox первым: cookies Chrome/Edge на Windows зашифрованы привязкой к приложению и часто не читаются
const AUTO_BROWSERS = ['firefox', 'edge', 'chrome', 'brave', 'opera', 'vivaldi'];
const COOKIE_MODES = { auto: 'Автоматически', none: 'Без входа', browser: 'Из браузера', file: 'Файл cookies.txt' };

/** Нужны ли cookies для этой цели yt-dlp: только YouTube и поиск YouTube. */
function needsAuth(target) {
  const t = String(target || '');
  return /^ytsearch\d*:/i.test(t) || platformOf(t) === 'youtube';
}

/** Аргументы yt-dlp для одного способа входа: null — без cookies. */
function cookieArgs(auth) {
  if (!auth) return [];
  if (auth.file) return ['--cookies', auth.file];
  if (auth.browser) return ['--cookies-from-browser', auth.browser];
  return [];
}

/**
 * Способы входа по очереди. auto: сначала без cookies, при проверке «не бот» — браузеры по одному;
 * browser/file: выбранный способ, а если cookies не прочитались — ещё раз без них. Не YouTube — всегда без cookies.
 */
function authPlan(cfg, target) {
  if (!needsAuth(target)) return [null];
  const c = cfg || {};
  if (c.mode === 'none') return [null];
  if (c.mode === 'file' && c.file) return [{ file: c.file }, null];
  if (c.mode === 'browser' && BROWSERS[c.browser]) return [{ browser: c.browser }, null];
  return [null, ...AUTO_BROWSERS.map((b) => ({ browser: b }))];
}

/** YouTube просит войти: проверка «не бот», возраст, вход. */
const isAuthError = (text) => /sign in to confirm|not a bot|use --cookies|--cookies-from-browser|login required|sign in to view|confirm your age|age[- ]restricted/i.test(String(text || ''));
/** Cookies не прочитались: нет браузера/профиля, база занята открытым браузером, шифрование Chrome/Edge. */
const isCookieError = (text) => /cookies? database|could not find .*(browser|profile|cookies)|failed to decrypt|decrypt.*cookie|dpapi|app.?bound|could not copy .*cookie|permission denied.*cookie|cookies? file|does not look like a netscape/i.test(String(text || ''));

const authName = (a) => (!a ? 'без входа' : a.file ? 'файл cookies.txt' : `cookies ${BROWSERS[a.browser] || a.browser}`);

/** Что сказать человеку, когда YouTube не пустил ни одним способом. */
function authHelp(tried) {
  const list = (tried || []).map(authName).join(', ');
  return 'YouTube просит подтвердить, что ты не бот.\n'
    + 'Что сделать: войди в YouTube в Firefox (лучше всего) или в Edge/Chrome, закрой этот браузер и повтори. '
    + 'Либо выбери браузер или файл cookies.txt в Настройках → «Вход в YouTube».'
    + (list ? `\nПробовал: ${list}.` : '')
    + '\nЗаписи Twitch и файлы с диска работают без входа.';
}

// ------------------------------------------------------------------ фон: залипательные видео и мини-игры
// Для нижней половины раскладки «стрим сверху, мини-игра снизу». Звук фона в ролик не идёт, поэтому качается только видео.

const FILLER_QUERIES = [
  'Чистка ковров = carpet cleaning satisfying',
  'Ржавое как новое = rusty restoration satisfying',
  'Грязное в чистое = dirty to clean satisfying',
  'Мойка давлением = pressure washing satisfying',
  'Слаймы = slime asmr satisfying',
  'Кинетический песок = kinetic sand cutting asmr',
  'Резка мыла = soap cutting asmr',
  'Гидропресс = hydraulic press satisfying',
  'Марбл ран = marble run satisfying',
  'Мобильные мини-игры = satisfying mobile games gameplay',
  'Subway Surfers = subway surfers gameplay no copyright',
  'Minecraft паркур = minecraft parkour gameplay no copyright',
];

/** Строка запроса «Название = запрос» (или просто «запрос») → {t, q}. */
function parseQueryLine(line) {
  const s = String(line || '').trim();
  if (!s) return null;
  const i = s.indexOf('=');
  if (i < 0) return { t: s, q: s };
  const t = s.slice(0, i).trim(), q = s.slice(i + 1).trim();
  return q ? { t: t || q, q } : null;
}

/** Поиск фона: ссылка как есть; иначе поиск YouTube, с cc — только видео под лицензией Creative Commons. */
function fillerTarget(q, { cc = false, limit = 30 } = {}) {
  const s = String(q || '').trim();
  if (isUrl(s)) return s;
  if (cc) return `https://www.youtube.com/results?search_query=${encodeURIComponent(s)}&sp=EgIwAQ%3D%3D`;
  return `ytsearch${limit}:${s}`;
}

/** Из найденного — то, что годится в фон: от 20 с, без трансляций; сначала самые просматриваемые. */
function filterFillers(list, { minDur = 20 } = {}) {
  return list.filter((e) => e.url && (!e.duration || e.duration >= minDur)).sort((a, b) => b.views - a.views);
}

/** Скачать фон: только видео до 1080p; длинное — первые maxSec секунд (фон всё равно идёт по кругу). */
function fillerDownloadArgs(url, { out, ffmpeg, duration = 0, maxSec = 600 } = {}) {
  const a = downloadArgs(url, { videoOnly: true, out, ffmpeg });
  if (duration > maxSec + 60) a.splice(a.length - 1, 0, '--download-sections', `*0-${maxSec}`);
  return a;
}

module.exports = { VIDEO_EXT, platformOf, isUrl, searchTarget, listArgs, channelUrl, parseList, filterLongs, downloadArgs, parseProgress, normEntry, statusOf,
  FILLER_QUERIES, parseQueryLine, fillerTarget, filterFillers, fillerDownloadArgs,
  BROWSERS, AUTO_BROWSERS, COOKIE_MODES, needsAuth, cookieArgs, authPlan, isAuthError, isCookieError, authName, authHelp };
