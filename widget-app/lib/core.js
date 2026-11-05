'use strict';
// Логика виджета без интерфейса: план дня, состояния папок, проверка папки перед загрузкой.
const fs = require('fs');
const path = require('path');

const VIDEO_EXT = new Set(['.mp4', '.mov']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png']);
const ALLOWED_EXT = new Set([...VIDEO_EXT, ...IMG_EXT, '.txt', '.srt']);
const LATE_MS = 15 * 60 * 1000;
const MAX_FILE = 95 * 1024 * 1024; // ограничение GitHub ~100 МБ на файл

const slug = (name) => {
  let s = String(name).trim().replace(/^\d+[_\- ]*/, '');
  s = s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');
  return s || 'reels';
};

/** Дата YYYY-MM-DD в заданном часовом поясе. */
const dayIn = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const num = (name) => { const m = /\d+/.exec(name); return m ? String(parseInt(m[0], 10)) : ''; };

/** Очереди: общая (во все аккаунты) и отдельные для каждой соцсети. Как lanes() в autoposter.py. */
const LANES = [
  { key: 'shared', net: '', dir: 'queue', posted: 'posted', prefix: '' },
  { key: 'instagram', net: 'instagram', dir: 'queue-instagram', posted: 'posted-instagram', prefix: 'instagram:' },
  { key: 'tiktok', net: 'tiktok', dir: 'queue-tiktok', posted: 'posted-tiktok', prefix: 'tiktok:' },
];
const NETS = ['instagram', 'tiktok'];
const laneByKey = (k) => LANES.find((l) => l.key === k) || LANES[0];
const laneOfId = (id) => LANES.slice(1).find((l) => String(id).startsWith(l.prefix)) || LANES[0];

/**
 * Собрать данные для экрана.
 * queues: {shared:[...], instagram:[...], tiktok:[...]} (или массив: только общая queue/),
 *   элемент: {name, videos:[имена файлов, в подпапках «аккаунт/файл.mp4»], texts?}.
 * opts: {scheduleTz, accounts:[имена], platforms:{имя: сеть}, net: 'instagram'|'tiktok' (раздел виджета)}
 */
function buildSnapshot(state, stats, queues, now = new Date(), opts = {}) {
  const scheduleTz = opts.scheduleTz || 'Europe/Moscow';
  state = state || {}; stats = stats || {};
  const Q = Array.isArray(queues) || !queues ? { shared: queues || [] } : queues;
  const posted = state.posted || {}, skipped = state.skipped || {};
  const postedAcc = state.posted_acc || {};
  const accNames = (opts.accounts && opts.accounts.length) ? opts.accounts : ['main'];
  const platformOf = (n) => ((opts.platforms || {})[n] || 'instagram').toLowerCase();
  const net = opts.net || '';
  const today = dayIn(now, scheduleTz);
  // какие очереди показываем: в разделе сети общая + своя, без раздела все
  const lanes = LANES.filter((l) => !net || !l.net || l.net === net);
  const slotOf = (l) => (l.net ? ((state.lanes || {})[l.net] || {}) : state);
  // аккаунты (индексы в общем списке): в разделе только аккаунты этой сети; в своей очереди сети только они
  const allIdx = accNames.map((_, i) => i).filter((i) => !net || platformOf(accNames[i]) === net);
  const laneIdx = (l) => allIdx.filter((i) => !l.net || platformOf(accNames[i]) === l.net);

  // время по плану для каждого видео (любой день), ключ «[сеть:]папка/файл»
  const planned = {};
  const todayFolders = new Set();
  for (const l of lanes) {
    const slot = slotOf(l);
    for (const [day, p] of Object.entries(slot.plans || {})) {
      for (const [name, when] of Object.entries(p.plan || {})) planned[`${l.prefix}${p.folder}/${name}`] = { when, day };
    }
    const tf = (slot.plans || {})[today] ? slot.plans[today].folder : (slot.active && slot.active.date === today ? slot.active.folder : null);
    if (tf) todayFolders.add(l.prefix + tf);
  }

  const metrics = (key) => {
    const s = stats[key] || {};
    return { views: s.views ?? null, likes: s.likes ?? null, comments: s.comments ?? null, reach: s.reach ?? null };
  };
  // состояние рилса в одном аккаунте (первый аккаунт хранится по-старому: state.posted, ключ без имени)
  const perAccount = (idx, key) => {
    const name = accNames[idx];
    const p = idx === 0 ? posted[key] : (postedAcc[name] || {})[key];
    const k2 = idx === 0 ? key : `${name}|${key}`;
    const st = stats[k2] || {};
    return {
      name, platform: platformOf(name) || (p && p.platform) || 'instagram', inbox: !!(p && p.mode === 'inbox'),
      status: p ? 'done' : (k2 in skipped ? 'skipped' : 'wait'), at: p ? p.at : null,
      permalink: st.permalink || (p && p.permalink) || '', comment: p ? (p.comment_id ? 'ok' : p.comment_error ? 'error' : '') : '',
      ...metrics(k2),
    };
  };
  // подпапка = аккаунт (имя подпапки равно имени аккаунта или содержит его, как в автопостере)
  const matchAcc = (sub) => {
    const n = String(sub).toLowerCase().replace(/^@/, '');
    const i = accNames.findIndex((a) => a.toLowerCase() === n);
    if (i >= 0) return i;
    let best = -1;
    accNames.forEach((a, j) => { if (n.includes(a.toLowerCase()) && (best < 0 || a.length > accNames[best].length)) best = j; });
    return best;
  };
  /** Рилс «папка/файл» в очереди l. null: к этому разделу не относится. */
  const video = (l, folder, name) => {
    const key = `${l.prefix}${folder}/${name}`;
    const pl = planned[key];
    const slash = name.indexOf('/');
    const allowed = laneIdx(l);
    let accounts, acc = '';
    if (slash > 0) {
      const idx = matchAcc(name.slice(0, slash));
      acc = idx >= 0 ? accNames[idx] : name.slice(0, slash);
      if (idx >= 0 && !allowed.includes(idx)) return null;  // подпапка аккаунта другой сети
      if (idx < 0 && net && !l.net) return null;             // неизвестная подпапка в общей очереди: не в разделах
      accounts = idx >= 0 ? [perAccount(idx, key)] : [];
    } else {
      if (!allowed.length && net) return null;
      accounts = allowed.map((i) => perAccount(i, key));
    }
    const first = accounts[0] || { status: 'wait', at: null, permalink: '', views: null, likes: null, comments: null, reach: null };
    const doneCount = accounts.filter((a) => a.status === 'done').length;
    const endCount = accounts.filter((a) => a.status === 'done' || a.status === 'skipped').length;
    let status = 'queued', at = null;
    if (accounts.length && doneCount === accounts.length) { status = 'done'; at = first.at; }
    else if (doneCount > 0) { status = endCount === accounts.length ? 'done' : 'part'; at = first.at || (accounts.find((a) => a.at) || {}).at || null; }
    else if (first.status === 'skipped' && accounts.every((a) => a.status === 'skipped')) { status = 'skipped'; at = pl ? pl.when : null; }
    else if (pl) { status = 'wait'; at = pl.when; }
    // «задерживается»: по плану время вышло больше 15 минут назад, а рилс ещё не вышел везде
    const late = (status === 'wait' || status === 'part') && !!pl && (now.getTime() - new Date(pl.when).getTime()) > LATE_MS;
    const withLink = accounts.find((a) => a.permalink) || {};
    return { key, id: key, lane: l.key, name: slash > 0 ? name.slice(slash + 1) : name, file: name, acc, status, at, late, accounts,
      permalink: first.permalink || withLink.permalink || '', views: first.views, likes: first.likes, comments: first.comments, reach: first.reach };
  };

  // все известные ключи по аккаунтам раздела (у остальных аккаунтов свои словари, пропуски с префиксом «аккаунт|»)
  const keySet = new Set();
  const idxSet = new Set(allIdx);
  if (idxSet.has(0)) for (const k of Object.keys(posted)) keySet.add(k);
  allIdx.filter((i) => i > 0).forEach((i) => { for (const k of Object.keys(postedAcc[accNames[i]] || {})) keySet.add(k); });
  for (const k of Object.keys(skipped)) {
    const m = /^([^/|]+)\|(.*)$/.exec(k);
    const idx = m ? accNames.indexOf(m[1]) : 0;
    if (idx >= 0 && (!net || idxSet.has(idx))) keySet.add(m ? m[2] : k);
  }
  const allKeys = [...keySet];

  const folders = [];
  const seen = new Set();
  const queueNames = [];
  for (const l of lanes) {
    for (const q of Q[l.key] || []) {
      const id = l.prefix + q.name;
      seen.add(id); queueNames.push(q.name);
      const names = new Set(q.videos);
      for (const k of allKeys) if (k.startsWith(id + '/')) names.add(k.slice(id.length + 1));
      const vids = [...names].sort().map((n) => video(l, q.name, n)).filter(Boolean);
      if (net && !vids.length && (q.videos || []).length) continue; // папка целиком для другой сети
      folders.push({ id, name: q.name, lane: l.key, shared: !l.net, texts: !!q.texts, kind: todayFolders.has(id) ? 'today' : 'queue', videos: vids });
    }
  }
  // папки, которые уже целиком опубликованы и переехали в posted/
  const doneIds = new Set();
  for (const k of allKeys) doneIds.add(k.split('/')[0]);
  const finished = [];
  for (const id of doneIds) {
    if (seen.has(id)) continue;
    const l = laneOfId(id);
    if (!lanes.includes(l)) continue;
    const name = id.slice(l.prefix.length);
    const names = new Set();
    for (const k of allKeys) if (k.startsWith(id + '/')) names.add(k.slice(id.length + 1));
    const vids = [...names].sort().map((n) => video(l, name, n)).filter(Boolean);
    if (!vids.length) continue;
    const last = vids.map((v) => v.at || '').sort().pop() || '';
    finished.push({ id, name, lane: l.key, shared: !l.net, kind: 'done', videos: vids, last });
  }
  finished.sort((a, b) => (b.last || '').localeCompare(a.last || ''));

  const rank = { today: 0, queue: 1 };
  folders.sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.name.localeCompare(b.name) || a.lane.localeCompare(b.lane));
  const all = [...folders, ...finished];
  for (const f of all) {
    f.total = f.videos.length;
    f.done = f.videos.filter((v) => v.status === 'done').length;
  }

  // план на сегодня (по всем очередям раздела)
  const todayRows = [];
  for (const l of lanes) {
    const tp = (slotOf(l).plans || {})[today];
    if (!tp) continue;
    for (const [name, when] of Object.entries(tp.plan || {})) {
      const v = video(l, tp.folder, name);
      if (!v) continue;
      // папку убрали из очереди (удалили): невышедшие рилсы из плана не показываем
      const removed = !seen.has(l.prefix + tp.folder);
      if (removed && !['done', 'part', 'skipped'].includes(v.status)) continue;
      // папку убрали, а рилс вышел не везде: он больше не выйдет, «задерживается» тут неправда
      todayRows.push({ ...v, ...(removed && v.status !== 'done' ? { late: false, removed: true } : {}), planAt: when, time: v.status === 'done' ? v.at : when, folder: tp.folder });
    }
  }
  todayRows.sort((a, b) => a.planAt.localeCompare(b.planAt));
  const nums = [...all.map((f) => f.name), ...queueNames, ...(opts.knownNames || [])]
    .map((n) => (/^(\d+)/.exec(n) || [0, 0])[1]).map(Number);
  const nextNum = Math.max(0, ...nums) + 1;
  const lateCount = todayRows.filter((r) => r.late).length;
  return { today, net, todayRows, folders: all, nextNum, summary: { ...summary(todayRows), late: lateCount } };
}

const TEXT_KEYS = ['caption', 'footer', 'hashtags', 'comment', 'use_pinned_comment'];
/** Тексты из формы: пустые поля убираем (значит «как в настройках сети»), лишние ключи отбрасываем. */
function cleanTexts(t) {
  const out = {};
  for (const k of TEXT_KEYS) {
    const v = (t || {})[k];
    if (typeof v === 'boolean') { if (v) out[k] = true; } else if (v != null && String(v).trim()) out[k] = String(v).trim();
  }
  return out;
}

const HEAD = /^[A-Z][A-Z0-9 ]*(?:\([^)\n]*\))?\s*:\s*$/;
/** Подпись из .txt как её возьмёт автопостер (caption_for): блок REELS CAPTION для аккаунта/сети, иначе общий, иначе весь текст. */
function captionFor(raw, platform = 'instagram', account = '') {
  const text = String(raw || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(REELS CAPTION[^\n]*):\s*$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !/^\s*COVER\b/i.test(lines[j]) && !HEAD.test(lines[j].trim()); j++) body.push(lines[j]);
    blocks.push([m[1], body.join('\n').trim()]);
  }
  const name = String(account).toLowerCase().replace(/^@/, '');
  if (name) { const b = blocks.find(([h]) => h.toLowerCase().includes(name)); if (b) return b[1]; }
  if (platform === 'tiktok') { const b = blocks.find(([h]) => /tiktok/i.test(h) && !h.includes('@')); if (b) return b[1]; }
  const plain = blocks.filter(([h]) => !h.includes('@') && !/tiktok/i.test(h));
  if (plain.length) return plain[0][1];
  if (blocks.length) return blocks[0][1];
  return text.split('\n').filter((l) => !/^\s*COVER\b/i.test(l)).join('\n').trim();
}

/**
 * Здоровье автопостера по последним запускам workflow «Публикация рилсов».
 * runs: [{status, conclusion, created_at, html_url}], новые сверху.
 * approval: GitHub не запускает workflow, пока человек не нажмёт «Approve and run» (conclusion action_required).
 */
function runHealth(runs, now = new Date()) {
  const list = (runs || []).filter((r) => r && r.status === 'completed');
  const lastOk = (list.find((r) => r.conclusion === 'success') || {}).created_at || null;
  const latest = list[0];
  if (!latest) return { ok: true, approval: false, lastOk, url: '' };
  const blocked = [];
  for (const r of list) { if (r.conclusion !== 'action_required') break; blocked.push(r); }
  const approval = blocked.length > 0;
  return { ok: !approval, approval, since: approval ? blocked[blocked.length - 1].created_at : null,
    count: blocked.length, lastOk, url: approval ? latest.html_url : '', minutes: lastOk ? Math.round((now - new Date(lastOk)) / 60000) : null };
}

function summary(rows) {
  if (!rows.length) return { text: 'На сегодня плана нет', done: 0, total: 0, next: null };
  const done = rows.filter((r) => r.status === 'done').length;
  const next = rows.find((r) => r.status === 'wait');
  return { text: `Сегодня ${done} из ${rows.length}`, done, total: rows.length, next: next ? next.planAt : null };
}

/** Проверка одной директории: видео, описания, обложки (без вложенных папок). */
function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const files = entries.map((e) => path.join(dir, e.name))
    .filter((p) => ALLOWED_EXT.has(path.extname(p).toLowerCase()) || path.basename(p) === 'texts.json').sort();
  const videos = files.filter((p) => VIDEO_EXT.has(path.extname(p).toLowerCase()));
  const images = files.filter((p) => IMG_EXT.has(path.extname(p).toLowerCase()));
  const noTxt = [], noCover = [];
  for (const v of videos) {
    const stem = path.basename(v, path.extname(v));
    const txt = path.join(dir, stem + '.txt');
    let named = '';
    if (fs.existsSync(txt)) {
      const m = /^\s*COVER[^:\n]*:\s*(\S+)/im.exec(fs.readFileSync(txt, 'utf8'));
      named = m ? m[1] : '';
    } else noTxt.push(path.basename(v));
    const n = num(stem);
    const has = (named && fs.existsSync(path.join(dir, named)))
      || images.some((i) => path.basename(i, path.extname(i)) === stem)
      || (n && images.some((i) => num(path.basename(i)) === n));
    if (!has) noCover.push(path.basename(v));
  }
  return { files, videos: videos.length, texts: videos.length - noTxt.length, covers: videos.length - noCover.length };
}

/**
 * Что лежит в папке: видео, описания, обложки, предупреждения и ошибки.
 * Два формата: плоская папка (все рилсы во все аккаунты) или папка с подпапками по аккаунтам.
 * accounts: имена аккаунтов из config.json (если известны, проверяем имена подпапок).
 */
function inspectFolder(dir, accounts = []) {
  const top = scanDir(dir);
  const groups = [];
  const files = [...top.files];
  const errors = [], warnings = [];
  const subs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  for (const sub of subs) {
    const g = scanDir(path.join(dir, sub));
    if (!g.files.length) { warnings.push(`Подпапка «${sub}» пустая, пропущу её.`); continue; }
    if (!g.videos) { warnings.push(`В подпапке «${sub}» нет видео, пропущу её.`); continue; }
    groups.push({ name: sub, videos: g.videos, texts: g.texts, covers: g.covers });
    files.push(...g.files);
    if (g.texts < g.videos) warnings.push(`${sub}: без описания ${g.videos - g.texts}`);
    if (g.covers < g.videos) warnings.push(`${sub}: без обложки ${g.videos - g.covers}`);
    if (accounts.length) {
      const n = sub.toLowerCase().replace(/^@/, '');
      if (!accounts.some((a) => n === a.toLowerCase() || n.includes(a.toLowerCase()))) {
        errors.push(`Подпапка «${sub}» не совпадает ни с одним аккаунтом (${accounts.join(', ')}). Назови её точно как аккаунт.`);
      }
    }
  }
  const videos = top.videos + groups.reduce((s, g) => s + g.videos, 0);
  const texts = top.texts + groups.reduce((s, g) => s + g.texts, 0);
  const covers = top.covers + groups.reduce((s, g) => s + g.covers, 0);
  const size = files.reduce((s, p) => s + fs.statSync(p).size, 0);
  const big = files.filter((p) => fs.statSync(p).size > MAX_FILE).map((p) => path.relative(dir, p));
  if (!videos) errors.push('В папке нет видео (.mp4 или .mov).');
  if (big.length) errors.push('Файлы больше 95 МБ GitHub не примет, сожми их: ' + big.join(', '));
  if (top.texts < top.videos) warnings.push(`Без описания: ${top.videos - top.texts} (подпись будет пустой)`);
  if (top.covers < top.videos) warnings.push(`Без обложки: ${top.videos - top.covers} (возьмётся кадр из видео)`);
  return { name: path.basename(dir), files, videos, texts, covers, size, groups, warnings, errors };
}

module.exports = { runHealth, slug, dayIn, buildSnapshot, summary, inspectFolder, captionFor, cleanTexts, LANES, NETS, laneByKey, laneOfId, VIDEO_EXT, MAX_FILE };
