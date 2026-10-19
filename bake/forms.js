// The detailed world's SHAPES: what each form (world.js FORMS) looks like, as a distance field in the form's own frame. Only the bake
// has this. The path tracer renders it (pt.js), the shape painter learns it (train_shape.py), and the game traces the learned shape
// inside each box's shell. It plays the part Unreal Engine 5's meshes play for Matrix-Game 4.0.
//
// c is a point in the form's frame (world.js formCanon): along a 'mirror' axis, metres in from the nearer face (negative outside it);
// along a 'tile' axis, metres into the period; along an 'ends' axis, read with formEnds (metres down from the top face, up from the
// bottom face); along a 'span' axis, metres across the form's nominal box. Every field is a distance bound: its slope stays near 1.
import { FORM } from '../game/world.js';

export const FORMS_GLSL = `
float sdIn2(vec2 d) { return length(max(-d, 0.0)) + min(max(-d.x, -d.y), 0.0); }
float sdIn3(vec3 d) { return length(max(-d, 0.0)) + min(max(-d.x, max(-d.y, -d.z)), 0.0); }
float sdIn4(vec4 d) { return length(max(-d, 0.0)) + min(max(max(-d.x, -d.y), max(-d.z, -d.w)), 0.0); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdRoundBox(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-6); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r; }
float sdHex(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p); p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy; p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}
float bump(float t) { t = clamp(t, -1.0, 1.0); return (1.0 - t * t) * (1.0 - t * t); }
// an angle about an axis, defined on the axis itself too (atan2s(0, 0) is not, and a grid point on a trunk's axis would be NaN)
float atan2s(float y, float x) { return atan(y, abs(x) + abs(y) < 1e-7 ? 1e-7 : x); }
// value noise that repeats every per cells along x
float hper(vec3 i, float per, uint seed) { i.x = mod(i.x, per); return float(hashu(uvec3(ivec3(i) + 4096) + uvec3(seed, 0u, 0u))) * (1.0 / 4294967295.0); }
float pv3(vec3 p, float per, uint seed) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hper(i, per, seed), hper(i + vec3(1, 0, 0), per, seed), f.x), mix(hper(i + vec3(0, 1, 0), per, seed), hper(i + vec3(1, 1, 0), per, seed), f.x), f.y),
             mix(mix(hper(i + vec3(0, 0, 1), per, seed), hper(i + vec3(1, 0, 1), per, seed), f.x), mix(hper(i + vec3(0, 1, 1), per, seed), hper(i + vec3(1, 1, 1), per, seed), f.x), f.y), f.z);
}
// a solid of revolution's distance: r from its axis, R its radius there, dR how fast R changes with height
float revolve(float r, float R, float dR) { return (r - R) / sqrt(1.0 + dR * dR); }

// ---- the walls ----
// a wall: ashlar on a chamfered plinth, a string course under a crenellated parapet (merlons every 1.3 m), every arris worn
float fWall(int f, vec3 c, float plinth) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y, w = c.z, u = c.x;
  float po = plinth * 0.08 * (1.0 - smoothstep(0.40, 0.56, dBot)) + 0.065 * smoothstep(0.36, 0.30, dTop) * smoothstep(0.08, 0.14, dTop);
  float body = sdIn3(vec3(w + po, dTop, dBot) - 0.025) - 0.025;
  float x = abs(u - 0.65);
  float merlon = sdIn3(vec3(0.31 - x, dTop + 0.78, w - 0.05) - 0.03) - 0.03;
  float n = pv3(vec3(u / 1.3 * 7.0, c.y * 5.4, w * 5.4), 7.0, 17u) - 0.5;
  return min(body, merlon) + 0.018 * n;
}
// a ruined wall: its top two courses broken out block by block (four blocks a 2.6 m period), the breaks crumbled
float fRuin(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y, w = c.z, u = c.x;
  float po = 0.08 * (1.0 - smoothstep(0.40, 0.56, dBot));
  float best = 9.0;
  for (int k = -1; k <= 1; k++) {
    float j = floor(u / 0.65) + float(k), jj = mod(j, 4.0);
    float h0 = hash3(vec3(jj, 1.0, 31.0)), h1 = hash3(vec3(jj, 2.0, 31.0)), h2 = hash3(vec3(jj, 3.0, 31.0));
    float depth = h0 < 0.62 ? (h1 < 0.5 ? 0.8 : 0.4) : 0.0;
    depth += 0.09 * (h2 - 0.5);
    float x0 = j * 0.65, x1 = x0 + 0.65;
    best = min(best, sdIn4(vec4(min(u - x0, x1 - u) + 0.01, dTop - depth, dBot, w + po) - 0.02) - 0.02);
  }
  float n = pv3(vec3(u / 2.6 * 14.0, c.y * 5.4, w * 5.4), 14.0, 19u) - 0.5;
  return best + 0.03 * n * smoothstep(1.2, 0.2, dTop);
}
// a window pier: its upright arrises worn, its springers reaching over half of each window under the parapet (a round arch, 1.5 m)
float fPier(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, x = c.x, w = c.z;
  float body = sdIn2(vec2(x, w) - 0.03) - 0.03;
  float sp = max(sdIn3(vec3(x + 0.75, w, 0.75 - dTop)), 0.75 - length(vec2(x + 0.75, dTop - 0.75)));
  float n = vnoise(vec3(x, c.y, w) * 5.4 + 3.0) - 0.5;
  return min(body, sp) + 0.012 * n;
}
// the windows' sill course: a plinth at the foot, the sill stone standing out over the top 12 cm
float fSill(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y, w = c.z;
  float po = 0.08 * (1.0 - smoothstep(0.40, 0.56, dBot)) + 0.07 * smoothstep(0.17, 0.12, dTop);
  float n = pv3(vec3(c.x / 1.3 * 7.0, c.y * 5.4, w * 5.4), 7.0, 23u) - 0.5;
  return sdIn3(vec3(w + po, dTop, dBot) - 0.02) - 0.02 + 0.012 * n;
}
// the stone over an opening: a round arch (radius 1.5 m) springing 1.55 m below it, its ring of voussoirs standing 2 cm proud
float fArchtop(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dBot = e.y < 5.0 ? e.y : 1.2, x = c.x, w = c.z;
  float ring = length(vec2(1.5 - x, dBot + 1.5));
  float vous = smoothstep(1.86, 1.82, ring) * smoothstep(1.46, 1.5, ring);
  float key = smoothstep(0.32, 0.26, abs(1.5 - x)) * smoothstep(1.98, 1.92, ring);
  float a = max(sdIn3(vec3(dBot + 1.55, 1.2 - dBot, w + 0.02 * max(vous, key) + 0.02 * key) - 0.015) - 0.015, 1.5 - ring);
  return a + 0.01 * (vnoise(vec3(x, dBot, w) * 5.4 + 9.0) - 0.5);
}
// a gate post: a plinth, an impost block where the arch springs (1.55-1.8 m up), its upright edges chamfered
float fPost(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y;
  float po = 0.06 * (1.0 - smoothstep(0.30, 0.36, dBot)) + 0.07 * smoothstep(1.52, 1.57, dBot) * smoothstep(1.84, 1.79, dBot);
  vec2 hv = vec2(c.x, c.z) + po;
  return sdIn4(vec4(hv, (hv.x + hv.y - 0.06) * 0.70710678, dTop + 0.02) - 0.012) - 0.012 + 0.01 * (vnoise(vec3(c.x, c.y, c.z) * 5.4) - 0.5);
}
// a tower: its foot battered out 25 cm with a roll moulding on top, its parapet corbelled out 30 cm over a deep cavetto, its corners
// chamfered
float fTower(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y;
  float bat = 0.25 * clamp(1.0 - dBot / 1.15, 0.0, 1.0) + 0.05 * bump((dBot - 1.18) / 0.07);
  float cor = 0.3 * smoothstep(1.55, 0.95, dTop) + 0.03 * bump((dTop - 0.9) / 0.05);
  float po = max(bat, cor);
  vec2 hv = vec2(c.x, c.z) + po;
  float d = sdIn4(vec4(hv, (hv.x + hv.y - 0.1) * 0.70710678, dTop) - 0.02) - 0.02;
  return d + 0.015 * (vnoise(vec3(c.x, c.y, c.z) * 5.4 + 1.0) - 0.5);
}
// a merlon: a little narrower at the top, capped with a low pyramid, every edge chipped
float fMerlon(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x;
  float taper = 0.03 * clamp(1.0 - dTop / 0.45, 0.0, 1.0);
  vec2 hv = vec2(c.x, c.z) - taper;
  float cap = dTop + 0.16 * min(min(hv.x, hv.y) / 0.42, 1.0);
  return sdIn3(vec3(hv, cap) - 0.02) - 0.02 + 0.016 * (vnoise(vec3(c.x, c.y, c.z) * 6.0 + 5.0) - 0.5);
}

// ---- the yard ----
float columnR(float dTop, float dBot) {
  float R = 0.285;
  R += 0.075 * bump((dBot - 0.225) / 0.075) + 0.03 * bump((dBot - 0.335) / 0.032);   // the torus and a roll over the plinth
  R += 0.022 * bump((dTop - 0.5) / 0.028);                                              // the necking ring
  float ech = clamp((0.44 - dTop) / 0.3, 0.0, 1.0);
  return R + 0.13 * ech * ech * (3.0 - 2.0 * ech) * 0.9;                                 // the echinus flaring under the abacus
}
// a column: a round shaft over a square plinth and a torus, a necking ring, the echinus flaring to a square abacus
float fColumn(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y;
  vec2 q = vec2(0.45) - vec2(c.x, c.z);
  float r = length(q);
  float R = columnR(dTop, dBot);
  float dR = (columnR(dTop - 0.004, dBot + 0.004) - columnR(dTop + 0.004, dBot - 0.004)) / 0.008;
  float shaft = revolve(r, R, dR);
  float plinth = sdIn3(vec3(c.x, c.z, 0.14 - dBot) - 0.01) - 0.01;
  float abacus = sdIn3(vec3(c.x - 0.005, c.z - 0.005, 0.14 - dTop) - 0.01) - 0.01;
  return min(shaft, min(plinth, abacus)) + 0.006 * (vnoise(vec3(c.x, c.y, c.z) * 8.0) - 0.5);
}
// a crystal: a hexagonal spire whose faces lean in over its top 0.6 m to a point 0.32 m above the box; four small ones at its foot
float fCrystal(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y;
  vec2 q = vec2(0.25) - vec2(c.x, c.z);
  float a = 0.15 * clamp((dTop + 0.32) / 0.6, 0.0, 1.0);
  float spire = max(sdHex(q, a) * 0.96, -(dTop + 0.32));
  vec2 q2 = q - vec2(0.135, 0.12);
  float a2 = 0.05 * clamp((0.32 - dBot) / 0.14, 0.0, 1.0);
  float small = max(sdHex(q2, a2) * 0.96, dBot - 0.32);
  return min(spire, small);
}
// a canopy: a mass of lobes, lumpy with leaf clusters at two sizes
float fCanopy(vec3 c) {
  vec3 p = c - vec3(1.6, 1.25, 1.6);
  float d = sdEllipsoid(p, vec3(1.45, 1.05, 1.45));
  d = smin(d, length(p - vec3(0.8, 0.3, 0.5)) - 0.85, 0.35);
  d = smin(d, length(p - vec3(-0.75, 0.45, 0.6)) - 0.8, 0.35);
  d = smin(d, length(p - vec3(0.3, 0.65, -0.8)) - 0.85, 0.35);
  d = smin(d, length(p - vec3(-0.6, -0.25, -0.7)) - 0.75, 0.35);
  d = smin(d, length(p - vec3(0.1, 0.95, 0.1)) - 0.8, 0.35);
  d = smin(d, length(p - vec3(0.95, -0.35, -0.55)) - 0.65, 0.3);
  return d + 0.11 * (vnoise(c * 2.2 + 3.0) - 0.5) + 0.05 * (vnoise(c * 5.0 + 11.0) - 0.5);
}
float trunkR(float dBot, float th) { return 0.16 + 0.17 * exp(-max(dBot, 0.0) * 4.2) * (0.55 + 0.45 * cos(4.0 * th)); }
// a trunk 32 cm across, flaring into four roots at its foot
float fTrunk(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dBot = e.y < 5.0 ? e.y : 2.0;
  vec2 q = vec2(0.3) - vec2(c.x, c.z);
  float r = length(q), th = atan2s(q.y, q.x);
  float R = trunkR(dBot, th) + 0.012 * (vnoise(vec3(th * 3.0, c.y * 2.5, 1.0)) - 0.5);
  float dR = (trunkR(dBot + 0.004, th) - trunkR(dBot - 0.004, th)) / 0.008;
  return revolve(r, R, dR);
}
// a rock: a rounded boulder, lumpy, with a couple of flat faces where it split
float fRock(vec3 c) {
  vec3 p = c - vec3(0.9, 0.0, 0.725);
  float d = sdRoundBox(p - vec3(0.0, 0.4, 0.0), vec3(0.86, 0.44, 0.68), 0.34);
  d = smax(d, dot(p - vec3(0.45, 0.55, 0.25), normalize(vec3(0.55, 0.75, 0.35))), 0.05);
  d = smax(d, dot(p - vec3(-0.5, 0.5, -0.2), normalize(vec3(-0.6, 0.6, -0.5))), 0.05);
  return d + 0.09 * (vnoise(c * 1.6 + 7.0) - 0.5) + 0.03 * (vnoise(c * 4.5 + 2.0) - 0.5);
}
// a hipped roof: the box is its eaves, the hips rise 1.5 m to a point over the middle, a ridge of rounded tiles along each hip
float fRoof(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dBot = e.y < 5.0 ? e.y : (e.x < 5.0 ? 0.6 - e.x : 0.6);   // (above the box its top band says how far above)
  vec2 q = abs(vec2(c.x, c.z) - 3.65);
  float y = dBot - 0.6, s = 1.5 / 3.65;
  float pl = (y - s * (3.65 - max(q.x, q.y))) / sqrt(1.0 + s * s);
  float body = max(pl, sdIn3(vec3(3.65 - q.x, 3.65 - q.y, dBot) - 0.02) - 0.02);
  float hip = length(vec2((q.x - q.y) * 0.70710678, y - s * (3.65 - max(q.x, q.y)))) - 0.055;
  hip = max(hip, -(y + 0.04));
  return min(body, hip);
}
// a banner: wool 1.6 cm thick hanging in soft folds from a rod, its hem cut into two tails
float fBanner(int f, vec3 c) {
  vec2 e = formEnds(f, 1, c.y);
  float dTop = e.x, dBot = e.y, u = c.x;
  float hang = e.x < 5.0 ? smoothstep(0.0, 0.15, dTop) : 1.0;   // the folds die out into the rod
  float mid = 0.05 + 0.035 * sin(u * 6.2831853 * 2.0) * hang;
  float sheet = (abs(c.z - mid) - 0.008) * 0.9;
  sheet = max(sheet, -(e.x < 5.0 ? dTop : 1.0));
  float notch = (e.y < 5.0 ? dBot : 1.0) - 0.35 * (1.0 - abs(u - 0.5) * 2.0);
  sheet = max(sheet, -notch * 0.8);
  float rod = length(vec2((e.x < 5.0 ? dTop : 1.0) + 0.02, c.z - 0.05)) - 0.022;
  return min(sheet, rod);
}
// a crate: boards framing every edge stand proud of its panels, iron caps on its corners stand proud of the boards
float fCrate(vec3 c) {
  float m1 = min(c.x, min(c.y, c.z)), m3 = max(c.x, max(c.y, c.z)), m2 = c.x + c.y + c.z - m1 - m3;
  float frame = smoothstep(0.095, 0.075, m2);
  float body = sdIn3(c - 0.014 * (1.0 - frame) - 0.006) - 0.006;
  float cap = max(sdIn3(c + 0.008), m3 - 0.11);
  return min(body, cap);
}
// every other piece of stone and timber: its arrises worn round, a few chips out of them
float fChamfer(vec3 c) { return sdIn3(c - 0.035) - 0.035 + 0.005 * (vnoise(c * 16.0) - 0.5); }

// ---- the moving things' parts ----
// a tunic: chest and shoulders over the belt, flaring below it in folds
float fTorso(vec3 c) {
  vec3 p = c - vec3(0.28, 0.0, 0.17);
  float chest = sdEllipsoid(p - vec3(0.0, 0.48, 0.0), vec3(0.275, 0.22, 0.15));
  float waist = sdRoundBox(p - vec3(0.0, 0.3, 0.0), vec3(0.21, 0.12, 0.135), 0.1);
  float flare = 0.045 * smoothstep(0.24, 0.0, p.y);
  float skirt = sdRoundBox(p - vec3(0.0, 0.1, 0.0), vec3(0.235 + flare, 0.12, 0.155 + flare * 0.6), 0.07);
  float d = smin(smin(chest, waist, 0.08), skirt, 0.06);
  d -= 0.012 * bump((p.y - 0.235) / 0.022);
  return d + 0.006 * sin(atan2s(p.z, p.x) * 9.0) * smoothstep(0.2, 0.04, p.y);
}
// an arm or a leg: a tapering capsule ending in a cuff or a boot
float fLimb(vec3 c) {
  vec3 p = c - vec3(0.09, 0.0, 0.095);
  float r = mix(0.08, 0.068, clamp(p.y / 0.6, 0.0, 1.0));
  float d = sdCapsule(p, vec3(0.0, 0.1, 0.0), vec3(0.0, 0.52, 0.0), r);
  return smin(d, sdRoundBox(p - vec3(0.0, 0.065, 0.015), vec3(0.078, 0.065, 0.098), 0.04), 0.03);
}
// a head: a skull and jaw, a nose, ears
float fHead(vec3 c) {
  vec3 p = c - vec3(0.19, 0.19, 0.19);
  float d = sdEllipsoid(p, vec3(0.15, 0.175, 0.165));
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.085, 0.035), vec3(0.11, 0.095, 0.12)), 0.06);
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.005, 0.165), vec3(0.024, 0.04, 0.03)), 0.02);
  return smin(d, sdEllipsoid(vec3(abs(p.x), p.y, p.z) - vec3(0.15, 0.0, 0.0), vec3(0.022, 0.045, 0.035)), 0.015);
}
// a scarf: a soft roll, folded
float fRoll(vec3 c) {
  vec3 p = c - vec3(0.3, 0.06, 0.19);
  return sdRoundBox(p, vec3(0.29, 0.058, 0.18), 0.055) + 0.008 * sin(atan2s(p.z, p.x) * 7.0);
}
// a shade: a hooded cloak, wide at a hem torn into tatters, narrowing to the shoulders, the hood's opening dark and deep
float fWraith(vec3 c) {
  vec3 p = c - vec3(0.375, 0.0, 0.375);
  float th = atan2s(p.z, p.x);
  float R = mix(0.4, 0.22, smoothstep(0.0, 0.85, p.y / 1.25)) + 0.022 * sin(th * 7.0 + p.y * 2.0);
  float body = max((length(p.xz) - R) * 0.82, p.y - 1.02);
  float hood = sdEllipsoid(p - vec3(0.0, 1.07, -0.02), vec3(0.22, 0.25, 0.24));
  hood = smax(hood, -sdEllipsoid(p - vec3(0.0, 1.05, 0.15), vec3(0.13, 0.15, 0.12)), 0.03);
  float d = smin(body, hood, 0.1);
  float hem = 0.04 + 0.2 * vnoise(vec3(th * 2.6 + 9.0, 0.0, 3.0)) + 0.06 * vnoise(vec3(th * 9.0, 0.0, 7.0));
  return smax(d, hem - p.y, 0.03);
}
// a wisp: a ragged knot of smoke
float fOrb(vec3 c) {
  vec3 p = c - vec3(0.21);
  return length(p) - 0.16 + 0.08 * (vnoise(c * 6.0 + 4.0) - 0.5) + 0.04 * (vnoise(c * 13.0) - 0.5);
}

// the form's truth at c: a distance (metres in the form's frame; negative inside)
float formTruth(int f, vec3 c) {
  if (f == ${FORM.wall}) return fWall(f, c, 1.0);
  if (f == ${FORM.parapet}) return fWall(f, c, 0.0);
  if (f == ${FORM.ruin}) return fRuin(f, c);
  if (f == ${FORM.pier}) return fPier(f, c);
  if (f == ${FORM.sill}) return fSill(f, c);
  if (f == ${FORM.archtop}) return fArchtop(f, c);
  if (f == ${FORM.post}) return fPost(f, c);
  if (f == ${FORM.tower}) return fTower(f, c);
  if (f == ${FORM.merlon}) return fMerlon(f, c);
  if (f == ${FORM.column}) return fColumn(f, c);
  if (f == ${FORM.crystal}) return fCrystal(f, c);
  if (f == ${FORM.canopy}) return fCanopy(c);
  if (f == ${FORM.trunk}) return fTrunk(f, c);
  if (f == ${FORM.rock}) return fRock(c);
  if (f == ${FORM.roof}) return fRoof(f, c);
  if (f == ${FORM.banner}) return fBanner(f, c);
  if (f == ${FORM.crate}) return fCrate(c);
  if (f == ${FORM.chamfer}) return fChamfer(c);
  if (f == ${FORM.torso}) return fTorso(c);
  if (f == ${FORM.limb}) return fLimb(c);
  if (f == ${FORM.head}) return fHead(c);
  if (f == ${FORM.roll}) return fRoll(c);
  if (f == ${FORM.wraith}) return fWraith(c);
  if (f == ${FORM.orb}) return fOrb(c);
  return sdIn3(c);
}
`;
