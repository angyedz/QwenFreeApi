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
];

// Лимиты из авторизованного chat.qwen.ai /api/models (2026-08-07).
// Не подставляем значения для моделей, которых upstream не объявляет.
const MODEL_LIMITS = {
  'qwen3.8-max': { context: 1000000, output: 131072 },
  'qwen3.7-plus': { context: 1000000, output: 65536 },
  'qwen3.7-max': { context: 1000000, output: 81920 },
  'qwen3.8-max-preview': { context: 1000000, output: 65536 },
  'qwen3.6-plus': { context: 1000000, output: 65536 },
  'qwen3.6-max-preview': { context: 262144, output: 81920 },
  'qwen3.6-27b': { context: 262144, output: 81920 },
  'qwen3.5-plus': { context: 1000000, output: 65536 },
  'qwen3.5-omni-plus': { context: 262144, output: 65536 },
  'qwen3.6-35b-a3b': { context: 262144, output: 81920 },
  'qwen3.5-flash': { context: 1000000, output: 65536 },
  'qwen3.5-397b-a17b': { context: 262144, output: 65536 },
  'qwen3.5-omni-flash': { context: 262144, output: 65536 },
  'qwen3-max-2026-01-23': { context: 262144, output: 32768 },
  'qwen-plus-2025-07-28': { context: 131072, output: 81920 },
  'qwen3-coder-plus': { context: 1048576, output: 65536 },
  'qwen3-vl-plus': { context: 262144, output: 81920 },
  'qwen3-omni-flash-2025-12-01': { context: 65536, output: 13684 },
};

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
const MAX_PAYLOAD_BYTES = Number(process.env.MAX_PAYLOAD_BYTES || 16 * 1024 * 1024);

// Keep agent prompts bounded: tool output can otherwise be copied into every
// following Qwen request and make the upstream close before producing SSE.
const AGENT_HISTORY_MAX_CHARS = Number(process.env.AGENT_HISTORY_MAX_CHARS || 12000);
const AGENT_MESSAGE_MAX_CHARS = Number(process.env.AGENT_MESSAGE_MAX_CHARS || 3000);

const PORT = Number(process.env.PORT || 3265);
// Если Qwen перестал присылать SSE, запрос не должен зависать навсегда.
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.STREAM_IDLE_TIMEOUT_MS || 180000);

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
  MODEL_LIMITS,
  DEFAULT_MODEL,
  MAX_PAYLOAD_BYTES,
  AGENT_HISTORY_MAX_CHARS,
  AGENT_MESSAGE_MAX_CHARS,
  PORT,
  STREAM_IDLE_TIMEOUT_MS,
};
