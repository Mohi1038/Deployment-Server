const L = require('./lib');
const { C, HEAD, MONO, text, mono, card, pill, g, circle, line, pathEl, drawLine, flowLine, packet, checkBadge, crossBadge,
  spinner, logo, frame, stepAt, seg, lin, clamp, mix, typed, easeOut, easeBack, pulse, userIcon, lockIcon, serverIcon, commitIcon } = L;

const scenes = [];
const fadeLoop = (t, dur) => 1 - lin(t, dur - 0.45, dur); // fade everything out before looping

// =====================================================================
// 01 — Overview: issue → bot → server → VM → live URL
// =====================================================================
scenes.push({
  name: '01-overview', dur: 12,
  draw(t) {
    const starts = [0, 1.8, 3.7, 5.6, 8.0];
    const { step, stepF } = stepAt(t, starts);
    const fade = fadeLoop(t, this.dur);
    const nodes = [
      { logo: 'github', title: 'GitHub issue', sub: 'comment' },
      { logo: 'probot', title: 'DeployBase bot', sub: 'Probot · ChatOps' },
      { logo: 'nodedotjs', title: 'Deployment Server', sub: 'API · SQLite' },
      { logo: 'gcp', title: 'Cloud VM', sub: 'GCP · AWS · Azure · DO' },
      { logo: null, title: 'Live URL', sub: 'health-checked' },
    ];
    const cw = 318, ch = 270, cy = 300, xs = [96, 448, 800, 1152, 1504];
    let s = '';
    // connectors
    for (let i = 0; i < 4; i++) {
      const x1 = xs[i] + cw + 12, x2 = xs[i + 1] - 12, y = cy + ch / 2;
      s += line(x1, y, x2, y, C.line, { w: 4 });
      const done = t >= starts[i + 1];
      if (done) s += flowLine([[x1, y], [x2, y]], t, C.coral, { w: 4 });
      const travel = lin(t, starts[i + 1] - 0.9, starts[i + 1] - 0.05);
      s += packet([[x1 - 20, y], [x2 + 20, y]], travel, C.coral, 12);
    }
    nodes.forEach((n, i) => {
      const active = step === i, done = t >= starts[i] && step > i, on = t >= starts[i] - 0.05;
      const pop = on ? easeBack(lin(t, starts[i], starts[i] + 0.45)) : 0;
      const sc = on ? mix(0.96, 1, pop) : 0.96;
      const x = xs[i], cx = x + cw / 2;
      const stroke = active ? C.coral : done ? '#F3B3AE' : C.line;
      let b = card(x, cy, cw, ch, { stroke, sw: active ? 4 : 2, r: 24 });
      if (active) b += `<rect x="${x - 10}" y="${cy - 10}" width="${cw + 20}" height="${ch + 20}" rx="32" fill="none" stroke="${C.coral}" stroke-width="2" opacity="${0.25 + 0.25 * pulse(t, 1.2)}"/>`;
      if (n.logo) b += logo(n.logo, cx - 46, cy + 34, 92);
      else b += circle(cx, cy + 80, 46, i === 4 && on ? C.greenSoft : C.soft2) + `<g transform="translate(${cx - 26} ${cy + 54})"><circle cx="26" cy="26" r="24" fill="none" stroke="${on ? C.green : C.faint}" stroke-width="4"/><path d="M2 26 H50 M26 2 C14 14 14 38 26 50 M26 2 C38 14 38 38 26 50" fill="none" stroke="${on ? C.green : C.faint}" stroke-width="3"/></g>`;
      b += text(cx, cy + 172, n.title, { family: HEAD, size: 28, weight: 700, anchor: 'middle', fill: on ? C.ink : C.faint });
      b += text(cx, cy + 210, n.sub, { size: 22, anchor: 'middle', fill: C.muted, opacity: on ? 1 : 0.6 });
      if (done || (i === 4 && t > starts[4] + 1.2)) b += checkBadge(x + cw - 6, cy + 6, 24, lin(t, (i === 4 ? starts[4] + 1.2 : starts[i + 1]), (i === 4 ? starts[4] + 1.6 : starts[i + 1] + 0.35)));
      s += g(b, { scale: sc, cx, cy: cy + ch / 2, opacity: on ? 1 : 0.55 });
    });
    // detail panel under the active node
    const px = 96, py = 640, pw = 1726, ph = 230;
    s += card(px, py, pw, ph, { r: 24, fill: C.soft });
    const detail = [
      () => { // typing the command
        const cmd = typed('/deploy gcp', lin(t, 0.4, 1.3));
        return userIcon(px + 90, py + 112, 70, C.slate) +
          text(px + 160, py + 92, '@mohit commented', { size: 24, weight: 700, fill: C.slate }) +
          card(px + 160, py + 112, 520, 70, { r: 12, shadow: false, fill: '#fff' }) +
          mono(px + 186, py + 158, cmd + (Math.floor(t * 3) % 2 ? '▍' : ' '), { size: 32, fill: C.coral, weight: 700 }) +
          text(px + 740, py + 158, 'one command, no deploy config', { size: 26, fill: C.muted });
      },
      () => {
        const f = lin(t, starts[1] + 0.2, starts[1] + 1.2);
        return logo('probot', px + 50, py + 70, 90) +
          text(px + 170, py + 98, 'Bot replies on the issue:', { size: 24, weight: 700, fill: C.slate }) +
          mono(px + 170, py + 148, typed('⏳ Provisioning a VM, building the app, checking the URL…', f), { size: 26, fill: C.ink }) +
          mono(px + 170, py + 196, typed('POST /api/deployments   (service token)', lin(t, starts[1] + 0.9, starts[1] + 1.6)), { size: 24, fill: C.blue });
      },
      () => {
        const items = ['Inputs validated', 'Credential chosen (cheapest verified)', 'Deployment #42 recorded'];
        return items.map((it, k) => {
          const f = lin(t, starts[2] + 0.2 + k * 0.45, starts[2] + 0.55 + k * 0.45);
          return checkBadge(px + 90 + k * 560, py + 115, 22, f) + text(px + 128 + k * 560, py + 124, it, { size: 26, weight: 600, fill: C.slate, opacity: f });
        }).join('') + pill(px + 1460, py + 92, 200, 46, 'pending', C.muted, C.soft2, { mono: true });
      },
      () => {
        const f = lin(t, starts[3] + 0.2, starts[4] - 0.3);
        const phases = ['terraform apply', 'Docker + NGINX', 'clone + build', 'start app'];
        let r = text(px + 60, py + 84, 'Provisioning and building on the VM', { size: 26, weight: 700, fill: C.slate });
        r += `<rect x="${px + 60}" y="${py + 112}" width="${pw - 120}" height="18" rx="9" fill="${C.line}"/><rect x="${px + 60}" y="${py + 112}" width="${(pw - 120) * f}" height="18" rx="9" fill="${C.coral}"/>`;
        phases.forEach((p, k) => {
          const doneK = f >= (k + 1) / phases.length - 0.01, act = f >= k / phases.length && !doneK;
          r += (doneK ? checkBadge(px + 80 + k * 400, py + 180, 16, 1) : act ? spinner(px + 80 + k * 400, py + 180, 14, t, C.coral) : circle(px + 80 + k * 400, py + 180, 12, C.line));
          r += mono(px + 108 + k * 400, py + 188, p, { size: 24, fill: doneK || act ? C.ink : C.faint });
        });
        return r;
      },
      () => {
        const f = lin(t, starts[4] + 0.1, starts[4] + 0.6);
        let r = `<g opacity="${f}">` + card(px + 60, py + 50, 1000, 130, { r: 16, shadow: false, fill: '#fff' }) +
          circle(px + 100, py + 82, 8, '#FCA5A5') + circle(px + 126, py + 82, 8, '#FCD34D') + circle(px + 152, py + 82, 8, '#86EFAC') +
          card(px + 190, py + 66, 840, 34, { r: 17, shadow: false, fill: C.soft2, stroke: C.soft2 }) +
          lockIcon(px + 218, py + 84, 22, C.green) +
          mono(px + 240, py + 92, 'https://myapp.34.93.12.8.sslip.io', { size: 22, fill: C.slate }) +
          text(px + 100, py + 154, 'Your app is live', { family: HEAD, size: 30, weight: 700 }) + '</g>';
        const probe = lin(t, starts[4] + 0.6, starts[4] + 1.2);
        r += pill(px + 1120, py + 82, 260, 56, probe >= 1 ? 'HTTP 200' : 'probing…', probe >= 1 ? C.green : C.amber, probe >= 1 ? C.greenSoft : C.amberSoft, { mono: true, size: 26 });
        r += text(px + 1410, py + 120, 'Posted to the issue', { size: 26, weight: 600, fill: C.slate, opacity: lin(t, starts[4] + 1.3, starts[4] + 1.7) });
        return r;
      },
    ];
    s += g(detail[step](), { opacity: stepF });
    return frame(g(s, { opacity: fade }), { title: 'From a GitHub comment to a live app', kicker: 'DEPLOYMENT SERVER · OVERVIEW', t, dur: this.dur, step, stepF,
      steps: ['A developer comments /deploy gcp on a GitHub issue', 'The DeployBase bot picks up the command and calls the API',
        'Deployment Server validates the request and records it', 'A cloud VM is provisioned and the app is built on it', 'The public URL is health-checked and posted back to the issue'] });
  },
});

module.exports = scenes.concat(require('./scenes2'));
