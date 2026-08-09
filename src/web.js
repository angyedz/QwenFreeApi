'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const chatStore = require('./chat-store');
const agent = require('./agent');
const toolExecutor = require('./tool-executor');
const { logger } = require('./util');

/**
 * Веб-приложение чата: статика + REST API + потоковая отправка сообщений (SSE).
 * Монтируется на тот же Express-сервер, что и /v1-прокси.
 */

function attachWeb(app) {
  const publicDir = path.join(config.PROJECT_ROOT, 'public');

  // ---------- Static ----------
  app.use(express.static(publicDir));

  // ---------- API: chats ----------
  app.get('/api/chats', (req, res) => {
    res.json({ chats: chatStore.list() });
  });

  app.post('/api/chats', (req, res) => {
    const body = req.body || {};
    const chat = chatStore.create({
      title: body.title || 'Новый чат',
      model: body.model || config.DEFAULT_MODEL,
      settings: body.settings || {},
    });
    res.status(201).json({ chat });
  });

  app.get('/api/chats/:id', (req, res) => {
    const chat = chatStore.get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat });
  });

  app.delete('/api/chats/:id', (req, res) => {
    chatStore.remove(req.params.id);
    res.json({ ok: true });
  });

  app.patch('/api/chats/:id', (req, res) => {
    const body = req.body || {};
    const chat = chatStore.update(req.params.id, {
      title: body.title,
      model: body.model,
      settings: body.settings,
    });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ chat });
  });

  app.post('/api/chats/:id/clear', (req, res) => {
    const chat = chatStore.update(req.params.id, { messages: [] });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json({ ok: true });
  });

  // ---------- API: config ----------
  app.get('/api/models', (req, res) => {
    res.json({ models: config.MODELS, default: config.DEFAULT_MODEL });
  });

  app.get('/api/workspace', (req, res) => {
    res.json({ workspace: toolExecutor.getWorkspace() });
  });

  app.post('/api/workspace', (req, res) => {
    const dir = (req.body || {}).workspace;
    if (!dir) return res.status(400).json({ error: 'workspace required' });
    toolExecutor.initWorkspace(dir);
    res.json({ workspace: toolExecutor.getWorkspace() });
  });

  // ---------- API: send message (SSE) ----------
  app.post('/api/chats/:id/messages', async (req, res) => {
    const id = req.params.id;
    const chat = chatStore.get(id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const content = String((req.body || {}).content || '').trim();
    if (!content) return res.status(400).json({ error: 'Empty message' });

    const patch = (req.body || {}).settings;
    if (patch) {
      chat.settings = { ...(chat.settings || {}), ...patch };
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

    try {
      const finalAssistant = await agent.runTurn(chat, content, emit);
      chatStore.save(chat);
      if (chat.messages.length > 0) {
        const firstUser = chat.messages.find((m) => m.role === 'user');
        const title = firstUser
          ? String(firstUser.content).slice(0, 42).replace(/\s+/g, ' ').trim()
          : 'Новый чат';
        if (chat.title === 'Новый чат' && title) chat.title = title;
        chatStore.save(chat);
      }
      emit({ type: 'done', content: finalAssistant.content });
    } catch (err) {
      logger.error(`[chat message] ${err.message}`, 'WEB', err);
      emit({ type: 'error', message: err.message });
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
}

module.exports = { attachWeb };
