'use strict';

const axios = require('axios');
const { logger } = require('./util');
const toolExecutor = require('./tool-executor');

/**
 * Агентный цикл чата.
 *
 * Работает как тонкий клиент к OpenAI-совместимому прокси (сервер на /v1):
 *   1. Стримит запрос с tools через прокси.
 *   2. Если модель вернула tool_calls — исполняет инструменты локально
 *      (bash/файлы/веб-поиск), подкладывает результаты в сообщения и повторяет.
 *   3. Когда модель ответила текстом — завершает.
 * Прогресс идёт клиенту потоком событий SSE.
 */

const PROXY_URL = process.env.QWEN_PROXY_URL || 'http://localhost:3265/v1/chat/completions';
const MAX_ROUNDS = 6;

// ---------------------------------------------------------------------------
// SSE-потребитель ответа прокси
// ---------------------------------------------------------------------------

/**
 * Собирает стрим прокси: reasoning/content -> браузеру, tool_calls -> на исполнение.
 * @returns {Promise<{content:string, toolCalls:Array, finish:string|null}>}
 */
function consumeProxyStream(proxyStream, emit) {
  return new Promise((resolve, reject) => {
    const state = {
      content: '',
      reasoning: '',
      toolCalls: [], // индекс -> {id, name, arguments}
      byIndex: new Map(),
      finish: null,
    };

    const sendReasoning = () => {
      if (state.reasoning) {
        emit({ type: 'reasoning', text: state.reasoning });
        state.reasoning = '';
      }
    };

    let buffer = '';
    const handleChunk = (text) => {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        processLine(line);
      }
    };

    const processLine = (raw) => {
      const trimmed = String(raw).trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch (_) {
        return;
      }
      if (obj.error) {
        reject(new Error(obj.error.message || 'Upstream error'));
        return;
      }
      const choice = obj.choices && obj.choices[0];
      if (!choice) return;
      if (choice.finish_reason) state.finish = choice.finish_reason;

      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        state.reasoning += delta.reasoning_content;
      }
      if (delta.content) {
        sendReasoning();
        state.content += delta.content;
        emit({ type: 'text', text: delta.content });
      }
      if (delta.tool_calls) {
        sendReasoning();
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          let entry = state.byIndex.get(index);
          if (!entry) {
            entry = { id: tc.id, name: '', arguments: '' };
            state.byIndex.set(index, entry);
            state.toolCalls.push(entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    };

    proxyStream.on('data', (buf) => handleChunk(buf.toString('utf8')));
    proxyStream.on('end', () => {
      handleChunk('\n');
      sendReasoning();
      const toolCalls = [...state.byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, c]) => ({
          id: c.id || `call_${index}`,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        }));
      resolve({
        content: state.content,
        reasoning: state.reasoning,
        toolCalls,
        finish: state.finish,
      });
    });
    proxyStream.on('error', (err) => reject(err));
    proxyStream.on('close', () => {
      if (!proxyStream.readableEnded) reject(new Error('Proxy stream closed unexpectedly'));
    });
  });
}

// ---------------------------------------------------------------------------
// Выбор набора инструментов по настройкам чата
// ---------------------------------------------------------------------------

function pickTools(settings) {
  const tools = [];
  const add = (name) => {
    const def = toolExecutor.TOOL_DEFS.find((t) => t.function.name === name);
    if (def) tools.push(def);
  };
  if (settings.terminal !== false) add('bash');
  if (settings.files !== false) {
    add('list_dir');
    add('read_file');
    add('write_file');
    add('edit_file');
  }
  if (settings.webSearch !== false) add('web_search');
  return tools;
}

// ---------------------------------------------------------------------------
// Основной цикл
// ---------------------------------------------------------------------------

/**
 * Выполнить один пользовательский ход.
 * @param {Object} chat - чат из хранилища (мутирует messages)
 * @param {string} userText
 * @param {(ev:Object)=>void} emit - отправка события клиенту
 * @returns {Promise<Object>} финальное ассистент-сообщение
 */
async function runTurn(chat, userText, emit) {
  const settings = chat.settings || {};
  const tools = pickTools(settings);
  chat.messages.push({ role: 'user', content: userText });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: chat.model,
      messages: chat.messages,
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (settings.thinking) body.thinking = true;
    if (settings.webSearch) body.search = true;

    emit({ type: 'round', round });

    const response = await axios.post(PROXY_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      responseType: 'stream',
      timeout: 5 * 60 * 1000,
    });

    const result = await consumeProxyStream(response.data, emit);

    if (result.toolCalls.length === 0) {
      const content = result.content.trim() ? result.content : '(пустой ответ)';
      const finalAssistant = { role: 'assistant', content };
      if (result.reasoning) finalAssistant.reasoning_content = result.reasoning;
      chat.messages.push(finalAssistant);
      return finalAssistant;
    }

    // Воспроизводим tool_calls как ассистент-сообщение для истории
    const assistantRound = {
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc, i) => ({ ...tc, index: i })),
    };
    chat.messages.push(assistantRound);

    // Исполняем инструменты
    for (const call of result.toolCalls) {
      const name = call.function.name;
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (_) {
        args = {};
      }
      emit({ type: 'tool', name, args });
      const output = await toolExecutor.executeTool(name, args);
      emit({ type: 'tool_result', name, output });
      chat.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: output,
      });
    }
  }

  const fallback = { role: 'assistant', content: '(достигнут лимит ходов, остановлено)' };
  chat.messages.push(fallback);
  return fallback;
}

module.exports = { runTurn, consumeProxyStream, pickTools };
