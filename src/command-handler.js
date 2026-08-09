'use strict';

/**
 * Proxy Command Handler — Management commands via $ prefix directly in chat.
 * 
 * Commands:
 *  - $compressor [on|off|status] / $comp [on|off]
 *  - $accounts / $account [switch|add|remove|test]
 *  - $ping
 *  - $stats
 *  - $history
 *  - $search <query>
 *  - $export
 *  - $system
 *  - $memo [stats|clear]
 *  - $reset / $clear
 *  - $help
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const accountStore = require('./account-store');
const toolMemo = require('./tool-memo');
const sessionStore = require('./session-store');
const qwenClient = require('./qwen-client');

function triggerSelfUpdate() {
  const repoDir = path.resolve(__dirname, '..');
  const updateScript = `sleep 0.5 && cd "${repoDir}" && git pull origin master && systemctl --user restart qwen-free-api.service`;
  const child = spawn('/bin/bash', ['-c', updateScript], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function checkUpdates() {
  const repoDir = path.resolve(__dirname, '..');
  try {
    execSync(`cd "${repoDir}" && git fetch origin master`, { timeout: 8000, stdio: 'ignore' });
    const local = execSync(`cd "${repoDir}" && git rev-parse --short HEAD`, { encoding: 'utf8' }).trim();
    const remote = execSync(`cd "${repoDir}" && git rev-parse --short origin/master`, { encoding: 'utf8' }).trim();
    const behindCount = execSync(`cd "${repoDir}" && git rev-list --count HEAD..origin/master`, { encoding: 'utf8' }).trim();

    if (local === remote || behindCount === '0') {
      return `✅ **Qwen Free API is Up To Date**\n\n- **Current Version:** \`${local}\` (latest)\n- **Status:** All changes synced with GitHub origin/master.`;
    }
    return `🔍 **Update Available for Qwen Free API!**\n\n- **Current Version:** \`${local}\`\n- **Latest Version:** \`${remote}\` (${behindCount} commit(s) behind)\n\n*Run \`$qwen-api update\` to apply the update automatically.*`;
  } catch (e) {
    return `⚠️ **Update Check Failed**: ${e.message}`;
  }
}

const disabledSessions = new Set();
const startTime = Date.now();
let requestCount = 0;

function isCommandMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  const text = (typeof last?.content === 'string' ? last.content : '').trim();
  return text.startsWith('$qwen-api') || text.startsWith('/qwen-api');
}

function isCompressorDisabled(sessionKey) {
  return disabledSessions.has(sessionKey);
}

function incrementRequestCount() {
  requestCount += 1;
}

function formatStreamChunk(text, id = 'cmd-1') {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'qwen-proxy-command',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  })}\n\n`;
}

function formatStreamDone() {
  return 'data: [DONE]\n\n';
}

function extractEmailFromJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.email || payload.sub || payload.id || null;
  } catch (_) {
    return null;
  }
}

async function handleCommand(messages, sessionKey, req, res) {
  incrementRequestCount();
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  const rawText = (typeof last?.content === 'string' ? last.content : '').trim();
  const streamRequested = req.body && req.body.stream === true;

  const prefixMatch = rawText.match(/^([$/]qwen-api)/i);
  let cleaned = rawText;
  if (prefixMatch) {
    cleaned = rawText.slice(prefixMatch[0].length).trim();
  }
  const parts = cleaned.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const arg1 = (parts[1] || '').toLowerCase();
  const arg2 = parts.slice(2).join(' ').trim();

  let responseText = '';

  if (cmd === 'check' || cmd === 'check-update' || cmd === 'checkupdate') {
    responseText = checkUpdates();
  } else if (cmd === 'update' || cmd === 'upgrade') {
    triggerSelfUpdate();
    responseText = `🚀 **Qwen Free API Self-Updater Initiated**\n\n` +
      `- **Action:** Pulling latest code from GitHub \`master\`...\n` +
      `- **Process:** Independent detached background worker initialized.\n` +
      `- **Service:** Restarting \`qwen-free-api.service\`...\n\n` +
      `*Check status in a few seconds via \`$qwen-api stats\`.*`;
  } else if (cmd === 'compressor' || cmd === 'comp') {
    if (arg1 === 'off' || arg1 === 'disable' || arg1 === 'false' || arg1 === '0') {
      disabledSessions.add(sessionKey);
      responseText = '⚡ **Compressor System**\n\nContext compaction/folding has been **DISABLED** for this session.';
    } else if (arg1 === 'on' || arg1 === 'enable' || arg1 === 'true' || arg1 === '1') {
      disabledSessions.delete(sessionKey);
      responseText = '⚡ **Compressor System**\n\nContext compaction/folding is now **ENABLED** for this session.';
    } else {
      const isDisabled = disabledSessions.has(sessionKey);
      const stats = toolMemo.stats();
      responseText = `⚡ **Compressor & Proxy Status**\n\n` +
        `- **Compaction Mode:** ${isDisabled ? '🔴 Disabled' : '🟢 Enabled'}\n` +
        `- **Active Session ID:** \`${sessionKey || 'default'}\`\n` +
        `- **Stored Memory Items:** ${stats.entries} across ${stats.sessions} session(s)\n` +
        `- **Active Account:** \`${accountStore.current() ? accountStore.current().email : 'None'}\``;
    }
  } else if (cmd === 'accounts' || cmd === 'account') {
    if (arg1 === 'switch' || arg1 === 'select' || arg1 === 'use') {
      const target = arg2 || parts[1] || '';
      try {
        const accs = accountStore.list();
        const found = accs.find((a) => a.id === target || a.email.toLowerCase().includes(target.toLowerCase()));
        if (found) {
          accountStore.select(found.id);
          responseText = `✅ Switched active Qwen account to **${found.email}** (\`${found.id}\`).`;
        } else {
          responseText = `❌ Account matching "${target}" not found. Available accounts:\n` +
            accs.map((a) => `- \`${a.id}\` (${a.email})`).join('\n');
        }
      } catch (err) {
        responseText = `❌ Failed to switch account: ${err.message}`;
      }
    } else if (arg1 === 'add' || arg1 === 'create') {
      // Usage: $account add <token> [cookie]
      const tokenCandidate = parts[2] || '';
      const cookieCandidate = parts.slice(3).join(' ') || '';
      if (!tokenCandidate) {
        responseText = `⚠️ **Usage:** \`$account add <JWT_TOKEN> [COOKIE_STRING]\`\n\n*Specify the Qwen JWT token (and optional cookie) to register a fresh account.*`;
      } else {
        const email = extractEmailFromJwt(tokenCandidate) || `user-${Date.now()}@qwen`;
        const accountData = {
          token: tokenCandidate,
          email,
          cookie: cookieCandidate ? [{ name: 'cookie', value: cookieCandidate }] : [],
          savedAt: Date.now(),
        };
        const saved = accountStore.save(accountData);
        responseText = `🎉 **Account Added Successfully!**\n\n- **ID:** \`${saved.id}\`\n- **Email:** \`${saved.email}\`\n- **Status:** Active`;
      }
    } else if (arg1 === 'remove' || arg1 === 'delete' || arg1 === 'rm') {
      const target = arg2 || parts[2] || '';
      const removed = accountStore.remove(target);
      if (removed) {
        responseText = `🗑️ Removed account **${target}**. Active account is now \`${accountStore.current() ? accountStore.current().email : 'None'}\`.`;
      } else {
        responseText = `❌ Could not find account \`${target}\` to remove.`;
      }
    } else if (arg1 === 'test' || arg1 === 'check') {
      const list = accountStore.list();
      responseText = `🔍 **Testing ${list.length} Qwen Account(s)...**\n\n`;
      for (const acc of list) {
        const testRes = await qwenClient.generateChatID('qwen3.8-max', 't2t', acc);
        if (testRes) {
          responseText += `- 🟢 **${acc.id}** (\`${acc.email}\`): OK (Chat ID: \`${testRes.slice(0, 8)}...\`)\n`;
        } else {
          responseText += `- 🔴 **${acc.id}** (\`${acc.email}\`): Failed/Rate-limited (${acc.lastError || 'Auth Error'})\n`;
        }
      }
    } else {
      const list = accountStore.list();
      const rows = list.map((a) => {
        const activeMarker = a.active ? ' 👈 *(Active)*' : '';
        const availMarker = a.available ? '🟢' : '🔴 (Cooling down)';
        return `- ${availMarker} **${a.id}** (\`${a.email}\`)${activeMarker}`;
      });
      responseText = `👥 **Configured Qwen Accounts (${list.length})**\n\n` + rows.join('\n') +
        `\n\n*Use \`$account switch <email|id>\`, \`$account add <token>\`, or \`$account remove <id>\`.*`;
    }
  } else if (cmd === 'ping') {
    const list = accountStore.list();
    responseText = `🏓 **Pong! Proxy Service Active**\n\n`;
    for (const acc of list) {
      const testRes = await qwenClient.generateChatID('qwen3.8-max', 't2t', acc);
      if (testRes) {
        responseText += `- 🟢 **${acc.email}**: Active (OK)\n`;
      } else {
        responseText += `- 🔴 **${acc.email}**: Error/Unavailable\n`;
      }
    }
  } else if (cmd === 'stats' || cmd === 'metrics') {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    const memoStats = toolMemo.stats();
    const accounts = accountStore.list();
    responseText = `📊 **Qwen Free API Proxy Statistics**\n\n` +
      `- **Uptime:** ${uptimeMin} minute(s) (${uptimeSec}s)\n` +
      `- **Total Requests:** ${requestCount}\n` +
      `- **Configured Accounts:** ${accounts.length} (${accounts.filter(a => a.available).length} available)\n` +
      `- **Persisted Memo Checkpoints:** ${memoStats.entries} across ${memoStats.sessions} session(s)\n` +
      `- **Compaction Mode:** ${disabledSessions.has(sessionKey) ? 'Disabled' : 'Enabled'}`;
  } else if (cmd === 'history' || cmd === 'timeline') {
    const sess = toolMemo._sessions.get(sessionKey);
    const items = sess ? sess.items : [];
    if (!items.length) {
      responseText = `📜 **Session History Timeline**\n\nNo stored steps or tool calls for session \`${sessionKey || 'default'}\` yet.`;
    } else {
      responseText = `📜 **Session History Timeline (${items.length} events)**\n\n` +
        toolMemo.recall(sessionKey, 'recent', 1500);
    }
  } else if (cmd === 'search') {
    const query = arg1 ? `${arg1} ${arg2}`.trim() : 'recent';
    responseText = toolMemo.recall(sessionKey, query, 2000);
  } else if (cmd === 'export' || cmd === 'save') {
    const sess = toolMemo._sessions.get(sessionKey);
    const items = sess ? sess.items : [];
    const content = toolMemo.recall(sessionKey, 'all', 3000);
    const scratchDir = path.join(config.PROJECT_ROOT, 'scratch');
    fs.mkdirSync(scratchDir, { recursive: true });
    const filename = `session_export_${Date.now()}.md`;
    const filePath = path.join(scratchDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    responseText = `💾 **Session History Exported!**\n\n- **File Path:** [${filename}](file://${filePath})\n- **Total Events:** ${items.length}`;
  } else if (cmd === 'system' || cmd === 'prompt') {
    const record = sessionStore.getRecord(sessionKey);
    const hist = record && record.history ? record.history.length : 0;
    responseText = `⚙️ **Effective System State**\n\n` +
      `- **Session Key:** \`${sessionKey || 'default'}\`\n` +
      `- **Stored Checkpoint Messages:** ${hist} turn(s)\n` +
      `- **Compaction:** ${disabledSessions.has(sessionKey) ? 'Off' : 'On'}\n` +
      `- **Active Model:** \`${req.body.model || config.DEFAULT_MODEL}\``;
  } else if (cmd === 'memo') {
    if (arg1 === 'clear' || arg1 === 'reset') {
      toolMemo.clear(sessionKey);
      responseText = `🧹 Cleared \`qwen-memo\` checkpoints for the current session.`;
    } else {
      const stats = toolMemo.stats();
      const sess = toolMemo._sessions.get(sessionKey);
      const count = sess && Array.isArray(sess.items) ? sess.items.length : 0;
      responseText = `🧠 **Qwen Memo Memory Stats**\n\n` +
        `- **Current Session Items:** ${count} checkpoints\n` +
        `- **Global Persisted Items:** ${stats.entries} items across ${stats.sessions} session(s)\n` +
        `- **Disk Storage:** \`config/memo.json\`\n\n` +
        `*Use \`$memo clear\` to reset session memory.*`;
    }
  } else if (cmd === 'reset' || cmd === 'clear') {
    sessionStore.clear(sessionKey);
    toolMemo.clear(sessionKey);
    responseText = `🔄 **Session Reset Complete**\n\nCleared Qwen upstream thread ID and local checkpoint history. Next turn will start on a clean thread.`;
  } else {
    responseText = `🛠️ **Qwen Free API Proxy Commands ($qwen-api)**\n\n` +
      `- \`$qwen-api compressor off\` / \`on\` — Disable or enable context compaction for this session.\n` +
      `- \`$qwen-api compressor status\` — View compressor and active session status.\n` +
      `- \`$qwen-api accounts\` — List all configured Qwen accounts.\n` +
      `- \`$qwen-api account add <JWT_TOKEN> [COOKIE]\` — Add a new Qwen account.\n` +
      `- \`$qwen-api account remove <id>\` — Remove a Qwen account.\n` +
      `- \`$qwen-api account switch <id|email>\` — Switch active Qwen account.\n` +
      `- \`$qwen-api ping\` / \`test\` — Test all accounts for valid auth & connectivity.\n` +
      `- \`$qwen-api stats\` — View proxy uptime, total requests, and token statistics.\n` +
      `- \`$qwen-api history\` — Show turn breakdown timeline for current session.\n` +
      `- \`$qwen-api search <query>\` — Search qwen-memo memory checkpoints.\n` +
      `- \`$qwen-api export\` — Export current session context log to markdown file.\n` +
      `- \`$qwen-api system\` — Inspect system prompt state and context size.\n` +
      `- \`$qwen-api memo\` — View qwen-memo memory statistics.\n` +
      `- \`$qwen-api memo clear\` — Clear memory checkpoints for current session.\n` +
      `- \`$qwen-api reset\` — Reset upstream Qwen thread & checkpoints.\n` +
      `- \`$qwen-api help\` — Show this help message.`;
  }

  res.setHeader('Content-Type', streamRequested ? 'text/event-stream' : 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (streamRequested) {
    res.write(formatStreamChunk(responseText));
    res.write(formatStreamDone());
    return res.end();
  } else {
    return res.json({
      id: 'chatcmpl-cmd-1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'qwen-proxy-command',
      choices: [{ index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
    });
  }
}

module.exports = {
  isCommandMessage,
  isCompressorDisabled,
  handleCommand,
  incrementRequestCount,
};
