'use strict';
// Поиск сразу по YouTube и Twitch с фильтром источника. yt-dlp подменён: отвечает списками как настоящий.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sources');
const { normalize } = require('../lib/settings');
const { Pipeline } = require('../lib/pipeline');

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const ok = (v, m) => { assert.ok(v, m); n++; };

// Twitch: что смотреть у канала
eq(S.twitchTargets('Evelone2004').map((t) => t.kind), ['vod', 'highlight', 'clip']);
ok(S.twitchTargets('evelone2004')[2].url === 'https://www.twitch.tv/evelone2004/clips?filter=clips&range=all');
// совпадение по словам, регистр и ё не важны, начало слова считается
eq(S.matchScore('Эвелон в КАЗИНО ночью', 'казино'), 1);
eq(S.matchScore('Эвелон казиношит', 'казино ночью'), 0.5);
eq(S.matchScore('Ёлочка', 'елочки'), 1, 'ё = е, окончание отбрасывается');
eq(S.matchScore('что угодно', ''), 1, 'пустой запрос — всё подходит');
eq(S.matchScore('Майнкрафт', 'казино'), 0);
const tw = [
  { title: 'Казино с Мелстроем', views: 10, url: 'a', channel: 'evelone2004' },
  { title: 'Майнкрафт', views: 999, url: 'b', channel: 'evelone2004' },
  { title: 'Казино ночью', views: 50, url: 'c', channel: 'evelone2004' },
  { title: 'казино мелстрой реакция', views: 1, url: 'd', channel: 'evelone2004' },
];
eq(S.filterByQuery(tw, 'казино мелстрой').map((e) => e.url), ['a', 'd', 'c'], 'сначала оба слова, потом по просмотрам');

// общая выдача: источники через один, клипы не режутся по «от N минут»
const mixed = [
  { url: 'y1', platform: 'youtube', views: 1e6, duration: 3600 },
  { url: 'y2', platform: 'youtube', views: 5e6, duration: 4000 },
  { url: 'y3', platform: 'youtube', views: 9e6, duration: 60 },
  { url: 't1', platform: 'twitch', kind: 'vod', views: 3, duration: 9000 },
  { url: 't2', platform: 'twitch', kind: 'clip', views: 900, duration: 30 },
];
eq(S.mergeResults(mixed, { minDur: 1200 }).map((e) => e.url), ['y2', 't1', 'y1', 't2'], 'короткое с YouTube отсеяно, клип оставлен, через один');
eq(S.mergeResults(mixed, { sort: 'duration' }).map((e) => e.url), ['t1', 'y2', 'y1', 'y3', 't2']);

// настройки
eq(normalize({}).twitchChannels, ['evelone2004']);
eq(normalize({}).searchSource, 'all');
eq(normalize({ twitchChannels: 'https://www.twitch.tv/Evelone2004, @buster;  x  , melharucos/videos' }).twitchChannels, ['evelone2004', 'buster', 'melharucos'], 'ссылки, @ и мусор');
eq(normalize({ twitchChannels: '' }).twitchChannels, ['evelone2004'], 'пусто — как было');
eq(normalize({ searchSource: 'tiktok' }).searchSource, 'all', 'неизвестный источник — все');
eq(normalize({ searchSource: 'instagram' }).searchSource, 'instagram');
eq(normalize({ igSearch: { token: ' t ', userId: 'abc' } }).igSearch, { token: 't', userId: '', username: '' }, 'ID только цифрами');

// Instagram: хэштеги из запроса и ошибки Meta по-русски
const IG = require('../lib/igsearch');
eq(IG.hashtagsOf('#Эвелон #казино, #эвелон'), ['эвелон', 'казино']);
eq(IG.hashtagsOf('эвелон казино'), ['эвелонказино'], 'без # — один хэштег из слов');
eq(IG.hashtagsOf('   '), []);
ok(/Public Content Access/.test(IG.igError({ error: { code: 10, message: 'Application does not have permission' } })));
ok(/30 разных хэштегов/.test(IG.igError({ error: { code: 24, message: 'max 30 unique hashtags' } })));
ok(/недействителен/.test(IG.igError({ error: { code: 190, message: 'expired' } })));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-'));
  const calls = [];
  let twitchDown = false;
  const tools = {
    ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg',
    run: async (cmd, args) => {
      const url = args[args.length - 1];
      calls.push(url);
      const json = (o) => ({ code: 0, stdout: Buffer.from(JSON.stringify(o)), stderr: '' });
      if (/youtube\.com\/results/.test(url)) return json({ entries: [{ id: 'YYYYYYYYYY1', title: 'Эвелон казино', duration: 5000, view_count: 1e6 }] });
      if (/twitch\.tv/.test(url)) {
        if (twitchDown) return { code: 1, stdout: Buffer.from(''), stderr: 'ERROR: [twitch:videos] Unable to download JSON metadata: HTTP Error 500' };
        const kind = /clips/.test(url) ? 'clip' : /highlights/.test(url) ? 'hl' : 'vod';
        return json({ entries: [
          { id: `v-${kind}-1`, url: `https://www.twitch.tv/videos/${kind}1`, title: `Казино ${kind}`, duration: kind === 'clip' ? 30 : 9000, view_count: 5 },
          { id: `v-${kind}-2`, url: `https://www.twitch.tv/videos/${kind}2`, title: 'Майнкрафт', duration: 9000, view_count: 50 },
        ] });
      }
      return { code: 1, stdout: Buffer.from(''), stderr: 'ERROR: unknown' };
    },
  };
  let settings = normalize({ twitchChannels: ['evelone2004'] });
  // поддельный Graph API Meta
  const urls = [];
  let igFail = null;
  const fetch = async (url) => {
    urls.push(url);
    const res = (j, status = 200) => ({ ok: status === 200, status, json: async () => j });
    if (igFail) return res({ error: igFail }, 400);
    if (/ig_hashtag_search/.test(url)) return res({ data: /q=nohash/.test(url) ? [] : [{ id: '999' }] });
    if (/\/999\/top_media/.test(url)) return res({ data: [
      { id: '1', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/AAA/', caption: 'Эвелон в казино\n#evelone', like_count: 500, timestamp: '2026-11-01T10:00:00+0000' },
      { id: '2', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/BBB/', like_count: 9000 },
    ] });
    if (/\/999\/recent_media/.test(url)) return res({ data: [
      { id: '1', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/AAA/', like_count: 500 },
      { id: '3', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/CCC/', like_count: 20 },
    ] });
    if (/me\/accounts/.test(url)) return res({ data: [{ id: 'page', instagram_business_account: { id: '17841431768361264', username: 'dayzerorules' } }] });
    return res({ error: { message: 'unknown' } }, 404);
  };
  const pl = new Pipeline({ tools, dataDir: tmp, fontsDir: tmp, settings: () => settings, fetch });

  const all = await pl.searchAll('казино', { source: 'all' });
  eq(all.errors, {});
  eq(all.results.filter((e) => e.platform === 'youtube').length, 1);
  const twr = all.results.filter((e) => e.platform === 'twitch');
  eq(twr.map((e) => e.kind).sort(), ['clip', 'highlight', 'vod'], 'по одному подходящему из записей, хайлайтов и клипов, «Майнкрафт» отсеян');
  ok(twr.every((e) => e.channel === 'evelone2004'));

  calls.length = 0;
  const onlyTw = await pl.searchAll('казино', { source: 'twitch' });
  ok(onlyTw.results.every((e) => e.platform === 'twitch') && !calls.some((u) => /youtube/.test(u)), 'фильтр Twitch — YouTube не трогаем');
  calls.length = 0;
  const onlyYt = await pl.searchAll('казино', { source: 'youtube' });
  ok(onlyYt.results.length === 1 && !calls.some((u) => /twitch/.test(u)), 'фильтр YouTube — Twitch не трогаем');

  // один источник упал — выдача из другого и предупреждение
  twitchDown = true;
  const half = await pl.searchAll('казино', { source: 'all' });
  ok(half.results.length === 1 && /Twitch ничего не отдал/.test(half.errors.twitch), 'Twitch не ответил — YouTube всё равно показан');
  await assert.rejects(pl.searchAll('казино', { source: 'twitch' }), /Twitch ничего не отдал/); n++;

  twitchDown = false;
  // слов запроса нет в названиях — не пусто, а последние записи и лучшие клипы с пометкой
  const loose = await pl.searchAll('casino inst', { source: 'twitch' });
  ok(loose.results.length > 0 && loose.results.every((e) => e.loose), 'по-английски не нашлось — показаны последние, с пометкой');
  ok(loose.results.some((e) => e.kind === 'clip') && loose.results.some((e) => e.kind !== 'clip'));
  ok((await pl.searchAll('казино', { source: 'twitch' })).results.every((e) => !e.loose), 'нашлось по словам — без пометки');
  // «Показать ещё» на YouTube: следующие 40
  eq(S.listArgs('эвелон', 40, 41).slice(4, 8), ['--playlist-start', '41', '--playlist-end', '80']);
  calls.length = 0;
  await pl.search('эвелон', 40, 41);
  ok(/youtube\.com\/results/.test(calls[0]));

  // Instagram: не настроен — во «Всех» просто пропускается, отдельно — понятная ошибка
  twitchDown = false; urls.length = 0;
  await pl.searchAll('казино', { source: 'all' });
  eq(urls.length, 0, 'без токена Instagram во «Всех» не трогаем');
  await assert.rejects(pl.searchAll('казино', { source: 'instagram' }), /не настроен/); n++;
  eq(await IG.igAccounts(fetch, 'tok'), [{ id: '17841431768361264', username: 'dayzerorules' }], 'аккаунт находится по токену');
  settings = normalize({ ...settings, igSearch: { token: 'tok', userId: '17841431768361264' } });
  const igr = await pl.searchAll('#казино', { source: 'instagram' });
  eq(igr.results.map((e) => e.url), ['https://www.instagram.com/reel/AAA/', 'https://www.instagram.com/reel/CCC/'], 'только видео, без повторов, по лайкам');
  eq([igr.results[0].title, igr.results[0].platform, igr.results[0].date], ['Эвелон в казино', 'instagram', '20261101']);
  ok(urls.some((u) => /user_id=17841431768361264/.test(u) && /q=%D0%BA%D0%B0%D0%B7%D0%B8%D0%BD%D0%BE/.test(u)));
  const all3 = await pl.searchAll('казино', { source: 'all' });
  eq([...new Set(all3.results.map((e) => e.platform))].sort(), ['instagram', 'twitch', 'youtube'], 'настроен — во «Всех» три источника');
  eq(S.mergeResults(all3.results, { minDur: 1200 }).slice(0, 3).map((e) => e.platform), ['youtube', 'twitch', 'instagram'], 'через один, рилсы не режутся по длине');
  await assert.rejects(pl.searchAll('#nohash', { source: 'instagram' }), /нет/); n++;
  igFail = { code: 10, message: 'Application does not have the capability' };
  const igDown = await pl.searchAll('казино', { source: 'all' });
  ok(igDown.results.length > 0 && /Public Content Access/.test(igDown.errors.instagram), 'Meta отказала — остальное показано, причина видна');
  igFail = null;

  // несколько каналов
  twitchDown = false; calls.length = 0;
  settings = normalize({ twitchChannels: 'evelone2004, buster' });  // без токена Instagram
  await pl.searchAll('казино', { source: 'twitch' });
  eq(calls.filter((u) => /twitch\.tv\/buster\//.test(u)).length, 3, 'у второго канала тоже записи, хайлайты и клипы');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`поиск: ${n} проверок`);
})().catch((e) => { console.error(e); process.exit(1); });
