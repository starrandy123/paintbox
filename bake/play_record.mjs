// Records real gameplay as a player sees it on a phone: the HUD, the touch buttons, the banners. The game is stepped and drawn frame
// by frame and the whole page is captured each frame, so the clip is smooth whatever the machine. A bot plays by the game's own
// rules: it steers the camera toward the next waypoint and holds W, waits by a crystal until it lights, and the shades come as
// the game sends them (a few can be placed where the camera will see them).
//   node bake/play_record.mjs <plays.json> [name]   -> out/broll/<name>.mp4
// plays.json: [{ name, seconds, fps, t, p, camPitch, camDist, show: ["#fps", ...], route: [{ to: [x, y, z], wait?: s, light?: k }],
//                shades: [{ at: s, p: [x, y, z] }], modes: [{ at: s, mode: 0|1 }] }]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { serve, GPU_ARGS } from './serve.mjs';

const [playsFile, only] = process.argv.slice(2);
const plays = JSON.parse(fs.readFileSync(playsFile, 'utf8')).filter((s) => !only || s.name === only);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'out', 'broll');
fs.mkdirSync(OUT, { recursive: true });
const { server, port } = await serve(0, OUT);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
try {
  for (const play of plays) {
    const { name, seconds = 20, fps = 30 } = play;
    const dir = path.join(OUT, `${name}_frames`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    // a phone held upright, drawn at 1080 x 1920
    const ctx = await browser.newContext({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.addInitScript(() => { window.__LP_MANUAL = true; });
    await page.goto(`http://127.0.0.1:${port}/game/index.html?w=1080&h=1920&preserve=1`);
    await page.waitForFunction(() => window.LP && window.LP.R() && document.getElementById('loading').classList.contains('gone'), null, { timeout: 30000 });
    await page.evaluate((play) => {
      const { S } = window.LP;
      window.LP.startPlay(false);
      S.t = play.t ?? 0.585; S.p = [...(play.p || [3, 0.2, 5])];
      S.cam.pitch = play.camPitch ?? 0.3; S.cam.dist = play.camDist ?? 6.5;
      S.shades = []; S.spawnIn = play.spawnIn ?? 3;
      if (play.lit) S.beacons.forEach((b, k) => { b.on = !!play.lit[k]; b.level = play.lit[k]; });
      for (const sel of play.show || []) { const el = document.querySelector(sel); if (el) el.style.setProperty('display', 'block', 'important'); }
      window.__route = { i: 0, waited: 0 };
    }, play);
    const frames = Math.round(seconds * fps);
    for (let i = 0; i < frames; i++) {
      const time = i / fps;
      const shot = await page.evaluate(({ play, time, dt }) => {
        const { S } = window.LP, R = window.__route;
        // the director: shades placed where the camera will see them, and the view switched at its moments
        // (what has happened is kept in the page: the play object is handed over afresh every frame)
        const done = window.__done || (window.__done = new Set());
        (play.shades || []).forEach((s, k) => { if (!done.has('s' + k) && time >= s.at) { S.shades.push({ p: [...s.p], v: [0, 0, 0], hp: 1, wob: Math.random() * 9, born: S.clock }); done.add('s' + k); } });
        (play.modes || []).forEach((m, k) => { if (!done.has('m' + k) && time >= m.at) { window.LP.setMode(m.mode); done.add('m' + k); } });
        // the player: steer toward the waypoint, hold W, stop at a crystal until it is lit
        const wp = play.route[R.i];
        let walk = false;
        if (wp) {
          const dx = wp.to[0] - S.p[0], dz = wp.to[2] - S.p[2], d = Math.hypot(dx, dz);
          const arrived = d <= (wp.r || 0.45);
          // walking, the camera looks where the player goes; arrived, it turns to the waypoint's own view (look: yaw, pitch)
          const want = arrived && wp.look !== undefined ? wp.look : Math.atan2(-dx, -dz);
          let dy = want - S.cam.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          S.cam.yaw += dy * Math.min(1, dt * (arrived ? (wp.lookTurn || 1.2) : (wp.turn || 4)));
          if (arrived && wp.pitch !== undefined) S.cam.pitch += (wp.pitch - S.cam.pitch) * Math.min(1, dt * 1.2);
          if (!arrived) dy = Math.atan2(Math.sin(Math.atan2(-dx, -dz) - S.cam.yaw), Math.cos(Math.atan2(-dx, -dz) - S.cam.yaw));
          const lit = wp.light === undefined || S.beacons[wp.light].on;
          if (!arrived) walk = Math.abs(dy) < 1.2;
          else if (lit && R.waited >= (wp.wait || 0)) { R.i++; R.waited = 0; }
          else R.waited += dt;
        }
        const ev = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
        ev('KeyW', walk);
        window.LP.step(dt);
        window.LP.draw();
        return { i: R.i, p: S.p.map((v) => +v.toFixed(2)), t: +S.t.toFixed(3), lit: S.beacons.filter((b) => b.on).length, shades: S.shades.length, hearts: S.hearts, phase: S.phase };
      }, { play, time, dt: 1 / fps });
      await page.screenshot({ path: path.join(dir, `${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
      if (i % 30 === 0) process.stdout.write(`\r  ${name}: ${i}/${frames} ${JSON.stringify(shot)}      `);
    }
    await ctx.close();
    const mp4 = path.join(OUT, `${name}.mp4`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, '%04d.jpg'), '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n  ${name}: ${frames} frames -> ${mp4}${errs.length ? '  ERRORS: ' + errs.slice(0, 2).join(' | ') : ''}`);
  }
} finally {
  await browser.close();
  server.close();
}
