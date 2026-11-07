'use strict';
const assert = require('assert');
const S = require('../lib/sources');

assert.strictEqual(S.platformOf('https://www.twitch.tv/videos/123'), 'twitch');
assert.strictEqual(S.platformOf('https://youtu.be/abc'), 'youtube');
assert.strictEqual(S.platformOf('https://kick.com/x'), 'kick');
assert.strictEqual(S.platformOf('https://vkvideo.ru/video-1_2'), 'vk');
assert.strictEqual(S.platformOf('C:\\v\\stream.mkv'), 'file');
assert.strictEqual(S.platformOf('эвелон'), null);
assert.strictEqual(S.searchTarget('эвелон стрим', 15), 'https://www.youtube.com/results?search_query=%D1%8D%D0%B2%D0%B5%D0%BB%D0%BE%D0%BD%20%D1%81%D1%82%D1%80%D0%B8%D0%BC', 'поиск через страницу результатов, не ytsearch');
assert.strictEqual(S.searchTarget('https://youtube.com/@x'), 'https://youtube.com/@x');
assert.deepStrictEqual(S.listArgs('эвелон', 5), ['--flat-playlist', '-J', '--no-warnings', '--ignore-errors', '--playlist-end', '5', S.ytResultsUrl('эвелон')]);
assert.deepStrictEqual(S.listArgs('https://www.twitch.tv/evelone2004/videos', 5).slice(-3), ['--playlist-end', '5', 'https://www.twitch.tv/evelone2004/videos']);
assert.strictEqual(S.channelUrl('twitch.tv/evelone2004'), 'https://www.twitch.tv/evelone2004/videos?filter=archives&sort=time');
assert.strictEqual(S.channelUrl('https://www.youtube.com/@evelone'), 'https://www.youtube.com/@evelone/videos');
assert.strictEqual(S.channelUrl('https://www.youtube.com/watch?v=1'), 'https://www.youtube.com/watch?v=1');

const list = S.parseList({ entries: [
  { id: 'dQw4w9WgXcQ', title: 'Стрим', duration: 7200, view_count: 50, channel: 'Evelone', thumbnails: [{ url: 's' }, { url: 'big' }], upload_date: '20261101' },
  { id: 'v2', url: 'https://www.twitch.tv/videos/2', title: 'VOD', duration: 600, view_count: 900, timestamp: 1793750400 },
  null,
] });
assert.strictEqual(list.length, 2);
assert.deepStrictEqual(list[0], { id: 'dQw4w9WgXcQ', title: 'Стрим', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: 7200, channel: 'Evelone', views: 50, thumb: 'big', date: '20261101', platform: 'youtube' });
assert.strictEqual(list[1].platform, 'twitch');
assert.strictEqual(list[1].date, '20261104');
assert.strictEqual(S.parseList({ id: 'x1', webpage_url: 'https://kick.com/v/1', title: 'одно' })[0].platform, 'kick');
assert.deepStrictEqual(S.filterLongs(list, { minDur: 1200 }).map((e) => e.id), ['dQw4w9WgXcQ']);
assert.deepStrictEqual(S.filterLongs(list, { sort: 'views' }).map((e) => e.id), ['v2', 'dQw4w9WgXcQ']);
assert.deepStrictEqual(S.filterLongs(list, { sort: 'date' }).map((e) => e.id), ['v2', 'dQw4w9WgXcQ']);

const dl = S.downloadArgs('U', { sections: [[10, 40]], out: 'o.mp4', ffmpeg: 'ff' });
assert.ok(dl.includes('--download-sections') && dl.includes('*10-40') && dl.includes('--force-keyframes-at-cuts'));
assert.ok(dl.join(' ').includes('--ffmpeg-location ff'));
assert.ok(dl.join(' ').includes('height<=1080'));
const au = S.downloadArgs('U', { audioOnly: true });
assert.ok(au.includes('ba[ext=m4a]/ba/b') && !au.includes('--merge-output-format') && !au.includes('-x'), 'звук без перекодирования');
assert.ok(S.downloadArgs('U', { chat: true }).includes('--skip-download'));
assert.strictEqual(S.parseProgress('[download]  42.5% of 10.00MiB at 1MiB/s'), 0.425);
assert.strictEqual(S.parseProgress('[info] x'), null);
// Instagram Reels и много ссылок сразу
assert.strictEqual(S.platformOf('https://www.instagram.com/reel/C9xYz12/?igsh=1'), 'instagram');
assert.strictEqual(S.platformOf('https://www.tiktok.com/@a/video/1'), 'tiktok');
assert.ok(S.needsAuth('https://www.instagram.com/reel/C9xYz12/'), 'Instagram — с cookies, как YouTube');
assert.ok(!S.needsAuth('https://www.twitch.tv/videos/1'));
assert.strictEqual(S.authPlan({ mode: 'auto' }, 'https://www.instagram.com/reel/1/').length, 1 + S.AUTO_BROWSERS.length);
assert.deepStrictEqual(S.parseLinks('https://www.instagram.com/reel/A1/\nhttps://youtu.be/x, https://www.instagram.com/reel/A1/ текст (https://www.twitch.tv/videos/5).'),
  ['https://www.instagram.com/reel/A1/', 'https://youtu.be/x', 'https://www.twitch.tv/videos/5']);
assert.deepStrictEqual(S.parseLinks('нет ссылок'), []);
assert.ok(S.isInstagramProfile('https://www.instagram.com/evelone2004/'));
assert.ok(S.isInstagramProfile('https://instagram.com/evelone2004/reels/'));
assert.ok(!S.isInstagramProfile('https://www.instagram.com/reel/C9xYz12/'));
assert.ok(!S.isInstagramProfile('https://www.instagram.com/p/C9xYz12/'));
assert.ok(S.isAuthError('ERROR: [Instagram] C9x: Requested content is not available, rate-limit reached or login required. Use --cookies'));
assert.match(S.authHelp([null], 'https://www.instagram.com/reel/1/'), /Instagram не отдаёт/);
assert.match(S.authHelp([null], 'https://youtu.be/1'), /YouTube просит/);
assert.ok(S.isShortSource({ kind: 'url', duration: 45 }));
assert.ok(!S.isShortSource({ kind: 'url', duration: 7200 }));
assert.ok(!S.isShortSource({ kind: 'file', duration: 45 }));
assert.ok(!S.isShortSource({ kind: 'url', duration: 0 }), 'длина неизвестна — качаем кусками, как раньше');
// причина по каждому способу входа
assert.match(S.cookieWhy('ERROR: Failed to decrypt with DPAPI', { browser: 'edge' }), /Firefox или файл cookies\.txt/);
assert.match(S.cookieWhy('could not find firefox cookies database', { browser: 'firefox' }), /не найден/);
assert.match(S.cookieWhy('Could not copy Chrome cookie database', { browser: 'chrome' }), /закрой этот браузер/);
assert.match(S.cookieWhy('Sign in to confirm you are not a bot', null), /не бот/);
const help = S.authHelp([null, { browser: 'edge' }], 'https://youtu.be/1', ['без входа', 'Windows не даёт прочитать cookies']);
assert.match(help, /• без входа: без входа/);
assert.match(help, /• cookies Edge: Windows не даёт/);
assert.match(help, /Get cookies\.txt LOCALLY/);
console.log('источники: 56 проверок');
