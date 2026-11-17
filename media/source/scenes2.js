const L = require('./lib');
const { C, HEAD, MONO, text, mono, card, pill, g, circle, line, pathEl, drawLine, flowLine, packet, checkBadge, crossBadge,
  spinner, logo, frame, stepAt, seg, lin, clamp, mix, typed, easeOut, easeBack, pulse, userIcon, lockIcon, serverIcon, commitIcon } = L;
const fadeLoop = (t, dur) => 1 - lin(t, dur - 0.45, dur);
const slideIn = (t, a, d = 0.45) => ({ opacity: lin(t, a, a + d), ty: 24 * (1 - easeOut(lin(t, a, a + d))) });
const scenes = [];

// =====================================================================
// 02 — ChatOps on a GitHub issue
// =====================================================================
scenes.push({
  name: '02-chatops', dur: 13,
  draw(t) {
    const starts = [0, 2.0, 3.0, 8.6, 9.6];
    const { step, stepF } = stepAt(t, starts);
    const X = 300, Y = 168, W = 1320, H = 770;
    let s = card(X, Y, W, H, { r: 20 });
    // window header
    s += `<rect x="${X}" y="${Y}" width="${W}" height="70" rx="20" fill="${C.soft}"/><rect x="${X}" y="${Y + 50}" width="${W}" height="20" fill="${C.soft}"/>` + line(X, Y + 70, X + W, Y + 70, C.line, { w: 2 });
    s += logo('github', X + 24, Y + 13, 44, { tile: false, pad: 0 });
    s += text(X + 84, Y + 45, 'Mohi1038 / portfolio-site', { size: 24, weight: 600, fill: C.slate });
    s += text(X + W - 130, Y + 45, 'Issues', { size: 22, weight: 700, fill: C.ink }) + `<rect x="${X + W - 134}" y="${Y + 62}" width="80" height="4" rx="2" fill="${C.coral}"/>`;
    // issue title + state
    s += text(X + 40, Y + 130, 'Ship the new landing page', { family: HEAD, size: 34, weight: 700 }) + text(X + 560, Y + 130, '#12', { family: HEAD, size: 34, weight: 500, fill: C.faint });
    const closed = t >= 10.2;
    s += pill(X + 40, Y + 150, 130, 40, closed ? 'Closed' : 'Open', '#fff', closed ? C.violet : C.green, { size: 20 });
    const lab = lin(t, 9.6, 10.0);
    if (lab > 0) s += g(pill(X + 190, Y + 150, 150, 40, 'deployed', C.green, C.greenSoft, { size: 20 }), { opacity: lab, scale: easeBack(lab), cx: X + 265, cy: Y + 170 });
    s += line(X + 40, Y + 214, X + W - 40, Y + 214, C.line, { w: 2 });
    // composer (before posting)
    const cy0 = Y + 240;
    if (t < 2.2) {
      const typedCmd = typed('/deploy gcp', lin(t, 0.4, 1.4));
      let c = card(X + 120, cy0, W - 160, 150, { r: 14, shadow: false });
      c += mono(X + 150, cy0 + 60, typedCmd + (t < 1.6 && Math.floor(t * 3) % 2 ? '▍' : ''), { size: 32, weight: 700, fill: C.coral });
      const press = lin(t, 1.6, 1.8);
      c += `<rect x="${X + W - 230}" y="${cy0 + 90}" width="170" height="44" rx="10" fill="${C.green}" opacity="${0.85 + 0.15 * press}"/>` + text(X + W - 145, cy0 + 120, 'Comment', { size: 22, weight: 700, fill: '#fff', anchor: 'middle' });
      c += userIcon(X + 70, cy0 + 50, 52, C.slate);
      s += g(c, { opacity: 1 - lin(t, 1.9, 2.15) });
    }
    // user comment
    if (t >= 2.0) {
      const a = slideIn(t, 2.0);
      let c = userIcon(X + 70, cy0 + 40, 52, C.slate) + card(X + 120, cy0, W - 160, 110, { r: 14, shadow: false });
      c += `<rect x="${X + 121}" y="${cy0 + 1}" width="${W - 162}" height="44" rx="13" fill="${C.soft}"/>` + text(X + 144, cy0 + 31, 'mohit', { size: 22, weight: 700 }) + text(X + 222, cy0 + 31, 'commented just now', { size: 22, fill: C.muted });
      c += mono(X + 144, cy0 + 88, '/deploy gcp', { size: 28, weight: 700, fill: C.coral });
      s += g(c, a);
    }
    // bot comment
    const by = cy0 + 140;
    if (t >= 3.0) {
      const a = slideIn(t, 3.0);
      const live = t >= 8.6, morph = lin(t, 8.6, 9.0);
      let c = logo('probot', X + 40, by, 60) + card(X + 120, by, W - 160, 330, { r: 14, shadow: false, stroke: live ? '#86EFAC' : C.line });
      c += `<rect x="${X + 121}" y="${by + 1}" width="${W - 162}" height="44" rx="13" fill="${live ? '#F0FDF4' : C.soft}"/>` + text(X + 144, by + 31, 'deploybase', { size: 22, weight: 700 }) +
        pill(X + 274, by + 12, 56, 24, 'bot', C.muted, C.soft2, { size: 15 }) + text(X + 344, by + 31, live ? 'edited this comment' : 'commented just now', { size: 22, fill: C.muted });
      if (!live || morph < 1) {
        let p = spinner(X + 160, by + 92, 14, t, C.amber) + text(X + 190, by + 101, 'Deployment Server: provisioning a VM, building the app, checking the URL', { size: 25, weight: 700 });
        const tasks = [['Provision VM on GCP (Terraform)', 3.4, 5.0], ['Build and start the app', 5.0, 7.0], ['Health-check the public URL', 7.0, 8.3]];
        tasks.forEach(([lbl, a0, a1], k) => {
          const yy = by + 160 + k * 56;
          p += t >= a1 ? checkBadge(X + 172, yy - 8, 16, lin(t, a1, a1 + 0.3)) : t >= a0 ? spinner(X + 172, yy - 8, 13, t, C.coral) : circle(X + 172, yy - 8, 12, C.line);
          p += text(X + 204, yy, lbl, { size: 24, fill: t >= a0 ? C.slate : C.faint, weight: 500 });
        });
        c += g(p, { opacity: 1 - morph });
      }
      if (live) {
        let p = checkBadge(X + 162, by + 92, 18, lin(t, 8.6, 8.9)) + text(X + 192, by + 101, 'Deployment Server: live', { size: 27, weight: 700, fill: C.green });
        const rows = [['URL', 'https://portfolio-site.34.93.12.8.sslip.io', C.blue], ['Cloud', 'GCP · e2-micro', C.slate], ['Deployment', '#42', C.slate], ['Health check', 'HTTP 200 through NGINX', C.green]];
        rows.forEach(([k, v, col], i) => {
          const yy = by + 160 + i * 46;
          p += text(X + 160, yy, k, { size: 23, weight: 700, fill: C.muted }) + mono(X + 360, yy, v, { size: 23, fill: col, weight: i === 0 ? 700 : 400 });
          if (i < rows.length - 1) p += line(X + 160, yy + 16, X + W - 80, yy + 16, C.soft2, { w: 2 });
        });
        c += g(p, { opacity: morph });
      }
      s += g(c, a);
    }
    return frame(g(s, { opacity: fadeLoop(t, this.dur) }), { title: 'ChatOps: deploy from a GitHub comment', kicker: 'DEPLOYMENT SERVER · GITHUB BOT', t, dur: this.dur, step, stepF,
      steps: ['Comment /deploy gcp on any issue', 'The command is posted to the issue', 'The bot answers and tracks progress live', 'The same comment turns into the live URL', 'Labelled and closed: the issue is the deployment record'] });
  },
});

// =====================================================================
// 03 — Lifecycle: state machine + live log stream
// =====================================================================
scenes.push({
  name: '03-lifecycle-live-logs', dur: 13,
  draw(t) {
    const starts = [0, 1.2, 2.4, 5.2, 8.8, 10.2];
    const { step, stepF } = stepAt(t, starts);
    const states = [['pending', C.muted, C.soft2], ['verifying', C.blue, C.blueSoft], ['provisioning', C.violet, C.violetSoft], ['configuring', C.amber, C.amberSoft], ['health check', C.cyan, C.cyanSoft], ['ready', C.green, C.greenSoft]];
    let s = text(96, 220, 'STATUS', { family: HEAD, size: 20, weight: 700, fill: C.muted, ls: 3 });
    const sx = 96, sy = 250, gap = 108;
    s += line(sx + 28, sy + 30, sx + 28, sy + 30 + gap * 5, C.line, { w: 4 });
    s += drawLine([[sx + 28, sy + 30], [sx + 28, sy + 30 + gap * 5]], clamp((t >= starts[5] ? 5 : step + lin(t, starts[step], starts[step] + 0.5) * 0) / 5), C.coral, { w: 4 });
    states.forEach(([n, col, soft], i) => {
      const y = sy + i * gap, on = step >= i, act = step === i;
      s += circle(sx + 28, y + 30, act ? 18 : 14, on ? col : '#fff', { stroke: on ? col : C.line, sw: 3 });
      if (act) s += circle(sx + 28, y + 30, 28 + 6 * pulse(t, 1), col, { opacity: 0.15 });
      if (on && !act) s += pathEl(`M ${sx + 21} ${y + 30} l 5 5 l 9 -10`, '#fff', { w: 3 });
      s += pill(sx + 70, y + 8, 250, 46, n, on ? col : C.faint, on ? soft : C.soft, { mono: true, size: 23 });
    });
    s += g(pill(sx + 70, sy + gap * 6 - 20, 120, 40, 'failed', C.red, C.redSoft, { mono: true, size: 19 }) + pill(sx + 200, sy + gap * 6 - 20, 150, 40, 'degraded', C.amber, C.amberSoft, { mono: true, size: 19 }), { opacity: 0.75 });
    // log panel
    const lx = 560, ly = 180, lw = 1264, lh = 740;
    s += card(lx, ly, lw, lh, { r: 20 });
    s += `<rect x="${lx}" y="${ly}" width="${lw}" height="64" rx="20" fill="${C.soft}"/><rect x="${lx}" y="${ly + 44}" width="${lw}" height="20" fill="${C.soft}"/>` + line(lx, ly + 64, lx + lw, ly + 64, C.line, { w: 2 });
    s += text(lx + 28, ly + 42, 'Deployment #42 · live log', { family: HEAD, size: 24, weight: 700 });
    s += circle(lx + lw - 210, ly + 34, 7, C.red, { opacity: 0.5 + 0.5 * pulse(t, 1) }) + text(lx + lw - 194, ly + 42, 'LIVE · SSE', { family: HEAD, size: 20, weight: 700, fill: C.red });
    const logs = [
      [0.3, '[API]', 'Deployment #42 queued · gcp · e2-micro', C.blue],
      [1.3, '[Prep]', 'Per-deployment SSH key + startup script generated', C.blue],
      [2.5, '[Terraform]', 'google_compute_firewall.app_firewall: Creating...', C.violet],
      [3.3, '[Terraform]', 'google_compute_instance.app_instance: Creation complete', C.violet],
      [4.1, '[VM]', 'devlups-myapp-4821 is up at 34.93.12.8', C.violet],
      [5.3, '[Engine]', 'Installing Docker Engine...', C.amber],
      [6.0, '[Engine]', 'Cloning github.com/Mohi1038/myapp (main)...', C.amber],
      [6.7, '[Engine]', 'Detected Dockerfile (container port 8080). Building image...', C.amber],
      [7.5, '[Engine]', 'Stack mode: docker', C.amber],
      [8.1, '[Engine]', 'Universal Cloud Deployment Completed Successfully', C.green],
      [8.9, '[HealthCheck]', 'Probe 1/60: pending (default NGINX page)', C.cyan],
      [9.7, '[HealthCheck]', 'Probe 2/60: SUCCESS! HTTP 200 in 84 ms', C.green],
      [10.3, '[Ready]', 'Verified live at http://34.93.12.8', C.green],
    ];
    logs.forEach(([at, tag, msg, col], i) => {
      if (t < at) return;
      const f = lin(t, at, at + 0.25), y = ly + 112 + i * 47;
      const ts = `10:42:${String(5 + Math.round(at * 3)).padStart(2, '0')}`;
      s += g(mono(lx + 28, y, ts, { size: 21, fill: C.faint }) + mono(lx + 160, y, tag, { size: 21, fill: col, weight: 700 }) + mono(lx + 160 + tag.length * 13 + 14, y, msg, { size: 21, fill: C.slate }), { opacity: f, tx: -14 * (1 - f) });
    });
    if (t >= 10.3) s += g(pill(lx + lw - 330, ly + lh - 76, 300, 52, 'ready · HTTP 200', C.green, C.greenSoft, { size: 22 }), { opacity: lin(t, 10.4, 10.8) });
    return frame(g(s, { opacity: fadeLoop(t, this.dur) }), { title: 'Every step is recorded and streamed live', kicker: 'DEPLOYMENT SERVER · LIFECYCLE', t, dur: this.dur, step, stepF,
      steps: ['The request is validated and recorded', 'Credential and startup script prepared', 'Terraform provisions the VM and firewall', 'The VM builds the app; its log streams to the dashboard over SSH + SSE', 'The public URL is probed through NGINX', 'Ready only when the real page answers'] });
  },
});

// =====================================================================
// 04 — Stack detection
// =====================================================================
scenes.push({
  name: '04-stack-detection', dur: 15,
  draw(t) {
    const repos = [
      { name: 'api-service', files: [['dir', 'src/'], ['file', 'Dockerfile', true], ['file', 'package.json'], ['file', 'README.md']], match: 1,
        logo: 'docker', how: ['docker build -t api-service:<sha> .', 'docker run on 127.0.0.1:3000', 'NGINX :80 → :3000'], upd: 'Updates: blue/green, health-gated' },
      { name: 'landing-page', files: [['dir', 'app/'], ['dir', 'public/'], ['file', 'package.json', true], ['file', 'next.config.js']], match: 2,
        logo: 'nodedotjs', how: ['npm install && npm run build', 'systemd service: npm start -p 3000', 'NGINX :80 → :3000'], upd: 'Updates: rebuild + service restart' },
      { name: 'docs-site', files: [['file', 'index.html', true], ['file', 'styles.css'], ['dir', 'img/']], match: 4,
        logo: 'nginx', how: ['no build step', 'NGINX serves the folder directly', 'try_files → index.html'], upd: 'Updates: git pull' },
    ];
    const per = this.dur / 3, ri = Math.min(2, Math.floor(t / per)), lt = t - ri * per, r = repos[ri];
    const op = Math.min(lin(lt, 0, 0.35), 1 - lin(lt, per - 0.35, per));
    const rules = [['docker-compose.yml', 'Compose'], ['Dockerfile', 'Docker image'], ['package.json', 'Node · Next · Vite'], ['requirements.txt · app.py', 'Python'], ['index.html', 'Static site'], ['nothing runnable', 'Placeholder page']];
    let s = '';
    // repo card
    s += card(96, 190, 470, 700, { r: 20 }) + logo('github', 124, 216, 56, { tile: false, pad: 0 }) + text(196, 254, r.name, { family: HEAD, size: 30, weight: 700 });
    s += text(124, 316, 'REPOSITORY', { family: HEAD, size: 18, weight: 700, fill: C.muted, ls: 3 });
    r.files.forEach(([kind, fname, key], i) => {
      const y = 360 + i * 68, hit = key && lt >= 1.0 + r.match * 0.45;
      s += `<rect x="116" y="${y - 34}" width="430" height="56" rx="10" fill="${hit ? C.coralSoft : 'transparent'}"/>`;
      s += kind === 'dir' ? `<path d="M134 ${y - 18} h16 l6 6 h20 v24 h-42 z" fill="#93C5FD"/>` : `<path d="M138 ${y - 22} h22 l10 10 v32 h-32 z" fill="#fff" stroke="${C.faint}" stroke-width="2.5"/>`;
      s += mono(192, y + 2, fname, { size: 25, fill: hit ? C.coral : C.slate, weight: hit ? 700 : 400 });
    });
    // rules
    const rx = 640;
    s += text(rx, 222, 'CHECKED IN ORDER · MOST SPECIFIC WINS', { family: HEAD, size: 18, weight: 700, fill: C.muted, ls: 3 });
    rules.forEach(([f, label], i) => {
      const y = 250 + i * 104, at = 0.7 + i * 0.45, evaluated = lt >= at && i <= r.match, isMatch = i === r.match && lt >= at;
      const scanning = lt >= at - 0.45 && lt < at && i <= r.match;
      s += card(rx, y, 560, 84, { r: 14, shadow: false, stroke: isMatch ? C.coral : scanning ? '#93C5FD' : C.line, sw: isMatch ? 3 : 2, fill: isMatch ? '#FFF7F6' : '#fff' });
      s += mono(rx + 72, y + 38, f, { size: 22, fill: C.ink, weight: 700 }) + text(rx + 72, y + 68, label, { size: 20, fill: C.muted });
      s += text(rx + 30, y + 52, String(i + 1), { family: HEAD, size: 24, weight: 700, fill: C.faint, anchor: 'middle' });
      if (scanning) s += spinner(rx + 520, y + 42, 14, t, C.blue);
      if (evaluated) s += isMatch ? checkBadge(rx + 520, y + 42, 20, lin(lt, at, at + 0.3)) : crossBadge(rx + 520, y + 42, 16, lin(lt, at, at + 0.3), '#CBD5E1');
      if (i > r.match) s += `<rect x="${rx}" y="${y}" width="560" height="84" rx="14" fill="#fff" opacity="0.55"/>`;
    });
    // result
    const resAt = 1.0 + r.match * 0.45, rf = lin(lt, resAt, resAt + 0.45);
    const ox = 1290;
    s += drawLine([[rx + 560, 250 + r.match * 104 + 42], [ox - 20, 520]], rf, C.coral, { w: 4, marker: 'coral' });
    let res = card(ox, 300, 534, 480, { r: 20, stroke: C.coral, sw: 3 });
    res += logo(r.logo, ox + 32, 330, 88) + text(ox + 140, 368, 'Runs as', { size: 22, fill: C.muted }) + text(ox + 140, 404, rules[r.match][1], { family: HEAD, size: 32, weight: 700 });
    r.how.forEach((h, i) => { res += circle(ox + 46, 486 + i * 62, 6, C.coral) + mono(ox + 66, 494 + i * 62, h, { size: 21, fill: C.slate }); });
    res += line(ox + 32, 680, ox + 502, 680, C.line, { w: 2 }) + text(ox + 32, 728, r.upd, { size: 23, weight: 700, fill: C.green });
    s += g(res, { opacity: rf, tx: 30 * (1 - easeOut(rf)) });
    return frame(g(s, { opacity: op }), { title: 'One startup script, any stack', kicker: 'DEPLOYMENT SERVER · STACK DETECTION', t, dur: this.dur, step: ri, stepF: op,
      steps: ['A Dockerfile repo runs as a container (blue/green ready)', 'A Next.js repo is built and run as a systemd service', 'A plain HTML site is served straight from NGINX'] });
  },
});

// =====================================================================
// 05 / 06 — Blue/green update (success) and safe rollback (failure)
// =====================================================================
function blueGreen(t, fail, dur) {
  const starts = fail ? [0, 1.8, 4.6, 6.6] : [0, 1.8, 4.6, 6.6, 8.6];
  const { step, stepF } = stepAt(t, starts);
  const switched = !fail && t >= 7.2, sw = fail ? 0 : lin(t, 6.8, 7.6);
  const blueGone = !fail && t >= 9.0;
  let s = '';
  // users
  const ux = 220, uy = 530;
  s += card(ux - 110, uy - 140, 220, 280, { r: 20 });
  [[-45, -40], [45, -40], [0, 40]].forEach(([dx, dy]) => { s += userIcon(ux + dx, uy + dy, 60, C.slate); });
  s += text(ux, uy + 120, 'Users', { family: HEAD, size: 24, weight: 700, anchor: 'middle' });
  // nginx
  const nx = 760, ny = 530;
  s += card(nx - 150, ny - 120, 300, 240, { r: 20, stroke: sw > 0 && sw < 1 ? C.coral : C.line, sw: sw > 0 && sw < 1 ? 3 : 2 });
  s += logo('nginx', nx - 44, ny - 96, 88) + text(nx, ny + 34, 'NGINX', { family: HEAD, size: 28, weight: 700, anchor: 'middle' }) + mono(nx, ny + 74, ':80 / :443', { size: 21, fill: C.muted, anchor: 'middle' });
  if (sw > 0 && sw < 1) s += pill(nx - 150, ny + 140, 300, 44, 'graceful reload', C.coral, C.coralSoft, { size: 20 });
  // VM boundary
  s += card(1110, 190, 760, 720, { r: 26, dash: '12 10', shadow: false, fill: 'none', stroke: '#CBD5E1' });
  s += text(1140, 232, 'CLOUD VM', { family: HEAD, size: 18, weight: 700, fill: C.muted, ls: 3 });
  // slots
  const slot = (y, name, col, soft, port, state) => {
    const { label, ver, opacity, live, building, prog, health } = state;
    let b = card(1170, y, 640, 250, { r: 20, stroke: live ? col : C.line, sw: live ? 4 : 2, opacity });
    b += `<rect x="1170" y="${y}" width="16" height="250" rx="8" fill="${col}" opacity="${opacity}"/>`;
    b += logo('docker', 1212, y + 30, 70);
    b += text(1304, y + 62, `${name} slot`, { family: HEAD, size: 30, weight: 700, fill: col });
    b += mono(1304, y + 96, `127.0.0.1:${port}`, { size: 21, fill: C.muted });
    if (ver) b += pill(1600, y + 34, 180, 44, ver, C.slate, C.soft2, { mono: true, size: 20 });
    b += text(1212, y + 160, label, { size: 24, weight: 600, fill: live ? C.green : C.slate });
    if (building !== undefined) b += `<rect x="1212" y="${y + 190}" width="560" height="14" rx="7" fill="${C.line}"/><rect x="1212" y="${y + 190}" width="${560 * prog}" height="14" rx="7" fill="${col}"/>`;
    if (health === 'ok') b += pill(1600, y + 176, 180, 46, 'HTTP 200', C.green, C.greenSoft, { mono: true, size: 21 });
    if (health === 'bad') b += pill(1600, y + 176, 180, 46, 'HTTP 500', C.red, C.redSoft, { mono: true, size: 21 });
    if (health === 'wait') b += spinner(1690, y + 200, 16, t, C.amber);
    return b;
  };
  const by = 260, gy = 600;
  const blueState = blueGone
    ? { label: 'stopped and removed', ver: null, opacity: 1 - 0.6 * lin(t, 9.0, 9.6), live: false }
    : { label: switched ? 'draining old connections' : 'serving all traffic', ver: 'v1 · a1b2c3d', opacity: 1, live: !switched };
  let greenState;
  if (t < 1.8) greenState = { label: 'idle', ver: null, opacity: 0.6, live: false };
  else if (t < 4.6) greenState = { label: `docker build v2 …`, ver: 'v2 · f9e8d7c', opacity: 1, live: false, building: true, prog: lin(t, 2.2, 4.4) };
  else if (t < 6.6 || fail) {
    const res = t >= 5.8 ? (fail ? 'bad' : 'ok') : 'wait';
    greenState = { label: res === 'wait' ? 'curl 127.0.0.1:3001 on the VM…' : res === 'ok' ? 'healthy: ready for traffic' : 'unhealthy: discarded', ver: 'v2 · f9e8d7c', opacity: fail ? 1 - 0.55 * lin(t, 6.8, 7.6) : 1, live: false, health: res };
  } else greenState = { label: 'serving all traffic', ver: 'v2 · f9e8d7c', opacity: 1, live: switched, health: 'ok' };
  s += slot(by, 'Blue', C.blue, C.blueSoft, 3000, blueState);
  s += slot(gy, 'Green', C.green, C.greenSoft, 3001, greenState);
  // commit arriving
  if (t >= 1.6 && t < 3.0) {
    const f = easeOut(lin(t, 1.6, 2.4));
    s += g(card(1300, 0, 420, 70, { r: 35 }) + commitIcon(1346, 35, 10, C.coral) + mono(1384, 44, 'push f9e8d7c · new pricing', { size: 21, fill: C.slate }),
      { ty: mix(150, gy - 90, f), opacity: 1 - lin(t, 2.6, 3.0) });
  }
  // traffic: users → nginx → active slot
  const toBlue = [[ux + 110, uy], [nx - 150, ny]], tgtY = switched ? gy + 125 : by + 125;
  const route = [[nx + 150, ny], [1000, ny], [1000, mix(by + 125, gy + 125, sw)], [1170, mix(by + 125, gy + 125, sw)]];
  s += line(ux + 110, uy, nx - 150, ny, C.line, { w: 4 });
  s += pathEl(`M ${route.map(p => p.join(' ')).join(' L ')}`, C.line, { w: 4 });
  s += flowLine(toBlue, t, C.slate, { w: 4 });
  s += flowLine(route, t, switched ? C.green : C.blue, { w: 4, marker: switched ? 'green' : 'blue' });
  for (let k = 0; k < 4; k++) {
    const f = ((t * 0.55 + k / 4) % 1);
    s += packet(toBlue, f, C.slate, 9) + packet(route, f, switched ? C.green : C.blue, 9);
  }
  // health probe on the VM
  if (t >= 4.6 && t < 6.4) s += drawLine([[1150, gy + 220], [1150, gy + 290], [1700, gy + 290], [1700, gy + 230]], lin(t, 4.7, 5.6), C.amber, { w: 3, dash: '8 8', marker: 'amber' });
  const caps = fail
    ? ['v1 serves all traffic from the blue slot', 'A push arrives: v2 is built in the idle green slot', 'v2 fails its health check on the VM', 'Traffic never moved: v2 is discarded, v1 keeps serving']
    : ['v1 serves all traffic from the blue slot', 'A push arrives: v2 is built in the idle green slot', 'v2 is health-checked on the VM before any traffic', 'NGINX switches to green with a graceful reload', 'The old slot is removed: v2 is live'];
  if (fail && t >= 6.8) s += g(card(560, 760, 400, 90, { r: 18, stroke: '#86EFAC' }) + checkBadge(610, 805, 22, 1) + text(648, 815, 'v1 still serving', { family: HEAD, size: 28, weight: 700, fill: C.green }), { opacity: lin(t, 6.8, 7.2) });
  return frame(g(s, { opacity: fadeLoop(t, dur) }), {
    title: fail ? 'A bad build never reaches users' : 'Zero-downtime updates with blue/green slots',
    kicker: fail ? 'DEPLOYMENT SERVER · SAFE ROLLBACK' : 'DEPLOYMENT SERVER · BLUE/GREEN', t, dur, step, stepF, steps: caps });
}
scenes.push({ name: '05-blue-green-update', dur: 12.5, draw(t) { return blueGreen(t, false, this.dur); } });
scenes.push({ name: '06-safe-rollback', dur: 10, draw(t) { return blueGreen(t, true, this.dur); } });

// =====================================================================
// 07 — Health monitor
// =====================================================================
scenes.push({
  name: '07-health-monitor', dur: 12,
  draw(t) {
    const probes = [0.5, 1.5, 2.5, 3.6, 4.6, 5.6, 6.7, 7.7, 8.7, 9.7];
    const down = (x) => x >= 3.2 && x < 6.2;
    const result = (p) => (down(p) ? 'bad' : 'ok');
    const misses = probes.filter(p => p <= t && down(p)).length;
    const status = t >= 6.8 ? 'ready' : t >= 4.7 ? 'degraded' : 'ready';
    const starts = [0, 3.2, 4.7, 6.7];
    const { step, stepF } = stepAt(t, starts);
    let s = '';
    // server
    s += card(96, 260, 470, 300, { r: 20 }) + logo('nodedotjs', 130, 290, 80) + text(232, 330, 'Deployment Server', { family: HEAD, size: 28, weight: 700 }) + text(232, 366, 'health monitor', { size: 22, fill: C.muted });
    s += mono(130, 440, 'every 60 s', { size: 24, fill: C.slate, weight: 700 }) + mono(130, 480, 'GET http://<vm-ip>/', { size: 22, fill: C.muted }) + mono(130, 516, '(through NGINX)', { size: 22, fill: C.muted });
    // vm
    const vmDown = down(t);
    s += card(1300, 260, 524, 300, { r: 20, stroke: vmDown ? C.red : C.line, sw: vmDown ? 3 : 2 });
    s += serverIcon(1336, 300, 120, 150, vmDown ? C.red : C.slate) + logo('nginx', 1480, 300, 64) + text(1560, 346, 'myapp VM', { family: HEAD, size: 28, weight: 700 });
    s += text(1480, 420, vmDown ? 'not answering' : 'serving traffic', { size: 24, weight: 700, fill: vmDown ? C.red : C.green });
    s += mono(1480, 460, '34.93.12.8', { size: 22, fill: C.muted });
    // probe travel
    const lane = [[566, 410], [1300, 410]];
    s += line(566, 410, 1300, 410, C.line, { w: 4, dash: '2 12' });
    probes.forEach(p => {
      const f = lin(t, p - 0.5, p);
      if (f > 0 && f < 1) s += packet(lane, f, down(p) ? C.red : C.cyan, 12);
      if (t >= p && t < p + 0.45) s += result(p) === 'ok' ? checkBadge(1250, 360, 20, lin(t, p, p + 0.2)) : crossBadge(1250, 360, 20, lin(t, p, p + 0.2));
    });
    // timeline strip
    s += text(96, 652, 'PROBE HISTORY', { family: HEAD, size: 18, weight: 700, fill: C.muted, ls: 3 });
    probes.forEach((p, i) => {
      const x = 96 + i * 82;
      if (t >= p) s += result(p) === 'ok' ? checkBadge(x + 28, 704, 24, lin(t, p, p + 0.25)) : crossBadge(x + 28, 704, 24, lin(t, p, p + 0.25));
      else s += circle(x + 28, 704, 22, C.soft2, { stroke: C.line });
    });
    // deployment record
    s += card(1000, 620, 824, 230, { r: 20 });
    s += text(1032, 670, 'Deployment record #42', { family: HEAD, size: 26, weight: 700 });
    const col = status === 'ready' ? C.green : C.amber, soft = status === 'ready' ? C.greenSoft : C.amberSoft;
    s += pill(1580, 640, 210, 48, status, col, soft, { mono: true, size: 24 });
    const note = t >= 6.8 ? 'Service recovered and is reachable again.' : t >= 4.7 ? 'Unreachable: record kept, not deleted.' : 'Reachable through NGINX.';
    s += text(1032, 730, note, { size: 24, fill: C.slate });
    s += text(1032, 790, t >= 4.7 && t < 6.8 ? `consecutive misses: ${misses}` : 'consecutive misses: 0', { size: 22, fill: C.muted, family: MONO });
    return frame(g(s, { opacity: fadeLoop(t, this.dur) }), { title: 'Unreachable never means deleted', kicker: 'DEPLOYMENT SERVER · HEALTH MONITOR', t, dur: this.dur, step, stepF,
      steps: ['Every 60 s the public URL is probed through NGINX (sped up here)', 'The VM stops answering', 'Two misses: status becomes degraded, the record is kept', 'It answers again: status returns to ready by itself'] });
  },
});

// =====================================================================
// 08 — Security
// =====================================================================
scenes.push({
  name: '08-security', dur: 15,
  draw(t) {
    const starts = [0, 5, 10];
    const { step, stepF } = stepAt(t, starts);
    const lanes = [
      { y: 230, title: 'API access', gate: 'Auth check', gateSub: 'session or bot token', icon: 'lock',
        reqs: [['GET /api/deployments', 'no token', false, '401 Sign in required'], ['GET /api/deployments', 'Bearer eyJh…', true, '200 OK']] },
      { y: 470, title: 'GitHub webhook', gate: 'HMAC-SHA256', gateSub: 'X-Hub-Signature-256', icon: 'github',
        reqs: [['POST /api/webhook/github', 'forged signature', false, '401 Invalid signature'], ['POST /api/webhook/github', 'signed by GitHub', true, 'deploy started']] },
      { y: 710, title: 'Secrets', gate: 'Encrypt + scrub', gateSub: 'AES-256-GCM · log sanitiser', icon: 'lock',
        reqs: [['token ghp_9fK2wQ7x…', 'stored in SQLite', true, 'enc:v1:3f9a…:c41d…'], ['log: token=ghp_9fK2…', 'streamed to dashboard', true, 'token=*****']] },
    ];
    let s = '';
    lanes.forEach((ln, li) => {
      const t0 = starts[li], lt = t - t0, active = step === li, seen = t >= t0;
      const op = seen ? (active ? 1 : 0.45) : 0.2;
      const y = ln.y, h = 200;
      let b = card(96, y, 1728, h, { r: 22, stroke: active ? C.coral : C.line, sw: active ? 3 : 2 });
      b += text(130, y + 50, ln.title.toUpperCase(), { family: HEAD, size: 20, weight: 700, fill: C.coral, ls: 3 });
      // gate
      const gx = 900;
      b += card(gx - 120, y + 30, 240, 140, { r: 18, shadow: false, fill: C.soft });
      b += ln.icon === 'github' ? logo('github', gx - 28, y + 44, 56, { tile: false, pad: 0 }) : lockIcon(gx, y + 76, 52, C.slate);
      b += text(gx, y + 130, ln.gate, { family: HEAD, size: 22, weight: 700, anchor: 'middle' }) + text(gx, y + 158, ln.gateSub, { size: 17, fill: C.muted, anchor: 'middle' });
      // two requests in sequence
      ln.reqs.forEach(([req, detail, ok, outcome], k) => {
        const a = 0.3 + k * 2.3; // request start (local)
        const yy = y + 80 + k * 70;
        if (lt < a) return;
        const travel = lin(lt, a, a + 0.9), res = lin(lt, a + 0.9, a + 1.2);
        b += mono(130, yy + 6, req, { size: 21, fill: C.ink, weight: 700 }) + text(130, yy + 36, detail, { size: 19, fill: C.muted });
        const p1 = [[560, yy], [gx - 125, yy]];
        b += line(560, yy, gx - 125, yy, C.line, { w: 3 });
        if (travel < 1) b += packet(p1, travel, ok ? C.green : C.red, 10);
        if (res > 0) {
          if (ok) {
            b += drawLine([[gx + 125, yy], [1340, yy]], res, C.green, { w: 3, marker: 'green' }) + checkBadge(gx + 125, yy, 16, res);
            b += g(mono(1360, yy + 8, outcome, { size: 22, fill: C.green, weight: 700 }), { opacity: res });
          } else {
            b += crossBadge(gx - 125, yy, 18, res) + g(mono(1360, yy + 8, outcome, { size: 22, fill: C.red, weight: 700 }), { opacity: res });
          }
        }
      });
      s += g(b, { opacity: op });
    });
    return frame(g(s, { opacity: fadeLoop(t, this.dur) }), { title: 'Secure by design', kicker: 'DEPLOYMENT SERVER · SECURITY', t, dur: this.dur, step, stepF,
      steps: ['Every API route needs a signed-in user or the bot token', 'Webhooks must carry a valid GitHub signature', 'Secrets are encrypted at rest and scrubbed from logs'] });
  },
});

// =====================================================================
// 09 — Architecture: control, data and health flows
// =====================================================================
scenes.push({
  name: '09-architecture-flows', dur: 14,
  draw(t) {
    const starts = [0, 3.5, 7.0, 10.0];
    const { step, stepF } = stepAt(t, starts);
    let s = '';
    const box = (x, y, w, h, key, title, sub, hl) => card(x, y, w, h, { r: 18, stroke: hl ? C.coral : C.line, sw: hl ? 3 : 2 }) +
      (key ? logo(key, x + 20, y + (h - 64) / 2, 64) : '') + text(x + (key ? 100 : 24), y + h / 2 - 4, title, { family: HEAD, size: 25, weight: 700 }) +
      text(x + (key ? 100 : 24), y + h / 2 + 28, sub, { size: 19, fill: C.muted });
    const col = (x, y, w, h, label) => card(x, y, w, h, { r: 24, dash: '10 10', shadow: false, fill: 'none', stroke: '#CBD5E1' }) + text(x + 24, y + 40, label, { family: HEAD, size: 17, weight: 700, fill: C.muted, ls: 3 });
    s += col(96, 190, 400, 720, 'TRIGGERS') + col(560, 190, 400, 720, 'INTEGRATION') + col(1020, 190, 400, 720, 'CONTROL PLANE') + col(1480, 190, 344, 720, 'CLOUD VM');
    const N = {
      gh: [120, 260, 352, 120, 'github', 'GitHub', 'issues · push'],
      ui: [120, 620, 352, 120, 'logo-mark', 'Dashboard', 'browser'],
      bot: [584, 260, 352, 120, 'probot', 'DeployBase bot', 'Probot'],
      api: [1044, 260, 352, 120, 'express', 'REST API', 'auth · validation'],
      ops: [1044, 440, 352, 120, 'nodedotjs', 'VM ops', 'SSH · health'],
      db: [1044, 620, 352, 120, 'sqlite', 'SQLite', 'encrypted secrets'],
      tf: [1500, 260, 304, 120, 'terraform', 'Terraform', 'per deployment'],
      vm: [1500, 440, 304, 120, 'nginx', 'NGINX', ':80 / :443'],
      app: [1500, 620, 304, 120, 'docker', 'App', 'blue | green'],
    };
    const hl = { 0: ['gh', 'bot', 'api', 'tf', 'vm'], 1: ['vm', 'ops', 'db', 'ui'], 2: ['ops', 'vm'], 3: ['api', 'bot', 'gh'] }[step];
    Object.entries(N).forEach(([k, v]) => { s += box(...v, hl.includes(k)); });
    const mid = (k, side) => { const [x, y, w, h] = N[k]; return side === 'r' ? [x + w, y + h / 2] : side === 'l' ? [x, y + h / 2] : side === 'b' ? [x + w / 2, y + h] : [x + w / 2, y]; };
    const flows = [
      { pts: [mid('gh', 'r'), mid('bot', 'l')], c: 'coral', ph: 0 },
      { pts: [mid('bot', 'r'), mid('api', 'l')], c: 'coral', ph: 0 },
      { pts: [mid('api', 'r'), mid('tf', 'l')], c: 'coral', ph: 0 },
      { pts: [mid('tf', 'b'), mid('vm', 't')], c: 'coral', ph: 0 },
      { pts: [mid('vm', 'l'), mid('ops', 'r')], c: 'cyan', ph: 1 },
      { pts: [mid('ops', 'b'), mid('db', 't')], c: 'cyan', ph: 1 },
      { pts: [mid('db', 'l'), [700, 680], mid('ui', 'r')], c: 'cyan', ph: 1 },
      { pts: [[1396, 520], [1500, 520]], c: 'green', ph: 2 },
      { pts: [[1044, 330], [960, 330]], c: 'coral', ph: 3 },
      { pts: [[584, 330], [472, 330]], c: 'coral', ph: 3 },
    ];
    flows.forEach(f => {
      const on = step === f.ph;
      s += pathEl(`M ${f.pts.map(p => p.join(' ')).join(' L ')}`, C.line, { w: 4 });
      if (on) {
        s += flowLine(f.pts, t, C[f.c], { w: 4, marker: f.c, dash: f.c === 'coral' ? '14 8' : '8 10' });
        for (let k = 0; k < 2; k++) s += packet(f.pts, ((t - starts[step]) * 0.7 + k / 2) % 1, C[f.c], 9);
      }
    });
    const labels = [
      [step === 0, [[990, 415, 'POST /api/deployments'], [1448, 415, 'terraform apply']]],
      [step === 1, [[1448, 588, 'ssh tail -F'], [758, 712, 'SSE live log']]],
      [step === 2, [[1448, 588, 'probe :80']]],
      [step === 3, [[516, 415, 'comment: live URL']]],
    ];
    labels.forEach(([on, ls]) => { if (on) ls.forEach(([x, y, l]) => { s += mono(x, y, l, { size: 18, fill: C.slate, opacity: stepF, anchor: 'middle', weight: 700 }); }); });
    // legend
    const lg = (x, c, l) => line(x, 880, x + 50, 880, C[c], { w: 4, dash: c === 'coral' ? '14 8' : '8 10' }) + text(x + 64, 887, l, { size: 20, fill: C.slate });
    s += lg(120, 'coral', 'commands') + lg(380, 'cyan', 'logs & status') + lg(680, 'green', 'health probe');
    return frame(g(s, { opacity: fadeLoop(t, this.dur) }), { title: 'How the pieces talk to each other', kicker: 'DEPLOYMENT SERVER · ARCHITECTURE', t, dur: this.dur, step, stepF,
      steps: ['Commands: GitHub → bot → API → Terraform → VM', 'Data: the VM log flows back over SSH, then to the browser over SSE', 'Health: the API probes the public port through NGINX', 'Report: the bot posts the live URL back to the issue'] });
  },
});

module.exports = scenes;
