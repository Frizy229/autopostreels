'use strict';
// «Сводка»: аккаунты всех групп, топ за 7 дней, лучшие ролики с повторами, A/B подписи, лимиты Meta.
const assert = require('assert');
const { buildDigest, cleanTexts } = require('../lib/core');

const now = new Date('2026-11-05T05:00:00Z'); // 12:00 Томск
const h = (n) => new Date(now - n * 3600000).toISOString();
const accounts = [
  { name: 'one', _group: '' }, { name: 'two', _group: '' }, { name: 'tt', platform: 'tiktok', _group: '' },
  { name: 'carsig', _group: 'cars' },
];
const state = {
  posted: { 'instagram:001/a.mp4': { at: h(2), ab: 'A' }, 'instagram:001/b.mp4': { at: h(30), ab: 'B' }, 'old/x.mp4': { at: h(24 * 9) } },
  posted_acc: {
    two: { 'instagram:001/a.mp4': { at: h(2), ab: 'B' }, 'instagram:001/b.mp4': { at: h(30), ab: 'A' } },
    tt: { 'tiktok:002/c.mp4': { at: h(1), mode: 'inbox' } },
    carsig: { 'cars:instagram:010/z.mp4': { at: h(5), ab: 'A' } },
  },
  limits: { one: { used: 50, total: 50, at: 'x' } },
  best: { 'instagram:001/b.mp4': { group: '', day: '2026-11-05', score: 900, median: 300, video: 'posted-instagram/001/b.mp4',
    reposts: { carsig: { due: '2026-11-06T16:00+07:00' }, two: { due: 'x', at: 'y', permalink: 'https://ig/r' } } } },
};
const stats = {
  'instagram:001/a.mp4': { views: 100, likes: 5, permalink: 'https://ig/1' }, 'two|instagram:001/a.mp4': { views: 300, likes: 7 },
  'instagram:001/b.mp4': { views: 900, likes: 50 }, 'two|instagram:001/b.mp4': { views: 900, likes: 40 },
  'carsig|cars:instagram:010/z.mp4': { views: 40, likes: 1 },
};
const d = buildDigest(state, stats, accounts, now, { scheduleTz: 'Asia/Tomsk', groupNames: { '': 'Выживание', cars: 'Машины' } });
assert.deepStrictEqual(d.totals, { today: 4, week: 6, views: 2240, likes: 103 });
assert.deepStrictEqual(d.accounts.map((a) => [a.name, a.today, a.week, a.views, a.groupName]),
  [['one', 1, 2, 1000, 'Выживание'], ['two', 1, 2, 1200, 'Выживание'], ['tt', 1, 1, 0, 'Выживание'], ['carsig', 1, 1, 40, 'Машины']]);
assert.deepStrictEqual(d.accounts[0].limit, { used: 50, total: 50, at: 'x' });
// топ: ролик целиком (все аккаунты), средние просмотры; TikTok не входит
assert.deepStrictEqual(d.top.map((v) => [v.id, v.avg, v.n, v.best]), [['instagram:001/b.mp4', 900, 2, true], ['instagram:001/a.mp4', 200, 2, false], ['cars:instagram:010/z.mp4', 40, 1, false]]);
assert.strictEqual(d.top[1].links[0].url, 'https://ig/1');
assert.strictEqual(d.top[0].video, 'posted-instagram/001/b.mp4');
// лучший: во сколько раз, повторы
assert.strictEqual(d.best[0].times, 3);
assert.deepStrictEqual(d.best[0].reposts.map((r) => [r.acc, r.status]), [['carsig', 'wait'], ['two', 'done']]);
// A/B по группе: по две публикации у варианта — победителя пока нет
const g = d.groups.find((x) => x.id === '');
assert.deepStrictEqual([g.ab.A.n, g.ab.A.views, g.ab.B.n, g.ab.B.views, g.ab.winner], [2, 500, 2, 600, '']);
assert.strictEqual(d.groups.find((x) => x.id === 'cars').ab.B.n, 0);
// пусто: не падает
const e = buildDigest({}, {}, [], now);
assert.deepStrictEqual([e.top.length, e.best.length, e.totals.week], [0, 0, 0]);
// тексты: вариант B сохраняется
assert.deepStrictEqual(cleanTexts({ caption_b: ' B ', footer_b: '', x: 1 }), { caption_b: 'B' });
console.log('digest tests ok');
