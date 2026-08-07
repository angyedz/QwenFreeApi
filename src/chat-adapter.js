'use strict';

const config = require('./config');
const qwenClient = require('./qwen-client');
const tools = require('./tools');
const { generateUUID, logger } = require('./util');

/**
 * Мост между OpenAI-форматом (клиент) и Qwen Chat v2 SSE-форматом.
 *
 * КРИТИЧНО: upstream chat/completions не принимает «минимальное» тело — только
 * точную форму запроса, которую шлёт живой SPA (version:'2.1', полная обёртка
 * сообщения с user_action/files/models/feature_config/extra.meta.subChatType).
 * При любой другой форме Aliyun WAF отвечает FAIL_SYS_USER_VALIDATE (x5sec-капча).
 * Это тело сверено с живым FE 0.2.83 (см. browser-inspect.js / browser-matrix.js).
 */

const getChatType = (model) => {
  const m = String(model || '');
  if (m.includes('-search')) return 'search';
  if (m.includes('-image-edit')) return 'image_edit';
  if (m.includes('-image')) return 't2i';
  if (m.includes('-video')) return 't2v';
  if (m.includes('-deep-research')) return 'deep_research';
  return 't2t';
};

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text')
      .map((p) => p.text || '')
      .join(' ');
  }
  return '';
}

const HISTORY_MARKER = '# Conversation history (JSONL)';
const CURRENT_MESSAGE_MARKER = '# Current message';

/**
 * Qwen web принимает ОДНО текущее сообщение. Историю сворачиваем в JSONL-конверт,
 * как делает сам интерфейс во время мультитарна. Если есть tool-протокол, внедряем
 * его в начало конверта и раскладываем tool_calls/результаты в читаемый текст.
 */
function foldMessages(messages, toolPrompt = '') {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { role: 'user', content: toolPrompt || 'Hello' };
  }
  const folded = toolPrompt ? tools.foldToolMessages(messages) : messages;
  const last = folded[folded.length - 1];
  const history = folded.slice(0, -1);

  const historyText = history
    .map((m) => {
      const s = extractText(m.content).trim();
      return s ? JSON.stringify({ role: m.role, content: s }) : '';
    })
    .filter(Boolean)
    .join('\n');

  const lastText = extractText(last.content).trim();
  const parts = [];
  if (toolPrompt) parts.push(toolPrompt);
  if (historyText) parts.push(HISTORY_MARKER, historyText);
  if (lastText) parts.push(CURRENT_MESSAGE_MARKER, JSON.stringify({ role: last.role, content: lastText }));
  return { role: last.role || 'user', content: parts.join('\n') || 'Hello' };
}

/**
 * Собрать полноценное тело запроса chat/completions (форма живого SPA 0.2.83).
 */
function buildChatBody(chatId, model, messages, thinking, toolPrompt = '', search = false) {
  const baseType = getChatType(model);
  const chatType = search ? 'search' : baseType;
  const { role, content } = foldMessages(messages, toolPrompt);

  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chatId,
    parentId: '',
    chat_id: chatId,
    chat_mode: 'normal',
    model,
    parent_id: null,
    timestamp: Date.now(),
    messages: [
      {
        id: null,
        fid: generateUUID(),
        parentId: null,
        childrenIds: [],
        role,
        content,
        user_action: 'chat',
        files: [],
        timestamp: Date.now(),
        models: [model],
        model: '',
        chat_type: chatType,
        feature_config: {
          thinking_enabled: thinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: chatType === 'search',
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: null,
      },
    ],
  };
}

/**
 * Подготовка запроса: создать chat_id и построить тело.
 */
async function preparePublicPayload(openaiBody) {
  const model = openaiBody.model || config.DEFAULT_MODEL;
  const thinking =
    openaiBody.thinking === true ||
    String(model).toLowerCase().includes('thinking') ||
    openaiBody.reasoning_effort !== undefined;

  const toolPrompt = tools.buildToolPrompt(openaiBody.tools, openaiBody.tool_choice);
  const hasTools = !!toolPrompt;
  const search =
    openaiBody.search === true ||
    String(openaiBody.chat_type || '').toLowerCase() === 'search';

  const chatId = await qwenClient.generateChatID(model, getChatType(model));
  if (!chatId) {
    throw new Error('Failed to create a Qwen chat (session/WAF). Re-login with `npm run login`.');
  }

  const qwenPayload = buildChatBody(chatId, model, openaiBody.messages, thinking, toolPrompt, search);
  return { qwenPayload, model, chatId, hasTools };
}

// ==================== SSE parsing / OpenAI encode ====================

const THINK_PHASES = new Set(['think', 'thinking', 'thinking_summary']);

/**
 * Разбор upstream SSE. Каждый значимый фрагмент вызывает onData(line).
 *  - thinking_summary: `extra.summary_thought.content` — растущий массив абзацев,
 *    выдаём только новые (инкрементально), чтобы не дублировать reasoning.
 *  - answer: content. Если включён tool-режим, контент прогоняется через
 *    XML-парсер и транслируется в OpenAI tool_calls delta.
 */
function parseQwenSSE(stream, onData, onDone, opts = {}) {
  const toolParser = opts.toolParser || null;
  const idleTimeout = Number(opts.idleTimeout || config.STREAM_IDLE_TIMEOUT_MS);

  let buffer = '';
  let seq = 0;
  let closed = false;
  let emittedSummaryCount = 0;
  let acceptedResponseId = null;
  let idleTimer = null;

  // Upstream часто открывает несколько конкурирующих кандидатных ответов
  // (разные response_id), чьи инкрементальные кадры перемешаны. Локимся на
  // первый response_id и отбрасываем остальные, иначе ответ "разъезжается".
  const acceptFrame = (json) => {
    const rid = json && json.response_id;
    if (!rid) return true;
    if (acceptedResponseId === null) acceptedResponseId = rid;
    return rid === acceptedResponseId;
  };

  const chunkId = () => {
    seq += 1;
    return {
      id: `chatcmpl-${seq}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: '',
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    };
  };

  const writeToolCallDeltas = (calls) => {
    const ARG_CHUNK = 24;
    for (const call of calls) {
      const header = chunkId();
      header.choices[0].delta.tool_calls = [
        {
          index: call.index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: '' },
        },
      ];
      onData(`data: ${JSON.stringify(header)}\n\n`);
      const args = call.function.arguments || '';
      for (let off = 0; off < args.length; off += ARG_CHUNK) {
        const piece = chunkId();
        piece.choices[0].delta.tool_calls = [
          { index: call.index, function: { arguments: args.slice(off, off + ARG_CHUNK) } },
        ];
        onData(`data: ${JSON.stringify(piece)}\n\n`);
      }
    }
  };

  const close = (error = null) => {
    if (!closed) {
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (onDone) onDone(error);
    }
  };

  const armIdleTimer = () => {
    if (!idleTimeout || idleTimeout <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const error = new Error(`Qwen upstream stream timed out after ${idleTimeout}ms without data`);
      close(error);
      if (typeof stream.destroy === 'function') stream.destroy(error);
    }, idleTimeout);
  };

  const handleLine = (raw) => {
    if (closed) return;
    const trimmed = String(raw).trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      close();
      return;
    }

    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      return;
    }
    if (obj === true || obj.data === true) return close();
    if (obj['response.created'] || obj['response.updated']) return;
    if (!acceptFrame(obj)) return;

    const choice = obj.choices && obj.choices[0];
    if (!choice || !choice.delta) return;
    const delta = choice.delta;
    const phase = delta.phase;

    let content = '';
    let reasoning = '';

    if (THINK_PHASES.has(phase)) {
      const thoughts = delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content;
      if (Array.isArray(thoughts)) {
        if (thoughts.length > emittedSummaryCount) {
          reasoning = thoughts.slice(emittedSummaryCount).filter(Boolean).join('\n');
          emittedSummaryCount = thoughts.length;
        }
      } else if (delta.reasoning_content) {
        reasoning = delta.reasoning_content;
      }
    } else if (delta.reasoning_content) {
      reasoning = delta.reasoning_content;
    } else {
      content = delta.content || '';
    }

    if (reasoning) {
      const chunk = chunkId();
      chunk.choices[0].delta.reasoning_content = reasoning;
      onData(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    if (content && toolParser) {
      const parsed = toolParser.push(content);
      if (parsed.textDelta) {
        const chunk = chunkId();
        chunk.choices[0].delta.content = parsed.textDelta;
        onData(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (parsed.calls.length > 0) writeToolCallDeltas(parsed.calls);
    } else if (content) {
      const chunk = chunkId();
      chunk.choices[0].delta.content = content;
      onData(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  };

  stream.on('data', (buf) => {
    armIdleTimer();
    buffer += buf.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer) handleLine(buffer);
    if (toolParser) {
      const tail = toolParser.flush();
      if (tail.textDelta) {
        const chunk = chunkId();
        chunk.choices[0].delta.content = tail.textDelta;
        onData(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (tail.calls.length > 0) writeToolCallDeltas(tail.calls);
    }
    if (!closed) close(new Error('Qwen upstream stream ended without a terminal event'));
  });
  stream.on('error', (error) => close(error));
  // A network reset can emit `close` without `end`. Do not turn that into a
  // successful [DONE], otherwise clients see a truncated answer as complete.
  stream.on('close', () => {
    if (!closed && !stream.readableEnded) {
      close(new Error('Qwen upstream stream closed unexpectedly'));
    }
  });

  armIdleTimer();

  return stream;
}

/** Агрегирующий non-stream путь: вернуть OpenAI JSON. */
async function collectNonStream(stream, opts = {}) {
  const toolParser = opts.toolParser || null;
  const contentParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  await new Promise((resolve, reject) => {
    parseQwenSSE(
      stream,
      (line) => {
        const json = JSON.parse(line.slice(6));
        const d = json.choices[0].delta;
        if (d.reasoning_content) reasoningParts.push(d.reasoning_content);
        else if (d.content) contentParts.push(d.content);
        else if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            if (tc.function && tc.function.name) {
              const idx = toolCalls.findIndex((c) => c.index === tc.index);
              if (idx === -1) {
                toolCalls.push({
                  index: tc.index,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function.name, arguments: tc.function.arguments || '' },
                });
              }
            } else if (tc.index !== undefined) {
              const existing = toolCalls.find((t) => t.index === tc.index);
              if (existing) existing.function.arguments += tc.function?.arguments || '';
            }
          }
        }
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
      { toolParser }
    );
  });
  const joinedContent = contentParts.join('');
  let parsedCalls = toolCalls;
  let cleanedText = joinedContent;
  if (toolParser) {
    const parsed = tools.parseToolCallsFromText(joinedContent);
    if (parsed.toolCalls.length > 0) {
      cleanedText = parsed.cleanedText;
      parsedCalls = parsed.toolCalls.map((c, i) => ({ ...c, index: i }));
    }
  }
  const hasTool = parsedCalls.length > 0;
  const assistant = {
    role: 'assistant',
    content: cleanedText || null,
    reasoning_content: reasoningParts.join('\n'),
  };
  if (hasTool) assistant.tool_calls = parsedCalls;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [
      {
        index: 0,
        message: assistant,
        finish_reason: hasTool ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Прокинуть SSE клиенту и завершить поток (streaming path). */
async function pipeThroughOpenAI(stream, res, opts = {}) {
  const toolParser = opts.toolParser || null;
  await new Promise((resolve) => {
    parseQwenSSE(
      stream,
      (line) => {
        res.write(line);
      },
      (error) => {
        if (error) {
          const errorChunk = {
            error: {
              message: error.message || 'Qwen upstream stream failed',
              type: 'upstream_error',
            },
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          if (opts.onError) opts.onError(error);
          res.end();
          resolve();
          return;
        }
        const finalChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: '',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: toolParser && toolParser.hasEmitted() ? 'tool_calls' : 'stop',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        resolve();
      },
      { toolParser }
    );
    stream.on('error', () => {
      try {
        res.end();
      } catch (_) {}
      resolve();
    });
  });
}

module.exports = {
  preparePublicPayload,
  buildChatBody,
  parseQwenSSE,
  collectNonStream,
  pipeThroughOpenAI,
  getChatType,
};
