'use strict';

const { generateCookies } = require('./cookie-generator');
const { logger } = require('./util');

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 min

let currentCookies = { ssxmod_itna: '', ssxmod_itna2: '', timestamp: 0 };
let timer = null;
let ready = false;

function refreshCookies() {
  try {
    const result = generateCookies();
    currentCookies = {
      ssxmod_itna: result.ssxmod_itna,
      ssxmod_itna2: result.ssxmod_itna2,
      timestamp: result.timestamp,
    };
    ready = true;
    if (!timer) logger.info('SSXMOD cookies generated', 'SSXMOD');
  } catch (err) {
    logger.error(`SSXMOD cookie generation failed: ${err.message}`, 'SSXMOD', err);
  }
}

function init() {
  refreshCookies();
  if (timer) clearInterval(timer);
  timer = setInterval(refreshCookies, REFRESH_INTERVAL);
  timer.unref && timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const getSsxmodItna = () => currentCookies.ssxmod_itna;
const getSsxmodItna2 = () => currentCookies.ssxmod_itna2;
const isReady = () => ready;

module.exports = { init, stop, refreshCookies, getSsxmodItna, getSsxmodItna2, isReady };

if (require.main === module) {
  init();
  console.log('itna :', getSsxmodItna().slice(0, 70) + '…');
  console.log('itna2:', getSsxmodItna2().slice(0, 70) + '…');
  process.exit(0);
}