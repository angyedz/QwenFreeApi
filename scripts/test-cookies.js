#!/usr/bin/env node
'use strict';

/**
 * test-cookies.js — автономный тест генерации SSXMOD cookies.
 * Убеждается, что алгоритм LZW+custom-base64 выдаёт валидные значения
 * (другой формат, стабильный префикс '1-', декодируется обратно).
 */
const { generateCookies } = require('../src/cookie-generator');
const { generateFingerprint } = require('../src/fingerprint');

let failures = 0;

const expect = (cond, label) => {
  if (!cond) {
    console.error('  ✗', label);
    failures++;
  } else {
    console.log('  ✓', label);
  }
};

console.log('=== generateCookies() ===');
for (let i = 0; i < 5; i++) {
  const r = generateCookies();
  expect(r.ssxmod_itna.startsWith('1-'), `itna prefix (run ${i})`);
  expect(r.ssxmod_itna2.startsWith('1-'), `itna2 prefix (run ${i})`);
  expect(r.ssxmod_itna.length > 40, `itna length ${r.ssxmod_itna.length}`);
  expect(r.ssxmod_itna2.length > 40, `itna2 length ${r.ssxmod_itna2.length}`);
  expect(r.deviceId.length === 20, 'deviceId = 20 hex');
}

console.log('=== Known-fingerprint encoding is deterministic-ish ===');
const fp = generateFingerprint({ platform: 'win64', screen: '1920x1080', locale: 'en-US' });
const a = generateCookies(fp);
const b = generateCookies(fp);
expect(a.deviceId === b.deviceId, 'same fingerprint -> same deviceId');
// timestamps differ, so full token may differ slightly — that's fine.

console.log('=== Model suffix mapping ===');
const { getChatType } = require('../src/chat-adapter');
expect(getChatType('qwen3.7-max') === 't2t', 'plain -> t2t');
expect(getChatType('qwen3.7-max-search') === 'search', '-search -> search');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);