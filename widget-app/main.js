'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeTheme, shell, safeStorage, nativeImage } = require('electron');
const { buildSnapshot, inspectFolder } = require('./lib/core');
const { GitHub } = require('./lib/github');

const DEFAULTS = {
  repo: 'Frizy229/autopostreels', branch: 'main', theme: 'system', material: 'acrylic', tint: 55,
  alwaysOnTop: false, autostart: true, refreshMin: 5, scheduleTz: 'Asia/Tomsk', autoUpload: false,
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
    width: b.width || 380, height: b.height || 700, x: b.x, y: b.y, minWidth: 320, minHeight: 420,
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
  saveCfg(); applyAppearance(); applyAutostart();
  return publicCfg();
});
handle('token:set', (t) => { setToken(String(t || '').trim()); return true; });
handle('conn:check', async () => gh().check());
handle('data:refresh', async () => {
  const g = gh();
  const [queue, state, stats, igCfg] = await Promise.all([g.queue(), g.readJson('state.json'), g.readJson('stats.json'), g.readJson('config.json')]);
  const accList = ((igCfg && igCfg.accounts) || []).filter((a) => a && a.name);
  const accounts = accList.map((a) => a.name);
  const platforms = Object.fromEntries(accList.map((a) => [a.name, (a.platform || 'instagram').toLowerCase()]));
  return { snapshot: buildSnapshot(state, stats, queue, new Date(), { scheduleTz: cfg.scheduleTz, accounts, platforms }), at: new Date().toISOString() };
});
handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Папка с рилсами' });
  return r.canceled ? null : r.filePaths[0];
});
handle('folder:inspect', (p) => {
  if (!fs.statSync(p).isDirectory()) throw new Error('Перетащи именно папку, а не отдельные файлы.');
  const { files, ...info } = inspectFolder(p);
  return info;
});
handle('folder:upload', async (p) => gh().uploadFolder(p, (frac, text) => win && win.webContents.send('upload:progress', { frac, text })));
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
