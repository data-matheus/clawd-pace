'use strict';

const $ = (id) => document.getElementById(id);
const body = document.body;
const pet = $('pet');
const fx = $('fx');

let st = null; // latest state from main
let walk = { dir: 0, speed: 0 };
let facing = -1;
let hovering = false;
let dragging = false;
let oneShot = null; // 'celebrate' | 'land' while it plays

// ---------------- HUD ----------------
const ICON = { ok: '✓', tight: '!', over: '▲', maxed: '■', fresh: '·' };
function renderRow(id, w) {
  const row = $(id);
  row.className = 'row ' + w.state;
  row.querySelector('.fill').style.width = Math.min(100, w.util) + '%';
  row.querySelector('.tick').style.left = Math.min(100, w.expected) + '%';
  row.querySelector('.val').textContent = w.state === 'fresh' ? 'livre' : Math.round(w.util) + '%';
  row.querySelector('.ico').textContent = ICON[w.state] || '';
}

// readable eyes on any body colour (mirror of color.js)
function eyeColor(hex) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.18 ? '#f0efec' : '#1a1a19';
}
let appliedColor = null;
function applyColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '') || hex === appliedColor) return;
  appliedColor = hex;
  document.documentElement.style.setProperty('--base', hex);
  document.documentElement.style.setProperty('--eye', eyeColor(hex));
}

function render() {
  if (!st) return;
  applyColor(st.color);
  body.className = `size-${st.size} mood-${st.mood}` + (st.hud === 'hover' ? ' hud-hover' : '') + (hovering ? ' hovering' : '') + (st.stale ? ' stale' : '') + (st.err === 'expired' || !st.hasData ? ' show-head' : '');
  if (st.hasData) {
    renderRow('r-s', st.session);
    renderRow('r-w', st.week);
  }
  let head = st.headline || '';
  if (st.err === 'expired') head = st.authNote === 'claude-open' ? 'Login expirou · use o Claude Code aberto' : st.authNote === 'renew-failed' ? 'Login expirou · faça login no Claude Code' : 'Renovando login…';
  else if (st.err === 'no-token') head = 'Faça login no Claude Code';
  $('headline').textContent = head;
  renderPet();
}

// ---------------- Clawd ----------------
function renderPet() {
  const beh = st ? st.behavior : 'calm';
  const cls = ['hit'];
  if (dragging) cls.push('dragged');
  else if (oneShot) cls.push(oneShot);
  else if (beh === 'sleep') cls.push('sleep');
  else if (beh === 'ko') cls.push('ko');
  if (!dragging && walk.dir && !oneShot) cls.push('walking', stepA ? 'step-a' : 'step-b');
  else cls.push('idle');
  if (beh === 'anxious') cls.push('anxious');
  cls.push(facing > 0 ? 'face-r' : 'face-l');
  if (blinking) cls.push('blink');
  pet.className = cls.join(' ');
  syncAmbient(beh);
}

// leg stepping driven by walking speed
let stepA = false;
let stepTimer = null;
function updateStepper() {
  clearInterval(stepTimer);
  stepTimer = null;
  if (walk.dir && !dragging) {
    const period = Math.max(140, Math.min(360, 9000 / Math.max(1, walk.speed)));
    stepTimer = setInterval(() => { stepA = !stepA; renderPet(); }, period);
  }
  renderPet();
}

// blinking
let blinking = false;
(function blinkLoop() {
  setTimeout(() => {
    if (!st || (st.behavior !== 'sleep' && st.behavior !== 'ko')) {
      blinking = true;
      renderPet();
      setTimeout(() => { blinking = false; renderPet(); }, 130);
    }
    blinkLoop();
  }, 2200 + Math.random() * 4200);
})();

// ---------------- ambient effects ----------------
function spawn(cls, text, x, y, life) {
  const el = document.createElement('div');
  el.className = cls;
  if (text) el.textContent = text;
  el.style.left = x;
  el.style.top = y;
  fx.appendChild(el);
  setTimeout(() => el.remove(), life);
  return el;
}
const u = () => parseFloat(getComputedStyle(body).getPropertyValue('--u')) || 5;

let ambientTimer = null;
let ambientKind = null;
let starEls = [];
function syncAmbient(beh) {
  const kind = dragging || oneShot ? null : beh === 'sleep' ? 'zzz' : beh === 'ko' ? 'ko' : st && st.mood === 'over' ? 'over' : st && st.mood === 'tight' ? 'tight' : null;
  if (kind === ambientKind) return;
  ambientKind = kind;
  clearInterval(ambientTimer);
  ambientTimer = null;
  starEls.forEach((e) => e.remove());
  starEls = [];
  if (kind === 'zzz') {
    ambientTimer = setInterval(() => spawn('z', 'z', `${u() * 11}px`, `${u() * -1}px`, 2400), 3200);
  } else if (kind === 'over') {
    ambientTimer = setInterval(() => {
      const side = Math.random() < 0.5;
      spawn('drop', '', `${u() * (side ? 2.4 : 12.8)}px`, `${u() * 0.8}px`, 900);
      if (Math.random() < 0.5) spawn('puff', '', `${u() * (4 + Math.random() * 7)}px`, `${u() * -1.6}px`, 1400);
    }, 3000);
  } else if (kind === 'tight') {
    ambientTimer = setInterval(() => {
      if (Math.random() < 0.5) spawn('drop', '', `${u() * 12.8}px`, `${u() * 0.8}px`, 900);
    }, 5000);
  } else if (kind === 'ko') {
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('div');
      s.className = 'star';
      s.textContent = '✦';
      s.style.animationDelay = `${-i * 0.8}s`;
      fx.appendChild(s);
      starEls.push(s);
    }
  }
}

function playOneShot(kind, ms) {
  oneShot = kind;
  renderPet();
  clearTimeout(playOneShot.t);
  playOneShot.t = setTimeout(() => { oneShot = null; renderPet(); }, ms);
}

function celebrate() {
  playOneShot('celebrate', 1600);
  for (let i = 0; i < 6; i++) {
    setTimeout(() => spawn('heart', '♥', `${u() * (2 + Math.random() * 10)}px`, `${u() * -1}px`, 1500), i * 160);
  }
}

// ---------------- input ----------------
// The window is click-through except over Clawd/HUD. Main forwards mouse moves
// to us; we hit-test each move. (enter/leave events are unreliable here: toggling
// click-through makes Windows emit a bogus leave right after the enter.)
let interactive = false;
function setInteractive(v) {
  if (v === interactive) return;
  interactive = v;
  window.clawd.setInteractive(v);
}
function setHover(v) {
  if (v === hovering) return;
  hovering = v;
  render();
}
const overHit = (x, y) => {
  const t = document.elementFromPoint(x, y);
  return !!(t && t.closest && t.closest('.hit'));
};
document.addEventListener('mousemove', (e) => {
  if (dragging) return;
  const over = overHit(e.clientX, e.clientY);
  setHover(over);
  setInteractive(over);
});
document.addEventListener('mouseleave', (e) => {
  if (dragging) return;
  const inside = e.clientX > 0 && e.clientY > 0 && e.clientX < innerWidth - 1 && e.clientY < innerHeight - 1;
  if (inside && overHit(e.clientX, e.clientY)) return; // the bogus leave
  setHover(false);
  setInteractive(false);
});

const hits = document.querySelectorAll('.hit');
hits.forEach((el) => {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    dragging = true;
    updateStepper();
    window.clawd.dragStart();
  });
  el.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !dragging) return;
    try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragging = false;
    window.clawd.dragEnd();
    updateStepper();
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); window.clawd.menu(); });
});
// eyes follow the cursor a little while hovering
document.addEventListener('pointermove', (e) => {
  if (!hovering || dragging || walk.dir) return;
  const r = pet.getBoundingClientRect();
  const f = e.clientX > r.left + r.width / 2 ? 1 : -1;
  if (f !== facing) { facing = f; renderPet(); }
});

// ---------------- from main ----------------
window.clawd.onState((s) => { st = s; render(); });
window.clawd.onWalk((w) => {
  walk = w;
  if (w.dir) facing = w.dir;
  updateStepper();
});
window.clawd.onEvent((ev) => {
  if (ev === 'celebrate') celebrate();
  else if (ev === 'land') playOneShot('land', 420);
  else if (ev === 'drag-start') { dragging = true; updateStepper(); }
  else if (ev === 'drag-end') { dragging = false; updateStepper(); }
});
