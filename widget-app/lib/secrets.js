'use strict';
// Шифрование секрета для GitHub Actions: libsodium sealed box (crypto_box_seal), как требует GitHub API.
// nonce = blake2b(эфемерный_ключ || ключ_репозитория, 24 байта), шифр = crypto_box, ответ = эфемерный_ключ || шифр.
const nacl = require('tweetnacl');
const { blake2b } = require('blakejs');

function sealNonce(epk, pk) {
  const both = new Uint8Array(epk.length + pk.length);
  both.set(epk); both.set(pk, epk.length);
  return blake2b(both, undefined, nacl.box.nonceLength);
}

/** Зашифровать строку открытым ключом репозитория (base64). Возвращает base64. */
function seal(publicKeyB64, value) {
  const pk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  if (pk.length !== nacl.box.publicKeyLength) throw new Error('Неверный открытый ключ репозитория.');
  const eph = nacl.box.keyPair();
  const box = nacl.box(new Uint8Array(Buffer.from(String(value), 'utf8')), sealNonce(eph.publicKey, pk), pk, eph.secretKey);
  const out = new Uint8Array(eph.publicKey.length + box.length);
  out.set(eph.publicKey); out.set(box, eph.publicKey.length);
  return Buffer.from(out).toString('base64');
}

/** Расшифровать (только для тестов: у GitHub закрытый ключ, у нас его нет). */
function open(sealedB64, publicKeyB64, secretKey) {
  const all = new Uint8Array(Buffer.from(sealedB64, 'base64'));
  const pk = new Uint8Array(Buffer.from(publicKeyB64, 'base64'));
  const epk = all.slice(0, nacl.box.publicKeyLength);
  const msg = nacl.box.open(all.slice(nacl.box.publicKeyLength), sealNonce(epk, pk), epk, secretKey);
  return msg ? Buffer.from(msg).toString('utf8') : null;
}

module.exports = { seal, open };
