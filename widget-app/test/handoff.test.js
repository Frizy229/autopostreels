'use strict';
// Передача папок из Reels Studio в виджет автопостера (lib/handoff.js одинаковый в обеих программах).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/handoff');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-'));
const dir = H.handoffDir(tmp);
assert.strictEqual(path.basename(dir), 'Reels Handoff');
assert.strictEqual(H.take(dir), null, 'папки обмена ещё нет — заявок нет');
assert.throws(() => H.request(dir, { folder: '' }));
assert.throws(() => H.request(dir, { folder: 'x', lane: 'vk' }), /Неизвестная очередь/);

// много папок подряд: виджет берёт их по одной, в порядке отправки, без повторов
const ids = [1, 2, 3].map((k) => H.request(dir, { folder: `C:/out/00${k}_x`, lane: 'tiktok' }, 1000 + k));
assert.strictEqual(H.status(dir, ids[0]).state, 'waiting');
const j1 = H.take(dir);
assert.strictEqual(j1.id, ids[0]);
assert.strictEqual(j1.lane, 'tiktok');
assert.strictEqual(H.status(dir, ids[0]).state, 'working');
H.progress(dir, j1.id, 0.5, 'Отправляю');
assert.strictEqual(H.status(dir, ids[0]).frac, 0.5);
H.finish(dir, j1.id, { ok: true, dest: 'queue-tiktok/007_x' });
assert.deepStrictEqual([H.status(dir, ids[0]).state, H.status(dir, ids[0]).ok, H.status(dir, ids[0]).dest], ['done', true, 'queue-tiktok/007_x']);
const j2 = H.take(dir), j3 = H.take(dir);
assert.deepStrictEqual([j2.id, j3.id], [ids[1], ids[2]]);
assert.strictEqual(H.take(dir), null, 'все заявки разобраны');
H.finish(dir, j2.id, { ok: false, error: 'нет токена' });
assert.strictEqual(H.status(dir, ids[1]).error, 'нет токена');
assert.strictEqual(H.status(dir, 'nope').state, 'missing');
// повреждённая заявка не стопорит очередь
fs.writeFileSync(path.join(dir, '0-bad.req.json'), '{');
assert.strictEqual(H.take(dir), null);
assert.strictEqual(H.status(dir, '0-bad').ok, false);

// аккаунты: виджет пишет, Studio читает (с фильтром по соцсети)
assert.strictEqual(H.readAccounts(dir), null);
const many = Array.from({ length: 40 }, (_, i) => ({ name: `acc${i}`, platform: i % 2 ? 'tiktok' : undefined }));
assert.strictEqual(H.writeAccounts(dir, [...many, null, { platform: 'tiktok' }]), 40);
assert.strictEqual(H.readAccounts(dir).accounts.length, 40);
assert.strictEqual(H.readAccounts(dir, 'tiktok').accounts.length, 20);
assert.strictEqual(H.readAccounts(dir, 'instagram').accounts[0].name, 'acc0');
assert.deepStrictEqual(['queue', 'queue-instagram', 'queue-tiktok', '?'].map(H.laneOfQueue), ['shared', 'instagram', 'tiktok', 'shared']);


// «Выложить сразу»: заявка несёт аккаунты, виджет собирает --only для автопостера
const idn = H.request(dir, { folder: 'C:/out/009_ig', lane: 'instagram', postNow: true, accounts: ['one', 'two'] });
const jn = H.take(dir);
assert.strictEqual(jn.id, idn);
assert.deepStrictEqual([jn.postNow, jn.accounts], [true, ['one', 'two']]);
assert.strictEqual(H.postNowOnly('queue-instagram/012_ig', jn.accounts), '012_ig/one/,012_ig/two/');
assert.strictEqual(H.postNowOnly('queue-instagram/012_ig'), '012_ig/');
assert.strictEqual(H.request(dir, { folder: 'x' }) && H.take(dir).postNow, false, 'по умолчанию по расписанию');

// старые ответы убираются
const old = path.join(dir, `${ids[0]}.done.json`);
fs.utimesSync(old, new Date(0), new Date(0));
assert.strictEqual(H.cleanup(dir), 1);
assert.ok(!fs.existsSync(old));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('передача в автопостер: 33 проверки');
