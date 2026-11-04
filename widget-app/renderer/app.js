'use strict';
const $ = (id) => document.getElementById(id);
const bridge = window.api;
const LABEL = { done: 'вышел', part: 'частично', wait: 'ждёт', skipped: 'пропущен', queued: 'в очереди' };

let cfg = {}, hasToken = false, version = '', snap = null, timer = null, busy = false;
let pending = [], dragDepth = 0;
const openSet = new Set(JSON.parse(localStorage.getItem('open') || '[]'));
let doneOpen = localStorage.getItem('doneOpen') === '1';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (name) => (String(name).trim().replace(/^\d+[_\- ]*/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '')) || 'reels';
const pad3 = (n) => String(n).padStart(3, '0');
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—');
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c}`; };
const nf = (v) => (v == null ? '—' : Number(v).toLocaleString('ru-RU'));
const utc = (d) => { const o = -d.getTimezoneOffset() / 60; return `UTC${o >= 0 ? '+' : '−'}${Math.abs(o)}`; };

function toast(text, ms = 3200) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------ шапка
function tick() {
  const now = new Date();
  $('clockLocal').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('clockMsk').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  $('tzLocal').textContent = utc(now);
  const d = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('dateLine').textContent = d.charAt(0).toUpperCase() + d.slice(1);
}

// ------------------------------------------------------------ список
const IC = {
  v: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  l: '<svg viewBox="0 0 24 24"><path d="M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20z"/></svg>',
  c: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
};
const nums = (o) => `<span title="просмотры">${IC.v}<b>${nf(o.views)}</b></span><span title="лайки">${IC.l}<b>${nf(o.likes)}</b></span><span title="комментарии">${IC.c}<b>${nf(o.comments)}</b></span>`;
function metrics(v) {
  if (v.status !== 'done' && v.status !== 'part') return '';
  const accs = v.accounts || [];
  if (accs.length < 2) {
    if (v.status !== 'done') return '';
    return `<div class="m">${nums(v)}</div>`;
  }
  return accs.map((a) => a.status === 'done'
    ? `<div class="m"${a.permalink ? ` data-url="${esc(a.permalink)}"` : ''}><span class="an" title="${esc(a.name)}">${esc(a.name)}</span>${nums(a)}</div>`
    : `<div class="m off"><span class="an" title="${esc(a.name)}">${esc(a.name)}</span><span>${a.status === 'skipped' ? 'пропущен' : 'ждёт'}</span></div>`).join('');
}
function rowHtml(v, sub) {
  const url = v.permalink ? ` data-url="${esc(v.permalink)}"` : '';
  return `<div class="row-card ${v.status}${v.permalink ? ' link' : ''}"${url}>
    <span class="t">${timeOf(v.time || v.at)}</span>
    <div class="nm">${esc(v.name)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}${metrics(v)}</div>
    <span class="chip ${v.status}">${v.status === 'part' ? `${(v.accounts || []).filter((a) => a.status === 'done').length}/${(v.accounts || []).length}` : LABEL[v.status]}</span></div>`;
}
function folderHtml(f) {
  const pct = f.total ? Math.round((f.done / f.total) * 100) : 0;
  const open = openSet.has(f.name) ? ' open' : '';
  const badge = f.kind === 'today' ? '<span class="chip today">сегодня</span>' : '';
  return `<div class="folder${open}" data-name="${esc(f.name)}">
    <div class="f-head"><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      <div class="f-main"><div class="f-name">${esc(f.name)}</div><div class="prog"><i style="width:${pct}%"></i></div></div>
      ${badge}<span class="f-count">${f.done}/${f.total}</span></div>
    <div class="f-body"><div class="f-inner"><div>${f.videos.map((v) => rowHtml(v)).join('')}</div></div></div></div>`;
}
const empty = (t) => `<div class="empty">${t}</div>`;

function render() {
  if (!snap) return;
  const rows = snap.todayRows, s = snap.summary;
  $('todayTitle').textContent = rows.length
    ? `Сегодня · ${s.done} из ${s.total}${s.next ? ` · дальше в ${timeOf(s.next)}` : s.done === s.total ? ' · день закрыт' : ''}`
    : 'Сегодня';
  $('todayList').innerHTML = rows.length ? rows.map((r) => rowHtml(r, r.folder)).join('')
    : empty('На сегодня плана нет.<br>План появится, когда начнётся день публикаций.');
  const queue = snap.folders.filter((f) => f.kind !== 'done'), done = snap.folders.filter((f) => f.kind === 'done');
  $('queueTitle').textContent = queue.length ? `Очередь · ${plural(queue.length, 'папка', 'папки', 'папок')}` : 'Очередь';
  $('queueList').innerHTML = queue.length ? queue.map(folderHtml).join('') : empty('Очередь пустая.<br>Нажми «+» или перетащи папку в окно.');
  $('doneTitle').firstChild.textContent = `Готово · ${done.length} `;
  $('doneTitle').classList.toggle('open', doneOpen);
  $('doneList').hidden = !doneOpen;
  $('doneList').innerHTML = done.length ? done.map(folderHtml).join('') : empty('Пока нет полностью опубликованных папок.');
}

document.addEventListener('click', (e) => {
  const head = e.target.closest('.f-head');
  if (head) {
    const f = head.parentElement; f.classList.toggle('open');
    f.classList.contains('open') ? openSet.add(f.dataset.name) : openSet.delete(f.dataset.name);
    localStorage.setItem('open', JSON.stringify([...openSet]));
    return;
  }
  const line = e.target.closest('.m[data-url]');
  if (line) { bridge.openUrl(line.dataset.url); return; }
  const row = e.target.closest('.row-card[data-url]');
  if (row) bridge.openUrl(row.dataset.url);
});
$('doneTitle').addEventListener('click', () => { doneOpen = !doneOpen; localStorage.setItem('doneOpen', doneOpen ? '1' : '0'); render(); });

// ------------------------------------------------------------ данные
function banner(text, info = false) {
  const b = $('banner'); b.hidden = !text; b.textContent = text || ''; b.classList.toggle('info', info);
}
async function refresh() {
  const btn = $('btnRefresh'); btn.classList.add('spin');
  try {
    const r = await bridge.refresh();
    snap = r.snapshot; banner('');
    $('foot').textContent = `Обновлено ${timeOf(r.at)}`;
    render();
  } catch (e) {
    if (e.code === 'NO_TOKEN') { banner('Подключи GitHub: открой настройки (шестерёнка) и вставь токен.', true); if (!hasToken && !refresh.asked) { refresh.asked = true; openSettings(); } }
    else banner(`Не удалось обновить: ${e.message}`);
  } finally { btn.classList.remove('spin'); }
}
function schedule() {
  clearInterval(timer);
  const m = Number(cfg.refreshMin);
  if (m > 0) timer = setInterval(() => { if (!busy) refresh(); }, m * 60000);
}

// ------------------------------------------------------------ загрузка папки
async function addFolders(paths) {
  pending.push(...paths.filter(Boolean));
  if (!busy && $('sheet').hidden) showNext();
}
async function showNext() {
  if (!pending.length) { $('sheet').hidden = true; return; }
  let info;
  try { info = await bridge.inspect(pending[0]); } catch (e) { toast(e.message); pending.shift(); return showNext(); }
  const name = `${pad3((snap && snap.nextNum) || 1)}_${slug(info.name)}`;
  $('pvTitle').textContent = `queue/${name}`;
  const more = pending.length > 1 ? ` · ещё ${pending.length - 1} в ожидании` : '';
  $('pvCounts').textContent = `${plural(info.videos, 'видео', 'видео', 'видео')} · описаний ${info.texts} · обложек ${info.covers} · ${(info.size / 1e6).toFixed(0)} МБ${more}`;
  const notes = [...info.errors.map((t) => `<div class="e">✗ ${esc(t)}</div>`), ...info.warnings.map((t) => `<div class="w">! ${esc(t)}</div>`)];
  $('pvNotes').innerHTML = notes.length ? notes.join('') : '<div class="g">✓ Всё на месте</div>';
  $('pvBar').hidden = true; $('pvStatus').textContent = '';
  $('pvGo').disabled = info.errors.length > 0; $('pvGo').textContent = 'Загрузить в очередь'; $('pvCancel').disabled = false;
  $('sheet').hidden = false;
  if (cfg.autoUpload && !info.errors.length) upload();
}
async function upload() {
  if (busy || !pending.length) return;
  busy = true;
  $('pvGo').disabled = true; $('pvGo').textContent = 'Загружаю…'; $('pvCancel').disabled = true;
  $('pvBar').hidden = false; $('pvBar').firstElementChild.style.width = '0%';
  try {
    const name = await bridge.upload(pending[0]);
    toast(`Готово: ${name} в очереди`);
    pending.shift(); busy = false;
    refresh(); showNext();
  } catch (e) {
    busy = false;
    $('pvStatus').textContent = e.message; $('pvStatus').style.color = 'var(--err)';
    $('pvGo').disabled = false; $('pvGo').textContent = 'Повторить'; $('pvCancel').disabled = false;
  }
}
bridge.onProgress(({ frac, text }) => {
  $('pvBar').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
  $('pvStatus').style.color = ''; $('pvStatus').textContent = text;
});
$('pvGo').addEventListener('click', upload);
$('pvCancel').addEventListener('click', () => { pending.shift(); showNext(); });
$('fab').addEventListener('click', async () => { const p = await bridge.pickFolder().catch(() => null); if (p) addFolders([p]); });

window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => bridge.pathFor(f));
  if (paths.length) addFolders(paths);
});

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
  $('about').textContent = `Reels Widget ${version}. Папка из одного длинного видео превращается в очередь рилсов, а автопостер на GitHub публикует их в Instagram в течение дня.`;
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
$('fTz').addEventListener('change', async (e) => { await save({ scheduleTz: e.target.value }); refresh(); });
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
document.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => {
  const base = `https://github.com/${cfg.repo}`;
  bridge.openUrl({ repo: base, actions: `${base}/actions`, releases: `${base}/releases/tag/widget` }[b.dataset.link]);
}));
bridge.onAppearance(applyAppearance);
bridge.onRefresh(refresh);
bridge.onConfig((c) => { cfg = c; fillSettings(); });

// ------------------------------------------------------------ старт
(async function init() {
  tick(); setInterval(tick, 1000);
  const r = await bridge.getConfig();
  cfg = r.cfg; hasToken = r.hasToken; version = r.version;
  applyAppearance(r.appearance); fillSettings(); schedule();
  refresh();
})();
