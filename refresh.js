'use strict';

// Renews the Claude Code OAuth login while Claude Code itself is closed, so the
// Clawd keeps updating without VS Code open (e.g. right after the PC boots).
//
// Same request Claude Code makes (taken from its own binary): POST TOKEN_URL with
// { grant_type: 'refresh_token', refresh_token, client_id, scope }.
//
// Safety rules — refreshing rotates the refresh token, so:
//  1. only when NO Claude Code process is running (nobody holds the old token in
//     memory; when Claude Code starts later it reads the new one from disk);
//  2. only when the access token is expired or about to expire;
//  3. one refresh at a time (lock file), credentials re-read right before and
//     after the request, abort if anything else changed the file meanwhile;
//  4. backup + atomic write, every other field in the file preserved;
//  5. after a failure, wait 1h before trying again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TOKEN_URL = process.env.CLAWD_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const MARGIN_MS = 5 * 60e3;
const COOLDOWN_MS = 60 * 60e3;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Any Claude Code running? (native claude.exe from the VS Code extension / installer,
// or the npm CLI running under node.exe)
function claudeRunning() {
  if (process.platform !== 'win32') return Promise.resolve(true); // be conservative elsewhere
  const ps =
    "$n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match '@anthropic-ai[\\\\/]claude-code') }).Count; Write-Output $n";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000, windowsHide: true }, (err, out) => {
      if (err) return resolve(true); // can't tell -> don't touch the login
      resolve(parseInt(String(out).trim(), 10) !== 0);
    });
  });
}

function createRefresher({ credFile, lockFile, logFile, isClaudeRunning = claudeRunning, fetchImpl = fetch }) {
  let lastFailure = 0;
  const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* ignore */ } };

  function needsRefresh(now = Date.now()) {
    try {
      const o = readJson(credFile).claudeAiOauth;
      return !!(o && o.refreshToken && (!o.expiresAt || o.expiresAt - now < MARGIN_MS));
    } catch {
      return false;
    }
  }

  function takeLock() {
    try {
      const st = fs.statSync(lockFile);
      if (Date.now() - st.mtimeMs > 2 * 60e3) fs.unlinkSync(lockFile); // stale
    } catch { /* no lock */ }
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  // -> 'ok' | 'not-needed' | 'claude-running' | 'cooldown' | 'busy' | 'failed:<why>'
  async function refresh(now = Date.now()) {
    if (!needsRefresh(now)) return 'not-needed';
    if (now - lastFailure < COOLDOWN_MS) return 'cooldown';
    if (await isClaudeRunning()) return 'claude-running';
    if (!takeLock()) return 'busy';
    try {
      const before = readJson(credFile);
      const o = before.claudeAiOauth;
      if (!o || !o.refreshToken) return 'not-needed';
      const scopes = Array.isArray(o.scopes) && o.scopes.length ? o.scopes : ['user:inference', 'user:profile'];

      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID, scope: scopes.join(' ') }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.status !== 200) {
        lastFailure = Date.now();
        log(`refresh failed http ${res.status}`);
        return `failed:http-${res.status}`;
      }
      const d = await res.json();
      if (!d || typeof d.access_token !== 'string' || typeof d.expires_in !== 'number') {
        lastFailure = Date.now();
        log('refresh failed: malformed response');
        return 'failed:malformed';
      }

      // Something else (Claude Code started?) rewrote the login meanwhile -> keep theirs.
      const current = readJson(credFile);
      if (!current.claudeAiOauth || current.claudeAiOauth.refreshToken !== o.refreshToken) {
        log('credentials changed during refresh; kept the other writer');
        return 'failed:raced';
      }

      const next = {
        ...current,
        claudeAiOauth: {
          ...current.claudeAiOauth,
          accessToken: d.access_token,
          refreshToken: d.refresh_token || o.refreshToken,
          expiresAt: Date.now() + d.expires_in * 1000,
          ...(typeof d.refresh_token_expires_in === 'number' ? { refreshTokenExpiresAt: Date.now() + d.refresh_token_expires_in * 1000 } : {}),
          ...(typeof d.scope === 'string' && d.scope.trim() ? { scopes: d.scope.trim().split(/\s+/) } : {}),
        },
      };
      fs.copyFileSync(credFile, credFile + '.clawd-bak');
      const tmp = credFile + '.clawd-tmp';
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, credFile);
      log(`refreshed; new token valid until ${new Date(next.claudeAiOauth.expiresAt).toISOString()}`);
      return 'ok';
    } catch (e) {
      lastFailure = Date.now();
      log(`refresh error: ${(e && e.message) || e}`);
      return 'failed:error';
    } finally {
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }

  return { refresh, needsRefresh };
}

const DEFAULT_CRED = path.join(os.homedir(), '.claude', '.credentials.json');

module.exports = { createRefresher, claudeRunning, DEFAULT_CRED, TOKEN_URL, CLIENT_ID };
