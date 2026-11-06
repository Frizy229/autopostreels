'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeTheme, shell, safeStorage, nativeImage } = require('electron');
const { buildSnapshot, inspectFolder, captionFor, laneByKey, runHealth, NETS } = require('./lib/core');
const { GitHub } = require('./lib/github');
const tiktok = require('./lib/tiktok');
const accounts = require('./lib/accounts');
const crypto = require('crypto');
const handoff = require('./lib/handoff');

const DEFAULTS = {
  repo: 'Frizy229/autopostreels', branch: 'main', theme: 'system', material: 'acrylic', tint: 55,
  alwaysOnTop: false, autostart: true, refreshMin: 5, scheduleTz: 'Asia/Tomsk', autoUpload: false, tab: 'instagram',
  bounds: null, tokenEnc: '', tokenPlain: '',
  // ключи приложений соцсетей (нужны только для входа при добавлении аккаунта), хранятся зашифрованными
  ttSecretEnc: '', igSecretEnc: '', igAppId: '',
  // приложение Meta для входа через Facebook (ID и секрет из «Настройки → Основное», конфигурация входа необязательна)
  fbAppId: '', fbSecretEnc: '', fbConfigId: '',
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
const PRIVATE = ['bounds', 'tokenEnc', 'tokenPlain', 'ttSecretEnc', 'igSecretEnc', 'fbSecretEnc'];
const publicCfg = () => { const rest = { ...cfg }; for (const k of PRIVATE) delete rest[k]; rest.hasTtSecret = !!cfg.ttSecretEnc; rest.hasIgSecret = !!cfg.igSecretEnc; rest.hasFbSecret = !!cfg.fbSecretEnc; return rest; };

function getToken() {
  try {
    if (cfg.tokenEnc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(cfg.tokenEnc, 'base64'));
  } catch { /* ignore */ }
  return cfg.tokenPlain || '';
}
// значения, которые храним зашифрованными (DPAPI Windows); если шифрования нет, с пометкой plain:
function encValue(v) {
  if (!v) return '';
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v).toString('base64') : `plain:${v}`;
}
function decValue(e) {
  if (!e) return '';
  if (e.startsWith('plain:')) return e.slice(6);
  try { return safeStorage.decryptString(Buffer.from(e, 'base64')); } catch { return ''; }
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
  const allowed = Object.keys(DEFAULTS).filter((k) => !PRIVATE.includes(k));
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
  const [queues, state, stats, rc, creators, runs, secretNames] = await Promise.all([g.queues(), g.readJson('state.json'), g.readJson('stats.json'), g.readJson('config.json'), g.readJson('tiktok_creator.json'), g.postRuns().catch(() => null), g.secretNames().catch(() => null)]);
  repoCfg = rc || {};
  const accList = (repoCfg.accounts || []).filter((a) => a && a.name);
  const accNames = accList.map((a) => a.name);
  const platforms = Object.fromEntries(accList.map((a) => [a.name, (a.platform || 'instagram').toLowerCase()]));
  const now = new Date();
  const nets = {};
  for (const net of NETS) nets[net] = buildSnapshot(state, stats, queues, now, { scheduleTz: cfg.scheduleTz, accounts: accNames, platforms, net });
  const all = buildSnapshot(state, stats, queues, now, { scheduleTz: cfg.scheduleTz, accounts: accNames, platforms });
  const tt = { pending: tiktok.pendingConfirm(queues, state, accList), creators: creators || {} };
  return {
    nets, nextNum: all.nextNum, tt, at: now.toISOString(), health: runs ? runHealth(runs, now) : null,
    accounts: (repoCfg.accounts || []).map((a, i) => a && a.name && ({
      name: a.name, platform: platforms[a.name], mode: a.platform === 'tiktok' ? (a.mode || 'inbox') : '',
      health: accounts.accountHealth(a, i, secretNames, (state || {}).tokens, now),
    })).filter(Boolean),
    canSecrets: Array.isArray(secretNames), repoSetup: { ttClientKey: !!repoCfg.tiktok_client_key, redirect: repoCfg.tiktok_redirect_uri || '', igAppId: repoCfg.instagram_app_id || cfg.igAppId || '', fbAppId: repoCfg.facebook_app_id || cfg.fbAppId || '' },
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
// ---------------------------------------------------------------- аккаунты: добавить кнопкой
// Вход в соцсеть открывается в отдельном окне с чистой сессией (каждый раз можно войти в другой аккаунт).
// Окно ловит переход на адрес возврата, забирает код и закрывается. Токены не попадают в окно виджета:
// они лежат здесь до сохранения и уходят на GitHub только зашифрованными.
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const logins = new Map(); // id -> { platform, secret, info, at }
let loginWin = null;
const dropOldLogins = () => { for (const [k, v] of logins) if (Date.now() - v.at > 30 * 60000) logins.delete(k); };

function oauthWindow(url, redirectUri, state) {
  return new Promise((resolve, reject) => {
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    const part = `login-${Date.now()}`; // без persist: сессия забывается, следующий вход начнётся с чистого листа
    const w = new BrowserWindow({ width: 480, height: 760, parent: win || undefined, title: 'Вход', autoHideMenuBar: true,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    loginWin = w;
    let done = false;
    // Google и Apple не пускают во встроенные окна программ («браузер небезопасен»): такой вход только в обычном браузере
    const blocked = (u) => {
      if (done || !accounts.needsBrowser(u)) return false;
      done = true;
      setImmediate(() => { if (!w.isDestroyed()) w.close(); });
      reject(Object.assign(new Error('Этот способ входа работает только в обычном браузере.'), { code: 'NEED_BROWSER' }));
      return true;
    };
    const finish = (u) => {
      if (blocked(u)) return true;
      if (done) return false;
      const r = accounts.parseRedirect(u, redirectUri, state);
      if (!r) return false;
      done = true;
      setImmediate(() => { if (!w.isDestroyed()) w.close(); });
      if (r.error) reject(new Error(r.error)); else resolve(r.code);
      return true;
    };
    const ses = w.webContents.session;
    ses.setUserAgent(CHROME_UA);
    // только переходы страницы: скрипты и фреймы Google на странице TikTok не считаются входом через Google
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: d.resourceType === 'mainFrame' ? finish(d.url) : !!accounts.parseRedirect(d.url, redirectUri, state) && finish(d.url) }));
    w.webContents.on('will-redirect', (e, u) => { if (finish(u)) e.preventDefault(); });
    w.webContents.on('will-navigate', (e, u) => { if (finish(u)) e.preventDefault(); });
    w.webContents.setWindowOpenHandler(({ url: u }) => { if (!finish(u)) w.loadURL(u); return { action: 'deny' }; });
    w.on('closed', () => { if (loginWin === w) loginWin = null; if (!done) { done = true; reject(Object.assign(new Error('Окно входа закрыто.'), { code: 'CANCELLED' })); } });
    w.loadURL(url, { userAgent: CHROME_UA });
  });
}

async function postForm(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  let j = {};
  try { j = await r.json(); } catch { /* пусто */ }
  return { ok: r.ok, status: r.status, j };
}
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  let j = {};
  try { j = await r.json(); } catch { /* пусто */ }
  return { ok: r.ok, status: r.status, j };
}

// TikTok
const ttSecret = () => decValue(cfg.ttSecretEnc);
async function ttExchange(code, redirectUri) {
  const key = repoCfg.tiktok_client_key, sec = ttSecret();
  const { ok, j } = await postForm('https://open.tiktokapis.com/v2/oauth/token/', { client_key: key, client_secret: sec, code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  if (!ok || !j.refresh_token) throw new Error(`TikTok не принял вход: ${j.error_description || j.error || 'ошибка'}. Код одноразовый, попробуй войти ещё раз.`);
  const u = await getJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { Authorization: `Bearer ${j.access_token}` });
  const user = (u.j && u.j.data && u.j.data.user) || {};
  const scopes = String(j.scope || '');
  return { secret: j.refresh_token, info: { platform: 'tiktok', open_id: user.open_id || j.open_id || '', display_name: user.display_name || '',
    suggested: accounts.suggestName(user.display_name), scopes, days: Math.round((j.refresh_expires_in || 0) / 86400),
    missing: ['video.upload'].filter((x) => !scopes.includes(x)) } };
}
function ttPrep() {
  const key = repoCfg.tiktok_client_key, redirect = repoCfg.tiktok_redirect_uri;
  if (!key || !redirect) throw new Error('В config.json репозитория нет tiktok_client_key / tiktok_redirect_uri (они есть в копии автопостера Alex).');
  if (!ttSecret()) throw Object.assign(new Error('Сначала впиши Client secret приложения TikTok.'), { code: 'NO_TT_SECRET' });
  const state = crypto.randomBytes(12).toString('hex');
  return { redirect, state, url: accounts.tiktokAuthUrl({ clientKey: key, redirectUri: redirect, state }) };
}

// Instagram (вход через Instagram, токены IGAA, живут 60 дней, продлевает workflow «Продление токена»)
const igSecret = () => decValue(cfg.igSecretEnc);
const igAppId = () => String(repoCfg.instagram_app_id || cfg.igAppId || '');
const igRedirect = () => String(repoCfg.instagram_redirect_uri || repoCfg.tiktok_redirect_uri || '');
async function igAccountsByToken(token) {
  if (/^EAA/.test(token)) {
    const r = await getJson(`https://graph.facebook.com/v23.0/me/accounts?fields=name,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Facebook не принял токен: ${(r.j.error && r.j.error.message) || r.status}`);
    return (r.j.data || []).filter((p) => p.instagram_business_account).map((p) => ({ user_id: p.instagram_business_account.id, username: p.instagram_business_account.username, page: p.name }));
  }
  const r = await getJson(`https://graph.instagram.com/v23.0/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`Instagram не принял токен: ${(r.j.error && r.j.error.message) || r.status}`);
  return [{ user_id: String(r.j.user_id || r.j.id || ''), username: r.j.username || '' }];
}
async function igExchange(code) {
  const a = await postForm('https://api.instagram.com/oauth/access_token', { client_id: igAppId(), client_secret: igSecret(), grant_type: 'authorization_code', redirect_uri: igRedirect(), code });
  const short = a.j.access_token || (a.j.data && a.j.data[0] && a.j.data[0].access_token);
  if (!a.ok || !short) throw new Error(`Instagram не принял вход: ${a.j.error_message || (a.j.error && a.j.error.message) || a.status}`);
  const b = await getJson(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(igSecret())}&access_token=${encodeURIComponent(short)}`);
  if (!b.ok || !b.j.access_token) throw new Error(`Instagram не выдал долгий токен: ${(b.j.error && b.j.error.message) || b.status}`);
  return b.j.access_token;
}

// Instagram через Facebook: один вход = все аккаунты Instagram со Страниц этого человека, токен EAA на 60 дней
// (его продлевает workflow «Продление токена», если в секретах есть FB_APP_ID и FB_APP_SECRET; виджет кладёт их сам)
const fbSecret = () => decValue(cfg.fbSecretEnc);
const fbAppId = () => String(repoCfg.facebook_app_id || cfg.fbAppId || '');
const fbConfigId = () => String(repoCfg.facebook_config_id || cfg.fbConfigId || '');
function fbPrep() {
  if (!fbAppId() || !fbSecret()) throw Object.assign(new Error('Сначала впиши ID и секрет приложения Meta (для входа через Facebook).'), { code: 'NO_FB_SECRET' });
  if (!igRedirect()) throw new Error('В config.json репозитория нет адреса возврата (tiktok_redirect_uri или instagram_redirect_uri).');
  const state = crypto.randomBytes(12).toString('hex');
  return { redirect: igRedirect(), state, url: accounts.facebookAuthUrl({ appId: fbAppId(), redirectUri: igRedirect(), state, configId: fbConfigId() }) };
}
const fbErr = (r) => (r.j && r.j.error && r.j.error.message) || r.status;
async function fbExchange(code) {
  const v = 'https://graph.facebook.com/v23.0/oauth/access_token';
  const a = await getJson(`${v}?${new URLSearchParams({ client_id: fbAppId(), client_secret: fbSecret(), redirect_uri: igRedirect(), code })}`);
  if (!a.ok || !a.j.access_token) throw new Error(`Facebook не принял вход: ${fbErr(a)}. Код одноразовый, войди ещё раз.`);
  const b = await getJson(`${v}?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: fbAppId(), client_secret: fbSecret(), fb_exchange_token: a.j.access_token })}`);
  if (!b.ok || !b.j.access_token) throw new Error(`Facebook не выдал долгий токен: ${fbErr(b)}`);
  const p = await getJson(`https://graph.facebook.com/v23.0/me/permissions?access_token=${encodeURIComponent(b.j.access_token)}`);
  const granted = ((p.j && p.j.data) || []).filter((x) => x.status === 'granted').map((x) => x.permission);
  const missing = ['instagram_basic', 'instagram_content_publish', 'pages_show_list'].filter((x) => granted.length && !granted.includes(x));
  return { token: b.j.access_token, days: Math.round((b.j.expires_in || 0) / 86400), missing };
}

function keepLogin(platform, secret, info) {
  dropOldLogins();
  const id = crypto.randomBytes(8).toString('hex');
  logins.set(id, { platform, secret, info, at: Date.now() });
  return { id, ...info };
}

handle('keys:set', ({ ttSecret: t, igSecret: i, igAppId: a, fbSecret: fs2, fbAppId: fa, fbConfigId: fc } = {}) => {
  if (t !== undefined) cfg.ttSecretEnc = encValue(String(t).trim());
  if (i !== undefined) cfg.igSecretEnc = encValue(String(i).trim());
  if (a !== undefined) cfg.igAppId = String(a).trim().replace(/\D/g, '');
  if (fs2 !== undefined) cfg.fbSecretEnc = encValue(String(fs2).trim());
  if (fa !== undefined) cfg.fbAppId = String(fa).trim().replace(/\D/g, '');
  if (fc !== undefined) cfg.fbConfigId = String(fc).trim().replace(/\D/g, '');
  saveCfg();
  return publicCfg();
});
if (process.env.REELS_WIDGET_TEST) global.__reelsTest = { oauthWindow }; // для проверки окна входа без настоящей соцсети

// вход: в окне виджета (по умолчанию) или в обычном браузере, тогда адрес страницы после входа вставляют руками
let pendingAuth = null;
function igPrep() {
  if (!igAppId() || !igRedirect()) throw Object.assign(new Error('Сначала впиши ID и секрет приложения Instagram.'), { code: 'NO_IG_SECRET' });
  if (!igSecret()) throw Object.assign(new Error('Сначала впиши секрет приложения Instagram.'), { code: 'NO_IG_SECRET' });
  const state = crypto.randomBytes(12).toString('hex');
  return { redirect: igRedirect(), state, url: accounts.instagramAuthUrl({ appId: igAppId(), redirectUri: igRedirect(), state }) };
}
async function finishLogin(platform, code, redirect) {
  if (platform === 'tiktok') {
    const { secret: rt, info } = await ttExchange(code, redirect);
    return keepLogin('tiktok', rt, info);
  }
  if (platform === 'facebook') {
    const { token, days, missing } = await fbExchange(code);
    const list = await igAccountsByToken(token);
    return keepLogin('instagram', token, { platform: 'instagram', via: 'facebook', days, missing,
      list: accounts.instagramChoices(list, (repoCfg && repoCfg.accounts) || []), suggested: (list[0] && list[0].username) || '' });
  }
  const token = await igExchange(code);
  const list = await igAccountsByToken(token);
  return keepLogin('instagram', token, { platform: 'instagram', list, suggested: (list[0] && list[0].username) || '' });
}
handle('acc:loginStart', async ({ platform, browser = false } = {}) => {
  if (!repoCfg || !Object.keys(repoCfg).length) repoCfg = await gh().readJson('config.json');
  const prep = platform === 'tiktok' ? ttPrep() : platform === 'facebook' ? fbPrep() : igPrep();
  pendingAuth = { platform, ...prep };
  if (browser) { shell.openExternal(prep.url); return { browser: true }; }
  let code;
  try { code = await oauthWindow(prep.url, prep.redirect, prep.state); } catch (e) {
    if (e.code !== 'NEED_BROWSER') throw e;
    shell.openExternal(prep.url); // та же ссылка входа в обычном браузере, адрес после входа вставят в виджет
    return { browser: true, reason: 'google' };
  }
  return finishLogin(platform, code, prep.redirect);
});
handle('acc:loginPasted', async (text) => {
  if (!pendingAuth) throw new Error('Сначала нажми «Открыть в браузере».');
  const r = accounts.parseRedirect(text, pendingAuth.redirect, pendingAuth.state);
  if (!r) throw new Error(`Это не тот адрес: нужен адрес, который начинается с ${pendingAuth.redirect}`);
  if (r.error) throw new Error(r.error);
  const { platform, redirect } = pendingAuth;
  pendingAuth = null; // код одноразовый
  return finishLogin(platform, r.code, redirect);
});
// Instagram: готовый токен (например, «Сгенерировать маркер» в кабинете Meta)
handle('acc:token', async (token) => {
  const t = String(token || '').trim();
  if (t.length < 30) throw new Error('Это не похоже на токен: вставь его целиком.');
  const list = await igAccountsByToken(t);
  if (!list.length) throw new Error('Токен рабочий, но к нему не привязан ни один аккаунт Instagram.');
  return keepLogin('instagram', t, { platform: 'instagram', via: /^EAA/.test(t) ? 'facebook' : 'instagram', suggested: list[0].username || '',
    list: accounts.instagramChoices(list, (repoCfg && repoCfg.accounts) || []) });
});
// сохранить: токен в секрет GitHub, аккаунт в config.json, недостающие общие секреты (ключ TikTok, GH_PAT) тоже
handle('acc:save', async ({ id, name, mode, userId } = {}) => {
  const l = logins.get(id);
  if (!l) throw new Error('Вход устарел: войди в аккаунт ещё раз.');
  const g = gh();
  const nick = accounts.cleanName(name);
  const rc = await g.readJson('config.json');
  const err = accounts.nameError(nick, rc.accounts || [], l.platform);
  if (err) throw new Error(err);
  const names = await g.secretNames();
  if (names === null) throw g.secretsError({ status: 403 });
  const entry = { name: nick, platform: l.platform, connected: new Date().toISOString().slice(0, 16) + 'Z' };
  if (l.platform === 'tiktok') { entry.open_id = l.info.open_id; entry.mode = mode === 'direct' ? 'direct' : 'inbox'; }
  else {
    const pick = (l.info.list || []).find((x) => x.user_id === userId) || (l.info.list || [])[0];
    if (!pick) throw new Error('Не выбран аккаунт Instagram.');
    entry.user_id = pick.user_id;
  }
  // имя секрета: прежнее, если аккаунт уже был (переподключение)
  const probe = JSON.parse(JSON.stringify(rc));
  const { account, replaced } = accounts.upsertAccount(probe, entry);
  const extra = [];
  await g.setSecret(account.token_env, l.secret);
  if (l.platform === 'tiktok' && !names.includes('TT_CLIENT_SECRET')) { await g.setSecret('TT_CLIENT_SECRET', ttSecret()); extra.push('TT_CLIENT_SECRET'); }
  // GH_PAT нужен автопостеру, чтобы самому сохранять обновлённые токены (TikTok меняет их при продлении, Instagram раз в 60 дней)
  if (!names.includes('GH_PAT')) { await g.setSecret('GH_PAT', getToken()); extra.push('GH_PAT'); }
  const c = await g.updateConfig((x) => {
    accounts.upsertAccount(x, entry);
    if (l.platform === 'instagram' && igAppId() && !x.instagram_app_id) x.instagram_app_id = igAppId();
  }, `${replaced ? 'Переподключён' : 'Добавлен'} аккаунт ${l.platform === 'tiktok' ? 'TikTok' : 'Instagram'} @${account.name} (виджет)`);
  repoCfg = c;
  logins.delete(id);
  return { name: account.name, secret: account.token_env, replaced, extra };
});
// Instagram пачкой (вход через Facebook): один токен на все выбранные аккаунты, у каждого свой секрет, один коммит config.json
handle('acc:saveMany', async ({ id, picks } = {}) => {
  const l = logins.get(id);
  if (!l || l.platform !== 'instagram') throw new Error('Вход устарел: войди ещё раз.');
  const g = gh();
  const rc = await g.readJson('config.json');
  const known = new Set((l.info.list || []).map((x) => String(x.user_id)));
  const chosen = (picks || []).filter((p) => known.has(String(p.user_id)));
  if (!chosen.length) throw new Error('Отметь хотя бы один аккаунт.');
  const { entries, errors } = accounts.planInstagramBatch(chosen, rc.accounts || []);
  if (errors.length) throw new Error(errors.join(' '));
  const names = await g.secretNames();
  if (names === null) throw g.secretsError({ status: 403 });
  const at = new Date().toISOString().slice(0, 16) + 'Z';
  const probe = JSON.parse(JSON.stringify(rc));
  const saved = [];
  for (const e of entries) {
    const { account, replaced } = accounts.upsertAccount(probe, { ...e, platform: 'instagram', connected: at });
    await g.setSecret(account.token_env, l.secret);
    saved.push({ name: account.name, secret: account.token_env, replaced });
  }
  const extra = [];
  if (!names.includes('GH_PAT')) { await g.setSecret('GH_PAT', getToken()); extra.push('GH_PAT'); }
  // для автопродления токенов Facebook (workflow «Продление токена»)
  if (l.info.via === 'facebook' && fbAppId() && fbSecret()) {
    if (!names.includes('FB_APP_ID')) { await g.setSecret('FB_APP_ID', fbAppId()); extra.push('FB_APP_ID'); }
    if (!names.includes('FB_APP_SECRET')) { await g.setSecret('FB_APP_SECRET', fbSecret()); extra.push('FB_APP_SECRET'); }
  }
  const added = saved.filter((x) => !x.replaced).map((x) => '@' + x.name), again = saved.filter((x) => x.replaced).map((x) => '@' + x.name);
  const c = await g.updateConfig((x) => {
    for (const e of entries) accounts.upsertAccount(x, { ...e, platform: 'instagram', connected: at });
    if (l.info.via === 'facebook' && fbAppId() && !x.facebook_app_id) x.facebook_app_id = fbAppId();
  }, `Instagram через Facebook: ${[added.length ? `добавлены ${added.join(', ')}` : '', again.length ? `обновлён вход ${again.join(', ')}` : ''].filter(Boolean).join('; ')} (виджет)`);
  repoCfg = c;
  logins.delete(id);
  return { saved, extra, days: l.info.days || 0 };
});
handle('acc:remove', async ({ name, platform } = {}) => {
  const g = gh();
  let gone = null;
  const c = await g.updateConfig((x) => { gone = accounts.removeAccount(x, name, platform); }, `Убран аккаунт @${name} (виджет)`);
  repoCfg = c;
  if (!gone) throw new Error(`Аккаунта @${name} уже нет в config.json.`);
  // секрет удаляем, только если его больше никто не использует
  const env = gone.token_env;
  const used = (c.accounts || []).some((a, i) => accounts.tokenEnvOf(a, i) === env);
  let secretGone = false;
  if (env && !used) secretGone = await g.deleteSecret(env).catch(() => false);
  return { secretGone, env };
});
// новая копия автопостера (например, у друга): очистить очереди и чужие аккаунты
const ORIGINAL_REPO = 'frizy229/autopostreels';
handle('repo:reset', async (confirmName) => {
  if (String(cfg.repo).toLowerCase() === ORIGINAL_REPO) throw new Error('Это основной репозиторий Alex: чистый старт здесь запрещён.');
  if (String(confirmName || '').trim().toLowerCase() !== String(cfg.repo).toLowerCase()) throw new Error(`Впиши точное имя репозитория: ${cfg.repo}`);
  return gh().resetCopy();
});
handle('open:url', (u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); return true; });
handle('win:hide', () => win.hide());
handle('win:quit', () => { quitting = true; app.quit(); });
handle('win:pin', (v) => { cfg.alwaysOnTop = !!v; saveCfg(); win.setAlwaysOnTop(cfg.alwaysOnTop); return cfg.alwaysOnTop; });

// ------------------------------------------------ папки из Reels Studio
// Studio кладёт заявку в %APPDATA%\Reels Handoff, виджет загружает папку в нужную очередь сам.
let handoffBusy = false, accountsAt = 0;
async function pollHandoff() {
  if (handoffBusy) return;
  const dir = handoff.handoffDir(app.getPath('appData'));
  // раз в 5 минут — список аккаунтов для Studio (каналы = аккаунты автопостера)
  if (Date.now() - accountsAt > 5 * 60e3 && getToken()) {
    accountsAt = Date.now();
    try { handoff.writeAccounts(dir, (await gh().readJson('config.json')).accounts); } catch { /* нет сети — в следующий раз */ }
  }
  const job = handoff.take(dir);
  if (!job) return;
  handoffBusy = true;
  const tell = (text, ok) => { if (win) win.webContents.send('handoff', { text, ok }); };
  try {
    if (!fs.existsSync(job.folder) || !fs.statSync(job.folder).isDirectory()) throw new Error(`Папки нет: ${job.folder}`);
    tell(`Reels Studio прислала папку ${path.basename(job.folder)}, загружаю…`, true);
    const dest = await gh().uploadFolder(job.folder, (frac, text) => {
      handoff.progress(dir, job.id, frac, text);
      if (win) win.webContents.send('upload:progress', { frac, text });
    }, await accountNames(job.lane), { lane: job.lane });
    handoff.finish(dir, job.id, { ok: true, dest });
    tell(`Загружено из Reels Studio: ${dest}`, true);
    if (win) win.webContents.send('refresh');
  } catch (e) {
    handoff.finish(dir, job.id, { ok: false, error: e.message, code: e.code || '' });
    tell(`Не загрузил папку из Reels Studio: ${e.message}`, false);
  } finally { handoffBusy = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => {
    loadCfg();
    createWindow(); createTray(); applyAutostart(); applyAppearance();
    setInterval(() => pollHandoff().catch(() => { handoffBusy = false; }), 3000);
    setInterval(() => handoff.cleanup(handoff.handoffDir(app.getPath('appData'))), 3600e3);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {});
}
