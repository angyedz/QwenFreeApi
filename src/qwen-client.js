'use strict';

const axios = require('axios');
const config = require('./config');
const accountStore = require('./account-store');
const ssxmodManager = require('./ssxmod-manager');
const { generateUUID, getTimezoneHeader, logger } = require('./util');

/**
 * Qwen Chat v2 HTTP-клиент с полным набором анти-бот заголовков
 * и генерацией SSXMOD cookie на каждый запрос.
 *
 * Поток:
 *   1. POST /api/v2/chats/new          -> chat_id
 *   2. POST /api/v2/chat/completions?chat_id=...   -> SSE
 *
 * Upstream стримит всегда (stream:false upstream не поддерживает).
 */

const isWafResponse = (status, contentType, bodyText) => {
  if (contentType && contentType.includes('text/html')) return true;
  if (status === 504) return true;
  if (typeof bodyText === 'string') {
    return /aliyun_waf|baxia|FAIL_SYS_USER_VALIDATE|<html/i.test(bodyText);
  }
  return false;
};

function buildHeaders(refererPath) {
  const cookie = accountStore.buildCookieHeader(
    ssxmodManager.getSsxmodItna(),
    ssxmodManager.getSsxmodItna2()
  );
  return {
    'sec-ch-ua-platform': '"Windows"',
    referer: `${config.BASE_URL}${refererPath}`,
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'user-agent': config.USER_AGENT,
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    source: 'web',
    version: config.QWEN_WEB_VERSION,
    timezone: getTimezoneHeader(),
    'x-request-id': generateUUID(),
    connection: 'keep-alive',
    cookie,
    host: config.BASE_URL.replace('https://', ''),
    origin: config.BASE_URL,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-accel-buffering': 'no',
  };
}

/**
 * Получить chat_id для новой беседы.
 */
async function generateChatID(model, chatType = 't2t') {
  try {
    const res = await axios.post(
      `${config.BASE_URL}/api/v2/chats/new`,
      {
        chatId: '',
        models: [model],
        project_id: '',
        timestamp: Date.now(),
        chat_type: chatType,
        chat_mode: 'normal',
      },
      { headers: buildHeaders('/c/new-chat'), timeout: 30000 }
    );
    if (isWafResponse(res.status, res.headers['content-type'], JSON.stringify(res.data))) {
      logger.error('WAF challenge on /chats/new — session probably stale, re-login', 'QWEN');
      return null;
    }
    return (res.data && res.data.data && res.data.data.id) || null;
  } catch (err) {
    logger.error(`generateChatId failed: ${err.message}`, 'QWEN', err);
    return null;
  }
}

/**
 * Отправить chat request. `payload` уже включает chat_id/chatId.
 */
async function sendChatRequest(payload) {
  const account = accountStore.current();
  if (!account || !account.token) {
    return { status: false, message: 'No account token configured' };
  }

  const chatId = payload.chat_id || payload.chatId;
  if (!chatId) {
    return { status: false, message: 'Missing chat_id in payload' };
  }

  try {
    const url = `${config.BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`;
    const response = await axios.post(url, payload, {
      headers: buildHeaders(`/c/${chatId}`),
      responseType: 'stream',
      timeout: 10 * 60 * 1000,
    });

    if (response.status === 200) {
      return { status: true, response: response.data };
    }
    return { status: false, message: `Unexpected status ${response.status}` };
  } catch (err) {
    const status = err.response ? err.response.status : null;
    const ct = err.response ? err.response.headers['content-type'] : '';
    let bodyText = String(err.response && err.response.data ? err.response.data : '').slice(0, 2000);
    try {
      if (err.response && err.response.data && typeof err.response.data === 'object') {
        bodyText = await readStream(err.response.data);
      }
    } catch (_) {
      /* ignore */
    }
    if (isWafResponse(status, ct, bodyText)) {
      logger.error(`WAF/session block (status ${status}). Re-run 'npm run login'.`, 'QWEN');
      return { status: false, message: 'Qwen session expired or blocked by WAF. Re-login.' };
    }
    logger.error(`chat completion failed: ${err.message}`, 'QWEN', err);
    return { status: false, message: err.message };
  }
}

function readStream(stream) {
  if (!stream || typeof stream !== 'object') return Promise.resolve('');
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    return (async () => {
      let out = '';
      for await (const chunk of stream) out += chunk;
      return out;
    })();
  }
  if (typeof stream.on === 'function') {
    return new Promise((resolve) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          resolve(chunks.join(''));
        }
      });
      stream.on('error', () => resolve(chunks.join('')));
    });
  }
  return Promise.resolve(String(stream));
}

module.exports = { sendChatRequest, generateChatID, isWafResponse };