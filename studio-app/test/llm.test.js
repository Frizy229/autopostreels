'use strict';
// Локальная нейросеть: выбор сборки llama.cpp, промпт, разбор ответа, клиент llama-server (на поддельном сервере).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/llm');
const { normalize } = require('../lib/settings');

const a = (name) => ({ name, browser_download_url: `https://x/${name}` });
const rel = [
  { tag_name: 'v0.7.0', assets: [a('nightly-tag.txt')] },
  { tag_name: 'b12017', assets: [a('llama-b12017-bin-win-cpu-x64.zip'), a('llama-b12017-bin-win-cpu-arm64.zip'), a('llama-b12017-bin-win-cuda-12.4-x64.zip'),
    a('cudart-llama-bin-win-cuda-12.4-x64.zip'), a('llama-b12017-bin-win-cuda-13.4-x64.zip'), a('cudart-llama-bin-win-cuda-13.4-x64.zip')] },
];
const g = L.pickLlamaAssets(rel, true);
assert.deepStrictEqual(g.map((x) => x.kind), ['cuda', 'cpu'], 'сначала видеокарта, потом процессор');
assert.strictEqual(g[0].name, 'llama-b12017-bin-win-cuda-12.4-x64.zip', 'CUDA 12.4, не 13 и не arm');
assert.deepStrictEqual(g[0].extra.map((x) => x.name), ['cudart-llama-bin-win-cuda-12.4-x64.zip'], 'библиотеки CUDA докачиваются');
assert.deepStrictEqual(L.pickLlamaAssets(rel, false).map((x) => x.kind), ['cpu']);
assert.throws(() => L.pickLlamaAssets([{ assets: [a('x.txt')] }], true), /нет сборки/);

// ---- промпт и ответ
const p = L.buildPrompt('привет чат');
assert.ok(p.includes('<|im_start|>assistant') && p.includes('привет чат') && p.includes('от 0 до 10'));
assert.ok(L.buildPrompt('текст', 'zanos').includes('настоящий занос') && L.buildPrompt('текст', 'zanos').includes('текст'), 'промпт заноса');
assert.ok(!L.buildPrompt('текст').includes('настоящий занос'));
assert.strictEqual(L.parseScore(' 8'), 8);
assert.strictEqual(L.parseScore('Оценка: 7.5'), 7.5);
assert.strictEqual(L.parseScore('6,5/10'), 6.5);
assert.strictEqual(L.parseScore('нет'), null);
assert.strictEqual(L.parseScore('250'), null, 'бред вне 0–10 не принимаем');
assert.strictEqual(L.llmBonus(5), 0);
assert.ok(L.llmBonus(9) > 0.9 && L.llmBonus(1) < -0.9 && L.llmBonus(null) === 0);

const words = Array.from({ length: 800 }, (_, i) => ({ w: `слово${i}`, s: i, e: i + 0.5 }));
assert.ok(L.momentText(words, 0, 1000).length <= 1800, 'длинный текст обрезается');
assert.strictEqual(L.momentText(words, 2, 4), 'слово2 слово3 слово4');
assert.ok(L.serverArgs({ model: 'm.gguf', port: 8123, gpu: false }).join(' ').includes('-ngl 0'));
assert.ok(L.serverArgs({ model: 'm.gguf', port: 8123, gpu: true }).join(' ').includes('-ngl 99'));
assert.ok(L.LLM_MODELS['7b'].url.endsWith('.gguf') && L.LLM_MODELS['3b'].file.endsWith('.gguf'));

// ---- настройки
assert.strictEqual(normalize({}).llm, true);
assert.strictEqual(normalize({}).llmModel, '7b');
assert.strictEqual(normalize({ llmModel: 'zzz' }).llmModel, '7b');
assert.strictEqual(normalize({ llm: false }).llm, false);

// ---- клиент на поддельном сервере: /health отвечает 503 первые 0,6 с, /completion возвращает « 8» (по слову «смешно» в промпте — 9)
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-'));
  const fake = path.join(tmp, 'llama-server.js');
  fs.writeFileSync(fake, `#!${process.execPath}
const a=process.argv;const port=+a[a.indexOf('--port')+1];const t0=Date.now();
require('http').createServer((req,res)=>{
  if(req.url==='/health'){res.statusCode=Date.now()-t0>600?200:503;return res.end('{}');}
  let b='';req.on('data',(c)=>b+=c);req.on('end',()=>{const j=JSON.parse(b);res.end(JSON.stringify({content:j.prompt.includes('ХАХА')?' 9':' 3'}));});
}).listen(port,'127.0.0.1');`);
  fs.chmodSync(fake, 0o755);
  if (process.platform === 'win32') { console.log('нейросеть: чистые проверки прошли (клиент на win32 пропущен)'); return; }
  const srv = new L.LlmServer({ bin: fake, model: 'm.gguf', gpu: false, startTimeoutMs: 15000 });
  await srv.start();
  try {
    assert.strictEqual(await srv.score('смешно ХАХА'), 9);
    assert.strictEqual(await srv.score('скучно'), 3);
  } finally { srv.stop(); }
  // сервер, который сразу падает
  const dead = path.join(tmp, 'dead.js');
  fs.writeFileSync(dead, `#!${process.execPath}\nconsole.error('error loading model');process.exit(3);`);
  fs.chmodSync(dead, 0o755);
  await assert.rejects(new L.LlmServer({ bin: dead, model: 'm', startTimeoutMs: 5000 }).start(), /код 3.*error loading model/);
  // остановка по сигналу
  const ac = new AbortController(); ac.abort();
  await assert.rejects(new L.LlmServer({ bin: fake, model: 'm', startTimeoutMs: 5000 }).start(ac.signal), (e) => e.code === 'ABORT');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('нейросеть: все проверки прошли');
})().catch((e) => { console.error(e); process.exit(1); });
