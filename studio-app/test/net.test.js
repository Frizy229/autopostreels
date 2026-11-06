'use strict';
// Сеть: прокси для yt-dlp (системный из Windows/свой/без), понятная ошибка «YouTube недоступен», UTF-8 вывода.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/sources');
const T = require('../lib/tools');
const { normalize } = require('../lib/settings');
const { Pipeline } = require('../lib/pipeline');

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ответы Electron resolveProxy
eq(S.proxyFromPac('DIRECT'), '');
eq(S.proxyFromPac('PROXY 127.0.0.1:10809; DIRECT'), 'http://127.0.0.1:10809', 'v2rayN/Hiddify в режиме системного прокси');
eq(S.proxyFromPac('SOCKS5 127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
eq(S.proxyFromPac('SOCKS 10.0.0.1:1080'), 'socks5://10.0.0.1:1080');
eq(S.proxyFromPac('HTTPS proxy.example:443'), 'https://proxy.example:443');
eq(S.proxyFromPac(''), '');
// своё поле
eq(S.normProxy('127.0.0.1:1080'), 'http://127.0.0.1:1080');
eq(S.normProxy('socks5://127.0.0.1:1080/'), 'socks5://127.0.0.1:1080');
eq(S.normProxy('socks5h://user:pw@host:1080'), 'socks5h://user:pw@host:1080');
eq(S.normProxy('что-то'), '');
// аргументы
eq(S.proxyArgs({ mode: 'system' }, 'http://127.0.0.1:10809'), ['--proxy', 'http://127.0.0.1:10809']);
eq(S.proxyArgs({ mode: 'system' }, ''), [], 'нет прокси в Windows — как есть');
eq(S.proxyArgs({ mode: 'manual', proxy: '127.0.0.1:1080' }, 'http://x:1'), ['--proxy', 'http://127.0.0.1:1080'], 'свой важнее системного');
eq(S.proxyArgs({ mode: 'manual', proxy: 'мусор' }, ''), []);
eq(S.proxyArgs({ mode: 'none' }, 'http://x:1'), ['--proxy', ''], 'без прокси — напрямую даже при системном');
// настройки
eq(normalize({}).net, { mode: 'system', proxy: '' });
eq(normalize({ net: { mode: 'manual', proxy: ' 127.0.0.1:1080 ' } }).net, { mode: 'manual', proxy: '127.0.0.1:1080' });
eq(normalize({ net: { mode: 'vpn' } }).net.mode, 'system');

// ошибка у друга Alex (Windows, YouTube заблокирован по DNS)
const DNS = 'ERROR: query "эвелон стрим" page 1: Unable to download API page: HTTPSConnection(host=\'www.youtube.com\', port=443): Failed to resolve \'www.youtube.com\' ([Errno 11001] getaddrinfo failed)';
ok(S.isNetworkError(DNS));
ok(S.isNetworkError('ERROR: Unable to download webpage: <urlopen error [WinError 10060] ...>'));
ok(S.isNetworkError('ERROR: Unable to download webpage: Unable to connect to proxy'));
ok(!S.isNetworkError("ERROR: [youtube] x: Sign in to confirm you're not a bot"));
ok(!S.isNetworkError('ERROR: [youtube] x: Video unavailable'));
ok(/YouTube недоступен/.test(S.netHelp('https://www.youtube.com/results?search_query=x')) && /VPN/.test(S.netHelp('https://youtu.be/x')) && /Twitch/.test(S.netHelp('x')));
ok(/Прокси из настроек не отвечает/.test(S.netHelp('https://youtu.be/x', 'socks5://127.0.0.1:1')));

(async () => {
  // UTF-8: дочерний процесс получает PYTHONUTF8/PYTHONIOENCODING (иначе yt-dlp на Windows пишет в cp1251 → «������»)
  const tools0 = new T.Tools(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-')));
  const env = JSON.parse((await tools0.run(process.execPath, ['-e', 'console.log(JSON.stringify({u:process.env.PYTHONUTF8,e:process.env.PYTHONIOENCODING}))'])).stdout.toString());
  eq(env, { u: '1', e: 'utf-8' });
  const echo = await tools0.run(process.execPath, ['-e', 'console.log(process.argv[1])', 'эвелон стрим']);
  eq(echo.stdout.toString('utf8').trim(), 'эвелон стрим', 'русский аргумент доходит целым');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-'));
  const calls = [];
  let sys = '';
  const tools = {
    ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg',
    run: async (cmd, args) => {
      calls.push(args);
      const i = args.indexOf('--proxy');
      if (i >= 0 && args[i + 1]) return { code: 0, stdout: Buffer.from('{"entries":[{"id":"a1","title":"t","url":"https://www.youtube.com/watch?v=a1","duration":100}]}'), stderr: '' };
      return { code: 1, stdout: Buffer.from(''), stderr: DNS };
    },
  };
  let settings = normalize({});
  const pl = new Pipeline({ tools, dataDir: tmp, fontsDir: tmp, settings: () => settings, systemProxy: () => sys });

  await assert.rejects(pl.search('эвелон стрим', 5), (e) => e.code === 'NET' && /YouTube недоступен/.test(e.message) && /«Сеть»/.test(e.message)); n++;
  eq(calls.length, 1, 'при сетевой ошибке браузеры для входа не перебираются');
  ok(fs.readFileSync(path.join(tmp, 'logs', 'yt-dlp.txt'), 'utf8').includes('getaddrinfo'));

  sys = 'http://127.0.0.1:10809';
  calls.length = 0;
  eq((await pl.search('эвелон стрим', 5)).length, 1, 'VPN в режиме системного прокси — YouTube находится');
  eq(calls[0].slice(0, 2), ['--proxy', 'http://127.0.0.1:10809']);

  settings = normalize({ net: { mode: 'manual', proxy: 'socks5://127.0.0.1:1080' } });
  calls.length = 0;
  const t = await pl.testYoutube();
  ok(t.ok && t.proxy === 'socks5://127.0.0.1:1080', JSON.stringify(t));

  settings = normalize({ net: { mode: 'none' } });
  const bad = await pl.testYoutube();
  ok(!bad.ok && bad.code === 'NET' && /недоступен/.test(bad.error));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`сеть: ${n} проверок`);
})().catch((e) => { console.error(e); process.exit(1); });
