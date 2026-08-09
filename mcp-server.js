#!/usr/bin/env node
'use strict';

/**
 * qwen-memo MCP server — stdio JSON-RPC 2.0 interface for qwen-free-api.
 *
 * Real Dynamic Provider Detection:
 * Probes PROXY_URL/healthz for X-Service: qwen-free-api header and payload.
 * qwen-memo tools WILL ONLY RUN if the active provider is qwen-free-api!
 */

const http = require('http');
const readline = require('readline');
const { URL } = require('url');

const PROXY_URL = (process.env.QWEN_PROXY_URL || 'http://localhost:3265').replace(/\/$/, '');
const MAX_CHARS_HARD_CAP = 3000;
const DEFAULT_MAX_CHARS = 800;

// ─── Real Dynamic Provider Detector ──────────────────────────────────────────

/**
 * Probes the proxy health endpoint dynamically without hardcoding.
 * Verifies response header 'X-Service: qwen-free-api' and JSON payload.
 */
function verifyQwenProviderActive() {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(`${PROXY_URL}/healthz`); } catch (_) {
      return resolve({ active: false, reason: 'qwen-memo is disabled: invalid PROXY_URL.' });
    }

    const options = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const serviceHeader = (res.headers['x-service'] || '').toLowerCase();
        let json = {};
        try { json = JSON.parse(data); } catch (_) {}

        const isQwenHeader = serviceHeader === 'qwen-free-api';
        const isQwenService = json && json.service === 'qwen-free-api';

        if (isQwenHeader || isQwenService) {
          resolve({ active: true });
        } else {
          resolve({
            active: false,
            reason: `qwen-memo is disabled: active provider is not qwen-free-api (detected service: "${json.service || serviceHeader || 'unknown'}").`,
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ active: false, reason: `qwen-memo is disabled: qwen-free-api proxy is offline (${e.message}).` });
    });
    req.setTimeout(1500, () => {
      req.destroy();
      resolve({ active: false, reason: 'qwen-memo is disabled: qwen-free-api proxy health check timed out.' });
    });
    req.end();
  });
}

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function err(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET' };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve({ result: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memo_recall',
    description: [
      'Recall previous conversation checkpoints, tool substeps, and timestamps stored in the current OpenCode session.',
      'Active ONLY when qwen-free-api is the active provider.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query: e.g. "step 1", "step #2", "10m", "first", "recent", or keywords like "git error".',
        },
        max_chars: {
          type: 'integer',
          description: 'Maximum characters to return (100–3000). Default: 1000. Capped at 3000.',
          minimum: 100,
          maximum: MAX_CHARS_HARD_CAP,
          default: 1000,
        },
        session: {
          type: 'string',
          description: 'Explicit session key (optional). Omit to use the most recently active session.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memo_sessions',
    description: 'List how many sessions and tool results are currently stored in qwen-free-api proxy memory.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleMemoRecall(args) {
  const query = String(args.query || 'recent').trim();
  const rawMax = Number(args.max_chars || DEFAULT_MAX_CHARS);
  const maxChars = Math.min(Math.max(100, rawMax), MAX_CHARS_HARD_CAP);
  const session = args.session ? String(args.session).trim() : '';

  const params = new URLSearchParams({ query, max_chars: maxChars });
  if (session) params.set('session', session);

  try {
    const data = await httpGet(`${PROXY_URL}/v1/memo/recall?${params}`);
    const text = data.result || 'No results.';
    return {
      content: [{ type: 'text', text }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error contacting proxy: ${e.message}` }],
      isError: true,
    };
  }
}

async function handleMemoSessions() {
  try {
    const data = await httpGet(`${PROXY_URL}/v1/memo/sessions`);
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    };
  }
}

// ─── MCP request dispatcher ──────────────────────────────────────────────────

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'qwen-memo', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    // 🔒 Real Dynamic Provider Detection Check
    const providerCheck = await verifyQwenProviderActive();
    if (!providerCheck.active) {
      return ok(id, {
        content: [{ type: 'text', text: providerCheck.reason }],
        isError: true,
      });
    }

    let result;
    if (name === 'memo_recall') {
      result = await handleMemoRecall(args);
    } else if (name === 'memo_sessions') {
      result = await handleMemoSessions();
    } else {
      return err(id, -32601, `Unknown tool: ${name}`);
    }
    return ok(id, result);
  }
}

// ─── Readline Loop ───────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handle(msg).catch((e) => {
      if (msg.id) err(msg.id, -32603, e.message);
    });
  } catch (_) {
    // ignore invalid JSON
  }
});
