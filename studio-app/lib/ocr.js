'use strict';
// Чтение текста с кадров (иксы, суммы, плашки WIN) без ключей и интернета: tesseract.js с английскими данными из пакета.
// В собранной программе файлы лежат в app.asar.unpacked (см. asarUnpack в package.json).
const path = require('path');

const unpackedPath = (p) => String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

/** Папка с eng.traineddata.gz или null, если пакет не установлен. */
function langDir() {
  try { return path.dirname(unpackedPath(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))); } catch { return null; }
}

/** Есть ли чем читать экран (пакеты на месте). */
function ocrAvailable() {
  try { require.resolve('tesseract.js'); return !!langDir(); } catch { return false; }
}

// только то, что бывает на плашках выигрыша: цифры, латиница, разделители и знаки валют
const WHITELIST = '0123456789xXWINMAGEPUSRBOFYLKTHDCVJZQ abcdefghijklmnopqrstuvwxyz.,:$€>\'';

class OcrReader {
  constructor() { this.worker = null; }

  async open() {
    if (this.worker) return this;
    const { createWorker } = require('tesseract.js');
    const dir = langDir();
    if (!dir) throw new Error('Нет данных распознавания текста (@tesseract.js-data/eng)');
    let workerPath;
    try { workerPath = unpackedPath(require.resolve('tesseract.js/src/worker-script/node/index.js')); } catch { /* путь по умолчанию */ }
    this.worker = await createWorker('eng', 1, {
      langPath: dir, gzip: true, cacheMethod: 'none', logger: () => {}, errorHandler: () => {},
      ...(workerPath ? { workerPath } : {}),
    });
    await this.worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: WHITELIST });
    return this;
  }

  /** Текст кадра (путь к jpg/png). */
  async read(file) {
    if (!this.worker) await this.open();
    const r = await this.worker.recognize(file);
    return String((r.data && r.data.text) || '');
  }

  async close() { if (this.worker) { try { await this.worker.terminate(); } catch { /* уже закрыт */ } this.worker = null; } }
}

module.exports = { OcrReader, ocrAvailable, langDir, unpackedPath };
