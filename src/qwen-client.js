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
    return /aliyun_waf|baxia|FAIL_SYS_USER_VALIDATE|RGV587_ERROR|_____tmd_____|x5secdata|<html/i.test(bodyText);
  }
  return false;
};

function buildHeaders(refererPath, account) {
  const cookie = accountStore.buildCookieHeader(
    account,
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
async function generateChatID(model, chatType = 't2t', targetAccount = null) {
  let candidates = accountStore.candidates();
  if (targetAccount && targetAccount.token) {
    candidates = [targetAccount, ...candidates.filter((a) => a.id !== targetAccount.id)];
  }
  if (!candidates.length) return null;
  for (const account of candidates) try {
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
      { headers: buildHeaders('/c/new-chat', account), timeout: 30000 }
    );
    if (isWafResponse(res.status, res.headers['content-type'], JSON.stringify(res.data)) || res.status === 401 || res.status === 403) {
      accountStore.markFailure(account, 'WAF challenge on /chats/new', true);
      continue;
    }
    const id = (res.data && res.data.data && res.data.data.id) || null;
    if (id) accountStore.markSuccess(account);
    else accountStore.markFailure(account, 'Qwen did not return a chat id');
    if (id) return id;
  } catch (err) {
    accountStore.markFailure(account, err.message, isWafResponse(err.response && err.response.status, err.response && err.response.headers && err.response.headers['content-type'], String(err.response && err.response.data || '')));
    logger.warn(`generateChatId failed for ${account.id}: ${err.message}`, 'QWEN');
  }
  return null;
}

/**
 * Отправить chat request. `payload` уже включает chat_id/chatId.
 */
async function sendChatRequest(payload, preferredAccount = null) {
  let candidates = accountStore.candidates();
  if (preferredAccount && preferredAccount.token && accountStore.isAvailable(preferredAccount)) {
    candidates = [preferredAccount, ...candidates.filter((a) => a.id !== preferredAccount.id)];
  }
  if (!candidates.length) {
    return { status: false, message: 'No account token configured' };
  }

  const model = (payload.models && payload.models[0]) || config.DEFAULT_MODEL || 'qwen3.8-max';
  const chatType = payload.sub_chat_type || 't2t';
  const originalChatId = payload.chat_id || payload.chatId;

  for (const account of candidates) try {
    let accountChatId = originalChatId;
    if ((account.id !== candidates[0].id) || !accountChatId) {
      accountChatId = await generateChatID(model, chatType, account);
    }
    if (!accountChatId) {
      accountStore.markFailure(account, 'Failed to generate chat_id');
      continue;
    }

    const accountPayload = {
      ...payload,
      chat_id: accountChatId,
      chatId: accountChatId,
    };

    const url = `${config.BASE_URL}/api/v2/chat/completions?chat_id=${accountChatId}`;
    const response = await axios.post(url, accountPayload, {
      headers: buildHeaders(`/c/${accountChatId}`, account),
      responseType: 'stream',
      timeout: 10 * 60 * 1000,
    });

    if (response.status === 200) {
      accountStore.markSuccess(account);
      return { status: true, response: response.data, account, chatId: accountChatId };
    }
    accountStore.markFailure(account, `Unexpected status ${response.status}`);
    continue;
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
    if (status === 401 || status === 403 || isWafResponse(status, ct, bodyText)) {
      accountStore.markFailure(account, 'Qwen session expired or blocked by WAF', true);
      logger.warn(`WAF/session block for ${account.id} (status ${status}), failing over to next account`, 'QWEN');
      continue;
    }
    accountStore.markFailure(account, err.message);
    logger.error(`chat completion failed for ${account.id}: ${err.message}, failing over...`, 'QWEN');
    continue;
  }
  return { status: false, message: 'All Qwen accounts are unavailable. Re-login an account with `npm run accounts`.' };
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
