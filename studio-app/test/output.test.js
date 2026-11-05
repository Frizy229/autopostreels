'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../lib/output');
const { planChannels } = require('../lib/plan');

assert.strictEqual(O.slugify('Контратака хорошая!'), 'kontrataka-horoshaya');
assert.strictEqual(O.slugify('S1mple 1vs5 стримеров'), 's1mple-1vs5-strimerov');
assert.strictEqual(O.slugify('!!!'), 'clip');
assert.ok(O.slugify('очень длинное название которое не влезает в имя файла', 20).length <= 20);
assert.strictEqual(O.nextFolderNumber(['016_Best', '015_x', 'readme', '7_y']), '017');
assert.strictEqual(O.nextFolderNumber([]), '001');
assert.strictEqual(O.accountDir('@evelon185', 0), 'evelon185');
assert.strictEqual(O.accountDir('', 2), 'channel3');

const txt = O.buildTxt({ title: 'T', description: 'D', tags: ['a', 'b'], comment: 'C', captionInstagram: 'IG', captionTiktok: 'TT', cover: 'cover-1.jpg' });
assert.strictEqual(txt, 'TITLE:\nT\n\nDESCRIPTION:\nD\n\nTAGS:\na, b\n\nCOMMENT:\nC\n\nREELS CAPTION (Instagram):\nIG\n\nREELS CAPTION (TikTok):\nTT\n\nCOVER: cover-1.jpg\n');
assert.ok(!O.buildTxt({ title: 'T' }).includes('PINNED'), 'пустые разделы не пишутся');
assert.strictEqual(O.fillTemplate('{title}\n\n\n\n{hashtags} {x}', { title: 'A', hashtags: '#b' }), 'A\n\n#b {x}');
assert.deepStrictEqual(O.buildTextsJson({ comment: 'Полное видео в профиле', footer: '', tiktok: { hashtags: '#fyp' }, instagram: {} }),
  { comment: 'Полное видео в профиле', tiktok: { hashtags: '#fyp' } });

// раскладка папки: 2 канала по 2 ролика, подпапки по аккаунтам, обязательные теги
const ms = [{ id: 'a', score: 3, title: 'Контратака | хорошая', peak: 10 }, { id: 'b', score: 2, title: 'Вы', peak: 20 }];
const plan = planChannels(ms, 2, 2, { formats: ['stream', 'full'] });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const out = O.layoutOutput({ root, number: '017', name: 'Эвелон стрим 05.11', channels: [{ name: '@evelon185' }, { name: 'second' }], plan,
  texts: { captionTiktok: '{title} {hashtags}', hashtags: '#fyp', comment: 'Полное видео в профиле' }, rules: {} });
assert.strictEqual(path.basename(out.folder), '017_evelon-strim-05-11');
assert.strictEqual(out.flat, false);
assert.deepStrictEqual(out.files.map((f) => path.relative(out.folder, f.video)),
  [path.join('evelon185', 'short-1-kontrataka-horoshaya.mp4'), path.join('evelon185', 'short-2-vy.mp4'),
   path.join('second', 'short-1-vy.mp4'), path.join('second', 'short-2-kontrataka-horoshaya.mp4')]);
const t0 = out.files[0].txtBody;
assert.match(t0, /^TITLE:\nКонтратака хорошая twitch: evelone2004 #evelone\n/, 'название с тегами (для Shorts)');
assert.match(t0, /REELS CAPTION \(TikTok\):\nКонтратака хорошая #fyp twitch: evelone2004 #evelone\n/);
assert.match(t0, /REELS CAPTION \(Instagram\):\nКонтратака хорошая\n\n#fyp\n\ntwitch: evelone2004 #evelone\n/);
assert.match(t0, /COVER: cover-1.jpg\n$/);
assert.deepStrictEqual(out.textsJson, { comment: 'Полное видео в профиле' });
O.writeTexts(out);
assert.ok(fs.existsSync(path.join(out.folder, 'texts.json')));
assert.ok(fs.existsSync(out.files[3].txt));
// проверка готовой папки
let chk = O.checkFolder(out.folder);
assert.strictEqual(chk.videos, 0);
fs.writeFileSync(out.files[0].video, 'x');
chk = O.checkFolder(out.folder);
assert.deepStrictEqual(chk.problems, [path.join('evelon185', 'short-1-kontrataka-horoshaya.mp4') + ': нет cover-1.jpg']);
fs.writeFileSync(out.files[0].cover, 'x');
assert.deepStrictEqual(O.checkFolder(out.folder).problems, []);
// один канал — плоская папка
const flat = O.layoutOutput({ root, number: '018', name: 'x', channels: [{ name: 'only' }], plan: planChannels(ms, 1, 2, {}), texts: {} });
assert.strictEqual(flat.flat, true);
assert.strictEqual(path.dirname(flat.files[0].video), flat.folder);
fs.rmSync(root, { recursive: true, force: true });
console.log('выходные папки: 27 проверок');
// без заголовка: на экране пусто, в подписи — заголовок по умолчанию, имя файла moment
const noT = O.layoutOutput({ root: os.tmpdir(), number: '019', name: 'x', channels: [{ name: 'a' }], plan: planChannels([{ id: 'z', score: 1 }], 1, 1, {}), texts: { defaultTitle: 'Эвелон на стриме' }, rules: {} });
assert.strictEqual(noT.files[0].title, '');
assert.strictEqual(path.basename(noT.files[0].video), 'short-1-moment.mp4');
assert.match(noT.files[0].txtBody, /^TITLE:\nЭвелон на стриме twitch: evelone2004 #evelone\n/);
