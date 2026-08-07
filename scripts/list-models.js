#!/usr/bin/env node
'use strict';

/**
 * npm run models — скачивает список актуальных моделей chat.qwen.ai и
 * сохраняет их в config/models-cache.json, подмешивая в /v1/models.
 *
 * Использование:
 *   npm run models            # показать и сохранить все модели
 *   npm run models -- --save  # сохранить в кэш (по умолчанию и так)
 *   npm run models -- --no-save
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../src/config');
const accountStore = require('../src/account-store');
const ssxmodManager = require('../src/ssxmod-manager');
const { getTimezoneHeader, generateUUID } = require('../src/util');

const save = !process.argv.includes('--no-save');

(async () => {
  ssxmodManager.init();
  if (!accountStore.load() && !accountStore.isAccount()) {
    console.log('Нет account.json. Сначала: npm run login');
    process.exit(1);
  }
  const cookie = accountStore.buildCookieHeader(
    ssxmodManager.getSsxmodItna(),
    ssxmodManager.getSsxmodItna2()
  );
  try {
    const res = await axios.get(`${config.BASE_URL}/api/models`, {
      headers: {
        'user-agent': config.USER_AGENT,
        cookie,
        source: 'web',
        version: config.QWEN_WEB_VERSION,
        timezone: getTimezoneHeader(),
        'x-request-id': generateUUID(),
        accept: 'application/json',
        origin: config.BASE_URL,
        referer: `${config.BASE_URL}/`,
      },
      timeout: 30000,
    });
    const raw = res.data && res.data.data ? res.data.data : res.data;

    // Поддержка и плоского массива ID, и массива объектов моделей с id/name.
    const models = Array.isArray(raw)
      ? raw.map((m) => (typeof m === 'string' ? m : m.id || m.model || m.name)).filter(Boolean)
      : Object.keys(raw || {});

    // Отметим только "чат"-модели (без image/video/deep-research суффиксов, чтобы не сломать ).
    const interesting = models.filter(
      (m) => !/-search$|-image$|-image-edit$|-video$|-deep-research$/.test(m)
    );

    if (!models.length) {
      console.error('Моделей не нашлось (пустой ответ). Проверь `npm run login`.');
      process.exit(1);
    }

    console.log('Доступные модели Qwen Chat:');
    for (const id of models.slice(0, 60)) console.log('  -', id);

    if (save) {
      const payload = {
        fetchedAt: new Date().toISOString(),
        models,
      };
      fs.writeFileSync(config.CACHE_FILE, JSON.stringify(payload, null, 2));
      console.log(`\nСохранено моделей: ${models.length} -> ${config.CACHE_FILE}`);
      if (interesting.length) {
        console.log('Рекомендуется для чата:');
        for (const m of interesting.slice(0, 20)) console.log('  -', m);
      }
    }
  } catch (e) {
    console.error('Не удалось получить модели:', e.message);
    const body =
      e.response && e.response.data
        ? JSON.stringify(e.response.data).slice(0, 300)
        : String(e.response || '');
    if (/<html|aliyun_waf|baxia/i.test(body)) {
      console.error('Ответ = WAF/HTML. Перезапусти `npm run login`.');
    }
    process.exit(1);
  }
  process.exit(0);
})();