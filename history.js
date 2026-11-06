'use strict';

// Tiny persisted time series of plan utilisation, used for burn-rate and the
// sparklines in the panel. One sample per change (or every 10 min), 8 days kept.

const fs = require('fs');

const KEEP_MS = 8 * 24 * 3600e3;
const HEARTBEAT_MS = 10 * 60e3;

function createHistory(file) {
  let samples = [];
  let dirty = false;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j)) samples = j;
  } catch { /* first run */ }

  const ms = (iso) => (iso ? new Date(iso).getTime() : null);

  function add(plan, t = Date.now()) {
    if (!plan || !plan.session || !plan.week) return;
    const s = {
      t,
      s: plan.session.util,
      sr: ms(plan.session.resetsAt),
      w: plan.week.util,
      wr: ms(plan.week.resetsAt),
    };
    const last = samples[samples.length - 1];
    const same = last && last.s === s.s && last.w === s.w && last.sr === s.sr && last.wr === s.wr;
    if (same && t - last.t < HEARTBEAT_MS) return;
    samples.push(s);
    const cut = t - KEEP_MS;
    while (samples.length && samples[0].t < cut) samples.shift();
    dirty = true;
  }

  function save() {
    if (!dirty) return;
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(samples));
      fs.renameSync(file + '.tmp', file);
      dirty = false;
    } catch { /* ignore */ }
  }

  return { add, save, all: () => samples };
}

module.exports = { createHistory };
