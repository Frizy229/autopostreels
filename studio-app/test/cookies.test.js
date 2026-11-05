'use strict';
// Вход в YouTube для yt-dlp: «Sign in to confirm you're not a bot» → cookies браузера или cookies.txt.
// yt-dlp подменён: отвечает так же, как настоящий, в зависимости от аргументов.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sources');
const { normalize } = require('../lib/settings');
const { Pipeline } = require('../lib/pipeline');

const BOT = "ERROR: [youtube] NT9iGYZZtR0: Sign in to confirm you're not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.";
let n = 0;
const ok = (v, m) => { assert.ok(v, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// чистые функции
ok(S.isAuthError(BOT), 'текст ошибки со скриншота Alex');
ok(S.isAuthError('ERROR: [youtube] x: Sign in to confirm your age'));
ok(!S.isAuthError('ERROR: [twitch:vod] 404 Not Found'));
ok(S.isCookieError('ERROR: could not find firefox cookies database in "C:\\Users\\a\\AppData\\Roaming\\Mozilla"'));
ok(S.isCookieError('ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271'));
ok(S.isCookieError('ERROR: Failed to decrypt with DPAPI'));
ok(!S.isCookieError(BOT));
ok(S.needsAuth('https://www.youtube.com/watch?v=NT9iGYZZtR0') && S.needsAuth('ytsearch20:эвелон') && S.needsAuth('https://youtu.be/x'));
ok(!S.needsAuth('https://www.twitch.tv/videos/123') && !S.needsAuth('C:\\stream.mp4') && !S.needsAuth('https://kick.com/x'));
eq(S.cookieArgs(null), []);
eq(S.cookieArgs({ browser: 'firefox' }), ['--cookies-from-browser', 'firefox']);
eq(S.cookieArgs({ file: 'C:\\c.txt' }), ['--cookies', 'C:\\c.txt']);
const yt = 'https://www.youtube.com/watch?v=NT9iGYZZtR0';
eq(S.authPlan({ mode: 'auto' }, yt)[0], null, 'auto: сначала без входа');
eq(S.authPlan({ mode: 'auto' }, yt)[1], { browser: 'firefox' }, 'auto: потом Firefox');
eq(S.authPlan({ mode: 'browser', browser: 'edge' }, yt), [{ browser: 'edge' }, null]);
eq(S.authPlan({ mode: 'file', file: 'c.txt' }, yt), [{ file: 'c.txt' }, null]);
eq(S.authPlan({ mode: 'none' }, yt), [null]);
eq(S.authPlan({ mode: 'browser', browser: 'edge' }, 'https://www.twitch.tv/videos/1'), [null], 'Twitch всегда без cookies');
ok(/войди в YouTube/.test(S.authHelp([null, { browser: 'firefox' }])) && /Twitch/.test(S.authHelp([])) && /cookies Firefox/.test(S.authHelp([{ browser: 'firefox' }])));

// настройки
eq(normalize({}).cookies, { mode: 'auto', browser: 'firefox', file: '' }, 'по умолчанию — автоматически');
eq(normalize({ cookies: { mode: 'browser', browser: 'edge' } }).cookies.browser, 'edge');
eq(normalize({ cookies: { mode: 'file', file: '' } }).cookies.mode, 'auto', 'файл не выбран — автоматически');
eq(normalize({ cookies: { mode: 'x', browser: 'netscape' } }).cookies, { mode: 'auto', browser: 'firefox', file: '' });

// конвейер с поддельным yt-dlp
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  const calls = [];
  // как ведёт себя ПК: Firefox не установлен, в Edge выполнен вход в YouTube
  const behave = (args) => {
    const i = args.indexOf('--cookies-from-browser'); const br = i >= 0 ? args[i + 1] : null;
    const f = args.indexOf('--cookies'); const file = f >= 0 ? args[f + 1] : null;
    const target = args[args.length - 1];
    if (!S.needsAuth(target)) return br || file ? { code: 1, stderr: 'ERROR: cookies не нужны Twitch' } : { code: 0, out: '{"id":"v1","title":"VOD","webpage_url":"https://www.twitch.tv/videos/1"}' };
    if (file === 'good.txt' || br === 'edge') return { code: 0, out: '{"id":"NT9iGYZZtR0","title":"Эвелон","duration":3600}' };
    if (br === 'firefox') return { code: 1, stderr: 'ERROR: could not find firefox cookies database in "C:\\x"' };
    if (file === 'bad.txt') return { code: 1, stderr: 'ERROR: \'bad.txt\' does not look like a Netscape format cookies file' };
    return { code: 1, stderr: BOT };
  };
  const tools = {
    ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg',
    run: async (cmd, args, opts) => {
      calls.push(args);
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Отменено'), { code: 'ABORT' });
      const r = behave(args);
      return { code: r.code, stdout: Buffer.from(r.out || ''), stderr: r.stderr || '' };
    },
  };
  let settings = normalize({});
  const pl = new Pipeline({ tools, dataDir: tmp, fontsDir: tmp, settings: () => settings });

  const pr = await pl.addUrl(yt);
  eq(pr.title, 'Эвелон', 'auto: YouTube открылся через cookies Edge');
  eq(calls.map((a) => S.cookieArgs(a.includes('--cookies-from-browser') ? { browser: a[a.indexOf('--cookies-from-browser') + 1] } : null).join(' ')),
    ['', '--cookies-from-browser firefox', '--cookies-from-browser edge'], 'без входа → Firefox (нет) → Edge');
  calls.length = 0;
  await pl.addUrl(yt);
  eq(calls.length, 1, 'сработавший способ запоминается');
  ok(calls[0].includes('edge'));

  calls.length = 0;
  const tw = await pl.addUrl('https://www.twitch.tv/videos/1');
  eq(tw.title, 'VOD'); eq(calls.length, 1); ok(!calls[0].includes('--cookies-from-browser'), 'Twitch без cookies');

  settings = normalize({ cookies: { mode: 'none' } });
  await assert.rejects(pl.addUrl(yt), (e) => e.code === 'AUTH' && /не бот/.test(e.message) && /Настройках/.test(e.message)); n++;

  settings = normalize({ cookies: { mode: 'file', file: 'good.txt' } });
  calls.length = 0;
  eq((await pl.addUrl(yt)).title, 'Эвелон'); ok(calls[0].includes('--cookies') && calls[0].includes('good.txt'));

  settings = normalize({ cookies: { mode: 'file', file: 'bad.txt' } });
  calls.length = 0;
  await assert.rejects(pl.addUrl(yt), (e) => e.code === 'AUTH' && /файл cookies.txt/.test(e.message)); n++;
  eq(calls.length, 2, 'битый cookies.txt → ещё раз без него');

  // обычная ошибка не превращается в «не бот» и не перебирает браузеры
  settings = normalize({});
  tools.run = async (cmd, args) => { calls.push(args); return { code: 1, stdout: Buffer.from(''), stderr: 'ERROR: [youtube] x: Video unavailable' }; };
  calls.length = 0; pl._auth = null;
  await assert.rejects(pl.addUrl(yt), (e) => e.code !== 'AUTH' && /Video unavailable/.test(e.message)); n++;
  eq(calls.length, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`вход в YouTube: ${n} проверок`);
})().catch((e) => { console.error(e); process.exit(1); });
