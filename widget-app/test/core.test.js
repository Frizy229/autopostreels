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

// --- папка с подпапками по аккаунтам: у каждого аккаунта свои рилсы
const sub = {
  plans: { '2026-11-05': { folder: '003_batch', plan: {
    'dayzerorules/short-1.mp4': '2026-11-05T10:00+07:00', 'dayzerorules/short-2.mp4': '2026-11-05T22:00+07:00',
    'rulezerosurvivel/short-1.mp4': '2026-11-05T10:00+07:00', 'rulezerosurvivel/short-2.mp4': '2026-11-05T22:00+07:00' } } },
  posted: { '003_batch/dayzerorules/short-1.mp4': { at: '2026-11-05T03:00:00+00:00', permalink: 'https://ig/d1' } },
  posted_acc: { rulezerosurvivel: { '003_batch/rulezerosurvivel/short-1.mp4': { at: '2026-11-05T03:01:00+00:00', permalink: 'https://ig/r1' } },
                survivelzerorule: { '002_old/survivelzerorule/short-1.mp4': { at: '2026-11-04T03:01:00+00:00' } } },
  skipped: { 'rulezerosurvivel|003_batch/rulezerosurvivel/short-2.mp4': 'x' },
};
const subStats = { '003_batch/dayzerorules/short-1.mp4': { views: 7, likes: 1, comments: 0 }, 'rulezerosurvivel|003_batch/rulezerosurvivel/short-1.mp4': { views: 4, likes: 2, comments: 1 } };
const subQueue = [{ name: '003_batch', videos: ['dayzerorules/short-1.mp4', 'dayzerorules/short-2.mp4', 'rulezerosurvivel/short-1.mp4', 'rulezerosurvivel/short-2.mp4', 'survivelzerorule/short-1.mp4'] }];
const ss = buildSnapshot(sub, subStats, subQueue, new Date('2026-11-05T05:00:00Z'), { accounts: ['dayzerorules', 'rulezerosurvivel', 'survivelzerorule'] });
const sf = ss.folders.find((f) => f.name === '003_batch');
assert.strictEqual(sf.kind, 'today');
assert.deepStrictEqual(sf.videos.map((v) => [v.acc, v.name, v.status, v.accounts.length]),
  [['dayzerorules', 'short-1.mp4', 'done', 1], ['dayzerorules', 'short-2.mp4', 'wait', 1],
   ['rulezerosurvivel', 'short-1.mp4', 'done', 1], ['rulezerosurvivel', 'short-2.mp4', 'skipped', 1],
   ['survivelzerorule', 'short-1.mp4', 'queued', 1]]);
assert.strictEqual(sf.videos[2].views, 4); assert.strictEqual(sf.videos[2].permalink, 'https://ig/r1');
assert.strictEqual(sf.videos[0].views, 7);
assert.strictEqual(ss.todayRows.length, 4);
// папка, опубликованная только у второстепенных аккаунтов, попадает в «Готово»
assert.ok(ss.folders.some((f) => f.name === '002_old' && f.kind === 'done'));
// удалили папку из очереди: невышедшие рилсы из плана дня пропадают, вышедшие остаются
const sd = buildSnapshot(sub, subStats, [], new Date('2026-11-05T05:00:00Z'), { accounts: ['dayzerorules', 'rulezerosurvivel', 'survivelzerorule'] });
assert.deepStrictEqual(sd.todayRows.map((r) => r.status).sort(), ['done', 'done', 'skipped']);

// --- проверка папки с подпапками
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
for (const acc of ['dayzerorules', 'rulezerosurvivel']) {
  fs.mkdirSync(path.join(root, acc));
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(root, acc, `short-${n}.mp4`), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, acc, `short-${n}.txt`), `REELS CAPTION (Instagram):\nhi\nCOVER: cover-${n}.jpg\n`);
    fs.writeFileSync(path.join(root, acc, `cover-${n}.jpg`), 'x');
  }
}
const ir = inspectFolder(root, ['dayzerorules', 'rulezerosurvivel', 'survivelzerorule']);
assert.strictEqual(ir.videos, 4); assert.strictEqual(ir.texts, 4); assert.strictEqual(ir.covers, 4);
assert.deepStrictEqual(ir.groups.map((g) => g.name), ['dayzerorules', 'rulezerosurvivel']);
assert.strictEqual(ir.errors.length, 0); assert.strictEqual(ir.warnings.length, 0);
assert.ok(ir.files.some((f) => f.endsWith(path.join('rulezerosurvivel', 'cover-2.jpg'))));
fs.mkdirSync(path.join(root, 'typo')); fs.writeFileSync(path.join(root, 'typo', 'a.mp4'), 'x');
assert.strictEqual(inspectFolder(root, ['dayzerorules', 'rulezerosurvivel']).errors.length, 1);
assert.strictEqual(inspectFolder(root).errors.length, 0); // имена аккаунтов неизвестны: не проверяем
console.log('ok');
