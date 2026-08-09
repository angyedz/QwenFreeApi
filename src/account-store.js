'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logger } = require('./util');

let accounts = new Map();
let activeId = null;
let cursor = 0;

function safeId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return id || `account-${Date.now()}`;
}

function accountPath(id) {
  return path.join(config.ACCOUNTS_DIR, `${safeId(id)}.json`);
}

function normalize(data, id) {
  return {
    ...data,
    id: safeId(data.id || id),
    email: data.email || data.id || 'unknown',
    failures: Number(data.failures || 0),
    unavailableUntil: Number(data.unavailableUntil || 0),
    lastError: data.lastError || '',
    lastUsedAt: Number(data.lastUsedAt || 0),
  };
}

function persist(account) {
  fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(accountPath(account.id), JSON.stringify(account, null, 2), 'utf8');
}

function migrateLegacy() {
  if (!fs.existsSync(config.ACCOUNT_FILE)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(config.ACCOUNT_FILE, 'utf8'));
    if (legacy && legacy.token) {
      const account = normalize(legacy, legacy.id || legacy.email || 'account-1');
      accounts.set(account.id, account);
      persist(account);
      fs.renameSync(config.ACCOUNT_FILE, `${config.ACCOUNT_FILE}.migrated`);
      logger.info(`Legacy account migrated to config/accounts/${account.id}.json`, 'ACCOUNT');
    }
  } catch (err) {
    logger.warn(`Could not migrate legacy account: ${err.message}`, 'ACCOUNT');
  }
}

function load() {
  accounts = new Map();
  fs.mkdirSync(config.ACCOUNTS_DIR, { recursive: true });
  migrateLegacy();
  for (const file of fs.readdirSync(config.ACCOUNTS_DIR).filter((name) => name.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(config.ACCOUNTS_DIR, file), 'utf8'));
      if (raw && raw.token) {
        const account = normalize(raw, path.basename(file, '.json'));
        accounts.set(account.id, account);
      }
    } catch (err) {
      logger.warn(`Skipping invalid account ${file}: ${err.message}`, 'ACCOUNT');
    }
  }
  if (activeId && !accounts.has(activeId)) activeId = null;
  if (!activeId) activeId = accounts.keys().next().value || null;
  return current();
}

function reset(account) {
  const target = typeof account === 'string' ? get(account) : account || current();
  if (!target) return null;
  target.failures = 0;
  target.unavailableUntil = 0;
  target.lastError = '';
  persist(target);
  return target;
}

function save(data, requestedId) {
  let explicitId = requestedId || (data && data.id);
  // Если пришёл дефолтный служебный ID (playwright-capture / manual) без явного requestedId —
  // не перезаписывать существующих пользователей, а создать новый уникальный account-N
  if (!requestedId && (explicitId === 'playwright-capture' || explicitId === 'manual')) {
    explicitId = null;
  }
  let id = explicitId || `account-${accounts.size + 1}`;
  let nextNumber = accounts.size + 1;
  while (!explicitId && accounts.has(safeId(id))) {
    id = `account-${++nextNumber}`;
  }
  const account = normalize(data, id);
  accounts.set(account.id, account);
  persist(account);
  activeId = account.id;
  logger.info(`Account ${account.id} saved`, 'ACCOUNT');
  return account;
}

function list() {
  return [...accounts.values()].map((account) => ({
    id: account.id,
    email: account.email,
    token: account.token || '',
    savedAt: account.savedAt,
    failures: account.failures || 0,
    unavailableUntil: account.unavailableUntil || 0,
    lastError: account.lastError || '',
    lastUsedAt: account.lastUsedAt || 0,
    active: account.id === activeId,
    available: isAvailable(account),
  }));
}

function isAvailable(account) {
  return Boolean(account && account.token && (!account.unavailableUntil || account.unavailableUntil <= Date.now()));
}

function get(id) { return accounts.get(safeId(id)) || null; }
function current() { return activeId ? accounts.get(activeId) || null : null; }
function isAccount() { return Boolean(current() && current().token); }

function select(id) {
  const account = get(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  activeId = account.id;
  return account;
}

function candidates() {
  let all = [...accounts.values()].filter(isAvailable);
  if (!all.length && accounts.size > 0) {
    all = [...accounts.values()].filter((a) => Boolean(a && a.token));
  }
  if (!all.length) return [];
  const active = current();
  if (active && isAvailable(active)) {
    return [active, ...all.filter((a) => a.id !== active.id)];
  }
  return all.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
}

function markSuccess(account) {
  if (!account) return;
  account.failures = 0;
  account.unavailableUntil = 0;
  account.lastError = '';
  account.lastUsedAt = Date.now();
  activeId = account.id;
  persist(account);
}

function markFailure(account, error, permanent = false) {
  if (!account) return;
  account.failures = Number(account.failures || 0) + 1;
  account.lastError = String(error || 'Request failed').slice(0, 240);
  let backoff;
  if (String(error).includes('RateLimited')) {
    backoff = 6 * 60 * 60 * 1000;
  } else if (permanent) {
    backoff = 30 * 60 * 1000;
  } else {
    backoff = Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** Math.min(account.failures - 1, 5));
  }
  account.unavailableUntil = Date.now() + backoff;
  persist(account);
  if (activeId === account.id) {
    const next = candidates().find((candidate) => candidate.id !== account.id);
    if (next) activeId = next.id;
  }
}

function buildCookieHeader(account, ssxmodItna, ssxmodItna2) {
  // Keep the old buildCookieHeader(ssxmodItna, ssxmodItna2) call working.
  if (typeof account === 'string' || account == null) {
    ssxmodItna2 = ssxmodItna;
    ssxmodItna = account;
    account = current();
  }
  const target = account || current();
  if (!target) return '';
  const parts = [];
  if (target.token) parts.push(`token=${target.token}`);
  if (Array.isArray(target.cookie)) {
    for (const c of target.cookie) {
      if (!c || !c.name || c.name === 'token' || c.name.startsWith('ssxmod')) continue;
      parts.push(`${c.name}=${c.value}`);
    }
  }
  if (ssxmodItna) parts.push(`ssxmod_itna=${ssxmodItna}`);
  if (ssxmodItna2) parts.push(`ssxmod_itna2=${ssxmodItna2}`);
  return parts.join(';');
}

function remove(id) {
  const target = get(id);
  if (!target) return false;
  accounts.delete(target.id);
  const file = accountPath(target.id);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
  if (activeId === target.id) {
    activeId = accounts.keys().next().value || null;
  }
  return true;
}

module.exports = { save, load, list, get, current, candidates, select, reset, remove, markSuccess, markFailure, isAccount, isAvailable, buildCookieHeader };
