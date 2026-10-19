// Bakes and trains the three painters for the world in game/world.js and bake/truth.js, one step after another, on this machine:
//   node bake/make.mjs            the full bake (about 6 minutes on an M1's GPU) and training (about 21 minutes of numpy)
//   node bake/make.mjs --quick    a small bake and short training (about 5 minutes): to check a change end to end before the full one
// The trainers run in Python 3 with numpy (PYTHON=... to choose one; python3 by default). It writes game/painter.bin, surface.bin and
// sky.bin; the old training sets are cleared first, so a set from another world is never mixed in.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const quick = process.argv.includes('--quick');
const PY = process.env.PYTHON || 'python3';
const run = (cmd, ...args) => {
  const t0 = Date.now();
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`✖ ${cmd} ${args.join(' ')} stopped (${r.status ?? r.error})`); process.exit(r.status || 1); }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
};

const check = spawnSync(PY, ['-c', 'import numpy; print(numpy.__version__)'], { encoding: 'utf8' });
if (check.status !== 0) { console.error(`✖ ${PY} has no numpy: install it (pip install numpy) or set PYTHON to a Python that has it`); process.exit(1); }

const data = path.join(ROOT, 'data');
fs.mkdirSync(data, { recursive: true });
for (const f of fs.readdirSync(data)) if (/^(train|val|surf_|sky_).*\.f32$/.test(f)) fs.rmSync(path.join(data, f));

const t0 = Date.now();
run('node', 'bake/run.mjs', 'boxes');
if (quick) {
  run('node', 'bake/run.mjs', 'samples', '512', '512', '128', 'train', '1');
  run('node', 'bake/run.mjs', 'samples', '128', '128', '512', 'val', '7');
  run('node', 'bake/run.mjs', 'surface', '1024', '512', '64', 'train0', '41');
  run('node', 'bake/run.mjs', 'surface', '128', '128', '256', 'val', '29');
  run('node', 'bake/run.mjs', 'sky', '1024', '512', 'train', '3');
  run('node', 'bake/run.mjs', 'sky', '128', '128', 'val', '9');
  run(PY, '-I', 'bake/train.py', '1000');
  run(PY, '-I', 'bake/train_sky.py', '800');
  run(PY, '-I', 'bake/train_surface.py', '1200');
} else {
  run('node', 'bake/run.mjs', 'samples', '1024', '1024', '256', 'train', '1');
  run('node', 'bake/run.mjs', 'samples', '256', '256', '1024', 'val', '7');
  for (let k = 0; k < 4; k++) run('node', 'bake/run.mjs', 'surface', '1024', '1024', '128', `train${k}`, String(41 + k));
  run('node', 'bake/run.mjs', 'surface', '256', '256', '512', 'val', '29');
  run('node', 'bake/run.mjs', 'sky', '2048', '1024', 'train', '3');
  run('node', 'bake/run.mjs', 'sky', '256', '256', 'val', '9');
  run(PY, '-I', 'bake/train.py', '4000');
  run(PY, '-I', 'bake/train_sky.py', '3000');
  run(PY, '-I', 'bake/train_surface.py', '5000');
}
console.log(`\n✔ the painters are made (${((Date.now() - t0) / 60000).toFixed(1)} min): game/painter.bin, game/surface.bin, game/sky.bin`);
console.log('  next: npm run look (the same cameras against the path tracer) · npm test (the rules) · npm run serve (play it)');
