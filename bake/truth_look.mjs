// The detailed world alone, path traced from a few cameras: to look at the bake's world before anything learns from it.
//   node bake/truth_look.mjs <views.json> [spp] [scale]   -> out/truth/<name>.png
import fs from 'node:fs';
import path from 'node:path';
import { serve, GPU_ARGS } from './serve.mjs';
import { m4 } from '../game/m4.js';
import { beaconState } from './beacons.mjs';
import { chromium } from 'playwright';

const [viewsFile, sppArg, scaleArg] = process.argv.slice(2);
const views = JSON.parse(fs.readFileSync(viewsFile, 'utf8'));
const spp = +(sppArg || 64), scale = +(scaleArg || 0.5);
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'out', 'truth');
fs.mkdirSync(OUT, { recursive: true });
const { server, port } = await serve(0, OUT);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 3000)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 3000)); });
  await page.goto(`http://127.0.0.1:${port}/bake/bake.html`);
  await page.waitForFunction(() => window.ready === true);
  for (const v of views) {
    const w = Math.round((v.w || 960) * scale), h = Math.round((v.h || 540) * scale), aspect = w / h;
    const proj = m4.perspective((aspect < 1 ? 68 : 58) * Math.PI / 180, aspect, 0.1, 220);
    const inv = Array.from(m4.invert(m4.mul(proj, m4.lookAt(v.eye, v.at, [0, 1, 0]))));
    const { light, glow } = beaconState(v.lit || [0, 0, 0, 0, 0], v.t);
    const r = await page.evaluate((o) => window.runCamera(o), { invViewProj: inv, eye: v.eye, w, h, t: v.t, beaconLight: light, glow, spp: v.spp || spp, name: `${v.name}.png` });
    console.log(v.name, `${w}x${h}`, spp, 'spp', r.ms, 'ms');
  }
} finally {
  await browser.close();
  server.close();
}
