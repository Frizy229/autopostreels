'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, net } = require('electron');
const { normalize, LANES } = require('./lib/settings');
const { LAYOUTS } = require('./lib/layout');
const { SUB_STYLES, TITLE_STYLES } = require('./lib/subs');
const { BROWSERS, COOKIE_MODES } = require('./lib/sources');
const { Tools, download, whisperAssets, exe, errorTail, exitHint } = require('./lib/tools');
const { Pipeline } = require('./lib/pipeline');
const { MODELS, modelUrl } = require('./lib/transcribe');
const { channelUrl, filterLongs } = require('./lib/sources');
const { ENCODERS } = require('./lib/render');

// Распознавание лиц в окне (Shape Detection API) — для автопоиска рамки вебки.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

const win11 = process.platform === 'win32' && parseInt(os.release().split('.')[2] || '0', 10) >= 22621;
const userData = () => app.getPath('userData');
const settingsPath = () => path.join(userData(), 'settings.json');
let settings = normalize({});
let win = null;

function loadSettings() {
  try { settings = normalize(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))); } catch { settings = normalize({}); }
  if (!settings.outputDir) settings.outputDir = path.join(app.getPath('documents'), 'Reels Studio');
  // библиотека фона (мини-игры, залипательные видео): по умолчанию рядом с готовыми папками
  if (!settings.fillerDir) settings.fillerDir = path.join(app.getPath('documents'), 'Reels Studio', 'Фон');
}
function saveSettings() {
  fs.mkdirSync(userData(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

const fontsDir = () => path.join(__dirname, 'assets', 'fonts').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
let tools, pipeline;

// ------------------------------------------------------------------ задачи с прогрессом и отменой
const jobs = new Map();
function startJob(kind, label, fn) {
  const id = `${kind}-${Date.now().toString(36)}`;
  const ctrl = new AbortController();
  jobs.set(id, ctrl);
  const send = (patch) => { if (win && !win.isDestroyed()) win.webContents.send('job', { id, kind, label, ...patch }); };
  send({ progress: 0, text: 'Запуск' });
  Promise.resolve()
    .then(() => fn((progress, text, extra) => send({ progress, text, ...(extra || {}) }), ctrl.signal))
    .then((result) => send({ done: true, progress: 1, result }))
    .catch((e) => send({ done: true, error: e.code === 'ABORT' ? 'Отменено' : e.message, aborted: e.code === 'ABORT', rejected: e.rejected }))
    .finally(() => jobs.delete(id));
  return id;
}

// ------------------------------------------------------------------ окно
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1080, minHeight: 680, show: false,
    title: 'Reels Studio', icon: path.join(__dirname, 'assets', 'icon.png'),
    frame: false, titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#00000000', symbolColor: '#e8ebf2', height: 44 } : false,
    ...(win11 && settings.material !== 'none' ? { backgroundMaterial: settings.material, backgroundColor: '#00000000' } : { backgroundColor: '#101217' }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (process.env.STUDIO_SHOTS) {
    win.webContents.on('console-message', (_e, level, message, line, src) => console.log(`[окно] ${message} (${path.basename(src)}:${line})`));
    win.webContents.once('did-finish-load', () => shots(process.env.STUDIO_SHOTS).catch((e) => { console.error(e); app.exit(1); }));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

const appearance = () => ({ material: win11 && settings.material !== 'none' ? settings.material : 'none', win11, platform: process.platform });

// ------------------------------------------------------------------ IPC
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
});

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), appearance: appearance(), userData: userData(),
    catalog: { layouts: LAYOUTS, subStyles: SUB_STYLES, titleStyles: TITLE_STYLES, lanes: LANES, browsers: BROWSERS, cookieModes: COOKIE_MODES } }));
  handle('settings:get', () => settings);
  handle('settings:set', (patch) => {
    const prevMat = settings.material;
    settings = normalize({ ...settings, ...patch, texts: { ...settings.texts, ...((patch && patch.texts) || {}) }, rules: { ...settings.rules, ...((patch && patch.rules) || {}) } });
    saveSettings();
    if (patch && patch.material !== undefined && prevMat !== settings.material && win11 && win) win.setBackgroundMaterial(settings.material);
    if (patch && patch.theme) nativeTheme.themeSource = settings.theme;
    return settings;
  });

  // инструменты
  handle('tools:status', () => {
    const st = tools.status((MODELS[settings.whisperModel] || MODELS.small).file);
    return { ...st, models: MODELS, encoders: Object.fromEntries(Object.entries(ENCODERS).map(([k, v]) => [k, v.name])) };
  });
  handle('tools:install', (what) => startJob('install', { ytdlp: 'yt-dlp', whisper: 'Распознавание речи', model: 'Модель речи' }[what] || what, async (progress, signal) => {
    if (what === 'ytdlp') {
      const url = process.platform === 'win32' ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : process.platform === 'darwin' ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
      const dest = path.join(tools.binDir, exe('yt-dlp'));
      await download(net.fetch, url, dest, (p) => progress(p, 'Скачиваю yt-dlp'), signal);
      fs.chmodSync(dest, 0o755);
      return dest;
    }
    if (what === 'whisper') {
      if (process.platform !== 'win32') throw new Error('Готовая сборка есть только для Windows; на другой системе поставь whisper-cli сам.');
      const AdmZip = require('adm-zip');
      const dir = path.join(tools.binDir, 'whisper');
      const zip = path.join(tools.binDir, 'whisper.zip');
      const options = await whisperAssets(net.fetch, settings.gpu);
      const fails = [];
      for (const [k, a] of options.entries()) {
        const share = 1 / options.length;
        await download(net.fetch, a.url, zip, (p) => progress((k + p * 0.9) * share, `Скачиваю ${a.name}`), signal);
        fs.rmSync(dir, { recursive: true, force: true });
        new AdmZip(zip).extractAllTo(dir, true);
        fs.rmSync(zip, { force: true });
        if (!tools.whisper) { fails.push(`${a.name}: в архиве нет whisper-cli.exe`); continue; }
        // проверка запуском: CUDA-сборке нужны библиотеки и драйвер; не запустилась — берём следующую (процессорную)
        const r = await tools.run(tools.whisper, ['-h'], { allowFail: true, signal, cwd: path.dirname(tools.whisper) })
          .catch((e) => { if (e.code === 'ABORT') throw e; return { code: -1, stderr: e.message }; });
        const said = `${r.stdout ? r.stdout.toString('utf8') : ''}\n${r.stderr || ''}`;
        if (r.code === 0 || /usage:\s/i.test(said)) return `${a.name}${a.kind === 'cuda' ? ' (видеокарта)' : ' (процессор)'}`;
        const why = exitHint(r.code) || errorTail(said) || 'без сообщения';
        fails.push(`${a.name} (${path.basename(tools.whisper)}, код ${r.code}): ${why}`);
      }
      throw new Error(fails.length ? `whisper.cpp не запустился:\n${fails.join('\n')}` : 'Не удалось поставить whisper.cpp');
    }
    if (what === 'model') {
      const m = MODELS[settings.whisperModel] || MODELS.small;
      return download(net.fetch, modelUrl(settings.whisperModel), tools.modelPath(m.file), (p, got, total) =>
        progress(p, `Скачиваю модель ${settings.whisperModel}: ${mb(got)} из ${mb(total)}`), signal);
    }
    throw new Error('Неизвестный компонент');
  }));
  handle('tools:testEncoder', async (enc) => {
    const args = ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', ...ENCODERS[enc].args('fast'), '-f', 'null', '-'];
    const r = await tools.run(tools.ffmpeg, args, { allowFail: true });
    return { ok: r.code === 0, log: r.code === 0 ? '' : r.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') };
  });

  // источники
  handle('search', async (q, o = {}) => {
    const list = await pipeline.search(channelUrl(q), o.limit || 30);
    return filterLongs(list, { minDur: (o.minMin || 0) * 60, sort: o.sort || 'views' });
  });
  handle('project:addUrl', (url) => pipeline.addUrl(url));
  handle('project:addFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Видео стрима', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Видео', extensions: ['mp4', 'mkv', 'mov', 'webm', 'ts', 'flv', 'avi'] }] });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) out.push(await pipeline.addFile(f));
    return out;
  });
  handle('project:addPath', (p) => pipeline.addFile(p));
  handle('project:list', () => pipeline.list().map(slim));
  handle('project:get', (id) => pipeline.get(id));
  handle('project:update', (id, patch) => slim(pipeline.update(id, patch)));
  handle('project:remove', (id) => pipeline.remove(id));
  handle('project:addMoment', (id, s, e) => pipeline.addMoment(id, s, e));
  handle('project:frame', async (id, t) => `data:image/jpeg;base64,${(await pipeline.frame(id, t)).toString('base64')}`);
  handle('filler:search', (q, o = {}) => pipeline.searchFillers(q, { cc: !!o.cc, limit: o.limit || 30 }));
  handle('filler:list', () => pipeline.fillerLibrary());
  handle('filler:add', (list) => startJob('filler', 'Фон: скачиваю', (p, signal) => pipeline.addFillers(Array.isArray(list) ? list.slice(0, 50) : [], p, signal)));
  handle('filler:remove', (file) => pipeline.removeFiller(file));
  handle('project:analyze', (id) => startJob('analyze', 'Поиск моментов', (p, signal) => pipeline.analyze(id, p, signal).then(slim)));
  handle('project:check', (id) => startJob('check', 'Проверка правил', (p, signal) => pipeline.check(id, p, signal).then(slim)));
  handle('project:clip', async (id, mid) => {
    // кусок для предпросмотра в окне (файл — как есть, ссылка — скачанный кусок)
    const pr = pipeline.get(id);
    const m = pr.moments.find((x) => x.id === mid);
    const v = await pipeline.videoFor(pr, m.start, m.end);
    return { src: fileUrl(v.input), start: m.start - v.offset, end: m.end - v.offset };
  });

  // сборка
  handle('build:start', (o) => startJob('build', 'Сборка', (progress, signal) => pipeline.build({
    ...o, signal, onEvent: (e) => progress((e.i + (e.progress || 0)) / Math.max(1, e.total), `${e.stage}: ${e.label}`, { file: e.file, stage: e.stage, i: e.i, total: e.total }),
  })));
  handle('job:cancel', (id) => { const c = jobs.get(id); if (c) c.abort(); return !!c; });

  // система
  handle('dialog:folder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title, filters) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: Array.isArray(filters) ? filters : undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('open:log', () => {
    const f = path.join(userData(), 'logs', 'yt-dlp.txt');
    if (!fs.existsSync(f)) return false;
    shell.showItemInFolder(f);
    return true;
  });
  handle('open:path', (p) => shell.openPath(p));
  handle('open:show', (p) => shell.showItemInFolder(p));
  handle('open:url', (u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); });
}

const slim = (pr) => ({ ...pr, moments: (pr.moments || []).map(({ words, ...m }) => ({ ...m, wordCount: words ? words.length : null })) });
const mb = (b) => `${Math.round((b || 0) / 1048576)} МБ`;
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');

/** Снимки всех страниц для проверки интерфейса (только при STUDIO_SHOTS=папка). */
async function shots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  await wait(1500);
  const js = (code) => win.webContents.executeJavaScript(code);
  for (const p of (process.env.STUDIO_PAGES || 'search,projects,edit,channels,build,settings').split(',')) {
    await js(`go(${JSON.stringify(p)})`);
    await wait(1200);
    if (p === 'projects' && process.env.STUDIO_FRAMER) { await js(`openFramer(S.project)`); await wait(1800); }
    if (process.env[`STUDIO_JS_${p}`]) { await js(process.env[`STUDIO_JS_${p}`]); await wait(600); }  // подготовка демо-данных для снимка
    fs.writeFileSync(path.join(dir, `${p}.png`), (await win.webContents.capturePage()).toPNG());
    if (p === 'projects' && process.env.STUDIO_FRAMER) await js(`document.querySelector('#fx').click()`);
  }
  if (process.env.STUDIO_BUILD) {
    await js(`go('build')`); await wait(800);
    await js(`document.querySelector('#go').click()`);
    for (let k = 0; k < 240; k++) { await wait(1000); if (await js('!!(S.build && S.build.done)')) break; }
    await wait(800);
    fs.writeFileSync(path.join(dir, 'build-done.png'), (await win.webContents.capturePage()).toPNG());
    console.log('СБОРКА', JSON.stringify(await js('({error: S.build.error, result: S.build.result})')));
  }
  const errs = await js('window.__errors || []');
  fs.writeFileSync(path.join(dir, 'errors.json'), JSON.stringify(errs));
  app.quit();
}

app.whenReady().then(() => {
  loadSettings();
  nativeTheme.themeSource = settings.theme;
  tools = new Tools(path.join(userData(), 'bin'));
  pipeline = new Pipeline({ tools, dataDir: userData(), fontsDir: fontsDir(), settings: () => settings });
  registerIpc();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
