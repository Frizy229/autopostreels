'use strict';
// Разделы Instagram / TikTok: снимок для каждой сети, отдельные очереди, тексты, запуск, подтверждение TikTok.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSnapshot, captionFor, cleanTexts, laneOfId, LANES, inspectFolder } = require('../lib/core');
const tiktok = require('../lib/tiktok');
const { GitHub } = require('../lib/github');

const accounts = ['dayzerorules', 'rulezerosurvivel', 'evelon185'];
const platforms = { dayzerorules: 'instagram', rulezerosurvivel: 'instagram', evelon185: 'tiktok' };
const now = new Date('2026-11-05T05:00:00Z'); // 12:00 в Томске
const state = {
  plans: { '2026-11-05': { folder: '010_both', plan: { 'a.mp4': '2026-11-05T10:00+07:00', 'b.mp4': '2026-11-05T22:00+07:00' } } },
  posted: { '010_both/a.mp4': { at: '2026-11-05T03:00:00+00:00', permalink: 'https://ig/a', comment_id: 'c1' },
            'instagram:011_ig/1.mp4': { at: '2026-11-05T03:05:00+00:00', permalink: 'https://ig/1', comment_error: 'no perm' },
            'instagram:009_old/x.mp4': { at: '2026-11-04T03:05:00+00:00' } },
  posted_acc: {
    rulezerosurvivel: { '010_both/a.mp4': { at: '2026-11-05T03:01:00+00:00' }, 'instagram:011_ig/1.mp4': { at: '2026-11-05T03:06:00+00:00' },
                        'instagram:009_old/x.mp4': { at: '2026-11-04T03:06:00+00:00' } },
    evelon185: { 'tiktok:012_tt/1.mp4': { at: '2026-11-05T03:02:00+00:00', mode: 'inbox', platform: 'tiktok' } },
  },
  skipped: { 'evelon185|010_both/a.mp4': 'TikTok: не успели' },
  lanes: {
    instagram: { plans: { '2026-11-05': { folder: '011_ig', plan: { '1.mp4': '2026-11-05T10:00+07:00', '2.mp4': '2026-11-05T22:00+07:00' } } } },
    tiktok: { active: { folder: '012_tt', date: '2026-11-05', plan: {} },
              plans: { '2026-11-05': { folder: '012_tt', plan: { '1.mp4': '2026-11-05T10:00+07:00', '2.mp4': '2026-11-05T11:00+07:00' } } } },
  },
};
const queues = {
  shared: [{ name: '010_both', videos: ['b.mp4'] }, { name: '013_split', videos: ['dayzerorules/s.mp4', 'evelon185/t.mp4'] }],
  instagram: [{ name: '011_ig', videos: ['2.mp4'], texts: true }, { name: '014_next', videos: ['1.mp4'] }],
  tiktok: [{ name: '012_tt', videos: ['2.mp4'], tiktok: [] }],
};
const opts = (net) => ({ scheduleTz: 'Asia/Tomsk', accounts, platforms, net });

// --- раздел Instagram
const ig = buildSnapshot(state, {}, queues, now, opts('instagram'));
assert.deepStrictEqual(ig.folders.filter((f) => f.kind !== 'done').map((f) => [f.id, f.kind, f.shared]),
  [['010_both', 'today', true], ['instagram:011_ig', 'today', false], ['013_split', 'queue', true], ['instagram:014_next', 'queue', false]]);
// в разделе Instagram только аккаунты Instagram
assert.deepStrictEqual(ig.folders[0].videos[0].accounts.map((a) => a.name), ['dayzerorules', 'rulezerosurvivel']);
assert.strictEqual(ig.folders[0].videos[0].status, 'done');
// подпапка TikTok-аккаунта в общей папке не видна в разделе Instagram
assert.deepStrictEqual(ig.folders.find((f) => f.id === '013_split').videos.map((v) => v.file), ['dayzerorules/s.mp4']);
assert.strictEqual(ig.folders.find((f) => f.id === 'instagram:011_ig').texts, true);
// план дня: общая очередь + своя, по времени
assert.deepStrictEqual(ig.todayRows.map((r) => [r.lane, r.file, r.status]),
  [['shared', 'a.mp4', 'done'], ['instagram', '1.mp4', 'done'], ['shared', 'b.mp4', 'wait'], ['instagram', '2.mp4', 'wait']]);
assert.strictEqual(ig.summary.text, 'Сегодня 2 из 4');
// авто-комментарий виден по аккаунту
assert.strictEqual(ig.todayRows[0].accounts[0].comment, 'ok');
assert.strictEqual(ig.todayRows[1].accounts[0].comment, 'error');
// опубликованная папка своей очереди в «Готово»
assert.ok(ig.folders.some((f) => f.id === 'instagram:009_old' && f.kind === 'done' && f.name === '009_old'));
assert.ok(!ig.folders.some((f) => f.id.startsWith('tiktok:')));
assert.strictEqual(ig.nextNum, 15);

// --- раздел TikTok
const tt = buildSnapshot(state, {}, queues, now, opts('tiktok'));
assert.deepStrictEqual(tt.folders.filter((f) => f.kind !== 'done').map((f) => f.id), ['010_both', 'tiktok:012_tt', '013_split']);
assert.deepStrictEqual(tt.folders.find((f) => f.id === '013_split').videos.map((v) => v.file), ['evelon185/t.mp4']);
const ttRows = tt.todayRows.map((r) => [r.id, r.status, r.late]);
assert.deepStrictEqual(ttRows, [['010_both/a.mp4', 'skipped', false], ['tiktok:012_tt/1.mp4', 'done', false],
  ['tiktok:012_tt/2.mp4', 'wait', true], ['010_both/b.mp4', 'wait', false]]);
assert.strictEqual(tt.todayRows[1].accounts[0].inbox, true);
// задержка в TikTok: 11:00 прошло больше 15 минут назад
const tt2 = buildSnapshot(state, {}, queues, new Date('2026-11-05T04:20:00Z'), opts('tiktok'));
assert.strictEqual(tt2.summary.late, 1);
assert.ok(!tt.folders.some((f) => f.id.startsWith('instagram:')));

// без раздела: всё вместе, как раньше
const all = buildSnapshot(state, {}, queues, now, { scheduleTz: 'Asia/Tomsk', accounts, platforms });
assert.strictEqual(all.todayRows.length, 6);
assert.strictEqual(all.folders.find((f) => f.id === '010_both').videos[0].status, 'done'); // вышел везде, кроме пропущенного TikTok
// массив вместо очередей: старый формат
assert.strictEqual(buildSnapshot(state, {}, queues.shared, now, opts('instagram')).folders.filter((f) => f.kind !== 'done').length, 2);

// --- id и очереди
assert.strictEqual(laneOfId('tiktok:012_tt').dir, 'queue-tiktok');
assert.strictEqual(laneOfId('010_both').dir, 'queue');
assert.deepStrictEqual(LANES.map((l) => l.posted), ['posted', 'posted-instagram', 'posted-tiktok']);

// --- подписи из .txt (как caption_for в автопостере)
const txt = 'TITLE:\nT\n\nREELS CAPTION (Instagram):\nIG cap\n\nREELS CAPTION (TikTok):\nTT cap\n\nPINNED COMMENT:\npin\n';
assert.strictEqual(captionFor(txt, 'tiktok'), 'TT cap');
assert.strictEqual(captionFor(txt, 'instagram'), 'IG cap');
assert.strictEqual(captionFor('REELS CAPTION (Instagram @evelon185):\nmine\n', 'tiktok', 'evelon185'), 'mine');
assert.strictEqual(captionFor('﻿just text\nCOVER: c.jpg\n'), 'just text');
assert.strictEqual(captionFor('REELS CAPTION:\nx\r\nCOVER: c.jpg\r\n'), 'x');

// --- тексты из формы
assert.deepStrictEqual(cleanTexts({ caption: '  hi ', footer: '', hashtags: '#a', comment: null, use_pinned_comment: false, junk: 1 }), { caption: 'hi', hashtags: '#a' });
assert.deepStrictEqual(cleanTexts({ use_pinned_comment: true }), { use_pinned_comment: true });

// --- проверка папки: texts.json едет вместе с папкой
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
fs.writeFileSync(path.join(dir, 'texts.json'), '{"caption":"c"}');
assert.ok(inspectFolder(dir).files.some((f) => f.endsWith('texts.json')));

// --- TikTok: подтверждение в общей и отдельной очереди
const accs = [{ name: 'dayzerorules' }, { name: 'evelon185', platform: 'tiktok', mode: 'direct' }];
const q2 = { shared: [{ name: '010_both', videos: ['b.mp4'], tiktok: [] }], tiktok: [{ name: '012_tt', videos: ['1.mp4', '2.mp4'], tiktok: ['2.tiktok.json'] }] };
const pend = tiktok.pendingConfirm(q2, state, accs);
assert.deepStrictEqual(pend.map((p) => [p.id, p.path, p.rel]), [
  ['010_both/b.mp4', 'queue/010_both/b.tiktok.json', 'queue/010_both/b.mp4']]);
const pend2 = tiktok.pendingConfirm(q2, {}, accs);
assert.deepStrictEqual(pend2.map((p) => p.path), ['queue/010_both/b.tiktok.json', 'queue-tiktok/012_tt/1.tiktok.json']);
assert.strictEqual(tiktok.pendingConfirm(q2, {}, [{ name: 'evelon185', platform: 'tiktok', mode: 'inbox' }]).length, 0);

// --- GitHub: очереди, тексты папки, config.json, запуск, удаление из отдельной очереди
const calls = [];
let dispatchStatus = 204;
const files = { 'config.json': JSON.stringify({ accounts: [], texts: { instagram: { comment: 'old' } } }) };
global.fetch = async (url, opt = {}) => {
  const m = opt.method || 'GET';
  const u = url.replace('https://api.github.com/repos/o/r', '').split('?')[0];
  const body = opt.body ? JSON.parse(opt.body) : null;
  calls.push([m, u, body]);
  const ok = (j, status = 200) => ({ ok: true, status, json: async () => j, text: async () => (typeof j === 'string' ? j : JSON.stringify(j)) });
  const nf = { ok: false, status: 404, statusText: 'nf', json: async () => ({ message: 'Not Found' }) };
  if (m === 'GET' && u === '/contents/queue') return ok([{ name: '010_both', type: 'dir', sha: 's1' }, { name: '.gitkeep', type: 'file' }]);
  if (m === 'GET' && u === '/contents/queue-instagram') return ok([{ name: '011_ig', type: 'dir', sha: 's2' }]);
  if (m === 'GET' && u === '/contents/queue-tiktok') return nf;
  if (m === 'GET' && u.startsWith('/git/trees/s')) return ok({ tree: u.endsWith('s2') ? [{ path: '1.mp4', type: 'blob' }, { path: 'texts.json', type: 'blob' }] : [{ path: 'b.mp4', type: 'blob' }] });
  if (m === 'GET' && u.startsWith('/contents/')) {
    const p = decodeURIComponent(u.slice('/contents/'.length));
    return p in files ? ok(files[p]) : nf;
  }
  if (u === '/git/blobs') return ok({ sha: 'blob1' });
  if (u === '/git/ref/heads/main') return ok({ object: { sha: 'head' } });
  if (u === '/git/commits/head') return ok({ tree: { sha: 'base' } });
  if (u === '/git/trees/base') return ok({ tree: [{ path: 'queue-tiktok', type: 'tree', sha: 'qt' }] });
  if (u === '/git/trees/qt') return ok({ tree: [{ path: '012_tt', type: 'tree', sha: 'f12' }] });
  if (u === '/git/trees/f12') return ok({ tree: [{ path: '1.mp4', type: 'blob' }, { path: 'texts.json', type: 'blob' }] });
  if (u === '/git/trees' && m === 'POST') return ok({ sha: 'tree2' });
  if (u === '/git/commits' && m === 'POST') return ok({ sha: 'c2' });
  if (m === 'PATCH') return ok({});
  if (u === '/actions/workflows/post.yml/dispatches') {
    return dispatchStatus === 204 ? ok({}, 204) : { ok: false, status: dispatchStatus, statusText: 'x', json: async () => ({ message: 'Resource not accessible by personal access token' }) };
  }
  throw new Error('unexpected ' + m + ' ' + url);
};
const lastTree = () => calls.filter(([m, u]) => m === 'POST' && u === '/git/trees').pop()[2].tree;

(async () => {
  const g = new GitHub('t', 'o/r');
  const qs = await g.queues();
  assert.deepStrictEqual(Object.keys(qs).sort(), ['instagram', 'shared', 'tiktok']);
  assert.deepStrictEqual(qs.instagram, [{ name: '011_ig', videos: ['1.mp4'], tiktok: [], texts: true }]);
  assert.deepStrictEqual(qs.shared.map((q) => q.name), ['010_both']);
  assert.deepStrictEqual(qs.tiktok, []);

  // тексты папки
  assert.deepStrictEqual(await g.folderTexts('instagram', '011_ig'), {});
  await g.saveFolderTexts('tiktok', '012_tt', { caption: 'hello', footer: '' });
  assert.deepStrictEqual(lastTree().map((e) => [e.path, e.sha]), [['queue-tiktok/012_tt/texts.json', 'blob1']]);
  const blobBody = calls.filter(([, u]) => u === '/git/blobs').pop()[2];
  assert.deepStrictEqual(JSON.parse(Buffer.from(blobBody.content, 'base64').toString()), { caption: 'hello' });
  // пустые тексты: файл удаляется (если он есть)
  files['queue-tiktok/012_tt/texts.json'] = '{"caption":"hello"}';
  await g.saveFolderTexts('tiktok', '012_tt', {});
  assert.deepStrictEqual(lastTree().map((e) => [e.path, e.sha]), [['queue-tiktok/012_tt/texts.json', null]]);
  await assert.rejects(() => g.saveFolderTexts('tiktok', '../x', {}), /Недопустимое/);

  // тексты сети и пауза: правка config.json без потери остальных настроек
  const c = await g.updateConfig((rc) => { rc.texts.tiktok = { hashtags: '#fyp' }; rc.paused = ['tiktok']; }, 'm');
  assert.deepStrictEqual(c.texts, { instagram: { comment: 'old' }, tiktok: { hashtags: '#fyp' } });
  assert.deepStrictEqual(lastTree().map((e) => e.path), ['config.json']);

  // запуск автопостера
  await g.dispatch({ action: 'post', only: 'tiktok:012_tt/2.mp4' });
  const d = calls.filter(([, u]) => u === '/actions/workflows/post.yml/dispatches').pop()[2];
  assert.deepStrictEqual(d, { ref: 'main', inputs: { action: 'post', only: 'tiktok:012_tt/2.mp4' } });
  dispatchStatus = 403;
  await assert.rejects(() => g.dispatch({ action: 'check' }), /Actions: Read and write/);

  // удаление папки из очереди TikTok
  const n = await g.deleteFolder('012_tt', 'tiktok');
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(lastTree().map((e) => e.path), ['queue-tiktok/012_tt/1.mp4', 'queue-tiktok/012_tt/texts.json']);
  await assert.rejects(() => g.deleteFolder('012_tt', 'instagram'), /нет в очереди/);

  // подтверждение TikTok в отдельной очереди разрешено, чужие пути нет
  await g.saveTiktokSettings('queue-tiktok/012_tt/1.tiktok.json', { consent: true });
  await assert.rejects(() => g.saveTiktokSettings('queue-instagram/011_ig/1.tiktok.json', {}), /Недопустимый/);
  await assert.rejects(() => g.downloadVideo('state.json', '/dev/null'), /Недопустимый/);

  // номер новой папки считается по всем очередям и posted
  calls.length = 0;
  global.fetch = async (url) => {
    const u = url.replace('https://api.github.com/repos/o/r', '').split('?')[0];
    const list = { '/contents/queue-tiktok': [{ name: '021_x', type: 'dir' }], '/contents/posted-instagram': [{ name: '030_y', type: 'dir' }] }[u];
    return list ? { ok: true, status: 200, json: async () => list } : { ok: false, status: 404, statusText: 'nf', json: async () => ({}) };
  };
  assert.strictEqual(await g.nextNumber(), 31);
  console.log('lanes tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
