/* Qwen Chat web app — клиентская логика. */

'use strict';

const state = {
  chatId: null,
  sending: false,
  settings: { thinking: false, webSearch: false, terminal: true, files: true },
  activeAssistant: null,
};

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scrollDown() {
  const m = $('#messages');
  m.scrollTop = m.scrollHeight;
}

/* ---------------- Markdown-lite (безопасно, без textContent->innerHTML уязвимостей) ---------------- */

function inline(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function escapeAndInline(s) {
  return inline(escapeHtml(s));
}

function renderMarkdown(text) {
  const lines = String(text).split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let inList = null;

  const closeList = () => {
    if (inList) { html += `</${inList}>`; inList = null; }
  };

  for (let raw of lines) {
    raw = raw.replace(/\r$/, '');
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      if (!inCode) {
        closeList();
        codeBuf = [];
        inCode = true;
      } else {
        html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
        codeBuf = [];
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (trimmed === '') { closeList(); continue; }

    const h = raw.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      closeList();
      const n = h[1].length;
      html += `<h${n}>${escapeAndInline(h[2])}</h${n}>`;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(raw)) {
      if (inList !== 'ul') { closeList(); inList = 'ul'; html += '<ul>'; }
      html += `<li>${escapeAndInline(raw.replace(/^\s*[-*+]\s+/, ''))}</li>`;
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(raw)) {
      if (inList !== 'ol') { closeList(); inList = 'ol'; html += '<ol>'; }
      html += `<li>${escapeAndInline(raw.replace(/^\s*\d+[.)]\s+/, ''))}</li>`;
      continue;
    }
    closeList();
    html += `<p>${escapeAndInline(raw)}</p>`;
  }
  closeList();
  if (inCode) html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
  return html;
}

/* ---------------- Message DOM ---------------- */

function appendAssistant() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Qwen';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-assistant';
  wrap.appendChild(role);
  wrap.appendChild(bubble);
  $('#messages').appendChild(wrap);
  scrollDown();
  return { wrap, bubble };
}

function appendUser(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = 'Вы';
  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-user';
  bubble.textContent = text;
  wrap.appendChild(role);
  wrap.appendChild(bubble);
  $('#messages').appendChild(wrap);
  scrollDown();
}

function addReasoningChunk(text) {
  const a = ensureAssistant();
  if (!a.reasonEl) {
    a.reasonEl = document.createElement('details');
    a.reasonEl.className = 'reasoning streaming';
    a.reasonEl.open = true;
    a.reasonEl.innerHTML = `<summary class="reason-summary"><svg class="brain-icon"><use href="#i-brain"/></svg> <span>Размышления (Thinking)</span></summary><div class="reason-text"></div>`;
    a.reasonText = a.reasonEl.querySelector('.reason-text');
    a.bubble.appendChild(a.reasonEl);
  }
  a.reasonText.textContent += text;
  scrollDown();
}

function addAnswerChunk(text) {
  const a = ensureAssistant();
  a.raw = (a.raw || '') + text;
  if (!a.textEl) {
    a.textEl = document.createElement('div');
    a.textEl.className = 'answer';
    a.bubble.appendChild(a.textEl);
  }
  a.textEl.innerHTML = renderMarkdown(a.raw) + '<span class="thinking">▍</span>';
  scrollDown();
}

function addTool(name, args) {
  const a = ensureAssistant();
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML =
    `<div class="tool-head">${toolIcon(name)}<span class="name">${escapeHtml(name)}</span>` +
    `<span class="state running">работает…</span></div>` +
    `<div class="tool-payload">${escapeHtml(JSON.stringify(args, null, 2))}</div>`;
  a.bubble.appendChild(card);
  (a.toolQueue ||= []).push(card);
  scrollDown();
}

function addToolResult(name, output) {
  const a = ensureAssistant();
  const card = (a.toolQueue || []).shift();
  if (card) {
    const stateEl = card.querySelector('.state');
    stateEl.textContent = 'готово';
    stateEl.classList.remove('running');
    const payload = card.querySelector('.tool-payload');
    payload.textContent = String(output).slice(0, 6000);
    payload.classList.add('result');
  }
  scrollDown();
}

function ensureAssistant() {
  if (state.activeAssistant && !state.activeAssistant.done) return state.activeAssistant;
  const a = appendAssistant();
  a.done = false;
  a.raw = '';
  a.textEl = null;
  a.reasonEl = null;
  a.reasonText = null;
  a.toolQueue = [];
  state.activeAssistant = a;
  return a;
}

function finishAssistant() {
  const a = state.activeAssistant;
  if (a) {
    a.done = true;
    if (a.textEl) {
      const live = a.textEl.querySelector('.thinking');
      if (live) live.remove();
      a.textEl.innerHTML = renderMarkdown(a.raw || '');
    }
    if (a.reasonEl) a.reasonEl.classList.remove('streaming');
  }
  state.activeAssistant = null;
}

function showTyping() {
  if ($('#typing')) { scrollDown(); return; }
  const t = document.createElement('div');
  t.className = 'msg msg-assistant';
  t.id = 'typing';
  t.innerHTML =
    `<div class="msg-role">Qwen</div><div class="bubble bubble-assistant">` +
    `<span class="typing-dots"><span></span><span></span><span></span></span></div>`;
  $('#messages').appendChild(t);
  scrollDown();
}

function hideTyping() {
  const t = $('#typing');
  if (t) t.remove();
}

function toolIcon(name) {
  const icon =
    /bash|run_command/.test(name) ? 'i-term' :
    /^list_dir|^read_file|^write_file|^edit_file/.test(name) ? 'i-doc' :
    /web_search/.test(name) ? 'i-search' : 'i-bolt';
  return `<svg><use href="#${icon}"/></svg>`;
}

function addError(msg) {
  finishAssistant();
  const a = appendAssistant();
  const p = document.createElement('p');
  p.className = 'error-line';
  p.textContent = 'Ошибка: ' + msg;
  a.bubble.appendChild(p);
}

/* ---------------- Streaming ---------------- */

async function sendMessage(text) {
  if (state.sending || !text) return;
  if (!state.chatId) {
    await newChat({ text });
    return;
  }
  state.sending = true;
  $('#send').disabled = true;
  const input = $('#input');
  input.value = '';
  autosize();
  appendUser(text);
  showTyping();

  try {
    const res = await fetch(`/api/chats/${state.chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, settings: state.settings }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try { handleEvent(JSON.parse(payload)); } catch (_) {}
        }
      }
    }
  } catch (err) {
    addError(err.message);
  } finally {
    state.sending = false;
    $('#send').disabled = false;
    hideTyping();
    finishAssistant();
    autosize();
    refreshList();
    if (state.chatId) {
      // обновить заголовок чата после поиска
      api(`/api/chats/${state.chatId}`).then(({ chat }) => {
        $('#chat-title').textContent = chat.title || 'Новый чат';
      }).catch(() => {});
    }
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'reasoning': addReasoning(ev.text); break;
    case 'text': addAnswerChunk(ev.text); break;
    case 'tool': addTool(ev.name, ev.args); break;
    case 'tool_result': addToolResult(ev.name, ev.output); break;
    case 'error': addError(ev.message); break;
    case 'done': finishAssistant(); break;
    case 'round': showTyping(); break;
  }
}

/* ---------------- Chat management ---------------- */

async function newChat({ text } = {}) {
  const { chat } = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ model: $('#model-select').value, settings: state.settings }),
  });
  state.chatId = chat.id;
  $('#messages').innerHTML = '';
  $('#chat-title').textContent = chat.title || 'Новый чат';
  refreshSettingsChips();
  refreshList();
  if (text) await sendMessage(text);
  else showWelcome();
}

function renderList(chats) {
  const list = $('#chat-list');
  list.innerHTML = '';
  list.classList.toggle('empty', !chats.length);
  if (!chats.length) {
    list.innerHTML = '<div class="empty-hint"><svg><use href="#i-doc"/></svg><span>Пока пусто</span></div>';
    return;
  }
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === state.chatId ? ' active' : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = c.title || 'Новый чат';
    t.onclick = () => openChat(c.id);
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Удалить';
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить чат?')) return;
      try {
        await api(`/api/chats/${c.id}`, { method: 'DELETE' });
        if (state.chatId === c.id) {
          state.chatId = null;
          state.activeAssistant = null;
          $('#chat-title').textContent = 'Новый чат';
          showWelcome();
        }
        refreshList();
      } catch (err) {
        addError(err.message);
      }
    };
    item.appendChild(t);
    item.appendChild(del);
    list.appendChild(item);
  }
}

function refreshList() {
  api('/api/chats').then(({ chats }) => renderList(chats)).catch(() => {});
}

async function openChat(id) {
  const { chat } = await api(`/api/chats/${id}`);
  state.chatId = id;
  state.activeAssistant = null;
  $('#messages').innerHTML = '';
  $('#chat-title').textContent = chat.title || 'Новый чат';
  $('#model-select').value = chat.model;
  $('#history-toggle').checked = false;
  for (const m of chat.messages || []) {
    if (m.role === 'user') {
      appendUser(typeof m.content === 'string' ? m.content : '');
    } else if (m.role === 'assistant') {
      const a = appendAssistant();
      a.done = true;
      if (m.content) {
        a.bubble.innerHTML = renderMarkdown(typeof m.content === 'string' ? m.content : '');
      }
      for (const tc of m.tool_calls || []) {
        const card = document.createElement('div');
        card.className = 'tool-card';
        card.innerHTML = `<div class="tool-head">${toolIcon(tc.function.name)}<span class="name">${escapeHtml(tc.function.name)}</span><span class="state">выполнено</span></div><div class="tool-payload">${escapeHtml(tc.function.arguments || '{}')}</div>`;
        a.bubble.appendChild(card);
      }
    }
  }
  refreshList();
}

function render(content) {
  return renderMarkdown(content || '');
}

function refreshSettingsChips() {
  document.querySelectorAll('.chip').forEach((chip) => {
    const key = chip.dataset.setting;
    chip.classList.toggle('on', !!state.settings[key]);
  });
}

function autosize() {
  const i = $('#input');
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight, 160) + 'px';
}

async function initModelSelect() {
  try {
    const j = await api('/api/models');
    const sel = $('#model-select');
    sel.innerHTML = '';
    for (const m of j.models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
    sel.value = j.default;
    sel.addEventListener('change', async () => {
      if (state.chatId) {
        await api(`/api/chats/${state.chatId}`, { method: 'PATCH', body: JSON.stringify({ model: sel.value }) });
      }
    });
  } catch (_) {}
}

function init() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.setting;
      state.settings[key] = !state.settings[key];
      refreshSettingsChips();
    });
  });

  const form = $('#composer-form');
  const input = $('#input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.sending) return;
    sendMessage(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', autosize);

  $('#new-chat').addEventListener('click', () => {
    newChat().catch((err) => addError(err.message));
    $('#history-toggle').checked = false;
  });
  $('#btn-clear').addEventListener('click', async () => {
    if (!state.chatId) return;
    if (!confirm('Очистить историю сообщений?')) return;
    try {
      await api(`/api/chats/${state.chatId}/clear`, { method: 'POST' });
      state.activeAssistant = null;
      showWelcome();
    } catch (err) {
      addError(err.message);
    }
  });

  refreshSettingsChips();
  initModelSelect();
  refreshList();
}

document.addEventListener('DOMContentLoaded', init);
