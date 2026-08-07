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

  console.log('\nSSE ADAPTER OK');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});