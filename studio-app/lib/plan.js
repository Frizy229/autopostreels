'use strict';
// Раздача моментов по каналам: у каждого канала свои ролики. Если моментов меньше, чем нужно,
// момент повторяется у другого канала, но в другом варианте (зум, цвет, стиль субтитров, скорость),
// и никогда не повторяется внутри одного канала.

/**
 * Оформление для (канал, повтор). У каждого канала своя раскладка из opts.formats и свой стиль субтитров
 * из opts.subStyles (по кругу), поэтому один и тот же момент у разных каналов выглядит по-разному.
 * Мелкие отличия (зум, цвет, скорость) — только при opts.vary и не у самого первого ролика.
 */
function variantFor(channelIdx, reuse, opts = {}) {
  const formats = opts.formats && opts.formats.length ? opts.formats : [null];
  const subs = opts.subStyles && opts.subStyles.length ? opts.subStyles : [null];
  const layout = formats[(channelIdx + reuse) % formats.length];
  const subStyle = subs[(channelIdx + reuse * 2) % subs.length];
  const k = channelIdx + reuse * 7;
  if (!opts.vary || (channelIdx === 0 && reuse === 0)) return { layout, subStyle, mirror: false, zoom: 1, sat: 1, bright: 0, speed: 1 };
  const zooms = [1, 1.04, 1.07, 1.02, 1.05];
  const sats = [1, 1.08, 0.95, 1.12, 1.04];
  const brights = [0, 0.02, -0.02, 0.03, -0.01];
  const speeds = [1, 1.03, 1, 1.05, 1.02];
  return {
    layout, subStyle,
    mirror: !!opts.allowMirror && k % 2 === 1,
    zoom: zooms[k % zooms.length],
    sat: sats[(k + 1) % sats.length],
    bright: brights[(k + 2) % brights.length],
    speed: opts.allowSpeed === false ? 1 : speeds[k % speeds.length],
  };
}

/**
 * moments: [{id, score, ...}] (уже отобранные). channels: число каналов. perChannel: роликов на канал.
 * Раздача «змейкой» по силе: канал 1 получает лучший, канал 2 — второй, ..., потом обратно,
 * чтобы ни одному каналу не доставались только слабые моменты.
 * Возвращает [{channel, items: [{moment, variant, reuse}]}].
 */
function planChannels(moments, channels, perChannel, opts = {}) {
  const N = Math.max(1, channels | 0), K = Math.max(1, perChannel | 0);
  const sorted = [...moments].sort((a, b) => (b.score || 0) - (a.score || 0));
  const plan = Array.from({ length: N }, (_, c) => ({ channel: c, items: [] }));
  const uses = new Map();
  const looks = new Map();
  const order = [];
  for (let round = 0; order.length < N * K && round < K * 2; round++) {
    const seq = round % 2 === 0 ? [...Array(N).keys()] : [...Array(N).keys()].reverse();
    order.push(...seq);
  }
  let next = 0;
  const unique = opts.reuse === false;
  for (const c of order.slice(0, N * K)) {
    const have = new Set(plan[c].items.map((x) => x.moment));
    let m = null;
    if (next < sorted.length) { m = sorted[next++]; }
    else if (!unique) {
      // повтор: самый сильный момент, которого у этого канала ещё нет и который реже всего использован
      m = sorted.filter((x) => !have.has(x)).sort((a, b) => (uses.get(a) || 0) - (uses.get(b) || 0) || (b.score || 0) - (a.score || 0))[0] || null;
    }
    if (!m) continue;
    const reuse = uses.get(m) || 0;
    uses.set(m, reuse + 1);
    const variant = variantFor(c, reuse, opts);
    // один и тот же момент у разных каналов — в разных раскладках и стилях, пока есть из чего выбирать
    const seen = looks.get(m) || { layout: new Set(), subStyle: new Set() };
    for (const [key, list] of [['layout', opts.formats], ['subStyle', opts.subStyles]]) {
      if (!list || !list.length || !seen[key].has(variant[key])) continue;
      const start = list.indexOf(variant[key]);
      for (let k = 1; k < list.length; k++) {
        const cand = list[(start + k) % list.length];
        if (!seen[key].has(cand)) { variant[key] = cand; break; }
      }
    }
    seen.layout.add(variant.layout); seen.subStyle.add(variant.subStyle);
    looks.set(m, seen);
    plan[c].items.push({ moment: m, reuse, variant });
  }
  return plan;
}

/** Сколько уникальных моментов нужно и сколько есть — для подсказки в интерфейсе. */
function shortage(momentsCount, channels, perChannel) {
  const need = Math.max(1, channels) * Math.max(1, perChannel);
  return { need, have: momentsCount, missing: Math.max(0, need - momentsCount) };
}

module.exports = { variantFor, planChannels, shortage };
