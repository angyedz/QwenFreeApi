'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.CONFIG_DIR, 'opencode-sessions.json');
let sessions = new Map();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    sessions = new Map(Object.entries(raw && raw.sessions ? raw.sessions : {}));
  } catch (_) {
    sessions = new Map();
  }
}

function persist() {
  fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
  const data = Object.fromEntries(sessions);
  fs.writeFileSync(FILE, JSON.stringify({ sessions: data }, null, 2), 'utf8');
}

function get(key) {
  return key ? sessions.get(String(key)) || null : null;
}

function getRecord(key) {
  if (!key) return null;
  const value = sessions.get(String(key));
  if (!value) return null;
  if (typeof value === 'string') return { chatId: value, awaitingCompactedHistory: false };
  return value;
}

function set(key, chatId, metadata = {}) {
  if (!key || !chatId) return;
  sessions.set(String(key), {
    chatId: String(chatId),
    awaitingCompactedHistory: Boolean(metadata.awaitingCompactedHistory),
    updatedAt: Date.now(),
  });
  persist();
}

function clear(key) {
  if (!key) return;
  sessions.delete(String(key));
  persist();
}

load();

module.exports = { get, getRecord, set, clear, load };
