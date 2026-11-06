'use strict';

// Reads your REAL plan limits the same way Claude Code's `/usage` does: takes the
// Claude Code OAuth access token from ~/.claude/.credentials.json and calls the
// usage endpoint on api.anthropic.com. Read-only and local:
//  - the token is only sent to api.anthropic.com, never logged or stored;
//  - we NEVER refresh the token ourselves (rotating it would log Claude Code
//    out). When it expires we wait until Claude Code refreshes it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE = 'https://api.anthropic.com/api/oauth/profile';
const CRED_FILES = [
  path.join(os.homedir(), '.claude', '.credentials.json'),
  path.join(os.homedir(), '.claude', 'credentials.json'),
];

function readCreds() {
  for (const p of CRED_FILES) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const o = j.claudeAiOauth || j;
      if (o.accessToken) return { token: o.accessToken, expiresAt: o.expiresAt || null, tier: o.rateLimitTier || '' };
    } catch { /* next */ }
  }
  return null;
}

function planNameFromTier(tier) {
  const t = String(tier || '');
  const mult = (t.match(/(\d+)x/) || [])[1];
  if (/max/i.test(t)) return mult ? `Max ${mult}x` : 'Max';
  if (/pro/i.test(t)) return 'Pro';
  if (/team/i.test(t)) return 'Team';
  if (/enterprise/i.test(t)) return 'Enterprise';
  return null;
}

const pick = (o) =>
  o && typeof o.utilization === 'number' ? { util: o.utilization, resetsAt: o.resets_at || null } : null;

// -> { ok:true, plan } | { ok:false, error: 'no-token'|'expired'|'http-429'|... }
async function fetchLimits() {
  const creds = readCreds();
  if (!creds) return { ok: false, error: 'no-token' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { ok: false, error: 'expired' };

  const headers = { Authorization: 'Bearer ' + creds.token, 'anthropic-beta': 'oauth-2025-04-20' };
  try {
    const res = await fetch(USAGE, { headers, signal: AbortSignal.timeout(12000) });
    if (res.status === 401) return { ok: false, error: 'expired' };
    if (!res.ok) return { ok: false, error: 'http-' + res.status };
    const j = await res.json();

    // Per-model weekly caps (e.g. a separate Fable allowance), when present.
    const scoped = (Array.isArray(j.limits) ? j.limits : [])
      .filter((l) => l && l.kind === 'weekly_scoped' && l.scope && l.scope.model)
      .map((l) => ({
        name: l.scope.model.display_name || l.scope.model.id || 'modelo',
        util: typeof l.percent === 'number' ? l.percent : 0,
        resetsAt: l.resets_at || null,
      }));

    const bd = j.seven_day_breakdown;
    const breakdown =
      bd && Array.isArray(bd.rows)
        ? bd.rows.filter((r) => typeof r.percent === 'number').map((r) => ({ name: r.display_name || r.key, pct: r.percent }))
        : null;

    const eu = j.extra_usage;
    const extra = eu && eu.is_enabled ? { util: eu.utilization, used: eu.used_credits, limit: eu.monthly_limit, currency: eu.currency || '' } : null;

    return {
      ok: true,
      plan: {
        session: pick(j.five_hour) || { util: 0, resetsAt: null },
        week: pick(j.seven_day) || { util: 0, resetsAt: null },
        weekOpus: pick(j.seven_day_opus),
        weekSonnet: pick(j.seven_day_sonnet),
        scoped,
        breakdown,
        extra,
        planName: planNameFromTier(creds.tier),
        fetchedAt: Date.now(),
        source: 'api',
      },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.name === 'TimeoutError' ? 'timeout' : e && e.message) || e) };
  }
}

module.exports = { fetchLimits, readCreds, CRED_FILES, USAGE, PROFILE };
