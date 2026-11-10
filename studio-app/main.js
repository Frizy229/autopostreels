'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, net, session } = require('electron');
const { normalize, LANES, igOverride } = require('./lib/settings');
const { igAccounts } = require('./lib/igsearch');
const { LAYOUTS, FITS, CAM_LAYOUTS } = require('./lib/layout');
const handoff = require('./lib/handoff');
const OV = require('./lib/overlays');
const { SUB_STYLES, TITLE_STYLES } = require('./lib/subs');
const { BROWSERS, COOKIE_MODES, NET_MODES, proxyFromPac } = require('./lib/sources');
const { LLM_MODELS, llamaAssets } = require('./lib/llm');
const { Tools, download, whisperAssets, exe, errorTail, exitHint } = require('./lib/tools');
const { Pipeline } = require('./lib/pipeline');
const { MODELS, modelUrl } = require('./lib/transcribe');
const { channelUrl, filterLongs, mergeResults, isUrl } = require('./lib/sources');
const { ENCODERS } = require('./lib/render');

// Распознавание лиц в окне (Shape Detection API) — для автопоиска рамки вебки.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

const win11 = process.platform === 'win32' && parseInt(os.release().split('.')[2] || '0', 10) >= 22621;
const userData = () => app.getPath('userData');
const settingsPath = () => path.join(userData(), 'settings.json');
let settings = normalize({});
let win = null;
// прокси Windows для youtube.com (VPN-программы в режиме «системный прокси»); yt-dlp сам его не видит
let sysProxy = '';
async function refreshSysProxy() {
  try { sysProxy = proxyFromPac(await session.defaultSession.resolveProxy('https://www.youtube.com')); } catch { sysProxy = ''; }
  return sysProxy;
}

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
    catalog: { layouts: LAYOUTS, fits: FITS, camLayouts: CAM_LAYOUTS, subStyles: SUB_STYLES, titleStyles: TITLE_STYLES, lanes: LANES, browsers: BROWSERS, cookieModes: COOKIE_MODES, netModes: NET_MODES } }));
  handle('net:info', async () => ({ system: await refreshSysProxy() }));
  handle('net:test', async () => { await refreshSysProxy(); return pipeline.testYoutube(); });
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
    const st = tools.status((MODELS[settings.whisperModel] || MODELS.small).file, (LLM_MODELS[settings.llmModel] || LLM_MODELS['7b']).file);
    return { ...st, models: MODELS, llmModels: LLM_MODELS, encoders: Object.fromEntries(Object.entries(ENCODERS).map(([k, v]) => [k, v.name])) };
  });
  handle('tools:install', (what) => startJob('install', { ytdlp: 'yt-dlp', whisper: 'Распознавание речи', model: 'Модель речи', llama: 'Нейросеть (программа)', llm: 'Нейросеть (модель)' }[what] || what, async (progress, signal) => {
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
    if (what === 'llama') {
      if (process.platform !== 'win32') throw new Error('Готовая сборка есть только для Windows; на другой системе поставь llama-server сам.');
      const AdmZip = require('adm-zip');
      const dir = path.join(tools.binDir, 'llama');
      const zip = path.join(tools.binDir, 'llama.zip');
      const options = await llamaAssets(net.fetch, settings.gpu);
      const fails = [];
      for (const [k, a] of options.entries()) {
        const share = 1 / options.length;
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [i, f] of [a, ...a.extra].entries()) {
          await download(net.fetch, f.url, zip, (p) => progress((k + (i + p) / (1 + a.extra.length) * 0.9) * share, `Скачиваю ${f.name}`), signal);
          new AdmZip(zip).extractAllTo(dir, true);
          fs.rmSync(zip, { force: true });
        }
        if (!tools.llamaServer) { fails.push(`${a.name}: в архиве нет llama-server.exe`); continue; }
        const r = await tools.run(tools.llamaServer, ['--version'], { allowFail: true, signal, cwd: path.dirname(tools.llamaServer) })
          .catch((e) => { if (e.code === 'ABORT') throw e; return { code: -1, stderr: e.message }; });
        const said = `${r.stdout ? r.stdout.toString('utf8') : ''}\n${r.stderr || ''}`;
        if (r.code === 0 || /version|usage/i.test(said)) return `${a.name}${a.kind === 'cuda' ? ' (видеокарта)' : ' (процессор)'}`;
        fails.push(`${a.name} (код ${r.code}): ${exitHint(r.code) || errorTail(said) || 'без сообщения'}`);
      }
      throw new Error(`llama.cpp не запустился:\n${fails.join('\n')}`);
    }
    if (what === 'llm') {
      const m = LLM_MODELS[settings.llmModel] || LLM_MODELS['7b'];
      return download(net.fetch, m.url, tools.llmPath(m.file), (p, got, total) =>
        progress(p, `Скачиваю нейросеть ${settings.llmModel}: ${mb(got)} из ${mb(total)}`), signal);
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
    // ссылка на канал, плейлист или видео — как раньше, только по ней
    if (isUrl(String(q).trim()) || /^(?:www\.)?(twitch\.tv|youtube\.com)\//i.test(String(q).trim())) {
      const list = await pipeline.search(channelUrl(q), o.limit || 30, o.start || 1);
      return { results: filterLongs(list, { minDur: (o.minMin || 0) * 60, sort: o.sort || 'views' }), errors: {}, raw: list.length };
    }
    // «Показать ещё»: следующая страница YouTube (Twitch и Instagram приходят сразу целиком)
    if (o.start > 1) {
      const list = await pipeline.search(q, o.limit || 30, o.start);
      return { results: filterLongs(list, { minDur: (o.minMin || 0) * 60, sort: o.sort || 'views' }), errors: {}, raw: list.length };
    }
    const r = await pipeline.searchAll(q, { source: o.source || 'all', limit: o.limit || 30 });
    return { results: mergeResults(r.results, { minDur: (o.minMin || 0) * 60, sort: o.sort || 'views' }), errors: r.errors, raw: r.results.filter((e) => e.platform === 'youtube').length };
  });
  // поиск в Instagram: проверить токен, найти Instagram-аккаунт и сохранить (userId можно ввести вручную)
  handle('igsearch:setup', async (token, userId = '') => {
    const t = String(token || '').trim();
    if (!t) { settings = normalize({ ...settings, igSearch: {} }); saveSettings(); return { ok: true, cleared: true }; }
    let id = String(userId || '').trim(), username = '';
    if (!id) {
      const list = await igAccounts((...a) => net.fetch(...a), t);
      if (!list.length) throw new Error('Токен рабочий, но Instagram-аккаунт к нему не найден. Впиши ID аккаунта Instagram вручную (например, 17841431768361264).');
      ({ id, username } = list[0]);
    }
    settings = normalize({ ...settings, igSearch: { token: t, userId: id, username } });
    saveSettings();
    return { ok: true, userId: id, username };
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
  handle('overlay:preview', (item, opts) => pipeline.overlayPreview(item, opts || {}));
  handle('overlay:bg', (item) => pipeline.overlayBg(item));
  handle('overlay:meta', () => ({ fonts: Object.fromEntries(Object.entries(OV.FONTS).map(([k, v]) => [k, v.name])), aligns: OV.ALIGNS }));
  handle('project:frame', async (id, t) => `data:image/jpeg;base64,${(await pipeline.frame(id, t)).toString('base64')}`);
  handle('filler:search', (q, o = {}) => pipeline.searchFillers(q, { cc: !!o.cc, limit: o.limit || 30 }));
  handle('filler:list', () => pipeline.fillerLibrary());
  handle('filler:add', (list) => startJob('filler', 'Фон: скачиваю', (p, signal) => pipeline.addFillers(Array.isArray(list) ? list.slice(0, 50) : [], p, signal)));
  handle('filler:remove', (file) => pipeline.removeFiller(file));
  handle('project:analyze', (id, opts = {}) => startJob('analyze', opts.mode === 'zanos' ? 'Поиск заносов' : 'Поиск моментов', (p, signal) => pipeline.analyze(id, p, signal, { mode: opts.mode === 'zanos' ? 'zanos' : 'funny' }).then(slim)));
  handle('project:check', (id) => startJob('check', 'Проверка правил', (p, signal) => pipeline.check(id, p, signal).then(slim)));
  handle('project:clip', async (id, mid, margin = 0) => {
    // кусок для предпросмотра в окне (файл — как есть, ссылка — скачанный кусок); margin — запас вокруг для обрезки
    const pr = pipeline.get(id);
    const m = pr.moments.find((x) => x.id === mid);
    const pad = Math.min(60, Math.max(0, +margin || 0));
    const v = await pipeline.videoFor(pr, Math.max(0, m.start - pad), m.end + pad);
    return { src: fileUrl(v.input), start: m.start - v.offset, end: m.end - v.offset, offset: v.offset };
  });

  // сборка
  handle('build:start', (o) => startJob('build', o.mode === 'instagram' ? 'Сборка Instagram' : 'Сборка', (progress, signal) => pipeline.build({
    ...o, override: o.mode === 'instagram' ? igOverride(settings) : null, signal, onEvent: (e) => progress((e.i + (e.progress || 0)) / Math.max(1, e.total), `${e.stage}: ${e.label}`, { file: e.file, stage: e.stage, i: e.i, total: e.total }),
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
  // автопостер: папку грузит виджет (Reels Widget) — через общую папку %APPDATA%\Reels Handoff
  const hoDir = () => handoff.handoffDir(app.getPath('appData'));
  // очередь берём по папке, в которую легла сборка (queue / queue-instagram / queue-tiktok)
  handle('handoff:send', async (folder, opts = {}) => {
    // GitHub не принимает файлы больше ~95 МБ: тяжёлые ролики (старая версия, ручная папка) сжимаем перед отправкой
    const sh = await pipeline.shrinkLarge(folder);
    if (sh.failed.length) throw new Error(`Не удалось сжать до лимита GitHub (95 МБ):\n${sh.failed.slice(0, 3).join('\n')}`);
    return handoff.request(hoDir(), { folder, lane: handoff.laneOfQueue(path.basename(path.dirname(folder))), group: opts.group || '', name: path.basename(folder),
      postNow: !!opts.postNow, accounts: Array.isArray(opts.accounts) ? opts.accounts : [] });
  });
  handle('handoff:igAccounts', () => handoff.readAccounts(hoDir(), 'instagram'));
  handle('handoff:status', (id) => handoff.status(hoDir(), id));
  handle('handoff:accounts', () => handoff.readAccounts(hoDir(), handoff.laneOfQueue(settings.lane) === 'shared' ? '' : handoff.laneOfQueue(settings.lane), ''));   // «Сборка»: основная группа
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
  pipeline = new Pipeline({ tools, dataDir: userData(), fontsDir: fontsDir(), settings: () => settings, systemProxy: () => sysProxy, fetch: (...a) => net.fetch(...a) });
  refreshSysProxy();
  setInterval(refreshSysProxy, 60000);
  registerIpc();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
