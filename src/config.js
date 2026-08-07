'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const ACCOUNT_FILE = path.join(CONFIG_DIR, 'account.json');
const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');
const CACHE_FILE = path.join(CONFIG_DIR, 'models-cache.json');

const BASE_URL = 'https://chat.qwen.ai';

// SPA build id — Qwen требует совпадения версии фронта.
// Значение 0.2.83 сверено с живым FE (см. DevTools -> Network -> version).
const QWEN_WEB_VERSION = process.env.QWEN_WEB_VERSION || '0.2.83';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Модели по умолчанию (обновляются через npm run models).
const BASE_MODELS = [
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3-coder-plus',
  'qwen3-coder-flash',
];

/**
 * Модели: default + те, что подхвачены из config/models-cache.json.
 * Кэш создаётся командой `npm run models`.
 */
function loadModelCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.models) ? raw.models : null;
    if (list && list.length) return [...new Set([...BASE_MODELS, ...list])];
  } catch (_) {
    /* no cache */
  }
  return BASE_MODELS;
}

const MODELS = loadModelCache();

// Реальная модель по умолчанию в живом FE — qwen3.8-max, но через /v1 можно просить любую.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen3.8-max';

// Лимит размера JSON тела, которое принимает WAF (защита от агент-контекстов).
const MAX_PAYLOAD_BYTES = 128 * 1024;

const PORT = Number(process.env.PORT || 3265);

module.exports = {
  PROJECT_ROOT,
  CONFIG_DIR,
  ACCOUNT_FILE,
  ACCOUNTS_DIR,
  CACHE_FILE,
  BASE_URL,
  QWEN_WEB_VERSION,
  USER_AGENT,
  MODELS,
  DEFAULT_MODEL,
  MAX_PAYLOAD_BYTES,
  PORT,
};
