#!/usr/bin/env node
'use strict';

// Claude Code statusLine command. Claude Code pipes session JSON on stdin after
// every response; when you're on a Pro/Max plan it includes
// rate_limits.five_hour / seven_day ({ used_percentage, resets_at }).
// We save those to a tiny local file the desktop pet watches (real-time, no
// network, no token) and print a compact status line back to Claude Code.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.claude', 'clawd-pace');
const FEED = path.join(DIR, 'feed.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw || '{}'); } catch { /* ignore */ }

  const rl = d.rate_limits || {};
  const win = (w) =>
    w && typeof w.used_percentage === 'number'
      ? { util: w.used_percentage, resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null }
      : null;
  const session = win(rl.five_hour);
  const week = win(rl.seven_day);

  if (session || week) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const tmp = FEED + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), session, week, source: 'statusline' }));
      fs.renameSync(tmp, FEED);
    } catch { /* never break the status line */ }
  }

  const parts = [];
  const model = d.model && d.model.display_name;
  if (model) parts.push(model);
  if (session) parts.push(`5h ${Math.round(session.util)}%`);
  if (week) parts.push(`7d ${Math.round(week.util)}%`);
  const ctx = d.context_window && d.context_window.used_percentage;
  if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);
  process.stdout.write(parts.join(' · '));
});
