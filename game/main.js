// The game underneath: every rule is code. Light the five beacons after the sun goes down; the shades drift through stone toward you
// and burn away in the beacons' light. The painters only paint.
import { BOXES, BEACONS, BEACON_POWER, GLOW_LIT, PLAY, M, FORM, sunElevDeg } from './world.js';
import { Renderer } from './render.js';
import { m4, sub, add, scale, norm, len, dot } from './m4.js';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const MODES = ['BOXES', 'AI PAINT'];
const AWAKE_T = 0.595, SHADES_T = 0.63, T_START = 0.18, T_RATE = 1 / 100;   // dusk about 42 s in; full night about 82 s in
const R = 0.32, HGT = 1.7, GRAV = -24, JUMP = 8.0, SPEED = 6.4;

const S = {
  phase: 'title', mode: 1, t: Q.has('t') ? +Q.get('t') : 0.42, time: 0, clock: 0,
  p: [...PLAY.spawn], v: [0, 0, 0], yaw: Math.PI, onGround: false, hearts: 3, inv: 0, walk: 0,
  cam: { yaw: 0.35, pitch: 0.36, dist: 7.2 },
  beacons: BEACONS.map((b) => ({ ...b, on: false, level: 0, charge: 0 })),
  shades: [], spawnIn: 3, startedAt: 0, litAt: 0, free: false, shake: 0,
};
if (Q.has('mode')) S.mode = Math.max(0, Math.min(1, +Q.get('mode')));

// ---------------- input ----------------
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space' && S.phase !== 'title') e.preventDefault();
  if (/^Digit[1-2]$/.test(e.code)) setMode(+e.code.slice(5) - 1);
  if (e.code === 'KeyM') setMode((S.mode + 1) % 2);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, look = { id: null, x: 0, y: 0 };
let jumpPressed = false;
const canvas = $('c');
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const touch = e.pointerType !== 'mouse';
  if (touch && e.clientX < innerWidth * 0.45 && stick.id === null && S.phase !== 'title') {
    Object.assign(stick, { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
    $('stick').style.display = 'block'; $('stick').style.left = e.clientX + 'px'; $('stick').style.top = e.clientY + 'px';
  } else if (look.id === null) Object.assign(look, { id: e.pointerId, x: e.clientX, y: e.clientY });
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId === stick.id) {
    const dx = e.clientX - stick.ox, dy = e.clientY - stick.oy, l = Math.hypot(dx, dy), m = Math.min(1, l / 56);
    stick.x = l > 0 ? (dx / l) * m : 0; stick.y = l > 0 ? (dy / l) * m : 0;
    $('knob').style.transform = `translate(${stick.x * 40}px, ${stick.y * 40}px)`;
  } else if (e.pointerId === look.id) {
    const k = e.pointerType === 'mouse' ? 0.0055 : 0.0075;
    S.cam.yaw -= (e.clientX - look.x) * k; S.cam.pitch = Math.max(-0.05, Math.min(1.2, S.cam.pitch + (e.clientY - look.y) * k));
    look.x = e.clientX; look.y = e.clientY;
  }
});
const endPointer = (e) => {
  if (e.pointerId === stick.id) { stick.id = null; stick.x = stick.y = 0; $('stick').style.display = 'none'; $('knob').style.transform = ''; }
  if (e.pointerId === look.id) look.id = null;
};
canvas.addEventListener('pointerup', endPointer); canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { S.cam.dist = Math.max(3.5, Math.min(13, S.cam.dist * (1 + Math.sign(e.deltaY) * 0.08))); e.preventDefault(); }, { passive: false });
$('jump').addEventListener('pointerdown', (e) => { e.stopPropagation(); jumpPressed = true; });
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setMode(+b.dataset.mode); }));
function setMode(m) {
  S.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
  $('modeNote').textContent = ['the boxes the code keeps', 'every pixel painted by a small network, from the boxes'][m];
}

// ---------------- the world's rules ----------------
const SOLID = BOXES;
function overlaps(p, b) { return p[0] + R > b.min[0] && p[0] - R < b.max[0] && p[1] + HGT > b.min[1] && p[1] < b.max[1] && p[2] + R > b.min[2] && p[2] - R < b.max[2]; }
function blocked(p) { for (const b of SOLID) if (overlaps(p, b)) return b; return null; }
function moveAxis(a, d, grounded = false) {
  const p = S.p;
  p[a] += d;
  for (let guard = 0; guard < 4; guard++) {
    const b = blocked(p);
    if (!b) return;
    if (a !== 1) {
      const step = b.max[1] - p[1];
      if (step > 0 && step <= 0.62 && grounded) {
        const up = [p[0], b.max[1] + 0.002, p[2]];
        if (!blocked(up)) { p[1] = up[1]; continue; }
      }
      p[a] = d > 0 ? b.min[a] - R - 1e-4 : b.max[a] + R + 1e-4;
    } else {
      if (d < 0) { p[1] = b.max[1] + 1e-4; S.onGround = true; } else p[1] = b.min[1] - HGT - 1e-4;
      S.v[1] = 0;
    }
  }
}
function camBasis() {
  const y = S.cam.yaw;
  return { f: [-Math.sin(y), 0, -Math.cos(y)], r: [Math.cos(y), 0, -Math.sin(y)] };
}
function playerUpdate(dt) {
  let mx = 0, mz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) mz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) mz -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
  mx += stick.x; mz -= stick.y;
  const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
  const { f, r } = camBasis();
  const want = add(scale(f, mz * SPEED), scale(r, mx * SPEED));
  const acc = S.onGround ? 14 : 5;
  S.v[0] += (want[0] - S.v[0]) * Math.min(1, acc * dt);
  S.v[2] += (want[2] - S.v[2]) * Math.min(1, acc * dt);
  if (Math.hypot(want[0], want[2]) > 0.3) {
    const target = Math.atan2(want[0], want[2]);
    let d = target - S.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    S.yaw += d * Math.min(1, 12 * dt);
  }
  if ((keys.has('Space') || jumpPressed) && S.onGround) { S.v[1] = JUMP; S.onGround = false; }
  jumpPressed = false;
  // sideways first (a step up to 0.62 m is climbed while standing), then up and down: landing on something is what stands you
  S.v[1] += GRAV * dt;
  const grounded = S.onGround && S.v[1] <= 0;
  moveAxis(0, S.v[0] * dt, grounded);
  moveAxis(2, S.v[2] * dt, grounded);
  S.onGround = false;
  moveAxis(1, S.v[1] * dt);
  S.p[0] = Math.max(-PLAY.half, Math.min(PLAY.half, S.p[0]));
  S.p[2] = Math.max(-PLAY.half, Math.min(PLAY.half, S.p[2]));
  if (S.p[1] < -3) { S.p = [...PLAY.spawn]; S.v = [0, 0, 0]; }
  S.walk += Math.hypot(S.v[0], S.v[2]) * dt * (S.onGround ? 1.6 : 0.3);
}
function beaconUpdate(dt) {
  const awake = S.t >= AWAKE_T || S.free;
  let near = null;
  for (const b of S.beacons) {
    const dx = S.p[0] - b.at[0], dz = S.p[2] - b.at[2], dy = S.p[1] + 0.9 - b.at[1];
    const close = Math.hypot(dx, dz) < 2.4 && Math.abs(dy) < 3.2;
    if (close && !b.on) near = b;
    if (close && awake && !b.on && (S.phase === 'play' || S.free)) {
      b.charge = Math.min(1, b.charge + dt / 0.65);
      if (b.charge >= 1) { b.on = true; S.shake = 0.35; S.litAt = S.clock; banner(`${b.name.toUpperCase()} LIT`); }
    } else if (!b.on) b.charge = Math.max(0, b.charge - dt);
    b.level += ((b.on ? 1 : 0) - b.level) * Math.min(1, dt / 0.9);
  }
  return near;
}
function shadeUpdate(dt) {
  if (S.phase !== 'play' || S.t < SHADES_T) return;
  S.spawnIn -= dt;
  const night = Math.min(1, (S.t - SHADES_T) / (1 - SHADES_T));
  if (S.spawnIn <= 0 && S.shades.length < 9) {
    S.spawnIn = 5.5 - 3.0 * night;
    const a = Math.random() * Math.PI * 2;
    S.shades.push({ p: [Math.cos(a) * 19, 0.4, Math.sin(a) * 19], v: [0, 0, 0], hp: 1, wob: Math.random() * 10, born: S.clock });
  }
  const speed = 2.9 + 1.4 * night;
  for (const s of S.shades) {
    const to = sub([S.p[0], S.p[1] + 0.3, S.p[2]], s.p), d = len(to);
    const dir = d > 0.01 ? scale(to, 1 / d) : [0, 0, 0];
    s.v = add(scale(s.v, 1 - Math.min(1, 3 * dt)), scale(dir, speed * Math.min(1, 3 * dt)));
    for (const b of S.beacons) {
      if (b.level < 0.2) continue;
      const w = sub(s.p, b.at), wd = Math.hypot(w[0], w[2]), rad = 6.2 * b.level;
      if (wd < rad) { s.hp -= dt * 1.6; const push = scale(norm([w[0], 0, w[2]]), (rad - wd) * 3); s.v = add(s.v, scale(push, dt * 6)); }
    }
    s.p = add(s.p, scale(s.v, dt));
    s.p[1] = Math.max(0.25, Math.min(s.p[1], 6));
    if (d < 0.85 && S.inv <= 0 && s.hp > 0) {
      S.hearts -= 1; S.inv = 1.6; S.shake = 0.6; s.hp = 0;
      S.v = add(S.v, scale(norm([-dir[0], 0, -dir[2]]), 9)); S.v[1] = 5;
      if (S.hearts <= 0) end(false);
    }
  }
  S.shades = S.shades.filter((s) => s.hp > -0.6);
  for (const s of S.shades) if (s.hp <= 0) s.hp -= dt * 1.5;
}
function end(won) {
  S.phase = won ? 'won' : 'lost';
  const secs = Math.round(S.clock - S.startedAt);
  $('endTitle').textContent = won ? 'The yard is lit.' : 'The night took you.';
  $('endText').textContent = won ? `All five beacons in ${secs} s. The stone, the moss, the glow and the sky were painted from boxes by a network small enough to run on a phone.` : `${S.beacons.filter((b) => b.on).length} of 5 beacons lit. The shades burn in the beacons' light — lure them in.`;
  $('end').classList.add('show');
}
function startPlay(free) {
  S.free = free; S.phase = free ? 'free' : 'play';
  S.t = free ? 0.66 : T_START; S.p = [...PLAY.spawn]; S.v = [0, 0, 0]; S.yaw = Math.PI; S.hearts = 3; S.inv = 0;
  S.cam.yaw = 0; S.cam.pitch = 0.32;
  S.beacons.forEach((b) => Object.assign(b, { on: false, level: 0, charge: 0 }));
  S.shades = []; S.spawnIn = 3; S.startedAt = S.clock;
  $('title').classList.remove('show'); $('end').classList.remove('show');
  $('hud').classList.add('show'); $('sunbar').classList.toggle('show', free);
  banner(free ? 'FREE ROAM — drag the sun' : 'Find the five crystals. They wake at dusk.');
}
let bannerTimer = 0;
function banner(text) { $('banner').textContent = text; $('banner').classList.add('show'); bannerTimer = 2.8; }

// ---------------- the camera and the picture ----------------
function rayHitBoxes(o, d, maxT) {
  let best = maxT;
  for (const b of BOXES) {
    let t0 = -Infinity, t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) { if (o[a] < b.min[a] || o[a] > b.max[a]) { t0 = Infinity; break; } continue; }
      let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 <= t1 && t1 > 0 && t0 > 0 && t0 < best) best = t0;
  }
  return best;
}
function cameraNow(override) {
  if (override) return override;
  const target = [S.p[0], S.p[1] + 1.45, S.p[2]];
  const c = S.cam, dir = [Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch)];
  const dist = Math.min(c.dist, rayHitBoxes(target, dir, c.dist) - 0.25);
  let eye = add(target, scale(dir, Math.max(1.2, dist)));
  if (S.shake > 0) eye = add(eye, [(Math.random() - 0.5) * S.shake * 0.25, (Math.random() - 0.5) * S.shake * 0.25, 0]);
  return { eye, at: target };
}
function boxModel(base, yaw, off, size, extraYaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const o = [off[0] * c + off[2] * s, off[1], -off[0] * s + off[2] * c];
  return m4.trs(add(base, o), yaw + extraYaw, size);
}
// the moving things, as boxes: each part says what it is made of, its colour and its form (the painters paint the rest: its shape too)
function part(base, yaw, off, size, color, mat, extra = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw), pos = add(base, [off[0] * c + off[2] * s, off[1], -off[0] * s + off[2] * c]);
  return { model: boxModel(base, yaw, off, size, extra.spin || 0), color, mat, size, emissive: extra.emissive, form: extra.form ? FORM[extra.form] : 0, pos, yaw: yaw + (extra.spin || 0) };
}
function dynamics() {
  const out = [];
  const p = S.p, y = S.yaw, flick = S.inv > 0 && Math.floor(S.clock * 12) % 2 === 0;
  if (!flick && S.phase !== 'title') {
    const tunic = [0.13, 0.28, 0.5], skin = [0.82, 0.64, 0.5], dark = [0.08, 0.08, 0.1], scarf = [0.85, 0.32, 0.12];
    const legY = 0.33, swing = (k) => Math.sin(S.walk * 3.2 + k) * 0.18;
    out.push(part(p, y, [-0.12, legY, swing(0)], [0.2, 0.62, 0.22], dark, M.cloth, { form: 'limb' }));
    out.push(part(p, y, [0.12, legY, swing(Math.PI)], [0.2, 0.62, 0.22], dark, M.cloth, { form: 'limb' }));
    out.push(part(p, y, [0, 0.95, 0], [0.56, 0.68, 0.34], tunic, M.cloth, { form: 'torso' }));
    out.push(part(p, y, [0, 1.26, 0.02], [0.6, 0.12, 0.38], scarf, M.cloth, { form: 'roll' }));
    out.push(part(p, y, [-0.36, 0.95, swing(Math.PI) * 0.8], [0.15, 0.56, 0.16], tunic, M.cloth, { form: 'limb' }));
    out.push(part(p, y, [0.36, 0.95, swing(0) * 0.8], [0.15, 0.56, 0.16], tunic, M.cloth, { form: 'limb' }));
    out.push(part(p, y, [0, 1.52, 0], [0.38, 0.38, 0.38], skin, M.skin, { form: 'head' }));
    out.push(part(p, y, [0.0, 1.52, 0.2], [0.26, 0.07, 0.02], [0.05, 0.05, 0.06], M.cloth));
  }
  for (const s of S.shades) {
    const k = Math.max(0, Math.min(1, s.hp + 0.6)), bob = Math.sin(S.clock * 3 + s.wob) * 0.12, yaw = Math.atan2(S.p[0] - s.p[0], S.p[2] - s.p[2]);
    const base = [s.p[0], s.p[1] + bob, s.p[2]], body = [0.02, 0.015, 0.035], eyes = [7, 0.9, 1.6], veins = [0.05, 0.015, 0.11];
    out.push(part(base, yaw, [0, 0.85, 0], [0.75 * k, 1.25 * k, 0.75 * k], body, M.shade, { emissive: veins, form: 'wraith' }));
    out.push(part(base, yaw, [0, 0.12, 0], [0.42 * k, 0.4 * k, 0.42 * k], body, M.shade, { emissive: veins, spin: S.clock * 2, form: 'orb' }));
    out.push(part(base, yaw, [-0.16, 1.12, 0.38 * k], [0.13 * k, 0.08 * k, 0.03], [0, 0, 0], M.shade, { emissive: eyes }));
    out.push(part(base, yaw, [0.16, 1.12, 0.38 * k], [0.13 * k, 0.08 * k, 0.03], [0, 0, 0], M.shade, { emissive: eyes }));
  }
  return out;
}

// ---------------- the frame loop ----------------
let R_, painter, last = performance.now(), fpsEma = 60, renderScale = 1, slowFor = 0, fastFor = 0, painted = false, camOverride = null;
const isPhone = () => !!(window.__MOSA_DEVICE ? (window.__MOSA_DEVICE.mobile || window.__MOSA_DEVICE.touch) : matchMedia('(pointer: coarse)').matches);
function sizeCanvas() {
  if (!R_) return;
  if (Q.has('w')) { R_.resize(+Q.get('w'), +Q.get('h')); canvas.style.width = '100vw'; canvas.style.height = '100vh'; return; }
  // a phone draws within a pixel budget (about 1.3 million pixels), a computer at up to twice its CSS size
  const css = innerWidth * innerHeight, budget = isPhone() ? 1.3e6 : 3.7e6;
  const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(budget / css)) * renderScale;
  R_.resize(innerWidth * dpr, innerHeight * dpr);
  document.body.classList.toggle('touch', isPhone());
}
function step(dt) {
  S.clock += dt;
  if (S.phase === 'play') {
    S.t = Math.min(1, S.t + dt * T_RATE);
    if (S.t >= AWAKE_T && S.t - dt * T_RATE < AWAKE_T) banner('Dusk. The crystals are awake — light them.');
    if (S.t >= SHADES_T && S.t - dt * T_RATE < SHADES_T) banner('Shades are coming. Their weakness is light.');
  }
  if (S.phase === 'title') { S.cam.yaw += dt * 0.06; }
  if (S.phase === 'play' || S.phase === 'free' || S.phase === 'won') playerUpdate(dt);
  const near = beaconUpdate(dt);
  shadeUpdate(dt);
  if (S.phase === 'play' && S.beacons.every((b) => b.on)) end(true);
  S.inv = Math.max(0, S.inv - dt); S.shake = Math.max(0, S.shake - dt * 1.8);
  bannerTimer -= dt; if (bannerTimer <= 0) $('banner').classList.remove('show');
  // hud
  $('pips').innerHTML = S.beacons.map((b) => `<i style="--c:rgb(${b.color.map((x) => Math.round(x * 255)).join(',')})" class="${b.on ? 'on' : ''}"></i>`).join('');
  $('hearts').textContent = '♥'.repeat(Math.max(0, S.hearts)) + '♡'.repeat(Math.max(0, 3 - S.hearts));
  const awake = S.t >= AWAKE_T || S.free;
  $('prompt').textContent = near ? (awake ? (near.charge > 0 ? 'Lighting…' : 'Stand by the crystal') : 'It sleeps until dusk') : '';
  $('sunfill').style.width = `${Math.min(100, (S.t / 1) * 100)}%`;
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (lost) { requestAnimationFrame(frame); return; }
  if (!window.__LP_MANUAL) step(dt);
  draw();
  // keep it smooth: lower the resolution when frames run long, raise it back when there is room
  fpsEma = fpsEma * 0.93 + (1 / Math.max(dt, 1e-3)) * 0.07;
  if (!Q.has('w')) {
    if (dt > 0.021) { slowFor += dt; fastFor = 0; } else if (dt < 0.0175) { fastFor += dt; slowFor = 0; }
    if (slowFor > 1.0 && renderScale > 0.5) { renderScale = Math.max(0.5, renderScale * 0.85); slowFor = 0; sizeCanvas(); }
    if (fastFor > 4.0 && renderScale < 1) { renderScale = Math.min(1, renderScale * 1.08); fastFor = 0; sizeCanvas(); }
  }
  $('fps').textContent = `${Math.round(fpsEma)} fps · ${R_.w}×${R_.h}`;
  requestAnimationFrame(frame);
}
function draw() {
  const cam = cameraNow(camOverride);
  const aspect = R_.w / R_.h;
  const proj = m4.perspective((aspect < 1 ? 68 : 58) * Math.PI / 180, aspect, 0.1, 2500);   // (the land runs out past the haze)
  const view = m4.lookAt(cam.eye, cam.at, [0, 1, 0]);
  const sd = sunDirJS(S.t), si = sunIrrJS(S.t);
  const beaconLight = [], beaconGlow = [];
  S.beacons.forEach((b, k) => {
    const pulse = 1 + 0.05 * Math.sin(S.clock * 2.3 + k * 1.7);
    const lit = b.level * BEACON_POWER * pulse;
    beaconLight.push(...b.color.map((c) => c * lit));
    const awake = S.t >= AWAKE_T || S.free;
    const idle = b.on ? 0 : (awake ? 1.2 + 0.9 * Math.sin(S.clock * 4 + k) + b.charge * 4 : 0.35);
    beaconGlow.push(...b.color.map((c) => c * (lit * GLOW_LIT + idle) + 0.04));
  });
  const occluders = S.phase === 'title' ? [] : [[S.p[0], S.p[1] + 0.45, S.p[2], 0.42], [S.p[0], S.p[1] + 1.2, S.p[2], 0.4]];
  for (const s of S.shades) occluders.push([s.p[0], s.p[1] + 0.8, s.p[2], 0.45]);
  R_.frame({ mode: S.mode, t: S.t, eye: cam.eye, view, proj, sunDir: sd, sunIrr: si, beaconLight, beaconGlow, dynamics: dynamics(), occluders, time: S.clock });
  if (!painted) {
    painted = true;
    if (window.__MOSA_BOOT) window.__MOSA_BOOT.ok = true;
    $('loading').classList.add('gone');
    phase(1, 'ready');
  }
}
// the sun, mirrored from the GLSL (the code needs it for the shadow map)
function sunDirJS(t) {
  const e = sunElevDeg(t) * Math.PI / 180, h = norm([0.9, 0, 0.38]);
  return norm([h[0] * Math.cos(e), Math.sin(e), h[2] * Math.cos(e)]);
}
function sunIrrJS(t) {
  const e = sunElevDeg(t), ss = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const vis = ss(-0.5, 3.5, e), w = ss(2, 24, e), mag = 1.7 + (3.2 - 1.7) * ss(2, 20, e);
  return [1.0, 0.33 + (0.82 - 0.33) * w, 0.09 + (0.62 - 0.09) * w].map((c) => c * vis * mag);
}

// ---------------- boot ----------------
const mosaBoot = window.__mosaBoot;
try { mosaBoot && mosaBoot.claimSurface && mosaBoot.claimSurface({ dismiss: 'self' }); } catch {}
const phase = (p, name) => { try { mosaBoot && mosaBoot.progress && mosaBoot.progress(p, name); } catch {} };
window.__MOSA_CONTROLS = {
  schema: 'mosa.controls.v1',
  actions: [
    { id: 'move', label: 'Move', keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], touch: true, kind: 'stick' },
    { id: 'look', label: 'Look', keys: [], touch: true, kind: 'drag' },
    { id: 'jump', label: 'Jump', keys: ['Space'], touch: '#jump', kind: 'button' },
  ],
};
// the four painters: the light, the surfaces, the sky and the shapes (painter.js), from their files
const PAINTER_FILES = [['light', 'painter.bin'], ['surface', 'surface.bin'], ['sky', 'sky.bin'], ['shape', 'shape.bin']];
let painterBytes = null, lost = false;
function paintersFrom(gl, bytes, mod) {
  return { light: mod.painterFrom(gl, bytes.light), surface: mod.surfaceFrom(gl, bytes.surface), sky: mod.skyFrom(gl, bytes.sky), shape: mod.shapeFrom(gl, bytes.shape) };
}
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; }, false);
canvas.addEventListener('webglcontextrestored', async () => {
  try {
    const gl = canvas.getContext('webgl2');
    painter = paintersFrom(gl, painterBytes, await import('./painter.js'));
    R_ = new Renderer(canvas, painter, { preserve: Q.has('preserve') });
    R_.w = 0; sizeCanvas(); lost = false;
  } catch (err) { $('loading').classList.remove('gone'); $('loadtext').textContent = 'The graphics were taken away and could not come back. Close and open the game again.'; }
}, false);
async function boot() {
  try {
    phase(0.05, 'loading the painters');
    const sizes = {}, got = {}, bytes = {};
    const show = () => {
      const total = Object.values(sizes).reduce((a, b) => a + b, 0), have = Object.values(got).reduce((a, b) => a + b, 0);
      if (total) { $('loadbar').style.width = `${Math.round((have / total) * 100)}%`; phase(0.05 + 0.75 * (have / total), 'loading the painters'); }
    };
    await Promise.all(PAINTER_FILES.map(async ([key, file]) => {
      const res = await fetch(file);
      if (!res.ok) throw new Error(`${file} did not load (${res.status})`);
      sizes[key] = +res.headers.get('content-length') || 0; got[key] = 0;
      const reader = res.body.getReader(), parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got[key] += value.length; show();
      }
      const buf = new Uint8Array(got[key]); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      bytes[key] = buf.buffer;
    }));
    $('loadtext').textContent = 'Waking the painters…';
    await new Promise((r) => setTimeout(r, 30));
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('preserve') });
    if (!gl) throw new Error('This browser has no WebGL2.');
    painterBytes = bytes;
    phase(0.85, 'waking the painters');
    painter = paintersFrom(gl, bytes, await import('./painter.js'));
    R_ = new Renderer(canvas, painter, { preserve: Q.has('preserve') });
    window.LP = { S, setMode, startPlay, step, draw, R: () => R_, painter, setCamera: (c) => (camOverride = c), sizeCanvas };
    // everything the painters learned: their networks' weights, their feature textures and their grids
    const hd = [painter.light.head, painter.surface.head, painter.sky.head, painter.shape.head];
    const learned = hd.reduce((n, h) => n + h.weights + (h.textureValues || 0) + (h.gridValues || 0), 0);
    const mb = (painter.light.bytes + painter.surface.bytes + painter.sky.bytes + painter.shape.bytes) / 1e6;
    $('netsize').textContent = `${(learned / 1e6).toFixed(1)}M learned numbers · ${mb.toFixed(1)} MB`;
    setMode(S.mode);
    sizeCanvas(); addEventListener('resize', sizeCanvas); addEventListener('mosa:device', sizeCanvas);
    if (Q.has('free')) startPlay(true);
    else if (Q.has('play')) startPlay(false);
    requestAnimationFrame(frame);
  } catch (e) {
    $('loadtext').textContent = 'This device could not start the game: ' + (e.message || e);
    console.error(e);
  }
}
$('playBtn').addEventListener('click', () => startPlay(false));
$('freeBtn').addEventListener('click', () => startPlay(true));
$('againBtn').addEventListener('click', () => startPlay(false));
$('freeBtn2').addEventListener('click', () => { $('end').classList.remove('show'); S.free = true; S.phase = 'free'; S.shades = []; $('sunbar').classList.add('show'); });
$('sun').addEventListener('input', (e) => { S.t = +e.target.value; });
boot();
