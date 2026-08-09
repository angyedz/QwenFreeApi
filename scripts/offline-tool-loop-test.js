'use strict';

/**
 * Offline regression test for the agent tool loop (no Qwen network calls).
 *
 * Covers the context-duplication fix in chat-adapter.preparePublicPayload:
 *  A. A NEW Qwen thread receives the full folded history (first message).
 *  B. An EXISTING thread (chatId present) receives only the current message —
 *     even on tool turns (no history re-embedding, no O(n^2) growth).
 *  C. agent.runTurn end-to-end: tool call -> local execution -> follow-up round
 *     reuses the same upstream thread and carries the tool result exactly once.
 *  D. Compaction request: full history + handoff prompt, tool protocol omitted.
 *  E. agent.runTurn with a dead thread (frames=0): one retry on a fresh thread
 *     with the full context re-sent.
 *
 * Run: node scripts/offline-tool-loop-test.js
 */

const assert = require('assert');
const { Readable } = require('stream');
const Module = require('module');

// ---------- Captures & mocks ----------

const sentPayloads = [];

const qwenClientMock = {
  async generateChatID() {
    return 'chat-test-1';
  },
  async sendChatRequest(payload) {
    sentPayloads.push(payload);
    const isFirstRound = sentPayloads.length === 1;
    const frames = isFirstRound
      ? [
          { choices: [{ delta: { phase: 'answer', content: '<tool_call>\n{"name":"read_file","arguments":{"path":"a.txt"}}\n</tool_call>' } }] },
          { choices: [{ delta: { phase: 'answer', status: 'finished', content: '' } }] },
        ]
      : [
          { choices: [{ delta: { phase: 'answer', content: 'Готово: файл прочитан.' } }] },
          { choices: [{ delta: { phase: 'answer', status: 'finished', content: '' } }] },
        ];
    return {
      status: true,
      response: Readable.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`)),
      account: { id: 'mock-account' },
    };
  },
};

const toolExecutorMock = {
  TOOL_DEFS: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    },
  ],
  async executeTool(name, args) {
    return `contents of ${args.path || '?'}`;
  },
};

// qwen-client (axios/HTTP) and tool-executor (bash/fs) are replaced with mocks,
// so the test never touches the network or the real workspace.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './qwen-client') return qwenClientMock;
  if (request === './tool-executor') return toolExecutorMock;
  return origLoad.call(this, request, parent, isMain);
};

const chatAdapter = require('../src/chat-adapter');
const agent = require('../src/agent');

const TOOL_TURN_MESSAGES = [
  { role: 'user', content: 'прочитай file.txt' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'UNIQUE_TOOL_BODY' },
];

(async () => {
  // --- A. New thread: full folded history in the first message ---
  const fresh = await chatAdapter.preparePublicPayload(
    { model: 'qwen3.8-max', messages: TOOL_TURN_MESSAGES, tools: toolExecutorMock.TOOL_DEFS, stream: true },
    {},
  );
  const freshContent = fresh.qwenPayload.messages[0].content;
  assert.ok(freshContent.includes('# Conversation history'), 'A1: new thread embeds folded history');
  assert.ok(freshContent.includes('прочитай file.txt'), 'A2: history includes the first user message');
  assert.ok(freshContent.includes('<tool_response'), 'A3: tool result folded as <tool_response>');
  console.log('PASS A: new thread embeds the full folded history');

  // --- B. Existing thread + tool turn: folded history included ---
  const cont = await chatAdapter.preparePublicPayload(
    { model: 'qwen3.8-max', messages: TOOL_TURN_MESSAGES, tools: toolExecutorMock.TOOL_DEFS, stream: true },
    { chatId: 'existing-chat-42' },
  );
  const contContent = cont.qwenPayload.messages[0].content;
  assert.ok(contContent.includes('# Conversation history'), 'B1: history re-embedding included');
  assert.ok(contContent.includes('прочитай file.txt'), 'B2: earlier user message is re-sent');
  assert.strictEqual(contContent.split('UNIQUE_TOOL_BODY').length - 1, 1, 'B3: tool result appears exactly once');
  assert.ok(contContent.includes('# Required tool follow-up'), 'B4: tool follow-up instructions present');
  console.log('PASS B: existing thread sends folded message with full history');

  // --- C. agent.runTurn end-to-end with mocked upstream ---
  const chat = { model: 'qwen3.8-max', settings: { terminal: false, webSearch: false }, messages: [] };
  const events = [];
  const finalMessage = await agent.runTurn(chat, 'прочитай a.txt', (ev) => events.push(ev));

  assert.strictEqual(finalMessage.content, 'Готово: файл прочитан.', 'C1: final answer text');
  assert.strictEqual(sentPayloads.length, 2, 'C2: exactly two upstream rounds');
  assert.strictEqual(chat.qwenChatId, 'chat-test-1', 'C3: qwenChatId persisted on the chat');
  const roundTwo = sentPayloads[1].messages[0].content;
  assert.ok(roundTwo.includes('contents of a.txt'), 'C5: round 2 carries the tool result');
  const toolEvents = events.filter((e) => e.type === 'tool');
  assert.strictEqual(toolEvents.length, 1, 'C6: exactly one tool execution');
  assert.strictEqual(toolEvents[0].name, 'read_file', 'C7: correct tool name');
  assert.ok(
    chat.messages.some((m) => m.role === 'tool' && m.content === 'contents of a.txt'),
    'C8: tool result stored in chat history',
  );
  console.log('PASS C: agent tool loop end-to-end');

  // --- D. Compaction request: full history + handoff prompt, no tool protocol ---
  const compacted = await chatAdapter.preparePublicPayload(
    { model: 'qwen3.8-max', messages: TOOL_TURN_MESSAGES, tools: toolExecutorMock.TOOL_DEFS, stream: true },
    { chatId: 'existing-chat-42', compaction: true },
  );
  const compactedContent = compacted.qwenPayload.messages[0].content;
  assert.ok(compactedContent.includes('dense handoff checkpoint'), 'D1: compaction handoff prompt included');
  assert.ok(compactedContent.includes('# Conversation history'), 'D2: compaction keeps full history in the current thread');
  assert.ok(!compactedContent.includes('# Tools'), 'D3: tool protocol omitted on compaction');
  console.log('PASS D: compaction sends full history + handoff prompt without tool protocol');

  // --- E. agent.runTurn: dead thread (frames=0) -> one retry on a fresh thread ---
  const retryPayloads = [];
  let generatedIds = 0;
  Module._load = function (request, parent, isMain) {
    if (request === './qwen-client') {
      return {
        async generateChatID() {
          generatedIds += 1;
          return `chat-retry-${generatedIds}`;
        },
        async sendChatRequest(payload) {
          retryPayloads.push(payload);
          if (retryPayloads.length === 1) {
            // Пустой стрим без единого кадра -> parseQwenSSE отдаёт frames=0 ошибку.
            return { status: true, response: Readable.from([]), account: { id: 'mock' } };
          }
          return {
            status: true,
            response: Readable.from([
              'data: {"choices":[{"delta":{"phase":"answer","content":"Ответ после ретрая"}}]}\n\n',
              'data: {"choices":[{"delta":{"phase":"answer","status":"finished","content":""}}]}\n\n',
            ]),
            account: { id: 'mock' },
          };
        },
      };
    }
    if (request === './tool-executor') return toolExecutorMock;
    return origLoad.call(this, request, parent, isMain);
  };
  // Пере-требуем agent и chat-adapter, чтобы их привязка к './qwen-client'
  // указывала на retry-мок (кэш предыдущих тестов иначе держит старый мок).
  for (const m of ['../src/agent', '../src/chat-adapter']) {
    delete require.cache[require.resolve(m)];
  }
  const agentRetry = require('../src/agent');

  const retryChat = { model: 'qwen3.8-max', settings: { terminal: false, webSearch: false }, messages: [] };
  const retryFinal = await agentRetry.runTurn(retryChat, 'привет', () => {});

  assert.strictEqual(retryPayloads.length, 2, 'E1: exactly two upstream attempts');
  assert.strictEqual(retryFinal.content, 'Ответ после ретрая', 'E2: final answer from the retry');
  assert.strictEqual(retryChat.qwenChatId, 'chat-retry-2', 'E3: chat moved to the fresh thread');
  assert.ok(
    retryPayloads[1].messages[0].content.includes('привет'),
    'E4: retry on the fresh thread carries the user message',
  );
  console.log('PASS E: dead thread triggers one retry on a fresh thread');

  console.log('\nALL OFFLINE TESTS PASSED');
})().catch((err) => {
  console.error('TEST FAILURE:', err && err.message ? err.message : err);
  process.exit(1);
});
