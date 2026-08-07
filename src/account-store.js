'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logger } = require('./util');

/**
 * Хранилище единственного аккаунта Qwen Chat.
 *
 * account.json:
 * {
 *   "token": "<JWT>",                // Bearer / cookie token
 *   "cookies": [                    //  остальные cookies из браузера (cna, acw_tc, ...)
 *     { "name":"cna", "value":"...", "domain":".qwen.ai", "path":"/" },
 *     ...
 *   ],
 *   "email": "user@example.com",
 *   "savedAt": 1786000000000
 * }
 */

let account = null;

function fileMustExist() {
  if (!fs.existsSync(config.ACCOUNT_FILE)) {
    throw new Error('config/account.json not found');
  }
}

/**
 * Собрать строку Cookie: name=value;name2=value2
 *   — первым всегда JWT token,
 *   — затем постоянные cookies из браузера,
 *   — живой ssxmod_itna / ssxmod_itna2 генерируются на каждый запрос (см. qwen-client).
 */
function buildCookieHeader(ssxmodItna, ssxmodItna2) {
  if (!account) return '';
  const parts = [];
  if (account.token) parts.push(`token=${account.token}`);
  if (Array.isArray(account.cookie)) {
    for (const c of account.cookie) {
      if (!c || !c.name || c.name === 'token' || c.name.startsWith('ssxmod')) {
        continue;
      }
      parts.push(`${c.name}=${c.value}`);
    }
  }
  if (ssxmodItna) parts.push(`ssxmod_itna=${ssxmodItna}`);
  if (ssxmodItna2) parts.push(`ssxmod_itna2=${ssxmodItna2}`);
  return parts.join(';');
}

function save(data) {
  fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
  account = data;
  fs.writeFileSync(config.ACCOUNT_FILE, JSON.stringify(data, null, 2), 'utf8');
  logger.info('Account saved to config/account.json', 'ACCOUNT');
  return account;
}

function load() {
  if (!fs.existsSync(config.ACCOUNT_FILE)) return null;
  account = JSON.parse(fs.readFileSync(config.ACCOUNT_FILE, 'utf8'));
  return account;
}

const current = () => account;
const isAccount = () => Boolean(account && account.token);

module.exports = { save, load, current, isAccount, buildCookieHeader };