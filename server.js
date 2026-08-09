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
const captchaResolver = require('./src/captcha-resolver');
const tools = require('./src/tools');
const toolMemo = require('./src/tool-memo');
const web = require('./src/web');
const toolExecutor = require('./src/tool-executor');
const sessionStore = require('./src/session-store');
const commandHandler = require('./src/command-handler');
const { logger } = require('./src/util');

const PORT = Number(process.env.PORT || config.PORT);
const app = express();

app.use(cors());
app.use(express.json({ limit: config.MAX_PAYLOAD_BYTES }));
app.use((req, res, next) => { res.setHeader('X-Service', 'qwen-free-api'); next(); });

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

// ---------- Tool Memo HTTP API (used by mcp-server.js) ----------
app.get('/v1/memo/recall', (req, res) => {
  const session = String(req.query.session || req.query.s || '').trim();
  const query = String(req.query.query || req.query.q || 'recent').trim();
  const maxChars = Number(req.query.max_chars || req.query.maxChars || 800);
  if (!session) {
    // Return from the most recently active session
    const latest = sessionStore.latestSessionKey();
    if (!latest) return res.json({ result: 'No active sessions.', session: null });
    return res.json({ result: toolMemo.recall(latest, query, maxChars), session: latest });
  }
  res.json({ result: toolMemo.recall(session, query, maxChars), session });
});

app.get('/v1/memo/sessions', (req, res) => {
  res.json(toolMemo.stats());
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
  commandHandler.incrementRequestCount();
  const publicBody = req.body || {};
  const streamRequested = publicBody.stream === true;
  const sessionKey = getOpenCodeSessionKey(req, publicBody);

  // Intercept in-chat proxy management commands (e.g. !compressor off, !accounts, !help)
  if (commandHandler.isCommandMessage(publicBody.messages)) {
    return commandHandler.handleCommand(publicBody.messages, sessionKey, req, res);
  }

  const compactionDisabled = commandHandler.isCompressorDisabled(sessionKey);
  const compaction = !compactionDisabled && isCompactionRequest(req, publicBody);
  if (!hasExplicitSessionId(req, publicBody) && isInitialConversation(publicBody.messages)) {
    sessionStore.clear(sessionKey);
    toolMemo.clear(sessionKey);
  }

  try {
    accountStore.load();
    const record = sessionStore.getRecord(sessionKey);
    const savedAccount = (record && record.accountId) ? accountStore.get(record.accountId) : null;
    const preferredAccount = (savedAccount && accountStore.isAvailable(savedAccount))
      ? savedAccount
      : (accountStore.candidates()[0] || accountStore.current());
    if (!preferredAccount || !preferredAccount.token) {
      return res.status(401).json({
        error: {
          message: 'No Qwen account configured. Run `npm run login` first.',
          type: 'unauthorized',
        },
      });
    }

    // If the last user message is a continuation request (e.g. "продолжи"), force rollover
    // to a fresh Qwen thread so stale upstream state on chat.qwen.ai never stalls the agent loop.
    const lastUser = [...(publicBody.messages || [])].reverse().find((m) => m?.role === 'user');
    const lastUserStr = (typeof lastUser?.content === 'string' ? lastUser.content : '').trim().toLowerCase();
    const isContinuationTurn = lastUserStr.length <= 25 && /^(продолжи|продолжай|continue|go ahead|давай|делай|proceed)$/i.test(lastUserStr);

    const rollover = Boolean((record && record.awaitingCompactedHistory && !compaction) || isContinuationTurn);
    const existingChatId = rollover ? null : record?.chatId || null;
    // If the client only sent the latest turn, recover prior context from the
    // local checkpoint so the folded Qwen message still carries the full task.
    const restoredMessages = sessionStore.restoreCheckpoint(
      publicBody.messages,
      record,
      hasExplicitSessionId(req, publicBody),
    );
    if (restoredMessages !== publicBody.messages) {
      logger.info(`[checkpoint] restored prior context (${restoredMessages.length} messages)`, 'SERVER');
    }
    const effectiveBody = restoredMessages === publicBody.messages
      ? publicBody
      : { ...publicBody, messages: restoredMessages };
    const prepared = await chatAdapter.preparePublicPayload(effectiveBody, {
      chatId: existingChatId,
      compaction,
      skipToolPrompt: false,
      existingToolPromptHash: record?.toolPromptHash,
      sessionKey,
      headers: req.headers,
      account: preferredAccount,
    });
    const response = await qwenClient.sendChatRequest(prepared.qwenPayload, preferredAccount);
    if (response && response.account) {
      sessionStore.set(sessionKey, prepared.chatId, {
        accountId: response.account.id,
        awaitingCompactedHistory: compaction,
        toolPromptHash: prepared.toolPromptHash,
        history: sessionStore.checkpointMessages(restoredMessages),
      });
    }

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
        // A stale Qwen thread can accept the request and then close its SSE
        // stream without emitting a completion. Retry once on a fresh thread,
        // including for non-stream OpenAI clients.
        if (/^Qwen upstream closed without a usable response/i.test(err.message)) {
          sessionStore.clear(sessionKey);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const retryPrepared = await chatAdapter.preparePublicPayload(effectiveBody, { compaction });
            const retry = await qwenClient.sendChatRequest(retryPrepared.qwenPayload);
            if (!retry.status) continue;
            sessionStore.set(sessionKey, retryPrepared.chatId, {
              accountId: retry.account ? retry.account.id : preferredAccount.id,
              awaitingCompactedHistory: compaction,
              toolPromptHash: retryPrepared.toolPromptHash,
              history: sessionStore.checkpointMessages(restoredMessages),
            });
            try {
              json = await chatAdapter.collectNonStream(retry.response, {
                toolParser: retryPrepared.hasTools ? tools.createToolCallStreamParser() : null,
              });
              return res.json(json);
            } catch (retryError) {
              if (!/^Qwen upstream closed without a usable response/i.test(retryError.message)) throw retryError;
            }
          }
        }
        accountStore.markFailure(response.account, err.message);
        throw err;
      }
      return res.json(json);
    }

    await chatAdapter.pipeThroughOpenAI(upstream, res, {
      toolParser: prepared.hasTools ? tools.createToolCallStreamParser() : null,
      requireToolCall: prepared.isContinuation || effectiveBody.tool_choice === 'required',
      maxEmptyRetries: 3,
      onError: (error) => {
        accountStore.markFailure(response.account, error.message);
        if (error.message && error.message.includes('WAF_CAPTCHA_CHALLENGE')) {
          const parts = error.message.split('WAF_CAPTCHA_CHALLENGE:');
          const captchaUrl = parts[1] || '';
          captchaResolver.solveCaptcha(response.account.id, captchaUrl);
        }
      },
      retryEmpty: async () => {
        sessionStore.clear(sessionKey);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const nextAccount = accountStore.candidates()[0] || preferredAccount;
          const retryPrepared = await chatAdapter.preparePublicPayload(effectiveBody, {
            compaction,
            sessionKey,
            headers: req.headers,
            account: nextAccount,
          });
          const retry = await qwenClient.sendChatRequest(retryPrepared.qwenPayload, nextAccount);
          if (retry.status) {
            sessionStore.set(sessionKey, retryPrepared.chatId, {
              accountId: retry.account ? retry.account.id : nextAccount.id,
              awaitingCompactedHistory: compaction,
              toolPromptHash: retryPrepared.toolPromptHash,
              history: sessionStore.checkpointMessages(restoredMessages),
            });
            return retry.response;
          }
        }
        return null;
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

  // OpenCode normally supplies one of the explicit IDs above. For clients that
  // omit them, use the first user turn as the conversation boundary instead of
  // one global model/user key. The full message list is sent on follow-ups, so
  // this remains stable through tool calls while separating newly-created chats.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages.find((message) => message?.role === 'user');
  const firstContent = extractSessionText(firstUser?.content);
  const userKey = body.user || body.metadata?.user_id || body.metadata?.userId || '';
  const seed = JSON.stringify({ model: body.model || '', user: userKey || 'default', firstUser: firstContent });
  return `derived-v2-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function hasExplicitSessionId(req, body) {
  const headers = req.headers || {};
  return Boolean(
    headers['x-opencode-session'] ||
    headers['x-opencode-session-id'] ||
    headers['x-session-id'] ||
    headers['x-conversation-id'] ||
    body.session_id || body.sessionId || body.sessionID ||
    body.conversation_id || body.conversationId || body.conversationID ||
    body.chat_id || body.chatId ||
    body.metadata?.session_id || body.metadata?.sessionId || body.metadata?.sessionID ||
    body.metadata?.conversation_id || body.metadata?.conversationId || body.metadata?.conversationID
  );
}

function isInitialConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return true;
  return messages.every((message) => message?.role === 'system' || message?.role === 'user') &&
    messages.filter((message) => message?.role === 'user').length <= 1;
}

function extractSessionText(content) {
  if (typeof content === 'string') return content.trim().slice(0, 4000);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      return part?.text || part?.content || '';
    }).join(' ').trim().slice(0, 4000);
  }
  if (content && typeof content === 'object') return extractSessionText(content.text || content.content || '');
  return '';
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
