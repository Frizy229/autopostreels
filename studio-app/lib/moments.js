'use strict';
// Поиск моментов без ИИ: громкость звука относительно «фона» вокруг (смех, крик, взрыв)
// плюс плотность чата, если он есть. Всё чистое: на входе массивы чисел, на выходе отрезки.

/** Копит громкость окнами по winSec из потока PCM s16le mono. */
class Envelope {
  constructor(sampleRate = 8000, winSec = 0.5) {
    this.sr = sampleRate; this.win = Math.max(1, Math.round(sampleRate * winSec)); this.winSec = this.win / sampleRate;
    this.sum = 0; this.n = 0; this.values = []; this.rest = null;
  }
  push(buf) {
    let b = buf;
    if (this.rest) { b = Buffer.concat([this.rest, buf]); this.rest = null; }
    const usable = b.length - (b.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = b.readInt16LE(i) / 32768;
      this.sum += v * v; this.n++;
      if (this.n >= this.win) { this.values.push(toDb(this.sum / this.n)); this.sum = 0; this.n = 0; }
    }
    if (usable < b.length) this.rest = b.subarray(usable);
    return this;
  }
  finish() { if (this.n > this.win / 4) this.values.push(toDb(this.sum / this.n)); this.sum = 0; this.n = 0; return this.values; }
}
const toDb = (ms) => (ms > 1e-10 ? 10 * Math.log10(ms) : -100);

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : 0;
}

/** Скользящее среднее радиусом r. */
function smooth(arr, r) {
  const out = new Array(arr.length);
  let s = 0, n = 0;
  for (let i = 0; i < arr.length + r; i++) {
    if (i < arr.length) { s += arr[i]; n++; }
    if (i - 2 * r - 1 >= 0) { s -= arr[i - 2 * r - 1]; n--; }
    const c = i - r;
    if (c >= 0 && c < arr.length) out[c] = s / n;
  }
  return out;
}

/** «Фон» — скользящая медиана по окну (шаг step, чтобы 3-часовой стрим считался быстро). */
function rollingBaseline(arr, radius, step = 4) {
  const out = new Array(arr.length);
  let last = null, lastI = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (i - lastI >= step || last === null) {
      last = median(arr.slice(Math.max(0, i - radius), Math.min(arr.length, i + radius + 1)));
      lastI = i;
    }
    out[i] = last;
  }
  return out;
}

function zscore(arr) {
  const n = arr.length || 1;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return arr.map((v) => (v - mean) / sd);
}

/** Сообщения чата → число сообщений в каждом окне. */
function chatDensity(times, winSec, length) {
  const out = new Array(length).fill(0);
  for (const t of times || []) {
    const i = Math.floor(t / winSec);
    if (i >= 0 && i < length) out[i]++;
  }
  return out;
}

/**
 * Чат из yt-dlp: YouTube live_chat.json (по строке на событие) или Twitch rechat (массив комментариев).
 * Возвращает секунды от начала записи.
 */
function parseChat(text) {
  const out = [];
  const s = String(text || '').trim();
  if (!s) return out;
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (o.content_offset_seconds != null) { out.push(+o.content_offset_seconds); return; }
    const r = o.replayChatItemAction;
    if (r && r.videoOffsetTimeMsec != null) { out.push(+r.videoOffsetTimeMsec / 1000); return; }
    if (o.comments) visit(o.comments);
  };
  if (s[0] === '[' || (s[0] === '{' && !s.includes('\n{'))) {
    try { visit(JSON.parse(s)); return out.filter(Number.isFinite).sort((a, b) => a - b); } catch { /* построчно ниже */ }
  }
  for (const line of s.split(/\r?\n/)) {
    try { visit(JSON.parse(line)); } catch { /* пропускаем мусор */ }
  }
  return out.filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * Найти моменты.
 * env: громкость в dB по окнам winSec. opt: minLen, maxLen, count, chat (массив секунд), chatWeight, gap.
 * Возвращает [{start, end, peak, score}] по убыванию score.
 */
function findMoments(env, opt = {}) {
  const winSec = opt.winSec || 0.5;
  const minLen = opt.minLen || 20, maxLen = Math.max(minLen, opt.maxLen || 60);
  const count = opt.count || 20, gap = opt.gap ?? 5;
  const n = env.length;
  if (!n) return [];
  const total = n * winSec;
  const base = rollingBaseline(env, Math.round(45 / winSec));
  let excite = zscore(smooth(env.map((v, i) => v - base[i]), Math.max(1, Math.round(1.5 / winSec))));
  if (opt.chat && opt.chat.length) {
    const w = opt.chatWeight ?? 0.8;
    // реакция чата приходит на 3–10 с позже момента: сдвигаем назад на ~5 с
    const shift = Math.round(5 / winSec);
    const dens = zscore(smooth(chatDensity(opt.chat, winSec, n), Math.round(3 / winSec)));
    excite = excite.map((v, i) => v + w * (dens[Math.min(n - 1, i + shift)] || 0));
  }
  // пики: локальный максимум в радиусе minLen/2
  const rad = Math.max(1, Math.round(minLen / 2 / winSec));
  const peaks = [];
  for (let i = 0; i < n; i++) {
    const v = excite[i];
    if (v < (opt.threshold ?? 0.8)) continue;
    let isMax = true;
    for (let j = Math.max(0, i - rad); j <= Math.min(n - 1, i + rad); j++) {
      if (excite[j] > v || (excite[j] === v && j < i)) { isMax = false; break; }
    }
    if (isMax) peaks.push(i);
  }
  const target = Math.min(maxLen, Math.max(minLen, opt.target || (minLen + maxLen) / 2));
  const cand = peaks.map((i) => {
    const peak = i * winSec;
    // начало с запасом перед пиком (подводка), конец тянем, пока «шумно», но в пределах maxLen
    let start = Math.max(0, peak - target * 0.55);
    let end = Math.min(total, start + target);
    let j = Math.floor(end / winSec);
    while (j < n && excite[j] > 0.3 && (j + 1) * winSec - start <= maxLen) j++;
    end = Math.min(total, Math.max(end, j * winSec));
    if (end - start < minLen) start = Math.max(0, end - minLen);
    // сила: пик + средняя «живость» отрезка
    const a = Math.floor(start / winSec), b = Math.max(a + 1, Math.floor(end / winSec));
    const mean = excite.slice(a, b).reduce((s, x) => s + x, 0) / (b - a);
    return { start: round1(start), end: round1(end), peak: round1(peak), score: round2(excite[i] * 0.7 + mean * 0.3) };
  }).sort((x, y) => y.score - x.score);
  const picked = [];
  for (const c of cand) {
    if (picked.some((p) => c.start < p.end + gap && c.end > p.start - gap)) continue;
    picked.push(c);
    if (picked.length >= count) break;
  }
  return picked;
}
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Время 1:02:03 / 62:03 / 3723 → секунды; и обратно. */
function parseTime(s) {
  if (typeof s === 'number') return s;
  const parts = String(s || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((a, p) => a * 60 + p, 0);
}
function fmtTime(sec) {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}

module.exports = { Envelope, smooth, median, rollingBaseline, zscore, chatDensity, parseChat, findMoments, parseTime, fmtTime };
