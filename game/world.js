// The world, owned by code: every box, every material, the beacons and the sky.
// The game and the bake (path tracer + trainer) both import this file, so the painter is trained on exactly the world it paints.

export const MAT = [
  // name,     base albedo (linear), proxy colour (the boxes view)
  ['grass',   [0.150, 0.230, 0.085], [0.42, 0.42, 0.42]],
  ['tile',    [0.500, 0.420, 0.320], [0.55, 0.55, 0.55]],
  ['sand',    [0.580, 0.460, 0.330], [0.80, 0.62, 0.42]],
  ['dark',    [0.290, 0.275, 0.265], [0.48, 0.50, 0.56]],
  ['wood',    [0.360, 0.220, 0.120], [0.66, 0.44, 0.24]],
  ['roof',    [0.500, 0.200, 0.120], [0.80, 0.36, 0.26]],
  ['plaster', [0.700, 0.660, 0.580], [0.90, 0.88, 0.80]],
  ['basalt',  [0.110, 0.110, 0.120], [0.25, 0.25, 0.28]],
  ['crystal', [0.000, 0.000, 0.000], [0.95, 0.95, 0.95]],
  ['moss',    [0.180, 0.290, 0.110], [0.40, 0.62, 0.32]],
  ['banner',  [0.450, 0.070, 0.070], [0.85, 0.20, 0.20]],
  ['bark',    [0.200, 0.130, 0.080], [0.50, 0.34, 0.20]],
  ['leaf',    [0.090, 0.200, 0.060], [0.30, 0.58, 0.28]],
  // what moving things are made of (the colour of each part is the code's: a blue tunic, an orange scarf)
  ['cloth',   [0.700, 0.700, 0.700], [0.60, 0.60, 0.60]],
  ['skin',    [0.800, 0.800, 0.800], [0.80, 0.80, 0.80]],
  ['shade',   [0.050, 0.040, 0.060], [0.10, 0.10, 0.12]],
];
export const M = Object.fromEntries(MAT.map((m, i) => [m[0], i]));

// How each material's pattern sits on a face, for the bake's detailed world and the painter alike:
//   [0, tileU, tileV]        world metres: a wall's courses run on across the boxes it is made of
//   [1, tileU, tileV, vTop]  metres from the box's own corner: one banner, one crate, one pedestal each; a top face is moved up by
//                            vTop, so the sides and the top hold different patterns in the same tile
// The pattern repeats on its tile, so a tiled feature texture can hold it exactly.
export const MAT_UV = {
  grass: [0, 4, 4], tile: [0, 4, 4], sand: [0, 4, 4], dark: [0, 4, 4], wood: [1, 4, 4, 0], roof: [0, 4, 4], plaster: [0, 4, 4],
  basalt: [1, 1.0, 1.6, 0.6], crystal: [1, 0.5, 1.8, 1.3], moss: [0, 4, 4], banner: [1, 1.0, 2.4, 0], bark: [0, 4, 4], leaf: [0, 4, 4],
  cloth: [1, 1.0, 1.0, 0], skin: [1, 0.4, 0.8, 0.4], shade: [1, 1.0, 1.6, 0],
};

// The five beacons: what the player lights. Colour is the light they give; the painter learns each one's light at unit strength.
export const BEACONS = [
  { name: 'amber', color: [1.00, 0.55, 0.20], at: [0.0, 2.15, 0.0] },
  { name: 'teal',  color: [0.20, 0.90, 0.80], at: [14.6, 7.25, -13.8] },
  { name: 'rose',  color: [1.00, 0.28, 0.55], at: [10.9, 1.45, 10.9] },
  { name: 'ice',   color: [0.45, 0.65, 1.00], at: [-11.9, 1.45, 1.0] },
  { name: 'lime',  color: [0.55, 1.00, 0.30], at: [-9.0, 1.85, -11.3] },
];
export const BEACON_POWER = 9.0;   // emitted radiance of a lit crystal (the painter's unit light is scaled by this and the colour)
export const GLOW_LIT = 0.3;       // how bright a lit crystal looks, per unit of the light it throws (bright, but its facets still show)

export const BOXES = [];
function B(x0, y0, z0, x1, y1, z1, mat, emit = -1, glow = -1) {
  BOXES.push({ min: [x0, y0, z0], max: [x1, y1, z1], m: M[mat], e: emit, glow: glow >= 0 ? glow : emit });
}

// ground and the courtyard floor
B(-2000, -1, -2000, 2000, 0, 2000, 'grass');   // out past the haze: from a tower the land runs to the horizon
B(-13, 0, -13, 13, 0.2, 13, 'tile');

// north wall with its gate
B(-12.6, 0, -14.2, -2.2, 5.2, -13, 'sand');
B(2.2, 0, -14.2, 12.6, 5.2, -13, 'sand');
B(-2.7, 0, -14.5, -2.0, 4.0, -12.7, 'dark');
B(2.0, 0, -14.5, 2.7, 4.0, -12.7, 'dark');
B(-2.7, 3.6, -14.5, 2.7, 4.4, -12.7, 'dark');
B(-2.2, 4.4, -14.2, 2.2, 5.2, -13, 'sand');
B(-4.2, 2.2, -13.0, -3.2, 4.6, -12.9, 'banner');
B(3.2, 2.2, -13.0, 4.2, 4.6, -12.9, 'banner');

// west wall with three tall windows
B(-14.2, 0, -12.6, -13, 1.6, 12.6, 'sand');
B(-14.2, 4.0, -12.6, -13, 5.2, 12.6, 'sand');
for (const [z0, z1] of [[-12.6, -7.0], [-5.5, -0.75], [0.75, 5.5], [7.0, 12.6]]) B(-14.2, 1.6, z0, -13, 4.0, z1, 'sand');

// east wall, ruined: the evening sun comes in over it
B(13, 0, -12.6, 14.2, 5.2, -8.0, 'sand');
B(13, 0, -8.0, 14.2, 1.4, -4.0, 'sand');
B(13, 0, -4.0, 14.2, 2.6, 1.0, 'sand');
B(13, 0, 1.0, 14.2, 0.6, 7.0, 'sand');
B(13, 0, 7.0, 14.2, 5.2, 12.6, 'sand');

// south wall with an arch
B(-12.6, 0, 13, -6.4, 5.2, 14.2, 'sand');
B(-3.4, 0, 13, 12.6, 5.2, 14.2, 'sand');
B(-6.4, 3.2, 13, -3.4, 5.2, 14.2, 'sand');

// corner towers (the north-east one is lower and reached by stairs)
function merlons(x0, z0, x1, z1, y, sides) {
  const s = 0.9, h = 0.8, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const put = (x, z) => B(x - s / 2, y, z - s / 2, x + s / 2, y + h, z + s / 2, 'dark');
  if (sides.includes('n')) for (const x of [x0 + s / 2, mx, x1 - s / 2]) put(x, z0 + s / 2);
  if (sides.includes('s')) for (const x of [x0 + s / 2, mx, x1 - s / 2]) put(x, z1 - s / 2);
  if (sides.includes('w')) put(x0 + s / 2, mz);
  if (sides.includes('e')) put(x1 - s / 2, mz);
}
B(-16.6, 0, -16.6, -12.6, 7.5, -12.6, 'dark'); merlons(-16.6, -16.6, -12.6, -12.6, 7.5, 'nswe');
B(-16.6, 0, 12.6, -12.6, 7.5, 16.6, 'dark');   merlons(-16.6, 12.6, -12.6, 16.6, 7.5, 'nswe');
B(12.6, 0, 12.6, 16.6, 7.5, 16.6, 'dark');     merlons(12.6, 12.6, 16.6, 16.6, 7.5, 'nswe');
B(12.6, 0, -16.6, 16.6, 6.0, -11.0, 'dark');   merlons(12.6, -16.6, 16.6, -11.0, 6.0, 'ne');

// stairs up to the north-east tower
for (let i = 0; i < 11; i++) B(1.6 + i, 0, -13, 2.6 + i, 0.2 + (5.8 / 11) * (i + 1), -11.6, 'sand');

// the central plinth
B(-2.6, 0.2, -2.6, 2.6, 0.55, 2.6, 'dark');
B(-1.7, 0.55, -1.7, 1.7, 0.9, 1.7, 'sand');

// the shed in the south-east corner (its door faces the yard)
B(6.0, 0, 7.0, 7.0, 3.6, 13.0, 'plaster');
B(6.0, 0, 6.0, 8.6, 3.6, 7.0, 'plaster');
B(10.8, 0, 6.0, 13.0, 3.6, 7.0, 'plaster');
B(8.6, 2.7, 6.0, 10.8, 3.6, 7.0, 'plaster');
B(5.7, 3.6, 5.7, 13.0, 4.2, 13.0, 'roof');

// the west colonnade
for (const zc of [-9.0, -5.0, -1.0, 3.0, 7.0]) B(-10.45, 0.2, zc - 0.45, -9.55, 4.2, zc + 0.45, 'plaster');
B(-13.0, 4.2, -10.0, -9.3, 4.8, 8.0, 'wood');

// the raised garden bed in the north-west
B(-12.0, 0.2, -13.0, -6.0, 0.6, -9.6, 'moss');
B(-11.6, 0.6, -12.7, -10.6, 1.4, -11.7, 'leaf');
B(-7.4, 0.6, -12.6, -6.5, 1.2, -11.6, 'leaf');

// crates, rubble, benches
B(10.8, 0.2, -5.4, 11.8, 1.2, -4.4, 'wood');
B(11.0, 1.2, -5.2, 11.8, 2.0, -4.4, 'wood');
B(10.6, 0.2, -3.8, 11.4, 1.0, -3.0, 'wood');
B(12.0, 0.2, 3.6, 13.0, 0.7, 4.6, 'dark');
B(11.4, 0.2, 5.0, 12.4, 0.5, 5.8, 'dark');
B(-8.2, 0.2, 10.8, -7.2, 1.2, 11.8, 'wood');
B(-2.6, 0.2, 11.4, -1.8, 1.0, 12.2, 'wood');
B(4.3, 0.2, -0.6, 5.5, 0.6, 0.6, 'sand');
B(-0.6, 0.2, 4.3, 0.6, 0.6, 5.5, 'sand');

// trees and rocks outside the walls
for (const [x, z] of [[-19.5, -18.5], [19.5, -4.0], [-19.0, 6.5], [18.5, 19.0], [-7.5, 19.0], [6.5, -19.0]]) {
  B(x - 0.3, 0, z - 0.3, x + 0.3, 2.5, z + 0.3, 'bark');
  B(x - 1.6, 2.2, z - 1.6, x + 1.6, 4.8, z + 1.6, 'leaf');
  B(x - 1.0, 4.8, z - 1.0, x + 1.0, 5.8, z + 1.0, 'leaf');
}
for (const [x, z, s] of [[-17.5, -2.0, 0.9], [17.0, 9.0, 1.1], [3.0, 18.0, 0.8], [-3.0, -18.5, 1.0]]) B(x - s, 0, z - s * 0.8, x + s, s * 0.9, z + s * 0.8, 'dark');

// pedestals and crystals: the code keeps how brightly each one glows; the painter paints the glow
const PED = [[0, 0.9], [14.6, 6.0], [10.9, 0.2], [-11.9, 0.2], [-9.0, 0.6]];
BEACONS.forEach((b, k) => {
  const [x, y] = PED[k], z = [0, -13.8, 10.9, 1.0, -11.3][k];
  B(x - 0.5, y, z - 0.5, x + 0.5, y + 0.6, z + 0.5, 'basalt', -1, k);   // its runes glow with its crystal
  B(x - 0.25, y + 0.6, z - 0.25, x + 0.25, y + 1.9, z + 0.25, 'crystal', k);
  b.at = [x, y + 1.25, z];
});

// How each face meets the world at its four edges (u-low, u-high, v-low, v-high, in faceUV's order): 1 an outside corner (the bake's
// stone is rounded and worn there), 2 an inside corner (another box rises beyond it), 0 the surface runs on into another box.
// Faces in BOXES order: axis 0 low, 0 high, 1 low, 1 high, 2 low, 2 high.
export const UVAX = [[2, 1], [0, 2], [0, 1]];   // for a face across axis a: which world axes are its u and v
export function edgeFlags(b, a, side) {
  const [ua, va] = UVAX[a], plane = side ? b.max[a] : b.min[a], out = [];
  for (const [ax, hi] of [[ua, 0], [ua, 1], [va, 0], [va, 1]]) {
    const other = ax === ua ? va : ua, votes = [0, 0, 0];
    for (const s of [0.2, 0.5, 0.8]) {
      const p = [0, 0, 0];
      p[a] = plane; p[ax] = hi ? b.max[ax] : b.min[ax]; p[other] = b.min[other] + (b.max[other] - b.min[other]) * s;
      const above = [...p], below = [...p];
      above[ax] += hi ? 0.03 : -0.03; above[a] += side ? 0.03 : -0.03;
      below[ax] += hi ? 0.03 : -0.03; below[a] -= side ? 0.03 : -0.03;
      votes[insideAnyBox(above) ? 2 : insideAnyBox(below) ? 0 : 1]++;
    }
    out.push(votes.indexOf(Math.max(...votes)));
  }
  return out;
}

// the painter's volume: where its grid lives (outside it the light fades to a plain sky)
export const GRID = { min: [-20, -0.5, -20], max: [20, 9.5, 20], h1: 0.5, h0: 2.0, f1: 8, f0: 4 };
GRID.n1 = GRID.max.map((v, i) => Math.round((v - GRID.min[i]) / GRID.h1) + 1);
GRID.n0 = GRID.max.map((v, i) => Math.round((v - GRID.min[i]) / GRID.h0) + 1);
GRID.off = 0.25;   // the grid is read half a cell off the surface, so the two sides of a wall never share a cell

export const PLAY = { half: 18.5, spawn: [0, 0.2, 8.5] };

// ---- shared GLSL: the sky, the materials, the tone. One text for the game and the bake. ----
const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

export const GLSL_COMMON = `
const float PI = 3.14159265359;
float sunElev(float t) { return mix(30.0, -20.0, t); }
vec3 sunDir(float t) {
  float e = radians(sunElev(t));
  vec3 h = normalize(vec3(0.9, 0.0, 0.38));
  return normalize(vec3(h.x * cos(e), sin(e), h.z * cos(e)));
}
vec3 sunIrr(float t) {
  float e = sunElev(t);
  float vis = smoothstep(-0.5, 3.5, e);
  vec3 c = mix(vec3(1.0, 0.33, 0.09), vec3(1.0, 0.82, 0.62), smoothstep(2.0, 24.0, e));
  return c * vis * mix(1.7, 3.2, smoothstep(2.0, 20.0, e));
}
vec3 key5(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  if (t < 0.35) return mix(a, b, smoothstep(0.0, 0.35, t));
  if (t < 0.59) return mix(b, c, smoothstep(0.35, 0.59, t));
  if (t < 0.78) return mix(c, d, smoothstep(0.59, 0.78, t));
  return mix(d, e, smoothstep(0.78, 1.0, t));
}
vec3 skyZenith(float t)  { return key5(t, vec3(0.13, 0.25, 0.52), vec3(0.10, 0.17, 0.40), vec3(0.055, 0.075, 0.21), vec3(0.014, 0.018, 0.055), vec3(0.005, 0.007, 0.020)); }
vec3 skyHorizon(float t) { return key5(t, vec3(0.42, 0.46, 0.52), vec3(0.60, 0.50, 0.38), vec3(0.78, 0.38, 0.21), vec3(0.11, 0.055, 0.085), vec3(0.008, 0.009, 0.018)); }
vec3 skyGlow(float t)    { return key5(t, vec3(0.10, 0.06, 0.02), vec3(0.45, 0.24, 0.08), vec3(0.95, 0.42, 0.16), vec3(0.20, 0.06, 0.05), vec3(0.0)); }
vec3 skyRadiance(vec3 d, float t) {
  if (d.y < 0.0) return skyHorizon(t) * vec3(0.10, 0.11, 0.09);
  vec3 col = mix(skyHorizon(t), skyZenith(t), pow(d.y, 0.42));
  vec3 s = sunDir(t);
  vec3 hs = normalize(vec3(s.x, 0.0, s.z));
  vec3 hd = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5));
  col += skyGlow(t) * pow(max(dot(hd, hs), 0.0), 5.0) * exp(-d.y * 6.0);
  return col;
}
float exposureAt(float t) { return mix(1.0, 3.4, smoothstep(0.45, 0.92, t)); }
vec3 tonemap(vec3 x) {
  x *= 0.8;
  x = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  return pow(x, vec3(1.0 / 2.2));
}
vec3 applyFog(vec3 col, vec3 ro, vec3 p, float t) {
  vec3 d = p - ro;
  float dist = length(d);
  vec3 fc = skyRadiance(normalize(vec3(d.x, 0.04, d.z)), t);
  return mix(col, fc, 1.0 - exp(-dist * 0.0085));
}

const vec3 MAT_ALBEDO[${MAT.length}] = vec3[${MAT.length}](${MAT.map((m) => v3(m[1])).join(', ')});
const vec3 MAT_PROXY[${MAT.length}] = vec3[${MAT.length}](${MAT.map((m) => v3(m[2])).join(', ')});

uint hashu(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float hash3(vec3 p) { return float(hashu(uvec3(ivec3(floor(p)) + 4096))) * (1.0 / 4294967295.0); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec2 faceUV(vec3 p, vec3 n) { vec3 a = abs(n); return a.x > 0.5 ? p.zy : (a.z > 0.5 ? p.xy : p.xz); }
// the face's own directions: T along u, B along v (faceUV's order)
void faceTB(vec3 n, out vec3 T, out vec3 B) {
  vec3 a = abs(n);
  if (a.x > 0.5) { T = vec3(0, 0, 1); B = vec3(0, 1, 0); }
  else if (a.z > 0.5) { T = vec3(1, 0, 0); B = vec3(0, 1, 0); }
  else { T = vec3(1, 0, 0); B = vec3(0, 0, 1); }
}
const vec4 MAT_UV[${MAT.length}] = vec4[${MAT.length}](${MAT.map((m) => { const u = MAT_UV[m[0]]; return `vec4(${f(u[0])}, ${f(u[1])}, ${f(u[2])}, ${f(u[3] || 0)})`; }).join(', ')});
// where a material's pattern is at a point (see MAT_UV)
vec2 matUV(int m, vec3 p, vec3 n, vec3 bmin) {
  vec4 mu = MAT_UV[m];
  if (mu.x < 0.5) return faceUV(p, n);
  vec2 uv = faceUV(p - bmin, n);
  if (abs(n.y) > 0.5) uv.y += mu.w;
  return uv;
}
// what the painter is told about the face's edges at a point: the nearest outside corner across u and across v (signed by side, over
// the last 6 cm), how near an inside corner is (half a metre) and how near any outside corner is (30 cm)
vec4 edgeFeatures(vec2 uv, vec2 lo, vec2 hi, vec4 fl) {
  vec4 d = vec4(uv.x - lo.x, hi.x - uv.x, uv.y - lo.y, hi.y - uv.y);
  vec4 r6 = 1.0 - clamp(d / 0.06, 0.0, 1.0), r30 = 1.0 - clamp(d / 0.3, 0.0, 1.0), r50 = 1.0 - clamp(d / 0.5, 0.0, 1.0);
  vec4 cx = vec4(equal(fl, vec4(1.0))), cc = vec4(equal(fl, vec4(2.0)));
  return vec4(r6.y * cx.y - r6.x * cx.x, r6.w * cx.w - r6.z * cx.z, max(max(r50.x * cc.x, r50.y * cc.y), max(r50.z * cc.z, r50.w * cc.w)),
              max(max(r30.x * cx.x, r30.y * cx.y), max(r30.z * cx.z, r30.w * cx.w)));
}
// facts the code keeps about the sky: where the stars are, where the sun's disk is
float starMask(vec3 d) {
  if (d.y <= 0.0) return 0.0;
  vec3 c = d * 140.0, f = fract(c) - 0.5;
  return step(0.9965, hash3(floor(c) + 17.0)) * smoothstep(0.32, 0.12, length(f)) * smoothstep(0.0, 0.15, d.y);   // a point of light in its cell
}
float sunDisk(vec3 d, float t) { return smoothstep(0.99975, 0.99985, dot(d, sunDir(t))); }
`;

// ---- small JS helpers the game rules use ----
export function sunElevDeg(t) { return 30 - 50 * t; }
export function boxContains(b, p, pad = 0) {
  return p[0] > b.min[0] - pad && p[0] < b.max[0] + pad && p[1] > b.min[1] - pad && p[1] < b.max[1] + pad && p[2] > b.min[2] - pad && p[2] < b.max[2] + pad;
}
export function insideAnyBox(p, pad = 0) { for (const b of BOXES) if (boxContains(b, p, pad)) return true; return false; }
