'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const { logger } = require('./util');

/**
 * Локальные инструменты агента: терминал (bash), доступ к файлам и веб-поиск.
 * Работают внутри рабочей директории (workspace) — как "песочницы" для файлов.
 * Терминал по умолчанию разрешён, но путь к workspace пользователь задаёт сам.
 */

const DEFAULT_WORKSPACE = process.env.QWEN_WORKSPACE || path.join(os.homedir(), 'qwen-workspace');

let workspace = null;

function initWorkspace(dir) {
  workspace = dir || DEFAULT_WORKSPACE;
  try {
    fs.mkdirSync(workspace, { recursive: true });
  } catch (_) {
    /* keep */
  }
  logger.info(`Workspace: ${workspace}`, 'TOOLS');
  return workspace;
}

function getWorkspace() {
  if (!workspace) initWorkspace();
  return workspace;
}

function resolveInsideWorkspace(rel) {
  const root = path.resolve(getWorkspace());
  const target = path.resolve(root, String(rel || '').replace(/^~/, os.homedir()));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace (${target})`);
  }
  return target;
}

const MAX_OUTPUT = 200 * 1024;

const runCommand = (command, opts = {}) =>
  new Promise((resolve) => {
    const cwd = opts.cwd || getWorkspace();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout: '', stderr: 'Command timed out (30s)', exitCode: 124 });
    }, 30000);
    const child = exec(command, { cwd, timeout: 30000, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      clearTimeout(timer);
      const out = String(stdout || '').slice(0, MAX_OUTPUT);
      const errOut = String(stderr || '').slice(0, MAX_OUTPUT);
      const exitCode = err ? (err.code === undefined ? 1 : err.code) : 0;
      let result = out || errOut || `(no output, exit ${exitCode})`;
      if (out && errOut) result = `${out}\n\n[stderr]\n${errOut}`;
      resolve({ stdout: result, stderr: '', exitCode });
    });
  });

function formatLs(rows) {
  return rows
    .map((r) => {
      const type = r.isDirectory() ? 'd' : '-';
      const size = r.isDirectory() ? '' : ` (${r.size} B)`;
      return `${type} ${r.name}${size}`;
    })
    .join('\n');
}

const HANDLERS = {
  // ---- Терминал ----
  bash: async (args) => {
    const command = String(args.command || '').trim();
    if (!command) return 'Empty command';
    const { stdout } = await runCommand(command, { cwd: args.cwd || getWorkspace() });
    return stdout;
  },
  run_command: async (args) => {
    const command = String(args.command || '').trim();
    if (!command) return 'Empty command';
    const { stdout } = await runCommand(command, { cwd: args.cwd || getWorkspace() });
    return stdout;
  },

  // ---- Файлы (внутри workspace) ----
  list_dir: async (args) => {
    const dir = resolveInsideWorkspace(args.path || '.');
    const rows = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    return formatLs(rows);
  },
  read_file: async (args) => {
    const file = resolveInsideWorkspace(args.path);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      const rows = fs.readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      return formatLs(rows);
    }
    if (stat.size > 5 * 1024 * 1024) return `File too large (${stat.size} B)`;
    return fs.readFileSync(file, 'utf8');
  },
  write_file: async (args) => {
    const file = resolveInsideWorkspace(args.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(args.content ?? ''), 'utf8');
    return `Wrote ${file} (${Buffer.byteLength(String(args.content ?? ''), 'utf8')} bytes)`;
  },
  edit_file: async (args) => {
    const file = resolveInsideWorkspace(args.path);
    const original = fs.readFileSync(file, 'utf8');
    const oldText = String(args.old ?? '');
    const newText = String(args.new ?? '');
    if (!oldText) return 'Missing "old" text';
    const count = original.split(oldText).length - 1;
    if (count === 0) return 'Pattern not found in file';
    const updated = original.split(oldText).join(newText);
    fs.writeFileSync(file, updated, 'utf8');
    return `Replaced ${count} occurrence(s) in ${file}`;
  },
  append_file: async (args) => {
    const file = resolveInsideWorkspace(args.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, String(args.content ?? ''), 'utf8');
    return `Appended to ${file}`;
  },

  // ---- Веб-поиск ----
  web_search: async (args) => {
    const raw = args.query ?? args.q ?? (Array.isArray(args.queries) ? args.queries.join(' ') : args.queries);
    const query = String(raw || '').trim();
    if (!query) return 'Empty query';
    try {
      const https = require('https');
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const html = await new Promise((resolve, reject) => {
        https
          .get(
            url,
            { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } },
            (res) => {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            }
          )
          .on('error', reject);
      });
      const results = parseDuckDuckGo(html);
      if (results.length === 0) return `No search results for "${query}"`;
      return results
        .slice(0, 6)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || ''}`)
        .join('\n\n');
    } catch (e) {
      return `Search failed: ${e.message}`;
    }
  },
};

function parseDuckDuckGo(html) {
  const out = [];
  const re =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 6) {
    out.push({
      url: m[1],
      title: m[2].replace(/<[^>]+>/g, '').trim(),
      snippet: m[3].replace(/<[^>]+>/g, '').trim(),
    });
  }
  if (out.length === 0) {
    const alt =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let a;
    while ((a = alt.exec(html)) !== null && out.length < 6) {
      out.push({ url: a[1], title: a[2].replace(/<[^>]+>/g, '').trim(), snippet: '' });
    }
  }
  return out;
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a bash/shell command on the local machine (cwd is the workspace). Use for filesystem, git, package managers, running programs, and anything terminal-related.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the contents of a directory (relative to the workspace).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to workspace' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full text content of a file (relative to the workspace).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to workspace' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content (relative to the workspace).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact substring in a file (relative to the workspace).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          old: { type: 'string', description: 'Exact text to replace' },
          new: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the internet for up-to-date information. Returns a list of titles, URLs and snippets. Use when the user asks about recent facts, news, or anything outside your knowledge. Provide the search terms in the "queries" array (or the single "query" string).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (single string)' },
          queries: { type: 'array', items: { type: 'string' }, description: 'Search queries (array form)' },
        },
      },
    },
  },
];

async function executeTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return `Unknown tool: ${name}`;
  try {
    const result = await handler(args);
    return String(result).slice(0, MAX_OUTPUT);
  } catch (e) {
    logger.warn(`Tool ${name} failed: ${e.message}`, 'TOOLS');
    return `Error: ${e.message}`;
  }
}

module.exports = {
  initWorkspace,
  getWorkspace,
  TOOL_DEFS,
  executeTool,
  runCommand,
};
