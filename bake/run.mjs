// Drives the bake in a windowless Chromium on this machine's GPU.
//   node bake/run.mjs info                         which GPU the page gets
//   node bake/run.mjs samples <w> <h> <spp> [tag]  the painter's teaching set -> data/<tag>_x.f32, data/<tag>_y.f32
//   node bake/run.mjs surface <w> <h> <spp> [tag] [seed]  the surface painter's set -> data/surf_<tag>_x.f32, _y.f32
//   node bake/run.mjs sky <w> <h> [tag] [seed]      the sky painter's set -> data/sky_<tag>_x.f32, _y.f32
//   node bake/run.mjs boxes                         the world's facts for the trainers -> data/boxes.json
//   node bake/run.mjs camera <views.json> <spp>    path-traced pictures -> data/<name>.png
import fs from 'node:fs';
import { serve, GPU_ARGS } from './serve.mjs';
import { chromium } from 'playwright';

const [cmd, ...args] = process.argv.slice(2);
const { server, port } = await serve(0);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 2000)); });
page.on('pageerror', (e) => console.log('[page exception]', String(e).slice(0, 3000)));
await page.goto(`http://127.0.0.1:${port}/bake/bake.html`);
await page.waitForFunction(() => window.ready === true);
const info = await page.evaluate(() => window.glInfo);
console.log('GPU:', info.renderer, '|', info.vendor);
const tick = setInterval(async () => { try { const p = await page.evaluate(() => window.progress); process.stdout.write(`\r  ${(p * 100).toFixed(0)}%   `); } catch {} }, 3000);
try {
  if (cmd === 'samples') {
    const [w, h, spp, tag = 'train', seed = '1'] = args;
    const r = await page.evaluate((o) => window.runSamples(o), { w: +w, h: +h, spp: +spp, tag, seed: +seed });
    console.log('\n', JSON.stringify(r));
  } else if (cmd === 'surface') {
    const [w, h, spp, tag = 'train', seed = '1'] = args;
    const r = await page.evaluate((o) => window.runSurface(o), { w: +w, h: +h, spp: +spp, tag, seed: +seed });
    console.log('\n', JSON.stringify(r));
  } else if (cmd === 'sky') {
    const [w, h, tag = 'train', seed = '1'] = args;
    const r = await page.evaluate((o) => window.runSky(o), { w: +w, h: +h, tag, seed: +seed });
    console.log('\n', JSON.stringify(r));
  } else if (cmd === 'boxes') {
    console.log(JSON.stringify(await page.evaluate(() => window.runBoxes())));
  } else if (cmd === 'camera') {
    const views = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    for (const v of views) {
      const r = await page.evaluate((o) => window.runCamera(o), { ...v, spp: +(args[1] || v.spp || 256) });
      console.log('\n', v.name, JSON.stringify(r));
    }
  }
} finally {
  clearInterval(tick);
  await browser.close();
  server.close();
}
