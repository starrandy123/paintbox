// Plays the rules in a windowless browser, with predictions written first. Exit 1 if any fails.
//   node bake/play_test.mjs
import { serve, GPU_ARGS } from './serve.mjs';
import { chromium } from 'playwright';

const { server, port } = await serve(0);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => { window.__LP_MANUAL = true; });
await page.goto(`http://127.0.0.1:${port}/game/index.html?w=960&h=540`);
await page.waitForFunction(() => window.LP && window.LP.R(), null, { timeout: 30000 });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const run = (fn, arg) => page.evaluate(fn, arg);
const steps = (n, dt = 1 / 60) => run(({ n, dt }) => { for (let i = 0; i < n; i++) window.LP.step(dt); window.LP.draw(); }, { n, dt });

// 1. the title opens to the game in one press
await page.click('#playBtn');
let s = await run(() => ({ phase: window.LP.S.phase, p: window.LP.S.p }));
check('one press on PLAY starts a round', s.phase === 'play', `phase=${s.phase}`);

// 2. the player stands on the floor (the tiles' top is 0.2)
await steps(90);
s = await run(() => ({ p: window.LP.S.p, ground: window.LP.S.onGround }));
check('the player lands on the courtyard floor', Math.abs(s.p[1] - 0.2) < 0.02 && s.ground, `y=${s.p[1].toFixed(3)} onGround=${s.ground}`);

// 3. W walks the way the camera looks
const before = s.p;
await page.keyboard.down('KeyW'); await steps(60); await page.keyboard.up('KeyW');
s = await run(() => ({ p: window.LP.S.p, yaw: window.LP.S.cam.yaw }));
const moved = Math.hypot(s.p[0] - before[0], s.p[2] - before[2]), fwd = [-Math.sin(s.yaw), -Math.cos(s.yaw)];
const along = ((s.p[0] - before[0]) * fwd[0] + (s.p[2] - before[2]) * fwd[1]) / Math.max(moved, 1e-6);
check('W walks forward from the camera (about 6 m a second)', moved > 4 && along > 0.95, `moved ${moved.toFixed(2)} m, along ${along.toFixed(2)}`);

// 4. a wall stops the player
await run(() => { const S = window.LP.S; S.p = [0, 0.2, 11.0]; S.v = [0, 0, 0]; S.cam.yaw = Math.PI; });
await page.keyboard.down('KeyW'); await steps(120); await page.keyboard.up('KeyW');
s = await run(() => window.LP.S.p);
check('the south wall stops the player (its face is z=13)', s[2] < 13 - 0.31 && s[2] > 12, `z=${s[2].toFixed(3)}`);

// 5. the stairs climb to the north-east tower (top 6.0)
await run(() => { const S = window.LP.S; S.p = [0.8, 0.2, -12.3]; S.v = [0, 0, 0]; S.cam.yaw = -Math.PI / 2; });
await page.keyboard.down('KeyW'); await steps(135); await page.keyboard.up('KeyW');
s = await run(() => window.LP.S.p);
check('walking up the stairs reaches the tower top', s[1] > 5.9 && s[0] > 12.6, `at ${s.map((x) => x.toFixed(2)).join(', ')}`);

// 6. before dusk a crystal sleeps; after dusk standing by it lights it
await run(() => { const S = window.LP.S; S.t = 0.4; S.p = [1.2, 0.9, 0]; S.v = [0, 0, 0]; });
await steps(90);
s = await run(() => window.LP.S.beacons[0].on);
check('a crystal does not light before dusk', s === false, `on=${s}`);
await run(() => { window.LP.S.t = 0.6; });
await steps(60);
s = await run(() => ({ on: window.LP.S.beacons[0].on, level: window.LP.S.beacons[0].level }));
check('standing by it after dusk lights it within a second', s.on === true, `on=${s.on} level=${s.level.toFixed(2)}`);

// 7. shades come at night, hurt on touch, and burn in a lit beacon's light
await run(() => { const S = window.LP.S; S.t = 0.8; S.p = [-6, 0.2, 6]; S.v = [0, 0, 0]; S.inv = 0; S.hearts = 3; S.shades = [{ p: [-6, 0.5, 8.5], v: [0, 0, 0], hp: 1, wob: 0, born: 0 }]; });
await steps(90);
s = await run(() => ({ hearts: window.LP.S.hearts }));
check('a shade that reaches the player takes a heart', s.hearts === 2, `hearts=${s.hearts}`);
await run(() => { const S = window.LP.S; S.spawnIn = 1e9; S.shades = [{ p: [3.5, 0.5, 0], v: [0, 0, 0], hp: 1, wob: 0, born: 0, tag: 'test' }]; S.p = [-12, 0.2, 9]; });
await steps(150);
s = await run(() => { const sh = window.LP.S.shades.find((x) => x.tag === 'test'); return { n: sh ? 1 : 0, hp: sh ? sh.hp : null }; });
check('a shade in the lit amber beacon\'s light burns away', s.n === 0 || s.hp < 0, `shades=${s.n} hp=${s.hp}`);

// 8. lighting all five wins the round
await run(() => { const S = window.LP.S; S.shades = []; S.hearts = 3; });
for (const k of [1, 2, 3, 4]) {
  await run((k) => { const S = window.LP.S, b = S.beacons[k], dx = [0, -1.2, 1.2, 1.2, 1.2][k]; S.p = [b.at[0] + dx, b.at[1] - 1.0, b.at[2] + 0.2]; S.v = [0, 0, 0]; S.shades = []; S.spawnIn = 1e9; }, k);
  await steps(70);
}
s = await run(() => ({ phase: window.LP.S.phase, lit: window.LP.S.beacons.map((b) => b.on) }));
check('lighting all five ends the round as won', s.phase === 'won', `phase=${s.phase} lit=${s.lit}`);

// 9. three hits lose it
await page.click('#againBtn');
await run(() => { const S = window.LP.S; S.t = 0.9; S.hearts = 1; S.inv = 0; S.p = [-6, 0.2, 6]; S.shades = [{ p: [-6, 0.5, 6.6], v: [0, 0, 0], hp: 1, wob: 0, born: 0 }]; });
await steps(60);
s = await run(() => window.LP.S.phase);
check('the last heart lost ends the round', s === 'lost', `phase=${s}`);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 600));
await browser.close(); server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
