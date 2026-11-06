'use strict';

// Draws the tray icon pixel by pixel: session % as a number in its status
// colour, plus a thin weekly bar underneath. 16px + 32px representations.

const { nativeImage } = require('electron');

const STATUS = {
  fresh: [0xc3, 0xc2, 0xb7],
  ok: [0x0c, 0xa3, 0x0c],
  tight: [0xfa, 0xb2, 0x19],
  over: [0xd0, 0x3b, 0x3b],
  maxed: [0xd0, 0x3b, 0x3b],
};
const BG = [0x1c, 0x1b, 0x1a];
const TRACK = [0x45, 0x44, 0x40];
const CLAWD = [0xd9, 0x77, 0x57];
const MUTED = [0x8f, 0x8e, 0x88];

// 3x5 digits
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

function draw(S, session, week, stale) {
  const px = Buffer.alloc(S * S * 4); // BGRA
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a;
  };
  const rect = (x, y, w, h, c, a) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c, a); };

  // rounded dark tile
  const r = S >= 32 ? 6 : 3;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.max(r - x - 0.5, x + 0.5 - (S - r), 0);
      const dy = Math.max(r - y - 0.5, y + 0.5 - (S - r), 0);
      if (dx * dx + dy * dy <= r * r) set(x, y, BG);
    }
  }

  if (!session) {
    // no data yet: a tiny Clawd silhouette
    const u = S / 16;
    rect(Math.round(3 * u), Math.round(4 * u), Math.round(10 * u), Math.round(6 * u), CLAWD);
    rect(Math.round(1.5 * u), Math.round(6 * u), Math.round(13 * u), Math.round(2 * u), CLAWD);
    rect(Math.round(5 * u), Math.round(6 * u), Math.max(1, Math.round(u)), Math.round(2 * u), BG);
    rect(Math.round(10 * u), Math.round(6 * u), Math.max(1, Math.round(u)), Math.round(2 * u), BG);
    for (const lx of [4, 6, 9, 11]) rect(Math.round(lx * u), Math.round(10 * u), Math.max(1, Math.round(u)), Math.round(2 * u), CLAWD);
    return px;
  }

  const val = session.state === 'fresh' ? 0 : Math.min(100, Math.round(session.util));
  const text = String(val);
  const color = stale ? MUTED : STATUS[session.state] || STATUS.ok;
  const scale = S >= 32 ? (text.length >= 3 ? 2 : 3) : text.length >= 3 ? 1 : 2;
  const gap = scale;
  const w = text.length * 3 * scale + (text.length - 1) * gap;
  const h = 5 * scale;
  const barH = S >= 32 ? 4 : 2;
  const top = Math.max(1, Math.floor((S - barH - 2 - h) / 2));
  let x0 = Math.floor((S - w) / 2);
  for (const ch of text) {
    const g = FONT[ch];
    for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) if (g[row][col] === '1') rect(x0 + col * scale, top + row * scale, scale, scale, color);
    x0 += 3 * scale + gap;
  }

  // weekly bar
  if (week) {
    const bx = S >= 32 ? 4 : 2;
    const bw = S - bx * 2;
    const by = S - barH - (S >= 32 ? 3 : 1);
    rect(bx, by, bw, barH, TRACK);
    const fill = Math.round((bw * Math.min(100, week.util)) / 100);
    rect(bx, by, fill, barH, stale ? MUTED : STATUS[week.state] || STATUS.ok);
  }
  return px;
}

function trayIcon(session, week, stale) {
  const img = nativeImage.createFromBitmap(draw(16, session, week, stale), { width: 16, height: 16, scaleFactor: 1 });
  const big = nativeImage.createFromBitmap(draw(32, session, week, stale), { width: 32, height: 32, scaleFactor: 2 });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: big.toPNG() });
  return img;
}

module.exports = { trayIcon, draw };
