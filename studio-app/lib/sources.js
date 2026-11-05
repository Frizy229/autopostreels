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
  if (o.audioOnly) a.push('-f', 'bestaudio/best', '-x', '--audio-format', 'm4a');
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

/** Прогресс из строки yt-dlp: «[download]  42.3% of ...» → 0.423. */
function parseProgress(line) {
  const m = /\[download\]\s+([\d.]+)%/.exec(line);
  return m ? Math.min(1, parseFloat(m[1]) / 100) : null;
}

module.exports = { VIDEO_EXT, platformOf, isUrl, searchTarget, listArgs, channelUrl, parseList, filterLongs, downloadArgs, parseProgress, normEntry };
