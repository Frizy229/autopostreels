'use strict';
// Передача готовых папок из Reels Studio в виджет автопостера через общую папку на компьютере.
// Studio кладёт заявку <id>.req.json, виджет забирает её (<id>.work.json), грузит папку в очередь на GitHub
// и пишет ответ <id>.done.json. Второй токен GitHub в Studio не нужен, грузит виджет.
// Этот файл одинаковый в studio-app/lib и widget-app/lib.

const fs = require('fs');
const path = require('path');

const LANE_KEYS = ['shared', 'instagram', 'tiktok'];
/** Папка обмена: %APPDATA%\Reels Handoff (одна на обе программы). */
const handoffDir = (appData) => path.join(appData, 'Reels Handoff');

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Studio: заявка на загрузку папки. Возвращает id. */
function request(dir, { folder, lane = 'shared', group = '', name = '', postNow = false, accounts = [] }, now = Date.now()) {
  if (!folder) throw new Error('Нет папки для отправки');
  if (!LANE_KEYS.includes(lane)) throw new Error(`Неизвестная очередь: ${lane}`);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  writeJson(path.join(dir, `${id}.req.json`), { id, folder, lane, ...(group ? { group: String(group) } : {}), name, postNow: !!postNow, accounts: (accounts || []).map(String), at: new Date(now).toISOString() });
  return id;
}

/** Studio: состояние заявки — waiting (виджет ещё не взял), working, done {ok, dest|error}. */
function status(dir, id) {
  const done = readJson(path.join(dir, `${id}.done.json`));
  if (done) return { state: 'done', ...done };
  if (fs.existsSync(path.join(dir, `${id}.work.json`))) return { state: 'working', ...(readJson(path.join(dir, `${id}.work.json`)) || {}) };
  if (fs.existsSync(path.join(dir, `${id}.req.json`))) return { state: 'waiting' };
  return { state: 'missing' };
}

/** Виджет: взять следующую заявку (переименованием, чтобы не взять дважды). null, если заявок нет. */
function take(dir) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.req.json')).sort(); } catch { return null; }
  for (const n of names) {
    const id = n.slice(0, -'.req.json'.length);
    const work = path.join(dir, `${id}.work.json`);
    try { fs.renameSync(path.join(dir, n), work); } catch { continue; }
    const req = readJson(work);
    if (req && req.folder) return { ...req, id };
    finish(dir, id, { ok: false, error: 'Заявка повреждена' });
  }
  return null;
}

/** Виджет: прогресс загрузки (Studio показывает его у себя). */
function progress(dir, id, frac, text) {
  const work = path.join(dir, `${id}.work.json`);
  const cur = readJson(work);
  if (cur) writeJson(work, { ...cur, frac, text });
}

/** Виджет: ответ по заявке. */
function finish(dir, id, result) {
  writeJson(path.join(dir, `${id}.done.json`), { id, ...result, at: new Date().toISOString() });
  fs.rmSync(path.join(dir, `${id}.work.json`), { force: true });
}

/** Убрать старые ответы (старше суток), чтобы папка не росла. */
function cleanup(dir, now = Date.now(), maxAgeMs = 24 * 3600e3) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of names.filter((x) => x.endsWith('.done.json'))) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.rmSync(p, { force: true }); n++; } } catch { /* ignore */ }
  }
  return n;
}

/** Виджет: список аккаунтов автопостера [{name, platform}] — Studio берёт из него каналы. */
function writeAccounts(dir, accounts, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const list = (accounts || []).filter((a) => a && a.name).map((a) => ({ name: String(a.name), platform: String(a.platform || 'instagram').toLowerCase() }));
  writeJson(path.join(dir, 'accounts.json'), { at: new Date(now).toISOString(), accounts: list });
  return list.length;
}
/** Studio: аккаунты из виджета или null, если виджет их ещё не записал. platform: 'instagram' | 'tiktok' | '' (все). */
function readAccounts(dir, platform = '') {
  const o = readJson(path.join(dir, 'accounts.json'));
  if (!o || !Array.isArray(o.accounts)) return null;
  return { at: o.at, accounts: o.accounts.filter((a) => !platform || a.platform === platform) };
}

/**
 * Что опубликовать сразу после загрузки: первый ролик каждого аккаунта (подпапки) — для --only автопостера.
 * dest: «queue-instagram/007_x». Без аккаунтов — первый ролик папки.
 */
function postNowOnly(dest, accounts = []) {
  const folder = String(dest).split('/').pop();
  return (accounts.length ? accounts.map((a) => `${folder}/${a}/`) : [`${folder}/`]).join(',');
}

/** Очередь Studio (queue, queue-instagram, queue-tiktok) → очередь виджета. */
const laneOfQueue = (q) => ({ queue: 'shared', 'queue-instagram': 'instagram', 'queue-tiktok': 'tiktok' }[q] || 'shared');

module.exports = { LANE_KEYS, handoffDir, request, status, take, progress, finish, cleanup, writeAccounts, readAccounts, laneOfQueue, postNowOnly };
