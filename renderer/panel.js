'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const NS = 'http://www.w3.org/2000/svg';
const H = 3600e3;

// ---------- tiny DOM helpers (textContent only: no HTML injection) ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k.nodeType ? k : String(k));
  return e;
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const b = (t) => el('b', {}, t);

// ---------- formatting (pt-BR) ----------
const nf = new Intl.NumberFormat('pt-BR');
const pct = (v) => `${Math.round(v)}%`;
function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' bi';
  if (n >= 1e6) return Math.round(n / 1e6) + ' mi';
  if (n >= 1e3) return Math.round(n / 1e3) + ' mil';
  return String(n || 0);
}
const usd = (v) => '$' + nf.format(Math.round(v || 0));
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DOW1 = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function when(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? hhmm(ms) : `${DOW[d.getDay()]} ${hhmm(ms)}`;
}
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  return `há ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
const STATUS = {
  ok: ['✓', 'No ritmo'],
  tight: ['!', 'No limite'],
  over: ['▲', 'Acima do ritmo'],
  maxed: ['■', 'Esgotado'],
  fresh: ['·', 'Livre'],
};
const COLOR = { ok: '#0ca30c', tight: '#fab219', over: '#d03b3b', maxed: '#d03b3b', fresh: '#c3c2b7' };
const ERR = {
  expired: 'O token do Claude Code expirou. Abra o Claude Code (VS Code ou terminal) que ele renova sozinho — o Clawd atualiza na hora.',
  'no-token': 'Não achei login do Claude Code neste PC (~/.claude/.credentials.json).',
  'http-429': 'A API pediu pra esperar (429). Tentando de novo em alguns minutos.',
  timeout: 'Sem resposta da API (timeout). Mostrando o último dado.',
};

// ---------- tooltip ----------
const tip = $('#tip');
function showTip(text, x, y) {
  tip.textContent = text;
  tip.classList.add('on');
  const w = tip.offsetWidth;
  tip.style.left = Math.max(4, Math.min(x - w / 2, window.innerWidth - w - 4)) + 'px';
  tip.style.top = Math.max(4, y - 30) + 'px';
}
const hideTip = () => tip.classList.remove('on');
function withTip(node, text) {
  node._tip = text;
  if (!node._tipBound) {
    node._tipBound = true;
    node.addEventListener('mousemove', (e) => showTip(node._tip, e.clientX, e.clientY));
    node.addEventListener('mouseleave', hideTip);
  }
  return node;
}

// ---------- sections ----------
function meter(node, p) {
  node.className = 'meter ' + p.state;
  $('.fill', node).style.width = Math.min(100, p.util) + '%';
  $('.tick', node).style.left = Math.min(100, p.expected) + '%';
  node.title = '';
  withTip(node, p.state === 'fresh' ? 'Janela ainda não começou' : `Usado ${pct(p.util)} · ritmo uniforme seria ${pct(p.expected)} agora`);
}

function head(sec, p) {
  const [ico, label] = STATUS[p.state] || STATUS.ok;
  const s = $('.status', sec);
  s.className = 'status ' + p.state;
  s.textContent = `${ico} ${label}`;
  $('.big', sec).textContent = p.state === 'fresh' ? '0%' : pct(p.util);
  meter($('.meter', sec), p);
}

// Utilisation over the window vs the even-pace diagonal, plus the projection.
function spark(svgEl, axis, series, p, lenMs) {
  svgEl.replaceChildren();
  const W = 312;
  const Hh = 34;
  if (!p.resetsAt) {
    $('.a0', axis).textContent = '';
    $('.a1', axis).textContent = '';
    svgEl.style.display = 'none';
    return;
  }
  svgEl.style.display = '';
  const start = p.resetsAt - lenMs;
  const X = (t) => ((t - start) / lenMs) * W;
  const Y = (v) => Hh - (Math.min(100, Math.max(0, v)) / 100) * (Hh - 2) - 1;
  svgEl.append(svg('line', { x1: 0, y1: Y(100), x2: W, y2: Y(100), stroke: 'rgba(255,255,255,.07)', 'stroke-width': 1 }));
  svgEl.append(svg('line', { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: 'rgba(255,255,255,.1)', 'stroke-width': 1 }));
  // even pace
  svgEl.append(svg('line', { x1: 0, y1: Y(0), x2: W, y2: Y(100), stroke: '#8f8e88', 'stroke-width': 1.5, 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' }));

  const now = Date.now();
  const pts = series.filter(([t]) => t >= start && t <= now).concat([[now, p.util]]);
  if (pts.length > 1) {
    svgEl.append(svg('polyline', { points: pts.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: '#3987e5', 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
  }
  // projection until reset (or until it hits 100%)
  const endT = p.etaFull ? p.etaFull : p.resetsAt;
  const endV = p.etaFull ? 100 : p.projected;
  svgEl.append(svg('line', { x1: X(now), y1: Y(p.util), x2: X(endT), y2: Y(endV), stroke: COLOR[p.state], 'stroke-width': 2, 'stroke-dasharray': '1 3', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
  svgEl.append(svg('circle', { cx: X(now), cy: Y(p.util), r: 3.2, fill: '#3987e5', stroke: '#1c1b1a', 'stroke-width': 2 }));
  if (p.etaFull) svgEl.append(svg('circle', { cx: X(p.etaFull), cy: Y(100), r: 3, fill: COLOR[p.state], stroke: '#1c1b1a', 'stroke-width': 2 }));

  // hover: nearest known point
  const hit = svg('rect', { x: 0, y: 0, width: W, height: Hh, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const r = svgEl.getBoundingClientRect();
    const t = start + ((e.clientX - r.left) / r.width) * lenMs;
    if (t > now) {
      const v = Math.min(100, p.util + p.rate * (t - now));
      showTip(`${when(t)} · projeção ${pct(v)} · ritmo uniforme ${pct(((t - start) / lenMs) * 100)}`, e.clientX, e.clientY);
      return;
    }
    let best = pts[0];
    for (const q of pts) if (Math.abs(q[0] - t) < Math.abs(best[0] - t)) best = q;
    showTip(`${when(best[0])} · ${pct(best[1])} usado`, e.clientX, e.clientY);
  });
  hit.addEventListener('mouseleave', hideTip);
  svgEl.append(hit);
  $('.a0', axis).textContent = 'início ' + when(start);
  $('.a1', axis).textContent = 'reset ' + when(p.resetsAt);
}

function renderSession(s) {
  const sec = $('#sec-session');
  const p = s.pace.session;
  const L = s.labels;
  head(sec, p);
  const ul = $('.facts', sec);
  ul.replaceChildren();
  if (p.state === 'fresh') {
    ul.append(el('li', {}, 'A janela de 5h começa na sua próxima mensagem.'));
  } else {
    ul.append(el('li', {}, 'Reset ', b(L.sessionReset), ` (em ${L.sessionLeft})`));
    if (p.etaFull) ul.append(el('li', {}, 'No ritmo atual: ', b('100% às ' + L.sessionEta), ` — ${L.sessionEtaGap} antes do reset`));
    else ul.append(el('li', {}, 'Projeção no reset: ', b('~' + pct(p.projected))));
    const now = p.recentH != null ? `${p.recentH.toFixed(0)}%/h nos últimos 30 min` : `${p.avgH.toFixed(0)}%/h na média da janela`;
    ul.append(el('li', {}, 'Ritmo: ', b(now), ' · pra durar: ', b(`${p.budget.toFixed(0)}%/h`)));
  }
  spark($('.spark', sec), $('.axis', sec), s.sessionSeries, p, 5 * H);
}

function renderWeek(s) {
  const sec = $('#sec-week');
  const p = s.pace.week;
  const L = s.labels;
  head(sec, p);
  const ul = $('.facts', sec);
  ul.replaceChildren();
  if (p.state !== 'fresh') {
    ul.append(el('li', {}, 'Reset ', b(L.weekReset), ` (em ${L.weekLeft})`));
    if (p.etaFull) ul.append(el('li', {}, 'No ritmo da semana: ', b('100% ' + L.weekEta), ` — ${L.weekEtaGap} antes do reset`));
    else ul.append(el('li', {}, 'Projeção no reset: ', b('~' + pct(p.projected))));
    const d = Math.round(p.delta);
    ul.append(el('li', {}, 'Pra chegar redondo: ', b(`~${p.budget.toFixed(0)}%/dia`), ` · ${d >= 0 ? '+' : ''}${d} pts vs ritmo uniforme`));
  }
  spark($('.spark', sec), $('.axis', sec), s.weekSeries, p, 7 * 24 * H);

  // where the week went (API breakdown)
  const bd = s.plan && s.plan.breakdown;
  const box = $('#breakdown');
  if (bd && bd.length) {
    box.hidden = false;
    const rows = bd.filter((r) => r.pct > 0).sort((a, c) => c.pct - a.pct);
    const palette = ['var(--series)', 'var(--s2)', 'var(--s3)'];
    const colorOf = (r, i) => (/^(other|outros?)$/i.test(r.name) || i > 2 ? 'var(--other)' : palette[i]);
    const stack = $('.stack', box);
    const legend = $('.legend', box);
    stack.replaceChildren();
    legend.replaceChildren();
    rows.forEach((r, i) => {
      stack.append(withTip(el('i', { style: { flex: String(r.pct), background: colorOf(r, i) } }), `${r.name}: ${r.pct}% do uso da semana`));
      legend.append(el('span', {}, el('i', { style: { background: colorOf(r, i) } }), r.name + ' ', b(r.pct + '%')));
    });
  } else box.hidden = true;

  // per-model weekly caps
  const sc = $('#scoped');
  sc.replaceChildren();
  for (const m of (s.plan && s.plan.scoped) || []) {
    const st = m.util >= 100 ? 'maxed' : m.util >= 85 ? 'tight' : 'ok';
    const mt = el('div', { class: 'meter ' + st }, el('i', { class: 'fill', style: { width: Math.min(100, m.util) + '%' } }));
    sc.append(el('div', { class: 'srow' }, el('span', {}, `Limite ${m.name}`), mt, b(pct(m.util))));
  }
  if (s.plan && s.plan.extra) {
    const x = s.plan.extra;
    sc.append(el('div', { class: 'srow' }, el('span', {}, 'Créditos extras'), el('span', { style: { flex: '1' } }), b(x.util != null ? pct(x.util) : '–')));
  }
}

function barsChart(svgEl, values, labels, opts) {
  svgEl.replaceChildren();
  const W = 312;
  const Hh = opts.height;
  const top = opts.top || 0;
  const n = values.length;
  const gap = opts.gap;
  const bw = (W - gap * (n - 1)) / n;
  const max = Math.max(1, ...values.map((v) => v.v));
  values.forEach((v, i) => {
    const h = Math.max(v.v > 0 ? 2 : 0, ((Hh - top) * v.v) / max);
    const x = i * (bw + gap);
    const y = Hh - h;
    const r = Math.min(3, bw / 2, h);
    // rounded data-end, square baseline
    const path = h > 0
      ? `M${x},${Hh} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${Hh} Z`
      : '';
    if (path) {
      const p = svg('path', { d: path, class: 'bar' + (v.hot ? ' hot' : '') });
      svgEl.append(p);
    }
    const hit = svg('rect', { x, y: 0, width: bw + gap, height: Hh + 14, fill: 'transparent' });
    withTip(hit, v.tip);
    svgEl.append(hit);
    if (v.label) {
      const t = svg('text', { x: x + bw / 2, y: y - 3, 'text-anchor': 'middle', class: 'val-t' });
      t.textContent = v.label;
      svgEl.append(t);
    }
    if (labels[i] != null) {
      const t = svg('text', { x: x + bw / 2, y: Hh + 11, 'text-anchor': 'middle', class: 'axis-t' + (v.hot ? ' now' : '') });
      t.textContent = labels[i];
      svgEl.append(t);
    }
  });
  svgEl.setAttribute('viewBox', `0 0 ${W} ${Hh + 14}`);
}

function renderActivity(u) {
  if (!u) return;
  $('#k-msgs').textContent = nf.format(u.today.m);
  $('#k-tok').textContent = tokens(u.today.t);
  $('#k-usd').textContent = usd(u.today.c);

  const maxDay = Math.max(...u.last7.map((d) => d.c));
  const days = u.last7.map((d, i) => ({
    v: d.c,
    hot: i === 6,
    label: (i === 6 || (d.c === maxDay && d.c > 0)) ? usd(d.c) : '',
    tip: `${DOW[d.dow]} ${d.day.slice(8)}/${d.day.slice(5, 7)} · ≈ ${usd(d.c)} · ${nf.format(d.m)} msgs · ${tokens(d.t)} tokens`,
  }));
  barsChart($('#days'), days, u.last7.map((d) => DOW1[d.dow]), { height: 40, top: 12, gap: 6 });

  const nowH = new Date().getHours();
  const peak = u.hours7.indexOf(Math.max(...u.hours7));
  const hours = u.hours7.map((v, h) => ({ v, hot: h === nowH, tip: `${h}h–${h + 1}h · ${nf.format(v)} msgs nos últimos 7 dias` }));
  barsChart($('#hours'), hours, u.hours7.map((_, h) => (h % 6 === 0 ? h + 'h' : null)), { height: 28, top: 0, gap: 2 });

  const ul = $('#act-facts');
  ul.replaceChildren();
  ul.append(el('li', {}, 'Pico de uso: ', b(`${peak}h–${peak + 1}h`), ' · agora: ', b(`${nowH}h`)));
  const top = u.modelsWeek[0];
  const tot = u.modelsWeek.reduce((a, m) => a + m.c, 0) || 1;
  ul.append(el('li', {}, 'Semana: ', b('≈ ' + usd(u.week.c)), top ? ` · ${top.name} ${Math.round((top.c / tot) * 100)}%` : ''));
  if (u.topProject) ul.append(el('li', {}, 'Projeto que mais gastou: ', b(u.topProject.name), ` (≈ ${usd(u.topProject.c)})`));
  ul.append(el('li', {}, 'Sequência: ', b(`${u.streak} ${u.streak === 1 ? 'dia' : 'dias'}`), ` · ${u.activeDays30}/30 dias ativos · total ${tokens(u.all.t)} tokens ≈ ${usd(u.all.c)}`));
}

// ---------- main render ----------
let state = null;
function render() {
  const s = state;
  if (!s) return;
  $('#plan').textContent = (s.plan && s.plan.planName) || '';
  $('#headline').textContent = s.plan ? s.headline : 'Buscando seus limites…';
  const err = $('#error');
  err.hidden = !s.planErr;
  err.textContent = s.planErr ? ERR[s.planErr] || `Não consegui atualizar (${s.planErr}). Mostrando o último dado.` : '';
  if (s.plan) {
    renderSession(s);
    renderWeek(s);
  }
  renderActivity(s.usage);
  const src = s.plan ? (s.plan.source === 'statusline' ? 'statusline' : 'API') : '';
  $('#foot').replaceChildren(
    el('span', {}, s.plan ? `Atualizado ${ago(s.plan.fetchedAt)} · ${src}` : ''),
    el('span', {}, '≈ $ = preço de API (não cobrado)'),
  );
  $('#btn-refresh').classList.remove('spin');
  // scrollHeight = full content, even when the card is currently clipped
  requestAnimationFrame(() => window.clawd.panelHeight(document.getElementById('card').scrollHeight + 12));
}

window.clawd.onPanel((s) => { state = s; render(); });
$('#btn-refresh').addEventListener('click', (e) => { e.currentTarget.classList.add('spin'); window.clawd.refresh(); });
$('#btn-menu').addEventListener('click', () => window.clawd.menu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.clawd.closePanel(); });
setInterval(render, 30e3);
