#!/usr/bin/env node
'use strict';

/**
 * offline-sse-test.js — тест перевода Qwen SSE -> OpenAI в реальном формате 0.2.83.
 */
const { Readable } = require('stream');
const { parseQwenSSE, collectNonStream } = require('../src/chat-adapter');
const { buildChatBody } = require('../src/chat-adapter');
const sessionStore = require('../src/session-store');

const SAMPLE = [
  'data: {"response.created":{"chat_id":"abc","parent_id":"p1","response_id":"r1","response_index":"0"}}',
  'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"thinking_summary","extra":{"summary_title":{"content":["Reasoning"]},"summary_thought":{"content":["First thought","Second thought"]}}}}]}',
  'data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"thinking_summary","status":"finished"}}]}',
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hello, ","phase":"answer","status":"typing"}}]}',
  'data: {"choices":[{"delta":{"role":"assistant","content":"world!","phase":"answer"}}]}',
  'data: {"choices":[{"delta":{"content":"","role":"assistant","status":"finished","phase":"answer"}}]}',
  'data: true',
].join('\n');

const makeStream = () => Readable.from([Buffer.from(SAMPLE)]);

const makeFailedStream = () => {
  const stream = new Readable({ read() {} });
  process.nextTick(() => stream.destroy(new Error('simulated upstream failure')));
  return stream;
};

const makeFinishedWithoutPhaseStream = () => Readable.from([
  Buffer.from([
    'data: {"choices":[{"delta":{"content":"Ответ","status":"typing"}}]}\n',
    'data: {"choices":[{"delta":{"content":"","status":"finished"}}]}\n',
  ].join('')),
]);

const makeToolStreamWithoutTerminalEvent = () => Readable.from([
  Buffer.from([
    'data: {"choices":[{"delta":{"content":"<tool_call>\\n{\\"name\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"pwd\\"}}\\n</tool_call>"}}]}\n',
  ].join('')),
]);

const makeAnswerStreamWithoutTerminalEvent = () => Readable.from([
  Buffer.from('data: {"choices":[{"delta":{"content":"Ответ без DONE"}}]}\n'),
]);

const makeStateOnlyStreamWithoutTerminalEvent = () => Readable.from([
  Buffer.from('data: {"choices":[{"delta":{"phase":"answer","status":"typing"}}]}\n'),
]);

const makeMetadataOnlyStreamWithoutTerminalEvent = () => Readable.from([
  Buffer.from('data: {"response.created":{"response_id":"r1"}}\n'),
]);

const makeEmptyStream = () => Readable.from([]);

const makeTerminalMessageStream = () => Readable.from([
  Buffer.from('data: {"choices":[{"message":{"role":"assistant","content":"Ответ из message"}}]}\n'),
]);

const makeTextStream = () => Readable.from([
  Buffer.from('data: {"choices":[{"text":"Ответ из text"}]}\n'),
]);

const makeArrayContentStream = () => Readable.from([
  Buffer.from('data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"Ответ из массива"}]}}]}\n'),
]);

(async () => {
  // 1) Streaming
  const chunks = [];
  await new Promise((resolve) => {
    const s = makeStream();
    parseQwenSSE(s, (line) => chunks.push(line), resolve);
  });
  const parsed = chunks.map((l) => JSON.parse(l.slice(6)));
  const reasoningParts = parsed.map((c) => c.choices[0].delta.reasoning_content).filter(Boolean).join('');
  const answerParts = parsed.map((c) => c.choices[0].delta.content).filter(Boolean).join('');
  console.log('stream reasoning:', JSON.stringify(reasoningParts));
  console.log('stream answer   :', JSON.stringify(answerParts));
  if (reasoningParts !== 'First thought\nSecond thought') throw new Error('reasoning mismatch: ' + reasoningParts);
  if (answerParts !== 'Hello, world!') throw new Error('answer mismatch');

  // 2) Non-stream
  const json = await collectNonStream(makeStream());
  console.log('non-stream content:', JSON.stringify(json.choices[0].message.content));
  if (json.choices[0].message.content !== 'Hello, world!') throw new Error('non-stream mismatch');

  // Qwen may omit phase in the terminal answer frame.
  let finishedWithoutPhase;
  await new Promise((resolve, reject) => {
    collectNonStream(makeFinishedWithoutPhaseStream()).then((value) => {
      finishedWithoutPhase = value;
      resolve();
    }, reject);
  });
  if (finishedWithoutPhase.choices[0].message.content !== 'Ответ') {
    throw new Error('terminal answer without phase was not accepted');
  }

  // Qwen can close after a complete tool call without [DONE] or finish_reason.
  const toolResult = await collectNonStream(makeToolStreamWithoutTerminalEvent(), {
    toolParser: require('../src/tools').createToolCallStreamParser(),
  });
  const toolCall = toolResult.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.function.name !== 'bash') {
    throw new Error('tool call without terminal event was not accepted');
  }

  const answerResult = await collectNonStream(makeAnswerStreamWithoutTerminalEvent());
  if (answerResult.choices[0].message.content !== 'Ответ без DONE') {
    throw new Error('answer without terminal event was not accepted');
  }

  let stateOnlyError;
  await collectNonStream(makeStateOnlyStreamWithoutTerminalEvent()).catch((error) => {
    stateOnlyError = error;
  });
  if (!stateOnlyError || !/without a usable response/.test(stateOnlyError.message)) {
    throw new Error('state-only upstream response was accepted as a completion');
  }
  let unusableError;
  await collectNonStream(makeMetadataOnlyStreamWithoutTerminalEvent()).catch((error) => {
    unusableError = error;
  });
  if (!unusableError || !/without a usable response/.test(unusableError.message)) {
    throw new Error('metadata-only upstream response was accepted as a completion');
  }

  let emptyError;
  await collectNonStream(makeEmptyStream()).catch((error) => {
    emptyError = error;
  });
  if (!emptyError || !/without a usable response/.test(emptyError.message)) {
    throw new Error('empty upstream response was accepted as a completion');
  }

  let retryAttempts = 0;
  await new Promise((resolve, reject) => {
    const replacement = () => {
      retryAttempts += 1;
      return retryAttempts < 3 ? makeEmptyStream() : makeAnswerStreamWithoutTerminalEvent();
    };
    const response = { write() {}, end() { resolve(); } };
    require('../src/chat-adapter').pipeThroughOpenAI(makeEmptyStream(), response, {
      retryEmpty: replacement,
      maxEmptyRetries: 3,
    }).catch(reject);
  });
  if (retryAttempts !== 3) throw new Error(`stream retry count mismatch: ${retryAttempts}`);

  const messageResult = await collectNonStream(makeTerminalMessageStream());
  if (messageResult.choices[0].message.content !== 'Ответ из message') {
    throw new Error('terminal message content was not accepted');
  }

  const textResult = await collectNonStream(makeTextStream());
  if (textResult.choices[0].message.content !== 'Ответ из text') {
    throw new Error('choice text content was not accepted');
  }

  const arrayResult = await collectNonStream(makeArrayContentStream());
  if (arrayResult.choices[0].message.content !== 'Ответ из массива') {
    throw new Error('array content was not accepted');
  }

  const retained = buildChatBody(
    'qwen-chat-1',
    'qwen3.8-max',
    [
      { role: 'user', content: 'initial task' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: 'next step' },
    ],
    false,
    'tool protocol',
    false,
    { currentOnly: true },
  );
  if (retained.messages[0].content.includes('initial task') || !retained.messages[0].content.includes('next step')) {
    throw new Error('reused Qwen chat payload included old history');
  }

  const compaction = buildChatBody(
    'qwen-chat-2',
    'qwen3.8-max',
    [{ role: 'user', content: 'task and completed tool results' }],
    false,
    '',
    false,
    { compaction: true },
  );
  if (!compaction.messages[0].content.includes('dense handoff checkpoint')) {
    throw new Error('compaction handoff prompt was not included');
  }

  const stateKey = `offline-test-${Date.now()}`;
  sessionStore.set(stateKey, 'chat-state', { awaitingCompactedHistory: true });
  const state = sessionStore.getRecord(stateKey);
  if (!state || state.chatId !== 'chat-state' || !state.awaitingCompactedHistory) {
    throw new Error('compaction session state was not persisted');
  }
  sessionStore.clear(stateKey);

  // Upstream failures must not be converted into a successful stream ending.
  let streamError;
  await new Promise((resolve) => {
    parseQwenSSE(makeFailedStream(), () => {}, (error) => {
      streamError = error;
      resolve();
    });
  });
  if (!streamError || streamError.message !== 'simulated upstream failure') {
    throw new Error('upstream stream error was swallowed');
  }

  // An upstream that stops sending data must not leave the request pending.
  let timeoutError;
  await new Promise((resolve) => {
    const idleStream = new Readable({ read() {} });
    parseQwenSSE(idleStream, () => {}, (error) => {
      timeoutError = error;
      resolve();
    }, { idleTimeout: 10 });
  });
  if (!timeoutError || !/timed out/.test(timeoutError.message)) {
    throw new Error('idle upstream stream was not timed out');
  }

  console.log('\nSSE ADAPTER OK');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
