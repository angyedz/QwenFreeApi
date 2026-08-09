#!/usr/bin/env node
'use strict';

/**
 * login.js — сохраняет или обновляет аккаунт Qwen Chat в config/accounts/<id>.json.
 *
 * Открывает настоящий браузер (Playwright Chromium) на chat.qwen.ai.
 * Если передан --relogin, старый токен не подставляется, скрипт ожидает нового входа пользователя.
 */
const config = require('../src/config');
const accountStore = require('../src/account-store');
const { logger } = require('../src/util');

const args = process.argv.slice(2);
const useManual = args.includes('--manual');
const isRelogin = args.includes('--relogin');
const cookieOnly = args.includes('--cookie-only');
const headless = args.includes('--headless');

const accountArgIdx = args.indexOf('--account');
const accountId = accountArgIdx >= 0 ? args[accountArgIdx + 1] : undefined;

const captchaArgIdx = args.indexOf('--captcha');
const captchaUrl = captchaArgIdx >= 0 ? args[captchaArgIdx + 1] : undefined;

// ---- Ручной ввод токена ----
if (useManual) {
  console.log(`
=== РУЧНОЙ ВВОД ТОКЕНА QWEN ===

1. Открой https://chat.qwen.ai и войди в аккаунт.
2. F12 -> Application -> Local Storage -> https://chat.qwen.ai
3. Скопируй значение ключа "token" (JWT, начинается с eyJ...).

Вставь токен ниже и нажми Enter:
`);
  process.stdout.write('> ');
  const { stdin } = process;
  stdin.setEncoding('utf8');
  let input = '';
  stdin.on('data', (d) => {
    input += d;
    if (input.includes('\n')) {
      const token = input.trim().split('\n').pop().trim();
      if (!token) {
        logger.error('Пустой токен.', 'LOGIN');
        process.exit(1);
      }
      accountStore.save({ token, email: accountId || 'manual', cookie: [], savedAt: Date.now() }, accountId);
      logger.info('Токен сохранён.', 'LOGIN');
      process.exit(0);
    }
  });
  return;
}

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  logger.error(
    'Playwright не установлен. Запусти: npm i playwright && npx playwright install chromium (или используй --manual)',
    'LOGIN',
    e
  );
  process.exit(1);
}

(async () => {
  accountStore.load();
  const existingAcc = accountId ? accountStore.get(accountId) : null;
  const initialToken = (existingAcc && !isRelogin) ? existingAcc.token : null;

  logger.info('Запуск Chromium… (если появится капча WAF — пройди слайдер в окне)', 'LOGIN');

  const browser = await playwright.chromium.launch({
    headless,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--lang=en-US'],
  });

  const context = await browser.newContext({
    userAgent: config.USER_AGENT,
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('i18nextLng', 'en-US');
      window.localStorage.setItem('lang', 'en-US');
      window.localStorage.setItem('language', 'en-US');
    } catch (_) {}
  });

  // Открываем целевую страницу
  const targetUrl = captchaUrl || config.BASE_URL;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

  // Очищаем старые токены из браузера перед логином, чтобы не захватить токен предыдущего аккаунта
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem('token');
      window.localStorage.removeItem('active_token');
      window.sessionStorage.clear();
    } catch (_) {}
  });

  if (!cookieOnly) {
    logger.info('Войди в нужный аккаунт Qwen в открывшемся окне браузера…', 'LOGIN');
    
    // Ждём появления НОВОГО токена после входа пользователя
    await page.waitForFunction(
      (oldTok) => {
        const t = window.localStorage.getItem('token') || window.localStorage.getItem('active_token');
        if (!t || t.length < 60) return false;
        if (oldTok && t === oldTok) return false;
        return true;
      },
      initialToken,
      { timeout: 5 * 60 * 1000 }
    );
    // Даём пару секунд на завершение сетевых профильных запросов
    await page.waitForTimeout(2000);
  } else {
    await page.waitForTimeout(4000);
  }

  // Извлекаем токен и реальный Email/Username
  const extracted = await page.evaluate(async () => {
    let tok = window.localStorage.getItem('token') || window.localStorage.getItem('active_token');
    if (!tok) {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const v = window.localStorage.getItem(window.localStorage.key(i)) || '';
        const m = v.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        if (m) { tok = m[0]; break; }
      }
    }

    let email = '';
    // 1) Попытка получить профиль от API Qwen
    try {
      const res = await fetch('/api/v1/auths/');
      if (res.ok) {
        const data = await res.json();
        email = data.email || data.username || data.user?.email || data.data?.email || data.name || '';
      }
    } catch (_) {}

    // 2) Попытка найти email в localStorage
    if (!email) {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i) || '';
        const v = window.localStorage.getItem(k) || '';
        if (v.includes('@')) {
          try {
            const obj = JSON.parse(v);
            if (obj.email || obj.username) { email = obj.email || obj.username; break; }
          } catch (_) {
            if (v.includes('@') && !v.includes('{') && v.length < 80) { email = v; break; }
          }
        }
      }
    }

    // 3) Попытка декодировать JWT payload
    if (!email && tok && tok.includes('.')) {
      try {
        const parts = tok.split('.');
        const payload = JSON.parse(atob(parts[1]));
        email = payload.email || payload.preferred_username || payload.user_name || payload.sub || '';
      } catch (_) {}
    }

    return { token: tok, email: email || '' };
  });

  let cookieJar = [];
  try {
    cookieJar = await context.cookies();
  } catch (e) {
    logger.warn('Не удалось снять cookies: ' + e.message, 'LOGIN');
  }

  if (!extracted.token) {
    logger.error('Токен не найден. Логин не завершён.', 'LOGIN');
    await browser.close();
    process.exit(1);
  }

  const persistable = cookieJar
    .filter((c) => c.value !== null && c.value !== '')
    .filter((c) => c.name !== 'ssxmod_itna' && c.name !== 'ssxmod_itna2')
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    }));

  const finalEmail = extracted.email || (existingAcc && existingAcc.email !== 'user' ? existingAcc.email : null) || accountId || 'qwen-user';

  const saved = accountStore.save(
    {
      token: extracted.token,
      email: finalEmail,
      cookie: persistable,
      savedAt: Date.now(),
      failures: 0,
      unavailableUntil: 0,
      lastError: '',
    },
    accountId
  );

  logger.info(`✅ Успешно! Аккаунт [${saved.id}] (${saved.email}) сохранён.`, 'LOGIN');
  await browser.close();
  process.exit(0);
})().catch((e) => {
  logger.error('Ошибка в процессе входа: ' + e.message, 'LOGIN', e);
  process.exit(1);
});
