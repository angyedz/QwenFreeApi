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
  const previous = getRecord(key);
  sessions.set(String(key), {
    chatId: String(chatId),
    accountId: metadata.accountId || (previous ? previous.accountId : undefined),
    awaitingCompactedHistory: Boolean(metadata.awaitingCompactedHistory),
    toolPromptHash: metadata.toolPromptHash !== undefined
      ? metadata.toolPromptHash
      : (previous ? previous.toolPromptHash : undefined),
    history: Array.isArray(metadata.history) && metadata.history.length > 0
      ? metadata.history
      : (previous && Array.isArray(previous.history) ? previous.history : undefined),
    updatedAt: Date.now(),
  });
  persist();
}

function clear(key) {
  if (!key) return;
  sessions.delete(String(key));
  persist();
}

// ---------- Local context checkpoint ----------
// OpenCode normally resends the whole message array every turn, but some
// clients only send the latest turn. Keep a bounded checkpoint per session so
// a partial request can still recover the prior conversation. Tool/skill
// output is carried through as data only; it is never treated as instructions.
const CHECKPOINT_MAX_MESSAGES = 24;
const CHECKPOINT_MAX_CHARS = 60000;
const CHECKPOINT_MESSAGE_MAX_CHARS = 12000;

function boundCheckpointContent(content) {
  if (typeof content === 'string') {
    if (content.length <= CHECKPOINT_MESSAGE_MAX_CHARS) return content;
    return `${content.slice(0, CHECKPOINT_MESSAGE_MAX_CHARS)}\n...[checkpoint truncated]`;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return boundCheckpointContent(part);
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        return { ...part, text: boundCheckpointContent(part.text) };
      }
      return part;
    });
  }
  return content;
}

function checkpointMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  let list = messages
    .filter((m) => m && typeof m === 'object' && m.role)
    .map((m) => {
      const entry = { role: m.role, content: boundCheckpointContent(m.content) };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) entry.tool_calls = m.tool_calls;
      if (m.tool_call_id) {
        entry.tool_call_id = m.tool_call_id;
        if (m.name) entry.name = m.name;
      }
      return entry;
    });
  if (list.length > CHECKPOINT_MAX_MESSAGES) {
    list = [list[0], ...list.slice(list.length - (CHECKPOINT_MAX_MESSAGES - 1))];
  }
  let total = 0;
  const kept = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const size = JSON.stringify(list[i]).length;
    if (total + size > CHECKPOINT_MAX_CHARS && kept.length > 0) break;
    total += size;
    kept.unshift(list[i]);
  }
  return kept;
}

function restoreCheckpoint(incoming, record, hasExplicitSession) {
  const messages = Array.isArray(incoming) ? incoming : [];
  if (!record || !Array.isArray(record.history) || record.history.length === 0) return messages;
  if (!hasExplicitSession) return messages;
  const countNonSystem = (list) => list.filter((m) => m && m.role !== 'system').length;
  if (countNonSystem(messages) > 1) return messages; // client already sent full history
  if (countNonSystem(record.history) <= 1) return messages;
  const incomingSystem = messages.find((m) => m && m.role === 'system');
  const systemMessage = incomingSystem || record.history.find((m) => m && m.role === 'system');
  const historyTurns = record.history.filter((m) => m && m.role !== 'system');
  const incomingTurns = messages.filter((m) => m && m.role !== 'system');
  return [...(systemMessage ? [systemMessage] : []), ...historyTurns, ...incomingTurns];
}

/** Return the key of the most recently updated session (for MCP memo server). */
function latestSessionKey() {
  let bestKey = null;
  let bestTime = 0;
  for (const [key, value] of sessions) {
    const t = typeof value === 'object' ? (value.updatedAt || 0) : 0;
    if (t > bestTime) { bestTime = t; bestKey = key; }
  }
  return bestKey;
}

load();

module.exports = {
  get,
  getRecord,
  set,
  clear,
  load,
  checkpointMessages,
  restoreCheckpoint,
  latestSessionKey,
};
