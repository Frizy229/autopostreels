'use strict';
// Добавление аккаунтов кнопкой: шифрование секрета, запись в config.json, разбор адреса после входа, состояние аккаунта,
// запись секрета и чистый старт копии через поддельный GitHub API.
const assert = require('assert');
const nacl = require('tweetnacl');
const { seal, open } = require('../lib/secrets');
const A = require('../lib/accounts');
const { GitHub } = require('../lib/github');

// ---- sealed box: GitHub расшифрует закрытым ключом репозитория
const kp = nacl.box.keyPair();
const pkB64 = Buffer.from(kp.publicKey).toString('base64');
const sealed = seal(pkB64, 'refresh-токен ✓');
assert.strictEqual(open(sealed, pkB64, kp.secretKey), 'refresh-токен ✓');
assert.notStrictEqual(seal(pkB64, 'x'), seal(pkB64, 'x')); // каждый раз новый эфемерный ключ
assert.throws(() => seal('AAAA', 'x'), /ключ/);

// ---- имена
assert.strictEqual(A.secretNameFor('tiktok', 'evelon185'), 'TT_TOKEN_EVELON185');
assert.strictEqual(A.secretNameFor('tiktok', 'my.nick-2'), 'TT_TOKEN_MY_NICK_2');
assert.strictEqual(A.secretNameFor('instagram', 'rulezerosurvivel'), 'IG_TOKEN_RULEZEROSURVIVEL');
assert.strictEqual(A.cleanName(' @my nick! '), 'my_nick');
assert.strictEqual(A.suggestName('Évelone Clips 🔥'), 'evelone_clips');
assert.match(A.nameError('', []), /Впиши/);
assert.match(A.nameError('dayzerorules', [{ name: 'dayzerorules' }], 'tiktok'), /занят/);
assert.strictEqual(A.nameError('evelon185', [{ name: 'evelon185', platform: 'tiktok' }], 'tiktok'), '');

// ---- config.json: добавить, переподключить, убрать
const cfg = { accounts: [
  { name: 'dayzerorules', token_env: 'IG_TOKEN', user_id_env: 'IG_USER_ID' },
  { name: 'evelon185', platform: 'tiktok', mode: 'inbox' },
] };
let r = A.upsertAccount(cfg, { name: 'new.one', platform: 'tiktok', mode: 'inbox', open_id: 'oid-1', connected: '2026-11-06T08:00Z' });
assert.strictEqual(r.replaced, false);
assert.deepStrictEqual(cfg.accounts[2], { name: 'new.one', platform: 'tiktok', mode: 'inbox', token_env: 'TT_TOKEN_NEW_ONE', open_id: 'oid-1', connected: '2026-11-06T08:00Z' });
// тот же аккаунт TikTok под другим ником = переподключение: имя и секрет прежние
r = A.upsertAccount(cfg, { name: 'другое', platform: 'tiktok', mode: 'direct', open_id: 'oid-1', connected: '2026-11-07T08:00Z' });
assert.strictEqual(r.replaced, true);
assert.strictEqual(r.account.name, 'new.one');
assert.strictEqual(r.account.mode, 'inbox'); // режим при переподключении не меняется
assert.strictEqual(cfg.accounts.length, 3);
// старый аккаунт без token_env: секрет по старой схеме TT_TOKEN_<НИК>
r = A.upsertAccount(cfg, { name: 'evelon185', platform: 'tiktok', open_id: 'oid-e' });
assert.strictEqual(r.account.token_env, 'TT_TOKEN_EVELON185');
// первый Instagram: секрет IG_TOKEN остаётся, id становится явным
r = A.upsertAccount(cfg, { name: 'dayzerorules', platform: 'instagram', user_id: '17841431768361264' });
assert.deepStrictEqual(cfg.accounts[0], { name: 'dayzerorules', token_env: 'IG_TOKEN', user_id: '17841431768361264' });
// новый Instagram
r = A.upsertAccount(cfg, { name: 'friend_ig', platform: 'instagram', user_id: '42' });
assert.deepStrictEqual(r.account, { name: 'friend_ig', token_env: 'IG_TOKEN_FRIEND_IG', user_id: '42' });
assert.strictEqual(A.removeAccount(cfg, 'friend_ig', 'tiktok'), null);
assert.strictEqual(A.removeAccount(cfg, 'friend_ig', 'instagram').token_env, 'IG_TOKEN_FRIEND_IG');
// пустой config (копия у друга): первым может быть TikTok
const empty = {};
A.upsertAccount(empty, { name: 'f1', platform: 'tiktok', open_id: 'x' });
assert.strictEqual(empty.accounts[0].token_env, 'TT_TOKEN_F1');
assert.strictEqual(A.tokenEnvOf({ name: 'a' }, 0), 'IG_TOKEN');
assert.strictEqual(A.tokenEnvOf({ name: 'a' }, 2), 'IG_TOKEN_3');

// ---- ссылки и адрес возврата
const RU = 'https://frizy229.github.io/autopostreels/';
const tu = new URL(A.tiktokAuthUrl({ clientKey: 'ck', redirectUri: RU, state: 's1' }));
assert.strictEqual(tu.searchParams.get('scope'), 'user.info.basic,video.upload');
assert.strictEqual(tu.searchParams.get('redirect_uri'), RU);
assert.ok(A.instagramAuthUrl({ appId: '1', redirectUri: RU, state: 's' }).includes('instagram_business_content_publish'));
assert.strictEqual(A.parseRedirect('https://www.tiktok.com/x', RU, 's1'), null);
assert.deepStrictEqual(A.parseRedirect(`${RU}?code=abc&scopes=x&state=s1`, RU, 's1'), { code: 'abc' });
assert.deepStrictEqual(A.parseRedirect('https://frizy229.github.io/autopostreels?code=abc&state=s1', RU, 's1'), { code: 'abc' });
assert.deepStrictEqual(A.parseRedirect(`${RU}?code=ig123#_`, RU, ''), { code: 'ig123' });
assert.match(A.parseRedirect(`${RU}?code=abc&state=other`, RU, 's1').error, /другого входа/);
assert.match(A.parseRedirect(`${RU}?error=access_denied&state=s1`, RU, 's1').error, /отменён/);

// ---- состояние аккаунта
const now = new Date('2026-11-06T09:00:00Z');
const tt = { name: 'tt', platform: 'tiktok' };
assert.strictEqual(A.accountHealth(tt, 1, ['GH_PAT'], {}, now).level, 'bad'); // нет секрета
assert.strictEqual(A.accountHealth(tt, 1, null, {}, now).level, 'unknown'); // секреты не видны: не пугаем
assert.strictEqual(A.accountHealth(tt, 1, ['TT_TOKEN_TT'], { tt: { ok: true, since: '2026-11-01', expires: '2027-11-01' } }, now).level, 'ok');
assert.strictEqual(A.accountHealth(tt, 1, ['TT_TOKEN_TT'], { tt: { ok: true, expires: '2026-11-20' } }, now).level, 'warn');
assert.strictEqual(A.accountHealth(tt, 1, ['TT_TOKEN_TT'], { tt: { ok: false, since: '2026-11-05' } }, now).level, 'bad');
assert.strictEqual(A.accountHealth({ ...tt, connected: '2026-11-06T08:00Z' }, 1, ['TT_TOKEN_TT'], { tt: { ok: false, since: '2026-11-05' } }, now).level, 'unknown');

// ---- GitHub: запись секрета и чистый старт копии
const calls = [];
let commitTree = null;
global.fetch = async (url, opt = {}) => {
  const u = url.replace('https://api.github.com/repos/f/copy', '').split('?')[0];
  const m = opt.method || 'GET';
  const body = opt.body ? JSON.parse(opt.body) : null;
  calls.push([m, u, body]);
  const ok = (j, status = 200) => ({ ok: true, status, json: async () => j, text: async () => (typeof j === 'string' ? j : JSON.stringify(j)) });
  if (u === '/actions/secrets/public-key') return ok({ key: pkB64, key_id: 'kid' });
  if (m === 'PUT' && u.startsWith('/actions/secrets/')) return ok({}, 201);
  if (u === '/actions/secrets') return ok({ secrets: [{ name: 'GH_PAT' }] });
  if (u === '/git/ref/heads/main') return ok({ object: { sha: 'head' } });
  if (u === '/git/commits/head') return ok({ tree: { sha: 'base' } });
  if (u === '/git/trees/base') {
    return ok({ tree: ['queue/.gitkeep', 'queue-tiktok/005_x/a/short-1.mp4', 'posted/001_b/s.mp4', 'posted-instagram/002/s.txt',
      'autoposter.py', 'state.json', 'tiktok_creator.json', 'docs/queue/x.md'].map((p) => ({ path: p, type: 'blob', sha: 'z' })) });
  }
  if (u === '/contents/config.json') return ok(JSON.stringify({ timezone: 'Asia/Tomsk', tiktok_client_key: 'ck', accounts: [{ name: 'dayzerorules' }], paused: ['tiktok'] }));
  if (u === '/git/blobs') return ok({ sha: `blob:${Buffer.from(body.content, 'base64').toString('utf8')}` });
  if (u === '/git/trees' && m === 'POST') { commitTree = body; return ok({ sha: 't' }); }
  if (u === '/git/commits' && m === 'POST') return ok({ sha: 'c' });
  if (m === 'PATCH') return ok({});
  throw new Error(`unexpected ${m} ${url}`);
};

(async () => {
  const g = new GitHub('pat', 'f/copy');
  assert.deepStrictEqual(await g.secretNames(), ['GH_PAT']);
  await g.setSecret('TT_TOKEN_F1', 'rt-123');
  const put = calls.find((c) => c[0] === 'PUT');
  assert.strictEqual(put[1], '/actions/secrets/TT_TOKEN_F1');
  assert.strictEqual(put[2].key_id, 'kid');
  assert.strictEqual(open(put[2].encrypted_value, pkB64, kp.secretKey), 'rt-123');
  assert.ok(!JSON.stringify(calls).includes('rt-123')); // в открытом виде токен не уходил
  await assert.rejects(g.setSecret('bad-name', 'x'), /Недопустимое/);

  const removed = await g.resetCopy();
  const byPath = Object.fromEntries(commitTree.tree.map((e) => [e.path, e.sha]));
  assert.strictEqual(byPath['queue-tiktok/005_x/a/short-1.mp4'], null);
  assert.strictEqual(byPath['posted/001_b/s.mp4'], null);
  assert.strictEqual(byPath['tiktok_creator.json'], null);
  assert.ok(!('autoposter.py' in byPath) && !('docs/queue/x.md' in byPath)); // код и документы не трогаем
  assert.strictEqual(byPath['queue/.gitkeep'], 'blob:');
  const newCfg = JSON.parse(byPath['config.json'].slice(5));
  assert.deepStrictEqual([newCfg.accounts, newCfg.paused, newCfg.tiktok_client_key], [[], [], 'ck']);
  assert.deepStrictEqual(JSON.parse(byPath['state.json'].slice(5)), { posted: {}, skipped: {} });
  assert.strictEqual(removed, 4);
  console.log('accounts tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
