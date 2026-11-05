'use strict';
const assert = require('assert');
const t = require('../lib/tiktok');

const creator = { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], duet_disabled: true };
const good = { title: 'Привет', privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: true, allow_stitch: false,
  commercial: { on: false }, consent: true };

// форма без приватности/согласия не проходит, значения по умолчанию нет
assert.ok(t.validate({ ...good, privacy_level: '' }, creator).length);
assert.ok(t.validate({ ...good, consent: false }, creator).length);
assert.ok(t.validate({ ...good, title: '  ' }, creator).length);
assert.ok(t.validate({ ...good, privacy_level: 'FRIENDS' }, creator).length);
assert.deepStrictEqual(t.validate(good, creator), []);

// коммерческий контент: нужен тип; брендированный не может быть приватным
assert.ok(t.validate({ ...good, commercial: { on: true } }, creator).length);
assert.ok(t.validate({ ...good, privacy_level: 'SELF_ONLY', commercial: { on: true, branded: true } }, creator).length);
assert.deepStrictEqual(t.validate({ ...good, commercial: { on: true, your_brand: true } }, creator), []);

// настройки: выключено по умолчанию, отключённое автором всегда выключено
const s = t.toSettings(good, creator);
assert.strictEqual(s.disable_comment, false);
assert.strictEqual(s.disable_duet, true); // creator_info: duet_disabled
assert.strictEqual(s.disable_stitch, true);
assert.strictEqual(s.consent, true);
assert.throws(() => t.toSettings({ ...good, consent: false }, creator));
assert.strictEqual(t.toSettings({ ...good, commercial: { on: false, branded: true } }, creator).commercial.branded, false);

// согласие и метки
assert.strictEqual(t.consentText({ on: true, branded: true }).links.length, 2);
assert.strictEqual(t.consentText({ on: false }).links.length, 1);
assert.match(t.commercialLabel({ on: true, branded: true }), /Платное партнёрство/);
assert.match(t.commercialLabel({ on: true, your_brand: true }), /собственного бренда/);
assert.deepStrictEqual(t.privacyOptions(creator).map((o) => o.value), ['SELF_ONLY', 'PUBLIC_TO_EVERYONE']);

// какие рилсы ждут подтверждения
const accounts = [{ name: 'ig1' }, { name: 'evelon185', platform: 'tiktok', mode: 'direct' }, { name: 'ink', platform: 'tiktok', mode: 'inbox' }];
const queue = [{ name: '001_a', videos: ['s1.mp4', 's2.mp4', 'evelon185/s3.mp4', 'ig1/s4.mp4'], tiktok: ['s2.tiktok.json'] }];
const state = { posted_acc: { evelon185: { '001_a/s1.mp4': {} } }, skipped: {} };
assert.deepStrictEqual(t.pendingConfirm(queue, state, accounts).map((p) => p.video), ['evelon185/s3.mp4']);
assert.strictEqual(t.pendingConfirm(queue, {}, accounts)[0].path, 'queue/001_a/s1.tiktok.json');
assert.strictEqual(t.pendingConfirm(queue, {}, [{ name: 'ig1' }]).length, 0);
assert.strictEqual(t.pendingConfirm(queue, { skipped: { 'evelon185|001_a/s1.mp4': 'x' } }, accounts).some((p) => p.video === 's1.mp4'), false);
console.log('tiktok tests ok');
