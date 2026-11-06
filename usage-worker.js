'use strict';

// Worker thread: owns the log scanner so heavy parsing never blocks the UI.
const { parentPort, workerData } = require('worker_threads');
const { createScanner } = require('./usage');

const scanner = createScanner(workerData.cacheFile);

parentPort.on('message', (msg) => {
  if (msg !== 'scan') return;
  try {
    parentPort.postMessage({ ok: true, data: scanner.scan() });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
});
