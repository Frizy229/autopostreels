'use strict';
// Окно «Наложения»: текст, плашки, картинки и видео поверх ролика 9:16. Работает и для одного ролика (с видео и временем),
// и для шаблона (без видео). Картинку текста и плашек рисует тот же ffmpeg, что и при рендере, поэтому на экране — как в ролике.
// Подключается после app.js; использует его $, $$, ic, esc, call, toast, fail, H.

const OVK = { text: ['Текст', 'type'], plate: ['Плашка', 'layout-template'], media: ['Картинка / видео', 'file-video'] };
const OV_MEDIA_FILTERS = [{ name: 'Картинки, гифки и видео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'webm', 'mkv'] }];
let OVMETA = null;

function ovNew(kind, extra = {}) {
  const id = `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  if (kind === 'text') return { id, kind, text: 'Текст', x: 0.1, y: 0.62, w: 0.8, h: 0.1, size: 90, color: '#ffffff', bg: '', bgAlpha: 0.9, radius: 0, outline: true, align: 'center', font: 'montserrat', start: null, end: null, fade: 0, opacity: 1, ...extra };
  if (kind === 'plate') return { id, kind, text: 'Плашка', x: 0.15, y: 0.08, w: 0.7, h: 0.07, size: 56, color: '#ffffff', bg: '#c8102e', bgAlpha: 0.9, radius: 24, outline: false, align: 'center', font: 'montserrat', start: null, end: null, fade: 0, opacity: 1, ...extra };
  return { id, kind: 'image', x: 0.62, y: 0.1, w: 0.3, start: null, end: null, fade: 0, opacity: 1, keyColor: '', keyTol: 0.15, keySoft: 0.08, ...extra };
}
const ovKey = (o, raw) => JSON.stringify([o.kind, o.w, o.h, o.text, o.font, o.size, o.color, o.align, o.outline, o.bg, o.bgAlpha, o.radius, o.path, raw ? '' : o.keyColor, raw ? 0 : o.keyTol, raw ? 0 : o.keySoft, !!raw]);
const ovLabel = (o) => (o.kind === 'text' || o.kind === 'plate' ? `${o.kind === 'plate' ? 'Плашка' : 'Текст'}: ${String(o.text).split('\n')[0].slice(0, 22)}` : `${o.kind === 'video' ? 'Видео' : 'Картинка'}: ${String(o.path).split(/[\\/]/).pop().slice(0, 22)}`);

/**
 * opts: {title, hint, items, clip (результат call('clip') или null), save(items) → Promise, extra(items, api) → html + привязка (для шаблонов)}
 */
async function openOverlays(opts) {
  if (!OVMETA) OVMETA = await call('overlayMeta');
  const m = $('#modal');
  const tf = (t) => H.fmtTimeP(t);
  const ed = { items: opts.items.map((o) => ({ ...o })), sel: 0, cache: new Map(), pick: false };
  m.hidden = false;
  m.innerHTML = `<div class="dlg ovdlg">
    <div class="row"><div class="grow"><h2>${esc(opts.title)}</h2><p class="hint">${esc(opts.hint || '')}</p></div><button class="btn ghost icon" id="ox">${ic('x')}</button></div>
    <div class="ovwrap">
      <div class="ovcol"><div class="ovstage" id="ostage">${opts.clip ? `<video id="ovid" src="${esc(opts.clip.src)}#t=${opts.clip.start.toFixed(2)},${opts.clip.end.toFixed(2)}" controls preload="auto"></video>` : '<div class="ovbg">9:16</div>'}<div class="ovguide"></div><div class="ovl" id="ovl"></div></div>
        <small class="muted">${opts.clip ? 'Фон условный (кадр обрезан по центру), раскладка в ролике может отличаться. Время — от начала ролика.' : 'Шаблон накладывается на все ролики. Время — от начала ролика.'}</small></div>
      <div class="ovside">
        <div class="row wrap"><button class="btn sm" data-add="text">${ic('plus', 'sm')}Текст</button><button class="btn sm" data-add="plate">${ic('plus', 'sm')}Плашка</button><button class="btn sm" data-add="media">${ic('plus', 'sm')}Картинка / видео</button></div>
        <div id="ovlist" class="ovlist"></div>
        <div id="ovprops" class="ovprops"></div>
      </div>
    </div>
    <div id="ovextra" style="margin-top:10px"></div>
    <div class="row" style="margin-top:14px"><span class="grow"></span><button class="btn ghost" id="ocancel">Отмена</button><button class="btn primary" id="osave">${ic('check')}Сохранить</button></div></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('#ox').onclick = close; $('#ocancel').onclick = close;
  const vid = () => $('#ovid');
  const rel = () => (vid() && opts.clip ? Math.max(0, vid().currentTime - opts.clip.start) : 0);
  const cur = () => ed.items[ed.sel];
  const active = (o, t) => (o.start == null || t >= o.start) && (o.end == null || t <= o.end);
  const st = () => $('#ostage').getBoundingClientRect();

  // картинка наложения: из кэша или от ffmpeg (с задержкой, чтобы не рисовать на каждую букву)
  const timers = new Map();
  const preview = (o, raw = false) => {
    const key = ovKey(o, raw);
    if (ed.cache.has(key)) return ed.cache.get(key);
    ed.cache.set(key, '');
    clearTimeout(timers.get(o.id + (raw ? 'r' : '')));
    timers.set(o.id + (raw ? 'r' : ''), setTimeout(async () => {
      try { const r = await call('overlayPreview', o, { raw }); ed.cache.set(key, r.src); } catch { ed.cache.set(key, 'x'); }
      drawStage();
    }, 250));
    return '';
  };
  // пипетка: цвет пикселя «сырой» картинки (без удаления фона) под курсором
  const pickColor = (o, ev, el) => {
    const src = ed.cache.get(ovKey(o, true));
    if (!src || src === 'x') { toast('Картинка ещё не загрузилась'); return; }
    const img = new Image();
    img.onload = () => {
      const B = el.getBoundingClientRect(), u = (ev.clientX - B.left) / B.width, v = (ev.clientY - B.top) / B.height;
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(Math.min(c.width - 1, Math.max(0, Math.round(u * c.width))), Math.min(c.height - 1, Math.max(0, Math.round(v * c.height))), 1, 1).data;
      if (d[3] < 40) toast('Здесь уже прозрачно: выбери цвет фона'); else { o.keyColor = '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join(''); toast(`Фон ${o.keyColor} стал прозрачным`); }
      ed.pick = false; drawAll();
    };
    img.src = src;
  };

  const drawStage = () => {
    const ov = $('#ovl');
    if (!ov) return;
    const t = rel();
    ov.innerHTML = ed.items.map((o, i) => {
      const picking = ed.pick && i === ed.sel;
      const src = picking ? preview(o, true) : preview(o);
      const live = !opts.clip || active(o, t);
      return `<div class="ovi ${i === ed.sel ? 'sel' : ''} ${live ? '' : 'off'} ${picking ? 'pick' : ''} ${o.keyColor && !picking ? 'keyed' : ''}" data-i="${i}" style="left:${o.x * 100}%;top:${o.y * 100}%;width:${o.w * 100}%;${o.h && (o.kind === 'text' || o.kind === 'plate') ? `height:${o.h * 100}%;` : ''}opacity:${o.opacity}">
        ${src && src !== 'x' ? `<img src="${src}" draggable="false">` : `<span class="ovwait">${src === 'x' ? 'нет картинки' : '…'}</span>`}<span class="h"></span></div>`;
    }).join('');
    $$('.ovi', ov).forEach((el) => {
      el.onpointerdown = (e) => {
        const i = +el.dataset.i, o = ed.items[i], B = st(), resize = e.target.classList.contains('h');
        if (ed.pick && i === ed.sel) { pickColor(o, e, el); e.preventDefault(); return; }
        const s0 = { ...o }, x0 = e.clientX, y0 = e.clientY, moved = ed.sel !== i;
        ed.sel = i;
        el.setPointerCapture(e.pointerId);
        el.onpointermove = (ev) => {
          const dx = (ev.clientX - x0) / B.width, dy = (ev.clientY - y0) / B.height;
          if (resize) { o.w = Math.min(1.5, Math.max(0.03, s0.w + dx)); if (o.h) o.h = Math.min(1.5, Math.max(0.02, s0.h + dy)); } else { o.x = Math.round((s0.x + dx) * 1000) / 1000; o.y = Math.round((s0.y + dy) * 1000) / 1000; }
          Object.assign(el.style, { left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, ...(o.h && (o.kind === 'text' || o.kind === 'plate') ? { height: `${o.h * 100}%` } : {}) });
        };
        el.onpointerup = () => { el.onpointermove = null; drawList(); drawProps(); };
        e.preventDefault();
        if (moved) { drawList(); drawProps(); $$('.ovi', ov).forEach((x) => x.classList.toggle('sel', +x.dataset.i === i)); }
      };
    });
  };

  const drawList = () => {
    $('#ovlist').innerHTML = ed.items.length ? ed.items.map((o, i) => `<div class="ovrow ${i === ed.sel ? 'sel' : ''}" data-r="${i}"><span class="grow">${esc(ovLabel(o))}</span><button class="btn sm ghost icon" data-del="${i}" title="Убрать">${ic('trash-2', 'sm')}</button></div>`).join('')
      : '<small class="muted">Пока пусто. Добавь текст, плашку или картинку: они появятся на кадре, их можно двигать мышью, уголок меняет размер.</small>';
    $$('[data-r]').forEach((r) => { r.onclick = () => { ed.sel = +r.dataset.r; drawList(); drawProps(); drawStage(); }; });
    $$('[data-del]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); ed.items.splice(+b.dataset.del, 1); ed.sel = Math.max(0, Math.min(ed.sel, ed.items.length - 1)); drawAll(); }; });
  };

  const drawProps = () => {
    const o = cur(), box = $('#ovprops');
    if (!o) { box.innerHTML = ''; return; }
    const textual = o.kind === 'text' || o.kind === 'plate';
    const num = (id, label, min, max, step, val, fmt = (v) => v) => `<div class="field"><span>${label}</span><div class="range"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(val)}</output></div></div>`;
    box.innerHTML = `
      ${textual ? `<div class="field"><span>Текст (Enter — новая строка)</span><textarea class="input" id="pText" rows="2">${esc(o.text)}</textarea></div>
        <div class="grid g2">
          <div class="field"><span>Шрифт</span><select class="input" id="pFont">${Object.entries(OVMETA.fonts).map(([k, n]) => `<option value="${k}" ${o.font === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
          <div class="field"><span>Выравнивание</span><div class="seg" id="pAlign">${Object.entries(OVMETA.aligns).map(([k, n]) => `<button class="${o.align === k ? 'on' : ''}" data-al="${k}">${esc(n)}</button>`).join('')}</div></div>
        </div>
        ${num('pSize', 'Размер букв', 16, 300, 2, o.size, (v) => `${v} px`)}
        <div class="row wrap" style="gap:14px"><label class="row muted">Цвет <input type="color" id="pColor" value="${o.color}"></label>
          <label class="row muted"><input type="checkbox" id="pOut" ${o.outline ? 'checked' : ''}> чёрная обводка</label>
          <label class="row muted"><input type="checkbox" id="pBgOn" ${o.bg ? 'checked' : ''}> фон</label>${o.bg ? `<input type="color" id="pBg" value="${o.bg}">` : ''}</div>
        ${o.bg ? `${num('pBgA', 'Прозрачность фона', 0.1, 1, 0.05, o.bgAlpha, (v) => `${Math.round(v * 100)}%`)}${num('pRad', 'Скругление углов', 0, 120, 2, o.radius, (v) => `${v} px`)}` : ''}`
        : `<div class="field"><span>Файл</span><div class="row"><input class="input grow" readonly value="${esc(o.path || '')}"><button class="btn sm" id="pFile">Заменить…</button></div></div>
        <div class="field"><span>Задний фон (серый, белый, зелёный и т. п.)</span>
          <div class="row wrap"><label class="row muted"><input type="checkbox" id="kOn" ${o.keyColor ? 'checked' : ''}> убрать фон</label>
            <button class="btn sm ${ed.pick ? 'primary' : ''}" id="kPick" title="Нажми и кликни по фону на кадре слева">${ic('eye', 'sm')}${ed.pick ? 'Кликни по фону слева…' : 'Пипетка'}</button>
            <button class="btn sm ghost" id="kAuto" title="Цвет фона берётся по углам картинки">Авто по углам</button>
            ${o.keyColor ? `<input type="color" id="kColor" value="${o.keyColor}" title="Цвет, который станет прозрачным">` : ''}</div>
          ${o.keyColor ? `${num('kTol', 'Допуск (насколько похожие цвета тоже убрать)', 0.02, 0.6, 0.01, o.keyTol, (v) => `${Math.round(v * 100)}%`)}${num('kSoft', 'Мягкость краёв', 0, 0.4, 0.01, o.keySoft, (v) => `${Math.round(v * 100)}%`)}` : '<small class="muted">Если у файла прозрачный фон (png, webm, mov), он и так прозрачный. Серый или цветной фон убирается здесь.</small>'}</div>`}
      ${num('pOp', 'Непрозрачность', 0.1, 1, 0.05, o.opacity, (v) => `${Math.round(v * 100)}%`)}
      ${num('pFade', 'Плавное появление и исчезновение', 0, 2, 0.1, o.fade, (v) => (v ? `${v} с` : 'нет'))}
      <div class="field"><span>Когда показывать</span>
        <label class="row muted"><input type="checkbox" id="pAll" ${o.start == null && o.end == null ? 'checked' : ''}> весь ролик</label>
        ${o.start == null && o.end == null ? '' : `<div class="row wrap">с <input class="input num" id="pS" style="width:78px" value="${o.start == null ? '' : tf(o.start)}" placeholder="начала">${opts.clip ? `<button class="btn sm ghost" id="pSn">сюда</button>` : ''}
          по <input class="input num" id="pE" style="width:78px" value="${o.end == null ? '' : tf(o.end)}" placeholder="конца">${opts.clip ? `<button class="btn sm ghost" id="pEn">сюда</button>` : ''}</div>`}</div>`;
    const set = (patch) => { Object.assign(o, patch); drawStage(); drawList(); };
    const bind = (id, fn) => { const el = $(`#${id}`); if (el) fn(el); };
    bind('pText', (el) => { el.oninput = () => { o.text = el.value; drawStage(); }; el.onchange = () => drawList(); });
    bind('pFont', (el) => { el.onchange = () => set({ font: el.value }); });
    $$('[data-al]').forEach((b) => { b.onclick = () => { set({ align: b.dataset.al }); drawProps(); }; });
    const rng = (id, key, fmt, redraw) => bind(id, (el) => { el.oninput = () => { el.nextElementSibling.textContent = fmt(+el.value); set({ [key]: +el.value }); }; if (redraw) el.onchange = () => drawProps(); });
    rng('pSize', 'size', (v) => `${v} px`); rng('pBgA', 'bgAlpha', (v) => `${Math.round(v * 100)}%`); rng('pRad', 'radius', (v) => `${v} px`);
    rng('pOp', 'opacity', (v) => `${Math.round(v * 100)}%`); rng('pFade', 'fade', (v) => (v ? `${v} с` : 'нет'));
    bind('pColor', (el) => { el.oninput = () => set({ color: el.value }); });
    bind('pBg', (el) => { el.oninput = () => set({ bg: el.value }); });
    bind('pOut', (el) => { el.onchange = () => set({ outline: el.checked }); });
    bind('pBgOn', (el) => { el.onchange = () => { set(el.checked ? { bg: o.kind === 'plate' ? '#c8102e' : '#000000', bgAlpha: 0.7, radius: o.radius || 20 } : { bg: '' }); drawProps(); }; });
    const keyOn = async () => {
      try {
        const r = await call('overlayBg', o);
        if (r.transparent) { toast('Фон у файла уже прозрачный: убирать нечего'); drawProps(); return; }
        o.keyColor = r.color; if (!r.same) toast('Углы разного цвета: проверь результат, цвет можно выбрать пипеткой', 5000);
        drawAll();
      } catch (e) { fail(e); }
    };
    bind('kOn', (el) => { el.onchange = () => { if (el.checked) keyOn(); else { o.keyColor = ''; ed.pick = false; drawAll(); } }; });
    bind('kAuto', (el) => { el.onclick = keyOn; });
    bind('kPick', (el) => { el.onclick = () => { ed.pick = !ed.pick; if (ed.pick) toast('Кликни по фону на кадре слева'); drawProps(); drawStage(); }; });
    bind('kColor', (el) => { el.oninput = () => set({ keyColor: el.value }); });
    rng('kTol', 'keyTol', (v) => `${Math.round(v * 100)}%`); rng('kSoft', 'keySoft', (v) => `${Math.round(v * 100)}%`);
    bind('pFile', (el) => { el.onclick = async () => { const f = await call('pickFile', 'Картинка, гифка или видео', OV_MEDIA_FILTERS); if (f) { set({ path: f, kind: /\.(png|jpe?g|webp|bmp)$/i.test(f) ? 'image' : 'video' }); drawProps(); } }; });
    bind('pAll', (el) => { el.onchange = () => { if (el.checked) set({ start: null, end: null }); else set({ start: opts.clip ? Math.round(rel() * 10) / 10 : 0, end: opts.clip ? Math.round((rel() + 3) * 10) / 10 : 3 }); drawProps(); drawStage(); }; });
    const tm = (id, key) => bind(id, (el) => { el.onchange = () => { const v = el.value.trim() === '' ? null : H.parseTime(el.value); if (v === null || Number.isFinite(v)) set({ [key]: v }); drawStage(); }; });
    tm('pS', 'start'); tm('pE', 'end');
    bind('pSn', (el) => { el.onclick = () => { set({ start: Math.round(rel() * 10) / 10 }); drawProps(); }; });
    bind('pEn', (el) => { el.onclick = () => { set({ end: Math.round(rel() * 10) / 10 }); drawProps(); }; });
  };

  const drawAll = () => { drawList(); drawProps(); drawStage(); };
  const add = async (kind) => {
    if (ed.items.length >= 12) { toast('Не больше 12 наложений'); return; }
    if (kind === 'media') {
      const f = await call('pickFile', 'Картинка, гифка или видео', OV_MEDIA_FILTERS);
      if (!f) return;
      ed.items.push(ovNew(/\.(png|jpe?g|webp|bmp)$/i.test(f) ? 'image' : 'video', { path: f }));
    } else ed.items.push(ovNew(kind));
    ed.sel = ed.items.length - 1;
    drawAll();
  };
  $$('[data-add]').forEach((b) => { b.onclick = () => add(b.dataset.add).catch(fail); });
  if (vid()) vid().addEventListener('timeupdate', drawStage);
  $('#osave').onclick = async () => {
    try { await opts.save(ed.items.map((o) => ({ ...o }))); close(); } catch (e) { fail(e); }
  };
  if (opts.extra) opts.extra($('#ovextra'), { items: () => ed.items, add: (list) => { ed.items.push(...list.slice(0, 12 - ed.items.length)); ed.sel = ed.items.length - 1; drawAll(); } });
  drawAll();
}

const ovCopy = (items) => (items || []).map((o) => ({ ...o, id: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` }));

/** Окно наложений одного ролика: свои элементы + загрузка шаблона и сохранение своих как шаблона. */
async function openMomentOverlays(pr, mid) {
  const full = await call('project', pr.id);
  const mom = full.moments.find((x) => x.id === mid);
  if (!mom) return;
  const clip = await call('clip', pr.id, mid, 0);
  await openOverlays({
    title: 'Текст, плашки и медиа на ролике',
    hint: 'Это наложения только для этого ролика. Общие для всех роликов — в шаблоне (внизу).',
    items: mom.overlays || [], clip,
    save: async (items) => {
      const f2 = await call('project', pr.id);
      await call('updateProject', pr.id, { moments: f2.moments.map((x) => (x.id === mid ? { ...x, overlays: items } : x)) });
      S.project = await call('project', pr.id);
      render();
      toast(items.length ? `Сохранено, наложений: ${items.length}` : 'Сохранено');
    },
    extra: (box, api) => {
      const tpls = S.settings.overlayTemplates || [];
      box.innerHTML = `<div class="card flat"><h3>Шаблоны</h3><div class="row wrap">
        <select class="input" id="tSel" style="min-width:180px">${tpls.length ? tpls.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${t.items.length})</option>`).join('') : '<option value="">нет шаблонов</option>'}</select>
        <button class="btn sm" id="tLoad" ${tpls.length ? '' : 'disabled'}>Добавить в этот ролик</button>
        <input class="input" id="tName" placeholder="Название нового шаблона" style="width:200px"><button class="btn sm" id="tSave">${ic('plus', 'sm')}Сохранить эти как шаблон</button></div>
        <small class="muted">Шаблон, выбранный в Настройках → Наложения, ложится на каждый ролик при сборке сам. Здесь его копию можно добавить в ролик и изменить.</small></div>`;
      $('#tLoad').onclick = () => { const t = tpls.find((x) => x.id === $('#tSel').value); if (t) api.add(ovCopy(t.items)); };
      $('#tSave').onclick = async () => {
        const items = api.items();
        if (!items.length) { toast('Сначала добавь наложения'); return; }
        const name = $('#tName').value.trim() || `Шаблон ${tpls.length + 1}`;
        await saveSettings({ overlayTemplates: [...tpls, { id: `t${Date.now().toString(36)}`, name, items: ovCopy(items) }] }, true);
        toast(`Шаблон «${name}» сохранён`);
      };
    },
  });
}

/** Окно правки шаблона (из Настроек): без видео. id пустой — новый шаблон. */
async function openTemplateEditor(id) {
  const tpls = S.settings.overlayTemplates || [];
  const t = tpls.find((x) => x.id === id);
  await openOverlays({
    title: t ? `Шаблон «${t.name}»` : 'Новый шаблон наложений',
    hint: 'Шаблон накладывается на все ролики при сборке: логотип, плашка с каналом, подпись «twitch: evelone2004», обводка.',
    items: t ? t.items : [], clip: null,
    save: async (items) => {
      const name = t ? t.name : (prompt_name() || `Шаблон ${tpls.length + 1}`);
      const next = t ? tpls.map((x) => (x.id === t.id ? { ...x, items } : x)) : [...tpls, { id: `t${Date.now().toString(36)}`, name, items }];
      await saveSettings({ overlayTemplates: next, ...(t ? {} : { overlayTemplate: next[next.length - 1].id }) }, true);
      toast('Шаблон сохранён'); render();
    },
  });
}
const prompt_name = () => { const el = $('#tplName'); return el ? el.value.trim() : ''; };
