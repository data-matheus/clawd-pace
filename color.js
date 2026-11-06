'use strict';

// Clawd colour helpers (pure, tested in test/color.test.js).

const DEFAULT_COLOR = '#d97757'; // Claude orange

// Accepts "#abc", "abc", "#aabbcc", "AABBCC" -> "#aabbcc"; anything else -> null.
function normHex(v) {
  const m = String(v == null ? '' : v).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(m)) return '#' + m.split('').map((c) => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(m)) return '#' + m.toLowerCase();
  return null;
}

function hexToRgb(hex) {
  const h = normHex(hex) || DEFAULT_COLOR;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

// WCAG relative luminance, 0 (black) .. 1 (white).
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Eyes stay readable on any body colour: dark eyes, light ones on dark bodies.
function eyeColor(hex) {
  return luminance(hex) < 0.18 ? '#f0efec' : '#1a1a19';
}

module.exports = { DEFAULT_COLOR, normHex, hexToRgb, luminance, eyeColor };
