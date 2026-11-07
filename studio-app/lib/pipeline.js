'use strict';
// Конвейер: источник → поиск моментов → (речь) → монтаж под каналы → папка для автозалива.
// Программы и сеть приходят снаружи (tools, fetch), поэтому конвейер можно гонять в тестах на настоящем ffmpeg.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildFilter, filterPath, camsOf, CAM_LAYOUTS, normBlurs, blursFor } = require('./layout');
const { buildAss } = require('./subs');
const { Envelope, findMoments, parseChat, fmtTime } = require('./moments');
const { planChannels } = require('./plan');
const { layoutOutput, writeTexts, checkFolder, nextFolderNumber, slugify } = require('./output');
const { renderArgs, coverArgs, frameArgs, envelopeArgs, parseRenderProgress, parseProbe, videoKbps, MAX_FILE_MB } = require('./render');
const { listArgs, downloadArgs, parseList, parseProgress, statusOf, proxyArgs, isNetworkError, netHelp, ytResultsUrl, fillerTarget, filterFillers, fillerDownloadArgs, platformOf, VIDEO_EXT, searchTarget, twitchTargets, filterByQuery, isInstagramProfile, isShortSource, authPlan, cookieArgs, needsAuth, isAuthError, isCookieError, authHelp } = require('./sources');
const { checkMoment } = require('./rules');
const { searchHashtags } = require('./igsearch');
const { whisperArgs, wavArgs, parseWhisperJson, MODELS } = require('./transcribe');

const hasEntries = (r, out) => { if (!out) return false; try { return parseList(out).length > 0; } catch { return false; } };
const uid = () => crypto.randomBytes(5).toString('hex');

class Pipeline {
  /** o: tools (Tools), dataDir (проекты и кэш), fontsDir, settings() → текущие настройки */
  constructor(o) {
    this.tools = o.tools; this.dataDir = o.dataDir; this.fontsDir = o.fontsDir; this.settings = o.settings;
    this.systemProxy = o.systemProxy || (() => '');  // прокси Windows (из Electron), '' — напрямую
    this.fetch = o.fetch || ((...a) => globalThis.fetch(...a)); // в программе — net.fetch Electron (системный прокси/VPN)
    this.projDir = path.join(this.dataDir, 'projects');
    this.cacheDir = path.join(this.dataDir, 'cache');
    fs.mkdirSync(this.projDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  // ------------------------------------------------------------ проекты
  list() {
    return fs.readdirSync(this.projDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(this.projDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.created - a.created);
  }
  get(id) {
    const p = path.join(this.projDir, `${id}.json`);
    if (!fs.existsSync(p)) throw new Error('Проект не найден');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  save(pr) { fs.writeFileSync(path.join(this.projDir, `${pr.id}.json`), JSON.stringify(pr, null, 1)); return pr; }
  remove(id) {
    fs.rmSync(path.join(this.projDir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.cacheDir, id), { recursive: true, force: true });
  }
  update(id, patch) {
    const pr = this.get(id);
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'moments' && Array.isArray(v)) {
        // момент обрезали: старые слова и проверка относятся к прежним границам
        const was = new Map((pr.moments || []).map((m) => [m.id, m]));
        pr.moments = v.map((m) => {
          const o = was.get(m.id);
          const start = Math.max(0, +m.start), end = Math.min(pr.source.duration || Infinity, +m.end);
          if (!(end - start >= 1)) throw new Error('Отрезок должен быть не короче секунды');
          if (o && (o.start !== start || o.end !== end)) { const { words, check, ...rest } = m; return { ...rest, start, end, peak: Math.min(end, Math.max(start, m.peak || start)), trimmed: true }; }
          return { ...m, start, end };
        });
      }
      else if (k === 'blurs') pr.blurs = normBlurs(v);
      else if (['frame', 'title', 'streamer'].includes(k)) pr[k] = v;
    }
    return this.save(pr);
  }
  cache(pr, ...p) { const d = path.join(this.cacheDir, pr.id); fs.mkdirSync(d, { recursive: true }); return path.join(d, ...p); }

  /**
   * Запуск yt-dlp с входом в YouTube по настройке cookies (см. authPlan в sources.js).
   * Способ, который сработал, запоминается до перезапуска программы. target — ссылка или ytsearch-запрос.
   */
  async ytdlp(args, target, opts = {}) {
    const cfg = this.settings().cookies || {};
    let plan = authPlan(cfg, target);
    const key = JSON.stringify(cfg);
    if (this._auth && this._auth.key === key && plan.length > 1) plan = [this._auth.auth, ...plan.filter((a) => JSON.stringify(a) !== JSON.stringify(this._auth.auth))];
    const { accept, okIfStdout, timeoutSec, ...runOpts } = opts;
    // лимит времени: поиск не должен висеть «Ищу…» бесконечно
    let timedOut = false, timer = null;
    const ctrl = timeoutSec ? new AbortController() : null;
    if (ctrl) {
      const stop = () => ctrl.abort();
      if (runOpts.signal) { if (runOpts.signal.aborted) stop(); runOpts.signal.addEventListener('abort', stop, { once: true }); }
      timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutSec * 1000);
      runOpts.signal = ctrl.signal;
    }
    const net = proxyArgs(this.settings().net, this.systemProxy());
    const tried = [];
    let authHit = false, last = null, empty = false, emptyRes = null, netFail = false;
    try {
      for (const auth of plan) {
        let r;
        try {
          // eslint-disable-next-line no-await-in-loop
          r = await this.tools.run(this.tools.ytdlp, [...net, ...cookieArgs(auth), ...args], { ...runOpts, allowFail: true });
        } catch (e) {
          if (timedOut) throw Object.assign(new Error(`yt-dlp не ответил за ${timeoutSec} с. Проверь интернет или VPN и повтори; если не поможет, обнови yt-dlp в Настройках → Компоненты.`), { code: 'TIMEOUT' });
          throw e;
        }
        tried.push(auth);
        const out = r.stdout ? r.stdout.toString('utf8').trim() : '';
        // accept: ответ годится (например, в поиске есть хоть одно видео); иначе — код 0 или (okIfStdout) непустой вывод
        const ok = accept ? accept(r, out) : (r.code === 0 || (okIfStdout && out));
        if (ok) { if (needsAuth(target)) this._auth = { key, auth }; return r; }
        last = r;
        // нет связи (DNS, блокировка, прокси) — другие cookies не помогут
        if (isNetworkError(r.stderr) && !isAuthError(r.stderr)) { netFail = true; break; }
        if (isAuthError(r.stderr)) { authHit = true; continue; }
        if (auth && isCookieError(r.stderr)) continue;
        // пустой ответ без ошибки: YouTube иногда отдаёт пустую выдачу без входа — пробуем дальше с cookies
        if (accept && r.code === 0) { empty = true; emptyRes = emptyRes || r; }
        if (accept && r.code === 0 && needsAuth(target) && plan.indexOf(auth) < plan.length - 1) continue;
        break;
      }
    } finally { if (timer) clearTimeout(timer); }
    if (empty && !authHit) last = emptyRes;
    this.logYtdlp([...net, ...args], last);
    if (netFail) throw Object.assign(new Error(netHelp(target, net.length && net[1])), { code: 'NET', res: last });
    if (authHit) throw Object.assign(new Error(authHelp(tried.filter(Boolean).length ? tried : [], target)), { code: 'AUTH', res: last });
    const tail = String((last && last.stderr) || '').trim().split(/\r?\n/).filter((l) => l && !/^\[(debug|info)\]/i.test(l)).slice(-3).join('\n');
    if (empty) throw Object.assign(new Error(`YouTube ничего не вернул.${tail ? `\n${tail}` : ''}\nПопробуй другой запрос, обнови yt-dlp (Настройки → Компоненты) или войди в YouTube (Настройки → «Вход в YouTube»).`), { code: 'EMPTY', res: last });
    throw Object.assign(new Error(`yt-dlp: код ${last.code}\n${tail}`), { res: last });
  }

  /** Проверка: открывается ли YouTube у yt-dlp с текущими настройками сети и входа. */
  async testYoutube() {
    const t0 = Date.now();
    const target = ytResultsUrl('minecraft');
    try {
      const r = await this.ytdlp(listArgs(target, 1), target, { accept: (x, out) => !!out && out.includes('"entries"'), timeoutSec: 40 });
      return { ok: true, ms: Date.now() - t0, proxy: proxyArgs(this.settings().net, this.systemProxy())[1] || '', count: r ? 1 : 0 };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message, code: e.code || '' };
    }
  }

  /** Последняя неудачная команда yt-dlp — в журнал (папка программы/logs/yt-dlp.txt), чтобы можно было прислать. */
  logYtdlp(args, r) {
    try {
      const dir = path.join(this.dataDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'yt-dlp.txt'), `${new Date().toISOString()}\nyt-dlp ${args.join(' ')}\nкод: ${r ? r.code : '?'}\n\n${r ? String(r.stderr || '').slice(-20000) : ''}\n`);
    } catch { /* не страшно */ }
  }

  async probe(file) {
    const r = await this.tools.run(this.tools.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
    return parseProbe(r.stdout.toString('utf8'));
  }

  async addFile(file) {
    const info = await this.probe(file);
    if (!info.width) throw new Error('В файле нет видео');
    const pr = { id: uid(), created: Date.now(), title: path.basename(file).replace(/\.[^.]+$/, ''), streamer: '',
      source: { kind: 'file', path: file, ...info, platform: 'file' }, moments: [], frame: null };
    return this.save(pr);
  }

  async addUrl(url) {
    if (isInstagramProfile(url)) throw new Error('Это профиль Instagram, а не рилс. Профиль целиком программа не скачивает (Instagram это закрыл): открой нужные рилсы и вставь ссылки на них, можно сразу несколько.');
    const r = await this.ytdlp(['-J', '--no-warnings', '--no-playlist', url], url);
    const raw = JSON.parse(r.stdout.toString('utf8'));
    const e = parseList(raw)[0];
    const platform = platformOf(url);
    const width = raw.width || 1920, height = raw.height || 1080;
    // у рилса заголовок «Video by ник»: лучше первая строка подписи
    const desc = String(raw.description || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
    const title = platform === 'instagram' && desc ? desc.slice(0, 90) : e.title;
    const pr = { id: uid(), created: Date.now(), title, streamer: e.channel || raw.uploader_id || '',
      source: { kind: 'url', url: e.url || url, duration: e.duration, width, height,
        hasAudio: true, platform, thumb: e.thumb, views: e.views }, moments: [], blurs: [],
      // вертикальное видео (рилс) — обычно без отдельной вебки: сразу «Без вебки», рамку можно поменять
      frame: height > width ? { cams: [], cam: null, content: { x: 0, y: 0, w: 1, h: 1 } } : null };
    return this.save(pr);
  }

  /**
   * Поиск сразу в нескольких местах. o.source: all | youtube | twitch; o.limit.
   * Возвращает {results, errors: {youtube?, twitch?}}; ошибка, только если не получилось нигде.
   */
  async searchAll(q, o = {}) {
    const s = this.settings();
    const src = o.source || 'all';
    const jobs = {};
    if (src === 'all' || src === 'youtube') jobs.youtube = this.search(q, o.limit || 30);
    if (src === 'all' || src === 'twitch') jobs.twitch = this.searchTwitch(q, s.twitchChannels || ['evelone2004'], o);
    // Instagram: по хэштегу через Graph API; во «Всех» — только если поиск настроен
    const ig = s.igSearch || {};
    if (src === 'instagram' || (src === 'all' && ig.token && ig.userId)) jobs.instagram = searchHashtags(this.fetch, ig, q);
    const names = Object.keys(jobs);
    const done = await Promise.allSettled(names.map((k) => jobs[k]));
    const results = [], errors = {};
    done.forEach((r, i) => { if (r.status === 'fulfilled') results.push(...r.value); else errors[names[i]] = (r.reason && r.reason.message) || String(r.reason); });
    if (!results.length && Object.keys(errors).length === names.length) {
      const e = done.find((r) => r.status === 'rejected').reason;
      const label = { youtube: 'YouTube', twitch: 'Twitch', instagram: 'Instagram' };
      throw Object.assign(new Error(names.map((k) => (names.length > 1 ? `${label[k]}: ${errors[k]}` : errors[k])).join('\n\n')), { code: e && e.code });
    }
    return { results, errors };
  }

  /** Twitch: записи, хайлайты и клипы каналов, отобранные по словам запроса. */
  async searchTwitch(q, channels, o = {}) {
    const lists = [], fails = [];
    for (const ch of channels.slice(0, 5)) {
      for (const t of twitchTargets(ch)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await this.ytdlp(listArgs(t.url, o.twitchLimit || 100), t.url, { accept: hasEntries, timeoutSec: 90 });
          lists.push(...parseList(r.stdout.toString('utf8').trim()).map((e) => ({ ...e, kind: t.kind, channel: e.channel || ch, platform: 'twitch' })));
        } catch (e) { if (e.code === 'NET') throw e; fails.push(`${ch} (${t.kind}): ${String(e.message).split('\n')[0]}`); }
      }
    }
    if (!lists.length && fails.length) throw new Error(`Twitch ничего не отдал.\n${fails.slice(0, 3).join('\n')}`);
    const seen = new Set();
    const all = lists.filter((e) => e.url && !seen.has(e.url) && seen.add(e.url));
    const found = filterByQuery(all, q);
    if (found.length) return found;
    // в названиях нет слов запроса (часто запрос по-английски, а стримы названы по-русски) — не пусто,
    // а последние записи и самые просматриваемые клипы, с пометкой
    const vods = all.filter((e) => e.kind !== 'clip').slice(0, 20), clips = all.filter((e) => e.kind === 'clip').sort((a, b) => b.views - a.views).slice(0, 20);
    return [...vods, ...clips].map((e) => ({ ...e, loose: true }));
  }

  /** Поиск лонгов/нарезок: запрос, ссылка на канал или плейлист. */
  async search(q, limit = 20, start = 1) {
    const r = await this.ytdlp(listArgs(q, limit, start), searchTarget(q, limit), { accept: hasEntries, timeoutSec: 90 });
    return parseList(r.stdout.toString('utf8').trim());
  }

  // ------------------------------------------------------------ анализ
  /** Звук источника: файл как есть, ссылка — только звуковая дорожка в кэш. */
  async audioSource(pr, onProgress, signal) {
    if (pr.source.kind === 'file') return pr.source.path;
    if (isShortSource(pr.source)) return this.wholeVideo(pr, onProgress, signal);
    const dir = path.dirname(this.cache(pr, 'x'));
    const ready = (x) => /^audio\.(m4a|webm|opus|mp3|aac|mp4|mkv|ts|ogg)$/i.test(x);
    const done = fs.readdirSync(dir).find(ready);
    if (done) return this.cache(pr, done);
    let p = 0, last = '', lastAt = Date.now();
    const say = (text) => onProgress && onProgress(p, text);
    // yt-dlp молчит дольше минуты — показать, что последним он писал (чтобы не казалось, что всё зависло)
    const timer = setInterval(() => { if (Date.now() - lastAt > 60000) say(`Жду yt-dlp ${Math.round((Date.now() - lastAt) / 60000)} мин: ${last.slice(0, 90) || 'нет ответа'}`); }, 15000);
    try {
      await this.ytdlp(downloadArgs(pr.source.url, { audioOnly: true, out: this.cache(pr, 'audio.%(ext)s'), ffmpeg: this.tools.ffmpeg }), pr.source.url, {
        signal, onLine: (l) => {
          last = l; lastAt = Date.now();
          const v = parseProgress(l);
          if (v != null) { p = v; say('Скачиваю звук'); return; }
          const st = statusOf(l);
          if (st) say(st);
        },
      });
    } finally { clearInterval(timer); }
    const f = fs.readdirSync(dir).find(ready) || fs.readdirSync(dir).find((x) => /^audio\./.test(x) && !/\.(part|ytdl|temp|tmp)$/i.test(x) && !/\.part-Frag/i.test(x));
    if (!f) throw new Error('Звук не скачался');
    return this.cache(pr, f);
  }

  async chatTimes(pr, signal) {
    if (pr.source.kind !== 'url') return [];
    try {
      // чат длинного стрима качается страница за страницей и может идти десятки минут: даём 3 минуты, потом без чата
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      if (signal) { if (signal.aborted) stop(); signal.addEventListener('abort', stop, { once: true }); }
      const t = setTimeout(stop, 180000);
      try { await this.ytdlp(downloadArgs(pr.source.url, { chat: true, out: this.cache(pr, 'chat.%(ext)s') }), pr.source.url, { signal: ctrl.signal }); } catch (e) { if (signal && signal.aborted) throw e; } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', stop); }
      const d = path.dirname(this.cache(pr, 'x'));
      const f = fs.readdirSync(d).find((x) => /^chat\..*\.(json|live_chat\.json)$/.test(x) || /^chat\.(live_chat|rechat)/.test(x));
      return f ? parseChat(fs.readFileSync(path.join(d, f), 'utf8')) : [];
    } catch (e) { if (signal && signal.aborted) throw e; return []; }
  }

  /** Короткое видео по ссылке (рилс): скачать целиком один раз — и звук, и картинка берутся из него. */
  async wholeVideo(pr, onProgress, signal) {
    const out = this.cache(pr, 'full.mp4');
    if (fs.existsSync(out)) return out;
    await this.ytdlp(downloadArgs(pr.source.url, { out, ffmpeg: this.tools.ffmpeg }), pr.source.url, {
      signal, onLine: (l) => { const p = parseProgress(l); if (p != null && onProgress) onProgress(p, 'Скачиваю видео'); },
    });
    if (!fs.existsSync(out)) throw new Error('Видео не скачалось');
    return out;
  }

  /** Найти моменты. Возвращает обновлённый проект. */
  async analyze(id, onProgress, signal) {
    const pr = this.get(id);
    const s = this.settings();
    const audio = await this.audioSource(pr, (p, t) => onProgress && onProgress(p * 0.4, t), signal);
    if (!pr.source.duration) pr.source.duration = (await this.probe(audio)).duration;
    const env = new Envelope(8000, 0.5);
    const dur = pr.source.duration || 1;
    let samples = 0;
    if (onProgress) onProgress(0.4, 'Слушаю звук');
    await this.tools.run(this.tools.ffmpeg, envelopeArgs(audio), {
      signal, onStdout: (b) => { env.push(b); samples += b.length / 2; if (onProgress) onProgress(0.4 + 0.5 * Math.min(1, samples / 8000 / dur), 'Слушаю звук'); },
    });
    const values = env.finish();
    if (onProgress) onProgress(0.92, 'Смотрю чат');
    const chat = await this.chatTimes(pr, signal);
    const need = Math.max(20, Math.ceil(s.channels.length * s.perChannel * 1.5));
    // короткое видео (рилс, клип) — один момент на всю длину, обрезать можно вручную
    const whole = dur <= Math.max(60, s.maxLen) * 1.3;
    const found = whole ? [{ start: 0, end: Math.round(dur * 100) / 100, peak: dur / 2, score: 0, whole: true }]
      : findMoments(values, { winSec: env.winSec, minLen: s.minLen, maxLen: s.maxLen, count: need, chat });
    const old = new Map((pr.moments || []).map((m) => [`${m.start}-${m.end}`, m]));
    pr.moments = found.map((m, i) => old.get(`${m.start}-${m.end}`) || { id: uid(), ...m, title: '', selected: i < need });
    pr.envelope = downsample(values, 600);
    pr.chatCount = chat.length;
    pr.analyzed = Date.now();
    if (onProgress) onProgress(1, 'Готово');
    return this.save(pr);
  }

  /** Добавить момент вручную. */
  addMoment(id, start, end) {
    const pr = this.get(id);
    const m = { id: uid(), start: Math.max(0, +start), end: +end, peak: (+start + +end) / 2, score: 0, title: '', selected: true, manual: true };
    if (!(m.end > m.start)) throw new Error('Конец должен быть позже начала');
    pr.moments.push(m);
    pr.moments.sort((a, b) => a.start - b.start);
    return this.save(pr);
  }

  // ------------------------------------------------------------ кадры и видео
  /** Видео для отрезка: файл как есть; ссылка — скачать только этот кусок (с запасом 2 с). */
  async videoFor(pr, start, end, onProgress, signal) {
    if (pr.source.kind === 'file') return { input: pr.source.path, offset: 0 };
    if (isShortSource(pr.source)) return { input: await this.wholeVideo(pr, onProgress && ((p) => onProgress(p)), signal), offset: 0 };
    const a = Math.max(0, Math.floor(start - 2)), b = Math.ceil(end + 2);
    const out = this.cache(pr, `v_${a}_${b}.mp4`);
    if (!fs.existsSync(out)) {
      await this.ytdlp(downloadArgs(pr.source.url, { sections: [[a, b]], out, ffmpeg: this.tools.ffmpeg }), pr.source.url, {
        signal, onLine: (l) => { const p = parseProgress(l); if (p != null && onProgress) onProgress(p); },
      });
    }
    return { input: out, offset: a };
  }

  /** JPEG-кадр источника (для выбора рамки вебки). */
  async frame(id, t) {
    const pr = this.get(id);
    const at = Math.max(0, Math.min((pr.source.duration || 1) - 1, t));
    const v = await this.videoFor(pr, at, at + 3);
    const r = await this.tools.run(this.tools.ffmpeg, frameArgs(v.input, Math.max(0, at - v.offset)));
    return r.stdout;
  }

  // ------------------------------------------------------------ речь
  async words(pr, m, signal) {
    if (m.words) return m.words;
    const s = this.settings();
    const model = this.tools.modelPath((MODELS[s.whisperModel] || MODELS.small).file);
    if (!this.tools.whisper || !fs.existsSync(model)) return null;
    const src = pr.source.kind === 'file' ? pr.source.path : await this.audioSource(pr, null, signal);
    const wav = this.cache(pr, `w_${m.id}.wav`);
    await this.tools.run(this.tools.ffmpeg, wavArgs(src, wav, m.start, m.end), { signal });
    if (!fs.existsSync(wav) || fs.statSync(wav).size < 16000) {
      throw new Error(`Не получилось вырезать звук отрезка ${fmtTime(m.start)}–${fmtTime(m.end)}: в исходнике нет звука в этом месте. Удали момент или скачай видео заново.`);
    }
    const base = this.cache(pr, `w_${m.id}`);
    // whisper-cli на Windows не открывает файлы, если в пути русские буквы (например, имя пользователя Windows
    // по-русски). Поэтому запускаем его из папки кэша и передаём только короткие латинские имена.
    const cwd = path.dirname(wav);
    const rel = (p) => path.relative(cwd, p) || p;
    const args = (gpu) => whisperArgs({ model: rel(model), wav: path.basename(wav), outBase: path.basename(base), lang: s.lang, gpu, threads: Math.max(2, require('os').cpus().length - 1) });
    const run = (gpu) => this.tools.run(this.tools.whisper, args(gpu), { signal, cwd });
    try {
      try { await run(s.gpu); } catch (e) {
        // нет CUDA-библиотек или видеокарта занята — распознаём на процессоре
        if (!s.gpu || e.code === 'ABORT') throw e;
        await run(false);
      }
    } catch (e) {
      if (e.code === 'ABORT') throw e;
      throw Object.assign(new Error(whisperHelp(e)), { res: e.res });
    }
    const words = parseWhisperJson(fs.readFileSync(`${base}.json`, 'utf8'), m.start);
    fs.rmSync(wav, { force: true });
    return words;
  }

  // ------------------------------------------------------------ проверка правил
  /** Нужна ли рамка вебки при выбранных раскладках. */
  needsCam() { return this.settings().formats.some((f) => CAM_LAYOUTS.includes(f)); }

  /** Распознать речь выбранных моментов проекта и проверить правила. Результат в m.check. */
  async check(id, onProgress, signal) {
    const s = this.settings();
    let pr = this.get(id);
    const sel = pr.moments.filter((m) => m.selected);
    for (let i = 0; i < sel.length; i++) {
      if (onProgress) onProgress(i / sel.length, `Проверяю ${i + 1} из ${sel.length}`);
      const words = s.subsOn || s.rules.minWords > 0 ? await this.words(pr, sel[i], signal) : null;
      pr = this.get(id);
      const m = pr.moments.find((x) => x.id === sel[i].id);
      if (!m) continue;
      if (words) m.words = words;
      // рамка сохранена без вебки («Без вебки») — ролики этого видео соберутся без неё, это не ошибка
      const noCam = !!(pr.frame && !camsOf(pr.frame).length);
      m.check = checkMoment(m, { words: m.words || null, layout: this.needsCam() && !noCam ? 'stream' : 'full', hasCam: camsOf(pr.frame).length > 0, rules: s.rules });
      this.save(pr);
    }
    if (onProgress) onProgress(1, 'Готово');
    return this.get(id);
  }

  /** Мини-игры из папки (кэш длительностей). */
  // ------------------------------------------------------------ фон: залипательные видео и мини-игры
  /** Поиск фона на YouTube (cc — только Creative Commons). */
  async searchFillers(q, o = {}) {
    const target = fillerTarget(q, { cc: !!o.cc, limit: o.limit || 30 });
    const r = await this.ytdlp(listArgs(target, o.limit || 30), target, { accept: hasEntries, timeoutSec: 90 });
    const list = filterFillers(parseList(r.stdout.toString('utf8').trim()));
    if (!list.length) throw Object.assign(new Error('Нашлись только ролики короче 20 секунд. Попробуй другой запрос.'), { code: 'EMPTY' });
    return list;
  }

  /** Библиотека фона: видео в папке фона. id — из имени «название-ID.mp4», чтобы не качать второй раз. */
  fillerLibrary() {
    const dir = this.settings().fillerDir;
    if (!dir) return { dir: '', files: [] };
    const files = safeList(dir).filter((x) => VIDEO_EXT.test(x)).map((name) => {
      let size = 0; try { size = fs.statSync(path.join(dir, name)).size; } catch { /* нет */ }
      const m = /-\[([\w-]{6,})\]\.\w+$/.exec(name);
      return { name, path: path.join(dir, name), size, id: m ? m[1] : null };
    });
    return { dir, files };
  }

  /** Скачать найденные видео в папку фона. list: [{id, url, title, duration}]. Уже скачанные пропускаются. */
  async addFillers(list, onProgress, signal) {
    const dir = this.settings().fillerDir;
    if (!dir) throw new Error('Не выбрана папка фона');
    fs.mkdirSync(dir, { recursive: true });
    const have = new Set(this.fillerLibrary().files.map((f) => f.id).filter(Boolean));
    const added = [], skipped = [], failed = [];
    for (const [i, e] of list.entries()) {
      const id = String(e.id || '').replace(/[^\w-]/g, '').slice(0, 40) || uid();
      if (have.has(id)) { skipped.push(e.title); continue; }
      const base = `${slugify(e.title || 'video', 40)}-[${id}]`;
      const say = (p, t) => onProgress && onProgress((i + p) / list.length, `${i + 1} из ${list.length}: ${t}`);
      say(0, e.title || 'видео');
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.ytdlp(fillerDownloadArgs(e.url, { out: path.join(dir, `${base}.%(ext)s`), ffmpeg: this.tools.ffmpeg, duration: e.duration }), e.url, {
          signal, onLine: (l) => { const p = parseProgress(l); if (p != null) say(p, e.title || 'видео'); },
        });
        const f = safeList(dir).find((x) => x.startsWith(base) && VIDEO_EXT.test(x));
        if (!f) throw new Error('файл не появился');
        added.push(path.join(dir, f)); have.add(id);
      } catch (err) {
        if (signal && signal.aborted) throw err;
        failed.push(`${e.title}: ${String(err.message).split('\n')[0]}`);
      }
    }
    this._fillers = null;
    if (!added.length && failed.length) throw new Error(`Не скачалось:\n${failed.slice(0, 3).join('\n')}`);
    return { added, skipped, failed, dir };
  }

  /** Убрать видео из библиотеки фона (только из папки фона). */
  removeFiller(file) {
    const dir = this.settings().fillerDir;
    const full = path.resolve(file);
    if (!dir || path.dirname(full) !== path.resolve(dir) || !VIDEO_EXT.test(full)) throw new Error('Это не файл из папки фона');
    fs.rmSync(full, { force: true });
    this._fillers = null;
    return this.fillerLibrary();
  }

  async fillers() {
    const dir = this.settings().fillerDir;
    if (!dir) return [];
    if (this._fillers && this._fillers.dir === dir) return this._fillers.list;
    const list = [];
    for (const f of safeList(dir).filter((x) => VIDEO_EXT.test(x))) {
      try { const info = await this.probe(path.join(dir, f)); if (info.width) list.push({ path: path.join(dir, f), duration: info.duration }); } catch { /* битый файл */ }
    }
    this._fillers = { dir, list };
    return list;
  }

  /**
   * Страховка перед отправкой в автопостер: видео папки тяжелее limitMb (GitHub не примет файл больше ~95 МБ)
   * пережимаются по битрейту под лимит. Нужно для папок, собранных старой версией, и для папок, добавленных вручную.
   * Возвращает {shrunk: [имя...], failed: [текст...]}.
   */
  async shrinkLarge(folder, { limitMb = 90, onProgress, signal } = {}) {
    const found = [];
    const walk = (d) => {
      for (const n of safeList(d)) {
        const p = path.join(d, n);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (/\.(mp4|mov)$/i.test(n) && st.size > limitMb * 1048576) found.push(p);
      }
    };
    walk(folder);
    const shrunk = [], failed = [];
    for (const [i, f] of found.entries()) {
      const name = path.relative(folder, f);
      if (onProgress) onProgress(i / found.length, `Сжимаю ${name}`);
      try {
        const info = await this.probe(f);
        let kbps = Math.round(videoKbps(info.duration || 60, limitMb - 8) * 0.9);
        const tmp = `${f}.shrink.mp4`;
        let ok = false;
        for (let k = 0; k < 3 && !ok; k++) {
          // eslint-disable-next-line no-await-in-loop
          await this.tools.run(this.tools.ffmpeg, ['-hide_banner', '-y', '-nostdin', '-i', f, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${kbps}k`,
            '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', tmp], { signal });
          ok = fs.statSync(tmp).size <= limitMb * 1048576;
          if (!ok) kbps = Math.max(800, Math.round(kbps * 0.7));
        }
        if (!ok) { fs.rmSync(tmp, { force: true }); throw new Error('всё равно тяжелее лимита'); }
        fs.renameSync(tmp, f);
        shrunk.push(name);
      } catch (e) {
        if (e.code === 'ABORT') throw e;
        failed.push(`${name}: ${String(e.message).split('\n')[0]}`);
      }
    }
    if (onProgress) onProgress(1, 'Готово');
    return { shrunk, failed };
  }

  // ------------------------------------------------------------ монтаж
  /**
   * Собрать папку дня. o: projectIds, name (имя папки), outputDir, onEvent({stage, i, total, label, progress, file}), signal.
   * Сначала проверка правил (речь, вебка), не прошедшие моменты в выход не попадают.
   * Возвращает {folder, videos, problems, rejected}.
   */
  async build(o) {
    // o.override: сборка раздела «Instagram» (свои аккаунты, очередь, раскладки) поверх общих настроек
    const s = { ...this.settings(), ...(o.override || {}) };
    const emit = o.onEvent || (() => {});
    const outDir = o.outputDir || s.outputDir;
    if (!outDir) throw new Error('Не выбрана папка для готовых роликов (Настройки → Выход)');
    const ids = o.projectIds;
    // 1. проверка
    const rejected = [];
    for (let k = 0; k < ids.length; k++) {
      await this.check(ids[k], (p, t) => emit({ stage: 'Проверка', i: k, total: ids.length, label: t, progress: p }), o.signal);
    }
    const projects = new Map(ids.map((id) => [id, this.get(id)]));
    const moments = [];
    for (const pr of projects.values()) {
      for (const m of pr.moments) {
        if (!m.selected) continue;
        if (m.check && !m.check.ok) { rejected.push({ project: pr.title, projectId: pr.id, at: fmtTime(m.start), issues: m.check.issues }); continue; }
        moments.push({ ...m, projectId: pr.id });
      }
    }
    if (!moments.length) throw Object.assign(new Error('Ни один момент не прошёл проверку'), { rejected });
    // 2. план
    const fillers = await this.fillers();
    const formats = s.formats.filter((f) => f !== 'filler' || fillers.length);
    const plan = planChannels(moments, s.channels.length, s.perChannel, { vary: s.vary, allowMirror: s.allowMirror, allowSpeed: s.allowSpeed, formats: formats.length ? formats : ['full'], subStyles: s.subStyles });
    const root = path.join(outDir, s.lane);
    fs.mkdirSync(root, { recursive: true });
    const existing = [...safeList(root), ...safeList(path.join(outDir, s.lane.replace('queue', 'posted')))];
    const first = projects.values().next().value;
    const out = layoutOutput({
      root, number: nextFolderNumber(existing), name: o.name || first.title, channels: s.channels, plan, rules: s.rules,
      texts: { ...s.texts }, meta: (m) => ({ title: m.title || '' }),
    });
    writeTexts(out);
    // 3. рендер
    const total = out.files.length;
    let encoderFallback = false;
    for (let i = 0; i < total; i++) {
      if (o.signal && o.signal.aborted) throw Object.assign(new Error('Отменено'), { code: 'ABORT' });
      const f = out.files[i];
      const m = f.item.moment, v = f.item.variant;
      const pr = projects.get(m.projectId);
      const label = `${path.basename(f.dir)} · ${path.basename(f.video)}`;
      const ev = (stage, progress) => emit({ stage, i, total, label, progress });
      ev('Видео', 0);
      const media = await this.videoFor(pr, m.start, m.end, (p) => ev('Скачиваю кусок', p * 0.2), o.signal);
      const words = s.subsOn ? (m.words || await this.words(pr, m, o.signal)) : null;
      const fr = pr.frame || {};
      const speed = v.speed || 1;
      const dur = (m.end - m.start) / speed;
      let filler = null;
      if (v.layout === 'filler' && fillers.length) {
        const h = hash(`${m.id}:${f.channel}`);
        const fl = fillers[h % fillers.length];
        filler = { path: fl.path, offset: Math.max(0, (h % 997) / 997 * Math.max(0, fl.duration - dur - 1)).toFixed(2) };
      }
      // блюр: время из исходника → время от начала ролика (до ускорения)
      const blurs = blursFor(pr.blurs, m.start, m.end);
      const base = { layout: v.layout || s.layout, srcW: pr.source.width, srcH: pr.source.height, cams: camsOf(fr), content: fr.content || null, fit: s.fit, blurs,
        split: fr.split || s.split, variant: v, hasAudio: pr.source.hasAudio !== false, filler: !!filler };
      const anchors = buildFilter(base).anchors;
      const assFile = this.cache(pr, `s_${i}_${m.id}.ass`);
      const start = m.start - media.offset, end = m.end - media.offset;
      fs.writeFileSync(assFile, buildAss({
        words: (words || []).map((w) => ({ ...w, s: w.s - media.offset, e: w.e - media.offset })), clipStart: start, clipEnd: end, speed,
        style: v.subStyle || s.subStyle, title: f.title, titleStyle: s.titleStyle, titleDur: s.titleDur, anchors, maxWords: s.maxWords,
      }));
      const filter = buildFilter({ ...base, ass: filterPath(assFile), fontsDir: filterPath(this.fontsDir) });
      let kbps = videoKbps(dur);
      const render = (encoder) => this.tools.run(this.tools.ffmpeg, renderArgs({ input: media.input, start, end, filter, filler, output: f.video, encoder, quality: s.quality, fps: s.fps, loudnorm: s.loudnorm, maxDur: dur.toFixed(3), maxKbps: kbps }), {
        signal: o.signal, onStdout: (b) => { const p = parseRenderProgress(b.toString('utf8'), dur); if (p != null) ev('Монтаж', 0.25 + p * 0.7); },
      });
      const enc = encoderFallback ? 'cpu' : s.encoder;
      try { await render(enc); } catch (e) {
        // видеокарта не взялась (старый драйвер, нет NVENC) — доделываем на процессоре, а не роняем всю сборку
        if (enc === 'cpu' || e.code === 'ABORT') throw e;
        encoderFallback = true;
        emit({ stage: 'Видеокарта не кодирует, перехожу на процессор', i, total, label, progress: 0.25, warning: e.message });
        await render('cpu');
      }
      // всё равно тяжелее лимита (кодек видеокарты не всегда держит потолок) — пережимаем на процессоре пониже
      for (let k = 0; k < 2 && fs.statSync(f.video).size > MAX_FILE_MB * 1048576 * 1.08; k++) {
        kbps = Math.max(1500, Math.round(kbps * 0.7));
        emit({ stage: 'Файл тяжелее 90 МБ, пережимаю', i, total, label, progress: 0.9 });
        await render('cpu');
      }
      const coverAt = Math.min(Math.max(0.5, dur - 0.5), Math.max(0.5, ((m.peak || m.start) - m.start) / speed));
      await this.tools.run(this.tools.ffmpeg, coverArgs(f.video, f.cover, coverAt.toFixed(2)), { signal: o.signal });
      fs.rmSync(assFile, { force: true });
      emit({ stage: 'Готово', i, total, label, progress: 1, file: f.video, layout: buildFilter(base).layout });
    }
    return { folder: out.folder, ...checkFolder(out.folder), rejected, encoderFallback };
  }
}

/** Понятный текст ошибки распознавания речи (whisper-cli) по его выводу. */
function whisperHelp(e) {
  const err = (e.res && e.res.stderr) || e.message || '';
  const code = e.res ? e.res.code : null;
  const why = /failed to read audio|failed to open audio|input file not found/i.test(err) ? 'программа распознавания не смогла открыть звук отрезка'
    : /failed to (initialize whisper context|load model)|invalid model|failed to open .*\.bin/i.test(err) ? 'файл модели повреждён или скачан не до конца: удали его в Настройках и скачай заново'
      : /failed to process audio/i.test(err) ? 'сбой при распознавании (часто нехватка видеопамяти: выбери модель поменьше или выключи видеокарту для распознавания)'
        : code === 11 ? 'не удалось прочитать звук или записать результат'
          : '';
  const detail = String(err).split(/\r?\n/).map((l) => l.trim()).filter((l) => /error|failed|not found/i.test(l) && !/^whisper_print_timings/.test(l)).slice(-3).join('\n');
  return `Распознавание речи не сработало${why ? `: ${why}` : ''}.${detail ? `\n${detail}` : `\n${String(e.message || '').split('\n')[0]}`}`;
}

const hash = (str) => { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
function safeList(d) { try { return fs.readdirSync(d); } catch { return []; } }
function downsample(arr, n) {
  if (arr.length <= n) return arr.map((v) => Math.round(v));
  const out = [], k = arr.length / n;
  for (let i = 0; i < n; i++) {
    const seg = arr.slice(Math.floor(i * k), Math.floor((i + 1) * k));
    out.push(Math.round(Math.max(...seg)));
  }
  return out;
}

module.exports = { Pipeline, downsample, whisperHelp };
