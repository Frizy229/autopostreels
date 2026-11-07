'use strict';
// Распознавание речи локально через whisper.cpp (whisper-cli.exe) с временем каждого слова.
// Здесь аргументы и разбор ответа; скачивание программы и модели — в tools.js.

const MODELS = {
  base: { file: 'ggml-base.bin', size: '142 МБ', note: 'быстро, хуже точность' },
  small: { file: 'ggml-small.bin', size: '466 МБ', note: 'хороший баланс' },
  medium: { file: 'ggml-medium.bin', size: '1.5 ГБ', note: 'точнее, нужна видеокарта' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', size: '1.6 ГБ', note: 'лучшее качество, нужна видеокарта' },
};
const modelUrl = (key) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${(MODELS[key] || MODELS.small).file}`;

/** Аргументы whisper-cli: по слову на сегмент (-ml 1 -sow), JSON на выходе. */
function whisperArgs({ model, wav, outBase, lang = 'ru', threads = 4, gpu = true, prompt = '' }) {
  const a = ['-m', model, '-f', wav, '-l', lang, '-ml', '1', '-sow', '-oj', '-of', outBase, '-t', String(threads), '-pp'];
  if (!gpu) a.push('-ng');
  if (prompt) a.push('--prompt', prompt);
  return a;
}

/** Звук для whisper: 16 кГц моно WAV, при нужде только кусок [start, end]. */
function wavArgs(input, out, start, end) {
  const a = ['-hide_banner', '-y'];
  if (start != null) a.push('-ss', String(start));
  if (end != null) a.push('-to', String(end));
  a.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  return a;
}

/**
 * Разбор JSON whisper.cpp → [{w, s, e}] в секундах (+ offset).
 * С -sow сегмент = слово; без него кусочки слов склеиваются (кусок без пробела в начале = продолжение).
 */
function parseWhisperJson(json, offset = 0) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const segs = (o && o.transcription) || [];
  const words = [];
  for (const seg of segs) {
    const raw = String(seg.text || '');
    if (!raw.trim() || /^\s*\[.*\]\s*$/.test(raw) || /^\s*\(.*\)\s*$/.test(raw)) continue; // [музыка], (смех)
    const from = (seg.offsets ? seg.offsets.from : 0) / 1000 + offset;
    const to = (seg.offsets ? seg.offsets.to : 0) / 1000 + offset;
    const glue = words.length && !/^\s/.test(raw) ;
    const isPunct = /^[\s]*[.,!?…:;»"')\]-]+$/.test(raw);
    if (words.length && (glue || isPunct)) {
      const last = words[words.length - 1];
      last.w += raw.trim();
      last.e = Math.max(last.e, to);
    } else {
      words.push({ w: raw.trim(), s: from, e: Math.max(from, to) });
    }
  }
  return words;
}

/** Подписи звука, которые whisper ставит вместо слов: [музыка], (смех), [аплодисменты]. Считаем, сколько каких. */
function whisperTags(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const tags = { music: 0, laugh: 0, applause: 0 };
  for (const seg of (o && o.transcription) || []) {
    const t = String(seg.text || '').trim();
    if (!/^[\[(♪*].*[\])♪*]$|^♪/.test(t)) continue;
    if (/музык|music|♪/i.test(t)) tags.music++;
    else if (/смех|смеет|смеёт|хохот|laugh/i.test(t)) tags.laugh++;
    else if (/аплодис|applause|clap/i.test(t)) tags.applause++;
  }
  return tags;
}

/** Текст из слов (для поиска/ИИ), с метками времени раз в ~15 с. */
function wordsToText(words, every = 15) {
  let out = '', last = -Infinity;
  for (const w of words) {
    if (w.s - last >= every) { out += `${out ? '\n' : ''}[${Math.floor(w.s)}] `; last = w.s; }
    out += w.w + ' ';
  }
  return out.trim();
}

module.exports = { MODELS, modelUrl, whisperArgs, wavArgs, parseWhisperJson, whisperTags, wordsToText };
