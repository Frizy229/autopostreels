'use strict';
// Чистые помощники окна: работают и в браузере (window.H), и в тестах Node (require).
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m; else root.H = m;
}(typeof self !== 'undefined' ? self : this, () => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTime(sec) {
    const t = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
  }
  /** Время с десятыми: 62.5 → «1:02.5» (для точной обрезки). */
  function fmtTimeP(sec) {
    const t = Math.max(0, Math.round((sec || 0) * 10) / 10);
    const whole = Math.floor(t), frac = Math.round((t - whole) * 10);
    return fmtTime(whole) + (frac ? `.${frac}` : '');
  }
  /** Все ссылки из вставленного текста, без повторов (как parseLinks в lib/sources.js). */
  function parseLinks(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/https?:\/\/[^\s,;"'<>]+/gi)) {
      const u = m[0].replace(/[).,]+$/, '');
      if (!out.includes(u)) out.push(u);
    }
    return out;
  }
  function parseTime(s) {
    const parts = String(s || '').trim().split(':').map(Number);
    if (!parts.length || parts.some((p) => !Number.isFinite(p))) return NaN;
    return parts.reduce((a, p) => a * 60 + p, 0);
  }
  const fmtViews = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n || 0));
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c; };

  /** Рамка в долях: внутри кадра, не меньше min. */
  function clampRect(r, min = 0.04) {
    const w = Math.min(1, Math.max(min, r.w)), h = Math.min(1, Math.max(min, r.h));
    return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
  }

  /**
   * Лицо (пиксели кадра) → рамка вебки: вебка стримера обычно в 2.5–3 раза шире лица,
   * лицо в верхней половине рамки (снизу плечи и стол).
   */
  function faceToCam(face, imgW, imgH) {
    const cx = face.x + face.width / 2, cy = face.y + face.height / 2;
    const w = face.width * 2.8, h = Math.max(face.height * 2.6, w * 9 / 16);
    return clampRect({ x: (cx - w / 2) / imgW, y: (cy - h * 0.42) / imgH, w: w / imgW, h: h / imgH });
  }
  /** Самое крупное лицо. */
  const biggestFace = (faces) => (faces || []).map((f) => f.boundingBox || f).sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;

  /** Все вебки рамки (новый формат {cams}, старый {cam}), не больше 4. */
  const camsOf = (frame) => (!frame ? [] : Array.isArray(frame.cams) ? frame.cams : frame.cam ? [frame.cam] : []).filter((r) => r && r.w > 0 && r.h > 0).slice(0, 4);

  /** Лица → рамки вебок: от крупного к мелкому, без рамок, которые сильно перекрывают уже взятые; слева направо. */
  function facesToCams(faces, imgW, imgH, max = 4) {
    const list = (faces || []).map((f) => f.boundingBox || f).sort((a, b) => b.width * b.height - a.width * a.height);
    const out = [];
    for (const f of list) {
      if (out.length >= max) break;
      const r = faceToCam(f, imgW, imgH);
      const overlap = out.some((o) => {
        const ix = Math.max(0, Math.min(o.x + o.w, r.x + r.w) - Math.max(o.x, r.x)), iy = Math.max(0, Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y));
        return ix * iy > 0.4 * Math.min(o.w * o.h, r.w * r.h);
      });
      if (!overlap) out.push(r);
    }
    return out.sort((a, b) => a.x - b.x);
  }

  /** Где поставить новую вебку: в свободный угол, а не поверх уже отмеченных. */
  function nextCamSlot(cams) {
    const slots = [{ x: 0.68, y: 0.02 }, { x: 0.02, y: 0.02 }, { x: 0.68, y: 0.6 }, { x: 0.02, y: 0.6 }, { x: 0.35, y: 0.3 }];
    const free = slots.find((s) => !cams.some((c) => Math.abs(c.x - s.x) < 0.2 && Math.abs(c.y - s.y) < 0.2)) || slots[4];
    return { ...free, w: 0.3, h: 0.36 };
  }

  /** CSS для предпросмотра стиля субтитров (приближённо к ASS). */
  function subCss(st) {
    const glow = st.glow ? `, 0 0 14px ${st.glow}, 0 0 4px ${st.glow}` : '';
    const shadow = st.shadow ? `, ${st.shadow}px ${st.shadow}px 0 rgba(0,0,0,.75)` : '';
    const base = `font-family:'${st.font}';font-style:${st.italic ? 'italic' : 'normal'};color:${st.color};text-transform:${st.upper ? 'uppercase' : 'none'};`;
    if (st.box) return base + `background:rgba(0,0,0,.72);padding:4px 10px;border-radius:6px;font-size:21px;`;
    return base + `-webkit-text-stroke:${Math.max(3, Math.round(st.bord * 0.75))}px ${st.outline};text-shadow:0 0 0 transparent${shadow}${glow};`;
  }

  /** Схема раскладки для карточки: список полос [{h, kind}] сверху вниз (доли высоты). */
  function layoutBands(key, split = 0.4, fit = 'fill') {
    const vh = 0.32; // видео 16:9 по ширине 9:16 — около трети высоты
    if (fit === 'fit' && key === 'stream') return [{ h: split, kind: 'cam' }, { h: vh, kind: 'video' }, { h: 1 - split - vh, kind: 'blur' }];
    if (fit === 'fit' && key === 'below') return [{ h: 1 - split - vh, kind: 'blur' }, { h: vh, kind: 'video' }, { h: split, kind: 'cam' }];
    switch (key) {
      case 'stream': return [{ h: split, kind: 'cam' }, { h: 1 - split, kind: 'video' }];
      case 'below': return [{ h: 1 - split, kind: 'video' }, { h: split, kind: 'cam' }];
      case 'duo': return [{ h: 0.34, kind: 'cam' }, { h: 0.32, kind: 'video' }, { h: 0.34, kind: 'cam' }];
      case 'pip': return [{ h: 0.08, kind: 'blur' }, { h: 0.24, kind: 'cam' }, { h: 0.32, kind: 'video' }, { h: 0.36, kind: 'blur' }];
      case 'camonly': return [{ h: 1, kind: 'cam' }];
      case 'filler': return [{ h: 0.5, kind: 'stream' }, { h: 0.5, kind: 'game' }];
      case 'full': return [{ h: 0.3, kind: 'blur' }, { h: 0.4, kind: 'stream' }, { h: 0.3, kind: 'blur' }];
      case 'camfull': return [{ h: 0.33, kind: 'cam' }, { h: 0.34, kind: 'video' }, { h: 0.33, kind: 'cam' }];
      default: return [{ h: 1, kind: 'video' }];
    }
  }

  /** Подпись с подставленными {title}, {hashtags} и обязательными тегами — для живого примера. */
  function captionPreview(tpl, vars, rules) {
    let t = String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)).replace(/\n{3,}/g, '\n\n').trim();
    const low = t.toLowerCase();
    const add = [];
    if (rules && rules.twitch && !low.includes(rules.twitch.toLowerCase())) add.push(`twitch: ${rules.twitch}`);
    if (rules && rules.hashtag && !new RegExp(`(^|[\\s,.(])${rules.hashtag.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\wа-яё])`).test(low)) add.push(rules.hashtag);
    return add.length ? `${t}${t ? ' ' : ''}${add.join(' ')}` : t;
  }

  /** Сводка сборки: сколько нужно, сколько выбрано, будут ли повторы. */
  function buildSummary(channels, perChannel, selected) {
    const need = channels * perChannel;
    const uniq = Math.min(selected, need);
    return { need, selected, repeats: Math.max(0, need - selected), uniq, ok: selected > 0 };
  }

  return { esc, fmtTime, fmtTimeP, parseLinks, parseTime, fmtViews, plural, clampRect, faceToCam, biggestFace, camsOf, facesToCams, nextCamSlot, subCss, layoutBands, captionPreview, buildSummary };
}));
