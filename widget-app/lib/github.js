'use strict';
// Работа с GitHub через REST API: чтение очереди и загрузка папки одним коммитом.
const fs = require('fs');
const path = require('path');
const { slug, inspectFolder, cleanTexts, LANES, laneByKey, groupLanes, GROUPS_DIR, VIDEO_EXT, REMOTE_SUFFIX, videoOfPath } = require('./core');
const MEDIA_TAG = 'media'; // релиз-хранилище видео очереди
const { push, splitBatches, explainPushError } = require('./gitpush');
const { seal } = require('./secrets');

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
    if (raw) return res.text();
    // 201 без тела (например, новый секрет Actions): пустой ответ = успех, а не сбой сети с повтором
    if (typeof res.text !== 'function') return res.json();
    const text = await res.text();
    return text ? JSON.parse(text) : {};
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

  /** Все очереди группы: {shared, instagram, tiktok}. group '' = группа по умолчанию (queue/, queue-instagram/, …). */
  async queues(group = '') {
    const out = {};
    await Promise.all(groupLanes(group).map(async (l) => { out[l.key] = await this.queue(l.dir); }));
    return out;
  }

  /** Очередь: папки в queue/ и видео в каждой (в подпапках по аккаунтам: «аккаунт/файл.mp4»). */
  async queue(dir = 'queue') {
    const dirs = (await this.listDir(dir)).filter((d) => d.type === 'dir' && !d.name.startsWith('.'));
    return Promise.all(dirs.map(async (d) => {
      const t = await this.req('GET', `/git/trees/${d.sha}?recursive=1`);
      // видео: файлы и описания видео из хранилища (a.mp4.remote.json → a.mp4)
      const items = ((t && t.tree) || []).filter((e) => e.type === 'blob' && e.path.split('/').length <= 2
        && videoOfPath(e.path) && !e.path.split('/').some((x) => x.startsWith('.')));
      const tiktok = ((t && t.tree) || []).filter((e) => e.type === 'blob' && e.path.endsWith('.tiktok.json')).map((e) => e.path);
      const out = { name: d.name, videos: [...new Set(items.map((e) => videoOfPath(e.path)))].sort(), tiktok };
      if (((t && t.tree) || []).some((e) => e.type === 'blob' && e.path === 'texts.json')) out.texts = true;
      return out;
    }));
  }

  /** Записать подтверждённые настройки TikTok (<имя>.tiktok.json рядом с видео) одним коммитом. */
  async saveTiktokSettings(path, settings) {
    if (!/^(?:groups\/[a-z0-9][a-z0-9_-]*\/)?queue(?:-tiktok)?\/[^/]+\/(?:[^/]+\/)?[^/]+\.tiktok\.json$/.test(path) || path.includes('..')) throw new Error('Недопустимый путь.');
    const sha = await this.blob(Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf8'));
    return this.commitFiles({ [path]: sha }, `Настройки TikTok подтверждены: ${path.split('/').slice(1).join('/')}`);
  }

  /** Скачать видео из очереди или из опубликованных (posted…): просмотр перед публикацией, лучший ролик из «Сводки». */
  async downloadVideo(rel, dest) {
    if (!/^(?:groups\/[a-z0-9][a-z0-9_-]*\/)?(?:queue|posted)(?:-instagram|-tiktok)?\/[^./]/.test(rel) || rel.includes('..')) throw new Error('Недопустимый путь.');
    const res = await fetch(`${API}/repos/${this.repo}/contents/${rel.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'reels-widget' },
    });
    if (res.status === 404) {
      // видео в хранилище: качаем файл релиза по описанию <видео>.remote.json
      const stub = await this.readText(rel + REMOTE_SUFFIX);
      const info = stub ? JSON.parse(stub) : null;
      if (!info || !info.asset_id) throw new Error('Видео нет ни в очереди, ни в хранилище.');
      if (info.deleted) throw new Error(`Видео уже удалено из хранилища (${info.deleted}).`);
      const r2 = await fetch(`${API}/repos/${this.repo}/releases/assets/${info.asset_id}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/octet-stream', 'User-Agent': 'reels-widget' },
      });
      if (!r2.ok) throw new Error(`Не удалось скачать видео из хранилища: GitHub ${r2.status}`);
      fs.writeFileSync(dest, Buffer.from(await r2.arrayBuffer()));
      return dest;
    }
    if (!res.ok) throw new Error(`Не удалось скачать видео: GitHub ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  }

  /** Релиз-хранилище видео (создаётся при первой загрузке). Видео там не попадают в историю git. */
  async mediaRelease() {
    if (this._media) return this._media;
    let r = await this.req('GET', `/releases/tags/${MEDIA_TAG}`);
    if (!r) {
      r = await this.req('POST', '/releases', {
        tag_name: MEDIA_TAG, target_commitish: this.branch, name: 'Хранилище видео очереди', prerelease: true,
        body: 'Видео, загруженные виджетом в очередь автопостера. Не трогай вручную: автопостер сам удаляет их через 2 дня после публикации.',
      });
    }
    this._media = r;
    return r;
  }

  /** Загрузить файл в релиз-хранилище. Возвращает описание для <видео>.remote.json. */
  async uploadAsset(name, buf) {
    const rel = await this.mediaRelease();
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`https://uploads.github.com/repos/${this.repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream', Accept: 'application/vnd.github+json', 'User-Agent': 'reels-widget' },
          body: buf,
        });
        if (!res.ok) {
          let msg = ''; try { msg = (await res.json()).message; } catch { /* ignore */ }
          const e = new Error(`GitHub ${res.status}: ${msg || res.statusText} (загрузка видео в хранилище)`); e.status = res.status; throw e;
        }
        const a = await res.json();
        return { asset_id: a.id, name: a.name, size: a.size, url: a.browser_download_url, repo: this.repo };
      } catch (e) {
        last = e;
        if (e.status && e.status < 500) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    throw last;
  }

  /** Удалить файлы хранилища по описаниям .remote.json (404 = уже нет). */
  async deleteAssets(ids) {
    let n = 0;
    for (const id of ids) {
      try { await this.req('DELETE', `/releases/assets/${id}`); n++; } catch (e) { if (e.status !== 404) throw e; }
    }
    return n;
  }

  async nextNumber(group = '') {
    let max = 0;
    for (const dir of groupLanes(group).flatMap((l) => [l.dir, l.posted])) {
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
        tree: Object.entries(files).map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha: sha || null })),
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

  /**
   * Загрузить папку в <очередь>/NNN_имя одним коммитом. progress(доля, текст).
   * opts.lane: shared | instagram | tiktok; opts.group: id группы ('' = по умолчанию); opts.texts: тексты папки (texts.json).
   */
  async uploadFolder(dir, progress = () => {}, accounts = [], opts = {}) {
    // видео в релиз-хранилище (по умолчанию) или, как раньше, прямо в git (opts.storage = 'git')
    let remote = opts.storage !== 'git';
    if (remote) {
      try { await this.mediaRelease(); } catch (e) {
        if (!e.status || e.status >= 500) throw e;
        remote = false; // нет права создать релиз: грузим по-старому, в git
        progress(0, 'Хранилище недоступно (нужно право Contents: Read and write), видео пойдут в git');
      }
    }
    const info = inspectFolder(dir, accounts, { remote });
    if (info.errors.length) throw new Error(info.errors.join(' '));
    const lane = laneByKey(opts.lane || 'shared', opts.group || '');
    const name = `${String(await this.nextNumber(opts.group || '')).padStart(3, '0')}_${slug(path.basename(dir))}`;
    const files = {};
    const texts = cleanTexts(opts.texts);
    let done = 0;
    const total = Math.max(info.size, 1);
    for (const f of info.files) {
      const size = fs.statSync(f).size;
      const rel = path.relative(dir, f).split(path.sep).join('/');
      if (remote && VIDEO_EXT.has(path.extname(f).toLowerCase())) {
        progress(0.9 * done / total, `Загружаю в хранилище ${rel} (${(size / 1e6).toFixed(1)} МБ)`);
        const asset = `${Date.now().toString(36)}-${`${lane.dir}/${name}/${rel}`.replace(/[^A-Za-z0-9._-]+/g, '_')}`.slice(0, 200);
        const stub = await this.uploadAsset(asset, fs.readFileSync(f));
        files[`${lane.dir}/${name}/${rel}${REMOTE_SUFFIX}`] = Buffer.from(JSON.stringify(stub, null, 2) + '\n', 'utf8');
      } else {
        progress((remote ? 0.9 : 0.3) * done / total, `Читаю ${rel} (${(size / 1e6).toFixed(1)} МБ)`);
        files[`${lane.dir}/${name}/${rel}`] = fs.readFileSync(f);
      }
      done += size;
    }
    if (Object.keys(texts).length) files[`${lane.dir}/${name}/texts.json`] = Buffer.from(JSON.stringify(texts, null, 2) + '\n', 'utf8');
    progress(remote ? 0.92 : 0.4, remote ? 'Записываю папку в очередь…' : `Отправляю на GitHub: ${(info.size / 1e6).toFixed(0)} МБ, это может занять несколько минут…`);
    await this.pushBatches(files, `Новая папка рилсов: ${lane.dir}/${name}`, info.videos, progress, remote ? 0.92 : 0.4);
    progress(1, 'Готово');
    return `${lane.dir}/${name}`;
  }

  /**
   * Отправить файлы порциями (каждая — отдельный коммит), каждую порцию повторять при сбое;
   * если GitHub отклонил порцию, делить её пополам. Мелкие файлы (тексты) идут последними.
   */
  async pushBatches(files, title, videos, progress = () => {}, from = 0.4) {
    const batches = splitBatches(files, this.batchBytes || 40e6, this.batchFiles || 6);
    const queue = [...batches];
    const totalBytes = Math.max(Object.values(files).reduce((a, b) => a + b.length, 0), 1);
    let sent = 0; let part = 0; const parts = () => part + queue.length;
    while (queue.length) {
      const batch = queue.shift();
      const keys = Object.keys(batch);
      const bytes = keys.reduce((a, k) => a + batch[k].length, 0);
      part++;
      progress(from + (1 - from) * 0.95 * sent / totalBytes, `Отправляю на GitHub: часть ${part} из ${parts()}, ${(bytes / 1e6).toFixed(0)} МБ`);
      let err = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await (this.pushFn || push)({
            repo: this.repo, token: this.token, branch: this.branch, files: batch,
            message: `${title} (${videos} видео, часть ${part})`,
            getHeadTree: async (commit) => (await this.req('GET', `/git/commits/${commit}`)).tree.sha,
            getTree: async (sha) => (await this.req('GET', `/git/trees/${sha}`)).tree.map((e) => ({
              mode: e.mode === '040000' ? '40000' : e.mode, name: e.path, sha: e.sha })),
          });
          err = null; break;
        } catch (e) {
          err = e;
          if (/не принял токен|не найдена/.test(e.message)) throw e; // повтор не поможет
          await new Promise((r) => setTimeout(r, (this.retryMs ?? 2000) * (attempt + 1)));
        }
      }
      if (err) {
        if (keys.length > 1) { // слишком большая порция: делим пополам и пробуем снова
          const half = Math.ceil(keys.length / 2);
          const a = {}; const b = {};
          keys.forEach((k, i) => { (i < half ? a : b)[k] = batch[k]; });
          queue.unshift(a, b); part--; continue;
        }
        const e = new Error(`${explainPushError(err.message)} (файл ${keys[0]}, ${(bytes / 1e6).toFixed(0)} МБ; часть ${part}, уже отправлено ${sent ? (sent / 1e6).toFixed(0) + ' МБ' : 'ничего'})`);
        e.cause = err; throw e;
      }
      sent += bytes;
    }
  }

  /** Убрать папку из очереди одним коммитом (файлы удаляются из репозитория; в истории git они остаются). */
  async deleteFolder(name, laneKey = 'shared', group = '') {
    if (!name || /[\\/]/.test(name) || name.startsWith('.') || name.includes('..')) throw new Error('Недопустимое имя папки.');
    const qdir = laneByKey(laneKey, group).dir;
    for (let i = 0; i < 5; i++) {
      const ref = await this.req('GET', `/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const base = (await this.req('GET', `/git/commits/${head}`)).tree.sha;
      // очередь может лежать глубже (groups/<id>/queue): идём по частям пути
      let q = { sha: base };
      for (const part of qdir.split('/')) {
        q = q && ((await this.req('GET', `/git/trees/${q.sha}`)).tree || []).find((e) => e.path === part && e.type === 'tree');
      }
      const dir = q && (await this.req('GET', `/git/trees/${q.sha}`)).tree.find((e) => e.path === name && e.type === 'tree');
      if (!dir) throw new Error(`Папки ${name} нет в очереди (возможно, её уже удалили или она опубликована).`);
      const all = (await this.req('GET', `/git/trees/${dir.sha}?recursive=1`)).tree.filter((e) => e.type === 'blob');
      if (!all.length) throw new Error(`Папка ${name} пустая.`);
      if (i === 0) {
        // видео из хранилища: удаляем и сами файлы релиза
        const ids = [];
        for (const e of all.filter((x) => x.path.endsWith(REMOTE_SUFFIX))) {
          try {
            const b = await this.req('GET', `/git/blobs/${e.sha}`);
            const j = JSON.parse(Buffer.from(b.content || '', 'base64').toString('utf8'));
            if (j.asset_id && !j.deleted) ids.push(j.asset_id);
          } catch { /* битое описание: просто убираем из очереди */ }
        }
        if (ids.length) await this.deleteAssets(ids);
      }
      const tree = (await this.req('POST', '/git/trees', {
        base_tree: base,
        tree: all.map((e) => ({ path: `${qdir}/${name}/${e.path}`, mode: '100644', type: 'blob', sha: null })),
      })).sha;
      const commit = (await this.req('POST', '/git/commits', { message: `Убрана из очереди: ${qdir}/${name}`, tree, parents: [head] })).sha;
      try {
        await this.req('PATCH', `/git/refs/heads/${this.branch}`, { sha: commit, force: false });
        return all.length;
      } catch (e) {
        if (e.status !== 422) throw e; // автопостер успел закоммитить своё: повторяем
      }
    }
    throw new Error('Не удалось удалить: репозиторий постоянно меняется, попробуй ещё раз.');
  }

  async readText(p) {
    const t = await this.req('GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`, null, true);
    return t == null ? null : String(t).replace(/^\uFEFF/, '');
  }

  /** Тексты папки (texts.json). */
  async folderTexts(laneKey, name, group = '') {
    if (!name || /[\\/]/.test(name) || name.includes('..')) throw new Error('Недопустимое имя папки.');
    const t = await this.readText(`${laneByKey(laneKey, group).dir}/${name}/texts.json`);
    try { return t ? JSON.parse(t) : {}; } catch { return {}; }
  }

  /** Записать тексты папки; пустые тексты удаляют texts.json. */
  async saveFolderTexts(laneKey, name, texts, group = '') {
    if (!name || /[\\/]/.test(name) || name.includes('..')) throw new Error('Недопустимое имя папки.');
    const p = `${laneByKey(laneKey, group).dir}/${name}/texts.json`;
    const clean = cleanTexts(texts);
    if (!Object.keys(clean).length) {
      if ((await this.readText(p)) == null) return null;
      return this.commitFiles({ [p]: null }, `Тексты папки сброшены: ${p}`);
    }
    const sha = await this.blob(Buffer.from(JSON.stringify(clean, null, 2) + '\n', 'utf8'));
    return this.commitFiles({ [p]: sha }, `Тексты папки: ${p}`);
  }

  /** Изменить config.json репозитория: fn(конфиг) меняет объект на месте. Читаем свежую версию прямо перед записью. */
  async updateConfig(fn, message) {
    const t = await this.readText('config.json');
    if (t == null) throw new Error('В репозитории нет config.json.');
    const cfg = JSON.parse(t);
    fn(cfg);
    const sha = await this.blob(Buffer.from(JSON.stringify(cfg, null, 2) + '\n', 'utf8'));
    await this.commitFiles({ 'config.json': sha }, message);
    return cfg;
  }

  // ---------------------------------------------------------------- секреты Actions (нужно право токена Secrets)
  secretsError(e) {
    if (e.status === 403 || e.status === 404) {
      return Object.assign(new Error('Токену GitHub не хватает права Secrets: Read and write (github.com/settings/tokens → токен виджета → Repository permissions → Secrets).'), { code: 'NO_SECRETS' });
    }
    return e;
  }

  /** Имена секретов репозитория (значения GitHub не отдаёт никому). Без права: null. */
  async secretNames() {
    try {
      const names = [];
      for (let page = 1; page < 10; page++) {
        const r = await this.req('GET', `/actions/secrets?per_page=100&page=${page}`);
        if (!r) return null;
        names.push(...(r.secrets || []).map((x) => x.name));
        if ((r.secrets || []).length < 100) break;
      }
      return names;
    } catch (e) {
      if (e.status === 403 || e.status === 404) return null;
      throw e;
    }
  }

  /** Записать секрет: значение шифруется открытым ключом репозитория прямо здесь, на GitHub уходит только шифр. */
  async setSecret(name, value) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /^GITHUB_/.test(name)) throw new Error(`Недопустимое имя секрета: ${name}`);
    if (!value) throw new Error(`Пустое значение секрета ${name}.`);
    try {
      const key = await this.req('GET', '/actions/secrets/public-key');
      if (!key) throw Object.assign(new Error('no key'), { status: 404 });
      await this.req('PUT', `/actions/secrets/${name}`, { encrypted_value: seal(key.key, value), key_id: key.key_id });
    } catch (e) { throw this.secretsError(e); }
    return true;
  }

  async deleteSecret(name) {
    try { await this.req('DELETE', `/actions/secrets/${name}`); } catch (e) {
      if (e.status === 404) return false;
      throw this.secretsError(e);
    }
    return true;
  }

  /**
   * Чистый старт копии автопостера (например, у друга): убрать очереди, опубликованное, историю и аккаунты Alex.
   * Секреты не копируются GitHub-ом вообще, их тут нет. Один коммит.
   */
  async resetCopy() {
    const ref = await this.req('GET', `/git/ref/heads/${this.branch}`);
    const head = ref.object.sha;
    const base = (await this.req('GET', `/git/commits/${head}`)).tree.sha;
    const all = (await this.req('GET', `/git/trees/${base}?recursive=1`)).tree.filter((e) => e.type === 'blob');
    const dirs = LANES.flatMap((l) => [l.dir, l.posted]);
    const files = {};
    for (const e of all) {
      const top = e.path.split('/')[0];
      if (dirs.includes(top) && e.path.includes('/') && !e.path.endsWith('/.gitkeep')) files[e.path] = null;
      if (top === GROUPS_DIR) files[e.path] = null; // группы Alex (их очереди и опубликованное) в копии не нужны
    }
    for (const d of dirs) files[`${d}/.gitkeep`] = await this.blob(Buffer.from(''));
    if (all.some((e) => e.path === 'tiktok_creator.json')) files['tiktok_creator.json'] = null;
    files['state.json'] = await this.blob(Buffer.from(JSON.stringify({ posted: {}, skipped: {} }, null, 2) + '\n'));
    files['stats.json'] = await this.blob(Buffer.from('{}\n'));
    const cfgText = await this.readText('config.json');
    const cfg = cfgText ? JSON.parse(cfgText) : {};
    cfg.accounts = []; cfg.paused = []; cfg.groups = [];
    files['config.json'] = await this.blob(Buffer.from(JSON.stringify(cfg, null, 2) + '\n'));
    const removed = Object.values(files).filter((v) => v === null).length;
    await this.commitFiles(files, 'Чистый старт копии автопостера: без чужих аккаунтов и очередей (виджет)');
    return removed;
  }

  /** Последние запуски «Публикация рилсов» (нужно право Actions: Read). Без права: null. */
  async postRuns(n = 10) {
    try {
      const r = await this.req('GET', `/actions/workflows/post.yml/runs?per_page=${n}`);
      return ((r && r.workflow_runs) || []).map((x) => ({ status: x.status, conclusion: x.conclusion, created_at: x.created_at, html_url: x.html_url }));
    } catch (e) {
      if (e.status === 403 || e.status === 404) return null;
      throw e;
    }
  }

  /** Запустить workflow «Публикация рилсов» (нужно право токена Actions: Read and write). */
  async dispatch(inputs = {}) {
    try {
      await this.req('POST', '/actions/workflows/post.yml/dispatches', { ref: this.branch, inputs });
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        throw new Error('Токену GitHub не хватает права Actions: Read and write (добавь его в настройках токена на github.com/settings/tokens).');
      }
      throw e;
    }
    return true;
  }
}

module.exports = { GitHub };
