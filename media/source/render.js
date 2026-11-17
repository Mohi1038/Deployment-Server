// node render.js <scene|all> [--preview t1,t2,...]
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { execFileSync } = require('child_process');
const scenes = require('./scenes').concat(require('./scenes_problem'));

const OUT = process.env.OUT || path.join(__dirname, 'out');
const FPS = 25;
const W = Number(process.env.GIF_W || 1280);

async function renderScene(sc, preview) {
  const dir = path.join(__dirname, 'frames', sc.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const times = preview ? preview : Array.from({ length: Math.round(sc.dur * FPS) }, (_, i) => i / FPS);
  const jobs = times.map((t, i) => async () => {
    const svg = sc.draw(t);
    await sharp(Buffer.from(svg), { density: 72 }).resize(sc.canvas || W).png().toFile(path.join(dir, `f${String(i).padStart(4, '0')}.png`));
  });
  for (let i = 0; i < jobs.length; i += 12) await Promise.all(jobs.slice(i, i + 12).map(j => j()));
  if (preview) return dir;
  fs.mkdirSync(OUT, { recursive: true });
  const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png')];
  const sizes = sc.sizes || [null];
  let gif;
  for (const size of sizes) {
    const suffix = size ? `-${size}` : '';
    const scale = size ? `scale=${size}:-2:flags=lanczos,` : '';
    gif = path.join(OUT, `${sc.name}${suffix}.gif`);
    execFileSync('ffmpeg', [...input, '-vf', `${scale}split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`, '-loop', '0', gif]);
    execFileSync('ffmpeg', [...input, '-vf', `${scale}format=yuv420p`, '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', path.join(OUT, `${sc.name}${suffix}.mp4`)]);
  }
  return gif;
}

(async () => {
  const which = process.argv[2] || 'all';
  const pv = process.argv.indexOf('--preview');
  const preview = pv > 0 ? process.argv[pv + 1].split(',').map(Number) : null;
  for (const sc of scenes.filter(s => which === 'all' || s.name.includes(which))) {
    const t0 = Date.now();
    const out = await renderScene(sc, preview);
    const size = preview ? '' : ` ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`;
    console.log(`${sc.name}: ${out}${size} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
