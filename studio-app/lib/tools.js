'use strict';
// Внешние программы: ffmpeg/ffprobe (идут с приложением), yt-dlp и whisper.cpp (скачиваются при первом запуске).
// Запуск процессов с прогрессом и отменой.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);

/** Путь к бинарнику из npm-пакета: внутри app.asar запускать нельзя, берём из app.asar.unpacked. */
const unpacked = (p) => (p ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p);

/**
 * Бинарник из npm-пакета, если его можно запустить. На Linux/macOS после `npm ci --ignore-scripts`
 * у файла нет права на выполнение (его ставит скрипт пакета): пробуем выдать, иначе null — возьмём системный.
 */
function runnable(p) {
  if (!p || !fs.existsSync(p)) return null;
  if (isWin) return p;
  try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* нет права */ }
  try { fs.chmodSync(p, 0o755); fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; }
}

function which(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, exe(name));
    try { if (fs.statSync(p).isFile()) return p; } catch { /* нет */ }
  }
  return null;
}

class Tools {
  constructor(binDir) {
    this.binDir = binDir;
    fs.mkdirSync(binDir, { recursive: true });
  }

  get ffmpeg() {
    try { const p = runnable(unpacked(require('ffmpeg-static'))); if (p) return p; } catch { /* нет пакета */ }
    return which('ffmpeg') || 'ffmpeg';
  }
  get ffprobe() {
    try { const p = runnable(unpacked(require('@ffprobe-installer/ffprobe').path)); if (p) return p; } catch { /* нет пакета */ }
    return which('ffprobe') || 'ffprobe';
  }
  get ytdlp() {
    const p = path.join(this.binDir, exe('yt-dlp'));
    return fs.existsSync(p) ? p : which('yt-dlp');
  }
  get whisper() {
    const dir = path.join(this.binDir, 'whisper');
    const found = findFile(dir, (n) => n === exe('whisper-cli') || n === exe('main'));
    return found || which('whisper-cli');
  }
  modelPath(file) { return path.join(this.binDir, 'models', file); }

  status(modelFile) {
    return {
      ffmpeg: this.ffmpeg, ytdlp: this.ytdlp, whisper: this.whisper,
      model: modelFile && fs.existsSync(this.modelPath(modelFile)) ? this.modelPath(modelFile) : null,
    };
  }

  /**
   * Запустить процесс. opts: onStdout(buf), onLine(line, stream), cwd, signal (AbortSignal), stdoutRaw.
   * Возвращает {code, stdout, stderr} (stdout копится, если не передан onStdout).
   */
  run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!cmd) { reject(new Error('Программа не найдена')); return; }
      const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
      const out = [], err = [];
      let lineBuf = { stdout: '', stderr: '' };
      const lines = (stream, chunk) => {
        if (!opts.onLine) return;
        lineBuf[stream] += chunk.toString('utf8');
        const parts = lineBuf[stream].split(/\r?\n|\r/);
        lineBuf[stream] = parts.pop();
        for (const l of parts) if (l) opts.onLine(l, stream);
      };
      p.stdout.on('data', (b) => { if (opts.onStdout) opts.onStdout(b); else out.push(b); lines('stdout', b); });
      p.stderr.on('data', (b) => { err.push(b); if (err.length > 400) err.splice(0, 200); lines('stderr', b); });
      const abort = () => { try { p.kill(); } catch { /* уже завершён */ } };
      if (opts.signal) {
        if (opts.signal.aborted) abort();
        opts.signal.addEventListener('abort', abort, { once: true });
      }
      p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`Не найдена программа: ${path.basename(cmd)}`) : e));
      p.on('close', (code) => {
        if (opts.signal) opts.signal.removeEventListener('abort', abort);
        const res = { code, stdout: opts.onStdout ? null : Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
        if (opts.signal && opts.signal.aborted) { reject(Object.assign(new Error('Отменено'), { code: 'ABORT' })); return; }
        if (code !== 0 && !opts.allowFail) {
          const tail = res.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
          reject(Object.assign(new Error(`${path.basename(cmd)}: код ${code}\n${tail}`), { res }));
          return;
        }
        resolve(res);
      });
    });
  }
}

function findFile(dir, test, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && test(e.name)) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), test, depth + 1); if (f) return f; }
  return null;
}

/**
 * Скачать файл с прогрессом через fetch (в Electron — net.fetch: системный прокси/VPN работают).
 * fetchImpl(url) → Response. Пишем во временный файл и переименовываем, чтобы обрыв не оставил битый файл.
 */
async function download(fetchImpl, url, dest, onProgress, signal) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Скачивание ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const fh = fs.openSync(tmp, 'w');
  let got = 0, lastTick = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fh, Buffer.from(value));
      got += value.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 200) { lastTick = now; onProgress(total ? got / total : 0, got, total); }
    }
  } finally { fs.closeSync(fh); }
  fs.renameSync(tmp, dest);
  if (onProgress) onProgress(1, got, total);
  return dest;
}

/** Ссылка на сборку whisper.cpp для Windows из последнего релиза (с CUDA, если просили GPU). */
async function whisperAssetUrl(fetchImpl, gpu) {
  const r = await fetchImpl('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  const rel = await r.json();
  return pickWhisperAsset(rel.assets || [], gpu);
}
function pickWhisperAsset(assets, gpu) {
  const names = assets.map((a) => a.name);
  const cuda = assets.filter((a) => /cublas.*bin-x64\.zip$/i.test(a.name)).sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))[0];
  const cpu = assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name));
  const a = (gpu && cuda) || cpu;
  if (!a) throw new Error(`В релизе whisper.cpp нет сборки для Windows (${names.join(', ')})`);
  return a.browser_download_url;
}

module.exports = { runnable, Tools, download, whisperAssetUrl, pickWhisperAsset, findFile, unpacked, exe };
