// Records b-roll of the game frame by frame, windowless: every frame is stepped, drawn and captured, so the clip is smooth whatever
// the machine. A shot is a JSON list: { name, w, h, fps, seconds, setup, keys: [{ at, cam, mode, t, lit, play }] }.
//   node bake/record.mjs <shots.json> [shotName]   -> out/broll/<name>.mp4
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serve, GPU_ARGS } from './serve.mjs';
import { chromium } from 'playwright';

const [shotsFile, only] = process.argv.slice(2);
const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8')).filter((s) => !only || s.name === only);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'out', 'broll');
fs.mkdirSync(OUT, { recursive: true });
const { server, port } = await serve(0, OUT);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const lerp = (a, b, k) => (Array.isArray(a) ? a.map((x, i) => x + (b[i] - x) * k) : a + (b - a) * k);
const ease = (k) => k * k * (3 - 2 * k);
try {
  for (const shot of shots) {
    const { name, w = 1080, h = 1920, fps = 30, seconds = 6 } = shot;
    const frames = Math.round(seconds * fps);
    const dir = path.join(OUT, `${name}_frames`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    const page = await browser.newPage({ viewport: { width: Math.round(w / 2), height: Math.round(h / 2) } });
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.addInitScript(() => { window.__LP_MANUAL = true; });
    await page.goto(`http://127.0.0.1:${port}/../game/index.html?w=${w}&h=${h}&preserve=1`.replace('/../', '/'));
    await page.waitForFunction(() => window.LP && window.LP.R(), null, { timeout: 30000 });
    await page.evaluate((setup) => {
      const { S } = window.LP;
      document.querySelectorAll('#hud, #title, #end, #loading').forEach((e) => (e.style.display = 'none'));
      if (setup.play) window.LP.startPlay(!!setup.free);
      document.querySelectorAll('#hud, #title, #end, #loading').forEach((e) => (e.style.display = 'none'));
      if (setup.p) S.p = setup.p;
      if (setup.yaw !== undefined) S.yaw = setup.yaw;
      if (setup.camYaw !== undefined) S.cam.yaw = setup.camYaw;
      if (setup.camPitch !== undefined) S.cam.pitch = setup.camPitch;
      if (setup.shades) S.shades = setup.shades.map((p) => ({ p, v: [0, 0, 0], hp: 1, wob: Math.random() * 9, born: 0 }));
    }, shot.setup || {});
    const keys = shot.keys;
    for (let i = 0; i < frames; i++) {
      const time = i / fps;
      // the keyframes around this moment
      let a = keys[0], b = keys[keys.length - 1];
      for (let k = 0; k < keys.length - 1; k++) if (time >= keys[k].at && time <= keys[k + 1].at) { a = keys[k]; b = keys[k + 1]; break; }
      const k = b.at > a.at ? ease(Math.min(1, Math.max(0, (time - a.at) / (b.at - a.at)))) : 0;
      const st = {
        cam: a.cam && b.cam ? { eye: lerp(a.cam.eye, b.cam.eye, k), at: lerp(a.cam.at, b.cam.at, k) } : a.cam || null,
        t: a.t !== undefined && b.t !== undefined ? lerp(a.t, b.t, k) : a.t,
        mode: a.mode, lit: a.lit, move: a.move, follow: a.follow,
        wipe: a.wipe ? { from: a.wipe.from, to: a.wipe.to, x: b.wipe ? lerp(a.wipe.x, b.wipe.x, k) : a.wipe.x } : null,
      };
      const url = await page.evaluate(({ st, fps, first }) => {
        const { S } = window.LP;
        if (st.t !== undefined) S.t = st.t;
        if (st.mode !== undefined && S.mode !== st.mode) window.LP.setMode(st.mode);
        if (st.lit) S.beacons.forEach((b, k) => { if (st.lit[k] && !b.on) { b.on = true; } if (!st.lit[k]) { b.on = false; } });
        window.__rec_keys = st.move || {};
        if (st.cam && !st.follow) window.LP.setCamera(st.cam); else window.LP.setCamera(null);
        if (st.move) {
          const ev = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
          for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']) ev(code, !!st.move[code]);
        }
        const tKeep = S.t;
        window.LP.step(1 / fps);
        if (st.t !== undefined) S.t = tKeep;
        if (!st.wipe) { window.LP.draw(); return document.getElementById('c').toDataURL('image/jpeg', 0.93); }
        // a wipe: the same frame in two modes, split by a line at x
        const c = document.getElementById('c'), W = c.width, H = c.height;
        const out = window.__wipe || (window.__wipe = document.createElement('canvas'));
        out.width = W; out.height = H;
        const g = out.getContext('2d');
        window.LP.setMode(st.wipe.from); window.LP.draw(); g.drawImage(c, 0, 0);
        window.LP.setMode(st.wipe.to); window.LP.draw();
        const xs = Math.round(st.wipe.x * W);
        g.drawImage(c, xs, 0, W - xs, H, xs, 0, W - xs, H);
        g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(xs - 2, 0, 4, H);
        return out.toDataURL('image/jpeg', 0.93);
      }, { st, fps, first: i === 0 });
      fs.writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
      if (i % 30 === 0) process.stdout.write(`\r  ${name}: ${i}/${frames}`);
    }
    await page.close();
    const mp4 = path.join(OUT, `${name}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, '%04d.jpg'), '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\r  ${name}: ${frames} frames -> ${mp4}${errs.length ? '  ERRORS: ' + errs.slice(0, 2).join(' | ') : ''}`);
  }
} finally {
  await browser.close();
  server.close();
}
