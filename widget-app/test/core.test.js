'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSnapshot, inspectFolder, slug } = require('../lib/core');

assert.strictEqual(slug('001 Бункер день 90'), 'Бункер_день_90');
assert.strictEqual(slug('12_x'), 'x');

const state = {
  plans: { '2026-11-03': { folder: '001_b', plan: {
    'a.mp4': '2026-11-03T10:00+03:00', 'b.mp4': '2026-11-03T14:00+03:00', 'c.mp4': '2026-11-03T18:00+03:00', 'd.mp4': '2026-11-03T22:00+03:00' } } },
  posted: { '001_b/a.mp4': { media_id: '1', permalink: 'https://ig/a', at: '2026-11-03T07:03:00+00:00' },
            '000_old/x.mp4': { media_id: '2', permalink: '', at: '2026-11-02T07:00:00+00:00' } },
  skipped: { '001_b/b.mp4': 'x' },
};
const stats = { '001_b/a.mp4': { views: 5, likes: 2, comments: 1, permalink: 'https://ig/reel/a' } };
const queue = [{ name: '001_b', videos: ['b.mp4', 'c.mp4', 'd.mp4'] }, { name: '002_next', videos: ['1.mp4', '2.mp4'] }];
const s = buildSnapshot(state, stats, queue, new Date('2026-11-03T12:00:00Z'));
assert.strictEqual(s.today, '2026-11-03');
assert.deepStrictEqual(s.todayRows.map((r) => r.status), ['done', 'skipped', 'wait', 'wait']);
assert.strictEqual(s.summary.text, 'Сегодня 1 из 4');
assert.deepStrictEqual(s.folders.map((f) => [f.name, f.kind, f.done, f.total]),
  [['001_b', 'today', 1, 4], ['002_next', 'queue', 0, 2], ['000_old', 'done', 1, 1]]);
assert.strictEqual(s.folders[0].videos[0].views, 5);
assert.strictEqual(s.folders[1].videos[0].status, 'queued');
assert.strictEqual(s.nextNum, 3);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
for (const n of ['short-4.mp4', 'short-5.mp4']) fs.writeFileSync(path.join(dir, n), Buffer.alloc(1000));
fs.writeFileSync(path.join(dir, 'short-4.txt'), 'REELS CAPTION:\nhi\nCOVER: cover-4.jpg\n');
fs.writeFileSync(path.join(dir, 'cover-4.jpg'), 'x');
const i = inspectFolder(dir);
assert.strictEqual(i.videos, 2); assert.strictEqual(i.texts, 1); assert.strictEqual(i.covers, 1);
assert.strictEqual(i.warnings.length, 2);
assert.throws(() => assert.ok(inspectFolder(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'))).errors.length === 0));
// три аккаунта
const st3 = { ...state, posted_acc: { b: { '001_b/a.mp4': { at: '2026-11-03T08:00:00+00:00', permalink: 'https://ig/b' } } } };
const stats3 = { ...stats, 'b|001_b/a.mp4': { views: 9, likes: 3, comments: 0 } };
const s3 = buildSnapshot(st3, stats3, queue, new Date('2026-11-03T12:00:00Z'), { accounts: ['a', 'b', 'c'] });
const v0 = s3.todayRows[0];
assert.strictEqual(v0.status, 'part');
assert.deepStrictEqual(v0.accounts.map((x) => [x.name, x.status, x.views]), [['a', 'done', 5], ['b', 'done', 9], ['c', 'wait', null]]);
const s1 = buildSnapshot(state, stats, queue, new Date('2026-11-03T12:00:00Z'), { accounts: ['a'] });
assert.strictEqual(s1.todayRows[0].status, 'done');
// задержка: слот прошёл больше 15 минут назад
const sl = buildSnapshot({ plans: { '2026-11-03': { folder: '001_b', plan: { 'c.mp4': '2026-11-03T18:00+03:00', 'd.mp4': '2026-11-03T22:00+03:00' } } }, posted: {}, skipped: {} },
  {}, [{ name: '001_b', videos: ['c.mp4', 'd.mp4'] }], new Date('2026-11-03T15:20:00Z'));
assert.deepStrictEqual(sl.todayRows.map((r) => r.late), [true, false]);
assert.strictEqual(sl.summary.late, 1);
const sl2 = buildSnapshot({ plans: { '2026-11-03': { folder: '001_b', plan: { 'c.mp4': '2026-11-03T18:00+03:00' } } }, posted: {}, skipped: {} },
  {}, [{ name: '001_b', videos: ['c.mp4'] }], new Date('2026-11-03T15:10:00Z'));
assert.strictEqual(sl2.todayRows[0].late, false);
// TikTok: черновик в инбоксе
const stT = { ...state, posted_acc: { tt: { '001_b/a.mp4': { at: '2026-11-03T08:00:00+00:00', platform: 'tiktok', mode: 'inbox', permalink: '' } } } };
const sT = buildSnapshot(stT, stats, queue, new Date('2026-11-03T12:00:00Z'), { accounts: ['a', 'tt'], platforms: { a: 'instagram', tt: 'tiktok' } });
assert.deepStrictEqual(sT.todayRows[0].accounts.map((x) => [x.name, x.platform, x.status, x.inbox]),
  [['a', 'instagram', 'done', false], ['tt', 'tiktok', 'done', true]]);
assert.strictEqual(sT.todayRows[0].status, 'done');
console.log('ok');
