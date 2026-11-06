'use strict';
// Фон: поиск залипательных видео/мини-игр и скачивание в библиотеку; звук для поиска моментов без перекодирования.
// yt-dlp подменён: «скачивание» создаёт файл по шаблону -o.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sources');
const { normalize } = require('../lib/settings');
const { Pipeline } = require('../lib/pipeline');

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// запросы
eq(S.parseQueryLine('Чистка ковров = carpet cleaning satisfying'), { t: 'Чистка ковров', q: 'carpet cleaning satisfying' });
eq(S.parseQueryLine('slime asmr'), { t: 'slime asmr', q: 'slime asmr' });
eq(S.parseQueryLine('  '), null);
eq(S.parseQueryLine('Пусто ='), null);
ok(S.FILLER_QUERIES.some((l) => /ковр/i.test(l)) && S.FILLER_QUERIES.some((l) => /slime/i.test(l)) && S.FILLER_QUERIES.some((l) => /rust/i.test(l)), 'ковры, слаймы, ржавое — как просил Alex');
eq(normalize({}).fillerQueries.length, S.FILLER_QUERIES.length);
eq(normalize({ fillerQueries: 'Мыло = soap cutting\n\n' }).fillerQueries, ['Мыло = soap cutting']);
eq(normalize({ fillerQueries: [] }).fillerQueries, S.FILLER_QUERIES, 'пустой список — как было');
eq(normalize({}).fillerCC, false);

// поиск: обычный и только Creative Commons
eq(S.fillerTarget('slime asmr', { limit: 30 }), 'https://www.youtube.com/results?search_query=slime%20asmr', '«Все видео» — тем же способом, что и Creative Commons (у Alex ytsearch давал пусто)');
ok(!S.fillerTarget('x').includes('&sp='), 'без фильтра');
const cc = S.fillerTarget('чистка ковров', { cc: true });
ok(cc.startsWith('https://www.youtube.com/results?search_query=') && cc.includes(encodeURIComponent('чистка ковров')) && cc.endsWith('&sp=EgIwAQ%3D%3D'), 'фильтр Creative Commons');
ok(S.needsAuth(cc), 'поиск CC идёт со входом в YouTube, если надо');
const la = S.listArgs(cc, 30);
ok(la.includes('--playlist-end') && la[la.length - 1] === cc);
const found = S.filterFillers([
  { id: 'a', url: 'u/a', duration: 10, views: 5 }, { id: 'b', url: 'u/b', duration: 300, views: 10 },
  { id: 'c', url: 'u/c', duration: 0, views: 99 }, { id: 'd', url: '', duration: 100, views: 1 }]);
eq(found.map((x) => x.id), ['c', 'b'], 'короче 20 с и без ссылки — мимо, по просмотрам');

// скачивание фона: только видео, длинное — первые 10 минут
const fa = S.fillerDownloadArgs('https://youtu.be/x', { out: 'o.%(ext)s', duration: 3600 });
ok(fa.join(' ').includes('bv*[height<=1080]') && !fa.includes('ba') && fa.includes('--download-sections') && fa.includes('*0-600'));
ok(!S.fillerDownloadArgs('U', { duration: 300 }).includes('--download-sections'), 'короткое — целиком');
eq(S.fillerDownloadArgs('U', { duration: 3600 }).pop(), 'U', 'ссылка последней');

// строки yt-dlp → подпись под полосой
eq(S.statusOf('[download]  42.0% of 10MiB'), null);
eq(S.statusOf('[ExtractAudio] Destination: audio.m4a'), 'Перевожу звук');
eq(S.statusOf('[Merger] Merging formats into "x.mp4"'), 'Склеиваю файл');
ok(/^yt-dlp: /.test(S.statusOf('WARNING: [youtube] No supported JavaScript runtime')));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
  const lib = path.join(tmp, 'Фон');
  const calls = [];
  const tools = {
    ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg',
    run: async (cmd, args, opts) => {
      calls.push(args);
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Отменено'), { code: 'ABORT' });
      const url = args[args.length - 1];
      if (args.includes('--flat-playlist')) {
        return { code: 0, stdout: Buffer.from(JSON.stringify({ entries: [
          { id: 'AAAAAAAAAA1', title: 'Carpet cleaning', duration: 900, view_count: 100, url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1' },
          { id: 'BBBBBBBBBB2', title: 'Short', duration: 8, view_count: 1e6, url: 'https://www.youtube.com/watch?v=BBBBBBBBBB2' },
        ] })), stderr: '' };
      }
      if (/broken/.test(url)) return { code: 1, stdout: Buffer.from(''), stderr: 'ERROR: [youtube] broken: Video unavailable' };
      const out = args[args.indexOf('-o') + 1].replace('%(ext)s', args.includes('ba[ext=m4a]/ba/b') ? 'webm' : 'mp4');
      for (const l of ['[youtube] x: Downloading webpage', '[download]  50.0% of 1MiB', '[download] 100% of 1MiB']) if (opts.onLine) opts.onLine(l, 'stdout');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'video');
      return { code: 0, stdout: Buffer.from(''), stderr: '' };
    },
  };
  const settings = normalize({ fillerDir: lib });
  const pl = new Pipeline({ tools, dataDir: tmp, fontsDir: tmp, settings: () => settings });

  const res = await pl.searchFillers('чистка ковров', { cc: true });
  eq(res.map((x) => x.id), ['AAAAAAAAAA1'], 'поиск: 8-секундное отсеяно');
  ok(calls[0][calls[0].length - 1].includes('sp=EgIwAQ'), 'ушёл запрос с фильтром CC');

  const steps = [];
  const r = await pl.addFillers([res[0], { id: 'broken', url: 'https://youtu.be/broken', title: 'Битое' }], (p, t) => steps.push([p, t]));
  eq(r.added.length, 1); eq(r.failed.length, 1, 'одно битое не мешает остальным');
  ok(r.added[0].startsWith(lib) && /carpet-cleaning-\[AAAAAAAAAA1\]\.mp4$/.test(r.added[0]), path.basename(r.added[0]));
  ok(calls.some((a) => a.includes('*0-600')), '15-минутное видео — первые 10 минут');
  ok(steps.some(([p, t]) => p > 0 && p < 1 && /1 из 2/.test(t)), 'прогресс по видео');
  const libList = pl.fillerLibrary();
  eq(libList.files.map((f) => f.id), ['AAAAAAAAAA1']);
  const again = await pl.addFillers([res[0]]);
  eq([again.added.length, again.skipped.length], [0, 1], 'уже в библиотеке — второй раз не качается');
  fs.writeFileSync(path.join(lib, 'my-game.mp4'), 'x');
  eq(pl.fillerLibrary().files.length, 2, 'свои файлы в папке тоже видны');
  assert.throws(() => pl.removeFiller(path.join(tmp, 'other.mp4')), /не файл из папки фона/); n++;
  eq(pl.removeFiller(r.added[0]).files.map((f) => f.name), ['my-game.mp4']);
  await assert.rejects(pl.addFillers([{ id: 'broken', url: 'https://youtu.be/broken', title: 'Битое' }]), /Не скачалось/); n++;

  // звук для поиска моментов: без -x, подписи этапов вместо «застывших 40%»
  const pr = pl.save({ id: 'p1', created: 1, title: 't', source: { kind: 'url', url: 'https://www.youtube.com/watch?v=CCCCCCCCCC3', duration: 60 }, moments: [] });
  const say = [];
  const audio = await pl.audioSource(pr, (p, t) => say.push(t));
  ok(/audio\.webm$/.test(audio), 'webm/opus берётся как есть');
  const dl = calls[calls.length - 1];
  ok(!dl.includes('-x') && !dl.includes('--audio-format'), 'без перекодирования');
  ok(say.includes('Получаю данные видео') && say.includes('Скачиваю звук'));
  eq(await pl.audioSource(pr), audio, 'второй раз из кэша');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`фон и звук: ${n} проверок`);
})().catch((e) => { console.error(e); process.exit(1); });
