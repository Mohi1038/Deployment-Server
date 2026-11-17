// "The problem" as a flow diagram: a developer deploys by hand, step by step, on every platform.
const L = require('./lib');
const { C, HEAD, MONO, text, mono, card, pill, g, circle, line, pathEl, drawLine, flowLine, packet, checkBadge, crossBadge, spinner,
  logo, frame, lin, clamp, mix, easeIO, easeOut, easeBack, pulse, userIcon, lockIcon } = L;

// ---------- flow layout (1920x1080 canvas) ----------
const ROW_Y = 470;                                   // centre line of the step nodes
const NODES = [
  { x: 430, label: ['Create', 'a VM'], icon: 'vm' },
  { x: 612, label: ['Open', 'firewall'], icon: 'shield' },
  { x: 794, label: ['SSH', 'into it'], icon: 'term' },
  { x: 976, label: ['Install', 'Docker + NGINX'], icon: 'install' },
  { x: 1158, label: ['Hand-edit', 'NGINX config'], icon: 'edit' },
  { x: 1340, label: ['Get HTTPS', 'certificate'], icon: 'cert' },
  { x: 1522, label: ['Check', 'the URL'], icon: 'check' },
];
const NS = 128; // node size
const PLATFORMS = ['gcp', 'aws', 'azure', 'digitalocean'];
const PLAT_NAMES = ['Google Cloud', 'AWS', 'Azure', 'DigitalOcean'];
const PERSON = { x: 190, y: ROW_Y };

// ---------- timeline ----------
function buildPlan() {
  const ev = []; let t = 0.7;
  const speeds = [0.55, 0.3, 0.27, 0.25];
  PLATFORMS.forEach((p, pi) => {
    const d = speeds[pi], pStart = t;
    for (let i = 0; i < 6; i++) { ev.push({ pi, node: i, a: t, b: t + d }); t += d; }
    const fail = pi === 0 || pi === 2;
    ev.push({ pi, node: 6, a: t, b: t + d * 1.2, result: fail ? 'fail' : 'ok' }); t += d * 1.2;
    if (fail) {
      ev.push({ pi, node: 'loop', a: t, b: t + (pi === 0 ? 1.1 : 0.6) }); t += pi === 0 ? 1.1 : 0.6;
      for (const i of [4, 5]) { ev.push({ pi, node: i, a: t, b: t + d, redo: true }); t += d; }
      ev.push({ pi, node: 6, a: t, b: t + d * 1.2, result: 'ok' }); t += d * 1.2;
    }
    ev.push({ pi, node: 'done', a: t, b: t + 0.45 }); t += 0.45;
    ev.pStart = ev.pStart || []; ev.pStart[pi] = pStart;
  });
  ev.end = t;
  return ev;
}
const PLAN = buildPlan();
const END = PLAN.end, DUR = END + 3.6;

const nodePos = (n) => (typeof n === 'number' ? [NODES[n].x, ROW_Y] : null);
// routed around the node labels: exits the right side of 'Check', runs under the labels, enters the left side of 'Hand-edit'
const LOOP_R = NODES[6].x + NS / 2 + 28, LOOP_L = NODES[4].x - NS / 2 - 26, LOOP_IN = ROW_Y + 34;
const LOOP_PTS = [[NODES[6].x + NS / 2 + 6, LOOP_IN], [LOOP_R, LOOP_IN], [LOOP_R, ROW_Y + 200], [LOOP_L, ROW_Y + 200], [LOOP_L, LOOP_IN], [NODES[4].x - NS / 2 - 6, LOOP_IN]];

// ---------- icons ----------
function icon(kind, cx, cy, col) {
  const s = 1;
  switch (kind) {
    case 'vm': return `<rect x="${cx - 34}" y="${cy - 30}" width="68" height="60" rx="8" fill="none" stroke="${col}" stroke-width="5"/>` +
      line(cx - 22, cy - 10, cx + 22, cy - 10, col, { w: 5 }) + line(cx - 22, cy + 8, cx + 22, cy + 8, col, { w: 5 }) + circle(cx + 20, cy - 10, 1, col);
    case 'shield': return `<path d="M ${cx} ${cy - 36} L ${cx + 30} ${cy - 24} V ${cy + 2} C ${cx + 30} ${cy + 20} ${cx + 14} ${cy + 32} ${cx} ${cy + 38} C ${cx - 14} ${cy + 32} ${cx - 30} ${cy + 20} ${cx - 30} ${cy + 2} V ${cy - 24} Z" fill="none" stroke="${col}" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="M ${cx - 12} ${cy} l 9 9 l 16 -18" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'term': return `<rect x="${cx - 38}" y="${cy - 30}" width="76" height="60" rx="9" fill="none" stroke="${col}" stroke-width="5"/>` +
      `<path d="M ${cx - 22} ${cy - 10} l 12 10 l -12 10 M ${cx + 2} ${cy + 12} h 18" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'install': return logo('docker', cx - 44, cy - 26, 52, { tile: false, pad: 0 }) + logo('nginx', cx + 0, cy - 26, 48, { tile: false, pad: 0 });
    case 'edit': return `<path d="M ${cx - 26} ${cy - 34} h 34 l 18 18 v 50 h -52 z" fill="none" stroke="${col}" stroke-width="5" stroke-linejoin="round"/>` +
      line(cx - 16, cy - 6, cx + 14, cy - 6, col, { w: 4 }) + line(cx - 16, cy + 8, cx + 14, cy + 8, col, { w: 4 }) + line(cx - 16, cy + 22, cx + 2, cy + 22, col, { w: 4 });
    case 'cert': return logo('letsencrypt', cx - 32, cy - 34, 64, { tile: false, pad: 0 });
    case 'check': return `<circle cx="${cx}" cy="${cy}" r="32" fill="none" stroke="${col}" stroke-width="5"/>` +
      `<path d="M ${cx - 32} ${cy} H ${cx + 32} M ${cx} ${cy - 32} C ${cx - 16} ${cy - 14} ${cx - 16} ${cy + 14} ${cx} ${cy + 32} M ${cx} ${cy - 32} C ${cx + 16} ${cy - 14} ${cx + 16} ${cy + 14} ${cx} ${cy + 32}" fill="none" stroke="${col}" stroke-width="4"/>`;
  }
  return '';
}

function laptopPerson(cx, cy) {
  // person behind a laptop
  return userIcon(cx, cy - 34, 120, C.slate) +
    `<path d="M ${cx - 70} ${cy + 18} h 140 l 18 30 h -176 z" fill="#fff" stroke="${C.slate}" stroke-width="5" stroke-linejoin="round"/>` +
    `<rect x="${cx - 58}" y="${cy - 34}" width="116" height="56" rx="6" fill="#fff" stroke="${C.slate}" stroke-width="5"/>` +
    mono(cx - 40, cy + 2, '>_', { size: 26, weight: 700, fill: C.coral });
}

module.exports = [{
  name: '00-problem', dur: DUR, sizes: [1280, 960, 640],
  draw(t) {
    const fade = 1 - lin(t, DUR - 0.45, DUR);
    // current event / platform
    let cur = PLAN.filter(e => e.a <= t).pop() || PLAN[0];
    const pi = t >= END ? 3 : cur.pi;
    const pStart = PLAN.pStart[pi];
    let s = '';

    // ---- person ----
    s += card(PERSON.x - 115, ROW_Y - 150, 230, 300, { r: 26 });
    s += laptopPerson(PERSON.x, ROW_Y + 10);
    s += text(PERSON.x, ROW_Y + 120, 'You', { family: HEAD, size: 30, weight: 700, anchor: 'middle' });

    // ---- connectors ----
    const firstX = NODES[0].x - NS / 2;
    s += line(PERSON.x + 115, ROW_Y, firstX - 8, ROW_Y, C.line, { w: 5 });
    for (let i = 0; i < 6; i++) s += line(NODES[i].x + NS / 2 + 8, ROW_Y, NODES[i + 1].x - NS / 2 - 8, ROW_Y, C.line, { w: 5 });
    // retry loop path (appears when a check fails)
    const loopEv = PLAN.filter(e => e.node === 'loop' && e.pi === pi)[0];
    if (loopEv && t >= loopEv.a - 0.05 && t < PLAN.pStart.concat([END + 9])[pi + 1]) {
      s += drawLine(LOOP_PTS, lin(t, loopEv.a, loopEv.a + 0.35), C.red, { w: 5, dash: undefined, marker: 'red' });
      s += pill((NODES[4].x + NODES[6].x) / 2 - 120, ROW_Y + 176, 240, 48, 'fix & retry', C.red, C.redSoft, { size: 24, opacity: lin(t, loopEv.a + 0.2, loopEv.a + 0.5) });
    }

    // ---- nodes ----
    NODES.forEach((n, i) => {
      const evs = PLAN.filter(e => e.pi === pi && e.node === i && t >= e.a);
      const last = evs[evs.length - 1];
      const active = last && t < last.b;
      const done = last && t >= last.b && last.result !== 'fail';
      const failed = last && t >= last.b && last.result === 'fail';
      const stroke = failed ? C.red : active ? C.coral : done ? '#86EFAC' : C.line;
      const fill = failed ? '#FEF2F2' : active ? '#FFF7F6' : '#fff';
      const pop = active ? easeBack(lin(t, last.a, last.a + 0.25)) : 1;
      let b = `<rect x="${n.x - NS / 2}" y="${ROW_Y - NS / 2}" width="${NS}" height="${NS}" rx="30" fill="${fill}" stroke="${stroke}" stroke-width="${active || failed ? 6 : 4}" filter="url(#sh)"/>`;
      if (active) b += `<rect x="${n.x - NS / 2 - 12}" y="${ROW_Y - NS / 2 - 12}" width="${NS + 24}" height="${NS + 24}" rx="38" fill="none" stroke="${C.coral}" stroke-width="3" opacity="${0.2 + 0.3 * pulse(t, 0.8)}"/>`;
      b += icon(n.icon, n.x, ROW_Y, failed ? C.red : active ? C.coral : done ? C.slate : C.faint);
      if (done) b += checkBadge(n.x + NS / 2 - 6, ROW_Y - NS / 2 + 6, 20, lin(t, last.b, last.b + 0.2));
      if (failed) b += crossBadge(n.x + NS / 2 - 6, ROW_Y - NS / 2 + 6, 20, lin(t, last.b, last.b + 0.2));
      s += g(b, { scale: active ? mix(0.94, 1, pop) : 1, cx: n.x, cy: ROW_Y });
      s += text(n.x, ROW_Y + NS / 2 + 44, n.label[0], { family: HEAD, size: 27, weight: 700, anchor: 'middle', fill: active || done || failed ? C.ink : C.faint });
      s += text(n.x, ROW_Y + NS / 2 + 78, n.label[1], { size: 21, weight: 500, anchor: 'middle', fill: active || done || failed ? C.muted : C.faint });
      if (failed) s += g(pill(n.x - 125, ROW_Y - NS / 2 - 92, 250, 56, '502 Bad Gateway', C.red, C.redSoft, { mono: true, size: 25 }),
        { opacity: lin(t, last.b, last.b + 0.2), tx: Math.sin(t * 55) * 7 * (1 - lin(t, last.b, last.b + 0.5)) });
      if (done && i === 6) s += g(pill(n.x - 90, ROW_Y - NS / 2 - 92, 180, 56, 'HTTP 200', C.green, C.greenSoft, { mono: true, size: 25 }), { opacity: lin(t, last.b, last.b + 0.2) });
    });

    // ---- the person's "hand" travelling through the flow ----
    if (t < END) {
      let pos;
      if (cur.node === 'loop') pos = L.along(LOOP_PTS, easeIO(lin(t, cur.a, cur.b)));
      else if (cur.node === 'done') pos = [mix(NODES[6].x, NODES[6].x + 40, lin(t, cur.a, cur.b)), ROW_Y - NS / 2 - 20];
      else {
        const idx = PLAN.indexOf(cur), prev = PLAN[idx - 1];
        let from;
        if (!prev || prev.pi !== cur.pi || prev.node === 'done') from = [PERSON.x + 115, ROW_Y];
        else if (prev.node === 'loop') from = [NODES[4].x, ROW_Y + NS / 2];
        else from = nodePos(prev.node);
        const to = nodePos(cur.node);
        const f = easeIO(lin(t, cur.a, cur.a + (cur.b - cur.a) * 0.45));
        pos = [mix(from[0], to[0], f), mix(from[1], to[1], f) - NS / 2 - 26 * Math.sin(Math.PI * f) - 8];
        if (f >= 1) pos = [to[0], to[1] - NS / 2 - 8];
      }
      if (cur.node !== 'done') {
        const [hx, hy] = pos;
        s += circle(hx, hy, 34, C.coral, { opacity: 0.15 }) + circle(hx, hy, 24, C.coral) + userIcon(hx, hy + 2, 26, '#fff');
      }
    }

    // ---- platforms column ----
    s += text(1780, 230, 'PLATFORMS', { family: HEAD, size: 18, weight: 700, fill: C.muted, ls: 3, anchor: 'middle' });
    PLATFORMS.forEach((p, k) => {
      const y = 262 + k * 150, isCur = k === pi && t < END, done = PLAN.filter(e => e.pi === k && e.node === 'done' && t >= e.b).length > 0;
      s += `<rect x="1712" y="${y}" width="136" height="128" rx="22" fill="#fff" stroke="${isCur ? C.coral : done ? '#86EFAC' : C.line}" stroke-width="${isCur ? 5 : 3}" filter="url(#sh)"/>`;
      s += g(logo(p, 1744, y + 14, 72, { tile: false, pad: 0 }), { opacity: isCur || done ? 1 : 0.4 });
      s += text(1780, y + 114, PLAT_NAMES[k], { size: 17, weight: 600, anchor: 'middle', fill: isCur || done ? C.slate : C.faint });
      if (done) s += checkBadge(1842, y + 6, 17, 1);
    });

    // ---- counter ----
    const actions = PLAN.filter(e => typeof e.node === 'number' && t >= e.b).length;
    s += card(96, 780, 470, 110, { r: 22 });
    s += text(130, 828, 'MANUAL STEPS SO FAR', { family: HEAD, size: 18, weight: 700, fill: C.muted, ls: 2 });
    s += text(130, 872, String(actions), { family: HEAD, size: 40, weight: 800, fill: C.coral });
    s += text(230, 872, `platforms done: ${t >= END ? 4 : pi + (cur.node === 'done' && t >= cur.b ? 1 : 0)} / 4`, { size: 24, weight: 600, fill: C.slate });

    // ---- end card ----
    if (t >= END) {
      const f = lin(t, END, END + 0.5);
      s += g(card(620, 780, 1040, 110, { r: 22, stroke: '#F3B3AE', fill: C.coralSoft }) +
        `<g transform="rotate(${(t * 140) % 360} 700 835)"><path d="M 684 826 A 20 20 0 1 1 686 848" fill="none" stroke="${C.coral}" stroke-width="5" stroke-linecap="round"/><path d="M 676 816 L 684 828 L 696 819" fill="none" stroke="${C.coral}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></g>` +
        text(744, 848, 'Same manual steps. Every platform. Every app.', { family: HEAD, size: 34, weight: 700, fill: C.coral }), { opacity: f, ty: 14 * (1 - easeOut(f)) });
    }

    // captions
    const p0 = PLAN.pStart;
    const firstFail = PLAN.find(e => e.result === 'fail').b;
    const starts = [0, firstFail, p0[1], END];
    let step = 0; while (step + 1 < starts.length && t >= starts[step + 1]) step++;
    const stepF = Math.min(lin(t, starts[step], starts[step] + 0.35), step + 1 < starts.length ? 1 - lin(t, starts[step + 1] - 0.25, starts[step + 1]) : 1);
    return frame(g(s, { opacity: fade }), {
      title: 'Deploying by hand, platform after platform', kicker: 'THE PROBLEM', t, dur: DUR, step, stepF,
      steps: ['Every deploy is the same chain of manual steps', 'One mistake in the config: 502, back to editing', 'Next platform? Do it all again', 'Repetitive, error-prone and invisible to the team'],
    });
  },
}];
