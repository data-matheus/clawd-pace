'use strict';

const assert = require('assert');
const { computePace, windowPace } = require('../pace');

const H = 3600e3;
const now = Date.parse('2026-11-06T19:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('even pace is ok and lands at ~100%', () => {
  const p = windowPace('session', { util: 40, resetsAt: iso(now + 3 * H) }, [], now); // 2h of 5h elapsed
  assert.strictEqual(Math.round(p.expected), 40);
  assert.strictEqual(Math.round(p.projected), 100);
  assert.ok(['tight', 'over'].includes(p.state));
});

t('slow pace is ok, no ETA', () => {
  const p = windowPace('session', { util: 10, resetsAt: iso(now + 3 * H) }, [], now);
  assert.strictEqual(p.state, 'ok');
  assert.strictEqual(p.etaFull, null);
});

t('fast pace is over with ETA before reset', () => {
  const p = windowPace('session', { util: 60, resetsAt: iso(now + 3 * H) }, [], now);
  assert.strictEqual(p.state, 'over');
  assert.ok(p.etaFull > now && p.etaFull < now + 3 * H);
});

t('session uses recent rate: paused -> ok even if average is high', () => {
  const sr = now + 3 * H;
  const samples = [{ t: now - 20 * 60e3, s: 60, sr, w: 50, wr: now + 3 * 24 * H }];
  const p = windowPace('session', { util: 60, resetsAt: iso(sr) }, samples, now);
  assert.strictEqual(p.rate, 0);
  assert.strictEqual(p.state, 'ok');
});

t('samples from a previous window are ignored', () => {
  const samples = [{ t: now - 20 * 60e3, s: 95, sr: now - 10 * 60e3, w: 50, wr: now + 3 * 24 * H }];
  const p = windowPace('session', { util: 5, resetsAt: iso(now + 4.5 * H) }, samples, now);
  assert.strictEqual(p.recentH, null);
});

t('no reset time -> fresh', () => {
  const p = windowPace('session', { util: 0, resetsAt: null }, [], now);
  assert.strictEqual(p.state, 'fresh');
});

t('reset in the past -> fresh', () => {
  const p = windowPace('session', { util: 80, resetsAt: iso(now - 60e3) }, [], now);
  assert.strictEqual(p.state, 'fresh');
});

t('100% -> maxed', () => {
  const p = windowPace('week', { util: 100, resetsAt: iso(now + 24 * H) }, [], now);
  assert.strictEqual(p.state, 'maxed');
});

t('weekly budget per day', () => {
  const p = windowPace('week', { util: 70, resetsAt: iso(now + 3 * 24 * H) }, [], now);
  assert.strictEqual(Math.round(p.budget), 10); // 30% left over 3 days
});

t('mood is the worst of both windows', () => {
  const r = computePace({ session: { util: 5, resetsAt: iso(now + 4 * H) }, week: { util: 99.8, resetsAt: iso(now + 2 * 24 * H) } }, [], now);
  assert.strictEqual(r.mood, 'maxed');
});

t('missing plan does not throw', () => {
  const r = computePace(null, [], now);
  assert.strictEqual(r.mood, 'fresh');
});

console.log(`\n${n} tests passed`);
