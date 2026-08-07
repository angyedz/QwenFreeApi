#!/usr/bin/env node
/**
 * npm run install:setup
 *
 * Интерактивный установщик:
 *   1. Проверяет окружение (node, npm, зависимости).
 *   2. Предлагает войти в аккаунт Qwen (npm run login / --cookie-only).
 *   3. Обновляет модели (npm run models).
 *   4. Добавляет systemd-user сервис (если пользователь разрешит).
 *   5. Добавляет провайдер `qwen` в конфиг opencode (если разрешит).
 *   6. Печатает итоговую сводку и адреса.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const ACCOUNT_FILE = path.join(CONFIG_DIR, 'account.json');
const ACCOUNTS_DIR = path.join(CONFIG_DIR, 'accounts');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q, def = '') =>
  new Promise((resolve) => {
    rl.question(def ? `${q} [${def}] ` : `${q} `, (a) => resolve(a.trim() || def));
  });

const yesNo = async (q, def = 'y') => {
  const a = (await ask(q, def)).toLowerCase();
  return a === 'y' || a === 'yes' || a === 'д' || a === 'да';
};

const run = (cmd, opts = {}) => {
  console.log(`\n  $ ${cmd}\n`);
  try {
    return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
  } catch (e) {
    return null;
  }
};

function line(char = '-') {
  console.log(char.repeat(60));
}

function heading(t) {
  console.log(`\n== ${t} ==`);
}

function hasPkg(name) {
  try {
    return !!require.resolve(name, { paths: [ROOT] });
  } catch (_) {
    return false;
  }
}

async function ensureDeps() {
  heading('Зависимости');
  const deps = ['express', 'axios', 'dotenv', 'cors'];
  const missing = deps.filter((d) => !hasPkg(d));
  if (missing.length) {
    console.log(`Не установлены: ${missing.join(', ')}`);
    if (await yesNo('Установить (npm install)?')) {
      run('npm install --no-audit --no-fund');
    }
  } else {
    console.log('Базовые зависимости уже на месте.');
  }
  const pw = hasPkg('playwright');
  const pp = hasPkg('puppeteer');
  if (!pw && !pp) {
    console.log('\nДля автозахвата токена нужен Playwright (Chromium).');
    if (await yesNo('Установить playwright + chromium?')) {
      run('npm install playwright --no-audit --no-fund');
      run('npx playwright install chromium --with-deps');
    }
  }
}

async function ensureLogin() {
  heading('Аккаунт Qwen');
  if (fs.existsSync(ACCOUNT_FILE)) {
    try {
      const acc = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
      if (acc && acc.token) {
        console.log(`Найден сохранённый аккаунт (token...${String(acc.token).slice(-6)}).`);
        if (await yesNo('Перелогиниться заново?', 'n')) {
          run('npm run login');
        }
        return;
      }
    } catch (_) {}
  }
  console.log('Нужен аккаунт Qwen Chat (chat.qwen.ai).');
  if (await yesNo('Открыть браузер для входа сейчас?')) {
    run('npm run login');
  } else {
    console.log('Пропущено. Позже: npm run login');
  }
}

async function syncModels() {
  heading('Модели');
  if (await yesNo('Получить список актуальных моделей (npm run models)?')) {
    run('npm run models');
  } else {
    console.log('Пропущено. Позже: npm run models');
  }
}

async function installSystemd() {
  heading('Автозапуск (systemd user)');
  const hasSystemd =
    process.platform !== 'win32' &&
    (fs.existsSync('/run/systemd/system') ||
      (fs.existsSync('/sbin/systemctl') && execSync('echo ok', { stdio: 'ignore' }) === null) ||
      true);
  if (!hasSystemd) {
    console.log('systemd не найден — пропускаю.');
    return;
  }
  const serviceName = 'qwen-free-api.service';
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, serviceName);
  const already = fs.existsSync(unitPath);

  if (already) {
    if (await yesNo(`Сервис ${serviceName} уже есть. Переустановить (enable --now)?`, 'y')) {
      writeUnit(unitPath);
      run('systemctl --user daemon-reload');
      run(`systemctl --user enable --now ${serviceName}`);
    }
    return;
  }
  if (await yesNo('Добавить автозапуск через systemd-user?')) {
    fs.mkdirSync(unitDir, { recursive: true });
    writeUnit(unitPath);
    run('systemctl --user daemon-reload');
    run(`systemctl --user enable --now ${serviceName}`);
    console.log('Сервис включён. Управление: systemctl --user status qwen-free-api');
  } else {
    console.log('Автозапуск пропущен. Запуск вручную: npm start');
  }
}

function writeUnit(unitPath) {
  const node = process.execPath;
  const unit = `[Unit]
Description=Qwen Free API - local OpenAI-compatible proxy + web chat
After=network.target

[Service]
Type=simple
ExecStart=${node} ${path.join(ROOT, 'server.js')}
WorkingDirectory=${ROOT}
Restart=on-failure
RestartSec=3
Environment=PORT=3265
Environment=QWEN_WORKSPACE=${path.join(os.homedir(), 'qwen-workspace')}
TimeoutStopSec=10

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, 'utf8');
  console.log(`  unit: ${unitPath}`);
}

async function installOpencode() {
  heading('opencode');
  const cfgHome = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(os.homedir(), '.config', 'opencode');
  const cfgPath = path.join(cfgHome, 'opencode.json');

  if (!fs.existsSync(cfgPath)) {
    console.log(`Не найден конфиг opencode (${cfgPath}).`);
    if (await yesNo('Создать opencode.json с провайдером qwen?')) {
      fs.mkdirSync(cfgHome, { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(providerConfig(), null, 2) + '\n', 'utf8');
      console.log('  создан:', cfgPath);
    }
    return;
  }

  const raw = fs.readFileSync(cfgPath, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (_) {
    console.log('  opencode.json невалиден (возможно это .jsonc). Пропускаю правку.');
    return;
  }
  if (cfg.provider && cfg.provider.qwen) {
    if (await yesNo('Провайдер qwen уже есть. Обновить его?')) {
      cfg.provider.qwen = providerConfig().provider.qwen;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      console.log('  обновлён:', cfgPath);
    }
    return;
  }
  if (await yesNo('Добавить провайдер qwen в opencode.json?')) {
    cfg.provider = cfg.provider || {};
    cfg.provider.qwen = providerConfig().provider.qwen;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log('  добавлен:', cfgPath);
  }
}

function providerConfig() {
  const models = {
    'qwen3.8-max': [1000000, 131072],
    'qwen3.7-plus': [1000000, 65536],
    'qwen3.7-max': [1000000, 81920],
    'qwen3.8-max-preview': [1000000, 65536],
    'qwen3.6-plus': [1000000, 65536],
    'qwen3.6-max-preview': [262144, 81920],
    'qwen3.6-27b': [262144, 81920],
    'qwen3.5-plus': [1000000, 65536],
    'qwen3.5-omni-plus': [262144, 65536],
    'qwen3.6-35b-a3b': [262144, 81920],
    'qwen3.5-flash': [1000000, 65536],
    'qwen3.5-397b-a17b': [262144, 65536],
    'qwen3.5-omni-flash': [262144, 65536],
    'qwen3-max-2026-01-23': [262144, 32768],
    'qwen-plus-2025-07-28': [131072, 81920],
    'qwen3-coder-plus': [1048576, 65536],
    'qwen3-vl-plus': [262144, 81920],
    'qwen3-omni-flash-2025-12-01': [65536, 13684],
  };
  const modelConfig = Object.fromEntries(Object.entries(models).map(([id, [context, output]]) => [id, {
    name: id,
    reasoning: !id.includes('omni-flash') && !id.includes('omni-plus'),
    tool_call: true,
    limit: { context, output },
  }]));
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      qwen: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Qwen Free',
        options: {
          baseURL: 'http://localhost:3265/v1',
          apiKey: 'local',
        },
        models: modelConfig,
      },
    },
  };
}

async function summary() {
  heading('Итог');
  line();
  const acc = fs.existsSync(ACCOUNT_FILE) || (fs.existsSync(ACCOUNTS_DIR) && fs.readdirSync(ACCOUNTS_DIR).some((name) => name.endsWith('.json')));
  console.log('  Аккаунты Qwen       : ' + (acc ? 'OK' : 'не настроены (npm run accounts)'));
  console.log('  Модели              : ' + (fs.existsSync(path.join(CONFIG_DIR, 'models-cache.json')) ? 'кэш есть' : 'npm run models'));
  console.log('  Веб-чат             : http://localhost:3265/');
  console.log('  OpenAI API          : http://localhost:3265/v1');
  console.log('  Workspace (файлы)   : ' + (process.env.QWEN_WORKSPACE || path.join(os.homedir(), 'qwen-workspace')));
  line();
  console.log('\nГотово. Запусти: npm start  (или открой http://localhost:3265)');
}

(async () => {
  console.log('');
  console.log('  Qwen Free API — установщик');
  console.log('  Прокси + веб-чат + тулы + opencode');
  line();

  if (!process.env.OPENCODE_ALLOW_UNSAFE && process.getuid && process.getuid() === 0) {
    console.log('\nНе запускай установщик от root.');
    process.exit(1);
  }

  await ensureDeps();
  await ensureLogin();
  await syncModels();
  await installSystemd();
  await installOpencode();
  await summary();

  rl.close();
})().catch((e) => {
  console.error('\nУстановка прервана:', e.message);
  rl.close();
  process.exit(1);
});
