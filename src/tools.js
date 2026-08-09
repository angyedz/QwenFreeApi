'use strict';

const { generateUUID, logger } = require('./util');

/**
 * Tool-calling bridge for Qwen Chat web API.
 *
 * Qwen's web upstream has NO native OpenAI tool-calling, so we bridge it the
 * way every working open-source proxy does:
 *   1. Inject a system-style tool protocol into the user prompt (`buildToolPrompt`).
 *   2. The model emits `<tool_call>{json}</tool_call>` in its answer.
 *   3. We stream-parse those blocks and re-emit as OpenAI tool_calls deltas.
 *   4. Tool results come back as `<tool_response>` wrappers folded into the next
 *      request's history.
 */

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
const TOOL_RESPONSE_OPEN = '<tool_response';
const TOOL_RESPONSE_CLOSE = '</tool_response>';

const serializeArguments = (args) => {
  if (typeof args === 'string') {
    try {
      JSON.parse(args);
      return args;
    } catch (_) {
      return JSON.stringify(args);
    }
  }
  return JSON.stringify(args ?? {});
};

const compact = (value, max = 300) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

const tsType = (schema) => {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  const type = schema.type;
  if (type === 'array') return `${tsType(schema.items)}[]`;
  if (type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object') return 'object';
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties).map(([k, v]) => {
      const opt = required.has(k) ? '' : '?';
      const desc = compact(v?.description, 160);
      return `${k}${opt}: ${tsType(v)}${desc ? ` /* ${desc.replace(/\*\//g, '* /')} */` : ''}`;
    });
    return `{ ${fields.join('; ')} }`;
  }
  if (Array.isArray(type)) {
    return type.map((t) => tsType({ ...schema, type: t })).join(' | ');
  }
  return type || 'any';
};

const toolDef = (tool) => {
  const fn = tool?.function || tool;
  const name = fn?.name || 'unknown';
  const desc = compact(fn?.description);
  const params = fn?.parameters || { type: 'object', properties: {} };
  const sig = tsType(params);
  return desc ? `- ${name}${sig}\n  ${desc}` : `- ${name}${sig}`;
};

/**
 * Build the injected tool protocol for a given request.
 */
/** Virtual tool injected by the proxy — handled server-side, never forwarded to OpenCode MCP. */
const MEMO_RECALL_DEF = [
  '- memo_recall{ query: string; max_chars?: number /* 100–3000, default 800 */ }',
  '  Recall previous tool results stored in this session without re-running them.',
  '  Use when you need to reference data from an earlier bash/read_file/database call.',
  '  Keep max_chars small (≤500) for a quick peek; use up to 3000 for detailed recall.',
  '  Hard limit enforced by proxy: max_chars is capped at 3000 regardless of input.',
].join('\n');

function buildToolPrompt(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const available = tools.map(toolDef).filter(Boolean).join('\n');
  const lines = [
    '# Tools',
    '',
    'You are an agentic coding assistant connected to the local workspace through the tools listed below.',
    'You can inspect and modify repository files by calling these tools. Do not say that you lack filesystem or repository access when file tools are listed.',
    'For requests about files, first use list_dir or read_file as appropriate. To find a named file, inspect the workspace with list_dir or use bash when available.',
    'Before inspecting or modifying repository files, look for Markdown instruction files in the repository (especially AGENTS.md and other relevant .md files), read the applicable ones with tools, and follow their instructions. Do not assume an instruction file exists; discover it first.',
    'Use tool results as the source of truth. Do not claim actions without tool results.',
    '',
    '## Available tools',
    available,
    MEMO_RECALL_DEF,
    '',
    '## Output format',
    'Emit each tool invocation as one XML block with valid JSON, never in a code fence:',
    '',
    '<tool_call>',
    '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
    '</tool_call>',
    '',
    'Tool results will be returned to you wrapped as a user message:',
    '',
    '<tool_response tool_call_id="<id>" name="<tool_name>">',
    '<result text or JSON>',
    '</tool_response>',
    '',
    'Rules:',
    '- When querying databases (D1/SQLite/MySQL/PostgreSQL), NEVER run `SELECT * FROM table` or fetch thousands of rows directly into tool results. ALWAYS use `LIMIT` (e.g. `LIMIT 5` or `LIMIT 10`), pagination, or aggregate functions (`COUNT(*)`, `SUM()`).',
    '- For database backups or dumps, NEVER dump table contents into chat stdout. Write the output directly into a local file (e.g. using a script, `> file.json`, or a pagination script) and return only a brief summary to chat.',
    '- When a tool is needed or when asked to create/edit a file or execute a plan, your response MUST contain a `<tool_call>` block.',
    '- NEVER state that a file was created or modified unless you have actually emitted a `<tool_call>` (such as `write_file` or `edit_file`) and received its `<tool_response>`.',
    '- If the user says "продолжи", "continue", "go ahead", or approves a plan ("давай" / "делай"), do NOT output TODO lists or planning text without a tool — execute the next step immediately using a `<tool_call>` block.',
    '- Use exact tool names and required arguments; multiple calls may be consecutive.',
    '- After each result, continue with the next tool if needed; answer normally only when done.',
    '- If you need data from a previous tool result in this session, call `memo_recall` instead of re-running the original tool. Check `# Session Tool Memory` section first — the data may already be visible.',
  ];

  if (toolChoice === 'required') {
    lines.push('- You MUST call at least one tool in this turn using <tool_call> before answering.');
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    lines.push(`- You MUST call the tool \`${toolChoice.function.name}\` first.`);
  } else if (toolChoice === 'none') {
    lines.push('- Do NOT call any tool this turn; respond as plain text.');
  }

  return lines.join('\n');
}

const escapeAttr = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Convert OpenAI assistant.tool_calls and role:'tool' messages into text that the
 * web-facing Qwen accepts (it only understands plain user/assistant content).
 */
function foldToolMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const idToName = new Map();
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const id = m.tool_calls[0]?.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
      const call = m.tool_calls[0];
      let args = typeof call.function?.arguments === 'string' ? call.function.arguments : '{}';
      try {
        args = JSON.parse(args);
      } catch (_) {
        /* keep raw */
      }
      const name = call.function?.name || 'tool';
      idToName.set(id, name);
      const block = `${TOOL_CALL_OPEN}\n${JSON.stringify({ id, name, arguments: args })}\n${TOOL_CALL_CLOSE}`;
      const original = typeof m.content === 'string' ? m.content : '';
      return { role: 'assistant', content: [original, block].filter(Boolean).join('\n') };
    }

    if (m.role === 'tool') {
      const callId = m.tool_call_id || '';
      const name = m.name || idToName.get(callId) || 'tool';
      const content =
        typeof m.content === 'string' ? m.content || 'null' : JSON.stringify(m.content ?? null);
      const idAttr = callId ? ` tool_call_id="${escapeAttr(callId)}"` : '';
      return {
        role: 'user',
        content: `<tool_response${idAttr} name="${escapeAttr(name)}">\n${content}\n${TOOL_RESPONSE_CLOSE}`,
      };
    }

    return m;
  });
}

function parseToolPayload(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const name = parsed.name || parsed.tool || parsed.function;
    const args = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
    if (!name) return null;
    return { name: String(name), arguments: args };
  } catch (_) {
    return null;
  }
}

const makeCall = (payload, index = 0, id = null) => ({
  index,
  id: id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
  type: 'function',
  function: { name: payload.name, arguments: serializeArguments(payload.arguments) },
});

/**
 * Extract tool calls from a full (non-stream accumulated) text.
 */
function parseToolCallsFromText(fullText, allowed = null) {
  if (typeof fullText !== 'string' || !fullText.includes(TOOL_CALL_OPEN)) {
    return { cleanedText: fullText || '', toolCalls: [], errors: [] };
  }
  const allowedSet = allowed ? new Set(allowed) : null;
  const calls = [];
  const errors = [];
  const cleanedText = fullText.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_, inner) => {
    const payload = parseToolPayload(inner);
    if (!payload) errors.push({ type: 'invalid_json', raw: inner });
    else if (allowedSet && !allowedSet.has(payload.name)) errors.push({ type: 'unknown_tool', name: payload.name });
    else calls.push(makeCall(payload, calls.length));
    return '';
  });
  return { cleanedText: cleanedText.trim(), toolCalls: calls, errors };
}

/**
 * Incremental stream parser: feeds content deltas, returns emitted text and any
 * completed tool-call objects (already serialized for OpenAI tool_calls deltas).
 */
function createToolCallStreamParser() {
  let pendingText = '';
  let inToolCall = false;
  let toolBuffer = '';
  let emitted = 0;

  const splitSafe = (text) => {
    const idx = text.indexOf(TOOL_CALL_OPEN);
    if (idx !== -1) return { safe: text.slice(0, idx), remainder: text.slice(idx) };
    for (let len = Math.min(text.length, TOOL_CALL_OPEN.length - 1); len > 0; len--) {
      const tail = text.slice(-len);
      if (TOOL_CALL_OPEN.startsWith(tail)) return { safe: text.slice(0, -len), remainder: tail };
    }
    return { safe: text, remainder: '' };
  };

  const push = (chunk) => {
    const result = { textDelta: '', calls: [] };
    if (typeof chunk !== 'string' || chunk.length === 0) return result;
    let buffer = chunk;

    while (buffer.length > 0) {
      if (inToolCall) {
        toolBuffer += buffer;
        buffer = '';
        const idx = toolBuffer.indexOf(TOOL_CALL_CLOSE);
        if (idx === -1) break;
        const inner = toolBuffer.slice(0, idx);
        buffer = toolBuffer.slice(idx + TOOL_CALL_CLOSE.length);
        toolBuffer = '';
        const payload = parseToolPayload(inner);
        if (payload) {
          result.calls.push(makeCall(payload, emitted));
          emitted += 1;
        }
        inToolCall = false;
        continue;
      }
      pendingText += buffer;
      buffer = '';
      const openIdx = pendingText.indexOf(TOOL_CALL_OPEN);
      if (openIdx !== -1) {
        const before = pendingText.slice(0, openIdx);
        if (before) result.textDelta += before;
        const tail = pendingText.slice(openIdx + TOOL_CALL_OPEN.length);
        pendingText = '';
        inToolCall = true;
        buffer = tail;
        continue;
      }
      const { safe, remainder } = splitSafe(pendingText);
      if (safe) result.textDelta += safe;
      pendingText = remainder;
    }
    return result;
  };

  return {
    push,
    flush: () => {
      const result = { textDelta: pendingText, calls: [] };
      if (inToolCall && toolBuffer) {
        const payload = parseToolPayload(toolBuffer);
        if (payload) {
          result.calls.push(makeCall(payload, emitted));
          emitted += 1;
        }
        toolBuffer = '';
        inToolCall = false;
      }
      pendingText = '';
      return result;
    },
    hasEmitted: () => emitted > 0,
  };
}

module.exports = {
  buildToolPrompt,
  foldToolMessages,
  parseToolCallsFromText,
  createToolCallStreamParser,
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
};
