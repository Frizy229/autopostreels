'use strict';
// Группы аккаунтов: очереди группы, снимок для виджета, создание/настройка/удаление группы,
// уникальные ники во всех группах, вход через Facebook с аккаунтами разных групп, удаление папки группы.
const assert = require('assert');
const { buildSnapshot, groupLanes, laneByKey, laneOfId, validGroupId } = require('../lib/core');
const accounts = require('../lib/accounts');
const tiktok = require('../lib/tiktok');

// --- очереди группы (как lanes() в autoposter.py)
assert.deepStrictEqual(groupLanes('cars').map((l) => [l.key, l.dir, l.posted, l.prefix, l.slot]), [
  ['shared', 'groups/cars/queue', 'groups/cars/posted', 'cars:', 'cars'],
  ['instagram', 'groups/cars/queue-instagram', 'groups/cars/posted-instagram', 'cars:instagram:', 'cars:instagram'],
  ['tiktok', 'groups/cars/queue-tiktok', 'groups/cars/posted-tiktok', 'cars:tiktok:', 'cars:tiktok'],
]);
assert.strictEqual(groupLanes('')[0].dir, 'queue');
assert.strictEqual(laneByKey('tiktok', 'cars').dir, 'groups/cars/queue-tiktok');
assert.strictEqual(laneByKey('tiktok').dir, 'queue-tiktok');
assert.strictEqual(laneOfId('cars:instagram:001_x', 'cars').key, 'instagram');
assert.strictEqual(laneOfId('cars:001_x', 'cars').key, 'shared');
assert.throws(() => groupLanes('../x'), /Недопустимый/);
assert.ok(!validGroupId('instagram') && !validGroupId('Cars') && validGroupId('cars-2'));

// --- снимок группы: только её аккаунты и очереди, первый аккаунт не «главный» (state.posted не трогаем)
const now = new Date('2026-11-05T05:00:00Z'); // 12:00 в Томске
const state = {
  posted: { 'cars:instagram:001_car/1.mp4': { at: 'x' }, '010_main/a.mp4': { at: '2026-11-05T03:00:00+00:00' } }, // мусорная запись не должна попасть в группу
  posted_acc: { carsig: { 'cars:instagram:001_car/1.mp4': { at: '2026-11-05T05:00:00+00:00', permalink: 'https://ig/c1' } },
    carstt: { 'cars:tiktok:002_old/1.mp4': { at: '2026-11-04T05:00:00+00:00', mode: 'inbox' } } },
  skipped: { '010_main/b.mp4': 'x', 'carstt|cars:001_both/2.mp4': 'TikTok: не успели' },
  lanes: { 'cars:instagram': { plans: { '2026-11-05': { folder: '001_car', plan: { '1.mp4': '2026-11-05T12:00+07:00', '2.mp4': '2026-11-05T20:00+07:00' } } } } },
};
const queues = { shared: [{ name: '001_both', videos: ['1.mp4', '2.mp4'] }], instagram: [{ name: '001_car', videos: ['1.mp4', '2.mp4'] }], tiktok: [] };
const opts = (net) => ({ scheduleTz: 'Asia/Tomsk', accounts: ['carsig', 'carstt'], platforms: { carsig: 'instagram', carstt: 'tiktok' }, net, group: 'cars' });
const ig = buildSnapshot(state, {}, queues, now, opts('instagram'));
assert.strictEqual(ig.group, 'cars');
assert.deepStrictEqual(ig.todayRows.map((r) => [r.id, r.status]), [['cars:instagram:001_car/1.mp4', 'done'], ['cars:instagram:001_car/2.mp4', 'wait']]);
assert.deepStrictEqual(ig.folders.map((f) => [f.id, f.kind]), [['cars:instagram:001_car', 'today'], ['cars:001_both', 'queue']]);
const tt = buildSnapshot(state, {}, queues, now, opts('tiktok'));
// общая очередь группы: в TikTok второй ролик пропущен; опубликованная папка 002_old в «Готово»
assert.deepStrictEqual(tt.folders.map((f) => [f.id, f.kind]), [['cars:001_both', 'queue'], ['cars:tiktok:002_old', 'done']]);
assert.strictEqual(tt.folders[0].videos[1].status, 'skipped');
// пустая группа без аккаунтов: ничего не показывает и не падает
const empty = buildSnapshot(state, {}, { shared: [], instagram: [], tiktok: [] }, now, { scheduleTz: 'Asia/Tomsk', accounts: [], group: 'new' });
assert.deepStrictEqual([empty.folders.length, empty.todayRows.length], [0, 0]);
// основная группа не видит рилсы группы
const main = buildSnapshot(state, {}, { shared: [] }, now, { scheduleTz: 'Asia/Tomsk', accounts: ['dayzerorules'], net: 'instagram' });
assert.ok(main.folders.every((f) => !f.id.startsWith('cars:')));

// --- TikTok: подтверждение прямой публикации в очередях группы
const pend = tiktok.pendingConfirm({ shared: [], tiktok: [{ name: '003_t', videos: ['1.mp4'], tiktok: [] }] }, {}, [{ name: 'carstt', platform: 'tiktok', mode: 'direct' }], 'cars');
assert.deepStrictEqual(pend.map((p) => [p.id, p.rel, p.path]), [['cars:tiktok:003_t/1.mp4', 'groups/cars/queue-tiktok/003_t/1.mp4', 'groups/cars/queue-tiktok/003_t/1.tiktok.json']]);

// --- создать, настроить и убрать группу
const cfg = { day_start: '10:00', day_end: '22:00', accounts: [{ name: 'dayzerorules', token_env: 'IG_TOKEN' }] };
const g = accounts.createGroup(cfg, { name: 'Машины', day_start: '12:00', day_end: '20:00' });
assert.deepStrictEqual(g, { id: 'mashiny', name: 'Машины', accounts: [], paused: [], texts: {}, day_start: '12:00', day_end: '20:00' });
assert.throws(() => accounts.createGroup(cfg, { name: 'машины' }), /уже есть/);
assert.throws(() => accounts.createGroup(cfg, { name: '' }), /название/);
assert.throws(() => accounts.createGroup(cfg, { name: 'X', day_start: '23:00', day_end: '10:00' }), /раньше/);
assert.throws(() => accounts.createGroup(cfg, { name: 'Y', day_start: '9' }), /10:00/);
assert.strictEqual(accounts.createGroup(cfg, { name: 'Основная 2' }).id, 'osnovnaya-2');
assert.deepStrictEqual(accounts.groupList(cfg).map((x) => [x.id, x.name]), [['', 'Основная'], ['mashiny', 'Машины'], ['osnovnaya-2', 'Основная 2']]);
accounts.updateGroup(cfg, 'mashiny', { name: 'Машины Эвелона', day_start: '' });
assert.strictEqual(cfg.groups[0].name, 'Машины Эвелона');
assert.ok(!('day_start' in cfg.groups[0]));
accounts.updateGroup(cfg, '', { name: 'Выживание' });
assert.strictEqual(cfg.group_name, 'Выживание');
assert.strictEqual(accounts.groupList(cfg)[0].name, 'Выживание');
assert.throws(() => accounts.updateGroup(cfg, 'nope', { name: 'x' }), /нет/);
assert.throws(() => accounts.removeGroup(cfg, ''), /Основную/);

// --- аккаунты в группе: свой список, ник уникален во всех группах, секрет по нику
const node = accounts.groupNode(cfg, 'mashiny');
const { account } = accounts.upsertAccount(node, { name: 'carsig', platform: 'instagram', user_id: '77' }, { legacy: false });
assert.strictEqual(account.token_env, 'IG_TOKEN_CARSIG');
assert.deepStrictEqual(cfg.accounts.map((a) => a.name), ['dayzerorules']);
const all = accounts.allAccounts(cfg);
assert.deepStrictEqual(all.map((a) => [a.name, a._group]), [['dayzerorules', ''], ['carsig', 'mashiny']]);
assert.match(accounts.nameError('dayzerorules', all, 'instagram', '', 'mashiny'), /уже есть в группе «Выживание»/);
assert.strictEqual(accounts.nameError('dayzerorules', all, 'instagram', '', ''), ''); // своя группа: переподключение
assert.strictEqual(accounts.nameError('newone', all, 'instagram', '', 'mashiny'), '');
assert.throws(() => accounts.removeGroup(cfg, 'mashiny'), /есть аккаунты/);

// вход через Facebook: аккаунт из другой группы помечен, при сохранении остаётся в своей группе
const choices = accounts.instagramChoices([{ user_id: '77', username: 'carsig' }, { user_id: '88', username: 'fresh' }], all);
assert.deepStrictEqual(choices.map((c) => [c.existing, c.group, c.main]), [['carsig', 'mashiny', false], ['', undefined, false]]);
const plan = accounts.planInstagramBatch([{ user_id: '77', name: 'carsig' }, { user_id: '88', name: 'fresh' }], all, '');
assert.deepStrictEqual(plan.errors, []);
assert.deepStrictEqual(plan.entries, [{ name: 'carsig', user_id: '77', group: 'mashiny' }, { name: 'fresh', user_id: '88', group: '' }]);
const clash = accounts.planInstagramBatch([{ user_id: '99', name: 'carsig' }], all, '');
assert.match(clash.errors[0], /уже есть в группе/);

// убрать аккаунт и пустую группу
accounts.removeAccount(node, 'carsig', 'instagram');
accounts.removeGroup(cfg, 'mashiny');
assert.deepStrictEqual(cfg.groups.map((x) => x.id), ['osnovnaya-2']);

// --- GitHub: удаление папки группы идёт по вложенному пути groups/<id>/queue-instagram
const trees = {
  base: [{ path: 'groups', type: 'tree', sha: 'gr' }, { path: 'queue', type: 'tree', sha: 'q' }],
  gr: [{ path: 'cars', type: 'tree', sha: 'c' }], c: [{ path: 'queue-instagram', type: 'tree', sha: 'ci' }],
  ci: [{ path: '001_car', type: 'tree', sha: 'f' }],
};
let created = null;
global.fetch = async (url, opt = {}) => {
  const u = url.replace('https://api.github.com/repos/o/r', '').split('?')[0];
  const m = opt.method || 'GET';
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (m === 'GET' && u.startsWith('/git/trees/')) {
    const sha = u.split('/').pop();
    if (url.includes('recursive')) return ok({ tree: [{ path: '1.mp4', type: 'blob' }, { path: '1.txt', type: 'blob' }] });
    return ok({ tree: trees[sha] || [] });
  }
  if (u === '/git/ref/heads/main') return ok({ object: { sha: 'head' } });
  if (u === '/git/commits/head') return ok({ tree: { sha: 'base' } });
  if (u === '/git/trees' && m === 'POST') { created = JSON.parse(opt.body); return ok({ sha: 'nt' }); }
  if (u === '/git/commits' && m === 'POST') return ok({ sha: 'nc' });
  if (m === 'PATCH') return ok({});
  throw new Error(`unexpected ${m} ${url}`);
};
const { GitHub } = require('../lib/github');
(async () => {
  const gh = new GitHub('t', 'o/r');
  assert.strictEqual(await gh.deleteFolder('001_car', 'instagram', 'cars'), 2);
  assert.deepStrictEqual(created.tree.map((e) => e.path), ['groups/cars/queue-instagram/001_car/1.mp4', 'groups/cars/queue-instagram/001_car/1.txt']);
  await assert.rejects(() => gh.deleteFolder('001_car', 'tiktok', 'cars'), /нет в очереди/);
  await assert.rejects(() => gh.saveTiktokSettings('groups/../x/queue/1.tiktok.json', {}), /Недопустимый/);
  console.log('groups tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
