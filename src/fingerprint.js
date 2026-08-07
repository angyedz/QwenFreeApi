'use strict';

/**
 * Генератор 37-field browser fingerprint для Qwen SSXMOD.
 * Поля соединяются через '^'. Определённые хэш-поля рандомизируются,
 * потому что сервер не сверяет их точное значение (требует лишь валидной структуры).
 *
 * Актуальный FE шаблон websdk-2.3.15d / Apple-платформы — эталонный RN клиента.
 */

const DEFAULT_TEMPLATE = {
  deviceId: '84985177a19a010dea49',
  sdkVersion: 'websdk-2.3.15d',
  initTimestamp: '1765348410850',
  field3: '91',
  field4: '1|15',
  language: 'zh-CN',
  timezoneOffset: '-480',
  colorDepth: '16705151|12791',
  screenInfo: '1470|956|283|797|158|0|1470|956|1470|798|0|0',
  field9: '5',
  platform: 'MacIntel',
  field11: '10',
  webglRenderer:
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
  field13: '30|30',
  field14: '0',
  field15: '28',
  pluginCount: '5',
  vendor: 'Google Inc.',
  field29: '8',
  touchInfo: '-1|0|0|0|0',
  field32: '11',
  field35: '0',
  mode: 'P',
};

const SCREEN_PRESETS = {
  '1920x1080': '1920|1080|283|1080|158|0|1920|1080|1920|922|0|0',
  '2560x1440': '2560|1440|283|1440|158|0|2560|1440|2560|1282|0|0',
  '1470x956': '1470|956|283|797|158|0|1470|956|1470|798|0|0',
  '1440x900': '1440|900|283|900|158|0|1440|900|1440|742|0|0',
  '1536x864': '1536|864|283|864|158|0|1536|864|1536|706|0|0',
};

const PLATFORM_PRESETS = {
  macIntel: {
    platform: 'MacIntel',
    webglRenderer:
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
    vendor: 'Google Inc.',
  },
  macM1: {
    platform: 'MacIntel',
    webglRenderer:
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)|Google Inc. (Apple)',
    vendor: 'Google Inc.',
  },
  win64: {
    platform: 'Win32',
    webglRenderer:
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)|Google Inc. (NVIDIA)',
    vendor: 'Google Inc.',
  },
  linux: {
    platform: 'Linux x86_64',
    webglRenderer:
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)|Google Inc. (Intel)',
    vendor: 'Google Inc.',
  },
};

const LANGUAGE_PRESETS = {
  'zh-CN': { language: 'zh-CN', timezoneOffset: '-480' },
  'zh-TW': { language: 'zh-TW', timezoneOffset: '-480' },
  'en-US': { language: 'en-US', timezoneOffset: '480' },
  'ja-JP': { language: 'ja-JP', timezoneOffset: '-540' },
  'ko-KR': { language: 'ko-KR', timezoneOffset: '-540' },
};

const generateDeviceId = () =>
  Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

const generateHash = () => Math.floor(Math.random() * 4294967296);

/**
 * Собрать 37-полевый fingerprint.
 * @param {Object} [options]
 * @returns {string} поля через '^'
 */
function generateFingerprint(options = {}) {
  const config = { ...DEFAULT_TEMPLATE };

  if (options.platform && PLATFORM_PRESETS[options.platform]) {
    Object.assign(config, PLATFORM_PRESETS[options.platform]);
  }
  if (options.screen && SCREEN_PRESETS[options.screen]) {
    config.screenInfo = SCREEN_PRESETS[options.screen];
  }
  if (options.locale && LANGUAGE_PRESETS[options.locale]) {
    Object.assign(config, LANGUAGE_PRESETS[options.locale]);
  }
  if (options.custom) {
    Object.assign(config, options.custom);
  }

  const deviceId = options.deviceId || generateDeviceId();
  const currentTimestamp = Date.now();

  const fields = [
    deviceId, // 0
    config.sdkVersion, // 1
    config.initTimestamp, // 2
    config.field3, // 3
    config.field4, // 4
    config.language, // 5
    config.timezoneOffset, // 6
    config.colorDepth, // 7
    config.screenInfo, // 8
    config.field9, // 9
    config.platform, // 10
    config.field11, // 11
    config.webglRenderer, // 12
    config.field13, // 13
    config.field14, // 14
    config.field15, // 15
    `${config.pluginCount}|${generateHash()}`, // 16
    generateHash(), // 17 canvas
    generateHash(), // 18 ua hash1
    '1', // 19
    '0', // 20
    '1', // 21
    '0', // 22
    config.mode, // 23
    '0', // 24
    '0', // 25
    '0', // 26
    '416', // 27
    config.vendor, // 28
    config.field29, // 29
    config.touchInfo, // 30
    generateHash(), // 31 ua hash2
    config.field32, // 32
    currentTimestamp, // 33
    generateHash(), // 34 url hash
    config.field35, // 35
    Math.floor(Math.random() * 91) + 10, // 36 doc hash
  ];

  return fields.join('^');
}

function generateFingerprintBatch(count, options = {}) {
  return Array.from({ length: count }, () => generateFingerprint(options));
}

function generateFingerprintProb(options) {
  // sdkVersion per platform stays aligned — just return one fingerprint.
  return generateFingerprint(options);
}

module.exports = {
  generateFingerprint,
  generateFingerprintBatch,
  generateFingerprintProb,
  generateDeviceId,
  generateHash,
  DEFAULT_TEMPLATE,
  SCREEN_PRESETS,
  PLATFORM_PRESETS,
  LANGUAGE_PRESETS,
};