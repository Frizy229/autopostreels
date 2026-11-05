'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeTheme, shell, safeStorage, nativeImage } = require('electron');
const { buildSnapshot, inspectFolder, captionFor, laneByKey, NETS } = require('./lib/core');
const { GitHub } = require('./lib/github');
const tiktok = require('./lib/tiktok');

const DEFAULTS = {
  repo: 'Frizy229/autopostreels', branch: 'main', theme: 'system', material: 'acrylic', tint: 55,
  alwaysOnTop: false, autostart: true, refreshMin: 5, scheduleTz: 'Asia/Tomsk', autoUpload: false, tab: 'instagram',
  bounds: null, tokenEnc: '', tokenPlain: '',
};
const win11 = process.platform === 'win32' && parseInt(os.release().split('.')[2] || '0', 10) >= 22621;

let win = null, tray = null, quitting = false;
const configPath = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { ...DEFAULTS };

function loadCfg() {
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { cfg = { ...DEFAULTS }; }
  if (cfg.scheduleTz === 'Europe/Moscow' && !cfg.tzMigrated) { cfg.scheduleTz = 'Asia/Tomsk'; cfg.tzMigrated = true; }
}
function saveCfg() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
const publicCfg = () => { const { tokenEnc, tokenPlain, ...rest } = cfg; return rest; };

function getToken() {
  try {
    if (cfg.tokenEnc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(cfg.tokenEnc, 'base64'));
  } catch { /* ignore */ }
  return cfg.tokenPlain || '';
}
function setToken(t) {
  cfg.tokenEnc = ''; cfg.tokenPlain = '';
  if (t) {
    if (safeStorage.isEncryptionAvailable()) cfg.tokenEnc = safeStorage.encryptString(t).toString('base64');
    else cfg.tokenPlain = t;
  }
  saveCfg();
}
const gh = () => {
  const t = getToken();
  if (!t) throw Object.assign(new Error('Не задан токен GitHub (Настройки → Подключение).'), { code: 'NO_TOKEN' });
  return new GitHub(t, cfg.repo, cfg.branch);
};

function applyAppearance() {
  nativeTheme.themeSource = cfg.theme;
  if (!win) return;
  win.setAlwaysOnTop(!!cfg.alwaysOnTop);
  if (win11) win.setBackgroundMaterial(cfg.material === 'none' ? 'none' : cfg.material);
  win.webContents.send('appearance', appearance());
}
const appearance = () => ({ material: win11 && cfg.material !== 'none' ? cfg.material : 'none', tint: cfg.tint, win11 });

function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!cfg.autostart });
  if (tray) tray.setContextMenu(trayMenu());
}

function createWindow() {
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 400, height: b.height || 720, x: b.x, y: b.y, minWidth: 340, minHeight: 480,
    frame: false, show: false, hasShadow: true, backgroundColor: '#00000000',
    ...(win11 && cfg.material !== 'none' ? { backgroundMaterial: cfg.material } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161c' : '#f2f3f8' }),
    alwaysOnTop: !!cfg.alwaysOnTop, title: 'Reels Widget', icon: path.join(__dirname, 'assets', 'icon.png'),
    skipTaskbar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('minimize', (e) => { e.preventDefault(); win.hide(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  const saveBounds = () => { if (win && !win.isMinimized()) { cfg.bounds = win.getBounds(); saveCfg(); } };
  let t; const later = () => { clearTimeout(t); t = setTimeout(saveBounds, 600); };
  win.on('resize', later); win.on('move', later);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const showWin = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.setSkipTaskbar(true); win.focus(); };
const trayMenu = () => Menu.buildFromTemplate([
  { label: 'Показать виджет', click: showWin },
  { label: 'Обновить данные', click: () => win && win.webContents.send('refresh') },
  { type: 'separator' },
  { label: 'Запускать вместе с Windows', type: 'checkbox', checked: !!cfg.autostart,
    click: (i) => { cfg.autostart = i.checked; saveCfg(); applyAutostart(); win && win.webContents.send('cfg', publicCfg()); } },
  { type: 'separator' },
  { label: 'Выход', click: () => { quitting = true; app.quit(); } },
]);

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Reels Widget');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWin()));
}

// ---------------------------------------------------------------- IPC
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
});

handle('cfg:get', () => ({ cfg: publicCfg(), hasToken: !!getToken(), appearance: appearance(), version: app.getVersion(), packaged: app.isPackaged }));
handle('cfg:set', (patch) => {
  const allowed = Object.keys(DEFAULTS).filter((k) => !['bounds', 'tokenEnc', 'tokenPlain'].includes(k));
  for (const k of allowed) if (k in patch) cfg[k] = patch[k];
  saveCfg();
  // перерисовывать окно и трогать автозапуск только когда меняли именно их (иначе окно мигает при переключении раздела)
  if (['theme', 'material', 'tint', 'alwaysOnTop'].some((k) => k in patch)) applyAppearance();
  if ('autostart' in patch) applyAutostart();
  return publicCfg();
});
handle('token:set', (t) => { setToken(String(t || '').trim()); return true; });
handle('conn:check', async () => gh().check());
// данные репозитория для обоих разделов (Instagram и TikTok)
let repoCfg = {};
handle('data:refresh', async () => {
  const g = gh();
  const [queues, state, stats, rc, creators] = await Promise.all([g.queues(), g.readJson('state.json'), g.readJson('stats.json'), g.readJson('config.json'), g.readJson('tiktok_creator.json')]);
  repoCfg = rc || {};
  const accList = (repoCfg.accounts || []).filter((a) => a && a.name);
  const accounts = accList.map((a) => a.name);
  const platforms = Object.fromEntries(accList.map((a) => [a.name, (a.platform || 'instagram').toLowerCase()]));
  const now = new Date();
  const nets = {};
  for (const net of NETS) nets[net] = buildSnapshot(state, stats, queues, now, { scheduleTz: cfg.scheduleTz, accounts, platforms, net });
  const all = buildSnapshot(state, stats, queues, now, { scheduleTz: cfg.scheduleTz, accounts, platforms });
  const tt = { pending: tiktok.pendingConfirm(queues, state, accList), creators: creators || {} };
  return {
    nets, nextNum: all.nextNum, tt, at: now.toISOString(),
    accounts: accList.map((a) => ({ name: a.name, platform: platforms[a.name], mode: a.platform === 'tiktok' ? (a.mode || 'inbox') : '' })),
    texts: repoCfg.texts || {}, paused: repoCfg.paused || [], hashtags: repoCfg.hashtags || '',
    window: { start: repoCfg.day_start || '10:00', end: repoCfg.day_end || '22:00', tz: repoCfg.timezone || cfg.scheduleTz },
  };
});
handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'], title: 'Папка с рилсами' });
  return r.canceled ? [] : r.filePaths;
});
// имена аккаунтов из config.json репозитория (для проверки подпапок); если не прочиталось, не проверяем
const accountNames = async (lane = 'shared') => {
  try {
    const accs = (((await gh().readJson('config.json')).accounts) || []).filter((a) => a && a.name);
    const net = laneByKey(lane).net;
    return accs.filter((a) => !net || (a.platform || 'instagram').toLowerCase() === net).map((a) => a.name);
  } catch { return []; }
};
handle('folder:inspect', async (p, lane) => {
  if (!fs.statSync(p).isDirectory()) throw new Error('Перетащи именно папку, а не отдельные файлы.');
  const { files, ...info } = inspectFolder(p, await accountNames(lane));
  return info;
});
handle('folder:upload', async (p, opts = {}) => gh().uploadFolder(p, (frac, text) => win && win.webContents.send('upload:progress', { frac, text }),
  await accountNames(opts.lane), { lane: opts.lane, texts: opts.texts }));
handle('folder:delete', async (name, lane) => gh().deleteFolder(String(name), lane));
handle('folder:texts', async (lane, name) => gh().folderTexts(lane, String(name)));
handle('folder:saveTexts', async (lane, name, texts) => { await gh().saveFolderTexts(lane, String(name), texts); return true; });
// тексты по умолчанию и пауза соцсети: в config.json репозитория (их читает автопостер)
handle('net:saveTexts', async (net, texts) => {
  if (!NETS.includes(net)) throw new Error('Неизвестная соцсеть.');
  const { cleanTexts } = require('./lib/core');
  const c = await gh().updateConfig((rc) => { rc.texts = rc.texts || {}; rc.texts[net] = cleanTexts(texts); }, `Тексты ${net} по умолчанию (виджет)`);
  repoCfg = c; return c.texts;
});
handle('net:pause', async (net, on) => {
  if (!NETS.includes(net)) throw new Error('Неизвестная соцсеть.');
  const c = await gh().updateConfig((rc) => {
    const s = new Set(rc.paused || []);
    if (on) s.add(net); else s.delete(net);
    rc.paused = [...s];
  }, `${on ? 'Пауза' : 'Снята пауза'}: ${net} (виджет)`);
  repoCfg = c; return c.paused;
});
// запуск автопостера на GitHub: post (сейчас по расписанию), check (проверить токены), один рилс сразу
handle('run', async (inputs) => {
  const action = ['post', 'check', 'dry-run'].includes(inputs && inputs.action) ? inputs.action : 'post';
  const only = String((inputs && inputs.only) || '').replace(/[^\p{L}\p{N}_.:/ -]/gu, '');
  return gh().dispatch(only ? { action, only } : { action });
});
// TikTok: просмотр ролика и подтверждение настроек перед прямой публикацией
handle('tt:preview', async (rel) => {
  // уникальное имя: иначе окно показывает из кэша прошлое видео с тем же адресом
  const dest = path.join(app.getPath('temp'), `reels-preview-${Date.now()}${path.extname(rel).toLowerCase() || '.mp4'}`);
  for (const f of fs.readdirSync(app.getPath('temp')).filter((n) => /^reels-preview/.test(n))) { try { fs.unlinkSync(path.join(app.getPath('temp'), f)); } catch { /* занято */ } }
  await gh().downloadVideo(rel, dest);
  return dest;
});
handle('tt:caption', async (rel, account) => {
  const t = await gh().readText(rel.replace(/\.[^./]+$/, '') + '.txt');
  return t ? captionFor(t, 'tiktok', account) : '';
});
handle('tt:confirm', async ({ path: p, form, creator }) => {
  const settings = tiktok.toSettings(form, creator); // повторная проверка на стороне программы
  await gh().saveTiktokSettings(p, settings);
  return true;
});
handle('open:url', (u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); return true; });
handle('win:hide', () => win.hide());
handle('win:quit', () => { quitting = true; app.quit(); });
handle('win:pin', (v) => { cfg.alwaysOnTop = !!v; saveCfg(); win.setAlwaysOnTop(cfg.alwaysOnTop); return cfg.alwaysOnTop; });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => {
    loadCfg();
    createWindow(); createTray(); applyAutostart(); applyAppearance();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {});
}
