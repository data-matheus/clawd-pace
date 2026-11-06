'use strict';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const hexEl = $('hex');
const picker = $('picker');
const hint = $('hint');

const PRESETS = [
  ['#d97757', 'Laranja Claude (padrão)'],
  ['#3987e5', 'Azul'],
  ['#199e70', 'Verde-água'],
  ['#0ca30c', 'Verde'],
  ['#9085e9', 'Violeta'],
  ['#d55181', 'Magenta'],
  ['#c98500', 'Âmbar'],
  ['#e66767', 'Coral'],
  ['#5fc4d9', 'Ciano'],
  ['#8b5e3c', 'Marrom'],
  ['#f2c94c', 'Amarelo'],
  ['#e8e6dc', 'Creme'],
  ['#ffffff', 'Branco'],
  ['#8f8e88', 'Cinza'],
  ['#2b2b2b', 'Grafite'],
  ['#1f2a5c', 'Azul-noite'],
];

// mirror of color.js (renderer is sandboxed: no require)
function normHex(v) {
  const m = String(v == null ? '' : v).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(m)) return '#' + m.split('').map((c) => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(m)) return '#' + m.toLowerCase();
  return null;
}
function eyeColor(hex) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.18 ? '#f0efec' : '#1a1a19';
}

let current = '#d97757';

function show(hex, { fromText = false } = {}) {
  current = hex;
  root.style.setProperty('--base', hex);
  root.style.setProperty('--eye', eyeColor(hex));
  picker.value = hex;
  if (!fromText) hexEl.value = hex.toUpperCase();
  hexEl.classList.remove('invalid');
  hint.classList.remove('invalid');
  hint.textContent = 'Qualquer hex: #RRGGBB ou #RGB. Aplica na hora.';
  document.querySelectorAll('.swatches button').forEach((b) => b.classList.toggle('on', b.dataset.hex === hex));
}

function apply(hex, opts) {
  show(hex, opts);
  window.clawd.setColor(hex);
}

// swatches
const sw = $('swatches');
for (const [hex, name] of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.hex = hex;
  b.title = `${name} · ${hex.toUpperCase()}`;
  b.setAttribute('aria-label', b.title);
  b.style.background = hex;
  b.addEventListener('click', () => apply(hex));
  sw.appendChild(b);
}

hexEl.addEventListener('input', () => {
  const h = normHex(hexEl.value);
  if (h) apply(h, { fromText: true });
  else {
    hexEl.classList.add('invalid');
    if (hexEl.value.replace('#', '').length >= 6) {
      hint.classList.add('invalid');
      hint.textContent = 'Hex inválido. Use 0–9 e A–F, ex.: #3987E5';
    }
  }
});
hexEl.addEventListener('blur', () => { if (!normHex(hexEl.value)) show(current); });
picker.addEventListener('input', () => apply(normHex(picker.value)));

$('reset').addEventListener('click', () => { window.clawd.setColor(null); });
$('done').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); if (e.key === 'Enter') window.close(); });

window.clawd.onSettings((s) => {
  show(s.color);
  if (document.activeElement !== hexEl) hexEl.value = s.color.toUpperCase();
});
