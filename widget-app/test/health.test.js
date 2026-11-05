'use strict';
// Запуски, которые ждут подтверждения на GitHub, и рилсы из убранной папки.
const assert = require('assert');
const { runHealth, buildSnapshot } = require('../lib/core');

const now = new Date('2026-11-05T16:20:00Z');
const run = (c, t) => ({ status: 'completed', conclusion: c, created_at: t, html_url: `https://gh/run/${t}` });
const h = runHealth([run('action_required', '2026-11-05T16:17:00Z'), run('action_required', '2026-11-05T09:05:00Z'), run('success', '2026-11-05T09:00:00Z')], now);
assert.strictEqual(h.approval, true);
assert.strictEqual(h.count, 2);
assert.strictEqual(h.since, '2026-11-05T09:05:00Z');
assert.strictEqual(h.url, 'https://gh/run/2026-11-05T16:17:00Z');
assert.strictEqual(h.minutes, 440);
assert.strictEqual(runHealth([run('success', '2026-11-05T16:15:00Z'), run('action_required', '2026-11-05T16:10:00Z')], now).approval, false);
assert.strictEqual(runHealth([{ status: 'in_progress' }], now).approval, false);
assert.strictEqual(runHealth([], now).ok, true);

// папку убрали: рилс, вышедший не во все аккаунты, не «задерживается», а помечен убранным
const state = {
  plans: { '2026-11-05': { folder: '002_Night', plan: { 's5.mp4': '2026-11-05T16:00+07:00', 's6.mp4': '2026-11-05T19:00+07:00' } } },
  posted_acc: { b: { '002_Night/s5.mp4': { at: '2026-11-05T09:04:00Z' } } }, posted: {}, skipped: {},
};
const opts = { scheduleTz: 'Asia/Tomsk', accounts: ['a', 'b', 'c'] };
const gone = buildSnapshot(state, {}, [], now, opts);
assert.deepStrictEqual(gone.todayRows.map((r) => [r.file, r.status, r.late, r.removed]), [['s5.mp4', 'part', false, true]]);
assert.strictEqual(gone.summary.late, 0);
const still = buildSnapshot(state, {}, [{ name: '002_Night', videos: ['s5.mp4', 's6.mp4'] }], now, opts);
assert.strictEqual(still.todayRows[0].late, true);
console.log('health tests ok');
