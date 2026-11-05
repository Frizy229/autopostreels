'use strict';
const $ = (id) => document.getElementById(id);
// window.api отдаёт {ok, data, error, code}: превращаем обратно в данные или ошибку с кодом
const unwrap = (r) => {
  if (!r || !r.__ipc) return r;
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.data;
};
const bridge = Object.fromEntries(Object.entries(window.api).map(([k, f]) => [k, typeof f !== 'function' ? f : (...args) => {
  const res = f(...args);
  return res && typeof res.then === 'function' ? res.then(unwrap) : res;
}]));
const LABEL = { done: 'вышел', part: 'частично', late: 'задерживается', wait: 'ждёт', skipped: 'пропущен', queued: 'в очереди' };
const NET_NAME = { instagram: 'Instagram', tiktok: 'TikTok' };
const LANE_DIR = { shared: 'queue', instagram: 'queue-instagram', tiktok: 'queue-tiktok' };
const TZ_NAME = { 'Europe/Moscow': 'Москва', 'Asia/Tomsk': 'Томск', 'Europe/Kaliningrad': 'Калининград', 'Asia/Yekaterinburg': 'Екатеринбург',
  'Asia/Novosibirsk': 'Новосибирск', 'Asia/Vladivostok': 'Владивосток', UTC: 'UTC' };

let cfg = {}, hasToken = false, version = '', data = null, timer = null, busy = false;
let net = 'instagram';
let pending = [], dragDepth = 0;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* без памяти окна */ } },
};
const openSet = new Set(store.get('open', []));
let doneOpen = store.get('doneOpen', false) === true;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (name) => (String(name).trim().replace(/^\d+[_\- ]*/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '')) || 'reels';
const pad3 = (n) => String(n).padStart(3, '0');
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—');
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c}`; };
const nf = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU'));
const snap = () => (data && data.nets && data.nets[net]) || null;
const netAccounts = (n = net) => ((data && data.accounts) || []).filter((a) => a.platform === n);
const isPaused = (n = net) => ((data && data.paused) || []).includes(n);

function toast(text, ms = 3400) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------ шапка
function tick() {
  const now = new Date();
  const tz = cfg.scheduleTz || 'Asia/Tomsk';
  $('clockLocal').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sched = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const w = data && data.window;
  $('clockSub').textContent = `Расписание: ${TZ_NAME[tz] || tz} ${sched}${w ? ` · окно ${w.start}–${w.end}` : ''}`;
  const d = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('dateLine').textContent = d.charAt(0).toUpperCase() + d.slice(1);
}

// ------------------------------------------------------------ вкладки
function setNet(n, save = true) {
  if (!NET_NAME[n]) n = 'instagram';
  const changed = n !== net;
  net = n;
  document.body.dataset.net = n;
  for (const b of document.querySelectorAll('.tab')) { const on = b.dataset.net === n; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
  if (changed) { const m = $('scroll'); m.classList.remove('fade'); void m.offsetWidth; m.classList.add('fade'); m.scrollTop = 0; }
  if (save && changed) bridge.setConfig({ tab: n }).then((c) => { cfg = c; }).catch(() => {});
  render();
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setNet(b.dataset.net); });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === '1' || e.key === '2')) { setNet(e.key === '1' ? 'instagram' : 'tiktok'); e.preventDefault(); }
  if (e.key === 'F5') { refresh(); e.preventDefault(); }
  if (e.key === 'Escape') closeTop();
});

// ------------------------------------------------------------ список
const IC = {
  v: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  l: '<svg viewBox="0 0 24 24"><path d="M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20z"/></svg>',
  c: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  txt: '<svg class="tx" viewBox="0 0 24 24"><path d="M5 6h14M5 12h10M5 18h7"/></svg>',
};
const nums = (o) => `<span title="просмотры">${IC.v}<b>${nf(o.views)}</b></span><span title="лайки">${IC.l}<b>${nf(o.likes)}</b></span><span title="комментарии">${IC.c}<b>${nf(o.comments)}</b></span>`;
const cm = (a) => (a.comment === 'ok' ? '<span class="cm" title="авто-комментарий добавлен">✓ коммент.</span>'
  : a.comment === 'error' ? '<span class="cm bad" title="комментарий не добавился: нет разрешения instagram_manage_comments">! коммент.</span>' : '');
function metrics(v) {
  if (v.status !== 'done' && v.status !== 'part') return '';
  const accs = v.accounts || [];
  const line = (a) => {
    const url = a.permalink ? ` data-url="${esc(a.permalink)}"` : '';
    const an = accs.length > 1 ? `<span class="an" title="${esc(a.name)}">${esc(a.name)}</span>` : '';
    if (a.status !== 'done') return `<div class="m off">${an}<span>${a.status === 'skipped' ? 'пропущен' : 'ждёт'}</span></div>`;
    if (a.platform === 'tiktok') return `<div class="m"${url}>${an}<span>${a.inbox ? 'в черновиках TikTok' : 'вышел'}</span></div>`;
    return `<div class="m"${url}>${an}${nums(a)}${cm(a)}</div>`;
  };
  return accs.map(line).join('');
}
const canPostNow = (v) => ['queued', 'wait', 'part'].includes(v.status); // любое невышедшее
function rowHtml(v, sub) {
  const url = v.permalink ? ` data-url="${esc(v.permalink)}"` : '';
  const chip = v.late ? LABEL.late : v.removed ? 'папка убрана' : v.status === 'part' ? `${(v.accounts || []).filter((a) => a.status === 'done').length}/${(v.accounts || []).length}` : LABEL[v.status];
  const now = canPostNow(v) ? `<button class="now-btn" data-now="${esc(v.id)}" title="Опубликовать сейчас">${IC.bolt}</button>` : '';
  return `<div class="row-card ${v.late ? 'late' : v.status}${v.permalink ? ' link' : ''}"${url}>
    <span class="t">${timeOf(v.time || v.at)}</span>
    <div class="nm">${esc(v.name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${metrics(v)}</div>
    ${now}<span class="chip ${v.late ? 'late' : v.status}">${chip}</span></div>`;
}
function folderHtml(f) {
  const pct = f.total ? Math.round((f.done / f.total) * 100) : 0;
  const open = openSet.has(f.id) ? ' open' : '';
  const badges = (f.kind === 'today' ? '<span class="chip today">сегодня</span>' : '') + (f.shared ? '<span class="chip both" title="общая очередь queue/: во все аккаунты обеих сетей">обе сети</span>' : '');
  const tools = f.kind === 'done' ? '' : `<button class="ibtn fbtn" data-ftexts="${esc(f.id)}" title="Тексты папки">${IC.pen}</button><button class="ibtn fbtn del" data-del="${esc(f.id)}" title="Убрать папку из очереди">${IC.trash}</button>`;
  return `<div class="folder${open}" data-id="${esc(f.id)}">
    <div class="f-head">${IC.chev}
      <div class="f-main"><div class="f-name"><span>${esc(f.name)}</span>${f.texts ? IC.txt : ''}</div>
        <div class="f-sub"><div class="prog"><i style="width:${pct}%"></i></div>${badges}</div></div>
      <span class="f-count">${f.done}/${f.total}</span>${tools}</div>
    <div class="f-body"><div class="f-inner"><div>${folderRows(f)}</div></div></div></div>`;
}
// рилсы папки; если папка разложена по аккаунтам, показываем группами
function folderRows(f) {
  if (!f.videos.length) return '<div class="empty">Нет роликов для этой сети.</div>';
  if (!f.videos.some((v) => v.acc)) return f.videos.map((v) => rowHtml(v)).join('');
  const groups = new Map();
  for (const v of f.videos) { const k = v.acc || 'все аккаунты'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
  return [...groups].map(([acc, vs]) => `<div class="grp"><b>${esc(acc)}</b><span>${vs.filter((v) => v.status === 'done').length}/${vs.length}</span></div>${vs.map((v) => rowHtml(v)).join('')}`).join('');
}
const empty = (t) => `<div class="empty">${t}</div>`;

function renderNetbar() {
  const accs = netAccounts();
  const paused = isPaused();
  $('nbAccs').innerHTML = accs.length ? accs.map((a) => `<span class="acc${paused ? ' off' : ''}">@${esc(a.name)}</span>`).join('') : '<span class="muted small">Нет аккаунтов</span>';
  let state = 'автозалив включён', hint = '';
  if (net === 'tiktok') {
    const direct = accs.some((a) => a.mode === 'direct');
    state = direct ? 'прямая публикация' : 'черновики';
    hint = direct
      ? 'Каждый ролик перед публикацией нужно один раз подтвердить (так требует TikTok). Неподтверждённые уходят в черновики.'
      : 'Ролики приходят в черновики TikTok: откройте уведомление в приложении TikTok и опубликуйте. TikTok держит не больше 5 неопубликованных черновиков за сутки.';
  } else {
    const t = (data && data.texts && data.texts.instagram) || {};
    if (t.comment || t.use_pinned_comment) hint = 'Под каждым рилсом автоматически появится первый комментарий.';
  }
  if (!accs.length) { hint = `В config.json нет аккаунтов ${NET_NAME[net]}.`; state = 'не подключено'; }
  if (paused) { state = 'на паузе'; hint = `Автозалив в ${NET_NAME[net]} остановлен. Общая очередь (обе сети) тоже ждёт. Нажмите «Продолжить», остаток дня распределится заново.`; }
  $('nbState').textContent = state; $('nbState').classList.toggle('paused', paused);
  $('nbHint').textContent = hint;
  $('actPause').classList.toggle('on', paused);
  $('actPause').querySelector('span').textContent = paused ? 'Продолжить' : 'Пауза';
  $('actPause').querySelector('svg').innerHTML = paused ? '<path d="M7 5l12 7-12 7z"/>' : '<path d="M9 6v12M15 6v12"/>';
  for (const id of ['actPause', 'actTexts', 'actRun']) $(id).disabled = !data || !accs.length;
}

function renderTabs() {
  for (const n of Object.keys(NET_NAME)) {
    const s = data && data.nets && data.nets[n];
    const el = $(n === 'instagram' ? 'cntInstagram' : 'cntTiktok');
    el.textContent = s && s.summary.total ? `${s.summary.done}/${s.summary.total}` : '';
    el.hidden = !el.textContent;
  }
  $('ttDot').hidden = !((data && data.tt && data.tt.pending) || []).length;
}

function render() {
  renderTabs(); renderNetbar(); renderTt();
  const s0 = snap();
  if (!s0) return;
  const late = (s0.summary && s0.summary.late) || 0;
  const h = data && data.health;
  if (h && h.approval) {
    // GitHub держит запуски до ручного подтверждения: без этого ничего не выйдет ни в одну сеть
    banner(`GitHub не запускает автопостер с ${timeOf(h.since)}: каждый запуск ждёт подтверждения (${plural(h.count, 'запуск', 'запуска', 'запусков')}). Нажми здесь, затем на GitHub «Approve and run» / «Review pending».`, false, h.url);
  } else if (!$('banner').classList.contains('error') || !$('banner').textContent) {
    banner(late && !isPaused() ? `${NET_NAME[net]}: задерживается рилсов ${late}. Автопостер ещё не запустился, GitHub опаздывает. Догонит на ближайшем запуске.` : '', true);
  }
  const rows = s0.todayRows, s = s0.summary;
  $('todayTitle').textContent = rows.length
    ? `Сегодня · ${s.done} из ${s.total}${s.next ? ` · дальше в ${timeOf(s.next)}` : s.done === s.total ? ' · день закрыт' : ''}`
    : 'Сегодня';
  $('todayList').innerHTML = rows.length ? rows.map((r) => rowHtml(r, [r.folder, r.acc, r.lane === 'shared' ? 'обе сети' : ''].filter(Boolean).join(' · '))).join('')
    : empty(isPaused() ? 'Пауза: сегодня ничего не выйдет.' : 'На сегодня плана нет.<br>План появится, когда начнётся окно публикаций.');
  const queue = s0.folders.filter((f) => f.kind !== 'done'), done = s0.folders.filter((f) => f.kind === 'done');
  $('queueTitle').textContent = queue.length ? `Очередь · ${plural(queue.length, 'папка', 'папки', 'папок')}` : 'Очередь';
  $('queueList').innerHTML = queue.length ? queue.map(folderHtml).join('')
    : empty(`Очередь ${NET_NAME[net]} пустая.<br>Нажми «+» или перетащи папку в окно.`);
  $('doneTitle').firstElementChild.textContent = `Готово · ${done.length}`;
  $('doneTitle').classList.toggle('open', doneOpen);
  $('doneList').hidden = !doneOpen;
  $('doneList').innerHTML = done.length ? done.map(folderHtml).join('') : empty('Пока нет полностью опубликованных папок.');
}

const findFolder = (id) => { const s = snap(); return s && s.folders.find((x) => x.id === id); };
const findVideo = (id) => { const s = snap(); if (!s) return null; for (const f of s.folders) { const v = f.videos.find((x) => x.id === id); if (v) return v; } return s.todayRows.find((r) => r.id === id) || null; };

document.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); askDelete(del.dataset.del); return; }
  const ft = e.target.closest('[data-ftexts]');
  if (ft) { e.stopPropagation(); openFolderTexts(ft.dataset.ftexts); return; }
  const now = e.target.closest('[data-now]');
  if (now) { e.stopPropagation(); askPostNow(now.dataset.now); return; }
  const head = e.target.closest('.f-head');
  if (head) {
    const f = head.parentElement; f.classList.toggle('open');
    f.classList.contains('open') ? openSet.add(f.dataset.id) : openSet.delete(f.dataset.id);
    store.set('open', [...openSet]);
    return;
  }
  const line = e.target.closest('.m[data-url]');
  if (line) { bridge.openUrl(line.dataset.url); return; }
  const row = e.target.closest('.row-card[data-url]');
  if (row) bridge.openUrl(row.dataset.url);
});
$('doneTitle').addEventListener('click', () => { doneOpen = !doneOpen; store.set('doneOpen', doneOpen); render(); });

// ------------------------------------------------------------ данные
function banner(text, info = false, url = '') {
  const b = $('banner'); b.hidden = !text; b.textContent = text || ''; b.classList.toggle('info', info); b.classList.toggle('error', !!text && !info);
  if (url) b.dataset.url = url; else delete b.dataset.url;
  b.classList.toggle('link', !!url);
}
$('banner').addEventListener('click', () => { const u = $('banner').dataset.url; if (u) bridge.openUrl(u); });
async function refresh() {
  if (refresh.running) return;
  refresh.running = true;
  const btn = $('btnRefresh'); btn.classList.add('spin');
  try {
    data = await bridge.refresh();
    banner('');
    $('foot').textContent = `Обновлено ${timeOf(data.at)}`;
    render(); tick();
  } catch (e) {
    if (e.code === 'NO_TOKEN') { banner('Подключи GitHub: открой настройки (шестерёнка) и вставь токен.', true); if (!hasToken && !refresh.asked) { refresh.asked = true; openSettings(); } }
    else banner(`Не удалось обновить: ${e.message}`);
  } finally { btn.classList.remove('spin'); refresh.running = false; }
}
function schedule() {
  clearInterval(timer);
  const m = Number(cfg.refreshMin);
  if (m > 0) timer = setInterval(() => { if (!busy && document.visibilityState !== 'hidden') refresh(); }, m * 60000);
}

// ------------------------------------------------------------ лист подтверждения (удалить, опубликовать сейчас, запустить)
let askAction = null;
function ask({ title, text, go, danger = false, action }) {
  askAction = action;
  $('askTitle').textContent = title; $('askText').textContent = text; $('askStatus').textContent = ''; $('askStatus').className = 'small';
  $('askGo').textContent = go; $('askGo').disabled = false; $('askCancel').disabled = false;
  $('askGo').classList.toggle('danger-bg', danger);
  $('askSheet').hidden = false; $('askGo').focus();
}
$('askCancel').addEventListener('click', () => { $('askSheet').hidden = true; });
$('askGo').addEventListener('click', async () => {
  if (!askAction) return;
  $('askGo').disabled = true; $('askCancel').disabled = true; $('askGo').textContent = 'Секунду…';
  try { await askAction(); $('askSheet').hidden = true; } catch (e) {
    $('askStatus').textContent = e.message; $('askStatus').className = 'small bad';
    $('askGo').disabled = false; $('askGo').textContent = 'Повторить'; $('askCancel').disabled = false;
  }
});

function askDelete(id) {
  const f = findFolder(id);
  if (!f) return;
  const left = f.videos.filter((v) => v.status !== 'done').length;
  ask({
    title: `Убрать ${LANE_DIR[f.lane]}/${f.name}?`, go: 'Убрать', danger: true,
    text: `Не опубликовано рилсов: ${left} из ${f.total}. Они исчезнут из очереди и больше не выйдут${f.shared ? ' ни в одну сеть' : ''}. Уже опубликованное останется в соцсетях.`,
    action: async () => {
      const n = await bridge.deleteFolder(f.name, f.lane);
      openSet.delete(f.id); store.set('open', [...openSet]);
      toast(`Папка ${f.name} убрана из очереди (${plural(n, 'файл', 'файла', 'файлов')})`);
      refresh();
    },
  });
}
function askPostNow(id) {
  const v = findVideo(id);
  if (!v) return;
  const where = v.lane === 'shared' ? 'во все аккаунты обеих сетей, где он ещё не вышел' : `в ${NET_NAME[net]} (${(v.accounts || []).filter((a) => a.status !== 'done').map((a) => '@' + a.name).join(', ')})`;
  ask({
    title: `Опубликовать ${v.name} сейчас?`, go: 'Опубликовать сейчас',
    text: `Автопостер на GitHub запустится вне расписания и выложит рилс ${where}. Обычно это занимает 1–3 минуты.`,
    action: async () => { await bridge.run({ action: 'post', only: v.id }); toast('Запуск отправлен. Обнови виджет через пару минут.'); },
  });
}
$('actRun').addEventListener('click', () => ask({
  title: 'Запустить автопостер сейчас?', go: 'Запустить',
  text: 'Он опубликует то, что уже пора по плану (обычно это делает расписание каждые 5–10 минут). Ничего лишнего не выйдет.',
  action: async () => { await bridge.run({ action: 'post' }); toast('Запуск отправлен. Обнови виджет через пару минут.'); },
}));
$('actPause').addEventListener('click', async () => {
  const on = !isPaused();
  const btn = $('actPause'); btn.disabled = true;
  try {
    data.paused = await bridge.pauseNet(net, on);
    toast(on ? `${NET_NAME[net]}: автозалив на паузе` : `${NET_NAME[net]}: автозалив продолжается`);
    render();
  } catch (e) { toast(e.message, 5000); } finally { btn.disabled = false; }
});

// ------------------------------------------------------------ тексты (подпись по умолчанию, хвост, хэштеги, комментарий)
const FIELDS = [
  { k: 'caption', label: 'Подпись по умолчанию', rows: 3, hint: 'Ставится, если у видео нет своего описания (.txt).' },
  { k: 'footer', label: 'Добавлять в конец каждой подписи', rows: 2, hint: 'Например призыв подписаться или ссылка на полное видео.' },
  { k: 'hashtags', label: 'Хэштеги', input: true, hint: 'Через пробел: #shorts #survival. В Instagram не больше 30.' },
  { k: 'comment', label: 'Первый комментарий под рилсом', rows: 2, ig: true, hint: 'Instagram: автопостер сам оставит комментарий сразу после публикации.' },
];
function fieldsHtml(prefix, values, inherited, { ig, folder }) {
  const out = FIELDS.filter((f) => !f.ig || ig).map((f) => {
    const ph = inherited && inherited[f.k] ? `как в сети: ${String(inherited[f.k]).slice(0, 60)}` : (folder ? 'как в настройках сети' : '');
    const val = esc(values[f.k] || '');
    const ctl = f.input ? `<input id="${prefix}_${f.k}" value="${val}" placeholder="${esc(ph)}" spellcheck="false">`
      : `<textarea id="${prefix}_${f.k}" rows="${f.rows}" maxlength="2200" placeholder="${esc(ph)}">${val}</textarea>`;
    return `<label>${f.label}${ctl}</label><div class="hint">${f.hint}</div>`;
  });
  if (ig) out.push(`<label class="check"><input id="${prefix}_use_pinned_comment" type="checkbox"${values.use_pinned_comment ? ' checked' : ''}> Брать комментарий из раздела PINNED COMMENT: в .txt</label>`);
  if (!ig) out.push('<p class="hint">TikTok не разрешает программам оставлять комментарии. Нужный текст можно добавить в конец подписи.</p>');
  else out.push('<p class="hint">Свой комментарий для одного видео: раздел <b>COMMENT:</b> в его .txt. Нужно разрешение instagram_manage_comments у токена Instagram, иначе рилс выйдет без комментария.</p>');
  return out.join('');
}
function readFields(prefix) {
  const t = {};
  for (const f of FIELDS) { const el = $(`${prefix}_${f.k}`); if (el && el.value.trim()) t[f.k] = el.value.trim(); }
  const pin = $(`${prefix}_use_pinned_comment`); if (pin && pin.checked) t.use_pinned_comment = true;
  return t;
}
/** Как автопостер соберёт подпись (build_caption): текст → хвост → хэштеги. */
function previewCaption(t, inherited, sample) {
  const pick = (k) => (t[k] != null && t[k] !== '' ? t[k] : (inherited || {})[k] || '');
  let text = sample || pick('caption') || '(подпись из .txt)';
  const footer = pick('footer'); if (footer) text += `\n\n${footer}`;
  const tags = pick('hashtags') || (!(inherited || {}).hashtags && data ? data.hashtags : '');
  if (tags) text += `\n\n${tags}`;
  const comment = pick('comment');
  return text + (comment ? `\n\n💬 Комментарий: ${comment}` : '');
}
let tx = null; // {mode:'net'|'folder', net, folder}
function openTexts(mode, opts) {
  tx = { mode, ...opts };
  const inherited = mode === 'folder' ? ((data && data.texts) || {})[net] || {} : null;
  const ig = mode === 'net' ? net === 'instagram' : (opts.folder.lane !== 'tiktok');
  $('txTitle').textContent = mode === 'net' ? `Тексты ${NET_NAME[net]} по умолчанию` : `Тексты папки ${opts.folder.name}`;
  $('txIntro').textContent = mode === 'net'
    ? `Прикрепляются сами к каждому ролику ${NET_NAME[net]} при заливе. Настройки папки (карандаш у папки) важнее этих.`
    : `Действуют только на ролики этой папки${opts.folder.shared ? ' во всех сетях' : ''}. Пустое поле: как в настройках сети.`;
  $('txFields').innerHTML = fieldsHtml('tx', opts.values || {}, inherited, { ig, folder: mode === 'folder' });
  $('txErr').textContent = ''; $('txSave').disabled = false; $('txSave').textContent = 'Сохранить';
  $('txSheet').hidden = false; syncTexts();
}
function syncTexts() {
  if (!tx) return;
  const inherited = tx.mode === 'folder' ? ((data && data.texts) || {})[net] || {} : null;
  $('txPreview').textContent = previewCaption(readFields('tx'), inherited, '');
}
$('txSheet').addEventListener('input', syncTexts);
$('actTexts').addEventListener('click', () => openTexts('net', { values: ((data && data.texts) || {})[net] || {} }));
async function openFolderTexts(id) {
  const f = findFolder(id);
  if (!f) return;
  openTexts('folder', { folder: f, values: {} });
  $('txSave').disabled = true; $('txSave').textContent = 'Загружаю…';
  try {
    const t = await bridge.folderTexts(f.lane, f.name);
    if (!tx || tx.folder !== f) return;
    openTexts('folder', { folder: f, values: t || {} });
  } catch (e) { $('txErr').textContent = e.message; $('txSave').disabled = false; $('txSave').textContent = 'Сохранить'; }
}
const closeTexts = () => { $('txSheet').hidden = true; tx = null; };
$('txBack').addEventListener('click', closeTexts); $('txCancel').addEventListener('click', closeTexts);
$('txSave').addEventListener('click', async () => {
  const t = readFields('tx');
  $('txSave').disabled = true; $('txSave').textContent = 'Сохраняю…'; $('txErr').textContent = '';
  try {
    if (tx.mode === 'net') { data.texts = await bridge.saveNetTexts(net, t); toast(`Тексты ${NET_NAME[net]} сохранены`); }
    else { await bridge.saveFolderTexts(tx.folder.lane, tx.folder.name, t); toast(Object.keys(t).length ? 'Тексты папки сохранены' : 'Тексты папки сброшены'); }
    closeTexts(); refresh();
  } catch (e) { $('txErr').textContent = e.message; $('txSave').disabled = false; $('txSave').textContent = 'Повторить'; }
});

// ------------------------------------------------------------ TikTok: подтверждение перед публикацией
const TT = {
  labels: { PUBLIC_TO_EVERYONE: 'Все', MUTUAL_FOLLOW_FRIENDS: 'Друзья (взаимные подписки)', FOLLOWER_OF_CREATOR: 'Подписчики', SELF_ONLY: 'Только я' },
  music: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
  brand: 'https://www.tiktok.com/legal/page/global/bc-policy/en',
};
let ttCur = null;
function renderTt() {
  const list = (data && data.tt && data.tt.pending) || [];
  $('ttSection').hidden = net !== 'tiktok' || !list.length;
  $('ttList').innerHTML = list.map((p, i) => `<div class="tt-row"><span>${esc(p.folder)}/${esc(p.video)}<br><span class="muted small">@${esc(p.account)}${p.lane === 'shared' ? ' · обе сети' : ''}</span></span><button class="btn small" data-tt="${i}">Проверить</button></div>`).join('');
}
$('ttList').addEventListener('click', (e) => { const b = e.target.closest('[data-tt]'); if (b) openTt(data.tt.pending[+b.dataset.tt]); });
function ttForm() {
  return {
    title: $('ttTitle').value, privacy_level: $('ttPrivacy').value,
    allow_comment: $('ttComment').checked, allow_duet: $('ttDuet').checked, allow_stitch: $('ttStitch').checked,
    commercial: { on: $('ttComm').checked, your_brand: $('ttOwn').checked, branded: $('ttBranded').checked },
    is_aigc: $('ttAigc').checked, consent: $('ttAgree').checked,
  };
}
function ttErrors(f) {
  const e = [];
  if (!f.title.trim()) e.push('Укажите название ролика.');
  if (!f.privacy_level) e.push('Выберите, кто может смотреть ролик.');
  if (f.commercial.on && !(f.commercial.your_brand || f.commercial.branded)) e.push('Выберите тип коммерческого контента.');
  if (f.commercial.on && f.commercial.branded && f.privacy_level === 'SELF_ONLY') e.push('Брендированный контент нельзя сделать приватным.');
  if (!f.consent) e.push('Подтвердите согласие.');
  return e;
}
function ttSync() {
  if (!ttCur) return;
  const f = ttForm(), c = f.commercial;
  $('ttCommBox').hidden = !c.on;
  // брендированный контент нельзя сделать приватным: блокируем «Только я», пока он выбран
  for (const o of $('ttPrivacy').options) if (o.value === 'SELF_ONLY') o.disabled = !!(c.on && c.branded);
  if (c.on && c.branded && $('ttPrivacy').value === 'SELF_ONLY') $('ttPrivacy').value = '';
  $('ttCommNote').textContent = !c.on ? '' : c.branded ? 'Ваш ролик будет помечен как «Платное партнёрство».' : c.your_brand ? 'Ваш ролик будет помечен как «Продвижение собственного бренда».' : '';
  $('ttConsent').innerHTML = (c.on && c.branded
    ? `Публикуя, я принимаю <a data-url="${TT.brand}">Политику брендированного контента</a> и <a data-url="${TT.music}">Подтверждение использования музыки</a> TikTok.`
    : `Публикуя, я принимаю <a data-url="${TT.music}">Подтверждение использования музыки</a> TikTok.`);
  $('ttLen').textContent = String(f.title.length);
  const errs = ttErrors(f);
  $('ttErr').textContent = f.consent ? errs.join(' ') : '';
  $('ttGo').disabled = errs.length > 0;
}
async function openTt(p) {
  const cr = ((data && data.tt && data.tt.creators) || {})[p.account] || {};
  const token = Symbol('tt');
  ttCur = { p, creator: cr, token };
  $('ttWho').textContent = cr.nickname ? `Публикация в аккаунт: ${cr.nickname}` : `Публикация в аккаунт @${p.account} (нажмите в настройках «Проверить токены», чтобы подтянуть ник)`;
  $('ttFile').textContent = `${p.folder}/${p.video}`;
  $('ttTitle').value = ''; $('ttAgree').checked = false; $('ttComm').checked = false; $('ttOwn').checked = false; $('ttBranded').checked = false; $('ttAigc').checked = false;
  for (const [id, key, note] of [['ttComment', 'comment_disabled', 'ttCommentNote'], ['ttDuet', 'duet_disabled', 'ttDuetNote'], ['ttStitch', 'stitch_disabled', 'ttStitchNote']]) {
    $(id).checked = false; $(id).disabled = !!cr[key]; $(note).textContent = cr[key] ? '(отключено в настройках TikTok)' : '';
  }
  // приватность: только варианты из TikTok, значения по умолчанию нет
  $('ttPrivacy').innerHTML = '<option value="">— выберите —</option>' + (cr.privacy_level_options || []).map((v) => `<option value="${esc(v)}">${esc(TT.labels[v] || v)}</option>`).join('');
  $('ttErr').textContent = ''; $('ttGo').textContent = 'Подтвердить'; $('ttGo').disabled = true; $('ttCancel').disabled = false;
  $('ttVideo').removeAttribute('src'); $('ttVideo').load();
  $('ttSheet').hidden = false; ttSync();
  try {
    const cap = await bridge.ttCaption(p.rel, p.account);
    if (ttCur && ttCur.token === token && !$('ttTitle').value) $('ttTitle').value = previewCaption({}, ((data && data.texts) || {}).tiktok || {}, cap).replace(/\n\n💬[\s\S]*$/, '').replace('(подпись из .txt)', '');
  } catch { /* без подсказки */ }
  try {
    const file = await bridge.ttPreview(p.rel);
    if (ttCur && ttCur.token === token) $('ttVideo').src = 'file:///' + file.replace(/\\/g, '/');
  } catch (e) { if (ttCur && ttCur.token === token) $('ttFile').textContent = `${p.folder}/${p.video} · превью не загрузилось: ${e.message}`; }
  ttSync();
}
$('ttSheet').addEventListener('input', ttSync);
$('ttSheet').addEventListener('change', ttSync);
$('ttSheet').addEventListener('click', (e) => { const a = e.target.closest('[data-url]'); if (a) bridge.openUrl(a.dataset.url); });
const ttClose = () => { $('ttVideo').pause(); $('ttVideo').removeAttribute('src'); $('ttSheet').hidden = true; ttCur = null; };
$('ttBack').addEventListener('click', ttClose); $('ttCancel').addEventListener('click', ttClose);
$('ttGo').addEventListener('click', async () => {
  const f = ttForm(); $('ttGo').disabled = true; $('ttGo').textContent = 'Сохраняю…';
  try {
    await bridge.ttConfirm({ path: ttCur.p.path, form: f, creator: ttCur.creator });
    toast('Подтверждено. Ролик уйдёт в TikTok по расписанию');
    ttClose(); refresh();
  } catch (e) { $('ttErr').textContent = e.message; $('ttGo').disabled = false; $('ttGo').textContent = 'Повторить'; }
});

// ------------------------------------------------------------ загрузка папки
let pvLane = 'instagram', pvInfo = null;
function addFolders(paths) {
  pending.push(...paths.filter(Boolean));
  if (!busy && $('sheet').hidden) { pvLane = net; showNext(); }
}
function laneHint() {
  return { instagram: 'Папка попадёт в queue-instagram/: только аккаунты Instagram, своё расписание.',
    tiktok: 'Папка попадёт в queue-tiktok/: только TikTok, своё расписание.',
    shared: 'Папка попадёт в общую queue/: каждый рилс выйдет и в Instagram, и в TikTok.' }[pvLane];
}
async function showNext() {
  if (!pending.length) { $('sheet').hidden = true; return; }
  for (const b of $('pvLane').children) b.classList.toggle('on', b.dataset.v === pvLane);
  $('pvLaneHint').textContent = laneHint();
  let info;
  try { info = await bridge.inspect(pending[0], pvLane); } catch (e) { toast(e.message); pending.shift(); return showNext(); }
  pvInfo = info;
  const name = `${pad3((data && data.nextNum) || 1)}_${slug(info.name)}`;
  $('pvTitle').textContent = `${LANE_DIR[pvLane]}/${name}`;
  const more = pending.length > 1 ? ` · ещё ${pending.length - 1} в ожидании` : '';
  $('pvCounts').textContent = `${plural(info.videos, 'видео', 'видео', 'видео')} · описаний ${info.texts} · обложек ${info.covers} · ${(info.size / 1e6).toFixed(0)} МБ${more}`;
  const gl = (info.groups || []).map((g) => `<div class="g">${esc(g.name)}: ${plural(g.videos, 'видео', 'видео', 'видео')}, описаний ${g.texts}, обложек ${g.covers}</div>`);
  const notes = [...gl, ...info.errors.map((t) => `<div class="e">✗ ${esc(t)}</div>`), ...info.warnings.map((t) => `<div class="w">! ${esc(t)}</div>`)];
  $('pvNotes').innerHTML = (info.errors.length || info.warnings.length) ? notes.join('') : (gl.join('') + '<div class="g">✓ Всё на месте</div>');
  if (!$('pvTexts').dataset.ready || $('sheet').hidden) {
    $('pvTexts').innerHTML = fieldsHtml('pv', {}, ((data && data.texts) || {})[pvLane === 'shared' ? 'instagram' : pvLane] || {}, { ig: pvLane !== 'tiktok', folder: true });
    $('pvTexts').dataset.ready = '1'; $('pvTextsBox').open = false;
  }
  $('pvBar').hidden = true; $('pvStatus').textContent = ''; $('pvStatus').className = 'muted small';
  $('pvGo').disabled = info.errors.length > 0; $('pvGo').textContent = 'Загрузить в очередь'; $('pvCancel').disabled = false;
  $('sheet').hidden = false;
  if (cfg.autoUpload && !info.errors.length) upload();
}
$('pvLane').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || busy) return;
  const keep = readFields('pv');
  pvLane = b.dataset.v;
  $('pvTexts').innerHTML = fieldsHtml('pv', keep, ((data && data.texts) || {})[pvLane === 'shared' ? 'instagram' : pvLane] || {}, { ig: pvLane !== 'tiktok', folder: true });
  showNext();
});
async function upload() {
  if (busy || !pending.length) return;
  busy = true;
  $('pvGo').disabled = true; $('pvGo').textContent = 'Загружаю…'; $('pvCancel').disabled = true;
  $('pvBar').hidden = false; $('pvBar').firstElementChild.style.width = '0%';
  try {
    const name = await bridge.upload(pending[0], { lane: pvLane, texts: readFields('pv') });
    toast(`Готово: ${name}`);
    pending.shift(); busy = false; delete $('pvTexts').dataset.ready;
    if (pvLane !== 'shared' && pvLane !== net) setNet(pvLane);
    await refresh(); showNext();
  } catch (e) {
    busy = false;
    $('pvStatus').textContent = e.message; $('pvStatus').className = 'small bad';
    $('pvGo').disabled = false; $('pvGo').textContent = 'Повторить'; $('pvCancel').disabled = false;
  }
}
bridge.onProgress(({ frac, text }) => {
  $('pvBar').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
  $('pvStatus').className = 'muted small'; $('pvStatus').textContent = text;
});
$('pvGo').addEventListener('click', upload);
$('pvCancel').addEventListener('click', () => { pending.shift(); delete $('pvTexts').dataset.ready; if (!pending.length) $('sheet').hidden = true; else showNext(); });
$('fab').addEventListener('click', async () => { const p = await bridge.pickFolder().catch(() => []); if (p && p.length) addFolders(p); });

window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    dragDepth++; $('dropOverlay').hidden = false;
    $('dropHint').textContent = `в очередь ${NET_NAME[net]} (можно выбрать другую перед загрузкой)`;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => bridge.pathFor(f)).filter(Boolean);
  if (paths.length) addFolders(paths);
});

function closeTop() {
  if (!$('ttSheet').hidden) return ttClose();
  if (!$('txSheet').hidden) return closeTexts();
  if (!$('askSheet').hidden && !$('askCancel').disabled) { $('askSheet').hidden = true; return; }
  if (!$('sheet').hidden && !busy) { $('pvCancel').click(); return; }
  if (!$('settings').hidden) $('settings').hidden = true;
}

// ------------------------------------------------------------ настройки
function applyAppearance(a) {
  document.body.dataset.material = a.material;
  document.documentElement.style.setProperty('--tint', String(0.15 + 0.8 * (a.tint / 100)));
  $('fMaterial').disabled = !a.win11;
  $('materialHint').textContent = a.win11 ? '' : 'Системная прозрачность доступна в Windows 11 22H2 и новее. Здесь окно будет обычным.';
}
function fillSettings() {
  $('fRepo').value = cfg.repo; $('fBranch').value = cfg.branch; $('fToken').value = '';
  $('fToken').placeholder = hasToken ? 'токен сохранён, оставь пустым чтобы не менять' : 'вставь токен';
  for (const b of $('segTheme').children) b.classList.toggle('on', b.dataset.v === cfg.theme);
  $('fMaterial').value = cfg.material; $('fTint').value = cfg.tint; $('tintVal').textContent = `${cfg.tint}%`;
  $('fPin').checked = cfg.alwaysOnTop; $('fAutostart').checked = cfg.autostart; $('fAutoUpload').checked = cfg.autoUpload;
  $('fRefresh').value = String(cfg.refreshMin); $('fTz').value = cfg.scheduleTz;
  $('btnPin').classList.toggle('on', !!cfg.alwaysOnTop);
  $('about').textContent = `Reels Widget ${version}. Две очереди: Instagram и TikTok (и общая для обеих). Папка из одного длинного видео превращается в рилсы на день, автопостер на GitHub публикует их сам.`;
}
function openSettings() { fillSettings(); $('connResult').textContent = ''; $('settings').hidden = false; }
const save = async (patch) => { cfg = await bridge.setConfig(patch); fillSettings(); schedule(); };

$('btnSettings').addEventListener('click', openSettings);
$('setBack').addEventListener('click', () => { $('settings').hidden = true; });
$('btnRefresh').addEventListener('click', refresh);
$('btnClose').addEventListener('click', () => bridge.hide());
$('btnPin').addEventListener('click', async () => { cfg.alwaysOnTop = await bridge.pin(!cfg.alwaysOnTop); fillSettings(); });
$('segTheme').addEventListener('click', (e) => { if (e.target.dataset.v) save({ theme: e.target.dataset.v }); });
$('fMaterial').addEventListener('change', (e) => save({ material: e.target.value }));
let tintT; $('fTint').addEventListener('input', (e) => {
  $('tintVal').textContent = `${e.target.value}%`;
  document.documentElement.style.setProperty('--tint', String(0.15 + 0.8 * (e.target.value / 100)));
  clearTimeout(tintT); tintT = setTimeout(() => save({ tint: Number(e.target.value) }), 300);
});
$('fPin').addEventListener('change', (e) => save({ alwaysOnTop: e.target.checked }));
$('fAutostart').addEventListener('change', (e) => save({ autostart: e.target.checked }));
$('fAutoUpload').addEventListener('change', (e) => save({ autoUpload: e.target.checked }));
$('fRefresh').addEventListener('change', (e) => save({ refreshMin: Number(e.target.value) }));
$('fTz').addEventListener('change', async (e) => { await save({ scheduleTz: e.target.value }); tick(); refresh(); });
$('btnEye').addEventListener('click', () => {
  const f = $('fToken'); f.type = f.type === 'password' ? 'text' : 'password';
  $('btnEye').textContent = f.type === 'password' ? 'Показать' : 'Скрыть';
});
$('btnPaste').addEventListener('click', async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return toast('Буфер обмена пуст: сначала скопируй токен.');
    $('fToken').value = t; toast(`Вставлено ${t.length} символов`);
  } catch { toast('Не удалось прочитать буфер: нажми в поле и Ctrl+V.'); }
});
$('btnForget').addEventListener('click', async () => {
  await bridge.setToken(''); hasToken = false; fillSettings();
  $('connResult').className = 'small'; $('connResult').textContent = 'Токен удалён.';
});
$('btnSave').addEventListener('click', async () => {
  const res = $('connResult'); res.className = 'small muted'; res.textContent = 'Проверяю…';
  const t = $('fToken').value.trim();
  try {
    if (t) { await bridge.setToken(t); hasToken = true; $('fToken').value = ''; }
    await save({ repo: $('fRepo').value.trim() || cfg.repo, branch: $('fBranch').value.trim() || cfg.branch });
    const full = await bridge.checkConnection();
    res.className = 'small ok'; res.textContent = `✓ Подключено к ${full}, запись разрешена.`;
    refresh();
  } catch (e) { res.className = 'small bad'; res.textContent = `✗ ${e.message}`; }
});
$('btnCheck').addEventListener('click', async () => {
  try { await bridge.run({ action: 'check' }); toast('Проверка запущена: результат в «Журнале запусков» через минуту'); } catch (e) { toast(e.message, 6000); }
});
document.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => {
  const base = `https://github.com/${cfg.repo}`;
  bridge.openUrl({ repo: base, actions: `${base}/actions`, releases: `${base}/releases/tag/widget` }[b.dataset.link]);
}));
bridge.onAppearance(applyAppearance);
bridge.onRefresh(refresh);
bridge.onConfig((c) => { cfg = c; fillSettings(); });

// ------------------------------------------------------------ старт
(async function init() {
  const r = await bridge.getConfig();
  cfg = r.cfg; hasToken = r.hasToken; version = r.version;
  tick(); setInterval(tick, 1000);
  applyAppearance(r.appearance); fillSettings(); schedule();
  setNet(cfg.tab || 'instagram', false);
  refresh();
})();
