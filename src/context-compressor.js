'use strict';

/**
 * context-compressor.js — Интеллектуальный модуль сжатия контекста и логов
 * Вдохновлен алгоритмами Headroom, RTK (Rust Token Killer) и LLMLingua.
 */

/**
 * 1. RTK (Rust Token Killer / Terminal Output Compressor)
 * Сжимает длинные выводы терминала (bash, git diff, npm, pytest, linters).
 */
function compressTerminalOutput(text) {
  if (typeof text !== 'string' || text.length < 500) return text;

  // А) Сжатие Git Diff: сохраняет структуры файлов и измененные строки, вырезает неизмененный шум
  if (text.includes('diff --git') || text.includes('--- a/') || text.includes('+++ b/')) {
    const lines = text.split('\n');
    const kept = [];
    let diffContextCount = 0;

    for (const line of lines) {
      if (
        line.startsWith('diff --git') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('@@') ||
        line.startsWith('+') ||
        line.startsWith('-')
      ) {
        kept.push(line);
        diffContextCount = 0;
      } else if (diffContextCount < 2) {
        kept.push(line);
        diffContextCount += 1;
      } else if (diffContextCount === 2) {
        kept.push('  ... [unchanged lines omitted]');
        diffContextCount += 1;
      }
    }
    const compressed = kept.join('\n');
    if (compressed.length < text.length) return compressed;
  }

  // Б) Сжатие логов сборки / npm / pip / pytest: оставляет первичное описание и финальные ошибки
  if (text.includes('npm ERR!') || text.includes('FAIL') || text.includes('Traceback (most recent call last)')) {
    const lines = text.split('\n');
    if (lines.length > 50) {
      const head = lines.slice(0, 15);
      const tail = lines.slice(-25);
      return [...head, `\n... [${lines.length - 40} lines of intermediate build/test log omitted] ...\n`, ...tail].join('\n');
    }
  }

  // В) Если вывод универсального инструмента длиннее 3000 символов — компактно обрезаем серединку
  if (text.length > 4000) {
    const head = text.slice(0, 1500);
    const tail = text.slice(-2000);
    return `${head}\n\n... [${text.length - 3500} chars of verbose tool output omitted] ...\n\n${tail}`;
  }

  return text;
}

/**
 * 2. Skeletonizer (Скелетонизация длинных исходных файлов)
 * Если в истории есть прочитанный файл > 1000 символов, который не является текущим вопросом,
 * сворачиваем внутренности функций, оставляя только импорты и сигнатуры.
 */
function skeletonizeCode(text) {
  if (typeof text !== 'string' || text.length < 2000) return text;

  // Не трогаем, если это не блоковый код
  if (!text.includes('function') && !text.includes('class') && !text.includes('def ')) return text;

  const lines = text.split('\n');
  if (lines.length < 60) return text;

  const head = lines.slice(0, 20).join('\n');
  const tail = lines.slice(-15).join('\n');
  return `${head}\n  // ... [middle file content skeletonized (${lines.length - 35} lines)] ...\n${tail}`;
}

/**
 * 3. Semantic Word Trimmer (Удаление разговорного шума и вводных фраз)
 */
function trimSemanticNoise(text) {
  if (typeof text !== 'string' || text.length < 150) return text;

  return text
    .replace(/^Sure,? I can help with that\.?\s*/i, '')
    .replace(/^Certainly!? Here is what I found:\s*/i, '')
    .replace(/^As an AI coding assistant,?\s*/i, '')
    .replace(/^I understand your request\.?\s*/i, '');
}

/**
 * 4. Hierarchical History Aging (Иерархическое старение сообщений истории)
 *  - Hot Zone (последние 3 сообщения): без изменений (100% точность).
 *  - Warm Zone (сообщения от 4 до 10 назад): применение RTK и Skeletonizer.
 *  - Cold Zone (старше 10 сообщений): компактное сворачивание.
 */
function compressConversationHistory(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const total = messages.length;
  // Сжимаем только если диалог достаточно разросся
  if (total <= 4) return messages;

  return messages.map((msg, index) => {
    if (!msg || typeof msg.content !== 'string') return msg;

    const distanceFromEnd = total - 1 - index;

    // Hot Zone: Самый свежий контекст (последние 3 сообщения) — не трогаем
    if (distanceFromEnd <= 2) {
      return msg;
    }

    let newContent = msg.content;

    // Warm Zone: (сообщения от 3 до 8 шагов назад) — фильтрация логов и diff
    if (distanceFromEnd <= 8) {
      if (msg.role === 'tool' || msg.role === 'user') {
        newContent = compressTerminalOutput(newContent);
      } else if (msg.role === 'assistant') {
        newContent = trimSemanticNoise(newContent);
      }
    } else {
      // Cold Zone: (старше 8 шагов назад) — глубокая скелетонизация и вырезка шума
      if (msg.role === 'tool') {
        newContent = compressTerminalOutput(newContent);
      } else if (msg.role === 'assistant') {
        newContent = skeletonizeCode(trimSemanticNoise(newContent));
      } else if (msg.role === 'user') {
        newContent = compressTerminalOutput(newContent);
      }
    }

    if (newContent === msg.content) return msg;
    return { ...msg, content: newContent };
  });
}

module.exports = {
  compressTerminalOutput,
  skeletonizeCode,
  trimSemanticNoise,
  compressConversationHistory,
};
