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

/**
 * Собрать данные для экрана.
 * queue: [{name, videos:[имена файлов]}] из папки queue/ на GitHub.
 * opts: {scheduleTz}
 */
function buildSnapshot(state, stats, queue, now = new Date(), opts = {}) {
  const scheduleTz = opts.scheduleTz || 'Europe/Moscow';
  state = state || {}; stats = stats || {};
  const posted = state.posted || {}, skipped = state.skipped || {}, plans = state.plans || {};
  const postedAcc = state.posted_acc || {};
  const accNames = (opts.accounts && opts.accounts.length) ? opts.accounts : ['main'];
  const today = dayIn(now, scheduleTz);

  // время по плану для каждого видео (любой день), ключ folder/name
  const planned = {};
  for (const [day, p] of Object.entries(plans)) {
    for (const [name, when] of Object.entries(p.plan || {})) planned[`${p.folder}/${name}`] = { when, day };
  }
  const todayFolder = plans[today] ? plans[today].folder : (state.active && state.active.date === today ? state.active.folder : null);

  const metrics = (key) => {
    const s = stats[key] || {};
    return { views: s.views ?? null, likes: s.likes ?? null, comments: s.comments ?? null, reach: s.reach ?? null };
  };
  // состояние рилса в одном аккаунте (первый аккаунт хранится по-старому: state.posted, ключ без имени)
  const perAccount = (name, idx, key) => {
    const p = idx === 0 ? posted[key] : (postedAcc[name] || {})[key];
    const skKey = idx === 0 ? key : `${name}|${key}`;
    const stKey = idx === 0 ? key : `${name}|${key}`;
    const st = stats[stKey] || {};
    return {
      name, status: p ? 'done' : (skKey in skipped ? 'skipped' : 'wait'), at: p ? p.at : null,
      permalink: st.permalink || (p && p.permalink) || '', ...metrics(stKey),
    };
  };
  // подпапка = аккаунт (имя подпапки равно имени аккаунта или содержит его, как в автопостере)
  const matchAcc = (sub) => {
    const n = String(sub).toLowerCase().replace(/^@/, '');
    let i = accNames.findIndex((a) => a.toLowerCase() === n);
    if (i >= 0) return i;
    let best = -1;
    accNames.forEach((a, j) => { if (n.includes(a.toLowerCase()) && (best < 0 || a.length > accNames[best].length)) best = j; });
    return best;
  };
  const video = (folder, name) => {
    const key = `${folder}/${name}`;
    const pl = planned[key];
    const slash = name.indexOf('/');
    let accounts, acc = '';
    if (slash > 0) {
      const idx = matchAcc(name.slice(0, slash));
      accounts = idx >= 0 ? [perAccount(accNames[idx], idx, key)] : [];
      acc = idx >= 0 ? accNames[idx] : name.slice(0, slash);
    } else accounts = accNames.map((n, i) => perAccount(n, i, key));
    const first = accounts[0] || { status: 'wait', at: null, permalink: '', views: null, likes: null, comments: null, reach: null };
    const doneCount = accounts.filter((a) => a.status === 'done').length;
    let status = 'queued', at = null;
    if (accounts.length && doneCount === accounts.length) { status = 'done'; at = first.at; }
    else if (doneCount > 0) { status = 'part'; at = first.at || (accounts.find((a) => a.at) || {}).at || null; }
    else if (first.status === 'skipped') { status = 'skipped'; at = pl ? pl.when : null; }
    else if (pl) { status = 'wait'; at = pl.when; }
    // «задерживается»: по плану время вышло больше 15 минут назад, а рилс ещё не вышел везде
    const late = (status === 'wait' || status === 'part') && !!pl && (now.getTime() - new Date(pl.when).getTime()) > LATE_MS;
    return { key, name: slash > 0 ? name.slice(slash + 1) : name, file: name, acc, status, at, late, accounts, permalink: first.permalink || (accounts.find((a) => a.permalink) || {}).permalink || '',
      views: first.views, likes: first.likes, comments: first.comments, reach: first.reach };
  };

  // все известные ключи «папка/файл» по всем аккаунтам (у остальных аккаунтов свои словари, пропуски с префиксом «аккаунт|»)
  const keySet = new Set(Object.keys(posted));
  for (const d of Object.values(postedAcc)) for (const k of Object.keys(d || {})) keySet.add(k);
  for (const k of Object.keys(skipped)) keySet.add(k.replace(/^[^/|]+\|/, ''));
  const allKeys = [...keySet];

  const folders = [];
  const seen = new Set();
  for (const q of queue || []) {
    seen.add(q.name);
    const names = new Set(q.videos);
    for (const k of allKeys) if (k.startsWith(q.name + '/')) names.add(k.slice(q.name.length + 1));
    const vids = [...names].sort().map((n) => video(q.name, n));
    folders.push({ name: q.name, kind: q.name === todayFolder ? 'today' : 'queue', videos: vids });
  }
  // папки, которые уже целиком опубликованы и переехали в posted/
  const doneNames = new Set();
  for (const k of allKeys) doneNames.add(k.split('/')[0]);
  const finished = [];
  for (const name of doneNames) {
    if (seen.has(name)) continue;
    const names = new Set();
    for (const k of allKeys) if (k.startsWith(name + '/')) names.add(k.slice(name.length + 1));
    const vids = [...names].sort().map((n) => video(name, n));
    const last = vids.map((v) => v.at || '').sort().pop() || '';
    finished.push({ name, kind: 'done', videos: vids, last });
  }
  finished.sort((a, b) => (b.last || '').localeCompare(a.last || ''));

  const rank = { today: 0, queue: 1 };
  folders.sort((a, b) => (rank[a.kind] - rank[b.kind]) || a.name.localeCompare(b.name));
  const all = [...folders, ...finished];
  for (const f of all) {
    f.total = f.videos.length;
    f.done = f.videos.filter((v) => v.status === 'done').length;
  }

  // план на сегодня
  const todayRows = [];
  const tp = plans[today];
  if (tp) {
    for (const [name, when] of Object.entries(tp.plan || {}).sort((a, b) => a[1].localeCompare(b[1]))) {
      const v = video(tp.folder, name);
      // папку убрали из очереди (удалили): невышедшие рилсы из плана не показываем
      if (!seen.has(tp.folder) && !['done', 'part', 'skipped'].includes(v.status)) continue;
      todayRows.push({ ...v, planAt: when, time: v.status === 'done' ? v.at : when, folder: tp.folder });
    }
  }
  const nextNum = Math.max(0, ...[...all.map((f) => f.name), ...(queue || []).map((q) => q.name)]
    .map((n) => (/^(\d+)/.exec(n) || [0, 0])[1]).map(Number)) + 1;
  const lateCount = todayRows.filter((r) => r.late).length;
  return { today, todayRows, folders: all, nextNum, summary: { ...summary(todayRows), late: lateCount } };
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
  const files = entries.map((e) => path.join(dir, e.name)).filter((p) => ALLOWED_EXT.has(path.extname(p).toLowerCase())).sort();
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

module.exports = { slug, dayIn, buildSnapshot, summary, inspectFolder, VIDEO_EXT, MAX_FILE };
