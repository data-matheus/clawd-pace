'use strict';

// Pace engine: turns "X% used, resets at T" into "am I burning too fast?".
// Pure functions (no Electron) so they can be tested with plain node.

const H = 3600e3;
const WINDOWS = {
  session: { len: 5 * H, lookback: 30 * 60e3, minSpan: 8 * 60e3 }, // 5h rolling session
  week: { len: 7 * 24 * H, lookback: 24 * H, minSpan: 3 * H }, // weekly limit
};

const RANK = { fresh: 0, ok: 1, tight: 2, over: 3, maxed: 4 };

// Burn rate (% per ms) from history samples that belong to the same window.
// samples: [{ t, s, sr, w, wr }] (s/w = util, sr/wr = resetsAt ms)
function recentRate(kind, samples, now, util, resetsAt) {
  const cfg = WINDOWS[kind];
  const k = kind === 'session' ? 's' : 'w';
  const rk = kind === 'session' ? 'sr' : 'wr';
  let old = null;
  for (const p of samples || []) {
    if (p[rk] == null || Math.abs(p[rk] - resetsAt) > 5 * 60e3) continue; // other window
    if (p.t < now - cfg.lookback || p.t > now - cfg.minSpan) continue;
    if (!old || p.t < old.t) old = p;
  }
  if (!old) return null;
  return Math.max(0, (util - old[k]) / (now - old.t));
}

// One window -> everything the UI needs.
function windowPace(kind, info, samples, now = Date.now()) {
  const cfg = WINDOWS[kind];
  const util = info && typeof info.util === 'number' ? info.util : 0;
  const resetsAt = info && info.resetsAt ? new Date(info.resetsAt).getTime() : null;

  // No active window (e.g. the 5h session only starts with your next message).
  if (!resetsAt || resetsAt <= now) {
    return { kind, state: 'fresh', util: 0, expected: 0, resetsAt: null, left: 0, frac: 0 };
  }

  const left = resetsAt - now;
  const elapsed = Math.max(0, cfg.len - left);
  const frac = Math.min(1, elapsed / cfg.len);
  const expected = frac * 100; // where a perfectly even pace would be now

  const avgRate = elapsed > 60e3 ? util / elapsed : 0;
  const recent = recentRate(kind, samples, now, util, resetsAt);
  // Session: what you're doing *now* matters most (stop typing -> you won't hit it).
  // Week: the average since the window started is the honest pace.
  const rate = kind === 'session' && recent != null ? recent : avgRate;

  const projected = util + rate * left; // % at reset if this rate holds
  const etaFull = rate > 0 && util < 100 ? now + (100 - util) / rate : null;
  const hitsBeforeReset = etaFull != null && etaFull < resetsAt;

  let state;
  if (util >= 99.5) state = 'maxed';
  else if (projected >= 100) state = 'over';
  else if (projected >= 85) state = 'tight';
  else state = 'ok';

  // Spendable budget from now on to land exactly at 100% on reset.
  const perUnit = kind === 'session' ? H : 24 * H;
  const budget = Math.max(0, (100 - util) / Math.max(left / perUnit, 1e-6)); // %/h or %/day

  return {
    kind,
    state,
    util,
    expected,
    delta: util - expected, // + = ahead of pace (spending faster than even)
    resetsAt,
    left,
    frac,
    rate, // %/ms used for projection
    rateH: rate * H, // %/h
    recentH: recent != null ? recent * H : null,
    avgH: avgRate * H,
    projected,
    etaFull: hitsBeforeReset ? etaFull : null,
    budget, // %/h (session) or %/day (week)
  };
}

function worst(...states) {
  return states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'fresh');
}

function computePace(plan, samples, now = Date.now()) {
  const session = windowPace('session', plan && plan.session, samples, now);
  const week = windowPace('week', plan && plan.week, samples, now);
  return { session, week, mood: worst(session.state, week.state), now };
}

module.exports = { computePace, windowPace, worst, WINDOWS, RANK };
