'use strict';
// Локальная нейросеть для оценки «смешного» по тексту момента: llama.cpp (llama-server) + модель Qwen2.5 Instruct.
// Без ключей и интернета после установки. Здесь выбор сборки, промпт, разбор ответа и клиент сервера;
// скачивание — в main.js, поиск программы — в tools.js.
const net = require('net');
const { spawn } = require('child_process');

const LLM_MODELS = {
  '7b': { file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', size: '4.7 ГБ', note: 'лучше понимает шутки, нужна видеокарта (RTX 3070 подходит)',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf' },
  '3b': { file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf', size: '2.1 ГБ', note: 'быстрее и легче, шутки понимает хуже',
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf' },
};

/**
 * Из списка релизов llama.cpp: CUDA 12.4 (+ cudart с библиотеками) для видеокарты, затем процессорная сборка.
 * Возвращает [{url, name, kind, extra: [{url, name}]}] по порядку предпочтения.
 */
function pickLlamaAssets(releases, gpu) {
  for (const rel of Array.isArray(releases) ? releases : [releases]) {
    const assets = (rel && rel.assets) || [];
    const find = (re) => assets.find((a) => re.test(a.name));
    const cuda = find(/^llama-b\d+-bin-win-cuda-12\.\d+-x64\.zip$/i);
    const rt = find(/^cudart-llama-bin-win-cuda-12\.\d+-x64\.zip$/i);
    const cpu = find(/^llama-b\d+-bin-win-cpu-x64\.zip$/i);
    if (!cuda && !cpu) continue;
    const out = [];
    if (gpu && cuda) out.push({ url: cuda.browser_download_url, name: cuda.name, kind: 'cuda', extra: rt ? [{ url: rt.browser_download_url, name: rt.name }] : [] });
    if (cpu) out.push({ url: cpu.browser_download_url, name: cpu.name, kind: 'cpu', extra: [] });
    if (out.length) return out;
  }
  throw new Error('В последних релизах llama.cpp нет сборки для Windows x64');
}

async function llamaAssets(fetchImpl, gpu) {
  const r = await fetchImpl('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10', { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
  return pickLlamaAssets(await r.json(), gpu);
}

/** Аргументы llama-server. */
function serverArgs({ model, port, gpu = true, ctx = 4096 }) {
  return ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', String(ctx), '-ngl', gpu ? '99' : '0', '--no-webui', '--parallel', '1'];
}

const MAX_TEXT = 1800;

/** Текст момента для нейросети: слова подряд, не длиннее MAX_TEXT знаков (берём середину, там обычно суть). */
function momentText(words, start, end) {
  const t = (words || []).filter((w) => w.e >= start && w.s <= end).map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT) return t;
  const from = Math.floor((t.length - MAX_TEXT) / 2);
  return t.slice(from, from + MAX_TEXT);
}

/** Промпт в формате ChatML (Qwen). Ответ — одно число 0–10. */
function buildPrompt(text) {
  const sys = 'Ты редактор коротких вертикальных видео по стримам. Отбираешь самые смешные и цепляющие моменты.';
  const user = `Это расшифровка фрагмента стрима Эвелона (в ней бывают ошибки распознавания):\n"""\n${text}\n"""\n\n`
    + 'Оцени от 0 до 10, насколько это хороший момент для рилса: шутка, неожиданный поворот, фейл, яркая эмоциональная реакция, смех. '
    + 'Скучный разговор, настройка, чтение чата без реакции, повторения, обрывки фраз: 0–3. Ответь одним числом.';
  return `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

/** Число 0–10 из ответа нейросети или null. */
function parseScore(text) {
  const m = /(\d+(?:[.,]\d+)?)/.exec(String(text || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return n >= 0 && n <= 10 ? n : (n > 10 && n <= 100 ? null : null);
}

/** Добавка к оценке момента: 5 из 10 — ноль, 9–10 заметно поднимают, 0–2 опускают. */
function llmBonus(score) {
  if (score == null) return 0;
  return Math.round((score - 5) * 0.25 * 100) / 100;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Запущенный llama-server: start() → score(text) много раз → stop(). */
class LlmServer {
  constructor({ bin, model, gpu = true, fetchImpl = (...a) => globalThis.fetch(...a), spawnImpl = spawn, startTimeoutMs = 180000 }) {
    Object.assign(this, { bin, model, gpu, fetchImpl, spawnImpl, startTimeoutMs });
    this.proc = null; this.port = 0; this.log = '';
  }

  async start(signal) {
    this.port = await freePort();
    const p = this.proc = this.spawnImpl(this.bin, serverArgs({ model: this.model, port: this.port, gpu: this.gpu }), { windowsHide: true });
    let exited = null;
    const grab = (b) => { this.log = (this.log + b.toString('utf8')).slice(-4000); };
    if (p.stdout) p.stdout.on('data', grab);
    if (p.stderr) p.stderr.on('data', grab);
    p.on('exit', (code) => { exited = code == null ? -1 : code; });
    p.on('error', (e) => { exited = -1; this.log += `\n${e.message}`; });
    const until = Date.now() + this.startTimeoutMs;
    while (Date.now() < until) {
      if (signal && signal.aborted) { this.stop(); const e = new Error('Остановлено'); e.code = 'ABORT'; throw e; }
      if (exited != null) throw new Error(`Нейросеть не запустилась (код ${exited}): ${this.tail()}`);
      try {
        const r = await this.fetchImpl(`http://127.0.0.1:${this.port}/health`);
        if (r.ok) return this;
      } catch { /* ещё не слушает */ }
      await sleep(400);
    }
    this.stop();
    throw new Error(`Нейросеть не успела загрузиться за ${Math.round(this.startTimeoutMs / 1000)} с: ${this.tail()}`);
  }

  tail() { return this.log.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300) || 'без сообщения'; }

  /** Оценка текста 0–10 или null, если ответ не разобрать. */
  async score(text) {
    const r = await this.fetchImpl(`http://127.0.0.1:${this.port}/completion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildPrompt(text), n_predict: 6, temperature: 0, cache_prompt: false, stop: ['<|im_end|>'] }),
    });
    if (!r.ok) throw new Error(`Нейросеть ответила HTTP ${r.status}`);
    const j = await r.json();
    return parseScore(j.content);
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch { /* уже завершён */ } this.proc = null; } }
}

module.exports = { LLM_MODELS, pickLlamaAssets, llamaAssets, serverArgs, momentText, buildPrompt, parseScore, llmBonus, LlmServer };
