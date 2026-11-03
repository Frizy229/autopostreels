'use strict';
// Отправка файлов в репозиторий протоколом git (smart HTTP, receive-pack).
// Нужна для больших видео: REST API отвечает 422 "input too large" уже на ~50-70 МБ.
const crypto = require('crypto');
const zlib = require('zlib');

const sha1 = (...bufs) => { const h = crypto.createHash('sha1'); bufs.forEach((b) => h.update(b)); return h.digest(); };
const objId = (type, body) => sha1(Buffer.from(`${type} ${body.length}\0`), body);
const pkt = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };

function treeBody(entries) {
  // entries: [{ mode: '100644'|'40000', name, sha: Buffer(20) }], git сортирует папки как "имя/"
  const key = (e) => (e.mode === '40000' ? e.name + '/' : e.name);
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  return Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), e.sha])));
}

function packHeader(type, size) {
  const t = { commit: 1, tree: 2, blob: 3 }[type];
  const bytes = [];
  let first = (t << 4) | (size & 15);
  size = Math.floor(size / 16);
  while (size > 0) { bytes.push(first | 0x80); first = size & 127; size = Math.floor(size / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(objects) {
  const head = Buffer.alloc(12); head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(objects.length, 8);
  const parts = [head];
  for (const o of objects) {
    parts.push(packHeader(o.type, o.body.length), zlib.deflateSync(o.body, { level: o.type === 'blob' ? 1 : 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1(body)]);
}

/**
 * Собрать объекты для добавления файлов в дерево.
 * files: { 'queue/001_x/a.mp4': Buffer }; getTree(sha|null) -> [{mode,name,sha(hex)}] для существующих деревьев;
 * baseTreeSha: дерево текущего коммита.
 */
async function planCommit({ files, baseTreeSha, parent, message, getTree, now = new Date() }) {
  const objects = [];
  const tree = {}; // вложенная структура
  for (const [p, data] of Object.entries(files)) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    objects.push({ type: 'blob', body });
    const parts = p.split('/');
    let node = tree;
    parts.slice(0, -1).forEach((d) => { node = node[d] = node[d] || {}; });
    node[parts.at(-1)] = objId('blob', body);
  }
  async function build(node, existingSha) {
    const existing = existingSha ? await getTree(existingSha) : [];
    const entries = new Map(existing.map((e) => [e.name, { mode: e.mode, name: e.name, sha: Buffer.from(e.sha, 'hex') }]));
    for (const [name, val] of Object.entries(node)) {
      if (Buffer.isBuffer(val)) { entries.set(name, { mode: '100644', name, sha: val }); continue; }
      const prev = entries.get(name);
      const sub = await build(val, prev && prev.mode === '40000' ? prev.sha.toString('hex') : null);
      entries.set(name, { mode: '40000', name, sha: sub });
    }
    const body = treeBody([...entries.values()]);
    objects.push({ type: 'tree', body });
    return objId('tree', body);
  }
  const rootSha = await build(tree, baseTreeSha);
  const ts = Math.floor(now.getTime() / 1000);
  const who = `Reels Widget <widget@users.noreply.github.com> ${ts} +0000`;
  const commitBody = Buffer.from(`tree ${rootSha.toString('hex')}\n${parent ? `parent ${parent}\n` : ''}author ${who}\ncommitter ${who}\n\n${message}\n`);
  objects.push({ type: 'commit', body: commitBody });
  return { objects, commit: objId('commit', commitBody).toString('hex') };
}

function parseAdvert(buf, ref) {
  // ответ: pkt "# service=..." flush, затем строки "sha ref\0caps"
  let i = 0; let sha = null;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.slice(i, i + 4).toString(), 16);
    if (len === 0) { i += 4; continue; }
    const line = buf.slice(i + 4, i + len).toString().split('\0')[0].trim();
    i += len;
    const m = /^([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m && m[2] === ref) sha = m[1];
  }
  return sha;
}

/** Отправить коммит. Возвращает sha. */
async function push({ repo, token, branch, files, message, getTree, getHeadTree, host = 'https://github.com', progress = () => {} }) {
  const auth = 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
  const headers = { Authorization: auth, 'User-Agent': 'reels-widget' };
  const ref = `refs/heads/${branch}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const adv = await fetch(`${host}/${repo}.git/info/refs?service=git-receive-pack`, { headers });
    if (adv.status === 401 || adv.status === 403) throw new Error('GitHub не принял токен для записи (нужно право Contents: Read and write).');
    if (!adv.ok) throw new Error(`GitHub ${adv.status} при подключении к репозиторию.`);
    const old = parseAdvert(Buffer.from(await adv.arrayBuffer()), ref);
    if (!old) throw new Error(`Ветка ${branch} не найдена в репозитории.`);
    const baseTreeSha = await getHeadTree(old);
    const { objects, commit } = await planCommit({ files, baseTreeSha, parent: old, message, getTree });
    progress('pack');
    const pack = buildPack(objects);
    const cmd = pkt(`${old} ${commit} ${ref}\0 report-status agent=reels-widget`);
    const body = Buffer.concat([cmd, Buffer.from('0000'), pack]);
    const res = await fetch(`${host}/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' },
      body,
    });
    const out = Buffer.from(await res.arrayBuffer()).toString('latin1');
    if (res.status === 401 || res.status === 403) throw new Error('GitHub не принял токен для записи (нужно право Contents: Read and write).');
    if (!res.ok) throw new Error(`GitHub ${res.status} при отправке файлов. ${out.slice(0, 200)}`);
    if (/unpack ok/.test(out) && new RegExp(`ok ${ref}`).test(out)) return commit;
    if (/ng /.test(out) && attempt < 3 && /stale|fast-forward|lock|changed/i.test(out)) continue; // ветка сдвинулась
    throw new Error('Отправка отклонена: ' + out.replace(/[\x00-\x1f]+/g, ' ').slice(0, 300));
  }
  throw new Error('Не удалось отправить: репозиторий постоянно меняется, попробуй ещё раз.');
}

module.exports = { push, planCommit, buildPack, objId, treeBody };
