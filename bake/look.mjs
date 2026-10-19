// Same camera, two renderers: the game (BOXES and AI PAINT) and the path tracer over the detailed world (the truth). Windowless, on
// this machine's GPU.
//   node bake/look.mjs <views.json> [refSpp|0]     -> out/<name>_<mode>.png, out/<name>_1pp.png and out/<name>_ref.png
import fs from 'node:fs';
import path from 'node:path';
import { serve, GPU_ARGS } from './serve.mjs';
import { m4 } from '../game/m4.js';
import { beaconState } from './beacons.mjs';
import { chromium } from 'playwright';

const [viewsFile, refArg] = process.argv.slice(2);
const views = JSON.parse(fs.readFileSync(viewsFile, 'utf8'));
const refSpp = refArg === undefined ? 256 : +refArg;
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'out');
fs.mkdirSync(OUT, { recursive: true });
const { server, port } = await serve(0, OUT);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const errs = [];
try {
  for (const v of views) {
    const w = v.w || 640, h = v.h || 360;
    const lit = v.lit || [0, 0, 0, 0, 0];
    const { light: beaconLight, glow } = beaconState(lit, v.t);
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.addInitScript(() => { window.__LP_MANUAL = true; });
    await page.goto(`http://127.0.0.1:${port}/game/index.html?w=${w}&h=${h}&preserve=1`);
    await page.waitForFunction(() => window.LP && window.LP.R(), null, { timeout: 30000 });
    for (const mode of v.modes || [0, 1]) {
      const png = await page.evaluate(({ v, mode, lit }) => {
        const { S } = window.LP;
        S.t = v.t; S.clock = 0;
        S.beacons.forEach((b, k) => { b.on = !!lit[k]; b.level = lit[k]; b.charge = 0; });
        window.LP.setMode(mode);
        window.LP.setCamera({ eye: v.eye, at: v.at });
        window.LP.draw();
        return document.getElementById('c').toDataURL('image/png');
      }, { v, mode, lit });
      fs.writeFileSync(path.join(OUT, `${v.name}_${mode}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    // the same AI frame with the light painter run at every pixel instead of through the light atlas
    const pp = await page.evaluate(() => { const R = window.LP.R(); R.useAtlas = false; window.LP.setMode(1); window.LP.draw(); const u = document.getElementById('c').toDataURL('image/png'); R.useAtlas = true; return u; });
    fs.writeFileSync(path.join(OUT, `${v.name}_1pp.png`), Buffer.from(pp.split(',')[1], 'base64'));
    // how long a frame of the painter takes here: 60 frames, waited on
    const ms = await page.evaluate(async ({ v }) => {
      const gl = window.LP.R().gl, out = {};
      const R = window.LP.R();
      for (const [key, mode, atlas] of [['boxes', 0, true], ['ai_paint', 1, true], ['ai_paint_light_per_pixel', 1, false]]) {
        window.LP.setMode(mode); R.useAtlas = atlas;
        window.LP.draw(); gl.finish();
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) window.LP.draw();
        const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out[key] = +((performance.now() - t0) / 60).toFixed(2);
      }
      R.useAtlas = true;
      out.atlas = `${R.atlas.w}x${R.atlas.h} ${R.atlas.texels} texels ${R.atlas.rgbm ? 'RGBM8' : 'RGBA16F'}`;
      return out;
    }, { v });
    console.log(v.name, `${w}x${h}`, 'ms/frame', JSON.stringify(ms));
    await page.close();
    if (refSpp > 0) {
      const bp = await browser.newPage();
      await bp.goto(`http://127.0.0.1:${port}/bake/bake.html`);
      await bp.waitForFunction(() => window.ready === true);
      const aspect = w / h;
      const proj = m4.perspective((aspect < 1 ? 68 : 58) * Math.PI / 180, aspect, 0.1, 220);
      const view = m4.lookAt(v.eye, v.at, [0, 1, 0]);
      const inv = Array.from(m4.invert(m4.mul(proj, view)));
      const r = await bp.evaluate((o) => window.runCamera(o), { invViewProj: inv, eye: v.eye, w, h, t: v.t, beaconLight, glow, spp: v.spp || refSpp, name: `${v.name}_ref.png` });
      console.log(v.name, 'path traced', v.spp || refSpp, 'spp in', r.ms, 'ms');
      await bp.close();
    }
  }
} finally {
  if (errs.length) console.log('PAGE ERRORS:\n' + errs.slice(0, 5).join('\n').slice(0, 4000));
  await browser.close();
  server.close();
}
