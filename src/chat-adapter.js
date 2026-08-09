'use strict';

const crypto = require('crypto');
const config = require('./config');
const qwenClient = require('./qwen-client');
const tools = require('./tools');
const toolMemo = require('./tool-memo');
const compressor = require('./context-compressor');
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
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p || typeof p !== 'object') return '';
        if (typeof p.text === 'string') return p.text;
        if (typeof p.content === 'string') return p.content;
        return '';
      })
      .join(' ');
  }
  if (content && typeof content === 'object') {
    return extractText(content.text || content.content || content.encrypted_content || '');
  }
  return '';
}

function compactText(value, limit = config.AGENT_MESSAGE_MAX_CHARS) {
  const text = extractText(value).trim();
  if (text.length <= limit) return text;
  const keep = Math.max(1000, Math.floor(limit * 0.7));
  return `${text.slice(0, keep)}\n...[compacted ${text.length - limit} chars]...\n${text.slice(-Math.max(500, limit - keep - 40))}`;
}

const HISTORY_MARKER = '# Conversation history (JSONL)';
const CURRENT_MESSAGE_MARKER = '# Current message';
const TOOL_FOLLOW_UP_MARKER = '# Required tool follow-up';
const COMPACTION_PROMPT = [
  'Create a dense handoff checkpoint for another coding agent that will continue this exact task.',
  'Preserve all user requirements and prohibitions, decisions, file paths, edits already made, tool results, failures, tests, current state, and concrete next steps.',
  'Remove repetition and obsolete intermediate chatter. Do not call tools, do not add commentary, and output only the checkpoint text.',
].join(' ');

function compactSystemInstructions(value) {
  const text = extractText(value).replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  const sections = [];
  const keepBlock = (open, close) => {
    const start = text.indexOf(open);
    if (start === -1) return;
    const end = text.indexOf(close, start + open.length);
    sections.push(end === -1 ? text.slice(start) : text.slice(start, end + close.length));
  };

  // Extract project instructions (e.g. AGENTS.md content)
  const instructions = [...text.matchAll(/Instructions from:[\s\S]*?(?=\nInstructions from:|\n<|$)/g)].map((m) => m[0].trim());
  sections.push(...instructions);
  keepBlock('<mcp_instructions>', '</mcp_instructions>');

  const base = [
    'You are OpenCode, an interactive software-engineering agent.',
    'Before inspecting or modifying repository files, check for instruction files like AGENTS.md.',
    'Use tools for actions. Never claim to have performed actions without a tool result.',
  ];

  const merged = [...base, ...new Set(sections.filter(Boolean))].join('\n\n');
  // Preserve full AGENTS.md and MCP instructions while remaining safe for WAF
  if (merged.length > 14000) return merged.slice(0, 14000) + '\n...[system truncated]...';
  return merged;
}

/**
 * Qwen web принимает ОДНО текущее сообщение. Историю сворачиваем в JSONL-конверт,
 * как делает сам интерфейс во время мультитарна. Если есть tool-протокол, внедряем
 * его в начало конверта и раскладываем tool_calls/результаты в читаемый текст.
 */
function stripCommandMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const result = [];
  let skipNextAssistant = false;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    const txt = extractText(m.content).trim();
    if (m.role === 'user' && (txt.startsWith('$qwen-api') || txt.startsWith('/qwen-api'))) {
      skipNextAssistant = true;
      continue;
    }
    if (m.role === 'assistant' && (skipNextAssistant || txt.includes('⚡ **Compressor') || txt.includes('🛠️ **Qwen Proxy') || txt.includes('👥 **Configured Qwen') || txt.includes('🧠 **Qwen Memo') || txt.includes('🔄 **Session Reset'))) {
      skipNextAssistant = false;
      continue;
    }
    skipNextAssistant = false;
    result.push(m);
  }
  return result;
}

function foldMessages(rawMessages, toolPrompt = '', options = {}) {
  const messages = stripCommandMessages(rawMessages);
  if (!Array.isArray(messages) || messages.length === 0) {
    return { role: 'user', content: toolPrompt || 'Hello' };
  }
  const compressedMessages = compressor.compressConversationHistory(messages, options);
  const folded = toolPrompt ? tools.foldToolMessages(compressedMessages) : compressedMessages;
  const last = folded[folded.length - 1];
  const lastIsToolResult = last?.role === 'tool' || (
    last?.role === 'user' && extractText(last.content).trim().startsWith('<tool_response')
  );

  const system = folded.find((message) => message?.role === 'system');
  const rawSystemText = system ? extractText(system.content).trim() : '';

  const effort = String(options.reasoningEffort || '').toLowerCase();
  let reasoningPrompt = '';
  if (effort === 'low') {
    reasoningPrompt = 'CRITICAL REQUIREMENT: Before answering or calling any tools, you MUST write your step-by-step reasoning process enclosed strictly inside <think>...</think> tags. Keep it concise (2-4 bullet points).';
  } else if (effort === 'medium') {
    reasoningPrompt = 'CRITICAL REQUIREMENT: Before answering or calling any tools, you MUST write your thorough step-by-step reasoning process enclosed strictly inside <think>...</think> tags.';
  } else if (effort === 'high' || effort === 'max') {
    reasoningPrompt = 'CRITICAL REQUIREMENT: Before answering or calling any tools, you MUST write an exhaustive, deep step-by-step reasoning analysis enclosed strictly inside <think>...</think> tags. Explore edge cases and verify logic thoroughly.';
  } else {
    reasoningPrompt = 'CRITICAL REQUIREMENT: Before answering or calling any tools, you MUST write your step-by-step reasoning process enclosed strictly inside <think>...</think> tags.';
  }

  if (options.currentOnly) {
    const currentText = compactText(last.content);
    const parts = [];
    if (rawSystemText) {
      parts.push(compactSystemInstructions(rawSystemText));
    }
    if (toolPrompt) parts.push(toolPrompt);
    if (options.compaction) parts.push(COMPACTION_PROMPT);
    if (reasoningPrompt) parts.push(`[Reasoning Directive]\n${reasoningPrompt}`);
    if (currentText) parts.push(CURRENT_MESSAGE_MARKER, JSON.stringify({ role: last.role, content: currentText }));
    if (lastIsToolResult) {
      parts.push(
        TOOL_FOLLOW_UP_MARKER,
        'The current message is a tool result, not a new user request. Continue the original user task now.',
        'Do not ask what the user wants to do with this result. Inspect the result, call the next necessary tool, or provide the concrete diagnosis/fix requested earlier.',
      );
    }
    return { role: last.role || 'user', content: parts.join('\n') || 'Hello' };
  }

  const history = folded.slice(0, -1);
  const historyLines = history
    .map((m) => {
      const s = m.role === 'system' ? '' : compactText(m.content);
      return s ? JSON.stringify({ role: m.role, content: s }) : '';
    })
    .filter(Boolean);

  const historyBudget = Math.max(4000, config.AGENT_HISTORY_MAX_CHARS);
  let historyText = historyLines.join('\n');
  if (historyText.length > historyBudget) {
    const first = historyLines[0] || '';
    const recent = [];
    let used = first.length;
    for (let i = historyLines.length - 1; i > 0; i -= 1) {
      const line = historyLines[i];
      if (used + line.length + 1 > historyBudget) break;
      recent.unshift(line);
      used += line.length + 1;
    }
    historyText = [first, '... [older history compacted] ...', ...recent].filter(Boolean).join('\n');
  }

  const lastText = compactText(last.content);
  const parts = [];

  if (rawSystemText) {
    parts.push(compactSystemInstructions(rawSystemText));
  }

  if (toolPrompt) parts.push(toolPrompt);
  if (options.compaction) parts.push(COMPACTION_PROMPT);

  // Inject session tool memory summary so the model can passively reference past results
  if (options.sessionKey && !options.compaction) {
    const memo = toolMemo.autoSummary(options.sessionKey);
    if (memo) parts.push(memo);
  }

  if (reasoningPrompt) {
    parts.push(`[Reasoning Directive]\n${reasoningPrompt}`);
  }

  if (historyText) parts.push(HISTORY_MARKER, historyText);
  if (lastText) parts.push(CURRENT_MESSAGE_MARKER, JSON.stringify({ role: last.role, content: lastText }));
  if (lastIsToolResult) {
    parts.push(
      TOOL_FOLLOW_UP_MARKER,
      'The current message is a tool result, not a new user request. Continue the original user task now.',
      'Do not ask what the user wants to do with this result. Inspect the result, call the next necessary tool, or provide the concrete diagnosis/fix requested earlier.',
    );
  }
  if (options.isContinuation) {
    parts.push(
      '### Continuation Instruction:',
      'The user sent a continuation request ("продолжи" / "continue").',
      'DO NOT write explanatory status text, TODO lists, or planning chatter outside <think>.',
      'Execute the next step immediately using a <tool_call> block (e.g. write_file, replace_file_content, bash).',
    );
  }
  return { role: last.role || 'user', content: parts.join('\n') || 'Hello' };
}

/**
 * Собрать полноценное тело запроса chat/completions (форма живого SPA 0.2.83).
 */
function buildChatBody(chatId, model, messages, thinking, toolPrompt = '', search = false, options = {}) {
  const baseType = getChatType(model);
  const chatType = search ? 'search' : baseType;
  const { role, content } = foldMessages(messages, toolPrompt, options);

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
          thinking_enabled: false,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
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
async function preparePublicPayload(openaiBody, options = {}) {
  const model = openaiBody.model || config.DEFAULT_MODEL;
  const reasoningEffort = String(
    openaiBody.reasoning_effort ||
    openaiBody.reasoningEffort ||
    options.reasoningEffort ||
    options.headers?.['x-reasoning-effort'] ||
    options.headers?.['reasoning-effort'] ||
    ''
  ).toLowerCase();

  const thinking =
    openaiBody.thinking === true ||
    options.thinking === true ||
    String(model).toLowerCase().includes('thinking') ||
    Boolean(reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== 'off');

  const lastUserMsg = [...(openaiBody.messages || [])].reverse().find((m) => m?.role === 'user');
  const lastUserText = (typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '').trim().toLowerCase();
  const isContinuation = lastUserText.length <= 25 && /^(продолжи|продолжай|continue|go ahead|давай|делай|proceed)$/i.test(lastUserText);

  let effectiveToolChoice = openaiBody.tool_choice;
  if (isContinuation && Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0 && !effectiveToolChoice) {
    effectiveToolChoice = 'required';
  }

  const fullToolPrompt = options.compaction
    ? ''
    : tools.buildToolPrompt(openaiBody.tools, effectiveToolChoice);
  const toolPromptHash = fullToolPrompt
    ? crypto.createHash('sha256').update(fullToolPrompt).digest('hex').slice(0, 16)
    : '';
  const toolPrompt = (options.skipToolPrompt && options.existingToolPromptHash === toolPromptHash)
    ? ''
    : fullToolPrompt;
  const hasTools = !!fullToolPrompt;
  const search =
    openaiBody.search === true ||
    String(openaiBody.chat_type || '').toLowerCase() === 'search';

  const chatId = options.chatId || (await qwenClient.generateChatID(model, getChatType(model), options.account));
  if (!chatId) {
    throw new Error('Failed to create a Qwen chat (session/WAF). Re-login with `npm run login`.');
  }

  // Инвариант: существующий chatId означает, что Qwen-тред УЖЕ получил полный
  // folded-конверт первым сообщением и далее помнит каждый ход, включая текст
  // `<tool_call>` ассистента. Поэтому при любом продолжении треда — и для
  // tool-ходов тоже — отправляем ТОЛЬКО текущее сообщение (currentOnly). Иначе
  // foldMessages вкладывал всю клиентскую историю в content каждого tool-хода
  // поверх серверной истории: на 2-м ходе Qwen видел историю дважды, на 3-м —
  // трижды (рост O(n^2)) и путался, видя свои ответы внутри user-сообщений.
  // Сценарий «изолированного tool-результата без исходного tool call» относится
  // только к НОВОМУ треду — а у него chatId нет, и currentOnly остаётся false.
  const sessionKey = options.sessionKey || null;

  // Auto-capture tool responses into memo before building this turn's payload
  if (sessionKey && hasTools) {
    const msgs = openaiBody.messages || [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== 'tool') continue;
      // Find the corresponding tool_call to get the name + args
      const callId = m.tool_call_id;
      let toolName = m.name || 'unknown';
      let toolArgs = {};
      for (let j = i - 1; j >= 0; j--) {
        const prev = msgs[j];
        if (prev?.role === 'assistant' && Array.isArray(prev.tool_calls)) {
          const tc = prev.tool_calls.find((c) => c.id === callId);
          if (tc) {
            toolName = tc.function?.name || toolName;
            toolArgs = tc.function?.arguments || {};
            break;
          }
        }
      }
      const rawText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      // Skip memo_recall self-referential saves
      if (toolName !== 'memo_recall') {
        toolMemo.save(sessionKey, toolName, toolArgs, rawText);
      }
    }

    // Синхронизируем иерархию шагов и таймштампов всей сессии
    toolMemo.syncMessages(sessionKey, openaiBody.messages);

    // Intercept memo_recall tool calls: synthesize the response in-proxy
    // so OpenCode never needs to handle this virtual tool via MCP.
    const lastMsg = (openaiBody.messages || []).at(-1);
    if (lastMsg?.role === 'tool' && lastMsg?.name === 'memo_recall') {
      // Already a memo_recall response — nothing to do, just proceed normally
    } else {
      // Check if the last assistant message (before last user/tool turn) requested memo_recall
      const lastAssistant = [...(openaiBody.messages || [])].reverse().find((m) => m?.role === 'assistant');
      if (lastAssistant && Array.isArray(lastAssistant.tool_calls)) {
        const memoCall = lastAssistant.tool_calls.find((c) => c.function?.name === 'memo_recall');
        if (memoCall && sessionKey) {
          let args = {};
          try { args = JSON.parse(memoCall.function?.arguments || '{}'); } catch (_) { /* ok */ }
          const recallResult = toolMemo.recall(sessionKey, args.query || 'recent', args.max_chars);
          // Inject synthetic tool response into messages so Qwen sees the complete turn
          openaiBody = {
            ...openaiBody,
            messages: [
              ...openaiBody.messages,
              { role: 'tool', tool_call_id: memoCall.id, name: 'memo_recall', content: recallResult },
            ],
          };
          logger.debug('[tool-memo] intercepted memo_recall, injected synthetic response', 'MEMO');
        }
      }
    }
  }

  const qwenPayload = buildChatBody(
    chatId,
    model,
    openaiBody.messages,
    thinking,
    toolPrompt,
    search,
    {
      ...options,
      currentOnly: options.currentOnly !== undefined ? options.currentOnly : false,
      compaction: Boolean(options.compaction),
      sessionKey,
      reasoningEffort,
      isContinuation,
    },
  );
  return { qwenPayload, model, chatId, hasTools, toolPromptHash, isContinuation };
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
  const requireToolCall = Boolean(opts.requireToolCall);

  let buffer = '';
  let seq = 0;
  let closed = false;
  let emittedSummaryCount = 0;
  let acceptedResponseId = null;
  let idleTimer = null;
  let emittedOutput = false;
  let receivedFrames = 0;
  let responseFrameCount = 0;
  let lastFrameShape = '';
  let inThinkBlock = false;
  let thinkBuffer = '';
  let lastUsage = null;

  let bufferedDataLines = [];
  let toolCallDetected = false;

  const emitData = (lineStr) => {
    if (requireToolCall && !toolCallDetected) {
      bufferedDataLines.push(lineStr);
      if (toolParser && toolParser.getCalls().length > 0) {
        toolCallDetected = true;
        emittedOutput = true;
        for (const line of bufferedDataLines) onData(line);
        bufferedDataLines = [];
      }
    } else {
      emittedOutput = true;
      onData(lineStr);
    }
  };

  const processThinkBuffer = (flush = false) => {
    let directContent = '';
    const OPEN_TAG = /<think(?:ing)?>/i;
    const CLOSE_TAG = /<\/think(?:ing)?>/i;

    while (thinkBuffer.length > 0) {
      if (!inThinkBlock) {
        const match = thinkBuffer.match(OPEN_TAG);
        if (match) {
          const before = thinkBuffer.slice(0, match.index);
          if (before) directContent += before;
          inThinkBlock = true;
          thinkBuffer = thinkBuffer.slice(match.index + match[0].length);
          continue;
        }

        const openIdx = thinkBuffer.indexOf('<');
        if (openIdx !== -1) {
          if (openIdx > 0) {
            directContent += thinkBuffer.slice(0, openIdx);
            thinkBuffer = thinkBuffer.slice(openIdx);
          }
          if (!flush && ('<thinking>'.startsWith(thinkBuffer.toLowerCase()) || '<think>'.startsWith(thinkBuffer.toLowerCase()))) {
            break;
          } else {
            directContent += thinkBuffer;
            thinkBuffer = '';
            break;
          }
        } else {
          directContent += thinkBuffer;
          thinkBuffer = '';
          break;
        }
      }

      if (inThinkBlock) {
        const matchEnd = thinkBuffer.match(CLOSE_TAG);
        if (matchEnd) {
          const thinkText = thinkBuffer.slice(0, matchEnd.index);
          if (thinkText) {
            emittedOutput = true;
            const chunk = chunkId();
            chunk.choices[0].delta.reasoning_content = thinkText;
            onData(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          inThinkBlock = false;
          thinkBuffer = thinkBuffer.slice(matchEnd.index + matchEnd[0].length);
          continue;
        }

        const closeIdx = thinkBuffer.indexOf('</');
        if (closeIdx !== -1) {
          if (closeIdx > 0) {
            const thinkText = thinkBuffer.slice(0, closeIdx);
            emittedOutput = true;
            const chunk = chunkId();
            chunk.choices[0].delta.reasoning_content = thinkText;
            onData(`data: ${JSON.stringify(chunk)}\n\n`);
            thinkBuffer = thinkBuffer.slice(closeIdx);
          }
          if (!flush && ('</thinking>'.startsWith(thinkBuffer.toLowerCase()) || '<think>'.startsWith(thinkBuffer.toLowerCase()))) {
            break;
          } else {
            emittedOutput = true;
            const chunk = chunkId();
            chunk.choices[0].delta.reasoning_content = thinkBuffer;
            onData(`data: ${JSON.stringify(chunk)}\n\n`);
            thinkBuffer = '';
            break;
          }
        } else {
          emittedOutput = true;
          const chunk = chunkId();
          chunk.choices[0].delta.reasoning_content = thinkBuffer;
          onData(`data: ${JSON.stringify(chunk)}\n\n`);
          thinkBuffer = '';
          break;
        }
      }
    }
    return directContent;
  };

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
    toolCallDetected = true;
    emittedOutput = true;
    if (bufferedDataLines.length > 0) {
      for (const line of bufferedDataLines) onData(line);
      bufferedDataLines = [];
    }
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
      if (!error && lastUsage) {
        seq += 1;
        const usageChunk = {
          id: `chatcmpl-${seq}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: '',
          choices: [],
          usage: lastUsage,
        };
        onData(`data: ${JSON.stringify(usageChunk)}\n\n`);
      }
      if (onDone) onDone(error, { usage: lastUsage });
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
    if (!trimmed) return;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') close();
      return;
    }

    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      return;
    }

    // Explicitly handle Qwen RateLimit or Captcha/WAF errors in SSE stream
    if (obj.success === false && obj.data && obj.data.code === 'RateLimited') {
      const waitHours = obj.data.num || 6;
      const accEmail = (opts.account && opts.account.email) ? opts.account.email : 'active account';
      const msg = `RateLimited: Account ${accEmail} reached Qwen daily limit (wait ~${waitHours}h). Switching to next account.`;
      return close(new Error(msg));
    }
    if (obj.ret && Array.isArray(obj.ret) && obj.ret.join('').includes('RGV587_ERROR')) {
      const captchaUrl = (obj.data && obj.data.url) || '';
      return close(new Error(`WAF_CAPTCHA_CHALLENGE:${captchaUrl}`));
    }
    if (obj.error || (obj.success === false && obj.message)) {
      const msg = obj.error?.message || obj.message || 'Qwen upstream error';
      return close(new Error(`Qwen Upstream Error: ${msg}`));
    }

    if (obj.usage) {
      lastUsage = {
        prompt_tokens: Number(obj.usage.input_tokens || 0),
        completion_tokens: Number(obj.usage.output_tokens || 0),
        total_tokens: Number(obj.usage.total_tokens || (Number(obj.usage.input_tokens || 0) + Number(obj.usage.output_tokens || 0))),
      };
    }

    receivedFrames += 1;
    if (obj === true || obj.data === true) return close();
    if (obj['response.created'] || obj['response.updated']) return;
    if (!acceptFrame(obj)) return;

    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    responseFrameCount += 1;
    // Qwen has returned both streaming `delta` frames and terminal-style
    // `message`/`text` frames across web-client versions. Normalize them so a
    // valid answer is not discarded just because its envelope changed.
    const delta = choice.delta || {};
    const message = choice.message || {};
    const phase = delta.phase;
    lastFrameShape = Object.keys(delta).concat(Object.keys(message).map((key) => `message.${key}`)).join(',');

    let content = '';
    let reasoning = '';

    const rawContent = delta.content || delta.text || choice.text || message.content || obj.content || '';
    content = extractText(rawContent);

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
    }

    if (!reasoning) {
      reasoning = delta.reasoning_content || message.reasoning_content || obj.reasoning_content || '';
    }

    if (content) {
      thinkBuffer += content;
    }
    const directContent = processThinkBuffer(false);

    if (reasoning) {
      emittedOutput = true;
      const chunk = chunkId();
      chunk.choices[0].delta.reasoning_content = reasoning;
      onData(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    if (directContent && toolParser) {
      const parsed = toolParser.push(directContent);
      if (parsed.textDelta) {
        const chunk = chunkId();
        chunk.choices[0].delta.content = parsed.textDelta;
        emitData(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (parsed.calls.length > 0) writeToolCallDeltas(parsed.calls);
    } else if (directContent) {
      const chunk = chunkId();
      chunk.choices[0].delta.content = directContent;
      emitData(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Некоторые версии Qwen завершают SSE кадром `status: finished` без
    // отдельного `data: true` или `[DONE]`.
    // В зависимости от типа запроса Qwen может не прислать phase в финальном
    // кадре. Не закрываем thinking-кадры, но принимаем finished для answer
    // или кадра, содержащего поле content.
    const finishedAnswer =
      delta.status === 'finished' &&
      (phase === 'answer' ||
        (phase === undefined && Object.prototype.hasOwnProperty.call(delta, 'content')));
    if (finishedAnswer || choice.finish_reason) {
      const finalDirectContent = processThinkBuffer(true);
      if (finalDirectContent) {
        if (toolParser) {
          const parsed = toolParser.push(finalDirectContent);
          if (parsed.textDelta) {
            const chunk = chunkId();
            chunk.choices[0].delta.content = parsed.textDelta;
            emitData(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } else {
          const chunk = chunkId();
          chunk.choices[0].delta.content = finalDirectContent;
          emitData(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
      close();
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
    const flushContent = processThinkBuffer(true);
    if (flushContent) {
      if (toolParser) {
        const parsed = toolParser.push(flushContent);
        if (parsed.textDelta) {
          const chunk = chunkId();
          chunk.choices[0].delta.content = parsed.textDelta;
          emitData(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } else {
        const chunk = chunkId();
        chunk.choices[0].delta.content = flushContent;
        emitData(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
    if (toolParser) {
      const tail = toolParser.flush();
      if (tail.textDelta) {
        const chunk = chunkId();
        chunk.choices[0].delta.content = tail.textDelta;
        emitData(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (tail.calls.length > 0) {
        writeToolCallDeltas(tail.calls);
      }
    }
    if (requireToolCall && !toolCallDetected) {
      emittedOutput = false;
      bufferedDataLines = [];
    }
    // Node's `end` is orderly, but metadata-only or state-only responses without text
    // are not usable completions.
    if (!closed) {
      close(
        emittedOutput
          ? null
          : new Error(
              `Qwen upstream closed without a usable response (frames=${receivedFrames}, choices=${responseFrameCount}, fields=${lastFrameShape || 'none'})`,
            ),
      );
    }
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
  let lastUsage = null;
  await new Promise((resolve, reject) => {
    parseQwenSSE(
      stream,
      (line) => {
        const json = JSON.parse(line.slice(6));
        const d = json.choices && json.choices[0] && json.choices[0].delta;
        if (d) {
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
        }
      },
      (error, meta) => {
        if (meta && meta.usage) lastUsage = meta.usage;
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
    usage: lastUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Прокинуть SSE клиенту и завершить поток (streaming path). */
async function pipeThroughOpenAI(stream, res, opts = {}) {
  const toolParser = opts.toolParser || null;
  const retryEmpty = typeof opts.retryEmpty === 'function' ? opts.retryEmpty : null;
  const maxEmptyRetries = Math.max(0, Number(opts.maxEmptyRetries ?? 3));
  let emptyRetries = 0;

  const pipe = async (currentStream) => new Promise((resolve) => {
    parseQwenSSE(
      currentStream,
      (line) => {
        res.write(line);
      },
      (error) => {
        if (error) {
          if (emptyRetries < maxEmptyRetries && retryEmpty && /^Qwen upstream closed without a usable response/i.test(error.message)) {
            emptyRetries += 1;
            Promise.resolve(retryEmpty(error, emptyRetries)).then((replacement) => {
              if (replacement) {
                pipe(replacement).then(resolve);
                return;
              }
              finishWithError(error, resolve);
            }, () => finishWithError(error, resolve));
            return;
          }
          finishWithError(error, resolve);
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
      { toolParser },
    );
    currentStream.on('error', () => {
      try {
        res.end();
      } catch (_) {}
      resolve();
    });
  });

  const finishWithError = (error, resolve) => {
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
  };

  await pipe(stream);
}

module.exports = {
  preparePublicPayload,
  buildChatBody,
  parseQwenSSE,
  collectNonStream,
  pipeThroughOpenAI,
  getChatType,
};
