#!/usr/bin/env node
'use strict';

/**
 * login.js — сохраняет аккаунт Qwen Chat в config/accounts/<id>.json.
 *
 * Открывает настоящий браузер (Playwright Chromium) на chat.qwen.ai.
 * Ты логинишься вручную (или уже залогинен в постоянном профиле). Скрипт
 * вытаскивает из localStorage JWT `token` и весь cookie-джар и сохраняет их.
 * Это даёт серверу реальные браузерные cookies (cna, acw_tc, ...), которые
 * вместе со свежими SSXMOD cookies (генерятся на каждый запрос) проходят WAF.
 *
 * Опции:
 *   --cookie-only     не ждать логина, просто забрать куки из профиля (быстрее)
 *   --headless        headless (обычно не пройдёт капчу)
 *   --profile <path>  путь постоянного профиля (переиспользовать логин)
 *   --account <id>    имя аккаунта в пуле
 *   --manual          без Playwright: вставить токен вручную
 */
const path = require('path');
const config = require('../src/config');
const accountStore = require('../src/account-store');
const { logger } = require('../src/util');

const args = process.argv.slice(2);
const useManual = args.includes('--manual');
const accountArgIdx = args.indexOf('--account');
const accountId = accountArgIdx >= 0 ? args[accountArgIdx + 1] : undefined;

// ---- Ручной ввод (без Playwright) ----
if (useManual) {
  console.log(`
=== MANUAL TOKEN IMPORT ===

1. Открой https://chat.qwen.ai и войди в аккаунт.
2. F12 -> Application -> Local Storage -> https://chat.qwen.ai
   Скопируй значение ключа "token" (JWT, начинается с eyJ...).

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
      logger.info('Токен сохранён. Запусти `npm start`.', 'LOGIN');
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
    'Playwright не установлен. Запусти: npm i playwright && npx playwright install chromium  (или используй --manual)',
    'LOGIN',
    e
  );
  process.exit(1);
}

const cookieOnly = args.includes('--cookie-only');
const headless = args.includes('--headless');
const profileArgIdx = args.indexOf('--profile');
const profileDir =
  profileArgIdx >= 0
    ? path.resolve(args[profileArgIdx + 1])
    : path.join(config.CONFIG_DIR, 'browser-profile');

(async () => {
  logger.info('Запуск Chromium… (если WAF просит слайдер — пройди его в окне)', 'LOGIN');

  const browser = await playwright.chromium.launchPersistentContext(profileDir, {
    headless,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    userAgent: config.USER_AGENT,
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });

  const page = browser.pages()[0] || (await browser.newPage());
  await page.goto(config.BASE_URL, { waitUntil: 'domcontentloaded' });

  if (!cookieOnly) {
    logger.info('Войди в аккаунт в открывшемся окне. Скрипт подхватит токен сам…', 'LOGIN');
    await page.waitForFunction(
      () => {
        const t = window.localStorage.getItem('token') || window.localStorage.getItem('active_token');
        return !!t && t.length > 60;
      },
      null,
      { timeout: 5 * 60 * 1000 }
    );
  } else {
    await page.waitForTimeout(4000);
  }

  // 1) JWT token из localStorage
  const token = await page.evaluate(() => {
    const direct =
      window.localStorage.getItem('token') || window.localStorage.getItem('active_token');
    if (direct) return direct;
    for (let i = 0; i < window.localStorage.length; i++) {
      const v = window.localStorage.getItem(window.localStorage.key(i)) || '';
      const m = v.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (m) return m[0];
    }
    return null;
  });

  // 2) Cookie-джар
  let cookieJar = [];
  try {
    cookieJar = await browser.cookies();
  } catch (e) {
    logger.warn('Не удалось снять cookies: ' + e.message, 'LOGIN');
  }

  if (!token) {
    logger.error(
      'Токен не найден. Логин не завершён или WAF отклонил. Попробуй --manual.',
      'LOGIN'
    );
    await browser.close();
    process.exit(1);
  }

  // Оставляем только хост-полезные cookies (ssxmod генерируются сами)
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

  await accountStore.save({
    token,
    email: 'playwright-capture',
    cookie: persistable,
    savedAt: Date.now(),
    profileDir,
  }, accountId);

  logger.info(`Сохранено ${persistable.length} cookies + token.`, 'LOGIN');
  logger.info(
    'Запусти `npm start`, затем используй http://localhost:3265/v1 в любом OpenAI-клиенте.',
    'LOGIN'
  );

  await browser.close();
  process.exit(0);
})().catch((e) => {
  logger.error('Ошибка login: ' + e.message, 'LOGIN', e);
  process.exit(1);
});
