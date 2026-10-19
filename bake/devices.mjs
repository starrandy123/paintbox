// The game as a player gets it, in both browser engines (Chromium = Chrome/Android, WebKit = Safari/every iPhone browser), at a desktop
// size and as a phone upright and turned (3x pixels, touch): tap PLAY, play a few seconds, measure the frame rate, keep a screenshot.
//   node bake/devices.mjs [chromium|webkit|both]
import fs from 'node:fs';
import path from 'node:path';
import { serve, GPU_ARGS } from './serve.mjs';
import pw from 'playwright';

const which = process.argv[2] || 'both';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'out', 'devices');
fs.mkdirSync(OUT, { recursive: true });
const { server, port } = await serve(0, OUT);
const profiles = [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  { name: 'phone-up', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'phone-turned', viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const rows = [];
for (const engine of which === 'both' ? ['chromium', 'webkit'] : [which]) {
  const opts = engine === 'chromium' ? { headless: true, args: GPU_ARGS } : { headless: true };
  const browser = await pw[engine].launch(opts);
  for (const prof of profiles) {
    const ctx = await browser.newContext(engine === 'webkit' && prof.isMobile ? { viewport: prof.viewport, deviceScaleFactor: prof.deviceScaleFactor, hasTouch: true, isMobile: true } : prof);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/game/index.html`);
    let booted = true;
    try { await page.waitForFunction(() => document.getElementById('loading').classList.contains('gone'), null, { timeout: 30000 }); } catch { booted = false; }
    const bootMs = Date.now() - t0;
    if (booted) {
      if (prof.hasTouch) await page.tap('#playBtn'); else await page.click('#playBtn');
      await page.waitForTimeout(2500);
    }
    const m = booted ? await page.evaluate(async () => {
      const gl = window.LP.R().gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
      let n = 0; const t0 = performance.now();
      await new Promise((ok) => { const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else ok(); }; requestAnimationFrame(f); });
      const R = window.LP.R();
      return {
        fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1),
        canvas: `${R.w}x${R.h}`, atlas: `${R.atlas.w}x${R.atlas.h} ${R.atlas.rgbm ? 'RGBM8' : 'RGBA16F'}`,
        gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        phase: window.LP.S.phase, touchUi: document.body.classList.contains('touch'),
        jumpVisible: getComputedStyle(document.getElementById('jump')).display !== 'none',
        // what the page asks the graphics card to hold, roughly: the surfaces and textures it made
        heldMB: +(((R.w * R.h * (4 + 4) * R.samples) + R.w * R.h * 4 * 1.6 + R.shadowSize * R.shadowSize * 4 + R.atlas.w * R.atlas.h * (R.atlas.rgbm ? 4 : 8) + window.LP.painter.light.bytes + window.LP.painter.surface.bytes * 1.33 + window.LP.painter.sky.bytes * 1.33) / 1e6).toFixed(1),
      };
    }) : {};
    const shot = path.join(OUT, `${engine}-${prof.name}.png`);
    await page.screenshot({ path: shot });
    rows.push({ engine, profile: prof.name, booted, bootMs, ...m, errors: errs.slice(0, 3) });
    console.log(JSON.stringify(rows[rows.length - 1]));
    await ctx.close();
  }
  await browser.close();
}
server.close();
fs.writeFileSync(path.join(OUT, 'devices.json'), JSON.stringify(rows, null, 1));
