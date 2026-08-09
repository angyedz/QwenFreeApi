'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { logger } = require('./util');

let activeResolver = null;

/**
 * Автоматически вызывать Playwright окно с капчей для аккаунта.
 * @param {string} accountId
 * @param {string} captchaUrl
 * @returns {Promise<boolean>}
 */
function solveCaptcha(accountId, captchaUrl = '') {
  if (activeResolver) return activeResolver;

  logger.warn(`[WAF CAPTCHA] Launching browser window for account "${accountId}" to solve captcha slider...`, 'WAF');

  activeResolver = new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'login.js');
    const args = ['--account', accountId, '--cookie-only'];
    if (captchaUrl) args.push('--captcha', captchaUrl);
    
    // Запускаем login.js в видимом режиме (headless: false по умолчанию)
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('exit', (code) => {
      activeResolver = null;
      if (code === 0) {
        logger.info(`[WAF CAPTCHA] Captcha solved and cookies updated for account "${accountId}"!`, 'WAF');
        resolve(true);
      } else {
        logger.error(`[WAF CAPTCHA] Captcha resolution failed with code ${code}`, 'WAF');
        resolve(false);
      }
    });

    child.on('error', (err) => {
      activeResolver = null;
      logger.error(`[WAF CAPTCHA] Failed to launch Playwright browser: ${err.message}`, 'WAF');
      resolve(false);
    });
  });

  return activeResolver;
}

module.exports = { solveCaptcha };
