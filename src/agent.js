'use strict';

const qwenClient = require('./qwen-client');
const chatAdapter = require('./chat-adapter');
const toolProtocol = require('./tools');
const toolExecutor = require('./tool-executor');
const { logger } = require('./util');

/**
 * Агентный цикл чата.
 *
 * Раньше каждый раунд ходил HTTP-запросом в СОБСТВЕННЫЙ /v1/chat/completions
 * (PROXY_URL). Это ломало tool loop: двойная сериализация OpenAI<->Qwen на
 * каждый ход, лишний HTTP-хоп и незаметное пересоздание upstream-треда при
 * внутренних ретраях /v1. Теперь агент вызывает Qwen напрямую через
 * chat-adapter/qwen-client:
 *   - chat.qwenChatId запоминается на чате и переживает chatStore.save(),
 *     поэтому все раунды одного чата продолжают ОДИН upstream-тред;
 *   - с готовым chatId адаптер отправляет только текущее сообщение
 *     (currentOnly), без повторной вкладки всей истории в каждый tool-ход;
 *   - мёртвый тред (frames=0) -> один ретрай на свежем треде с полной историей,
 *     как retry в server.js.
 *
 * События для веб-клиента не меняются: reasoning/text/round/tool/tool_result.
 */

const MAX_ROUNDS = 6;

// ---------------------------------------------------------------------------
// Потребитель Qwen-стрима: reasoning/content -> клиенту, tool_calls -> на исполнение
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, finish:string|null}>}
 */
function consumeQwenStream(stream, emit, toolParser) {
  return new Promise((resolve, reject) => {
    const state = {
      content: '',
      reasoning: '', // буфер для инкрементальных событий в UI
      reasoningAll: '', // полный reasoning для истории чата
      byIndex: new Map(), // index -> {id, name, arguments}
      finish: null,
    };

    const sendReasoning = () => {
      if (state.reasoning) {
        emit({ type: 'reasoning', text: state.reasoning });
        state.reasoning = '';
      }
    };

    const handleLine = (raw) => {
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
        state.reasoningAll += delta.reasoning_content;
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
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    };

    // parseQwenSSE сам нарезает upstream SSE и отдаёт OpenAI-shaped строки,
    // включая tool_calls-дельты, когда передан toolParser.
    chatAdapter.parseQwenSSE(
      stream,
      handleLine,
      (error) => {
        if (error) {
          reject(error);
          return;
        }
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
          reasoning: state.reasoningAll,
          toolCalls,
          finish: state.finish,
        });
      },
      { toolParser }
    );
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
// Один раунд: подготовить payload -> отправить в Qwen -> собрать стрим
// ---------------------------------------------------------------------------

async function requestRound(body, chat, emit) {
  // Без chatId preparePublicPayload создаёт НОВЫЙ upstream-тред и отправляет
  // полную историю первым сообщением (currentOnly=false). С chatId — только
  // текущее сообщение: тред уже хранит предыдущие ходы.
  const prepared = await chatAdapter.preparePublicPayload(body, {
    chatId: chat.qwenChatId || undefined,
  });
  chat.qwenChatId = prepared.chatId;

  const response = await qwenClient.sendChatRequest(prepared.qwenPayload);
  if (!response || !response.status) {
    throw new Error((response && response.message) || 'Qwen upstream request failed');
  }

  const toolParser = prepared.hasTools ? toolProtocol.createToolCallStreamParser() : null;
  return consumeQwenStream(response.response, emit, toolParser);
}

// ---------------------------------------------------------------------------
// Основной цикл
// ---------------------------------------------------------------------------

/**
 * Выполнить один пользовательский ход.
 * @param {Object} chat - чат из хранилища (мутирует messages и qwenChatId)
 * @param {string} userText
 * @param {(ev:Object)=>void} emit - отправка события клиенту
 * @returns {Promise<Object>} финальное ассистент-сообщение
 */
async function runTurn(chat, userText, emit) {
  const settings = chat.settings || {};
  const tools = pickTools(settings);
  chat.messages.push({ role: 'user', content: userText });

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    emit({ type: 'round', round });

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

    let result;
    try {
      result = await requestRound(body, chat, emit);
    } catch (err) {
      if (err.message && err.message.includes('WAF_CAPTCHA_CHALLENGE')) {
        const captchaResolver = require('./captcha-resolver');
        const accountStore = require('./account-store');
        const acc = accountStore.current();
        if (acc) captchaResolver.solveCaptcha(acc.id);
      }
      // Тред умер, не выдав ни одного кадра: сбрасываем qwenChatId и один раз
      // повторяем раунд на свежем треде (полная история уйдёт автоматически).
      const deadThread = /^Qwen upstream closed without a usable response \(frames=0/.test(err.message);
      if (!deadThread || !chat.qwenChatId) throw err;
      logger.warn('Qwen thread died without output, retrying on a fresh thread', 'AGENT');
      chat.qwenChatId = null;
      result = await requestRound(body, chat, emit);
    }

    if (result.toolCalls.length === 0) {
      const content = result.content.trim() ? result.content : '(пустой ответ)';
      const finalAssistant = { role: 'assistant', content };
      if (result.reasoning) finalAssistant.reasoning_content = result.reasoning;
      chat.messages.push(finalAssistant);
      return finalAssistant;
    }

    // Воспроизводим tool_calls как ассистент-сообщение для истории
    chat.messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((tc, i) => ({ ...tc, index: i })),
    });

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

module.exports = { runTurn, consumeQwenStream, pickTools };
