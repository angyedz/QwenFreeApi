#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { spawnSync } = require('child_process');
const path = require('path');
const accountStore = require('../src/account-store');

accountStore.load();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));

function clear() { process.stdout.write('\x1b[2J\x1b[0f'); }
function printAccounts() {
  const list = accountStore.list();
  console.log('\nQwen accounts dashboard\n');
  if (!list.length) console.log('  Нет аккаунтов. Выберите [a], чтобы добавить первый.\n');
  for (const [index, account] of list.entries()) {
    const state = account.available ? 'доступен' : `недоступен до ${new Date(account.unavailableUntil).toLocaleString()}`;
    console.log(`  ${index + 1}. ${account.id}${account.active ? ' *' : ''}`);
    console.log(`     email: ${account.email} | ${state} | failures: ${account.failures}`);
    if (account.lastError) console.log(`     error: ${account.lastError}`);
  }
  console.log('\n  [r] relogin  [s] select  [u] unlock  [a] add  [d] delete  [q] quit\n');
  return list;
}

function runLogin(id) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'login.js'), '--account', id], { stdio: 'inherit' });
  if (result.status !== 0) console.log('\nЛогин завершился с ошибкой.\n');
  accountStore.load();
}

async function main() {
  while (true) {
    clear();
    const list = printAccounts();
    const command = (await ask('Действие: ')).toLowerCase();
    if (command === 'q' || command === 'quit') break;
    if (command === 'a' || command === 'add') {
      const id = await ask('ID нового аккаунта (например personal-2): ');
      if (id) runLogin(id);
    } else if (command === 'r' || command === 'relogin') {
      const value = await ask('Номер или ID аккаунта для relogin: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) runLogin(account.id);
      else console.log('Аккаунт не найден.');
    } else if (command === 's' || command === 'select') {
      const value = await ask('Номер или ID активного аккаунта: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) accountStore.select(account.id);
      else console.log('Аккаунт не найден.');
    } else if (command === 'u' || command === 'unlock') {
      const value = await ask('Номер или ID аккаунта для разблокировки: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) accountStore.reset(account.id);
      else console.log('Аккаунт не найден.');
    } else if (command === 'd' || command === 'delete') {
      const value = await ask('Номер или ID аккаунта для удаления: ');
      const account = list[Number(value) - 1] || accountStore.get(value);
      if (account) {
        const fs = require('fs');
        fs.unlinkSync(path.join(require('../src/config').ACCOUNTS_DIR, `${account.id}.json`));
        accountStore.load();
      }
    }
  }
  rl.close();
}

main().catch((err) => { console.error(err.message); rl.close(); process.exitCode = 1; });
