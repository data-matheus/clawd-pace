'use strict';

// Exercises refresh.js against a fake token server and a throwaway credentials
// file. Never touches the real ~/.claude login.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-refresh-'));
  const credFile = path.join(dir, '.credentials.json');
  const lockFile = path.join(dir, 'refresh.lock');
  const logFile = path.join(dir, 'auth.log');
  let lastBody = null;
  let reply = { status: 200, body: { access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 28800, refresh_token_expires_in: 2592000, scope: 'user:inference user:profile' } };

  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      lastBody = { method: req.method, type: req.headers['content-type'], json: JSON.parse(b || '{}') };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.CLAWD_TOKEN_URL = `http://127.0.0.1:${server.address().port}/v1/oauth/token`;
  delete require.cache[require.resolve('../refresh')];
  const { createRefresher, CLIENT_ID } = require('../refresh');

  const writeCreds = (expiresAt, rt = 'OLD_RT') =>
    fs.writeFileSync(credFile, JSON.stringify({
      claudeAiOauth: { accessToken: 'OLD_AT', refreshToken: rt, expiresAt, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
      somethingElse: { keep: true },
    }));

  let running = false;
  const mk = () => createRefresher({ credFile, lockFile, logFile, isClaudeRunning: async () => running });
  let n = 0;
  const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

  await t('valid token -> not-needed, no request', async () => {
    writeCreds(Date.now() + 3600e3);
    lastBody = null;
    assert.strictEqual(await mk().refresh(), 'not-needed');
    assert.strictEqual(lastBody, null);
  });

  await t('expired but Claude Code open -> untouched', async () => {
    writeCreds(Date.now() - 1000);
    running = true;
    lastBody = null;
    assert.strictEqual(await mk().refresh(), 'claude-running');
    assert.strictEqual(lastBody, null);
    assert.strictEqual(JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth.accessToken, 'OLD_AT');
    running = false;
  });

  await t('expired + Claude closed -> refreshes like Claude Code does', async () => {
    writeCreds(Date.now() - 1000);
    assert.strictEqual(await mk().refresh(), 'ok');
    assert.strictEqual(lastBody.method, 'POST');
    assert.strictEqual(lastBody.type, 'application/json');
    assert.deepStrictEqual(lastBody.json, { grant_type: 'refresh_token', refresh_token: 'OLD_RT', client_id: CLIENT_ID, scope: 'user:inference user:profile user:sessions:claude_code' });
    const j = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    assert.strictEqual(j.claudeAiOauth.accessToken, 'NEW_AT');
    assert.strictEqual(j.claudeAiOauth.refreshToken, 'NEW_RT');
    assert.ok(j.claudeAiOauth.expiresAt > Date.now() + 7 * 3600e3);
    assert.strictEqual(j.claudeAiOauth.subscriptionType, 'max'); // other fields kept
    assert.deepStrictEqual(j.somethingElse, { keep: true });
    assert.strictEqual(JSON.parse(fs.readFileSync(credFile + '.clawd-bak', 'utf8')).claudeAiOauth.accessToken, 'OLD_AT');
    assert.ok(!fs.existsSync(lockFile));
  });

  await t('server error -> file untouched, then 1h cooldown', async () => {
    writeCreds(Date.now() - 1000);
    reply = { status: 400, body: { error: 'invalid_grant' } };
    const r = mk();
    assert.strictEqual(await r.refresh(), 'failed:http-400');
    assert.strictEqual(JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth.accessToken, 'OLD_AT');
    lastBody = null;
    assert.strictEqual(await r.refresh(), 'cooldown');
    assert.strictEqual(lastBody, null);
  });

  await t('malformed response -> file untouched', async () => {
    writeCreds(Date.now() - 1000);
    reply = { status: 200, body: { nope: 1 } };
    assert.strictEqual(await mk().refresh(), 'failed:malformed');
    assert.strictEqual(JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth.accessToken, 'OLD_AT');
  });

  await t('another refresh in progress (lock) -> busy', async () => {
    writeCreds(Date.now() - 1000);
    fs.writeFileSync(lockFile, '1');
    assert.strictEqual(await mk().refresh(), 'busy');
    fs.unlinkSync(lockFile);
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
