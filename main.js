'use strict';

// Clawd Pace — a desktop Clawd that shows, at a glance, how fast you're burning
// your Claude plan (5h session + weekly). Fork of plugin87/claude-usage-pet (MIT).

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, Notification, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { fetchLimits, CRED_FILES } = require('./limits');
const { computePace } = require('./pace');
const { createHistory } = require('./history');
const { PROJECTS_DIR } = require('./usage');
const { trayIcon } = require('./trayicon');
const { DEFAULT_COLOR, normHex } = require('./color');
const { createRefresher, DEFAULT_CRED } = require('./refresh');

const APP_ID = 'com.matheus.clawdpace';
const APP_NAME = 'Clawd Pace';
const FEED_DIR = path.join(os.homedir(), '.claude', 'clawd-pace');
const FEED_FILE = path.join(FEED_DIR, 'feed.json');

const POLL_MS = 5 * 60e3; // background refresh of plan limits
const ACTIVITY_GAP_MS = 90e3; // min gap between refreshes triggered by Claude Code activity
const SCAN_MS = 2 * 60e3; // local log scan
const WORKING_MS = 120e3; // "Claude is working" if logs changed this recently
const AWAY_S = 600; // OS idle seconds -> Clawd naps

const PET_W = 180;
const PET_H = 150;
const SNAP = process.env.CLAWD_SNAP || ''; // dev only: write PNG captures of the windows to this folder
const TEST = !!process.env.CLAWD_TEST; // dev only: Clawd stands still + logs input events
const dlog = (m) => { if (SNAP) try { fs.appendFileSync(path.join(SNAP, 'events.log'), `${new Date().toISOString()} ${m}
`); } catch { /* ignore */ } };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  start();
}

function start() {
  const dataDir = app.getPath('userData');
  const file = (n) => path.join(dataDir, n);

  // ---------------- settings ----------------
  const settings = { walk: true, hud: 'always', size: 'm', notify: true, autostart: true, installed: false, pos: null, color: null, autoLogin: true };
  try { Object.assign(settings, JSON.parse(fs.readFileSync(file('settings.json'), 'utf8'))); } catch { /* defaults */ }
  settings.color = normHex(settings.color); // ignore a hand-edited invalid value
  const clawdColor = () => settings.color || DEFAULT_COLOR;
  const saveSettings = () => { try { fs.writeFileSync(file('settings.json'), JSON.stringify(settings, null, 1)); } catch { /* ignore */ } };

  // ---------------- state ----------------
  let plan = null; // last good plan limits
  let planErr = null;
  let lastFetch = 0;
  let notified = {}; // which alerts already fired (per window)
  try {
    const last = JSON.parse(fs.readFileSync(file('last.json'), 'utf8'));
    plan = last.plan || null;
    notified = last.notified || {};
  } catch { /* first run */ }
  const saveLast = () => { try { fs.writeFileSync(file('last.json'), JSON.stringify({ plan, notified })); } catch { /* ignore */ } };

  const history = createHistory(file('history.json'));
  let usage = null;
  let lastActivityTs = 0;
  let pace = computePace(plan, history.all());

  let win = null;
  let panel = null;
  let settingsWin = null;
  let panelClosedAt = 0;
  let tray = null;

  // ---------------- formatting (pt-BR) ----------------
  const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return hhmm(d);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `amanhã ${hhmm(d)}`;
    return `${DOW[d.getDay()]} ${hhmm(d)}`;
  }
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60e3));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }
  const pct = (v) => `${Math.round(v)}%`;

  // One short line for hover + tray: the most useful thing to know right now.
  function headline(p) {
    if (!p) return '';
    const s = p.session;
    const w = p.week;
    if (s.state === 'maxed') return `Sessão esgotada · volta ${when(s.resetsAt)}`;
    if (w.state === 'maxed') return `Semana esgotada · volta ${when(w.resetsAt)}`;
    if (s.state === 'over' && s.etaFull) return `5h acaba ~${when(s.etaFull)} (reset ${when(s.resetsAt)})`;
    if (w.state === 'over' && w.etaFull) return `Semana acaba ~${when(w.etaFull)} · use ~${Math.round(w.budget)}%/dia`;
    if (s.state === 'fresh') return `Sessão livre · semana ~${Math.round(w.budget)}%/dia`;
    return `5h reseta ${when(s.resetsAt)} · semana ~${Math.round(w.budget)}%/dia`;
  }

  // ---------------- behaviour (what Clawd is doing) ----------------
  function behavior() {
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch { /* ignore */ }
    if (idle > AWAY_S) return 'sleep';
    if (pace.mood === 'maxed') return 'ko';
    if (pace.mood === 'over') return 'anxious';
    if (Date.now() - lastActivityTs < WORKING_MS) return 'busy';
    return 'calm';
  }

  const stale = () => !plan || Date.now() - (plan.fetchedAt || 0) > 20 * 60e3;

  function petState() {
    const view = (x) => ({ state: x.state, util: x.util, expected: x.expected });
    return {
      hasData: !!plan,
      session: view(pace.session),
      week: view(pace.week),
      mood: pace.mood,
      behavior: behavior(),
      headline: plan ? headline(pace) : planErr === 'no-token' ? 'Faça login no Claude Code' : 'Carregando…',
      err: planErr,
      authNote,
      stale: stale(),
      hud: settings.hud,
      size: settings.size,
      color: clawdColor(),
    };
  }

  function panelState() {
    const sr = pace.session.resetsAt;
    const wr = pace.week.resetsAt;
    const all = history.all();
    return {
      plan,
      pace,
      planErr,
      authNote,
      stale: stale(),
      lastFetch,
      usage,
      working: Date.now() - lastActivityTs < WORKING_MS,
      headline: headline(pace),
      color: clawdColor(),
      sessionSeries: sr ? all.filter((p) => p.sr && Math.abs(p.sr - sr) < 5 * 60e3).map((p) => [p.t, p.s]) : [],
      weekSeries: wr ? all.filter((p) => p.wr && Math.abs(p.wr - wr) < 5 * 60e3).map((p) => [p.t, p.w]) : [],
      labels: {
        sessionReset: sr ? when(sr) : null,
        sessionLeft: sr ? dur(sr - Date.now()) : null,
        sessionEta: pace.session.etaFull ? when(pace.session.etaFull) : null,
        sessionEtaGap: pace.session.etaFull ? dur(sr - pace.session.etaFull) : null,
        weekReset: wr ? when(wr) : null,
        weekLeft: wr ? dur(wr - Date.now()) : null,
        weekEta: pace.week.etaFull ? when(pace.week.etaFull) : null,
        weekEtaGap: pace.week.etaFull ? dur(wr - pace.week.etaFull) : null,
      },
    };
  }

  let lastPetJson = '';
  function pushState(force) {
    pace = computePace(plan, history.all());
    const ps = petState();
    const j = JSON.stringify(ps);
    if (win && !win.isDestroyed() && (force || j !== lastPetJson)) win.webContents.send('pet-state', ps);
    lastPetJson = j;
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel-state', panelState());
    refreshTray();
    checkAlerts();
  }

  // ---------------- alerts ----------------
  function notify(title, body) {
    if (!settings.notify || !Notification.isSupported()) return;
    try { new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png'), silent: false }).show(); } catch { /* ignore */ }
  }
  function petEvent(type) {
    if (win && !win.isDestroyed()) win.webContents.send('pet-event', type);
  }
  let prevSession = null; // { resetsAt, util } to detect resets by time
  function checkAlerts() {
    if (!plan) return;
    const s = pace.session;
    const w = pace.week;
    let dirty = false;
    const once = (key, id, fn) => { if (notified[key] !== id) { notified[key] = id; dirty = true; fn(); } };

    if (s.state === 'over' && s.etaFull) once('sessOver', s.resetsAt, () => notify('Ritmo alto na sessão de 5h', `No ritmo atual o limite acaba ~${when(s.etaFull)} — o reset é só às ${when(s.resetsAt)}.`));
    if (s.util >= 90 && s.resetsAt) once('sess90', s.resetsAt, () => notify(`Sessão em ${pct(s.util)}`, `Reset às ${when(s.resetsAt)} (${dur(s.resetsAt - Date.now())}).`));
    const today = new Date().toDateString();
    if (w.state === 'over' && w.etaFull) once('weekOver', today, () => notify('Semana acima do ritmo', `No ritmo atual você bate 100% ${when(w.etaFull)}, antes do reset (${when(w.resetsAt)}). Pra durar: ~${Math.round(w.budget)}%/dia.`));
    if (w.util >= 90 && w.resetsAt) once('week90', w.resetsAt, () => notify(`Semana em ${pct(w.util)}`, `Reset ${when(w.resetsAt)}.`));

    // Session reset (detected by time, no fetch needed) -> celebrate.
    if (prevSession && prevSession.resetsAt && Date.now() >= prevSession.resetsAt && prevSession.util >= 25) {
      once('sessReset', prevSession.resetsAt, () => {
        notify('Sessão renovada', '100% da sessão de 5h disponível de novo.');
        petEvent('celebrate');
      });
    }
    prevSession = s.resetsAt ? { resetsAt: s.resetsAt, util: s.util } : prevSession && Date.now() < prevSession.resetsAt ? prevSession : null;
    if (dirty) saveLast();
  }

  // ---------------- plan limits: API + statusline feed ----------------
  let inflight = false;
  let backoffMs = 0;
  let backoffUntil = 0;
  let activityTimer = null;

  function applyPlan(p) {
    plan = p;
    history.add(plan);
    history.save();
    saveLast();
    pushState();
  }

  // Keeps the login alive while Claude Code is closed (see refresh.js for the safety rules).
  const refresher = createRefresher({ credFile: DEFAULT_CRED, lockFile: path.join(FEED_DIR, 'refresh.lock'), logFile: file('auth.log') });
  let authNote = null; // why we couldn't renew, for the UI
  async function renewLogin() {
    if (!settings.autoLogin) return false;
    const r = await refresher.refresh();
    authNote = r === 'claude-running' ? 'claude-open' : r.startsWith('failed') ? 'renew-failed' : null;
    return r === 'ok';
  }

  async function refreshLimits(reason) {
    if (inflight) return;
    if (reason !== 'manual' && Date.now() < backoffUntil) return;
    inflight = true;
    let r;
    try {
      if (refresher.needsRefresh()) await renewLogin(); // token about to expire and Claude Code closed
      r = await fetchLimits();
      if (!r.ok && r.error === 'expired' && (await renewLogin())) r = await fetchLimits();
    } finally { inflight = false; }
    lastFetch = Date.now();
    if (r.ok) {
      planErr = null;
      authNote = null;
      backoffMs = 0;
      applyPlan(r.plan);
    } else {
      planErr = r.error;
      if (r.error === 'http-429') {
        backoffMs = Math.min(Math.max(backoffMs * 2, 5 * 60e3), 30 * 60e3);
        backoffUntil = Date.now() + backoffMs;
      }
      pushState();
    }
  }

  function scheduleActivityRefresh() {
    if (activityTimer) return;
    const wait = Math.max(4000, lastFetch + ACTIVITY_GAP_MS - Date.now());
    activityTimer = setTimeout(() => { activityTimer = null; refreshLimits('activity'); }, wait);
  }

  function readFeed() {
    try {
      const f = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8'));
      if (!f || !f.ts || Date.now() - f.ts > 10 * 60e3) return;
      if (plan && plan.fetchedAt >= f.ts) return;
      applyPlan({ ...(plan || {}), session: f.session || (plan && plan.session), week: f.week || (plan && plan.week), fetchedAt: f.ts, source: 'statusline' });
    } catch { /* ignore */ }
  }

  // ---------------- local logs (worker thread) ----------------
  let worker = null;
  let scanBusy = false;
  let scanTimer = null;
  function startWorker() {
    worker = new Worker(path.join(__dirname, 'usage-worker.js'), { workerData: { cacheFile: file('usage-cache.json') } });
    worker.on('message', (m) => {
      scanBusy = false;
      if (m && m.ok) {
        usage = m.data;
        if (usage.lastActivity > lastActivityTs && Date.now() - usage.lastActivity < WORKING_MS) lastActivityTs = usage.lastActivity;
        if (panel && !panel.isDestroyed()) panel.webContents.send('panel-state', panelState());
      }
    });
    worker.on('error', (e) => { scanBusy = false; console.error('usage worker', e); });
    worker.on('exit', () => { worker = null; scanBusy = false; });
  }
  function scan() {
    if (!worker) startWorker();
    if (scanBusy) return;
    scanBusy = true;
    worker.postMessage('scan');
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 45e3);
  }

  function onActivity() {
    const was = behavior();
    lastActivityTs = Date.now();
    if (behavior() !== was) pushState();
    scheduleActivityRefresh();
    scheduleScan();
  }

  function watchSources() {
    try {
      fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, name) => { if (name && String(name).endsWith('.jsonl')) onActivity(); });
    } catch (e) { console.error('watch projects', e.message); }
    try {
      fs.mkdirSync(FEED_DIR, { recursive: true });
      fs.watch(FEED_DIR, (_ev, name) => { if (name === 'feed.json') readFeed(); });
    } catch (e) { console.error('watch feed', e.message); }
    let credTimer = null;
    try {
      fs.watch(path.dirname(CRED_FILES[0]), (_ev, name) => {
        if (name !== path.basename(CRED_FILES[0]) || credTimer) return;
        // Claude Code refreshed its token -> retry right away if we were stuck.
        credTimer = setTimeout(() => { credTimer = null; if (planErr) refreshLimits('creds'); }, 2500);
      });
    } catch (e) { console.error('watch creds', e.message); }
  }

  // ---------------- pet window ----------------
  function workAreaFor(b) {
    return screen.getDisplayMatching(b).workArea;
  }
  function groundY(area) {
    return area.y + area.height - PET_H;
  }

  function createPet() {
    win = new BrowserWindow({
      width: PET_W,
      height: PET_H,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      title: APP_NAME,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    lockDown(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });

    const area = screen.getPrimaryDisplay().workArea;
    let x = area.x + area.width - PET_W - 160;
    let y = groundY(area);
    if (!settings.walk && settings.pos) {
      const ok = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return settings.pos.x >= a.x - 20 && settings.pos.x <= a.x + a.width && settings.pos.y >= a.y - 40 && settings.pos.y <= a.y + a.height;
      });
      if (ok) ({ x, y } = settings.pos);
    }
    walker.x = x;
    win.setBounds({ x, y, width: PET_W, height: PET_H });
    win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
    win.webContents.once('did-finish-load', () => {
      win.showInactive();
      pushState(true);
    });
  }

  // ---------------- settings window (Clawd colour) ----------------
  function sendSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings-state', { color: clawdColor(), defaultColor: DEFAULT_COLOR });
  }
  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    if (panel && !panel.isDestroyed()) panel.close();
    settingsWin = new BrowserWindow({
      width: 380,
      height: 470,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: '#1c1b1a',
      title: 'Clawd Pace · Configurações',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    settingsWin.removeMenu();
    lockDown(settingsWin);
    settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
    settingsWin.webContents.once('did-finish-load', () => { sendSettings(); settingsWin.show(); });
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  function lockDown(w) {
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  // ---- walking ----
  const walker = { mode: 'rest', until: Date.now() + 2500, dir: -1, x: 0, lastSent: null, lastTick: Date.now() };
  const drag = { active: false, off: { x: 0, y: 0 }, start: { x: 0, y: 0 }, timer: null };
  const fall = { active: false, y: 0, vy: 0 };
  const rand = (a, b) => a + Math.random() * (b - a);
  const SPEED = { calm: 28, busy: 40, anxious: 56 }; // px/s
  const STEP = 4; // move in whole 4px hops: pixel-art feel and ~3x fewer window moves (CPU)
  const REST = { calm: [6000, 16000], busy: [3000, 8000], anxious: [1800, 4500] };
  const WALK = { calm: [2500, 5000], busy: [2500, 5500], anxious: [1500, 3200] };

  function sendWalk(dir, speed) {
    const key = dir + ':' + speed;
    if (walker.lastSent === key) return;
    walker.lastSent = key;
    if (win && !win.isDestroyed()) win.webContents.send('walk', { dir, speed });
  }

  function tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - walker.lastTick) / 1000);
    walker.lastTick = now;
    if (!win || win.isDestroyed() || !win.isVisible() || drag.active) return;
    const b = win.getBounds();
    const area = workAreaFor(b);

    if (fall.active) {
      fall.vy = Math.min(fall.vy + 2600 * dt, 2200);
      fall.y += fall.vy * dt;
      const gy = groundY(area);
      if (fall.y >= gy) {
        fall.active = false;
        win.setBounds({ x: b.x, y: gy, width: PET_W, height: PET_H });
        petEvent('land');
        dlog('land y=' + gy);
      } else {
        win.setBounds({ x: b.x, y: Math.round(fall.y), width: PET_W, height: PET_H });
      }
      return;
    }

    const beh = behavior();
    if (TEST) return sendWalk(0, 0);
    if (!settings.walk || panel || beh === 'sleep' || beh === 'ko') return sendWalk(0, 0);

    if (now > walker.until) {
      if (walker.mode === 'walk') {
        walker.mode = 'rest';
        walker.until = now + rand(...REST[beh]);
      } else {
        walker.mode = 'walk';
        walker.until = now + rand(...WALK[beh]);
        if (Math.random() < 0.5) walker.dir *= -1;
      }
    }
    if (walker.mode === 'rest') return sendWalk(0, 0);

    const speed = SPEED[beh];
    if (Math.abs(walker.x - b.x) > 3) walker.x = b.x; // moved externally
    walker.x += walker.dir * speed * dt;
    const minX = area.x - 30;
    const maxX = area.x + area.width - PET_W + 30;
    if (walker.x <= minX) { walker.x = minX; walker.dir = 1; }
    if (walker.x >= maxX) { walker.x = maxX; walker.dir = -1; }
    const gy = groundY(area);
    const nx = Math.round(walker.x / STEP) * STEP;
    if (nx !== b.x || b.y !== gy) win.setBounds({ x: nx, y: gy, width: PET_W, height: PET_H }); // setBounds: setPosition can drift size on mixed-DPI setups
    sendWalk(walker.dir, speed);
  }

  function startDrag() {
    if (!win || drag.active) return;
    dlog('drag-start');
    fall.active = false;
    drag.active = true;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    drag.start = { x: b.x, y: b.y };
    drag.off = { x: c.x - b.x, y: c.y - b.y };
    sendWalk(0, 0);
    petEvent('drag-start');
    drag.timer = setInterval(() => {
      if (!win || win.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      win.setBounds({ x: p.x - drag.off.x, y: p.y - drag.off.y, width: PET_W, height: PET_H });
    }, 12);
  }
  function endDrag() {
    if (!drag.active) return;
    drag.active = false;
    clearInterval(drag.timer);
    const b = win.getBounds();
    const moved = Math.abs(b.x - drag.start.x) + Math.abs(b.y - drag.start.y);
    walker.x = b.x;
    dlog(`drag-end moved=${moved} at ${b.x},${b.y}`);
    if (moved < 6) { petEvent('drag-end'); togglePanel(); return; }
    petEvent('drag-end');
    if (settings.walk) {
      // let go mid-air -> falls back to the taskbar
      fall.active = true;
      fall.y = b.y;
      fall.vy = 0;
      walker.mode = 'rest';
      walker.until = Date.now() + 1500;
    } else {
      settings.pos = { x: b.x, y: b.y };
      saveSettings();
    }
  }

  // ---------------- panel window ----------------
  function panelAnchor() {
    if (win && !win.isDestroyed() && win.isVisible()) return win.getBounds();
    if (tray) { const t = tray.getBounds(); if (t && t.width) return t; }
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - 200, y: a.y + a.height - 10, width: 10, height: 10 };
  }
  function placePanel(h) {
    if (!panel || panel.isDestroyed()) return;
    const W = 360;
    const anchor = panelAnchor();
    const area = workAreaFor(anchor);
    const top = anchor.y + PET_H - 118; // roughly the top of the HUD inside the pet window
    let x = Math.round(anchor.x + anchor.width / 2 - W / 2);
    x = Math.max(area.x + 8, Math.min(x, area.x + area.width - W - 8));
    h = Math.min(h, area.height - 16);
    let y = top - h - 6;
    if (y < area.y + 8) y = Math.min(anchor.y + anchor.height + 6, area.y + area.height - h - 8);
    panel.setBounds({ x, y: Math.max(area.y + 8, y), width: W, height: h });
  }
  function togglePanel() {
    dlog('toggle-panel ' + (panel ? 'close' : 'open'));
    if (panel && !panel.isDestroyed()) { panel.close(); return; }
    if (Date.now() - panelClosedAt < 350) return; // the click that blurred it
    panel = new BrowserWindow({
      width: 360,
      height: 560,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: APP_NAME,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    lockDown(panel);
    panel.setAlwaysOnTop(true, 'pop-up-menu');
    placePanel(560);
    panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
    panel.webContents.once('did-finish-load', () => {
      panel.webContents.send('panel-state', panelState());
      setTimeout(() => { if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); } }, 60); // after first layout
    });
    panel.on('blur', () => { if (!SNAP && panel && !panel.isDestroyed()) panel.close(); });
    panel.on('closed', () => { panel = null; panelClosedAt = Date.now(); pushState(); });
    sendWalk(0, 0);
    if (usage == null || Date.now() - usage.updatedAt > 60e3) scan();
  }

  // ---------------- tray ----------------
  function refreshTray() {
    if (!tray) return;
    const hasData = !!plan;
    try {
      tray.setImage(trayIcon(hasData ? pace.session : null, hasData ? pace.week : null, stale(), clawdColor()));
    } catch (e) { console.error('tray icon', e.message); }
    const s = pace.session;
    const w = pace.week;
    const tip = hasData
      ? `Clawd Pace\nSessão ${s.state === 'fresh' ? 'livre' : pct(s.util)}${s.resetsAt ? ' · reset ' + when(s.resetsAt) : ''}\nSemana ${pct(w.util)} · reset ${when(w.resetsAt)}\n${headline(pace)}`
      : 'Clawd Pace · ' + (planErr === 'no-token' ? 'faça login no Claude Code' : 'carregando…');
    tray.setToolTip(tip.slice(0, 127));
  }

  function buildMenu() {
    const s = pace.session;
    const w = pace.week;
    const head = plan
      ? [
          { label: `Sessão  ${s.state === 'fresh' ? 'livre' : pct(s.util)}${s.resetsAt ? '  ·  reset ' + when(s.resetsAt) : ''}`, enabled: false },
          { label: `Semana  ${pct(w.util)}  ·  reset ${when(w.resetsAt)}`, enabled: false },
          { type: 'separator' },
        ]
      : [];
    const set = (k, v) => { settings[k] = v; saveSettings(); pushState(true); };
    return Menu.buildFromTemplate([
      ...head,
      { label: 'Abrir painel', click: togglePanel },
      { label: 'Atualizar agora', click: () => { refreshLimits('manual'); scan(); } },
      { type: 'separator' },
      {
        label: 'Andar pela tela',
        type: 'checkbox',
        checked: settings.walk,
        click: (i) => {
          set('walk', i.checked);
          if (i.checked) { const b = win.getBounds(); fall.active = true; fall.y = b.y; fall.vy = 0; }
          else { const b = win.getBounds(); settings.pos = { x: b.x, y: b.y }; saveSettings(); }
        },
      },
      {
        label: 'Barras de uso',
        submenu: [
          { label: 'Sempre visíveis', type: 'radio', checked: settings.hud === 'always', click: () => set('hud', 'always') },
          { label: 'Só ao passar o mouse', type: 'radio', checked: settings.hud === 'hover', click: () => set('hud', 'hover') },
        ],
      },
      {
        label: 'Tamanho',
        submenu: [
          { label: 'Pequeno', type: 'radio', checked: settings.size === 's', click: () => set('size', 's') },
          { label: 'Médio', type: 'radio', checked: settings.size === 'm', click: () => set('size', 'm') },
          { label: 'Grande', type: 'radio', checked: settings.size === 'l', click: () => set('size', 'l') },
        ],
      },
      { label: 'Cor do Clawd…', click: openSettings },
      { label: 'Renovar login sozinho (Claude Code fechado)', type: 'checkbox', checked: settings.autoLogin, click: (i) => { set('autoLogin', i.checked); if (i.checked) refreshLimits('manual'); } },
      { label: 'Notificações de ritmo', type: 'checkbox', checked: settings.notify, click: (i) => set('notify', i.checked) },
      { label: 'Iniciar com o Windows', type: 'checkbox', checked: settings.autostart, click: (i) => { set('autostart', i.checked); syncAutostart(); } },
      { type: 'separator' },
      { label: 'Trazer o Clawd pra cá', click: bringBack },
      { label: win && win.isVisible() ? 'Esconder o Clawd' : 'Mostrar o Clawd', click: () => { if (win.isVisible()) win.hide(); else { win.showInactive(); pushState(true); } } },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]);
  }
  function popMenu() {
    const m = buildMenu();
    if (win && !win.isDestroyed() && win.isVisible()) m.popup({ window: win });
    else if (tray) tray.popUpContextMenu(m);
  }
  function bringBack() {
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    walker.x = Math.round(Math.min(Math.max(screen.getCursorScreenPoint().x - PET_W / 2, a.x), a.x + a.width - PET_W));
    win.setBounds({ x: walker.x, y: groundY(a), width: PET_W, height: PET_H });
    settings.pos = null;
    saveSettings();
    if (!win.isVisible()) win.showInactive();
    petEvent('celebrate');
  }
  function createTray() {
    tray = new Tray(trayIcon(null, null, true, clawdColor()));
    tray.on('click', togglePanel);
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    refreshTray();
  }

  // ---------------- autostart + Start menu shortcut (Windows) ----------------
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const startupLink = path.join(programs, 'Startup', `${APP_NAME}.lnk`);
  const startMenuLink = path.join(programs, `${APP_NAME}.lnk`);
  function linkOptions() {
    return {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      description: 'Clawd mostrando o ritmo de uso do Claude',
      icon: path.join(__dirname, 'build', 'icon.ico'),
      iconIndex: 0,
      appUserModelId: APP_ID,
    };
  }
  function syncAutostart() {
    if (process.platform !== 'win32') { app.setLoginItemSettings({ openAtLogin: settings.autostart }); return; }
    try {
      if (settings.autostart) shell.writeShortcutLink(startupLink, 'create', linkOptions());
      else if (fs.existsSync(startupLink)) fs.unlinkSync(startupLink);
    } catch (e) { console.error('autostart', e.message); }
  }
  function install() {
    if (process.platform === 'win32') {
      // Start-menu entry carries the AppUserModelID so toasts show "Clawd Pace".
      try { shell.writeShortcutLink(startMenuLink, 'create', linkOptions()); } catch (e) { console.error('start menu', e.message); }
    }
    syncAutostart();
    if (!settings.installed) { settings.installed = true; saveSettings(); }
  }

  // ---------------- IPC ----------------
  const fromPet = (e) => win && e.sender === win.webContents;
  const fromPanel = (e) => panel && e.sender === panel.webContents;
  const fromSettings = (e) => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
  ipcMain.on('set-color', (e, v) => {
    if (!fromSettings(e)) return;
    const c = v === null ? null : normHex(v);
    if (v !== null && !c) return; // invalid hex: keep the current colour
    settings.color = c === DEFAULT_COLOR ? null : c;
    saveSettings();
    pushState(true);
    sendSettings();
  });
  ipcMain.on('set-interactive', (e, v) => { if (fromPet(e)) { win.setIgnoreMouseEvents(!v, { forward: true }); dlog('interactive ' + !!v); } });
  ipcMain.on('drag-start', (e) => { if (fromPet(e)) startDrag(); });
  ipcMain.on('drag-end', (e) => { if (fromPet(e)) endDrag(); });
  ipcMain.on('menu', (e) => { if (fromPet(e) || fromPanel(e)) popMenu(); });
  ipcMain.on('refresh', (e) => { if (fromPanel(e)) { refreshLimits('manual'); scan(); } });
  ipcMain.on('panel-height', (e, h) => { if (fromPanel(e) && Number.isFinite(h)) placePanel(Math.max(200, Math.min(1400, Math.round(h)))); });
  ipcMain.on('panel-close', (e) => { if (fromPanel(e)) panel.close(); });

  // ---------------- boot ----------------
  app.on('second-instance', () => { if (win) { if (!win.isVisible()) win.showInactive(); bringBack(); } });
  app.on('window-all-closed', (e) => e.preventDefault && e.preventDefault());

  app.whenReady().then(() => {
    install();
    createPet();
    createTray();
    watchSources();
    readFeed();
    refreshLimits('boot');
    scan();

    setInterval(tick, 50); // 20 fps is plenty for pixel art and keeps CPU low
    setInterval(() => { if (Date.now() - lastFetch > POLL_MS) refreshLimits('poll'); }, 30e3);
    setInterval(scan, SCAN_MS);
    setInterval(() => pushState(), 30e3); // time moves -> pace moves
    setInterval(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver'); }, 60e3);

    if (SNAP) {
      const cap = async (w, name) => { if (w && !w.isDestroyed()) fs.writeFileSync(path.join(SNAP, name), (await w.webContents.capturePage()).toPNG()); };
      if (!TEST) setTimeout(togglePanel, 4000);
      setTimeout(openSettings, 3500);
      setTimeout(() => cap(settingsWin, 'settings.png'), 8500);
      setTimeout(() => { fs.writeFileSync(path.join(SNAP, 'bounds.json'), JSON.stringify(win.getBounds())); dlog('ready'); }, 3000);
      setTimeout(async () => { await cap(panel, 'panel.png'); await cap(win, 'pet.png'); fs.writeFileSync(path.join(SNAP, 'tray.png'), trayIcon(null, null, false, clawdColor()).resize({ width: 128, height: 128, quality: 'good' }).toPNG()); }, 9000);
    }

    powerMonitor.on('resume', () => setTimeout(() => refreshLimits('resume'), 5000));
    powerMonitor.on('unlock-screen', () => { pushState(); refreshLimits('unlock'); });
    screen.on('display-removed', bringBack);
    screen.on('display-metrics-changed', () => {
      const b = win.getBounds();
      const a = workAreaFor(b);
      if (b.x > a.x + a.width - 40 || b.y > a.y + a.height) bringBack();
    });
  });

  app.on('before-quit', () => { history.save(); saveLast(); if (worker) worker.terminate(); });
}
