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
    // В архивах whisper.cpp рядом с whisper-cli.exe лежит main.exe — заглушка, которая только пишет
    // «main is deprecated» и выходит с кодом 1. В Windows он находится первым (по алфавиту), поэтому ищем
    // whisper-cli везде, а main берём только в очень старых сборках, где whisper-cli ещё нет.
    const dir = path.join(this.binDir, 'whisper');
    return findFile(dir, (n) => n.toLowerCase() === exe('whisper-cli').toLowerCase())
      || which('whisper-cli')
      || findFile(dir, (n, d) => n.toLowerCase() === exe('main').toLowerCase() && !isDeprecationStub(path.join(d, n)));
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
      // PYTHONUTF8/PYTHONIOENCODING: yt-dlp (Python) пишет в UTF-8, а не в кодировке консоли Windows (cp1251/cp866)
      const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts.env || {}) };
      const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env });
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
          const lines = res.stderr.trim().split(/\r?\n/);
          // строки с ошибкой важнее служебного хвоста (у whisper в конце идут тайминги)
          const key = lines.filter((l) => /error|failed|not found|ошибк/i.test(l) && !/print_timings/.test(l)).slice(-3);
          const tail = (key.length ? key : lines.slice(-6)).join('\n');
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
  for (const e of entries) if (e.isFile() && test(e.name, dir)) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), test, depth + 1); if (f) return f; }
  return null;
}

/** main.exe-заглушка из whisper.cpp (examples/deprecation-warning): маленький файл с текстом «is deprecated». */
function isDeprecationStub(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 200 * 1024) return false;
    return fs.readFileSync(file).includes('is deprecated');
  } catch { return false; }
}

/** Короткий текст ошибки запуска из вывода программы: последние осмысленные строки. */
function errorTail(text, n = 3) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' · ').slice(0, 300);
}

/**
 * Что значит код выхода Windows-программы, которая не стартовала. Коды NTSTATUS приходят как большие числа
 * (или отрицательные): 0xC0000135 — нет DLL, 0xC000007B — DLL не той разрядности, 0xC0000139 — DLL не той версии.
 */
function exitHint(code) {
  const u = Number(code) >>> 0;
  const map = {
    0xC0000135: 'не хватает DLL (для видеокарты — CUDA-библиотек или драйвера NVIDIA; для любой сборки — Microsoft Visual C++ Redistributable x64)',
    0xC000007B: 'DLL не той разрядности (нужна x64)',
    0xC0000139: 'DLL не той версии (обнови драйвер NVIDIA или Visual C++ Redistributable)',
    0xC000001D: 'процессор не поддерживает нужные инструкции (AVX)',
    0xC0000005: 'программа упала при запуске',
  };
  return map[u] || '';
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

/**
 * Сборки whisper.cpp для Windows. В релизе с пометкой «Latest» (v1.x) лежат только исходники,
 * готовые программы — в пре-релизах bNNNN. Поэтому смотрим несколько последних релизов
 * и берём первый, где есть нужная сборка. Возвращает [{url, name, kind}] по порядку предпочтения.
 */
async function whisperAssets(fetchImpl, gpu) {
  const r = await fetchImpl('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20', { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  return pickWhisperAssets(await r.json(), gpu);
}

const cudaVer = (name) => { const m = /(?:cuda|cublas)-(\d+)(?:\.(\d+))?/i.exec(name); return m ? [+m[1], +(m[2] || 0)] : [0, 0]; };

/**
 * Из списка релизов: CUDA-сборка x64 (12.x — с ней работает драйвер любой RTX 20/30/40; 13.x — только самые новые драйверы),
 * затем процессорная (с BLAS быстрее). Без gpu — только процессорные.
 */
function pickWhisperAssets(releases, gpu) {
  const list = Array.isArray(releases) ? releases : [releases];
  for (const rel of list) {
    const assets = (rel && rel.assets) || [];
    const x64 = assets.filter((a) => /x64\.zip$/i.test(a.name) && !/arm64|win32/i.test(a.name));
    const cuda = x64.filter((a) => /cuda|cublas/i.test(a.name))
      .sort((a, b) => { const [ma, na] = cudaVer(a.name), [mb, nb] = cudaVer(b.name); const pa = ma === 12 ? 1 : 0, pb = mb === 12 ? 1 : 0; return pb - pa || mb - ma || nb - na; });
    const cpu = [x64.find((a) => /^whisper-blas-bin-x64\.zip$/i.test(a.name)), x64.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name))].filter(Boolean);
    if (!cpu.length && !cuda.length) continue;
    const out = [];
    if (gpu && cuda.length) out.push({ url: cuda[0].browser_download_url, name: cuda[0].name, kind: 'cuda' });
    for (const c of cpu) out.push({ url: c.browser_download_url, name: c.name, kind: 'cpu' });
    if (out.length) return out;
  }
  throw new Error('В последних релизах whisper.cpp нет сборки для Windows x64');
}

module.exports = { runnable, Tools, download, whisperAssets, pickWhisperAssets, findFile, isDeprecationStub, errorTail, exitHint, unpacked, exe };
