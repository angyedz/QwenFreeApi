#!/usr/bin/env node
'use strict';

/**
 * offline-sse-test.js — тест перевода Qwen SSE -> OpenAI в реальном формате 0.2.83.
 */
const { Readable } = require('stream');
const { parseQwenSSE, collectNonStream } = require('../src/chat-adapter');

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

  await collectNonStream(makeStateOnlyStreamWithoutTerminalEvent());
  await collectNonStream(makeMetadataOnlyStreamWithoutTerminalEvent());

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
