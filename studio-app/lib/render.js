'use strict';
// Аргументы ffmpeg для рендера ролика и обложки + разбор прогресса. Запуск — в tools.js.

const ENCODERS = {
  cpu: { name: 'Процессор (x264)', args: (q) => ['-c:v', 'libx264', '-preset', q === 'fast' ? 'veryfast' : 'medium', '-crf', q === 'fast' ? '22' : '19'] },
  nvenc: { name: 'NVIDIA (NVENC)', args: (q) => ['-c:v', 'h264_nvenc', '-preset', q === 'fast' ? 'p4' : 'p6', '-rc', 'vbr', '-cq', q === 'fast' ? '23' : '20', '-b:v', '0'] },
  qsv: { name: 'Intel (QuickSync)', args: (q) => ['-c:v', 'h264_qsv', '-global_quality', q === 'fast' ? '24' : '21'] },
  amf: { name: 'AMD (AMF)', args: (q) => ['-c:v', 'h264_amf', '-quality', q === 'fast' ? 'speed' : 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'] },
};

/**
 * o: input, start, end (секунды исходника), filter (из layout.buildFilter), output, encoder, quality, fps, loudnorm.
 * -ss до -i: быстрый переход; с перекодированием кадр точный.
 */
function renderArgs(o) {
  const enc = ENCODERS[o.encoder] || ENCODERS.cpu;
  const a = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  if (o.start != null) a.push('-ss', o.start.toFixed(3));
  if (o.end != null) a.push('-to', o.end.toFixed(3));
  a.push('-i', o.input);
  // мини-игра для раскладки filler: по кругу, со своего места, без звука
  if (o.filler) a.push('-stream_loop', '-1', '-ss', String(o.filler.offset || 0), '-i', o.filler.path);
  let filter = o.filter.filter;
  let aLabel = o.filter.aLabel;
  if (o.loudnorm && aLabel) {
    const src = aLabel === '0:a?' ? '[0:a]' : aLabel;
    filter += `;${src}loudnorm=I=-14:TP=-1.5:LRA=11[anorm]`;
    aLabel = '[anorm]';
  }
  a.push('-filter_complex', filter, '-map', o.filter.vLabel);
  if (aLabel) a.push('-map', aLabel);
  a.push(...enc.args(o.quality), '-r', String(o.fps || 30), '-pix_fmt', 'yuv420p');
  if (aLabel) a.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'); else a.push('-an');
  if (o.maxDur) a.push('-t', String(o.maxDur));
  a.push('-movflags', '+faststart', o.output);
  return a;
}

/** Обложка: кадр из готового ролика (уже с заголовком), JPEG 1080×1920. */
function coverArgs(video, out, at = 1) {
  return ['-hide_banner', '-y', '-nostdin', '-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '2', out];
}

/** Кадр исходника для предпросмотра/выбора рамки вебки (в stdout как JPEG). */
function frameArgs(input, at, width = 1280) {
  return ['-hide_banner', '-nostdin', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'];
}

/** Звук для поиска моментов: моно 8 кГц PCM в stdout. */
function envelopeArgs(input) {
  return ['-hide_banner', '-nostdin', '-i', input, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'];
}

/** Прогресс из `-progress pipe:1`: out_time_us → доля от длительности. */
function parseRenderProgress(chunk, durSec) {
  const m = /out_time_(?:us|ms)=(\d+)/g;
  let last = null, x;
  while ((x = m.exec(chunk))) last = parseInt(x[1], 10);
  if (last == null || !durSec) return null;
  return Math.max(0, Math.min(1, last / 1e6 / durSec));
}

/** Разбор ffprobe -show_streams -show_format -of json. */
function parseProbe(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const v = (o.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (o.streams || []).find((s) => s.codec_type === 'audio');
  let w = +v.width || 0, h = +v.height || 0;
  const rot = Math.abs(parseInt((v.tags && v.tags.rotate) || ((v.side_data_list || []).find((s) => s.rotation != null) || {}).rotation || 0, 10));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  const [fn, fd] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  return { width: w, height: h, duration: parseFloat((o.format || {}).duration || v.duration || 0) || 0, fps: fd ? fn / fd : 30, hasAudio: !!a };
}

module.exports = { ENCODERS, renderArgs, coverArgs, frameArgs, envelopeArgs, parseRenderProgress, parseProbe };
