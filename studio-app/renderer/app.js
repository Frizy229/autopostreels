'use strict';
/* global H */
// Окно Reels Studio. Без фреймворка: страницы рисуются строками, состояние в S.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const { esc, fmtTime } = H;
const ic = (name, cls = '') => `<i class="ic ${cls}" style="--i:url(icons/${name}.svg)"></i>`;

const S = {
  page: 'search', info: null, settings: null, tools: null, cat: null,
  results: [], searching: false, lastQuery: '',
  fill: { results: [], q: '', searching: false, sel: new Set(), lib: { dir: '', files: [] }, busy: false },
  projects: [], current: null, project: null, activeMoment: null,
  jobs: new Map(), build: null,
};

// не «api»: это имя уже занято window.api из preload, и скрипт падал целиком с SyntaxError
async function call(name, ...args) {
  const r = await window.api[name](...args);
  if (!r || !r.ok) { const e = new Error((r && r.error) || 'Ошибка'); e.code = r && r.code; throw e; }
  return r.data;
}
function toast(text, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const fail = (e) => toast(e.message || String(e), e && /не бот/.test(e.message || "") ? 12000 : 5000);

// ------------------------------------------------------------------ навигация
const PAGES = {
  search: { t: 'Поиск', sub: 'лонги, записи стримов и нарезки', icon: 'search' },
  fillers: { t: 'Фон', sub: 'залипательные видео и мини-игры для нижней половины', icon: 'gamepad-2' },
  projects: { t: 'Моменты', sub: 'источники и найденные отрезки', icon: 'scissors' },
  edit: { t: 'Монтаж', sub: 'раскладки, субтитры, заголовки', icon: 'layout-template' },
  channels: { t: 'Каналы и тексты', sub: 'сколько каналов, подписи, правила', icon: 'users' },
  build: { t: 'Сборка', sub: 'папка для автозалива', icon: 'package' },
  instagram: { t: 'Instagram', sub: 'рилсы под выбранные аккаунты и сразу в постинг', icon: 'camera' },
  settings: { t: 'Настройки', sub: 'компоненты, видеокарта, вид', icon: 'settings' },
};

function renderNav() {
  $('#nav').innerHTML = Object.entries(PAGES).map(([k, p], i) => `
    ${k === 'settings' ? '<div class="sep"></div>' : ''}
    <button data-page="${k}" class="${S.page === k ? 'on' : ''}">${ic(p.icon)}<span>${p.t}</span>
      ${k === 'projects' && S.projects.length ? `<span class="badge">${S.projects.length}</span>` : ''}
    </button>`).join('');
  $$('#nav button').forEach((b) => { b.onclick = () => go(b.dataset.page); });
  const t = S.tools || {};
  const row = (ok, name, warn) => `<div class="tool-row"><span class="dot ${ok ? 'ok' : warn ? 'warn' : 'err'}"></span>${name}</div>`;
  $('#sideFoot').innerHTML = S.tools ? row(!!t.ffmpeg, 'ffmpeg') + row(!!t.ytdlp, 'yt-dlp', true) + row(!!(t.whisper && t.model), 'распознавание речи', true) : '';
}

function go(page) {
  S.page = page;
  const run = () => { renderNav(); render(); };
  if (document.startViewTransition) document.startViewTransition(run); else run();
}

function render() {
  const p = PAGES[S.page];
  $('#pageTitle').textContent = p.t;
  $('#pageSub').textContent = S.page === 'projects' && S.project ? S.project.title : p.sub;
  $('#topActions').innerHTML = '';
  const page = $('#page');
  page.className = 'page' + (S.page === 'projects' ? ' split' : '');
  ({ search: pageSearch, fillers: pageFillers, projects: pageProjects, edit: pageEdit, channels: pageChannels, build: pageBuild, instagram: pageInstagram, settings: pageSettings })[S.page](page);
}

// ------------------------------------------------------------------ задачи
function jobUpdate(j) {
  const prev = S.jobs.get(j.id) || {};
  const cur = { ...prev, ...j };
  S.jobs.set(j.id, cur);
  renderDock();
  if (cur.kind === 'build') { S.build = cur; if (S.page === 'build' || S.page === 'instagram') { if (j.done && j.error) render(); else renderBuildProgress(); } }
  if (j.done) {
    if (j.error) { if (!j.aborted) toast(`${cur.label}: ${j.error}`, 6000); }
    else if (cur.kind === 'analyze' || cur.kind === 'check') {
      refreshProjects().then(() => { if (S.current) loadProject(S.current); });
      toast(cur.kind === 'analyze' ? `Найдено моментов: ${j.result.moments.length}` : 'Проверка закончена');
    } else if (cur.kind === 'install') { refreshTools(); toast(`${cur.label}: готово${typeof j.result === 'string' && !j.result.includes('\\') && !j.result.includes('/') ? ` — ${j.result}` : ''}`); }
    else if (cur.kind === 'filler') {
      const r = j.result || {};
      toast(`В библиотеку фона добавлено: ${(r.added || []).length}${(r.skipped || []).length ? `, уже были: ${r.skipped.length}` : ''}${(r.failed || []).length ? `, не скачалось: ${r.failed.length}` : ''}`, 4000);
    }
    else if (cur.kind === 'build') {
      toast('Папка готова');
      if ((cur.mode === 'instagram' || S.settings.autoSend) && j.result && j.result.folder && !(j.result.problems || []).length) sendToAutoposter(cur);
      if (S.page === 'build' || S.page === 'instagram') render();
    }
    setTimeout(() => { S.jobs.delete(j.id); renderDock(); }, j.error ? 9000 : 3500);
  }
  if (cur.kind === 'filler' && j.done) { S.fill.busy = false; refreshFillerLib(); }
  if (cur.kind === 'analyze' || cur.kind === 'check') { const el = $('#projJob'); if (el && S.page === 'projects') el.innerHTML = jobInline(cur); }
}
const jobInline = (j) => (j && !j.done ? `<div class="row"><small class="grow muted">${esc(j.text || '')}</small><span class="num muted">${Math.round((j.progress || 0) * 100)}%</span></div><div class="bar"><i style="width:${(j.progress || 0) * 100}%"></i></div>` : '');
function renderDock() {
  $('#dock').innerHTML = [...S.jobs.values()].map((j) => `
    <div class="job ${j.error ? 'err' : ''}">
      <div class="row"><b>${esc(j.label)}</b>${j.done ? (j.error ? `<span class="badge err">${j.aborted ? 'отменено' : 'ошибка'}</span>` : '<span class="badge ok">готово</span>')
        : `<button class="btn ghost sm" data-cancel="${j.id}">Отмена</button>`}</div>
      <small title="${esc(j.error || j.text || '')}">${esc(j.error || j.text || '')}</small>
      ${j.done ? '' : `<div class="bar"><i style="width:${(j.progress || 0) * 100}%"></i></div>`}
    </div>`).join('');
  $$('[data-cancel]').forEach((b) => { b.onclick = () => call('cancel', b.dataset.cancel); });
}

// ------------------------------------------------------------------ данные
async function refreshTools() { S.tools = await call('toolsStatus'); renderNav(); if (S.page === 'settings') render(); }
async function refreshProjects() { S.projects = await call('projects'); renderNav(); }
async function loadProject(id) {
  S.current = id;
  S.project = await call('project', id);
  if (S.page === 'projects') render();
}
async function saveSettings(patch, quiet) {
  S.settings = await call('setSettings', patch);
  if (!quiet) toast('Сохранено', 1200);
}

// ------------------------------------------------------------------ Поиск
const QUICK = [
  { q: 'twitch.tv/evelone2004', t: 'Записи стримов Twitch', icon: 'radio' },
  { q: 'эвелон стрим', t: 'YouTube: эвелон стрим', icon: 'search' },
  { q: 'evelone нарезка', t: 'YouTube: нарезки', icon: 'scissors' },
  { q: 'эвелон реакция', t: 'YouTube: реакции', icon: 'eye' },
  { q: 'эвелон лучшие моменты', t: 'YouTube: лучшие моменты', icon: 'sparkle' },
];

function pageSearch(el) {
  const s = S.settings;
  el.innerHTML = `
    <div class="search-box">${ic('search')}<input id="q" class="input" placeholder="Что искать: «эвелон стрим», ссылка на канал, плейлист или видео" value="${esc(S.lastQuery)}"></div>
    <div class="quick">${QUICK.map((x) => `<button class="chip" data-q="${esc(x.q)}">${ic(x.icon, 'sm')}${esc(x.t)}</button>`).join('')}
      <span class="grow"></span>
      <label class="row muted" style="font-size:12.5px">от <input id="minMin" class="input num" style="width:64px;height:30px" type="number" min="0" value="${s.searchMinMin}"> мин</label>
      <select id="sort" class="input" style="width:150px;height:30px"><option value="views">по просмотрам</option><option value="date">по дате</option><option value="duration">по длине</option></select>
    </div>
    <div class="grid g2" style="margin-bottom:18px">
      <div class="drop" id="drop">${ic('file-video')} Перетащи сюда видео (стрим, лонг, рилс) или <button class="btn sm" id="pick">выбери файлы</button></div>
      <div class="card" style="padding:12px"><div class="row"><textarea id="url" class="input grow" rows="2" style="resize:vertical" placeholder="Ссылки: Instagram Reels, YouTube (лонги и шортсы), Twitch, Kick, VK. Можно сразу несколько, каждую с новой строки"></textarea><button class="btn primary" id="addUrl">${ic('plus')}Добавить</button></div></div>
    </div>
    <div id="res"></div>`;
  const doSearch = async (q) => {
    if (!q.trim()) return;
    if (!S.tools.ytdlp) { toast('Сначала поставь yt-dlp: Настройки → Компоненты'); return; }
    S.lastQuery = q; S.searching = true; S.searchError = ''; drawResults();
    try {
      const minMin = +$('#minMin').value || 0;
      saveSettings({ searchMinMin: minMin }, true);
      S.results = await call('search', q, { minMin, sort: $('#sort').value, limit: 40 });
    } catch (e) { S.searchError = e.message || String(e); S.results = []; }
    S.searching = false; drawResults();
  };
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(e.target.value); };
  $$('[data-q]').forEach((b) => { b.onclick = () => { $('#q').value = b.dataset.q; doSearch(b.dataset.q); }; });
  $('#pick').onclick = async () => { try { const r = await call('addFiles'); if (r.length) { await refreshProjects(); await openProject(r[0].id); } } catch (e) { fail(e); } };
  $('#addUrl').onclick = () => addUrl($('#url').value);
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    let first = null;
    for (const f of e.dataTransfer.files) { try { const p = await call('addPath', window.api.pathOf(f)); first = first || p; } catch (err) { fail(err); } }
    if (first) { await refreshProjects(); openProject(first.id); }
  };
  drawResults();
}

async function addUrl(text) {
  const links = H.parseLinks(text);
  if (!links.length) { toast('Нужна ссылка вида https://…'); return; }
  if (!S.tools.ytdlp) { toast('Сначала поставь yt-dlp: Настройки → Компоненты'); return; }
  let first = null, failed = 0;
  for (const [i, url] of links.entries()) {
    toast(links.length > 1 ? `Добавляю ${i + 1} из ${links.length}…` : 'Добавляю…', 2500);
    // eslint-disable-next-line no-await-in-loop
    try { const p = await call('addUrl', url); first = first || p; } catch (e) { failed++; fail(links.length > 1 ? new Error(`${url}\n${e.message || e}`) : e); }
  }
  if (first) { if ($('#url')) $('#url').value = ''; await refreshProjects(); openProject(first.id); }
  if (links.length > 1) toast(`Добавлено ${links.length - failed} из ${links.length}`, 4000);
}

function drawResults() {
  const el = $('#res');
  if (!el) return;
  if (S.searching) { el.innerHTML = `<div class="empty">${ic('refresh-cw')}<b>Ищу…</b>yt-dlp смотрит YouTube и Twitch</div>`; return; }
  if (!S.results.length && S.searchError) {
    el.innerHTML = searchError(S.searchError);
    $('#retry').onclick = () => { $('#q').value = S.lastQuery; $('#q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); };
    $('#ytLog').onclick = async () => { if (!(await call('openLog'))) toast('Журнала пока нет'); };
    return;
  }
  if (!S.results.length) {
    el.innerHTML = `<div class="empty">${ic('list-video')}<b>Найди лонг или запись стрима</b>Нажми быструю кнопку сверху или вставь ссылку.<br>Нарезки лучше делать из записей, где Эвелон в кадре и много говорит.</div>`;
    return;
  }
  const added = new Set(S.projects.map((p) => p.source.url));
  el.innerHTML = `<div class="results">${S.results.map((v, i) => `
    <div class="vcard">
      <div class="thumb" style="background-image:url('${esc(v.thumb)}')">
        <span class="badge plat">${esc(v.platform)}</span>${v.duration ? `<span class="badge num">${fmtTime(v.duration)}</span>` : ''}
      </div>
      <div class="body">
        <div class="t" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="meta">${esc(v.channel)}${v.views ? ` · ${H.fmtViews(v.views)} просм.` : ''}${v.date ? ` · ${v.date.slice(6, 8)}.${v.date.slice(4, 6)}.${v.date.slice(0, 4)}` : ''}</div>
        <div class="act">
          ${added.has(v.url) ? `<span class="badge ok">${ic('check', 'sm')}добавлено</span>` : `<button class="btn sm primary" data-add="${i}">${ic('plus', 'sm')}В работу</button>`}
          <button class="btn sm ghost" data-open="${i}">${ic('external-link', 'sm')}</button>
        </div>
      </div>
    </div>`).join('')}</div>`;
  $$('[data-add]').forEach((b) => { b.onclick = () => addUrl(S.results[+b.dataset.add].url); });
  $$('[data-open]').forEach((b) => { b.onclick = () => call('openUrl', S.results[+b.dataset.open].url); });
}

/** Ошибка поиска на месте результатов: видна, пока не начнёшь новый поиск. */
const searchError = (msg) => `<div class="empty err-box">${ic('triangle-alert')}<b>Поиск не получился</b><div class="err-text">${esc(msg)}</div>
  <div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm primary" id="retry">${ic('refresh-cw', 'sm')}Повторить</button><button class="btn sm ghost" id="ytLog">Журнал yt-dlp</button></div></div>`;

// ------------------------------------------------------------------ Фон: залипательные видео и мини-игры
const fillerChips = () => S.settings.fillerQueries.map((l) => { const i = l.indexOf('='); return i < 0 ? { t: l.trim(), q: l.trim() } : { t: l.slice(0, i).trim(), q: l.slice(i + 1).trim() }; }).filter((x) => x.q);
async function refreshFillerLib() {
  try { S.fill.lib = await call('fillerList'); } catch { /* нет папки */ }
  if (S.page === 'fillers') { drawFillers(); drawFillerLib(); }
}

function pageFillers(el) {
  const s = S.settings, F = S.fill;
  el.innerHTML = `
    <div class="search-box">${ic('search')}<input id="fq" class="input" placeholder="Что искать: «slime asmr», «чистка ковров», «subway surfers gameplay» или ссылка" value="${esc(F.q)}"></div>
    <div class="quick">${fillerChips().map((x) => `<button class="chip ${F.q === x.q ? 'on' : ''}" data-fq="${esc(x.q)}">${esc(x.t)}</button>`).join('')}</div>
    <div class="row wrap" style="margin:-4px 0 16px;gap:10px">
      <div class="seg" id="lic"><button data-cc="0" class="${s.fillerCC ? '' : 'on'}">Все видео</button><button data-cc="1" class="${s.fillerCC ? 'on' : ''}">Только Creative Commons</button></div>
      <small class="muted grow">${s.fillerCC ? 'Видео, которые авторы разрешили переиспользовать. Найдётся меньше, зато без претензий.' : 'Всё подряд с YouTube. Чужие ролики могут поймать жалобу правообладателя; безопаснее «Creative Commons» или свои записи мини-игр.'}</small>
      <button class="btn sm ghost" id="fqEdit">${ic('settings', 'sm')}Запросы</button>
    </div>
    <div id="fbar"></div>
    <div id="fres"></div>
    <div class="card" id="flib" style="margin-top:18px"></div>`;
  const doSearch = async (q) => {
    if (!q.trim()) return;
    if (!S.tools.ytdlp) { toast('Сначала поставь yt-dlp: Настройки → Компоненты'); return; }
    F.q = q; F.searching = true; F.error = ''; F.sel.clear(); drawFillers();
    $$('[data-fq]').forEach((b) => b.classList.toggle('on', b.dataset.fq === q));
    try { F.results = await call('fillerSearch', q, { cc: S.settings.fillerCC, limit: 30 }); } catch (e) { F.error = e.message || String(e); F.results = []; }
    F.searching = false; drawFillers();
  };
  $('#fq').onkeydown = (e) => { if (e.key === 'Enter') doSearch(e.target.value); };
  $$('[data-fq]').forEach((b) => { b.onclick = () => { $('#fq').value = b.dataset.fq; doSearch(b.dataset.fq); }; });
  $$('#lic [data-cc]').forEach((b) => { b.onclick = async () => { await saveSettings({ fillerCC: b.dataset.cc === '1' }, true); render(); if (F.q) doSearch(F.q); }; });
  $('#fqEdit').onclick = () => { go('settings'); setTimeout(() => { const t = $('#fqList'); if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.focus(); } }, 300); };
  drawFillers();
  refreshFillerLib();
}

function addFillers(list) {
  if (!list.length) return;
  if (S.fill.busy) { toast('Уже качаю, подожди'); return; }
  S.fill.busy = true;
  call('fillerAdd', list.map((v) => ({ id: v.id, url: v.url, title: v.title, duration: v.duration })))
    .then((id) => { S.jobs.set(id, { id, kind: 'filler', label: 'Фон: скачиваю', progress: 0 }); renderDock(); S.fill.sel.clear(); drawFillers(); toast(`Качаю в библиотеку: ${list.length}`, 1800); })
    .catch((e) => { S.fill.busy = false; fail(e); });
}

function drawFillers() {
  const F = S.fill, el = $('#fres'), bar = $('#fbar');
  if (!el) return;
  const have = new Set((F.lib.files || []).map((f) => f.id).filter(Boolean));
  const fresh = F.results.filter((v) => !have.has(v.id));
  bar.innerHTML = F.results.length && !F.searching ? `
    <div class="card fbar"><b>${F.sel.size ? `Выбрано: ${F.sel.size}` : 'Нажми на превью, чтобы выбрать'}</b><span class="grow"></span>
      <button class="btn sm ghost" id="fAll" ${fresh.length ? '' : 'disabled'}>Выбрать все новые</button>
      <button class="btn sm primary" id="fAdd" ${F.sel.size && !F.busy ? '' : 'disabled'}>${ic('download', 'sm')}В библиотеку${F.sel.size ? ` (${F.sel.size})` : ''}</button></div>` : '';
  if (F.searching) { el.innerHTML = `<div class="empty">${ic('refresh-cw')}<b>Ищу…</b>yt-dlp смотрит YouTube</div>`; return; }
  if (!F.results.length && F.error) {
    el.innerHTML = searchError(F.error);
    $('#retry').onclick = () => { $('#fq').value = F.q; $('#fq').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); };
    $('#ytLog').onclick = async () => { if (!(await call('openLog'))) toast('Журнала пока нет'); };
    return;
  }
  if (!F.results.length) {
    el.innerHTML = `<div class="empty">${ic('gamepad-2')}<b>Найди фон для нижней половины</b>Нажми запрос сверху: чистка ковров, ржавые вещи, слаймы, мини-игры…<br>Выбранные видео скачиваются прямо в библиотеку фона, монтаж берёт их сам.</div>`;
    return;
  }
  el.innerHTML = `<div class="results">${F.results.map((v, i) => {
    const inLib = have.has(v.id), on = F.sel.has(v.id);
    return `<div class="vcard ${on ? 'sel' : ''} ${inLib ? 'inlib' : ''}">
      <div class="thumb" data-pick="${i}" style="background-image:url('${esc(v.thumb)}');cursor:${inLib ? 'default' : 'pointer'}">
        ${inLib ? `<span class="lib-tag">${ic('check', 'sm')}в библиотеке</span>` : `<span class="tick">${ic(on ? 'square-check' : 'square')}</span>`}
        ${v.duration ? `<span class="badge num">${fmtTime(v.duration)}</span>` : ''}
      </div>
      <div class="body">
        <div class="t" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="meta">${esc(v.channel)}${v.views ? ` · ${H.fmtViews(v.views)} просм.` : ''}${v.duration > 660 ? ' · возьмём первые 10 мин' : ''}</div>
        <div class="act">${inLib ? '' : `<button class="btn sm primary" data-one="${i}" ${F.busy ? 'disabled' : ''}>${ic('download', 'sm')}В библиотеку</button>`}
          <button class="btn sm ghost" data-fopen="${i}" title="Открыть на YouTube">${ic('external-link', 'sm')}</button></div>
      </div>
    </div>`;
  }).join('')}</div>`;
  $$('[data-pick]').forEach((b) => { b.onclick = () => { const v = F.results[+b.dataset.pick]; if (have.has(v.id)) return; if (F.sel.has(v.id)) F.sel.delete(v.id); else F.sel.add(v.id); drawFillers(); }; });
  $$('[data-one]').forEach((b) => { b.onclick = () => addFillers([F.results[+b.dataset.one]]); });
  $$('[data-fopen]').forEach((b) => { b.onclick = () => call('openUrl', F.results[+b.dataset.fopen].url); });
  if ($('#fAll')) $('#fAll').onclick = () => { fresh.forEach((v) => F.sel.add(v.id)); drawFillers(); };
  if ($('#fAdd')) $('#fAdd').onclick = () => addFillers(F.results.filter((v) => F.sel.has(v.id)));
}

function drawFillerLib() {
  const el = $('#flib');
  if (!el) return;
  const { dir, files } = S.fill.lib;
  const mb = (b) => `${Math.max(1, Math.round(b / 1048576))} МБ`;
  el.innerHTML = `
    <div class="row"><div class="grow"><h3>Библиотека фона <span class="badge num">${files.length}</span></h3>
      <p class="hint" style="margin:0">Отсюда монтаж берёт низ для раскладки «Стрим сверху, мини-игра снизу». Звук фона в ролик не идёт.</p></div>
      <button class="btn sm" id="flOpen" ${dir ? '' : 'disabled'}>${ic('folder-open', 'sm')}Открыть папку</button>
      <button class="btn sm ghost" id="flPick">Сменить папку</button></div>
    <small class="muted">${esc(dir || 'папка не выбрана')}</small>
    ${files.length ? `<div class="flist">${files.map((f, i) => `<div class="fitem"><span class="grow" title="${esc(f.name)}">${esc(f.name.replace(/-\[[\w-]+\]\.\w+$/, ''))}</span><span class="muted num">${mb(f.size)}</span>
      <button class="btn sm ghost" data-fshow="${i}" title="Показать в папке">${ic('eye', 'sm')}</button><button class="btn sm ghost" data-frm="${i}" title="Убрать из библиотеки">${ic('trash-2', 'sm')}</button></div>`).join('')}</div>`
    : '<p class="muted" style="margin:10px 0 0">Пока пусто: выбери видео выше или положи свои записи мини-игр в эту папку.</p>'}`;
  if (dir) $('#flOpen').onclick = () => call('openPath', dir);
  $('#flPick').onclick = async () => { const d = await call('pickFolder', 'Папка библиотеки фона'); if (d) { await saveSettings({ fillerDir: d }, true); refreshFillerLib(); } };
  $$('[data-fshow]').forEach((b) => { b.onclick = () => call('showItem', files[+b.dataset.fshow].path); });
  $$('[data-frm]').forEach((b) => { b.onclick = async () => { try { S.fill.lib = await call('fillerRemove', files[+b.dataset.frm].path); drawFillerLib(); drawFillers(); } catch (e) { fail(e); } }; });
}

// ------------------------------------------------------------------ Моменты
async function openProject(id) { S.page = 'projects'; renderNav(); await loadProject(id); }

function pageProjects(el) {
  if (!S.projects.length) {
    el.className = 'page';
    el.innerHTML = `<div class="empty">${ic('scissors')}<b>Пока нет источников</b>Добавь запись стрима на вкладке «Поиск»: ссылкой или файлом.<br><br><button class="btn primary" id="toSearch">${ic('search')}Найти видео</button></div>`;
    $('#toSearch').onclick = () => go('search');
    return;
  }
  if (!S.current || !S.projects.some((p) => p.id === S.current)) { loadProject(S.projects[0].id); return; }
  const pr = S.project;
  el.innerHTML = `
    <div class="plist">${S.projects.map((p) => `
      <div class="pitem ${p.id === S.current ? 'on' : ''}" data-p="${p.id}">
        <div class="pt" style="${p.source.thumb ? `background-image:url('${esc(p.source.thumb)}')` : ''}">${p.source.thumb ? '' : ic('film')}</div>
        <div class="grow"><b>${esc(p.title)}</b><small>${fmtTime(p.source.duration)} · ${p.analyzed ? `${p.moments.filter((m) => m.selected).length} из ${p.moments.length} выбрано` : 'не разобран'}</small></div>
      </div>`).join('')}</div>
    <div id="pmain">${pr ? projectMain(pr) : ''}</div>`;
  $$('[data-p]').forEach((d) => { d.onclick = () => loadProject(d.dataset.p); });
  if (pr) bindProject(pr);
}

function checkBadges(m) {
  const c = m.check;
  const out = [];
  if (m.wordCount != null || (m.words && m.words.length)) out.push(`<span class="badge">${ic('captions', 'sm')}${m.wordCount ?? m.words.length} слов</span>`);
  if (c) {
    for (const i of c.issues) out.push(`<span class="badge err">${ic('triangle-alert', 'sm')}${esc(i)}</span>`);
    for (const w of c.warn) out.push(`<span class="badge warn">${esc(w)}</span>`);
    if (c.ok && !c.warn.length) out.push(`<span class="badge ok">${ic('shield-check', 'sm')}правила</span>`);
  }
  if (m.ok) out.push(`<span class="badge acc">${ic('check', 'sm')}Эвелон главный</span>`);
  return out.join('');
}

function projectMain(pr) {
  const s = S.settings;
  const job = [...S.jobs.values()].find((j) => !j.done && (j.kind === 'analyze' || j.kind === 'check'));
  const sel = pr.moments.filter((m) => m.selected).length;
  const maxScore = Math.max(1, ...pr.moments.map((m) => m.score || 0));
  const needCam = s.formats.some((f) => S.cat.camLayouts.includes(f));
  const nCams = H.camsOf(pr.frame).length;
  return `
    ${!pr.frame && needCam ? `<div class="card notice"><span class="warnc">${ic('triangle-alert')}</span><div class="grow"><b>Отметь, где вебка</b><small>Без рамки ролики «вебка сверху» не соберутся. Нажми «Рамка вебки» → «Найти лицо» → «Сохранить». Если вебки в видео нет — «Без вебки».</small></div></div>` : ''}
    <div class="card">
      <div class="row wrap">
        <div class="grow"><h3>${esc(pr.title)}</h3><p class="hint" style="margin:0">${esc(pr.streamer || pr.source.platform)} · ${fmtTime(pr.source.duration)} · ${pr.source.width}×${pr.source.height}${pr.chatCount ? ` · чат: ${pr.chatCount} сообщений` : ''}${(pr.blurs || []).length ? ` · блюр: ${pr.blurs.length}` : ''}</p></div>
        <button class="btn ${!pr.frame && needCam ? 'primary' : ''}" id="frameBtn">${ic('scan-face')}${pr.frame ? (nCams > 1 ? `Вебки: ${nCams} ✓` : nCams ? 'Рамка вебки ✓' : 'Без вебки ✓') : 'Рамка вебки'}</button>
        <button class="btn ${pr.analyzed ? '' : 'primary'}" id="anBtn" ${job ? 'disabled' : ''}>${ic('audio-lines')}${pr.analyzed ? 'Искать заново' : 'Найти моменты'}</button>
        <button class="btn" id="chkBtn" ${job || !sel ? 'disabled' : ''}>${ic('shield-check')}Проверить</button>
        <button class="btn ghost danger icon" id="delBtn" title="Убрать источник">${ic('trash-2')}</button>
      </div>
      <div id="projJob" style="margin-top:10px">${jobInline(job)}</div>
      ${pr.analyzed ? `<div class="timeline" id="tl" style="margin-top:12px"><canvas></canvas></div>` : ''}
    </div>
    ${pr.analyzed ? `
    <div class="card">
      <div class="row wrap">
        <h3 class="grow">Моменты <span class="muted num" style="font-weight:400">· выбрано ${sel} из ${pr.moments.length}</span></h3>
        <button class="btn sm ghost" id="selAll">Выбрать все</button><button class="btn sm ghost" id="selNone">Снять все</button>
        <span class="faint">|</span>
        <input id="mStart" class="input num" style="width:86px;height:30px" placeholder="12:30"><span class="faint">–</span><input id="mEnd" class="input num" style="width:86px;height:30px" placeholder="13:05">
        <button class="btn sm" id="mAdd">${ic('plus', 'sm')}Свой отрезок</button>
      </div>
      <p class="hint" style="margin-top:6px">Заголовок пишется в две строки через «|»: «Контратака | хорошая». Галочка «Эвелон главный» — твоя проверка по правилам конкурса${s.rules.requireOk ? ' (без неё момент не соберётся)' : ''}.</p>
      <div id="mprev"></div>
      <div class="moments">${pr.moments.map((m) => `
        <div class="mom ${m.selected ? '' : 'off'} ${S.activeMoment === m.id ? 'active' : ''}" data-m="${m.id}">
          <button class="box ${m.selected ? 'on' : ''}" data-sel title="Брать в нарезку">${m.selected ? ic('check', 'sm') : ''}</button>
          <div class="tm"><b>${fmtTime(m.start)}–${fmtTime(m.end)}</b><span class="muted">${Math.round(m.end - m.start)} с${m.manual ? ' · свой' : ''}${m.whole && !m.trimmed ? ' · всё видео' : ''}${m.trimmed ? ' · обрезан' : ''}</span>
            <div class="score"><i style="width:${Math.max(4, (m.score || 0) / maxScore * 100)}%"></i></div></div>
          <div class="grow"><input class="input" data-title value="${esc(m.title || '')}" placeholder="Заголовок: строка 1 | строка 2">
            <div class="chk">${checkBadges(m)}</div></div>
          <div class="tools">
            <button class="btn sm icon ghost" data-play title="Посмотреть">${ic('play', 'sm')}</button>
            <button class="btn sm icon ghost" data-edit title="Обрезать и заблюрить">${ic('scissors', 'sm')}</button>
            <button class="btn sm ${m.ok ? 'primary' : 'ghost'}" data-ok title="Эвелон — главное лицо">${ic('scan-face', 'sm')}</button>
          </div>
        </div>`).join('')}</div>
    </div>` : `<div class="card"><div class="empty" style="padding:30px">${ic('audio-lines')}<b>Нажми «Найти моменты»</b>Программа послушает звук (смех, крики, всплески) и чат, если он есть, и предложит отрезки.<br>Для ссылки сначала скачивается только звук, видео — потом, лишь нужные куски.</div></div>`}`;
}

function bindProject(pr) {
  $('#anBtn').onclick = async () => { try { const id = await call('analyze', pr.id); S.jobs.set(id, { id, kind: 'analyze', label: 'Поиск моментов', progress: 0 }); render(); } catch (e) { fail(e); } };
  $('#chkBtn').onclick = async () => { try { const id = await call('check', pr.id); S.jobs.set(id, { id, kind: 'check', label: 'Проверка правил', progress: 0 }); render(); } catch (e) { fail(e); } };
  $('#delBtn').onclick = async () => {
    if (!confirmInline($('#delBtn'))) return;
    await call('removeProject', pr.id); S.current = null; S.project = null; await refreshProjects(); render();
  };
  $('#frameBtn').onclick = () => openFramer(pr);
  if (!pr.analyzed) return;
  drawTimeline(pr);
  // слова не приходят в списке (wordCount), поэтому сохраняем полный проект с диска
  const updFull = async (fn) => {
    const full = await call('project', pr.id);
    fn(full.moments);
    await call('updateProject', pr.id, { moments: full.moments });
    S.project = full;
  };
  $$('.mom').forEach((row) => {
    const id = row.dataset.m;
    $('[data-sel]', row).onclick = async () => { await updFull((ms) => { const m = ms.find((x) => x.id === id); m.selected = !m.selected; }); await refreshProjects(); render(); };
    $('[data-ok]', row).onclick = async () => { await updFull((ms) => { const m = ms.find((x) => x.id === id); m.ok = !m.ok; }); render(); };
    $('[data-title]', row).onchange = (e) => updFull((ms) => { ms.find((x) => x.id === id).title = e.target.value.trim(); });
    $('[data-play]', row).onclick = () => playMoment(pr, id);
    $('[data-edit]', row).onclick = () => openEditor(pr, id).catch(fail);
  });
  $('#selAll').onclick = async () => { await updFull((ms) => ms.forEach((m) => { m.selected = true; })); await refreshProjects(); render(); };
  $('#selNone').onclick = async () => { await updFull((ms) => ms.forEach((m) => { m.selected = false; })); await refreshProjects(); render(); };
  $('#mAdd').onclick = async () => {
    const a = H.parseTime($('#mStart').value), b = H.parseTime($('#mEnd').value);
    if (!(b > a)) { toast('Укажи начало и конец, например 12:30 и 13:05'); return; }
    try { S.project = await call('addMoment', pr.id, a, b); await refreshProjects(); render(); } catch (e) { fail(e); }
  };
}

function confirmInline(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; btn.classList.add('primary'); btn.title = 'Нажми ещё раз, чтобы убрать';
  toast('Нажми ещё раз, чтобы убрать источник');
  setTimeout(() => { delete btn.dataset.armed; btn.classList.remove('primary'); }, 3000);
  return false;
}

function drawTimeline(pr) {
  const box = $('#tl');
  if (!box) return;
  const cv = $('canvas', box);
  const dpr = window.devicePixelRatio || 1;
  const W = box.clientWidth, Hh = box.clientHeight;
  cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const env = pr.envelope || [];
  const dur = pr.source.duration || 1;
  const lo = Math.min(...env, -60), hi = Math.max(...env, -10);
  g.fillStyle = 'rgba(255,255,255,.16)';
  const bw = W / Math.max(1, env.length);
  env.forEach((v, i) => { const h = Math.max(2, ((v - lo) / (hi - lo || 1)) * (Hh - 16)); g.fillRect(i * bw, Hh - 8 - h, Math.max(1, bw - 1), h); });
  for (const m of pr.moments) {
    const x = (m.start / dur) * W, w = Math.max(3, ((m.end - m.start) / dur) * W);
    g.fillStyle = m.selected ? 'rgba(200,255,61,.22)' : 'rgba(255,255,255,.07)';
    g.fillRect(x, 0, w, Hh);
    g.fillStyle = m.selected ? '#c8ff3d' : 'rgba(255,255,255,.35)';
    g.fillRect(x, 0, w, 3);
  }
  box.onclick = (e) => {
    const t = (e.offsetX / W) * dur;
    const m = pr.moments.find((x) => t >= x.start && t <= x.end);
    if (m) { S.activeMoment = m.id; const row = $(`[data-m="${m.id}"]`); if (row) { row.scrollIntoView({ block: 'center' }); $$('.mom').forEach((r) => r.classList.toggle('active', r === row)); } }
  };
}

async function playMoment(pr, id) {
  const el = $('#mprev');
  S.activeMoment = id;
  $$('.mom').forEach((r) => r.classList.toggle('active', r.dataset.m === id));
  el.innerHTML = `<div class="muted" style="padding:10px 0">Готовлю кусок…</div>`;
  try {
    const c = await call('clip', pr.id, id);
    el.innerHTML = `<video class="vprev" controls autoplay src="${esc(c.src)}#t=${c.start.toFixed(2)},${c.end.toFixed(2)}" style="margin:6px 0 4px"></video>`;
  } catch (e) { el.innerHTML = ''; fail(e); }
}

// ------------------------------------------------------------------ обрезка и блюр
/** Окно момента: обрезать начало и конец, размыть области (ник, вотермарка, лицо, чужой чат) на всё видео или на время. */
async function openEditor(pr, mid) {
  const m = $('#modal');
  const full = await call('project', pr.id);
  const mom = full.moments.find((x) => x.id === mid);
  if (!mom) return;
  const W = pr.source.width || 1920, Hh = pr.source.height || 1080;
  const dur = pr.source.duration || mom.end;
  const ed = { start: mom.start, end: mom.end, blurs: (full.blurs || []).map((b) => ({ ...b })) };
  let clip = null; // {src, offset}: видео-кусок и сколько секунд исходника до его начала
  m.hidden = false;
  m.innerHTML = `<div class="dlg">
    <div class="row"><div class="grow"><h2>Обрезка и блюр</h2><p class="hint">Двигай ползунок видео и жми «сюда», чтобы поставить начало и конец. Блюр — размытая рамка: тяни её мышью, уголок меняет размер. Блюр действует на всё видео-источник, во всех его роликах.</p></div>
      <button class="btn ghost icon" id="ex">${ic('x')}</button></div>
    <div id="estage" class="estage"><div class="empty">Готовлю видео…</div></div>
    <div class="grid g2" style="margin-top:12px">
      <div class="card flat"><h3>Обрезка</h3>
        <div class="row" style="margin-top:6px"><span class="muted" style="width:60px">Начало</span><input class="input num" id="eS" style="width:96px"><button class="btn sm" id="eSnow">${ic('arrow-right', 'sm')}сюда</button></div>
        <div class="row" style="margin-top:6px"><span class="muted" style="width:60px">Конец</span><input class="input num" id="eE" style="width:96px"><button class="btn sm" id="eEnow">${ic('arrow-right', 'sm')}сюда</button></div>
        <div class="row" style="margin-top:8px"><button class="btn sm" id="ePlay">${ic('play', 'sm')}Проиграть отрезок</button><small class="muted grow" id="eLen"></small></div>
      </div>
      <div class="card flat"><div class="row"><h3 class="grow">Блюр</h3><button class="btn sm" id="eAdd">${ic('plus', 'sm')}Добавить блюр</button></div>
        <div id="eBl" class="stack" style="margin-top:6px"></div></div>
    </div>
    <div class="row" style="margin-top:14px"><span class="grow"></span><button class="btn ghost" id="eCancel">Отмена</button><button class="btn primary" id="eSave">${ic('check')}Сохранить</button></div></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('#ex').onclick = close; $('#eCancel').onclick = close;
  const vid = () => $('#ev');
  const now = () => (vid() && clip ? clip.offset + vid().currentTime : ed.start);
  const tf = (t) => H.fmtTimeP(t);
  const active = (b, t) => (b.start == null || t >= b.start) && (b.end == null || t <= b.end);
  const drawTrim = () => {
    $('#eS').value = tf(ed.start); $('#eE').value = tf(ed.end);
    $('#eLen').textContent = `длина ${Math.round((ed.end - ed.start) * 10) / 10} с`;
  };
  const drawRects = () => {
    const ov = $('#eov');
    if (!ov) return;
    const t = now();
    ov.innerHTML = ed.blurs.map((b, i) => `<div class="rect blur ${active(b, t) ? '' : 'off'}" data-i="${i}"><span class="lbl">блюр ${i + 1}</span><button class="del" data-del="${i}" title="Убрать блюр">×</button><span class="h"></span></div>`).join('');
    $$('.rect', ov).forEach((el) => { const b = ed.blurs[+el.dataset.i]; Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }); });
    $$('[data-del]', ov).forEach((x) => { x.onpointerdown = (e) => e.stopPropagation(); x.onclick = () => { ed.blurs.splice(+x.dataset.del, 1); drawAll(); }; });
    $$('.rect', ov).forEach((el) => {
      el.onpointerdown = (e) => {
        if (e.target.dataset.del != null) return;
        const resize = e.target.classList.contains('h');
        const B = ov.getBoundingClientRect(), i = +el.dataset.i, st = { ...ed.blurs[i] }, x0 = e.clientX, y0 = e.clientY;
        el.setPointerCapture(e.pointerId);
        el.onpointermove = (ev) => {
          const dx = (ev.clientX - x0) / B.width, dy = (ev.clientY - y0) / B.height;
          const r = H.clampRect(resize ? { ...st, w: st.w + dx, h: st.h + dy } : { ...st, x: st.x + dx, y: st.y + dy }, 0.02);
          Object.assign(ed.blurs[i], r);
          Object.assign(el.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
        };
        el.onpointerup = () => { el.onpointermove = null; };
        e.stopPropagation(); e.preventDefault();
      };
    });
  };
  const drawList = () => {
    $('#eBl').innerHTML = ed.blurs.length ? ed.blurs.map((b, i) => `
      <div class="blrow" data-b="${i}"><b>${i + 1}</b>
        <label class="row muted" style="font-size:12.5px"><input type="checkbox" data-all ${b.start == null && b.end == null ? 'checked' : ''}> всё видео</label>
        ${b.start == null && b.end == null ? '' : `<span class="row">с <input class="input num" data-bs value="${b.start == null ? '' : tf(b.start)}" placeholder="начала" style="width:78px"><button class="btn sm ghost" data-bsn title="С текущего места видео">сюда</button>
          по <input class="input num" data-be value="${b.end == null ? '' : tf(b.end)}" placeholder="конца" style="width:78px"><button class="btn sm ghost" data-ben title="До текущего места видео">сюда</button></span>`}
      </div>`).join('') : '<small class="muted">Нет блюра. «Добавить блюр» поставит рамку посередине кадра: перетащи её на ник, вотермарку или лицо.</small>';
    $$('.blrow').forEach((row) => {
      const b = ed.blurs[+row.dataset.b];
      $('[data-all]', row).onchange = (e) => { if (e.target.checked) { b.start = null; b.end = null; } else { b.start = Math.max(0, Math.floor(now())); b.end = Math.min(dur, b.start + 5); } drawAll(); };
      const setT = (k, v) => { b[k] = v === '' ? null : v; drawRects(); };
      if ($('[data-bs]', row)) {
        $('[data-bs]', row).onchange = (e) => { const v = e.target.value.trim() === '' ? '' : H.parseTime(e.target.value); if (v === '' || Number.isFinite(v)) setT('start', v); };
        $('[data-be]', row).onchange = (e) => { const v = e.target.value.trim() === '' ? '' : H.parseTime(e.target.value); if (v === '' || Number.isFinite(v)) setT('end', v); };
        $('[data-bsn]', row).onclick = () => { b.start = Math.round(now() * 10) / 10; drawAll(); };
        $('[data-ben]', row).onclick = () => { b.end = Math.round(now() * 10) / 10; drawAll(); };
      }
    });
  };
  const drawAll = () => { drawTrim(); drawRects(); drawList(); };
  $('#eS').onchange = (e) => { const v = H.parseTime(e.target.value); if (Number.isFinite(v)) ed.start = Math.max(0, v); drawTrim(); };
  $('#eE').onchange = (e) => { const v = H.parseTime(e.target.value); if (Number.isFinite(v)) ed.end = Math.min(dur, v); drawTrim(); };
  $('#eSnow').onclick = () => { ed.start = Math.round(now() * 10) / 10; drawTrim(); };
  $('#eEnow').onclick = () => { ed.end = Math.round(now() * 10) / 10; drawTrim(); };
  $('#ePlay').onclick = () => { const v = vid(); if (!v) return; v.currentTime = Math.max(0, ed.start - clip.offset); v.play(); };
  $('#eAdd').onclick = () => { if (ed.blurs.length >= 12) { toast('Не больше 12 блюров'); return; } ed.blurs.push({ id: `b${Date.now().toString(36)}`, x: 0.35, y: 0.4, w: 0.3, h: 0.14, start: null, end: null }); drawAll(); };
  $('#eSave').onclick = async () => {
    if (!(ed.end - ed.start >= 1)) { toast('Конец должен быть хотя бы на секунду позже начала'); return; }
    try {
      const f2 = await call('project', pr.id);
      const ms = f2.moments.map((x) => (x.id === mid ? { ...x, start: ed.start, end: ed.end } : x));
      await call('updateProject', pr.id, { moments: ms, blurs: ed.blurs });
      S.project = await call('project', pr.id);
      await refreshProjects(); close(); render();
      toast(ed.blurs.length ? `Сохранено, блюров: ${ed.blurs.length}` : 'Сохранено');
    } catch (e) { fail(e); }
  };
  drawAll();
  try {
    clip = await call('clip', pr.id, mid, 20);
    const box = $('#estage');
    if (!box) return;
    // размер сцены под кадр источника: рамки блюра в долях кадра совпадают с картинкой
    const maxW = box.clientWidth || 800, maxH = Math.round(window.innerHeight * 0.5);
    const k = Math.min(maxW / W, maxH / Hh);
    box.innerHTML = `<div class="evid" style="width:${Math.round(W * k)}px;height:${Math.round(Hh * k)}px"><video id="ev" src="${esc(clip.src)}" controls preload="auto"></video><div id="eov" class="eov"></div></div>`;
    const v = vid();
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.max(0, ed.start - clip.offset); }, { once: true });
    v.addEventListener('timeupdate', () => { if ($('#eov')) $$('.rect', $('#eov')).forEach((el) => el.classList.toggle('off', !active(ed.blurs[+el.dataset.i] || {}, now()))); });
    drawRects();
  } catch (e) { const box = $('#estage'); if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ------------------------------------------------------------------ рамка вебки
async function openFramer(pr) {
  const m = $('#modal');
  const init = pr.frame || (pr.streamer && S.settings.presets[pr.streamer]) || {};
  const fr = { cams: H.camsOf(init).map((r) => ({ ...r })), content: { x: 0, y: 0, w: 1, h: 1, ...(init.content || {}) } };
  const t0 = (pr.moments.find((x) => x.selected) || { peak: (pr.source.duration || 60) * 0.3 }).peak;
  m.hidden = false;
  m.innerHTML = `<div class="dlg">
    <div class="row"><div class="grow"><h2>Где вебки и где контент</h2><p class="hint">Зелёные рамки — вебки (можно несколько, до 4), пунктир — то, что смотрят или во что играют. Тяни рамку мышью, уголок меняет размер, крестик удаляет вебку.</p></div>
      <button class="btn ghost icon" id="fx">${ic('x')}</button></div>
    <div class="framer" id="fr"><div class="empty" style="aspect-ratio:16/9">Загружаю кадр…</div></div>
    <div class="row wrap" style="margin-top:14px">
      <button class="btn" id="fAuto">${ic('scan-face')}Найти лица</button>
      <button class="btn" id="fAdd">${ic('plus')}Ещё вебка</button>
      <button class="btn" id="fOther">${ic('refresh-cw')}Другой кадр</button>
      <button class="btn ghost" id="fNoCam" title="В этом видео нет вебки: ролики соберутся без неё">Без вебки</button>
      <span class="grow"></span>
      ${pr.streamer ? `<label class="row muted" style="font-size:12.5px"><input type="checkbox" id="fPreset" checked> запомнить для «${esc(pr.streamer)}»</label>` : ''}
      <button class="btn primary" id="fSave">${ic('check')}Сохранить</button>
    </div></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('#fx').onclick = close;
  let t = t0, src = null;
  const rect = (k, i, label) => `<div class="rect ${k}" data-k="${k}" ${i != null ? `data-i="${i}"` : ''}><span class="lbl">${label}</span>${i != null ? `<button class="del" data-del="${i}" title="Убрать эту вебку">×</button>` : ''}<span class="h"></span></div>`;
  const draw = () => {
    if (!src) return;
    $('#fr').innerHTML = `<img id="fimg" src="${src}">${rect('content', null, 'контент')}${fr.cams.map((_, i) => rect('cam', i, fr.cams.length > 1 ? `вебка ${i + 1}` : 'вебка')).join('')}`;
    const place = (el, r) => Object.assign(el.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    place($('.rect.content'), fr.content);
    $$('.rect.cam').forEach((el) => place(el, fr.cams[+el.dataset.i]));
    $('#fAdd').disabled = fr.cams.length >= 4;
    bindDrag();
  };
  const load = async () => {
    try { src = await call('frame', pr.id, t); draw(); } catch (e) { $('#fr').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  const get = (el) => (el.dataset.k === 'cam' ? fr.cams[+el.dataset.i] : fr.content);
  const set = (el, r) => { if (el.dataset.k === 'cam') fr.cams[+el.dataset.i] = r; else fr.content = r; };
  const bindDrag = () => {
    const box = $('#fr');
    $$('[data-del]', box).forEach((b) => { b.onpointerdown = (e) => e.stopPropagation(); b.onclick = () => { fr.cams.splice(+b.dataset.del, 1); draw(); }; });
    $$('.rect', box).forEach((el) => {
      el.onpointerdown = (e) => {
        if (e.target.dataset.del != null) return;
        const resize = e.target.classList.contains('h');
        const B = box.getBoundingClientRect(), start = { ...get(el) }, x0 = e.clientX, y0 = e.clientY;
        el.setPointerCapture(e.pointerId);
        el.onpointermove = (ev) => {
          const dx = (ev.clientX - x0) / B.width, dy = (ev.clientY - y0) / B.height;
          const r = H.clampRect(resize ? { ...start, w: start.w + dx, h: start.h + dy } : { ...start, x: start.x + dx, y: start.y + dy });
          set(el, r);
          Object.assign(el.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
        };
        el.onpointerup = () => { el.onpointermove = null; };
        e.stopPropagation();
      };
    });
  };
  $('#fOther').onclick = () => { t = Math.random() * (pr.source.duration || 60); load(); };
  $('#fAdd').onclick = () => { if (fr.cams.length < 4) { fr.cams.push(H.nextCamSlot(fr.cams)); draw(); } };
  $('#fNoCam').onclick = () => { fr.cams = []; draw(); toast('Вебки нет — нажми «Сохранить», ролики соберутся без неё', 3500); };
  $('#fAuto').onclick = async () => {
    const img = $('#fimg');
    if (!img) return;
    if (!('FaceDetector' in window)) { if (!fr.cams.length) fr.cams.push(H.nextCamSlot([])); draw(); toast('Автопоиск лица недоступен на этой системе — поставил рамку в угол, поправь вручную'); return; }
    try {
      const faces = await new window.FaceDetector({ fastMode: false, maxDetectedFaces: 8 }).detect(img);
      const cams = H.facesToCams(faces, img.naturalWidth, img.naturalHeight);
      if (!cams.length) { toast('Лицо не найдено, попробуй другой кадр'); return; }
      fr.cams = cams; draw();
      if (cams.length > 1) toast(`Нашёл ${cams.length} ${H.plural(cams.length, 'лицо', 'лица', 'лиц')}. Лишние (например, лица в игре) убери крестиком`, 5000);
    } catch (e) { fail(e); }
  };
  $('#fSave').onclick = async () => {
    const frame = { cams: fr.cams, cam: fr.cams[0] || null, content: fr.content };
    try {
      S.project = await call('project', (await call('updateProject', pr.id, { frame })).id);
      if ($('#fPreset') && $('#fPreset').checked && pr.streamer) await saveSettings({ presets: { ...S.settings.presets, [pr.streamer]: frame } }, true);
      close(); render(); toast(fr.cams.length > 1 ? `Сохранено: ${fr.cams.length} вебки` : 'Рамка сохранена');
    } catch (e) { fail(e); }
  };
  load();
}

// ------------------------------------------------------------------ Монтаж
function phone(key, split, fit) {
  const colors = { cam: '#c8ff3d', video: 'rgba(255,255,255,.55)', stream: 'rgba(124,196,255,.7)', game: 'rgba(242,201,76,.7)', blur: 'rgba(255,255,255,.12)' };
  return `<div class="phone">${H.layoutBands(key, split, fit).map((b) => `<i style="height:${b.h * 100}%;background:${colors[b.kind]};opacity:.85;border-bottom:1px solid rgba(0,0,0,.4)"></i>`).join('')}</div>`;
}

function pageEdit(el) {
  const s = S.settings, cat = S.cat;
  const fmtOn = (k) => s.formats.indexOf(k);
  el.innerHTML = `
    <div class="card">
      <h3>Раскладки</h3><p class="hint">Отметь несколько: канал 1 получит первую, канал 2 — вторую и так по кругу. Один и тот же момент у разных каналов выйдет в разных раскладках. Если в рамке отмечено несколько вебок, они встают рядом (или друг под другом); «Две вебки» нужны две рамки, с одной она соберётся как «Реакция сверху».</p>
      <div class="layouts">${Object.entries(cat.layouts).map(([k, name]) => `
        <button class="lay ${fmtOn(k) >= 0 ? 'on' : ''}" data-lay="${k}">${fmtOn(k) >= 0 ? `<span class="badge acc ord">${fmtOn(k) + 1}</span>` : ''}${phone(k, s.split, s.fit)}<div class="cap">${esc(name)}</div></button>`).join('')}</div>
      <div class="grid g2" style="margin-top:14px">
        <div class="field"><span>Видео (игра, ролик) в раскладках с вебкой</span>
          <div class="seg" id="fitSeg">${Object.entries(cat.fits).map(([k, n]) => `<button class="${s.fit === k ? 'on' : ''}" data-fit="${k}">${esc(n)}</button>`).join('')}</div></div>
        <div class="field"><span>Доля вебки (раскладки «Реакция сверху» и «Видео сверху, реакция снизу»)</span><div class="range"><input type="range" id="split" min="0.25" max="0.55" step="0.01" value="${s.split}"><output>${Math.round(s.split * 100)}%</output></div></div>
        <div class="field"><span>Папка с мини-играми (для «Стрим сверху, мини-игра снизу»)</span>
          <div class="row"><input class="input grow" id="filler" readonly value="${esc(s.fillerDir)}" placeholder="не выбрана — раскладка пропускается"><button class="btn" id="fillerPick">${ic('folder-open')}</button></div></div>
      </div>
    </div>
    <div class="card">
      <h3>Субтитры</h3><p class="hint">Тоже по кругу между каналами. Слово, которое сейчас звучит, подсвечивается.</p>
      <div class="styles">${Object.entries(cat.subStyles).map(([k, st]) => `
        <button class="sty ${s.subStyles.includes(k) ? 'on' : ''}" data-sty="${k}">
          <div class="demo"><span style="${H.subCss(st)}">тот самый <span style="color:${st.active}">кент</span></span></div>
          <div class="nm"><span>${esc(st.name)}</span>${s.subStyles.includes(k) ? `<span class="badge acc">${s.subStyles.indexOf(k) + 1}</span>` : ''}</div>
        </button>`).join('')}</div>
      <div class="grid g3" style="margin-top:14px">
        <label class="switch"><div><b>Субтитры</b><small>распознавание речи на видеокарте</small></div><input type="checkbox" id="subsOn" ${s.subsOn ? 'checked' : ''}></label>
        <div class="field"><span>Слов на экране</span><div class="range"><input type="range" id="maxWords" min="1" max="5" step="1" value="${s.maxWords}"><output>${s.maxWords}</output></div></div>
        <div class="field"><span>Язык речи</span><select class="input" id="lang"><option value="ru">русский</option><option value="en">английский</option><option value="auto">определить</option></select></div>
      </div>
    </div>
    <div class="card">
      <h3>Заголовок</h3><p class="hint">Крупный текст на стыке кадров. Берётся из поля заголовка у момента.</p>
      <div class="row wrap">${Object.entries(cat.titleStyles).map(([k, t]) => `
        <button class="chip ${s.titleStyle === k ? 'on' : ''}" data-ts="${k}">${t.font ? `<span class="title-demo" style="font-size:13px;color:${t.line2};${t.glow ? `text-shadow:0 0 8px ${t.glow}` : ''}">${esc(t.name)}</span>` : esc(t.name)}</button>`).join('')}
        <span class="grow"></span>
        <label class="row muted" style="font-size:12.5px">показывать <input class="input num" id="titleDur" type="number" min="0" max="60" style="width:64px;height:30px" value="${s.titleDur}"> с (0 — весь ролик)</label>
      </div>
    </div>
    <div class="card">
      <h3>Отличия между каналами</h3>
      <label class="switch"><div><b>Мелкие отличия</b><small>зум 2–7%, цвет, скорость до +5% — у повторов момента</small></div><input type="checkbox" id="vary" ${s.vary ? 'checked' : ''}></label>
      <label class="switch"><div><b>Зеркалить контент</b><small>не трогает вебку; надписи в игре будут наоборот</small></div><input type="checkbox" id="mirror" ${s.allowMirror ? 'checked' : ''}></label>
      <label class="switch"><div><b>Ускорение</b><small>до +5%, голос не меняется</small></div><input type="checkbox" id="speed" ${s.allowSpeed ? 'checked' : ''}></label>
      <label class="switch"><div><b>Выравнивание громкости</b><small>−14 LUFS, как требует TikTok</small></div><input type="checkbox" id="loud" ${s.loudnorm ? 'checked' : ''}></label>
    </div>`;
  $('#lang').value = s.lang;
  $$('[data-lay]').forEach((b) => { b.onclick = async () => {
    const k = b.dataset.lay; let f = [...s.formats];
    f = f.includes(k) ? f.filter((x) => x !== k) : [...f, k];
    if (!f.length) { toast('Нужна хотя бы одна раскладка'); return; }
    await saveSettings({ formats: f }, true); render();
  }; });
  $$('[data-sty]').forEach((b) => { b.onclick = async () => {
    const k = b.dataset.sty; let f = [...s.subStyles];
    f = f.includes(k) ? f.filter((x) => x !== k) : [...f, k];
    if (!f.length) { toast('Нужен хотя бы один стиль'); return; }
    await saveSettings({ subStyles: f, subStyle: f[0] }, true); render();
  }; });
  $$('[data-fit]').forEach((b) => { b.onclick = async () => { await saveSettings({ fit: b.dataset.fit }, true); render(); }; });
  $$('[data-ts]').forEach((b) => { b.onclick = async () => { await saveSettings({ titleStyle: b.dataset.ts }, true); render(); }; });
  const rng = (id, key, fmt) => { const i = $(`#${id}`); i.oninput = () => { i.nextElementSibling.textContent = fmt(+i.value); }; i.onchange = () => saveSettings({ [key]: +i.value }, true); };
  rng('split', 'split', (v) => `${Math.round(v * 100)}%`);
  rng('maxWords', 'maxWords', (v) => v);
  const sw = (id, key) => { $(`#${id}`).onchange = (e) => saveSettings({ [key]: e.target.checked }, true); };
  sw('subsOn', 'subsOn'); sw('vary', 'vary'); sw('mirror', 'allowMirror'); sw('speed', 'allowSpeed'); sw('loud', 'loudnorm');
  $('#lang').onchange = (e) => saveSettings({ lang: e.target.value }, true);
  $('#titleDur').onchange = (e) => saveSettings({ titleDur: +e.target.value }, true);
  $('#fillerPick').onclick = async () => { const d = await call('pickFolder', 'Папка с мини-играми'); if (d) { await saveSettings({ fillerDir: d }); render(); } };
}

// ------------------------------------------------------------------ Каналы и тексты
function pageChannels(el) {
  const s = S.settings, t = s.texts, r = s.rules;
  const vars = { title: 'Контратака хорошая', hashtags: t.hashtags };
  el.innerHTML = `
    <div class="grid g2">
      <div class="card">
        <div class="row"><div class="grow"><h3>Каналы</h3><p class="hint" style="margin:0">Сколько каналов — столько разных нарезок на выходе. Имя = подпапка для автозалива.</p></div>
          <div class="stepper"><button id="chMinus">${ic('minus', 'sm')}</button><output class="num">${s.channels.length}</output><button id="chPlus">${ic('plus', 'sm')}</button></div></div>
        <div style="margin-top:10px">${s.channels.map((c, i) => `
          <div class="chan"><span class="n num">${i + 1}</span><input class="input" data-ch="${i}" value="${esc(c.name)}">
            <span class="badge" title="раскладка">${esc((S.cat.layouts[s.formats[i % s.formats.length]] || '').split(',')[0])}</span>
            <span class="badge" title="субтитры">${esc((S.cat.subStyles[s.subStyles[i % s.subStyles.length]] || {}).name || '')}</span></div>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="chFromAp">${ic('users', 'sm')}Взять аккаунты из автопостера</button><small class="muted grow">имена должны совпадать с аккаунтами, иначе виджет не примет папку</small></div>
        <div class="row" style="margin-top:12px"><span class="grow muted">Роликов на канал в день</span>
          <div class="stepper"><button id="pcMinus">${ic('minus', 'sm')}</button><output class="num">${s.perChannel}</output><button id="pcPlus">${ic('plus', 'sm')}</button></div></div>
        <div class="grid g2" style="margin-top:12px">
          <div class="field"><span>Длина ролика от, с</span><input class="input num" type="number" id="minLen" value="${s.minLen}"></div>
          <div class="field"><span>до, с</span><input class="input num" type="number" id="maxLen" value="${s.maxLen}"></div>
        </div>
      </div>
      <div class="card">
        <h3>Правила конкурса</h3><p class="hint">Проверяются перед сборкой. Не прошедшие моменты в папку не попадают.</p>
        <div class="grid g2">
          <div class="field"><span>Обязательный хэштег</span><input class="input" id="rTag" value="${esc(r.hashtag)}"></div>
          <div class="field"><span>Twitch-канал</span><input class="input" id="rTw" value="${esc(r.twitch)}"></div>
          <div class="field"><span>Речи в отрезке не меньше, %</span><input class="input num" type="number" id="rSp" value="${Math.round(r.minSpeech * 100)}"></div>
          <div class="field"><span>Слов не меньше</span><input class="input num" type="number" id="rW" value="${r.minWords}"></div>
        </div>
        <label class="switch" style="margin-top:6px"><div><b>Нужна рамка вебки</b><small>для раскладок с вебкой: лицо Эвелона в кадре</small></div><input type="checkbox" id="rCam" ${r.requireCam ? 'checked' : ''}></label>
        <label class="switch"><div><b>Только отмеченные мной</b><small>собирать моменты с галочкой «Эвелон главный»</small></div><input type="checkbox" id="rOk" ${r.requireOk ? 'checked' : ''}></label>
      </div>
    </div>
    <div class="card">
      <h3>Подписи и комментарий</h3><p class="hint">{title} — заголовок момента, {hashtags} — хэштеги ниже. «twitch: ${esc(r.twitch)}» и ${esc(r.hashtag)} добавятся сами, если их нет.</p>
      <div class="grid g2">
        <div class="stack">
          <div class="field"><span>Подпись TikTok</span><textarea class="input" id="tTt">${esc(t.captionTiktok)}</textarea></div>
          <div class="preview-cap" id="pvTt"></div>
          <div class="field"><span>Хэштеги</span><input class="input" id="tHash" value="${esc(t.hashtags)}"></div>
          <div class="field"><span>Заголовок для подписи, если у момента его нет (на видео тогда без заголовка)</span><input class="input" id="tDef" value="${esc(t.defaultTitle)}"></div>
        </div>
        <div class="stack">
          <div class="field"><span>Подпись Instagram</span><textarea class="input" id="tIg">${esc(t.captionInstagram)}</textarea></div>
          <div class="preview-cap" id="pvIg"></div>
          <div class="field"><span>Комментарий в закреп (Instagram, через автозалив)</span><input class="input" id="tCom" value="${esc(t.comment)}" placeholder="Например: полный стрим — twitch.tv/evelone2004"></div>
        </div>
      </div>
    </div>`;
  const pv = () => {
    const rr = { hashtag: $('#rTag').value.trim(), twitch: $('#rTw').value.trim() };
    const v = { ...vars, hashtags: $('#tHash').value };
    $('#pvTt').textContent = H.captionPreview($('#tTt').value, v, rr);
    $('#pvIg').textContent = H.captionPreview($('#tIg').value, v, rr);
  };
  pv();
  ['tTt', 'tIg', 'tHash', 'rTag', 'rTw'].forEach((id) => { $(`#${id}`).oninput = pv; });
  const saveTexts = () => saveSettings({ texts: { captionTiktok: $('#tTt').value, captionInstagram: $('#tIg').value, hashtags: $('#tHash').value, comment: $('#tCom').value, defaultTitle: $('#tDef').value } }, true);
  ['tTt', 'tIg', 'tHash', 'tCom', 'tDef'].forEach((id) => { $(`#${id}`).onchange = saveTexts; });
  const saveRules = () => saveSettings({ rules: { hashtag: $('#rTag').value.trim(), twitch: $('#rTw').value.trim().replace(/^@/, ''), minSpeech: (+$('#rSp').value || 0) / 100, minWords: +$('#rW').value || 0, requireCam: $('#rCam').checked, requireOk: $('#rOk').checked } }, true);
  ['rTag', 'rTw', 'rSp', 'rW', 'rCam', 'rOk'].forEach((id) => { $(`#${id}`).onchange = saveRules; });
  const setCh = async (n) => {
    const ch = [...s.channels];
    while (ch.length < n) ch.push({ name: `channel${ch.length + 1}` });
    ch.length = Math.max(1, Math.min(60, n));
    await saveSettings({ channels: ch }, true); render();
  };
  $('#chMinus').onclick = () => setCh(s.channels.length - 1);
  $('#chFromAp').onclick = async () => {
    try {
      const r = await call('handoffAccounts');
      if (!r) { toast('Виджет ещё не передал аккаунты: запусти Reels Widget (с токеном GitHub) и подожди минуту', 6000); return; }
      if (!r.accounts.length) { toast('В автопостере нет аккаунтов для выбранной очереди (Сборка → «Очередь автозалива»)', 6000); return; }
      await saveSettings({ channels: r.accounts.map((a) => ({ name: a.name })) }, true); render();
      toast(`Каналы: ${r.accounts.map((a) => a.name).join(', ')}`, 5000);
    } catch (e) { fail(e); }
  };
  $('#chPlus').onclick = () => setCh(s.channels.length + 1);
  $('#pcMinus').onclick = async () => { await saveSettings({ perChannel: s.perChannel - 1 }, true); render(); };
  $('#pcPlus').onclick = async () => { await saveSettings({ perChannel: s.perChannel + 1 }, true); render(); };
  $$('[data-ch]').forEach((i) => { i.onchange = () => { const ch = s.channels.map((c, k) => (k === +i.dataset.ch ? { ...c, name: i.value } : c)); saveSettings({ channels: ch }, true); }; });
  $('#minLen').onchange = (e) => saveSettings({ minLen: +e.target.value }, true);
  $('#maxLen').onchange = (e) => saveSettings({ maxLen: +e.target.value }, true);
}

// ------------------------------------------------------------------ Сборка
let buildSel = null;
function pageBuild(el) {
  const s = S.settings;
  const ready = S.projects.filter((p) => p.analyzed);
  if (!buildSel) buildSel = new Set(ready.map((p) => p.id));
  const selCount = ready.filter((p) => buildSel.has(p.id)).reduce((n, p) => n + p.moments.filter((m) => m.selected).length, 0);
  const sum = H.buildSummary(s.channels.length, s.perChannel, selCount);
  const running = S.build && !S.build.done;
  el.innerHTML = `
    <div class="grid g4">
      <div class="card stat"><small>Каналов</small><b>${s.channels.length}</b></div>
      <div class="card stat"><small>Роликов на канал</small><b>${s.perChannel}</b></div>
      <div class="card stat"><small>Всего роликов</small><b>${sum.need}</b></div>
      <div class="card stat"><small>Выбрано моментов</small><b class="${sum.selected ? '' : 'err'}">${sum.selected}</b></div>
    </div>
    ${sum.repeats > 0 && sum.selected ? `<div class="card" style="border-color:rgba(242,201,76,.3)"><span class="warnc">${ic('triangle-alert', 'sm')}</span> Моментов меньше, чем роликов: ${sum.repeats} ${H.plural(sum.repeats, 'ролик повторит', 'ролика повторят', 'роликов повторят')} момент в другой раскладке и другом стиле. Ни один канал не получит один момент дважды.</div>` : ''}
    <div class="grid g2" style="margin-top:14px">
      <div class="card">
        <h3>Источники</h3><p class="hint">Из каких записей брать выбранные моменты.</p>
        ${ready.length ? ready.map((p) => `<label class="switch"><div><b>${esc(p.title)}</b><small>${p.moments.filter((m) => m.selected).length} моментов${!p.frame ? ' · рамка вебки не задана' : H.camsOf(p.frame).length > 1 ? ` · вебок: ${H.camsOf(p.frame).length}` : ''}</small></div><input type="checkbox" data-bp="${p.id}" ${buildSel.has(p.id) ? 'checked' : ''}></label>`).join('')
    : `<div class="muted">Сначала найди моменты на вкладке «Моменты».</div>`}
      </div>
      <div class="card">
        <h3>Куда</h3>
        <div class="stack">
          <div class="field"><span>Папка для готового</span><div class="row"><input class="input grow" id="outDir" readonly value="${esc(s.outputDir)}"><button class="btn" id="outPick">${ic('folder-open')}</button></div></div>
          <div class="grid g2">
            <div class="field"><span>Очередь автозалива</span><select class="input" id="lane">${Object.entries(S.cat.lanes).map(([k, v]) => `<option value="${k}">${esc(v)} (${k}/)</option>`).join('')}</select></div>
            <div class="field"><span>Имя папки дня</span><input class="input" id="fname" placeholder="${esc((ready.find((p) => buildSel.has(p.id)) || {}).title || 'evelone')}"></div>
          </div>
          <label class="switch"><div><b>Сразу в автопостер</b><small>после сборки папка уходит в виджет Reels Widget, он загружает её в очередь (виджет должен быть запущен)</small></div><input type="checkbox" id="autoSend" ${s.autoSend ? 'checked' : ''}></label>
          <div class="row"><button class="btn primary grow" id="go" ${!sum.selected || running ? 'disabled' : ''}>${ic('scissors')}Собрать ${sum.need} ${H.plural(sum.need, 'ролик', 'ролика', 'роликов')}</button>
            ${running ? `<button class="btn" id="stop">${ic('circle-stop')}Стоп</button>` : ''}</div>
        </div>
      </div>
    </div>
    <div class="card" id="bprog"></div>`;
  $('#lane').value = s.lane;
  $('#lane').onchange = (e) => saveSettings({ lane: e.target.value }, true);
  $('#autoSend').onchange = (e) => saveSettings({ autoSend: e.target.checked }, true);
  $('#outPick').onclick = async () => { const d = await call('pickFolder', 'Куда класть готовые папки'); if (d) { await saveSettings({ outputDir: d }); render(); } };
  $$('[data-bp]').forEach((i) => { i.onchange = () => { if (i.checked) buildSel.add(i.dataset.bp); else buildSel.delete(i.dataset.bp); render(); }; });
  $('#go').onclick = async () => {
    try {
      const id = await call('build', { projectIds: ready.filter((p) => buildSel.has(p.id)).map((p) => p.id), name: $('#fname').value.trim() || undefined });
      S.build = { id, kind: 'build', label: 'Сборка', progress: 0, files: [] };
      S.jobs.set(id, S.build); render();
    } catch (e) { fail(e); }
  };
  if ($('#stop')) $('#stop').onclick = () => call('cancel', S.build.id);
  renderBuildProgress();
}

function renderBuildProgress() {
  const el = $('#bprog');
  if (!el) return;
  const b = S.build;
  if (!b && S.page === 'instagram') { el.innerHTML = `<h3>Что получится</h3><p class="hint">Папка queue-instagram/NNN_имя/ с подпапкой на каждый отмеченный аккаунт (ролики, описания, обложки). Её сразу заберёт виджет и загрузит в очередь Instagram.</p>`; return; }
  if (!b) { el.innerHTML = `<h3>Что получится</h3><div class="tree">${esc(treePreview())}</div>`; return; }
  b.files = b.files || [];
  if (b.file && !b.files.includes(b.file)) b.files.push(b.file);
  const res = b.result;
  el.innerHTML = `
    <div class="row"><h3 class="grow">${b.done ? (b.error ? 'Сборка остановлена' : 'Готово') : 'Собираю'}</h3>
      ${res && (!b.ap || b.ap.state === 'done' && !b.ap.ok) ? `<button class="btn" id="apSend">${ic('upload')}В автопостер</button>` : ''}
      ${res ? `<button class="btn primary" id="openOut">${ic('folder-open')}Открыть папку</button>` : ''}</div>
    ${apBlock(b.ap)}
    ${b.done ? '' : `<div class="row" style="margin:8px 0"><small class="grow muted">${esc(b.text || '')}</small><span class="num muted">${Math.round((b.progress || 0) * 100)}%</span></div><div class="bar"><i style="width:${(b.progress || 0) * 100}%"></i></div>`}
    ${b.error ? `<p class="err">${esc(b.error)}</p>` : ''}
    ${res ? `<p class="hint">${res.videos} роликов в <b>${esc(res.folder)}</b>. ${res.problems.length ? `<span class="err">Проблемы: ${esc(res.problems.join('; '))}</span>` : 'Проверка формата автозалива пройдена.'}${res.encoderFallback ? ' <span class="warnc">Видеокарта не взялась, ролики собраны на процессоре (Настройки → Видео → Проверить).</span>' : ''}</p>` : ''}
    ${noFrameBlock((res && res.rejected) || b.rejected || [])}
    ${((res && res.rejected) || b.rejected || []).length ? `<p class="hint warnc">Не прошли правила: ${((res && res.rejected) || b.rejected).map((r) => `${esc(r.at)} (${esc(r.issues.join(', '))})`).join('; ')}</p>` : ''}
    <div class="log">${b.files.map((f) => `<div class="ln"><span class="okc">${ic('circle-check', 'sm')}</span><span>${esc(f.split(/[\\/]/).slice(-2).join(' / '))}</span><button class="btn sm ghost" data-show="${esc(f)}">показать</button></div>`).join('')}</div>`;
  if ($('#openOut')) $('#openOut').onclick = () => call('openPath', res.folder);
  if ($('#apSend')) $('#apSend').onclick = () => sendToAutoposter(b);
  $$('[data-frame]').forEach((x) => { x.onclick = async () => { await openProject(x.dataset.frame); if (S.project) openFramer(S.project); }; });
  $$('[data-show]').forEach((x) => { x.onclick = () => call('showItem', x.dataset.show); });
}

// ------------------------------------------------------------------ Instagram
function pageInstagram(el) {
  const s = S.settings, ig = s.ig;
  const known = S.igAcc || [];
  const names = [...new Set([...known.map((a) => a.name), ...ig.accounts])];
  const ready = S.projects.filter((p) => p.analyzed);
  if (!buildSel) buildSel = new Set(ready.map((p) => p.id));
  const selCount = ready.filter((p) => buildSel.has(p.id)).reduce((n, p) => n + p.moments.filter((m) => m.selected).length, 0);
  const need = ig.accounts.length * ig.perChannel;
  const running = S.build && !S.build.done;
  const fmts = ig.formats.length ? ig.formats : s.formats;
  el.innerHTML = `
    <div class="grid g2">
      <div class="card">
        <div class="row"><div class="grow"><h3>Аккаунты Instagram</h3><p class="hint" style="margin:0">Список берётся из автопостера (виджет Reels Widget). У каждого отмеченного аккаунта свои ролики.</p></div>
          <button class="btn sm" id="igLoad">${ic('refresh-cw', 'sm')}Обновить</button></div>
        <div class="stack" style="margin-top:10px">${names.length ? names.map((n) => `
          <label class="switch"><div><b>@${esc(n)}</b>${known.length && !known.some((a) => a.name === n) ? '<small class="warnc">нет в автопостере: виджет не примет папку</small>' : ''}</div><input type="checkbox" data-iga="${esc(n)}" ${ig.accounts.includes(n) ? 'checked' : ''}></label>`).join('')
    : `<div class="muted">Аккаунтов пока нет. Запусти Reels Widget (он должен быть подключён к GitHub) и нажми «Обновить».</div>`}</div>
        ${names.length > 1 ? `<div class="row" style="margin-top:8px"><button class="btn sm ghost" id="igAll">Отметить все</button><button class="btn sm ghost" id="igNone">Снять все</button></div>` : ''}
      </div>
      <div class="card">
        <h3>Ролики</h3>
        <div class="row" style="margin-top:6px"><span class="grow muted">Роликов на аккаунт</span>
          <div class="stepper"><button id="igpMinus">${ic('minus', 'sm')}</button><output class="num">${ig.perChannel}</output><button id="igpPlus">${ic('plus', 'sm')}</button></div></div>
        <div class="field" style="margin-top:12px"><span>Раскладки для Instagram ${ig.formats.length ? '' : '(не выбраны — как в «Монтаже»)'}</span>
          <div class="row wrap">${Object.entries(S.cat.layouts).map(([k, n]) => `<button class="chip ${ig.formats.includes(k) ? 'on' : ''}" data-igf="${k}">${esc(n)}</button>`).join('')}</div></div>
        <div class="field" style="margin-top:12px"><span>Публикация</span>
          <div class="seg"><button class="${ig.postNow ? '' : 'on'}" data-ignow="0">По расписанию</button><button class="${ig.postNow ? 'on' : ''}" data-ignow="1">Первый ролик сразу</button></div>
          <small class="muted">${ig.postNow ? 'Сразу после загрузки выйдет по одному ролику на каждый аккаунт, остальные — по расписанию автопостера.' : 'Ролики выйдут по расписанию автопостера (окно дня из его настроек).'}</small></div>
      </div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card">
        <h3>Подпись и закреп</h3><p class="hint">{title} — заголовок момента, {hashtags} — хэштеги из «Каналы и тексты». «twitch: evelone2004» и #evelone добавятся сами.</p>
        <div class="field"><span>Подпись Instagram</span><textarea class="input" id="igCap" rows="4">${esc(s.texts.captionInstagram)}</textarea></div>
        <div class="field" style="margin-top:8px"><span>Комментарий в закреп</span><input class="input" id="igCom" value="${esc(s.texts.comment)}" placeholder="Например: полный стрим — twitch.tv/evelone2004"></div>
      </div>
      <div class="card">
        <h3>Собрать</h3>
        <p class="hint">Моменты: ${selCount} выбрано на вкладке «Моменты» (источники — как на «Сборке»). Раскладки по кругу: ${esc(fmts.map((f) => (S.cat.layouts[f] || f).split(',')[0]).join(' · '))}.</p>
        <div class="row"><button class="btn primary grow" id="igGo" ${!selCount || !ig.accounts.length || running ? 'disabled' : ''}>${ic('send')}Собрать ${need} ${H.plural(need, 'ролик', 'ролика', 'роликов')} и отправить</button>
          ${running ? `<button class="btn" id="stop">${ic('circle-stop')}Стоп</button>` : ''}</div>
        ${!ig.accounts.length ? '<small class="warnc">Отметь хотя бы один аккаунт.</small>' : ''}
      </div>
    </div>
    <div class="card" id="bprog" style="margin-top:14px"></div>`;
  const saveIg = async (patch) => { await saveSettings({ ig: { ...S.settings.ig, ...patch } }, true); render(); };
  $('#igLoad').onclick = async () => {
    try {
      const r = await call('handoffIgAccounts');
      if (!r) { toast('Виджет ещё не передал аккаунты: запусти Reels Widget и подожди минуту', 6000); return; }
      S.igAcc = r.accounts; render();
      toast(r.accounts.length ? `Аккаунтов Instagram: ${r.accounts.length}` : 'В автопостере нет аккаунтов Instagram', 4000);
    } catch (e) { fail(e); }
  };
  $$('[data-iga]').forEach((i) => { i.onchange = () => saveIg({ accounts: i.checked ? [...ig.accounts, i.dataset.iga] : ig.accounts.filter((x) => x !== i.dataset.iga) }); });
  if ($('#igAll')) $('#igAll').onclick = () => saveIg({ accounts: names });
  if ($('#igNone')) $('#igNone').onclick = () => saveIg({ accounts: [] });
  $('#igpMinus').onclick = () => saveIg({ perChannel: Math.max(1, ig.perChannel - 1) });
  $('#igpPlus').onclick = () => saveIg({ perChannel: Math.min(20, ig.perChannel + 1) });
  $$('[data-igf]').forEach((b) => { b.onclick = () => { const k = b.dataset.igf; saveIg({ formats: ig.formats.includes(k) ? ig.formats.filter((x) => x !== k) : [...ig.formats, k] }); }; });
  $$('[data-ignow]').forEach((b) => { b.onclick = () => saveIg({ postNow: b.dataset.ignow === '1' }); });
  $('#igCap').onchange = (e) => saveSettings({ texts: { ...S.settings.texts, captionInstagram: e.target.value } }, true);
  $('#igCom').onchange = (e) => saveSettings({ texts: { ...S.settings.texts, comment: e.target.value } }, true);
  $('#igGo').onclick = async () => {
    try {
      const id = await call('build', { mode: 'instagram', projectIds: ready.filter((p) => buildSel.has(p.id)).map((p) => p.id) });
      S.build = { id, kind: 'build', mode: 'instagram', label: 'Сборка Instagram', progress: 0, files: [] };
      S.jobs.set(id, S.build); render();
    } catch (e) { fail(e); }
  };
  if ($('#stop')) $('#stop').onclick = () => call('cancel', S.build.id);
  if (!S.igAcc) call('handoffIgAccounts').then((r) => { S.igAcc = r ? r.accounts : []; if (S.page === 'instagram' && r && r.accounts.length) render(); }).catch(() => { S.igAcc = []; });
  renderBuildProgress();
}

/** Отдать готовую папку виджету автопостера и следить, как он её грузит. */
async function sendToAutoposter(b) {
  try {
    const id = await call('handoffSend', b.result.folder, b.mode === 'instagram' ? { postNow: S.settings.ig.postNow, accounts: S.settings.ig.accounts } : {});
    b.ap = { id, state: 'waiting', since: Date.now() };
    if (S.page === 'build' || S.page === 'instagram') renderBuildProgress();
    const tick = async () => {
      const st = await call('handoffStatus', id).catch(() => null);
      if (!st) return;
      b.ap = { ...b.ap, ...st };
      if (S.build === b && (S.page === 'build' || S.page === 'instagram')) renderBuildProgress();
      if (st.state === 'done') { toast(st.ok ? `В автопостере: ${st.dest}` : `Автопостер не принял папку: ${st.error}`, st.ok ? 5000 : 12000); return; }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 1500);
  } catch (e) { fail(e); }
}

function apBlock(ap) {
  if (!ap) return '';
  const slow = ap.state === 'waiting' && Date.now() - ap.since > 20000;
  const text = ap.state === 'waiting' ? (slow ? 'Виджет не отвечает. Запусти Reels Widget (значок в трее): он заберёт папку сам, как только откроется.' : 'Передаю папку виджету автопостера…')
    : ap.state === 'working' ? `Виджет загружает: ${ap.text || '…'}`
      : ap.state === 'done' && ap.ok ? `В очереди автопостера: ${ap.dest}. ${ap.posted ? 'Первые ролики уже публикуются (2–5 минут), остальные выйдут по расписанию.' : 'Дальше ролики выйдут по расписанию.'}`
        : ap.state === 'done' ? `Виджет не загрузил папку: ${ap.error}${/не совпадает ни с одним аккаунтом/.test(ap.error || '') ? ' Нажми «Каналы и тексты» → «Взять аккаунты из автопостера» и собери заново.' : ''}`
          : 'Заявка потерялась, отправь ещё раз.';
  const cls = ap.state === 'done' ? (ap.ok ? 'okc' : 'err') : slow ? 'warnc' : 'muted';
  return `<div class="card notice" style="margin:10px 0"><span class="${cls}">${ic(ap.state === 'done' && ap.ok ? 'circle-check' : 'upload')}</span><div class="grow"><b>Автопостер</b><small>${esc(text)}</small>
    ${ap.state === 'working' && ap.frac != null ? `<div class="bar" style="margin-top:6px"><i style="width:${Math.round(ap.frac * 100)}%"></i></div>` : ''}</div></div>`;
}

/** Видео без рамки вебки из отклонённых моментов → кнопки, которые сразу открывают рамку. */
function noFrameBlock(rejected) {
  const seen = new Map();
  for (const r of rejected) if (r.projectId && r.issues.some((x) => /рамка вебки/.test(x))) seen.set(r.projectId, r.project);
  if (!seen.size) return '';
  return `<div class="card notice" style="margin:10px 0"><span class="warnc">${ic('scan-face')}</span><div class="grow"><b>Не отмечена вебка</b>
    <small>Открой рамку, нажми «Найти лицо» и «Сохранить» (или «Без вебки», если её нет), потом снова «Собрать».</small>
    <div class="row wrap" style="margin-top:8px">${[...seen].map(([id, t]) => `<button class="btn sm primary" data-frame="${esc(id)}">${ic('scan-face', 'sm')}Задать рамку: ${esc(String(t).slice(0, 40))}</button>`).join('')}</div></div></div>`;
}

function treePreview() {
  const s = S.settings;
  const ch = s.channels;
  const lines = [`${s.lane}/`, '  NNN_имя-папки/', '    texts.json            ← комментарий в закреп'];
  const one = (pad) => [`${pad}short-1-zagolovok.mp4`, `${pad}short-1-zagolovok.txt  ← подписи, #evelone, twitch`, `${pad}cover-1.jpg`, `${pad}… до short-${s.perChannel}`];
  if (ch.length <= 1) lines.push(...one('    '));
  else for (const c of ch.slice(0, 3)) lines.push(`    ${c.name}/`, ...one('      '));
  if (ch.length > 3) lines.push(`    … ещё ${ch.length - 3}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ Настройки
function pageSettings(el) {
  const s = S.settings, t = S.tools;
  const state = (ok, txt) => `<span class="badge ${ok ? 'ok' : 'warn'}">${ok ? 'есть' : txt || 'нет'}</span>`;
  el.innerHTML = `
    <div class="grid g2">
      <div class="card">
        <h3>Компоненты</h3><p class="hint">Скачиваются один раз в папку программы.</p>
        <div class="switch"><div><b>ffmpeg</b><small>монтаж, идёт в комплекте</small></div>${state(!!t.ffmpeg)}</div>
        <div class="switch"><div><b>yt-dlp</b><small>поиск и скачивание с YouTube, Twitch, Kick, VK</small></div>
          <div class="row">${state(!!t.ytdlp)}<button class="btn sm" data-inst="ytdlp">${ic('download', 'sm')}${t.ytdlp ? 'Обновить' : 'Скачать'}</button></div></div>
        <div class="switch"><div><b>whisper.cpp</b><small>распознавание речи${s.gpu ? ' на видеокарте (CUDA)' : ''}</small></div>
          <div class="row">${state(!!t.whisper)}<button class="btn sm" data-inst="whisper">${ic('download', 'sm')}${t.whisper ? 'Переставить' : 'Скачать'}</button></div></div>
        <div class="switch"><div><b>Модель речи</b><small>${esc(s.whisperModel)}: ${esc((t.models[s.whisperModel] || {}).size)}, ${esc((t.models[s.whisperModel] || {}).note)}</small></div>
          <div class="row"><select class="input" id="model" style="width:170px;height:30px">${Object.keys(t.models).map((k) => `<option>${k}</option>`).join('')}</select>${state(!!t.model)}
          <button class="btn sm" data-inst="model">${ic('download', 'sm')}</button></div></div>
        <label class="switch"><div><b>Видеокарта для речи</b><small>RTX 3070: да</small></div><input type="checkbox" id="gpu" ${s.gpu ? 'checked' : ''}></label>
      </div>
      <div class="card">
        <h3>Видео</h3>
        <div class="stack">
          <div class="field"><span>Кодировщик</span><div class="row"><select class="input grow" id="enc">${Object.entries(t.encoders).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select><button class="btn" id="encTest">Проверить</button></div><small class="muted" id="encRes"></small></div>
          <div class="grid g2">
            <div class="field"><span>Качество</span><select class="input" id="q"><option value="best">лучше</option><option value="fast">быстрее</option></select></div>
            <div class="field"><span>Кадров в секунду</span><select class="input" id="fps"><option>30</option><option>60</option></select></div>
          </div>
        </div>
        <h3 style="margin-top:18px">Окно</h3>
        <div class="field"><span>Материал (Windows 11)</span><select class="input" id="mat"><option value="acrylic">акрил</option><option value="mica">слюда</option><option value="none">без стекла</option></select></div>
        <p class="hint" style="margin-top:12px">Данные программы: ${esc(S.info.userData)}</p>
      </div>
      <div class="card">
        <h3>Запросы для фона</h3>
        <p class="hint">Кнопки в разделе «Фон». По строке на кнопку: «Название = что искать». Искать лучше по-английски, так находится больше.</p>
        <textarea class="input" id="fqList" rows="9" style="width:100%;font-size:12.5px;line-height:1.5;resize:vertical">${esc(s.fillerQueries.join('\n'))}</textarea>
        <div class="row" style="margin-top:8px"><span class="grow"></span><button class="btn sm ghost" id="fqReset">Как было</button><button class="btn sm primary" id="fqSave">Сохранить</button></div>
      </div>
      <div class="card">
        <h3>Сеть</h3>
        <p class="hint">Если YouTube не открывается (в России его часто блокируют), нужен VPN или прокси. Программа сама берёт прокси, который включил VPN в Windows. Если VPN работает только в браузере, укажи его прокси вручную, например <code>socks5://127.0.0.1:1080</code>.</p>
        <div class="stack">
          <div class="field"><span>Подключение для YouTube</span><select class="input" id="netMode">${Object.entries(S.cat.netModes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
            <small class="muted" id="netSys">${s.net.mode === 'system' ? 'проверяю прокси Windows…' : ''}</small></div>
          <div class="field" ${s.net.mode === 'manual' ? '' : 'hidden'}><span>Адрес прокси</span>
            <div class="row"><input class="input grow" id="netProxy" value="${esc(s.net.proxy)}" placeholder="socks5://127.0.0.1:1080 или 127.0.0.1:10809"><button class="btn" id="netSave">Сохранить</button></div></div>
          <div class="row"><button class="btn" id="netTest">${ic('refresh-cw', 'sm')}Проверить YouTube</button><small class="grow" id="netRes"></small></div>
        </div>
      </div>
      <div class="card">
        <h3>Вход на сайты (YouTube, Instagram)</h3>
        <p class="hint">Если YouTube пишет «Sign in to confirm you're not a bot» или Instagram не отдаёт рилс, программе нужны cookies браузера, где ты вошёл в YouTube и Instagram. Перед загрузкой закрой этот браузер. Лучше всего работает Firefox. Twitch и файлы с диска работают без входа.</p>
        <div class="stack">
          <div class="field"><span>Способ</span><select class="input" id="ckMode">${Object.entries(S.cat.cookieModes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
            <small class="muted">${s.cookies.mode === 'auto' ? 'сначала без входа, при проверке «не бот» — cookies Firefox, Edge, Chrome и других по очереди' : ''}</small></div>
          <div class="field" ${s.cookies.mode === 'browser' ? '' : 'hidden'}><span>Браузер</span><select class="input" id="ckBrowser">${Object.entries(S.cat.browsers).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div class="field" ${s.cookies.mode === 'file' ? '' : 'hidden'}><span>Файл cookies.txt (формат Netscape)</span>
            <div class="row"><input class="input grow" id="ckFile" readonly value="${esc(s.cookies.file)}" placeholder="не выбран"><button class="btn" id="ckPick">${ic('folder-open')}</button></div>
            <small class="muted">Выгрузить можно расширением «Get cookies.txt LOCALLY», открыв youtube.com под своим аккаунтом.</small></div>
        </div>
      </div>
    </div>`;
  $('#model').value = s.whisperModel; $('#enc').value = s.encoder; $('#q').value = s.quality; $('#fps').value = String(s.fps); $('#mat').value = s.material;
  $$('[data-inst]').forEach((b) => { b.onclick = async () => { try { const id = await call('install', b.dataset.inst); S.jobs.set(id, { id, kind: 'install', label: b.dataset.inst, progress: 0 }); renderDock(); } catch (e) { fail(e); } }; });
  $('#model').onchange = async (e) => { await saveSettings({ whisperModel: e.target.value }, true); refreshTools(); };
  $('#gpu').onchange = (e) => saveSettings({ gpu: e.target.checked }, true);
  $('#enc').onchange = (e) => saveSettings({ encoder: e.target.value }, true);
  $('#q').onchange = (e) => saveSettings({ quality: e.target.value }, true);
  $('#fps').onchange = (e) => saveSettings({ fps: +e.target.value }, true);
  $('#mat').onchange = async (e) => { await saveSettings({ material: e.target.value }, true); document.body.dataset.material = S.info.appearance.win11 && e.target.value !== 'none' ? e.target.value : 'none'; };
  $('#fqSave').onclick = async () => { await saveSettings({ fillerQueries: $('#fqList').value.split(/\r?\n/) }); render(); };
  $('#fqReset').onclick = async () => { await saveSettings({ fillerQueries: [] }); render(); };
  $('#netMode').value = s.net.mode;
  $('#netMode').onchange = async (e) => { await saveSettings({ net: { ...s.net, mode: e.target.value } }, true); render(); };
  if ($('#netSave')) $('#netSave').onclick = async () => { await saveSettings({ net: { ...s.net, proxy: $('#netProxy').value.trim() } }); };
  if (s.net.mode === 'system') call('netInfo').then((r) => { const el = $('#netSys'); if (el) el.textContent = r.system ? `найден прокси Windows: ${r.system}` : 'прокси в Windows нет — подключение напрямую (VPN в режиме TUN тоже подойдёт)'; }).catch(() => {});
  $('#netTest').onclick = async () => {
    const out = $('#netRes'); out.innerHTML = '<span class="muted">Проверяю…</span>';
    if (s.net.mode === 'manual' && $('#netProxy') && $('#netProxy').value.trim() !== s.net.proxy) await saveSettings({ net: { ...s.net, proxy: $('#netProxy').value.trim() } }, true);
    const r = await call('netTest');
    out.innerHTML = r.ok ? `<span class="okc">YouTube открывается (${(r.ms / 1000).toFixed(1)} с${r.proxy ? `, через ${esc(r.proxy)}` : ''})</span>` : `<span class="err" style="white-space:pre-line">${esc(r.error)}</span>`;
  };
  $('#ckBrowser').value = s.cookies.browser;
  const setCk = async (patch) => { await saveSettings({ cookies: { ...s.cookies, ...patch } }, true); render(); };
  $('#ckMode').value = s.cookies.mode;
  $('#ckMode').onchange = async (e) => {
    if (e.target.value === 'file' && !s.cookies.file) { const f = await call('pickFile', 'Файл cookies.txt', [{ name: 'cookies.txt', extensions: ['txt'] }]); if (!f) { e.target.value = s.cookies.mode; return; } await setCk({ mode: 'file', file: f }); return; }
    await setCk({ mode: e.target.value });
  };
  $('#ckBrowser').onchange = (e) => setCk({ browser: e.target.value });
  $('#ckPick').onclick = async () => { const f = await call('pickFile', 'Файл cookies.txt', [{ name: 'cookies.txt', extensions: ['txt'] }]); if (f) await setCk({ file: f, mode: 'file' }); };
  $('#encTest').onclick = async () => {
    $('#encRes').textContent = 'Проверяю…';
    const r = await call('testEncoder', $('#enc').value);
    $('#encRes').innerHTML = r.ok ? '<span class="okc">Работает</span>' : `<span class="err">Не работает на этом ПК: ${esc(r.log)}</span>`;
  };
}

// ------------------------------------------------------------------ старт
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason && e.reason.message)));
(async function init() {
  try {
    S.info = await call('info');
    S.cat = S.info.catalog;
    S.settings = await call('getSettings');
    document.body.dataset.material = S.info.appearance.material;
    document.body.dataset.platform = S.info.appearance.platform;
    $('#ver').textContent = `версия ${S.info.version}`;
    window.api.onJob(jobUpdate);
    await Promise.all([refreshTools(), refreshProjects()]);
    if (S.projects.length) S.page = 'projects';
    renderNav(); render();
    window.addEventListener('resize', () => { if (S.page === 'projects' && S.project) drawTimeline(S.project); });
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b">${esc(e.stack || e.message)}</pre>`;
  }
}());
