'use strict';
// Загрузка папки порциями: деление на коммиты, повтор, деление пополам при отказе GitHub.
const assert = require('assert');
const { splitBatches, explainPushError } = require('../lib/gitpush');
const { GitHub } = require('../lib/github');

const mb = (n) => Buffer.alloc(n * 1e6);
const files = { 'q/a.mp4': mb(30), 'q/b.mp4': mb(30), 'q/c.mp4': mb(5), 'q/a.txt': Buffer.from('x'), 'q/b.txt': Buffer.from('y') };

(async () => {
  // порции по размеру, мелкие файлы в конце, ничего не потеряно
  const b = splitBatches(files, 40e6, 6);
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(Object.keys(b[0]), ['q/a.mp4']);
  assert.strictEqual(b.reduce((n, x) => n + Object.keys(x).length, 0), 5);
  assert.ok(Object.keys(b.at(-1)).some((k) => k.endsWith('.txt')), 'тексты в последней порции');
  // лимит по числу файлов
  const many = {}; for (let i = 0; i < 25; i++) many[`q/s${i}.mp4`] = mb(1);
  assert.strictEqual(splitBatches(many, 1e9, 6).length, 5);
  assert.deepStrictEqual(splitBatches({}), []);
  // файл больше лимита идёт один
  assert.strictEqual(splitBatches({ a: mb(100), b: mb(1) }, 40e6, 6).length, 2);

  assert.ok(/слишком большую порцию/.test(explainPushError('Отправка отклонена: unpack index-pack failed')));
  assert.strictEqual(explainPushError('нужен токен'), 'нужен токен');

  // все порции отправлены отдельными коммитами
  const g = new GitHub('t', 'o/r'); g.retryMs = 0; g.batchBytes = 40e6;
  const sent = [];
  g.pushFn = async ({ files: f, message }) => { sent.push({ keys: Object.keys(f), message }); };
  const prog = [];
  await g.pushBatches(files, 'Новая папка', 3, (fr, t) => prog.push([fr, t]), 0.4);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent.flatMap((s) => s.keys).length, 5);
  assert.ok(/часть 2/.test(sent[1].message));
  assert.ok(prog.length === 2 && prog[1][0] > prog[0][0] && prog.every(([f]) => f >= 0.4 && f < 1));

  // сбой «index-pack failed» на большой порции -> повтор 3 раза, потом деление пополам
  const g2 = new GitHub('t', 'o/r'); g2.retryMs = 0;
  let calls = 0; const ok = [];
  g2.pushFn = async ({ files: f }) => {
    calls++;
    if (Object.keys(f).length > 1) throw new Error('Отправка отклонена: unpack index-pack failed');
    ok.push(...Object.keys(f));
  };
  await g2.pushBatches(files, 'T', 3, () => {});
  assert.strictEqual(ok.length, 5, 'все файлы отправлены по одному');
  assert.ok(calls > 5);

  // единственный файл не проходит -> понятная ошибка с именем и уже отправленным
  const g3 = new GitHub('t', 'o/r'); g3.retryMs = 0;
  g3.pushFn = async ({ files: f }) => { if (f['q/b.mp4']) throw new Error('unpack index-pack failed'); };
  await assert.rejects(() => g3.pushBatches(files, 'T', 3, () => {}), (e) => /q\/b\.mp4/.test(e.message) && /Повтори загрузку/.test(e.message));

  // ошибка токена не повторяется
  const g4 = new GitHub('t', 'o/r'); g4.retryMs = 0; let n4 = 0;
  g4.pushFn = async () => { n4++; throw new Error('GitHub не принял токен для записи'); };
  await assert.rejects(() => g4.pushBatches(files, 'T', 3, () => {}), /токен/);
  assert.strictEqual(n4, 1);
  console.log('batches ok');
})().catch((e) => { console.error(e); process.exit(1); });
