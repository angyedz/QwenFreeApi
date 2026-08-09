'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { generateUUID, logger } = require('./util');

/**
 * Простое файловое хранилище чатов (по одному JSON на чат).
 * Путь: config/chats/<id>.json
 */

const CHATS_DIR = path.join(config.CONFIG_DIR, 'chats');

const ensureDir = () => fs.mkdirSync(CHATS_DIR, { recursive: true });

const chatFile = (id) => path.join(CHATS_DIR, `${id}.json`);

const safeId = (id) => /^[0-9a-f-]{36}$/.test(String(id || ''));

function list() {
  ensureDir();
  const chats = [];
  for (const name of fs.readdirSync(CHATS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, name), 'utf8'));
      if (raw && raw.id) {
        chats.push({
          id: raw.id,
          title: raw.title || 'Новый чат',
          model: raw.model || config.DEFAULT_MODEL,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
          messageCount: Array.isArray(raw.messages) ? raw.messages.length : 0,
        });
      }
    } catch (_) {
      /* skip corrupt */
    }
  }
  return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function get(id) {
  if (!safeId(id)) return null;
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(chatFile(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function create({ title, model, settings } = {}) {
  ensureDir();
  const now = Date.now();
  const chat = {
    id: generateUUID(),
    title: title || 'Новый чат',
    model: model || config.DEFAULT_MODEL,
    settings: settings || {},
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  save(chat);
  return chat;
}

function save(chat) {
  if (!chat || !safeId(chat.id)) return false;
  ensureDir();
  fs.writeFileSync(chatFile(chat.id), JSON.stringify(chat, null, 2));
  return true;
}

function update(id, patch) {
  const chat = get(id);
  if (!chat) return null;
  if (patch.title !== undefined) chat.title = patch.title;
  if (patch.model !== undefined) chat.model = patch.model;
  if (patch.settings !== undefined) chat.settings = patch.settings;
  if (Array.isArray(patch.messages)) chat.messages = patch.messages;
  chat.updatedAt = Date.now();
  save(chat);
  return chat;
}

function remove(id) {
  if (!safeId(id)) return false;
  ensureDir();
  try {
    fs.unlinkSync(chatFile(id));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { list, get, create, save, update, remove };
