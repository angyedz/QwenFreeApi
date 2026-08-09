#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { spawnSync } = require('child_process');
const path = require('path');
const accountStore = require('../src/account-store');

let rl = null;

function getReadLine() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function ask(question) {
  return new Promise((resolve) => {
    getReadLine().question(question, (answer) => resolve(String(answer || '').trim()));
  });
}

function clear() {
  process.stdout.write('\x1b[2J\x1b[0f');
}

function printAccounts() {
  accountStore.load();
  const list = accountStore.list();
  console.log('==================================================');
  console.log('       📋 QWEN ACCOUNTS DASHBOARD');
  console.log('==================================================\n');

  if (!list.length) {
    console.log('  ⚠️ Нет сохранённых аккаунтов. Нажмите [a], чтобы добавить.\n');
  } else {
    for (const [index, account] of list.entries()) {
      const isCurrent = account.active ? ' ⭐️ (АКТИВНЫЙ)' : '';
      let state = '✅ Доступен';
      if (!account.available) {
        const untilStr = account.unavailableUntil > 0 ? new Date(account.unavailableUntil).toLocaleTimeString() : 'блокировка WAF';
        state = `❌ Заблокирован до ${untilStr}`;
      }

      const tokenPreview = account.token ? `${account.token.slice(0, 16)}...` : '❌ НЕТ ТОКЕНА';
      console.log(`  [${index + 1}] ID: ${account.id}${isCurrent}`);
      console.log(`      Email/Пользователь: ${account.email}`);
      console.log(`      Статус:             ${state} | Ошибок: ${account.failures}`);
      console.log(`      Токен:              ${tokenPreview}`);
      if (account.lastError) {
        console.log(`      Ошибка:             ${account.lastError}`);
      }
      console.log('  ------------------------------------------------');
    }
  }

  console.log('\n  [a] Add (добавить)     [r] Relogin (обновить токен)');
  console.log('  [s] Select (выбрать)   [u] Unlock (снять блокировку)');
  console.log('  [t] Test (проверить)   [d] Delete (удалить аккаунт)');
  console.log('  [q] Quit (выход)\n');

  return list;
}

function runLogin(id, isRelogin = false) {
  if (rl) {
    rl.close();
    rl = null;
  }

  const loginScript = path.join(__dirname, 'login.js');
  const args = ['--account', id];
  if (isRelogin) args.push('--relogin');

  console.log(`\n🚀 Запуск браузера для ${isRelogin ? 'обновления' : 'добавления'} аккаунта [${id}]…\n`);
  const result = spawnSync(process.execPath, [loginScript, ...args], { stdio: 'inherit' });

  if (result.status !== 0) {
    console.log('\n❌ Ошибка или отмена процесса входа.\n');
  } else {
    console.log('\n✅ Успешно обновлено!\n');
  }
}

async function main() {
  while (true) {
    clear();
    const list = printAccounts();
    const command = (await ask('Выберите действие: ')).toLowerCase();

    if (command === 'q' || command === 'quit' || command === 'exit') {
      console.log('\nВыход.');
      break;
    }

    if (command === 'a' || command === 'add') {
      let id = await ask('Введите ID нового аккаунта (или Enter для авто-выбора): ');
      if (!id) id = `account-${list.length + 1}`;
      runLogin(id, false);
      await ask('Нажмите Enter для продолжения…');
    } else if (command === 'r' || command === 'relogin') {
      if (!list.length) {
        console.log('Нет аккаунтов для обновления.');
        await ask('Enter…');
        continue;
      }
      const value = await ask('Введите номер или ID аккаунта для перевхода: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        runLogin(account.id, true);
      } else {
        console.log('❌ Аккаунт не найден.');
      }
      await ask('Нажмите Enter для продолжения…');
    } else if (command === 's' || command === 'select') {
      if (!list.length) continue;
      const value = await ask('Введите номер или ID активного аккаунта: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        accountStore.select(account.id);
        console.log(`\n✅ Аккаунт [${account.id}] выбран как активный.\n`);
      } else {
        console.log('❌ Аккаунт не найден.');
      }
      await ask('Enter…');
    } else if (command === 'u' || command === 'unlock') {
      if (!list.length) continue;
      const value = await ask('Введите номер или ID аккаунта (или "all" для всех): ');
      if (value.toLowerCase() === 'all') {
        for (const acc of list) accountStore.reset(acc.id);
        console.log('\n✅ Все аккаунты разблокированы.\n');
      } else {
        const account = list[Number(value) - 1] || accountStore.get(value);
        if (account) {
          accountStore.reset(account.id);
          console.log(`\n✅ Аккаунт [${account.id}] разблокирован.\n`);
        } else {
          console.log('❌ Аккаунт не найден.');
        }
      }
      await ask('Enter…');
    } else if (command === 't' || command === 'test') {
      if (!list.length) continue;
      const qwenClient = require('../src/qwen-client');
      const chatAdapter = require('../src/chat-adapter');
      console.log('\n🧪 Проверка всех аккаунтов через API Qwen…\n');
      for (const acc of list) {
        process.stdout.write(`  Тестирование [${acc.id}] (${acc.email})… `);
        try {
          const prepared = await chatAdapter.preparePublicPayload(
            {
              model: 'qwen3.8-max',
              messages: [{ role: 'user', content: 'ping' }],
            },
            { account: acc }
          );
          const res = await qwenClient.sendChatRequest(prepared.qwenPayload, acc);
          if (res.status) {
            let text = '';
            await new Promise((resFn) => {
              res.response.on('data', (c) => { text += c.toString(); });
              res.response.on('end', resFn);
            });
            if (text.includes('RateLimited')) {
              console.log('❌ Превышен дневной лимит (RateLimited)');
              accountStore.markFailure(acc, 'RateLimited');
            } else if (text.includes('FAIL_SYS_USER_VALIDATE') || text.includes('RGV587_ERROR')) {
              console.log('❌ Капча WAF (RGV587)');
              accountStore.markFailure(acc, 'WAF Captcha Challenge', true);
            } else if (text.includes('choices') || text.includes('delta') || text.includes('content')) {
              console.log('✅ ИДЕАЛЬНО (Работает)');
              accountStore.markSuccess(acc);
            } else {
              console.log(`❌ Ошибка ответа: ${text.slice(0, 80)}`);
              accountStore.markFailure(acc, 'Invalid SSE response');
            }
          } else {
            console.log(`❌ Ошибка: ${res.message}`);
          }
        } catch (e) {
          console.log(`❌ Исключение: ${e.message}`);
        }
      }
      await ask('\nНажмите Enter для продолжения…');
    } else if (command === 'd' || command === 'delete') {
      if (!list.length) continue;
      const value = await ask('Введите номер или ID аккаунта для удаления: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        const confirm = await ask(`Удалить аккаунт [${account.id}]? (y/N): `);
        if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
          const fs = require('fs');
          const file = path.join(require('../src/config').ACCOUNTS_DIR, `${account.id}.json`);
          if (fs.existsSync(file)) fs.unlinkSync(file);
          accountStore.load();
          console.log('\n✅ Аккаунт удалён.');
        }
      } else {
        console.log('❌ Аккаунт не найден.');
      }
      await ask('Enter…');
    }
  }

  if (rl) rl.close();
}

main().catch((err) => {
  console.error(err);
  if (rl) rl.close();
  process.exitCode = 1;
});
