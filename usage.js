'use strict';

// Local activity stats from Claude Code's own session logs
// (~/.claude/projects/**/*.jsonl). Runs inside a worker thread (usage-worker.js)
// so a big first scan never freezes the pet.
//
// Incremental: logs are append-only, so each file remembers the byte offset it
// was parsed up to and only the new bytes are read on the next scan. The
// per-file aggregates are persisted, so a reboot doesn't re-read gigabytes.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CACHE_VERSION = 3;
const CHUNK = 4 * 1024 * 1024;

// Public API prices, USD per million tokens: [input, output, cacheRead].
// Cache writes: 1.25x input (5 min) / 2x input (1 h). On a subscription you
// don't pay this — it's the "what this would cost on the API" value.
const PRICES = [
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-5|opus-4-[5-9]/, [5, 25, 0.5]],
  [/opus/, [15, 75, 1.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5/, [0.1, 0.5, 0.01]],
  [/haiku/, [1, 5, 0.1]],
];
const DEFAULT_PRICE = [3, 15, 0.3];
const priceCache = new Map();
function priceFor(model) {
  if (!priceCache.has(model)) {
    const m = String(model);
    const hit = m === '<synthetic>' ? [0, 0, 0] : (PRICES.find(([re]) => re.test(m)) || [null, DEFAULT_PRICE])[1];
    priceCache.set(model, hit);
  }
  return priceCache.get(model);
}

function msgCost(model, u) {
  const [pin, pout, pcr] = priceFor(model);
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation_input_tokens || 0;
  const c1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  const c5m = Math.max(0, cc - c1h);
  return (inp * pin + out * pout + cr * pcr + c5m * pin * 1.25 + c1h * pin * 2) / 1e6;
}

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function listJsonl(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function emptyEntry() {
  return { offset: 0, size: 0, mtime: 0, ids: [], cwd: null, last: 0, days: {} };
}

// Parse bytes [entry.offset, size) of a file into entry (mutates).
function parseIncrement(fp, entry, size) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return; }
  const ids = new Set(entry.ids);
  const recent = entry.ids.slice();
  let pos = entry.offset;
  let carry = '';
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      carry = lines.pop(); // incomplete last line -> next chunk / next scan
      for (const line of lines) handleLine(line, entry, ids, recent);
    }
  } finally {
    fs.closeSync(fd);
  }
  // Only advance past complete lines; a half-written last line is re-read later.
  entry.offset = pos - Buffer.byteLength(carry, 'utf8');
  entry.ids = recent.slice(-64);
}

function handleLine(line, entry, ids, recent) {
  if (!line || line.indexOf('"usage"') === -1) {
    if (!entry.cwd && line && line.indexOf('"cwd"') !== -1) {
      try { const o = JSON.parse(line); if (typeof o.cwd === 'string') entry.cwd = o.cwd; } catch { /* skip */ }
    }
    return;
  }
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!entry.cwd && typeof obj.cwd === 'string') entry.cwd = obj.cwd;
  const msg = obj && obj.message;
  const u = msg && msg.usage;
  if (!u || typeof u !== 'object') return;
  const id = msg.id && (msg.id + ':' + (obj.requestId || ''));
  if (id) {
    if (ids.has(id)) return; // same message streamed over several lines
    ids.add(id);
    recent.push(id);
  }
  const model = msg.model || 'unknown';
  if (model === '<synthetic>') return;
  const ts = obj.timestamp ? new Date(obj.timestamp) : null;
  if (!ts || isNaN(ts)) return;
  const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const cost = msgCost(model, u);
  const day = localDay(ts);
  const d = entry.days[day] || (entry.days[day] = { m: 0, t: 0, o: 0, c: 0, h: new Array(24).fill(0), mod: {} });
  d.m += 1;
  d.t += tok;
  d.o += u.output_tokens || 0;
  d.c += cost;
  d.h[ts.getHours()] += 1;
  d.mod[model] = (d.mod[model] || 0) + cost;
  const t = ts.getTime();
  if (t > entry.last) entry.last = t;
}

function createScanner(cacheFile) {
  let cache = {};
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j && j.v === CACHE_VERSION) cache = j.files || {};
  } catch { /* first run */ }

  function save() {
    try {
      fs.writeFileSync(cacheFile + '.tmp', JSON.stringify({ v: CACHE_VERSION, files: cache }));
      fs.renameSync(cacheFile + '.tmp', cacheFile);
    } catch { /* ignore */ }
  }

  function scan() {
    const t0 = Date.now();
    const files = listJsonl(PROJECTS_DIR);
    const seen = new Set(files);
    let changed = false;
    for (const k of Object.keys(cache)) if (!seen.has(k)) { delete cache[k]; changed = true; }

    for (const fp of files) {
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      let e = cache[fp];
      if (e && e.size === st.size && e.mtime === st.mtimeMs) continue;
      if (!e || st.size < e.offset) e = cache[fp] = emptyEntry(); // new or rewritten
      parseIncrement(fp, e, st.size);
      e.size = st.size;
      e.mtime = st.mtimeMs;
      changed = true;
    }
    if (changed) save();
    return summarize(files.length, Date.now() - t0);
  }

  function summarize(fileCount, scanMs) {
    const now = new Date();
    const dayKey = (back) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    const keys7 = Array.from({ length: 7 }, (_, i) => dayKey(6 - i)); // oldest -> today
    const set7 = new Set(keys7);
    const set30 = new Set(Array.from({ length: 30 }, (_, i) => dayKey(i)));

    const zero = () => ({ m: 0, t: 0, o: 0, c: 0 });
    const add = (a, d) => { a.m += d.m; a.t += d.t; a.o += d.o; a.c += d.c; };
    const byDay = {};
    const all = zero();
    const week = zero();
    const last30 = zero();
    const hours7 = new Array(24).fill(0);
    const models7 = {};
    const projects7 = {};
    let lastActivity = 0;

    for (const e of Object.values(cache)) {
      if (e.last > lastActivity) lastActivity = e.last;
      const proj = e.cwd ? e.cwd.split(/[\\/]/).filter(Boolean).pop() : null;
      for (const [day, d] of Object.entries(e.days)) {
        add(all, d);
        const bd = byDay[day] || (byDay[day] = zero());
        add(bd, d);
        if (set30.has(day)) add(last30, d);
        if (set7.has(day)) {
          add(week, d);
          for (let h = 0; h < 24; h++) hours7[h] += d.h[h];
          for (const [m, c] of Object.entries(d.mod)) models7[m] = (models7[m] || 0) + c;
          if (proj) projects7[proj] = (projects7[proj] || 0) + d.c;
        }
      }
    }

    const today = byDay[dayKey(0)] || zero();
    const todayHours = new Array(24).fill(0);
    for (const e of Object.values(cache)) {
      const d = e.days[dayKey(0)];
      if (d) for (let h = 0; h < 24; h++) todayHours[h] += d.h[h];
    }

    let streak = 0;
    for (let i = today.m > 0 ? 0 : 1; i < 400; i++) {
      if (byDay[dayKey(i)] && byDay[dayKey(i)].m > 0) streak++;
      else break;
    }
    const activeDays30 = [...set30].filter((k) => byDay[k] && byDay[k].m > 0).length;
    const prettyModel = (m) => m.replace(/^claude-/, '').replace(/^./, (c) => c.toUpperCase()).replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1');
    const modelsWeek = Object.entries(models7)
      .map(([name, c]) => ({ name: prettyModel(name), c }))
      .sort((a, b) => b.c - a.c);
    const topProject = Object.entries(projects7).sort((a, b) => b[1] - a[1])[0] || null;

    return {
      today,
      todayHours,
      week,
      last30,
      all,
      allDays: Object.keys(byDay).length,
      last7: keys7.map((k) => ({ day: k, dow: new Date(k + 'T12:00:00').getDay(), ...(byDay[k] || zero()) })),
      hours7,
      modelsWeek,
      topProject: topProject ? { name: topProject[0], c: topProject[1] } : null,
      activeDays30,
      streak,
      lastActivity,
      files: fileCount,
      scanMs,
      updatedAt: Date.now(),
    };
  }

  return { scan };
}

module.exports = { createScanner, PROJECTS_DIR, msgCost, priceFor };
