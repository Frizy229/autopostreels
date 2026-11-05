'use strict';
// Работа с GitHub через REST API: чтение очереди и загрузка папки одним коммитом.
const fs = require('fs');
const path = require('path');
const { slug, inspectFolder, VIDEO_EXT } = require('./core');
const { push } = require('./gitpush');

const API = 'https://api.github.com';

class GitHub {
  constructor(token, repo, branch = 'main') {
    this.token = token; this.repo = repo; this.branch = branch;
  }

  async req(method, url, body, raw = false) {
    let last;
    for (let i = 0; i < 4; i++) {
      try { return await this.req1(method, url, body, raw); } catch (e) {
        last = e;
        if (e.status && e.status < 500) throw e; // повторяем только сбои сервера и сети
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw last;
  }

  async req1(method, url, body, raw = false) {
    const res = await fetch(`${API}/repos/${this.repo}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'User-Agent': 'reels-widget',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message; } catch { /* ignore */ }
      const e = new Error(`GitHub ${res.status}: ${msg || res.statusText} (${method} ${url.split('?')[0]})`);
      e.status = res.status;
      throw e;
    }
    if (res.status === 204) return {};
    return raw ? res.text() : res.json();
  }

  async listDir(p) {
    const r = await this.req('GET', `/contents/${p}?ref=${encodeURIComponent(this.branch)}`);
    return Array.isArray(r) ? r : [];
  }

  async readJson(p) {
    const t = await this.req('GET', `/contents/${p}?ref=${encodeURIComponent(this.branch)}`, null, true);
    if (!t) return {};
    try { return JSON.parse(t); } catch { return {}; }
  }

  async check() {
    const r = await this.req('GET', '');
    if (!r) throw new Error('Репозиторий не найден или у токена нет к нему доступа.');
    if (!(r.permissions && r.permissions.push)) throw new Error('У токена нет права записи (Contents: Read and write).');
    return r.full_name;
  }

  /** Очередь: папки в queue/ и видео в каждой (в подпапках по аккаунтам: «аккаунт/файл.mp4»). */
  async queue() {
    const dirs = (await this.listDir('queue')).filter((d) => d.type === 'dir');
    return Promise.all(dirs.map(async (d) => {
      const t = await this.req('GET', `/git/trees/${d.sha}?recursive=1`);
      const items = ((t && t.tree) || []).filter((e) => e.type === 'blob' && e.path.split('/').length <= 2
        && VIDEO_EXT.has(path.extname(e.path).toLowerCase()) && !e.path.split('/').some((x) => x.startsWith('.')));
      return { name: d.name, videos: items.map((e) => e.path).sort() };
    }));
  }

  async nextNumber() {
    let max = 0;
    for (const dir of ['queue', 'posted']) {
      for (const d of await this.listDir(dir)) {
        const m = /^(\d+)/.exec(d.name);
        if (d.type === 'dir' && m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
    return max + 1;
  }

  async blob(buf) {
    const r = await this.req('POST', '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' });
    return r.sha;
  }

  async commitFiles(files, message) {
    for (let i = 0; i < 5; i++) {
      const ref = await this.req('GET', `/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const base = (await this.req('GET', `/git/commits/${head}`)).tree.sha;
      const tree = (await this.req('POST', '/git/trees', {
        base_tree: base,
        tree: Object.entries(files).map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha })),
      })).sha;
      const commit = (await this.req('POST', '/git/commits', { message, tree, parents: [head] })).sha;
      try {
        await this.req('PATCH', `/git/refs/heads/${this.branch}`, { sha: commit, force: false });
        return commit;
      } catch (e) {
        if (e.status !== 422) throw e; // кто-то успел закоммитить: повторяем
      }
    }
    throw new Error('Не удалось записать коммит: репозиторий постоянно меняется, попробуй ещё раз.');
  }

  /** Загрузить папку в queue/NNN_имя одним коммитом. progress(доля, текст). */
  async uploadFolder(dir, progress = () => {}, accounts = []) {
    const info = inspectFolder(dir, accounts);
    if (info.errors.length) throw new Error(info.errors.join(' '));
    const name = `${String(await this.nextNumber()).padStart(3, '0')}_${slug(path.basename(dir))}`;
    const files = {};
    let done = 0;
    const total = Math.max(info.size, 1);
    for (const f of info.files) {
      const size = fs.statSync(f).size;
      const rel = path.relative(dir, f).split(path.sep).join('/');
      progress(0.3 * done / total, `Читаю ${rel} (${(size / 1e6).toFixed(1)} МБ)`);
      files[`queue/${name}/${rel}`] = fs.readFileSync(f);
      done += size;
    }
    progress(0.4, `Отправляю на GitHub: ${(info.size / 1e6).toFixed(0)} МБ, это может занять несколько минут…`);
    await push({
      repo: this.repo, token: this.token, branch: this.branch, files,
      message: `Новая папка рилсов: ${name} (${info.videos} видео)`,
      getHeadTree: async (commit) => (await this.req('GET', `/git/commits/${commit}`)).tree.sha,
      getTree: async (sha) => (await this.req('GET', `/git/trees/${sha}`)).tree.map((e) => ({
        mode: e.mode === '040000' ? '40000' : e.mode, name: e.path, sha: e.sha })),
    });
    progress(1, 'Готово');
    return name;
  }

  /** Убрать папку из очереди одним коммитом (файлы удаляются из репозитория; в истории git они остаются). */
  async deleteFolder(name) {
    if (!name || /[\\/]/.test(name) || name.startsWith('.') || name.includes('..')) throw new Error('Недопустимое имя папки.');
    for (let i = 0; i < 5; i++) {
      const ref = await this.req('GET', `/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const base = (await this.req('GET', `/git/commits/${head}`)).tree.sha;
      const root = (await this.req('GET', `/git/trees/${base}`)).tree;
      const q = root.find((e) => e.path === 'queue' && e.type === 'tree');
      const dir = q && (await this.req('GET', `/git/trees/${q.sha}`)).tree.find((e) => e.path === name && e.type === 'tree');
      if (!dir) throw new Error(`Папки ${name} нет в очереди (возможно, её уже удалили или она опубликована).`);
      const all = (await this.req('GET', `/git/trees/${dir.sha}?recursive=1`)).tree.filter((e) => e.type === 'blob');
      if (!all.length) throw new Error(`Папка ${name} пустая.`);
      const tree = (await this.req('POST', '/git/trees', {
        base_tree: base,
        tree: all.map((e) => ({ path: `queue/${name}/${e.path}`, mode: '100644', type: 'blob', sha: null })),
      })).sha;
      const commit = (await this.req('POST', '/git/commits', { message: `Убрана из очереди: ${name}`, tree, parents: [head] })).sha;
      try {
        await this.req('PATCH', `/git/refs/heads/${this.branch}`, { sha: commit, force: false });
        return all.length;
      } catch (e) {
        if (e.status !== 422) throw e; // автопостер успел закоммитить своё: повторяем
      }
    }
    throw new Error('Не удалось удалить: репозиторий постоянно меняется, попробуй ещё раз.');
  }
}

module.exports = { GitHub };
