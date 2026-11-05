'use strict';
// Выходная папка под автозалив (формат автопостера, см. README репозитория):
//   <очередь>/NNN_slug/                     ← одна папка = один день
//     texts.json                            ← комментарий, хвост, хэштеги для всех роликов папки
//     <аккаунт>/short-1-slug.mp4 + .txt + cover-1.jpg   ← у каждого аккаунта свои ролики
// При одном канале — без подпапок (плоская папка: ролик уходит во все аккаунты автопостера).

const fs = require('fs');
const path = require('path');
const { ensureTags } = require('./rules');

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/** Латиница для имени файла: обложка уходит в Instagram по ссылке raw.githubusercontent, кириллица там лишняя. */
function slugify(s, max = 32) {
  const t = String(s || '').toLowerCase().split('').map((c) => (c in TR ? TR[c] : c)).join('')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (t.slice(0, max).replace(/-+$/g, '') || 'clip');
}

/** Номер следующей папки NNN по уже существующим именам (в очереди и в posted). */
function nextFolderNumber(names) {
  let max = 0;
  for (const n of names || []) {
    const m = /^(\d{1,4})[_-]/.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}

/** Имя аккаунта для подпапки: без @ и пробелов. */
const accountDir = (name, i) => String(name || '').trim().replace(/^@+/, '').replace(/[\\/:*?"<>|\s]+/g, '_') || `channel${i + 1}`;

function section(name, body) {
  const b = String(body || '').trim();
  return b ? `${name}:\n${b}\n` : '';
}

/**
 * .txt ролика в формате автопостера.
 * t: title, description, tags (строка или массив), pinned, comment, captionInstagram, captionTiktok, cover.
 */
function buildTxt(t) {
  const tags = Array.isArray(t.tags) ? t.tags.join(', ') : t.tags;
  const parts = [
    section('TITLE', t.title),
    section('DESCRIPTION', t.description),
    section('TAGS', tags),
    section('PINNED COMMENT', t.pinned),
    section('COMMENT', t.comment),
    section('REELS CAPTION (Instagram)', t.captionInstagram),
    section('REELS CAPTION (TikTok)', t.captionTiktok),
  ].filter(Boolean);
  if (t.cover) parts.push(`COVER: ${t.cover}\n`);
  return parts.join('\n');
}

/** Подпись из шаблона: {title}, {hashtags}, {source}, {channel}. */
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)).replace(/\n{3,}/g, '\n\n').trim();
}

/** texts.json папки: только ключи, которые понимает автопостер. */
function buildTextsJson(s) {
  const out = {};
  const pick = (src) => {
    const o = {};
    for (const k of ['caption', 'footer', 'hashtags', 'comment', 'use_pinned_comment']) {
      if (src && src[k] !== undefined && src[k] !== '' && src[k] !== null) o[k] = src[k];
    }
    return o;
  };
  Object.assign(out, pick(s));
  for (const net of ['instagram', 'tiktok']) {
    const o = pick(s && s[net]);
    if (Object.keys(o).length) out[net] = o;
  }
  return out;
}

/**
 * Разложить план по файлам (без записи на диск).
 * o: root (папка очереди), number, name, channels [{name}], plan (из planChannels), texts (настройки текстов),
 *    meta(moment) → {title, description, tags, comment}.
 * Возвращает { folder, files: [{channel, dir, base, video, txt, cover, txtBody, item}] , textsJson }.
 */
function layoutOutput(o) {
  const folder = path.join(o.root, `${o.number}_${slugify(o.name, 40)}`);
  const flat = (o.channels || []).length <= 1;
  const files = [];
  const s = o.texts || {};
  for (const ch of o.plan) {
    const chInfo = (o.channels || [])[ch.channel] || {};
    const dir = flat ? folder : path.join(folder, accountDir(chInfo.name, ch.channel));
    ch.items.forEach((item, i) => {
      const n = i + 1;
      const meta = (o.meta ? o.meta(item.moment, ch.channel) : null) || {};
      // title — то, что на экране (может быть пустым: тогда без заголовка), textTitle — для подписей и TITLE
      const title = String(meta.title || item.moment.title || '').trim();
      const textTitle = title || s.defaultTitle || `Момент ${n}`;
      const base = `short-${n}-${slugify(title || 'moment', 28)}`;
      const vars = { title: textTitle.replace(/\s*\|\s*/g, ' '), hashtags: meta.hashtags || s.hashtags || '', source: s.source || '', channel: chInfo.name || '' };
      const cover = `cover-${n}.jpg`;
      const tag = (t, short) => (o.rules ? ensureTags(t, o.rules, { short }) : t);
      files.push({
        channel: ch.channel, dir, base, item, title,
        video: path.join(dir, `${base}.mp4`), txt: path.join(dir, `${base}.txt`), cover: path.join(dir, cover),
        txtBody: buildTxt({
          title: tag(vars.title, true),
          description: meta.description || '',
          tags: meta.tags || '',
          comment: meta.comment || '',
          captionInstagram: tag(fillTemplate(chInfo.captionInstagram || s.captionInstagram || '{title}\n\n{hashtags}', vars)),
          captionTiktok: tag(fillTemplate(chInfo.captionTiktok || s.captionTiktok || '{title} {hashtags}', vars), true),
          cover,
        }),
      });
    });
  }
  return { folder, flat, files, textsJson: buildTextsJson({ comment: s.comment, footer: s.footer, instagram: s.instagram, tiktok: s.tiktok }) };
}

/** Записать .txt и texts.json (видео и обложки пишет рендер). */
function writeTexts(out) {
  fs.mkdirSync(out.folder, { recursive: true });
  if (Object.keys(out.textsJson).length) fs.writeFileSync(path.join(out.folder, 'texts.json'), JSON.stringify(out.textsJson, null, 2) + '\n');
  for (const f of out.files) {
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(f.txt, f.txtBody);
  }
}

/** Проверка готовой папки так же, как её увидит автопостер: у каждого mp4 есть .txt и cover. */
function checkFolder(folder) {
  const problems = [];
  let videos = 0;
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth === 0) walk(p, 1);
      else if (e.isFile() && /\.mp4$/i.test(e.name)) {
        videos++;
        const base = p.slice(0, -4);
        if (!fs.existsSync(base + '.txt')) problems.push(`${path.relative(folder, p)}: нет .txt`);
        const num = (/\d+/.exec(e.name) || [''])[0];
        if (!fs.existsSync(path.join(d, `cover-${num}.jpg`))) problems.push(`${path.relative(folder, p)}: нет cover-${num}.jpg`);
      }
    }
  };
  walk(folder, 0);
  return { videos, problems };
}

module.exports = { slugify, nextFolderNumber, accountDir, buildTxt, fillTemplate, buildTextsJson, layoutOutput, writeTexts, checkFolder };
