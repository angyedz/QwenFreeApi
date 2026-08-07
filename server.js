#!/usr/bin/env node
/**
 * Qwen Free API — локальный бесшовный OpenAI-прокси к Qwen Chat v2 API.
 *
 * Обходит Aliyun WAF через генерацию SSXMOD-cookie в чистом JS
 * (без браузера на каждый запрос). Требуется только аккаунт Qwen Chat.
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *   GET  /health
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const config = require('./src/config');
const accountStore = require('./src/account-store');
const ssxmodManager = require('./src/ssxmod-manager');
const qwenClient = require('./src/qwen-client');
const chatAdapter = require('./src/chat-adapter');
const tools = require('./src/tools');
const web = require('./src/web');
const toolExecutor = require('./src/tool-executor');
const sessionStore = require('./src/session-store');
const { logger } = require('./src/util');

const PORT = Number(process.env.PORT || config.PORT);
const app = express();

app.use(cors());
app.use(express.json({ limit: config.MAX_PAYLOAD_BYTES }));

// ---------- Diagnostics ----------
app.get('/healthz', (req, res) => {
  res.json({
    service: 'qwen-free-api',
    ok: true,
    endpoints: ['/v1/models', '/v1/chat/completions', '/health', '/'],
    account: accountStore.isAccount() ? 'loaded' : 'missing',
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    account: accountStore.isAccount() ? 'loaded' : 'missing',
    ssxmod: ssxmodManager.isReady() ? 'ready' : 'pending',
  });
});

// ---------- /v1/models ----------
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: config.MODELS.map((id) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'qwen',
      context_window: config.MODEL_LIMITS[id]?.context,
      max_output_tokens: config.MODEL_LIMITS[id]?.output,
    })),
  });
});

// ---------- /v1/chat/completions ----------
app.post('/v1/chat/completions', async (req, res) => {
  const publicBody = req.body || {};
  const streamRequested = publicBody.stream === true;
  const sessionKey = getOpenCodeSessionKey(req, publicBody);
  const compaction = isCompactionRequest(req, publicBody);

  try {
    const account = accountStore.current();
    if (!account || !account.token) {
      return res.status(401).json({
        error: {
          message: 'No Qwen account configured. Run `npm run login` first.',
          type: 'unauthorized',
        },
      });
    }

    const record = sessionStore.getRecord(sessionKey);
    // Compaction is generated in the current Qwen thread. The following normal
    // turn rolls over to a fresh thread, carrying the client's checkpoint.
    const rollover = Boolean(record && record.awaitingCompactedHistory && !compaction);
    const existingChatId = rollover ? null : record?.chatId || null;
    const prepared = await chatAdapter.preparePublicPayload(publicBody, {
      chatId: existingChatId,
      compaction,
    });
    sessionStore.set(sessionKey, prepared.chatId, { awaitingCompactedHistory: compaction });
    const response = await qwenClient.sendChatRequest(prepared.qwenPayload, account);

    if (!response || !response.status) {
      return res.status(502).json({
        error: {
          message: (response && response.message) || 'Qwen upstream request failed',
          type: 'upstream_error',
        },
      });
    }

    // Upstream с qwen-клиента всегда стримит (stream:true). Для non-stream агрегируем.
    const upstream = response.response; // axios-респонса data (Readable stream)
    res.setHeader('Content-Type', streamRequested ? 'text/event-stream' : 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (!streamRequested) {
      let json;
      try {
        json = await chatAdapter.collectNonStream(upstream, {
          toolParser: prepared.hasTools ? tools.createToolCallStreamParser() : null,
        });
      } catch (err) {
        accountStore.markFailure(response.account, err.message);
        throw err;
      }
      return res.json(json);
    }

    await chatAdapter.pipeThroughOpenAI(upstream, res, {
      toolParser: prepared.hasTools ? tools.createToolCallStreamParser() : null,
      onError: (error) => accountStore.markFailure(response.account, error.message),
      retryEmpty: async () => {
        // A zero-frame response usually means the upstream chat session died.
        // Reusing the same chat_id just reproduces the empty stream, so create
        // a fresh upstream session while preserving the original request.
        sessionStore.clear(sessionKey);
        const retryPrepared = await chatAdapter.preparePublicPayload(publicBody);
        sessionStore.set(sessionKey, retryPrepared.chatId, { awaitingCompactedHistory: compaction });
        const retry = await qwenClient.sendChatRequest(retryPrepared.qwenPayload);
        return retry.status ? retry.response : null;
      },
    });
  } catch (err) {
    logger.error(`[chat/completions] ${err.message}`, 'SERVER', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message, type: 'server_error' } });
    } else {
      res.end();
    }
  }
});

function getOpenCodeSessionKey(req, body) {
  const headers = req.headers || {};
  const value =
    headers['x-opencode-session'] ||
    headers['x-opencode-session-id'] ||
    headers['x-session-id'] ||
    headers['x-conversation-id'] ||
    body.session_id ||
    body.sessionId ||
    body.sessionID ||
    body.conversation_id ||
    body.conversationId ||
    body.conversationID ||
    body.chat_id ||
    body.chatId ||
    body.metadata?.session_id ||
    body.metadata?.sessionId ||
    body.metadata?.sessionID ||
    body.metadata?.conversation_id ||
    body.metadata?.conversationId ||
    body.metadata?.conversationID;
  if (value) return String(value).trim();

  // Some OpenAI-compatible clients omit all session metadata and may send a
  // different subset of messages on every turn. Never derive this key from
  // message content: after a tool call that would create a new Qwen chat and
  // make the model forget the original request. Explicit session metadata
  // above remains the preferred isolation mechanism.
  const userKey = body.user || body.metadata?.user_id || body.metadata?.userId || '';
  const seed = JSON.stringify({ model: body.model || '', user: userKey || 'default' });
  return `derived-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function isCompactionRequest(req, body) {
  const headers = req.headers || {};
  const marker = String(
    headers['x-opencode-compaction'] || headers['x-context-compaction'] || body.compaction || body.context_compaction || '',
  ).toLowerCase();
  if (marker === 'true' || marker === '1' || marker === 'compact' || marker === 'compaction') return true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    const content = message?.content;
    if (Array.isArray(content) && content.some((part) => part?.type === 'compaction')) return true;
    if (content && typeof content === 'object' && content.type === 'compaction') return true;
    return /^\s*(context compaction|conversation summary)\s*$/i.test(String(content || ''));
  });
}

// ---------- Boot ----------
ssxmodManager.init();
toolExecutor.initWorkspace();
web.attachWeb(app);

try {
  accountStore.load();
  logger.info(`${accountStore.list().length} Qwen account(s) loaded`, 'ACCOUNT');
} catch (e) {
  logger.warn(`No account yet (${e.message}). Run 'npm run login' or 'npm run accounts'.`, 'ACCOUNT');
}

app.listen(PORT, () => {
  logger.info(`Qwen Free API on http://localhost:${PORT}`, 'SERVER');
  if (!accountStore.isAccount()) {
    logger.warn('Run `npm run login` to authenticate your Qwen account.', 'SERVER');
  }
});
