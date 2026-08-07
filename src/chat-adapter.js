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

 // OpenCode builds the system prompt from these dynamic sections. Keep their
 // contents, but replace its long generic CLI prompt with a small contract.
 const instructions = [...text.matchAll(/Instructions from:[\s\S]*?(?=\nInstructions from:|\n<|$)/g)].map((m) => m[0].trim());
 sections.push(...instructions);
 keepBlock('<mcp_instructions>', '</mcp_instructions>');

 const skillsStart = text.indexOf('Skills provide specialized instructions and workflows');
 if (skillsStart !== -1) {
 const skillsEnd = text.indexOf('<mcp_instructions>', skillsStart);
 sections.push(text.slice(skillsStart, skillsEnd === -1 ? text.length : skillsEnd).trim());
 }

 const base = [
 'You are OpenCode, an interactive software-engineering agent.',
 'Complete the user request using only capabilities exposed in this request.',
 'The tools block in the current message is your actual interface to the local workspace. If file tools are listed, you can inspect repository files yourself; do not ask the user to paste files merely because you cannot access their filesystem outside the tools.',
 'For a request to inspect a file such as AGENTS.md, use list_dir/read_file (or bash if listed) and report the tool result. Do not claim that the user must upload or paste the file.',
 'Before inspecting or modifying repository files, look for Markdown instruction files in the repository (especially AGENTS.md and other relevant .md files), read the applicable ones with tools, and follow their instructions. Do not assume an instruction file exists; discover it first.',
 'Use tools for actions. Never claim to have read, changed, searched, executed, or verified anything without a tool result.',
 'Call tools with their exact exposed names and arguments. A tool result is not a new user question: use it to continue the original task, call more tools if needed, and answer only when the requested task is finished.',
 'Do not invent tools, skills, MCP servers, loaders, files, database access, commands, or tool results.',
 'Skills are usable only when a matching skill is listed and a skill-loading tool is exposed. MCP is usable only through MCP tools exposed in this request.',
 'Follow project instructions included below when relevant. If a requested capability is unavailable, state that plainly.',
 ];

 return [...base, ...new Set(sections.filter(Boolean))].join('\n\n');
}

/**
 * Qwen web принимает ОДНО текущее сообщение. Историю сворачиваем в JSONL-конверт,
 * как делает сам интерфейс во время мультитарна. Если есть tool-протокол, внедряем
 * его в начало конверта и раскладываем tool_calls/результаты в читаемый текст.
 */
function foldMessages(messages, toolPrompt = '', options = {}) {
 if (!Array.isArray(messages) || messages.length === 0) {
 return { role: 'user', content: toolPrompt || 'Hello' };
 }
 const folded = toolPrompt ? tools.foldToolMessages(messages) : messages;
 const last = folded[folded.length - 1];
 const lastIsToolResult = last?.role === 'tool' || (
 last?.role === 'user' && extractText(last.content).trim().startsWith('<tool_response')
 );
 if (options.currentOnly) {
 const currentText = compactText(last.content);
 const parts = [];
 if (toolPrompt) parts.push(toolPrompt);
 if (options.compaction) parts.push(COMPACTION_PROMPT);
 const system = folded.find((message) => message?.role === 'system');
 const systemText = system ? compactSystemInstructions(system.content) : '';
 if (systemText) parts.push(systemText);
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
 const s = m.role === 'system' ? compactSystemInstructions(m.content) : compactText(m.content);
 return s ? JSON.stringify({ role: m.role, content: s }) : '';
 })
 .filter(Boolean);
 const historyBudget = Math.max(4000, config.AGENT_HISTORY_MAX_CHARS);
 let historyText = historyLines.join('\n');
 if (historyText.length > historyBudget) {
 // Keep the initial user request plus the newest tool turns. Older tool
 // results are useful less often than the current task and can be huge.
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
 if (toolPrompt) parts.push(toolPrompt);
 if (options.compaction) parts.push(COMPACTION_PROMPT);
 if (historyText) parts.push(HISTORY_MARKER, historyText);
 if (lastText) parts.push(CURRENT_MESSAGE_MARKER, JSON.stringify({ role: last.role, content: lastText }));
 if (lastIsToolResult) {
 parts.push(
 TOOL_FOLLOW_UP_MARKER,
 'The current message is a tool result, not a new user request. Continue the original user task now.',
 'Do not ask what the user wants to do with this result. Inspect the result, call the next necessary tool, or provide the concrete diagnosis/fix requested earlier.',
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
async function preparePublicPayload(openaiBody, options = {}) {
 const model = openaiBody.model || config.DEFAULT_MODEL;
 const thinking =
 openaiBody.thinking === true ||
 String(model).toLowerCase().includes('thinking') ||
 openaiBody.reasoning_effort !== undefined;

 const toolPrompt = options.compaction
 ? ''
 : tools.buildToolPrompt(openaiBody.tools, openaiBody.tool_choice);
 const hasTools = !!toolPrompt;
 const search =
 openaiBody.search === true ||
 String(openaiBody.chat_type || '').toLowerCase() === 'search';

 const chatId = options.chatId || (await qwenClient.generateChatID(model, getChatType(model)));
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
 const qwenPayload = buildChatBody(
 chatId,
 model,
 openaiBody.messages,
 thinking,
 toolPrompt,
 search,
 {
 currentOnly: Boolean(options.chatId) && !options.compaction,
 compaction: Boolean(options.compaction),
 },
 );
 return { qwenPayload, model, chatId, hasTools };
}

// ==================== SSE parsing / OpenAI encode ====================

const THINK_PHASES = new Set(['think', 'thinking', 'thinking_summary']);

/**
 * Разбор upstream SSE. Каждый значимый фрагмент вызывает onData(line).
 * - thinking_summary: `extra.summary_thought.content` — растущий массив абзацев,
 * выдаём только новые (инкрементально), чтобы не дублировать reasoning.
 * - answer: content. Если включён tool-режим, контент прогоняется через
 * XML-парсер и транслируется в OpenAI tool_calls delta.
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
 let emittedOutput = false;
 let receivedFrames = 0;
 let responseFrameCount = 0;
 let lastFrameShape = '';

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
 emittedOutput = true;
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
 const rawContent = delta.content || delta.text || choice.text || message.content || obj.content || '';
 content = extractText(rawContent);
 }

 if (!reasoning) {
 reasoning = delta.reasoning_content || message.reasoning_content || obj.reasoning_content || '';
 }

 if (reasoning) {
 emittedOutput = true;
 const chunk = chunkId();
 chunk.choices[0].delta.reasoning_content = reasoning;
 onData(`data: ${JSON.stringify(chunk)}\n\n`);
 }

 if (content && toolParser) {
 const parsed = toolParser.push(content);
 if (parsed.textDelta) {
 emittedOutput = true;
 const chunk = chunkId();
 chunk.choices[0].delta.content = parsed.textDelta;
 onData(`data: ${JSON.stringify(chunk)}\n\n`);
 }
 if (parsed.calls.length > 0) writeToolCallDeltas(parsed.calls);
 } else if (content) {
 emittedOutput = true;
 const chunk = chunkId();
 chunk.choices[0].delta.content = content;
 onData(`data: ${JSON.stringify(chunk)}\n\n`);
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
 if (finishedAnswer || choice.finish_reason) close();
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
 emittedOutput = true;
 const chunk = chunkId();
 chunk.choices[0].delta.content = tail.textDelta;
 onData(`data: ${JSON.stringify(chunk)}\n\n`);
 }
 if (tail.calls.length > 0) writeToolCallDeltas(tail.calls);
 }
 // Node's `end` is orderly, but metadata-only responses are not usable
 // completions. Qwen frequently omits [DONE] and finish_reason, so require
 // actual output rather than a protocol terminal event.
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
 if (emptyRetries < maxEmptyRetries && retryEmpty && /^Qwen upstream closed without a usable response \(frames=0/.test(error.message)) {
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
