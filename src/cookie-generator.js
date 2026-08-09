'use strict';

/**
 * Генератор SSXMOD-cookie для Qwen (ssxmod_itna / ssxmod_itna2).
 * Эти два cookie — «отпечаток устройства», который сервер Alibaba принимает
 * как доказательство реального браузера. Генерируются в чистом JS:
 * fingerprint (37 полей) -> LZW-compress -> custom-base64 -> "1-<encoded>".
 *
 * Алгоритм сверен с рабочим reverse-engineered референсом (Rfym21/Qwen2API).
 */

const { generateFingerprint } = require('./fingerprint');

// Позиции хэш-полей, которые должен рандомизировать (не проверяются по содержанию).
const HASH_FIELDS = {
  16: 'split', //  plugins hash (count|hash) — заменяем hash
  17: 'full', //  canvas hash
  18: 'full', //  UA hash1
  31: 'full', //  UA hash2
  34: 'full', //  URL hash
  36: 'full', //  doc hash
};

const CUSTOM_BASE64_CHARS = 'DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ';

// ==================== LZW ====================
function lzwCompress(data, bits, charFunc) {
  if (data == null) return '';

  const dict = {};
  const dictToCreate = {};
  let wc = '';
  let w = '';
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const result = [];
  let value = 0;
  let position = 0;

  const pushBits = (bitCount, fill) => {
    for (let j = 0; j < bitCount; j++) {
      value = (value << 1) | (fill & 1);
      if (position === bits - 1) {
        position = 0;
        result.push(charFunc(value));
        value = 0;
      } else {
        position++;
      }
      fill >>= 1;
    }
  };

  for (let i = 0; i < data.length; i++) {
    const c = data.charAt(i);
    if (!Object.prototype.hasOwnProperty.call(dict, c)) {
      dict[c] = dictSize++;
      dictToCreate[c] = true;
    }

    wc = w + c;
    if (Object.prototype.hasOwnProperty.call(dict, wc)) {
      w = wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
        if (w.charCodeAt(0) < 256) {
          pushBits(numBits, 0);
          pushBits(8, w.charCodeAt(0));
        } else {
          pushBits(numBits, 1);
          pushBits(16, w.charCodeAt(0));
        }
        enlargeIn--;
        if (enlargeIn === 0) {
          enlargeIn = Math.pow(2, numBits);
          numBits++;
        }
        delete dictToCreate[w];
      } else {
        pushBits(numBits, dict[w]);
      }

      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }

      dict[wc] = dictSize++;
      w = String(c);
    }
  }

  if (w !== '') {
    if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
      if (w.charCodeAt(0) < 256) {
        pushBits(numBits, 0);
        pushBits(8, w.charCodeAt(0));
      } else {
        pushBits(numBits, 1);
        pushBits(16, w.charCodeAt(0));
      }
      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }
      delete dictToCreate[w];
    } else {
      pushBits(numBits, dict[w]);
    }
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }

  // Конец потока
  pushBits(numBits, 2);
  while (true) {
    value = value << 1;
    if (position === bits - 1) {
      result.push(charFunc(value));
      break;
    }
    position++;
  }

  return result.join('');
}

function customEncode(data, urlSafe) {
  if (data == null) return '';
  const compressed = lzwCompress(data, 6, (index) => CUSTOM_BASE64_CHARS.charAt(index));
  if (!urlSafe) {
    switch (compressed.length % 4) {
      case 1:
        return compressed + '===';
      case 2:
        return compressed + '==';
      case 3:
        return compressed + '=';
      default:
        return compressed;
    }
  }
  return compressed;
}

// ==================== Обработка fingerprint ====================
const randomHash = () => Math.floor(Math.random() * 4294967296);

function processFields(fields) {
  const processed = [...fields];
  const currentTimestamp = Date.now();

  for (const [index, type] of Object.entries(HASH_FIELDS)) {
    const idx = parseInt(index, 10);
    if (type === 'split') {
      const parts = String(processed[idx]).split('|');
      if (parts.length === 2) {
        processed[idx] = `${parts[0]}|${randomHash()}`;
      }
    } else if (type === 'full') {
      if (idx === 36) {
        processed[idx] = Math.floor(Math.random() * 91) + 10;
      } else {
        processed[idx] = randomHash();
      }
    }
  }

  processed[33] = currentTimestamp;
  return processed;
}

/**
 * Сгенерировать пару ssxmod cookies.
 * @param {string} [fingerprint] - готовый 37-пол. fingerprint (или сгенерить).
 * @param {Object} [opts] - опции fingerprint (platform/screen/locale).
 */
function generateCookies(fingerprint = null, opts = {}) {
  const fp = fingerprint || generateFingerprint(opts);
  const fields = fp.split('^');
  const processed = processFields(fields);

  const itnaData = processed.join('^');
  const ssxmod_itna = '1-' + customEncode(itnaData, true);

  // ssxmod_itna2 = подмножество полей (18)
  const itna2Data = [
    processed[0], // deviceId
    processed[1], // sdkVersion
    processed[23], // mode
    0,
    '',
    0,
    '',
    '',
    0,
    0,
    0,
    processed[32], // 11
    processed[33], // timestamp
    0,
    0,
    0,
    0,
    0,
  ].join('^');
  const ssxmod_itna2 = '1-' + customEncode(itna2Data, true);

  return {
    ssxmod_itna,
    ssxmod_itna2,
    timestamp: parseInt(processed[33], 10),
    deviceId: processed[0],
    rawData: itnaData,
    rawData2: itna2Data,
  };
}

function generateBatch(count = 10, fingerprint = null, opts = {}) {
  return Array.from({ length: count }, () => generateCookies(fingerprint, opts));
}

module.exports = { generateCookies, generateBatch, customEncode, randomHash };

// CLI smoke: node src/cookie-generator.js
if (require.main === module) {
  const { generateCookies } = module.exports;
  const r = generateCookies();
  console.log('ssxmod_itna :', r.ssxmod_itna.slice(0, 80) + '…');
  console.log('ssxmod_itna2:', r.ssxmod_itna2.slice(0, 80) + '…');
  console.log('deviceId    :', r.deviceId, '| timestamp:', r.timestamp);
}