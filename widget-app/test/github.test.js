'use strict';
// GitHub-класс на поддельном API: чтение вложенной очереди и удаление папки одним коммитом.
const assert = require('assert');
const { GitHub } = require('../lib/github');

const trees = {
  root: [{ path: 'queue', type: 'tree', sha: 'q' }, { path: 'state.json', type: 'blob', sha: 's' }],
  q: [{ path: '003_batch', type: 'tree', sha: 'b' }, { path: '004_flat', type: 'tree', sha: 'f' }],
  b: [{ path: 'dayzerorules', type: 'tree', sha: 'bd' }, { path: 'rulezerosurvivel', type: 'tree', sha: 'br' }],
  bd: [{ path: 'short-1.mp4', type: 'blob', sha: '1' }, { path: 'short-1.txt', type: 'blob', sha: '2' }],
  br: [{ path: 'short-1.mp4', type: 'blob', sha: '3' }],
  f: [{ path: 'a.mp4', type: 'blob', sha: '4' }],
};
const flat = (name) => ({ b: ['dayzerorules/short-1.mp4', 'dayzerorules/short-1.txt', 'rulezerosurvivel/short-1.mp4'], f: ['a.mp4'] }[name]);
let created = null, patches = 0, conflict = 1;
global.fetch = async (url, opt = {}) => {
  const u = url.replace('https://api.github.com/repos/o/r', '').split('?')[0];
  const body = opt.body ? JSON.parse(opt.body) : null;
  const ok = (j, status = 200) => ({ ok: true, status, json: async () => j, text: async () => JSON.stringify(j) });
  const m = opt.method || 'GET';
  if (u === '/contents/queue') return ok([{ name: '003_batch', type: 'dir', sha: 'b' }, { name: '004_flat', type: 'dir', sha: 'f' }]);
  if (m === 'GET' && u.startsWith('/git/trees/')) {
    const sha = u.split('/').pop();
    if (url.includes('recursive')) return ok({ tree: (flat(sha) || []).map((p) => ({ path: p, type: 'blob' })) });
    return ok({ tree: trees[sha === 'base' ? 'root' : sha] });
  }
  if (u === '/git/ref/heads/main') return ok({ object: { sha: 'head' } });
  if (u === '/git/commits/head') return ok({ tree: { sha: 'base' } });
  if (u === '/git/trees' && m === 'POST') { created = body; return ok({ sha: 'newtree' }); }
  if (u === '/git/commits' && m === 'POST') return ok({ sha: 'newcommit' });
  if (m === 'PATCH') {
    patches++;
    if (conflict-- > 0) return { ok: false, status: 422, statusText: 'x', json: async () => ({ message: 'not fast forward' }) };
    return ok({});
  }
  throw new Error('unexpected ' + m + ' ' + url);
};

(async () => {
  const g = new GitHub('t', 'o/r');
  assert.deepStrictEqual(await g.queue(), [
    { name: '003_batch', tiktok: [], videos: ['dayzerorules/short-1.mp4', 'rulezerosurvivel/short-1.mp4'] },
    { name: '004_flat', tiktok: [], videos: ['a.mp4'] },
  ]);
  trees.root[0].sha = 'q';
  // 'base' tree = root
  const n = await g.deleteFolder('003_batch');
  assert.strictEqual(n, 3);
  assert.strictEqual(patches, 2); // первый коммит отклонён (автопостер успел), второй принят
  assert.deepStrictEqual(created.tree.map((e) => [e.path, e.sha]), [
    ['queue/003_batch/dayzerorules/short-1.mp4', null], ['queue/003_batch/dayzerorules/short-1.txt', null],
    ['queue/003_batch/rulezerosurvivel/short-1.mp4', null]]);
  await assert.rejects(() => g.deleteFolder('../state.json'), /Недопустимое/);
  await assert.rejects(() => g.deleteFolder('nope'), /нет в очереди/);
  console.log('ok github');
})().catch((e) => { console.error(e); process.exit(1); });
