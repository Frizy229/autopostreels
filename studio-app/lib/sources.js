'use strict';
// Источники: ссылки YouTube/Twitch/Instagram Reels и файлы с диска. Здесь только аргументы yt-dlp и разбор его ответа,
// запуск — в tools.js. Для длинных стримов сначала качается только звук (поиск моментов),
// потом видео лишь нужных отрезков (--download-sections), а не все 3 часа.

const VIDEO_EXT = /\.(mp4|mkv|mov|webm|avi|flv|ts)$/i;

function platformOf(url) {
  const u = String(url || '').toLowerCase();
  if (/twitch\.tv/.test(u)) return 'twitch';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/kick\.com/.test(u)) return 'kick';
  if (/vkvideo\.ru|vk\.com\/video/.test(u)) return 'vk';
  if (/^https?:\/\//.test(u)) return 'web';
  if (VIDEO_EXT.test(u)) return 'file';
  return null;
}
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());

/** Все ссылки из вставленного текста (через пробел, запятую или с новой строки), без повторов. */
function parseLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s,;"'<>]+/gi)) {
    const u = m[0].replace(/[).,]+$/, '');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Профиль Instagram целиком (не рилс): yt-dlp его не скачивает, нужны ссылки на сами рилсы. */
const isInstagramProfile = (url) => /instagram\.com\/(?!reels?\/|p\/|tv\/|stories\/)[\w.]+\/?(reels\/?)?(\?.*)?$/i.test(String(url || ''));

/** Короткий источник (рилс, клип до 10 минут): качается целиком один раз, а не кусками. */
const SHORT_SEC = 600;
const isShortSource = (src) => !!src && src.kind === 'url' && src.duration > 0 && src.duration <= SHORT_SEC;

/** Запрос → что передать yt-dlp: ссылка как есть, иначе поиск YouTube. */
function searchTarget(q, limit = 20) {
  const s = String(q || '').trim();
  if (isUrl(s)) return s;
  return ytResultsUrl(s);
}

/**
 * Поиск YouTube через страницу результатов youtube.com/results (как в браузере). Раньше был `ytsearchN:`,
 * но у Alex он возвращал пустую выдачу, а страница результатов (фильтр Creative Commons) работала.
 * sp — фильтр YouTube: EgIwAQ== — только Creative Commons.
 */
function ytResultsUrl(q, sp) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(String(q || '').trim())}${sp ? `&sp=${encodeURIComponent(sp)}` : ''}`;
}

/** Список видео (поиск, канал, плейлист) без скачивания. start — с какого по счёту (для «Показать ещё»). */
function listArgs(q, limit = 20, start = 1) {
  const target = searchTarget(q, limit);
  const a = ['--flat-playlist', '-J', '--no-warnings', '--ignore-errors'];
  if (isUrl(target) && start > 1) a.push('--playlist-start', String(start));
  if (isUrl(target)) a.push('--playlist-end', String(start - 1 + limit));
  a.push(target);
  return a;
}

// ------------------------------------------------------------------ поиск в Twitch
// Открытого поиска по видео у Twitch без ключей API нет. Поэтому программа берёт списки записей, хайлайтов
// и клипов нужных каналов (yt-dlp, как кнопка «Записи стримов Twitch») и отбирает их по словам запроса.

/** Что смотреть у канала: записи стримов, хайлайты, клипы за всё время (самые просматриваемые). */
function twitchTargets(channel) {
  const c = String(channel || '').trim().toLowerCase();
  return [
    { kind: 'vod', url: `https://www.twitch.tv/${c}/videos?filter=archives&sort=time` },
    { kind: 'highlight', url: `https://www.twitch.tv/${c}/videos?filter=highlights&sort=views` },
    { kind: 'clip', url: `https://www.twitch.tv/${c}/clips?filter=clips&range=all` },
  ];
}

const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/**
 * Насколько название подходит к запросу: доля слов запроса, которые есть в названии (начало слова тоже считается:
 * «казино» найдёт «казиношка»). Пустой запрос — всё подходит (1).
 */
function matchScore(title, q) {
  const qw = words(q);
  if (!qw.length) return 1;
  const tw = words(title);
  return qw.filter((w) => tw.some((t) => t.startsWith(w) || (w.length > 4 && t.startsWith(w.slice(0, -1))))).length / qw.length;
}

/** Отбор видео Twitch по запросу: сначала самые подходящие, потом по просмотрам. */
function filterByQuery(list, q) {
  return list.map((e) => ({ e, s: matchScore(`${e.title} ${e.channel}`, q) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.e.views - a.e.views).map((x) => x.e);
}

/**
 * Общая выдача YouTube + Twitch. Клипы Twitch короткие по природе: фильтр «от N минут» к ним не относится.
 * По просмотрам — источники через один (у YouTube просмотров на порядки больше, иначе Twitch уходит в самый низ,
 * а внутри Twitch порядок «сначала подходящие по словам»); по дате и длине — общий порядок.
 */
function mergeResults(list, { minDur = 0, sort = 'views' } = {}) {
  // клипы Twitch и рилсы короткие по природе: фильтр «от N минут» к ним не относится
  const ok = list.filter((e) => e.kind === 'clip' || e.platform === 'instagram' || !minDur || !e.duration || e.duration >= minDur);
  if (sort !== 'views') return filterLongs(ok, { sort });
  const groups = [
    filterLongs(ok.filter((e) => e.platform !== 'twitch' && e.platform !== 'instagram'), { sort: 'views' }),
    ok.filter((e) => e.platform === 'twitch'),
    ok.filter((e) => e.platform === 'instagram'),
  ];
  const out = [];
  for (let i = 0; i < Math.max(...groups.map((g) => g.length)); i++) for (const g of groups) if (g[i]) out.push(g[i]);
  return out;
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
// в котором выполнен вход в YouTube, или файл cookies.txt. Instagram без входа часто не отдаёт рилсы — те же cookies.
// Twitch, Kick, VK и файлы с диска идут без cookies.

const BROWSERS = { firefox: 'Firefox', edge: 'Edge', chrome: 'Chrome', brave: 'Brave', opera: 'Opera', vivaldi: 'Vivaldi', chromium: 'Chromium' };
// Firefox первым: cookies Chrome/Edge на Windows зашифрованы привязкой к приложению и часто не читаются
const AUTO_BROWSERS = ['firefox', 'edge', 'chrome', 'brave', 'opera', 'vivaldi'];
const COOKIE_MODES = { auto: 'Автоматически', none: 'Без входа', browser: 'Из браузера', file: 'Файл cookies.txt' };

/** Нужны ли cookies для этой цели yt-dlp: YouTube (и его поиск) и Instagram. */
function needsAuth(target) {
  const t = String(target || '');
  return /^ytsearch\d*:/i.test(t) || ['youtube', 'instagram'].includes(platformOf(t));
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
const isAuthError = (text) => /sign in to confirm|not a bot|use --cookies|--cookies-from-browser|login required|sign in to view|confirm your age|age[- ]restricted|rate-?limit reached|requested content is not available|restricted video|unable to extract shared data/i.test(String(text || ''));
/** Cookies не прочитались: нет браузера/профиля, база занята открытым браузером, шифрование Chrome/Edge. */
const isCookieError = (text) => /cookies? database|could not find .*(browser|profile|cookies)|failed to decrypt|decrypt.*cookie|dpapi|app.?bound|could not copy .*cookie|permission denied.*cookie|cookies? file|does not look like a netscape/i.test(String(text || ''));

/** Почему cookies этого браузера не помогли (по тексту ошибки yt-dlp). */
function cookieWhy(stderr, auth) {
  const t = String(stderr || '');
  if (!auth) return 'без входа YouTube просит подтвердить, что ты не бот';
  if (/failed to decrypt|decrypt.*cookie|dpapi|app.?bound/i.test(t)) return 'Windows не даёт прочитать cookies (Edge/Chrome шифруют их), используй Firefox или файл cookies.txt';
  if (/could not find .*(browser|profile|cookies)|no such file/i.test(t)) return 'браузер или его профиль не найден';
  if (/could not copy .*cookie|permission denied|database is locked|cookies? database/i.test(t)) return 'файл cookies занят: закрой этот браузер полностью (и в трее) и повтори';
  if (isAuthError(t)) return 'cookies прочитались, но вход в YouTube в этом браузере не выполнен или устарел';
  return 'cookies не помогли';
}

const authName = (a) => (!a ? 'без входа' : a.file ? 'файл cookies.txt' : `cookies ${BROWSERS[a.browser] || a.browser}`);

/** Что сказать человеку, когда сайт не пустил ни одним способом. target — для Instagram свой текст. */
function authHelp(tried, target = '', notes = []) {
  const list = (tried || []).map(authName).join(', ');
  const detail = (tried || []).map((a, i) => (notes && notes[i] ? `• ${authName(a)}: ${notes[i]}` : '')).filter(Boolean).join('\n');
  if (platformOf(target) === 'instagram') {
    return 'Instagram не отдаёт этот рилс без входа (или рилс закрыт, удалён, аккаунт приватный).\n'
      + 'Что сделать: войди в Instagram в Firefox (лучше всего) или в Edge/Chrome, закрой этот браузер и повтори. '
      + 'Либо выбери браузер или файл cookies.txt в Настройках → «Вход на сайты».'
      + (detail ? `\nПробовал:\n${detail}` : (list ? `\nПробовал: ${list}.` : ''))
      + '\nЕсли качаешь много рилсов подряд, Instagram может временно ограничить скачивание: подожди 10–20 минут.';
  }
  return 'YouTube просит подтвердить, что ты не бот.\n'
    + 'Что сделать: войди в YouTube в Firefox (лучше всего) или в Edge/Chrome, закрой этот браузер и повтори. '
    + 'Либо выбери браузер или файл cookies.txt в Настройках → «Вход на сайты».'
    + (detail ? `\nПробовал:\n${detail}` : (list ? `\nПробовал: ${list}.` : ''))
    + '\nСамый надёжный способ: расширение «Get cookies.txt LOCALLY» в браузере → выгрузить cookies youtube.com → Настройки → «Вход на сайты» → «Файл cookies.txt».'
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
  return ytResultsUrl(s, cc ? 'EgIwAQ==' : '');
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

// ------------------------------------------------------------------ сеть: прокси и недоступный YouTube
const NET_MODES = { system: 'Как в Windows (VPN, системный прокси)', manual: 'Свой прокси', none: 'Без прокси' };

/** Ответ Electron resolveProxy («PROXY h:p; DIRECT», «SOCKS5 h:p») → адрес для yt-dlp --proxy или ''. */
function proxyFromPac(pac) {
  for (const part of String(pac || '').split(';')) {
    const m = /^\s*(PROXY|HTTPS|HTTP|SOCKS5|SOCKS4|SOCKS)\s+([^\s;]+)\s*$/i.exec(part);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    const scheme = kind === 'SOCKS4' ? 'socks4' : kind.startsWith('SOCKS') ? 'socks5' : kind === 'HTTPS' ? 'https' : 'http';
    return `${scheme}://${m[2]}`;
  }
  return '';
}

/** Свой прокси из поля настроек: «127.0.0.1:1080» → http://…; socks5/socks4/http/https оставляем как есть. '' — неверно. */
function normProxy(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^(socks5h?|socks4a?|https?):\/\/[^\s/]+(:\d+)?\/?$/i.test(t)) return t.replace(/\/$/, '');
  if (/^[\w.-]+:\d{2,5}$/.test(t)) return `http://${t}`;
  return '';
}

/** Аргументы прокси для yt-dlp: net {mode, proxy}, sys — найденный системный прокси. */
function proxyArgs(net, sys) {
  const n = net || {};
  if (n.mode === 'none') return ['--proxy', ''];
  if (n.mode === 'manual') { const p = normProxy(n.proxy); return p ? ['--proxy', p] : []; }
  return sys ? ['--proxy', sys] : [];
}

/** Нет связи с сайтом: DNS, таймаут, сброс соединения, прокси не отвечает. */
const isNetworkError = (text) => /getaddrinfo failed|failed to resolve|name or service not known|temporary failure in name resolution|nodename nor servname|errno 11001|winerror 1006[01]|winerror 10054|connection (refused|reset|aborted)|timed out|network is unreachable|no route to host|unable to connect to proxy|proxyerror|ssl: (unexpected_eof|wrong_version)|eof occurred in violation/i.test(String(text || ''));

function netHelp(target, viaProxy) {
  const site = platformOf(target) === 'youtube' || /^ytsearch/i.test(String(target)) ? 'YouTube' : platformOf(target) === 'instagram' ? 'Instagram' : 'Сайт';
  return `${site} недоступен в этой сети: программа не может подключиться к серверу.\n`
    + (viaProxy ? 'Прокси из настроек не отвечает: проверь его адрес или включи VPN.\n' : 'Включи VPN или укажи прокси в Настройках → «Сеть», затем нажми «Проверить YouTube».\n')
    + 'Записи Twitch и файлы с диска работают без этого.';
}

module.exports = { twitchTargets, matchScore, filterByQuery, mergeResults, VIDEO_EXT, platformOf, isUrl, parseLinks, isInstagramProfile, SHORT_SEC, isShortSource, searchTarget, listArgs, channelUrl, parseList, filterLongs, downloadArgs, parseProgress, normEntry, statusOf,
  NET_MODES, proxyFromPac, normProxy, proxyArgs, isNetworkError, netHelp, ytResultsUrl,
  FILLER_QUERIES, parseQueryLine, fillerTarget, filterFillers, fillerDownloadArgs,
  BROWSERS, AUTO_BROWSERS, COOKIE_MODES, needsAuth, cookieArgs, authPlan, isAuthError, isCookieError, cookieWhy, authName, authHelp };
