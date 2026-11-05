'use strict';
const assert = require('assert');
const S = require('../lib/sources');

assert.strictEqual(S.platformOf('https://www.twitch.tv/videos/123'), 'twitch');
assert.strictEqual(S.platformOf('https://youtu.be/abc'), 'youtube');
assert.strictEqual(S.platformOf('https://kick.com/x'), 'kick');
assert.strictEqual(S.platformOf('https://vkvideo.ru/video-1_2'), 'vk');
assert.strictEqual(S.platformOf('C:\\v\\stream.mkv'), 'file');
assert.strictEqual(S.platformOf('эвелон'), null);
assert.strictEqual(S.searchTarget('эвелон стрим', 15), 'ytsearch15:эвелон стрим');
assert.strictEqual(S.searchTarget('https://youtube.com/@x'), 'https://youtube.com/@x');
assert.deepStrictEqual(S.listArgs('эвелон', 5), ['--flat-playlist', '-J', '--no-warnings', '--ignore-errors', 'ytsearch5:эвелон']);
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
assert.ok(au.includes('bestaudio/best') && !au.includes('--merge-output-format'));
assert.ok(S.downloadArgs('U', { chat: true }).includes('--skip-download'));
assert.strictEqual(S.parseProgress('[download]  42.5% of 10.00MiB at 1MiB/s'), 0.425);
assert.strictEqual(S.parseProgress('[info] x'), null);
console.log('источники: 30 проверок');
