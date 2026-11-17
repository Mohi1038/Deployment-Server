// Tiny SVG animation toolkit (1920x1080 design canvas, light theme)
const fs = require('fs');
const path = require('path');

const C = {
  bg: '#FFFFFF', dot: '#E5E9F0', ink: '#0F172A', slate: '#334155', muted: '#64748B', faint: '#94A3B8',
  line: '#E2E8F0', soft: '#F8FAFC', soft2: '#F1F5F9',
  coral: '#E8524A', coralSoft: '#FDECEA',
  blue: '#2563EB', blueSoft: '#DBEAFE',
  cyan: '#0891B2', cyanSoft: '#CFFAFE',
  green: '#16A34A', greenSoft: '#DCFCE7',
  amber: '#D97706', amberSoft: '#FEF3C7',
  red: '#DC2626', redSoft: '#FEE2E2',
  violet: '#7C3AED', violetSoft: '#EDE9FE',
};
const HEAD = 'Montserrat', BODY = 'Montserrat', MONO = 'DejaVu Sans Mono';

// ---------- timing ----------
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lin = (t, a, b) => clamp((t - a) / (b - a));
const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const seg = (t, a, b, e = easeIO) => e(lin(t, a, b));
const mix = (a, b, f) => a + (b - a) * f;
const pulse = (t, period = 1) => 0.5 - 0.5 * Math.cos((t / period) * 2 * Math.PI);

// ---------- text ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function text(x, y, s, o = {}) {
  const a = [`x="${x}"`, `y="${y}"`, `font-family="${o.family || BODY}"`, `font-size="${o.size || 28}"`,
    `font-weight="${o.weight || 500}"`, `fill="${o.fill || C.ink}"`];
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`);
  if (o.opacity !== undefined) a.push(`opacity="${o.opacity}"`);
  if (o.ls) a.push(`letter-spacing="${o.ls}"`);
  return `<text ${a.join(' ')}>${esc(s)}</text>`;
}
const mono = (x, y, s, o = {}) => text(x, y, s, { family: MONO, weight: 400, ...o });
// typed text: shows the first n characters
const typed = (s, f) => s.slice(0, Math.round(s.length * clamp(f)));

// ---------- shapes ----------
function card(x, y, w, h, o = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 18}" fill="${o.fill || C.bg}" stroke="${o.stroke || C.line}" stroke-width="${o.sw || 2}"${o.shadow === false ? '' : ' filter="url(#sh)"'}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
}
function pill(x, y, w, h, label, color, softColor, o = {}) {
  return `<g${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${softColor}" stroke="${o.stroke || 'none'}" stroke-width="2"/>` +
    text(x + w / 2, y + h / 2 + (o.size || 22) * 0.36, label, { size: o.size || 22, weight: 700, fill: color, anchor: 'middle', family: o.mono ? MONO : HEAD }) + '</g>';
}
function g(content, o = {}) {
  const tr = [];
  if (o.tx || o.ty) tr.push(`translate(${o.tx || 0} ${o.ty || 0})`);
  if (o.scale !== undefined && o.cx !== undefined) tr.push(`translate(${o.cx} ${o.cy}) scale(${o.scale}) translate(${-o.cx} ${-o.cy})`);
  return `<g${tr.length ? ` transform="${tr.join(' ')}"` : ''}${o.opacity !== undefined ? ` opacity="${clamp(o.opacity)}"` : ''}>${content}</g>`;
}
const circle = (cx, cy, r, fill, o = {}) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 2}"` : ''}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}/>`;
const line = (x1, y1, x2, y2, color, o = {}) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${o.w || 3}" stroke-linecap="round"${o.dash ? ` stroke-dasharray="${o.dash}" stroke-dashoffset="${o.offset || 0}"` : ''}${o.marker ? ` marker-end="url(#ah-${o.marker})"` : ''}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}/>`;
const pathEl = (d, color, o = {}) => `<path d="${d}" fill="${o.fill || 'none'}" stroke="${color}" stroke-width="${o.w || 3}" stroke-linecap="round" stroke-linejoin="round"${o.dash ? ` stroke-dasharray="${o.dash}" stroke-dashoffset="${o.offset || 0}"` : ''}${o.marker ? ` marker-end="url(#ah-${o.marker})"` : ''}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}/>`;

// draw a polyline progressively (0..1) using dasharray
function drawLine(pts, f, color, o = {}) {
  const len = polyLen(pts);
  const d = 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L ');
  if (f <= 0) return '';
  return pathEl(d, color, { ...o, dash: `${len} ${len}`, offset: len * (1 - clamp(f)), marker: f >= 0.98 ? o.marker : undefined });
}
// a flowing dashed connector (dashes move along the path)
function flowLine(pts, t, color, o = {}) {
  const d = 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L ');
  return pathEl(d, color, { w: o.w || 3, dash: o.dash || '10 12', offset: -((t * (o.speed || 120)) % 22), marker: o.marker, opacity: o.opacity });
}
function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
function along(pts, f) {
  const L = polyLen(pts) * clamp(f); let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const s = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + s >= L) { const k = (L - acc) / s; return [mix(pts[i - 1][0], pts[i][0], k), mix(pts[i - 1][1], pts[i][1], k)]; }
    acc += s;
  }
  return pts[pts.length - 1];
}
// glowing packet travelling along a path
function packet(pts, f, color, r = 11) {
  if (f <= 0 || f >= 1) return '';
  const [x, y] = along(pts, f);
  return circle(x, y, r * 2.1, color, { opacity: 0.16 }) + circle(x, y, r, color) + circle(x, y, r * 0.42, '#fff');
}

// ---------- icons ----------
function checkBadge(cx, cy, r, f = 1, color = C.green) {
  if (f <= 0) return '';
  const s = easeBack(clamp(f));
  return g(circle(cx, cy, r, color) + pathEl(`M ${cx - r * 0.42} ${cy + r * 0.02} L ${cx - r * 0.1} ${cy + r * 0.34} L ${cx + r * 0.45} ${cy - r * 0.3}`, '#fff', { w: r * 0.24 }),
    { scale: s, cx, cy });
}
function crossBadge(cx, cy, r, f = 1, color = C.red) {
  if (f <= 0) return '';
  const s = easeBack(clamp(f)), k = r * 0.36;
  return g(circle(cx, cy, r, color) + line(cx - k, cy - k, cx + k, cy + k, '#fff', { w: r * 0.22 }) + line(cx + k, cy - k, cx - k, cy + k, '#fff', { w: r * 0.22 }), { scale: s, cx, cy });
}
function spinner(cx, cy, r, t, color = C.blue) {
  const a = (t * 360 * 1.2) % 360;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.line}" stroke-width="${r * 0.28}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${r * 0.28}" stroke-linecap="round" stroke-dasharray="${r * 1.6} ${r * 10}" transform="rotate(${a} ${cx} ${cy})"/>`;
}
function userIcon(cx, cy, s, color = C.slate) {
  return circle(cx, cy - s * 0.32, s * 0.26, color) + `<path d="M ${cx - s * 0.48} ${cy + s * 0.5} Q ${cx - s * 0.48} ${cy + s * 0.02} ${cx} ${cy + s * 0.02} Q ${cx + s * 0.48} ${cy + s * 0.02} ${cx + s * 0.48} ${cy + s * 0.5} Z" fill="${color}"/>`;
}
function lockIcon(cx, cy, s, color = C.slate, open = 0) {
  return `<path d="M ${cx - s * 0.28} ${cy - s * 0.05} V ${cy - s * 0.3} A ${s * 0.28} ${s * 0.28} 0 0 1 ${cx + s * 0.28} ${cy - s * 0.3} V ${cy - s * 0.05 - open * s * 0.25}" fill="none" stroke="${color}" stroke-width="${s * 0.11}" stroke-linecap="round" transform="translate(0 ${-open * s * 0.12})"/>` +
    `<rect x="${cx - s * 0.42}" y="${cy - s * 0.08}" width="${s * 0.84}" height="${s * 0.62}" rx="${s * 0.1}" fill="${color}"/>` + circle(cx, cy + s * 0.2, s * 0.08, '#fff');
}
function serverIcon(x, y, w, h, color = C.slate) {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h * 0.12}" fill="${C.soft}" stroke="${color}" stroke-width="3"/>`;
  for (let i = 0; i < 3; i++) {
    const yy = y + h * (0.2 + i * 0.28);
    s += `<rect x="${x + w * 0.1}" y="${yy}" width="${w * 0.8}" height="${h * 0.18}" rx="4" fill="#fff" stroke="${C.line}" stroke-width="2"/>` + circle(x + w * 0.2, yy + h * 0.09, h * 0.035, color);
  }
  return s;
}
function commitIcon(cx, cy, r, color) {
  return line(cx - r * 2, cy, cx - r, cy, color, { w: r * 0.45 }) + line(cx + r, cy, cx + r * 2, cy, color, { w: r * 0.45 }) + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="${color}" stroke-width="${r * 0.45}"/>`;
}

// ---------- logos ----------
const LOGO_DIR = path.join(__dirname, 'img');
const logoCache = {};
function logoData(key) {
  if (!logoCache[key]) logoCache[key] = 'data:image/png;base64,' + fs.readFileSync(path.join(LOGO_DIR, key + '.png')).toString('base64');
  return logoCache[key];
}
function logo(key, x, y, s, o = {}) {
  const pad = s * (o.pad ?? 0.17);
  return (o.tile === false ? '' : `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.24}" fill="#fff" stroke="${C.line}" stroke-width="2"/>`) +
    `<image href="${logoData(key)}" x="${x + pad}" y="${y + pad}" width="${s - 2 * pad}" height="${s - 2 * pad}" preserveAspectRatio="xMidYMid meet"/>`;
}

// ---------- page chrome ----------
function defs() {
  const marker = (id, color) => `<marker id="ah-${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`;
  return `<defs>
  <filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="10"/><feOffset dy="8" result="b"/><feComponentTransfer><feFuncA type="linear" slope="0.10"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
  <pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="${C.dot}"/></pattern>
  ${['coral', 'blue', 'cyan', 'green', 'amber', 'red', 'muted', 'violet', 'slate'].map(k => marker(k, C[k])).join('')}
</defs>`;
}
/**
 * frame(): background, header, step caption + dots, progress bar.
 * o = { kicker, title, steps: [captions], step: index, stepF: 0..1 fade, t, dur }
 */
function frame(body, o) {
  const W = 1920, H = 1080;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs()}`;
  s += `<rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#dots)" opacity="0.7"/>`;
  // header
  s += logo('logo-mark', 96, 58, 64, { tile: false, pad: 0 });
  s += text(176, 86, o.kicker || 'DEPLOYMENT SERVER', { family: HEAD, size: 20, weight: 700, fill: C.coral, ls: 3 });
  s += text(176, 124, o.title, { family: HEAD, size: 38, weight: 700, fill: C.ink });
  s += body;
  // caption with step dots
  if (o.steps) {
    const n = o.steps.length, cy = 990, gap = 26, x0 = W / 2 - ((n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
      const active = i === o.step;
      s += active ? `<rect x="${x0 + i * gap - 14}" y="${cy - 26 - 7}" width="28" height="14" rx="7" fill="${C.coral}"/>` : circle(x0 + i * gap, cy - 26, 6, i < o.step ? '#F3A6A1' : C.line);
    }
    const cap = o.steps[Math.max(0, o.step)] || '';
    s += text(W / 2, cy + 26, cap, { family: HEAD, size: 30, weight: 600, fill: C.slate, anchor: 'middle', opacity: o.stepF ?? 1 });
  }
  // loop progress bar
  s += `<rect x="0" y="${H - 6}" width="${W}" height="6" fill="${C.soft2}"/><rect x="0" y="${H - 6}" width="${W * clamp(o.t / o.dur)}" height="6" fill="${C.coral}" opacity="0.85"/>`;
  return s + '</svg>';
}
// step index + caption fade from an array of start times
function stepAt(t, starts) {
  let i = 0; while (i + 1 < starts.length && t >= starts[i + 1]) i++;
  const f = Math.min(lin(t, starts[i], starts[i] + 0.35), i + 1 < starts.length ? 1 - lin(t, starts[i + 1] - 0.25, starts[i + 1]) : 1);
  return { step: i, stepF: f };
}

module.exports = { C, HEAD, BODY, MONO, clamp, lin, seg, mix, pulse, easeIO, easeOut, easeBack, esc, text, mono, typed, card, pill, g, circle, line,
  pathEl, drawLine, flowLine, along, packet, checkBadge, crossBadge, spinner, userIcon, lockIcon, serverIcon, commitIcon, logo, frame, stepAt };
