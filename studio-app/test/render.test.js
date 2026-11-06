'use strict';
const assert = require('assert');
const R = require('../lib/render');
const L = require('../lib/layout');

const f = L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080 });
const a = R.renderArgs({ input: 'in.mp4', start: 10, end: 40.5, filter: f, output: 'o.mp4', encoder: 'nvenc', quality: 'best', loudnorm: true });
const s = a.join(' ');
assert.ok(s.includes('-ss 10.000 -to 40.500 -i in.mp4'), 'быстрый переход до -i');
assert.ok(s.includes('-c:v h264_nvenc'));
assert.ok(s.includes('[0:a]loudnorm=I=-14'), 'громкость под TikTok');
assert.ok(s.includes('-map [anorm]'));
assert.ok(s.endsWith('-movflags +faststart o.mp4'));
assert.ok(R.renderArgs({ input: 'i', filter: f, output: 'o' }).includes('libx264'), 'по умолчанию процессор');
const nf = L.buildFilter({ layout: 'crop', srcW: 1920, srcH: 1080, hasAudio: false });
const na = R.renderArgs({ input: 'i', filter: nf, output: 'o', loudnorm: true }).join(' ');
assert.ok(na.includes('-an') && !na.includes('loudnorm'), 'без звука');
const fl = R.renderArgs({ input: 'i', filter: f, output: 'o', filler: { path: 'g.mp4', offset: 12 }, maxDur: '30' }).join(' ');
assert.ok(fl.includes('-i i -stream_loop -1 -ss 12 -i g.mp4'), 'мини-игра вторым входом по кругу');
assert.ok(fl.includes('-t 30'));
assert.deepStrictEqual(R.coverArgs('v.mp4', 'c.jpg', 2).slice(-6), ['-i', 'v.mp4', '-frames:v', '1', '-q:v', '2', 'c.jpg'].slice(-6));
assert.ok(R.frameArgs('i', 5).includes('pipe:1'));
assert.ok(R.envelopeArgs('i').join(' ').includes('-ac 1 -ar 8000 -f s16le pipe:1'));
assert.strictEqual(R.parseRenderProgress('frame=1\nout_time_us=5000000\nout_time_us=15000000\n', 30), 0.5);
assert.strictEqual(R.parseRenderProgress('nothing', 30), null);
const pr = R.parseProbe({ streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '60/1', tags: { rotate: '90' } }, { codec_type: 'audio' }], format: { duration: '12.5' } });
assert.deepStrictEqual(pr, { width: 1920, height: 1080, duration: 12.5, fps: 60, hasAudio: true });
assert.strictEqual(R.parseProbe({ streams: [] }).hasAudio, false);
for (const k of Object.keys(R.ENCODERS)) assert.ok(R.ENCODERS[k].args('fast').length > 2);

// потолок битрейта: 60 с влезают в 85 МБ, короткие — не выше 12 Мбит/с, длинные — не ниже 1.5 Мбит/с
assert.strictEqual(R.videoKbps(10), 12000);
const k60 = R.videoKbps(60);
assert.ok((k60 + 192) * 60 / 8 / 1024 <= 85 && k60 > 10000, `60 с: ${k60}`);
assert.ok((R.videoKbps(180) + 192) * 180 / 8 / 1024 <= 85, '3 минуты тоже влезают');
assert.strictEqual(R.videoKbps(100000), 1500);
for (const e of Object.keys(R.ENCODERS)) {
  const x = R.renderArgs({ input: 'i', filter: f, output: 'o', encoder: e, maxKbps: 9000 }).join(' ');
  assert.match(x, /-maxrate 9000k -bufsize 18000k/, `${e}: есть потолок`);
}
assert.match(R.renderArgs({ input: 'i', filter: f, output: 'o' }).join(' '), /-maxrate 12000k/, 'потолок по умолчанию');
console.log('рендер: 27 проверок');
