// The bake's path tracer: the detailed world (truth.js) rendered the slow, exact way. It plays the part Unreal Engine 5's renders play
// for Matrix-Game 4.0. All in WebGL2, on the same machine as the game:
//   samples(): the light arriving at chosen points (position, normal, time of day), the sky's part and each beacon's part: the light painter
//   surface(): what a point of the detailed world sends to the eye, split the same way, with the sun's part and the glow: the surface painter
//   sky():     the detailed sky in chosen directions at chosen times: the sky painter
//   camera():  a full path-traced picture from a camera, to compare the painters against
import { BOXES, BEACONS, BEACON_POWER, MAT, GRID, GLSL_COMMON, FORMS, edgeFlags, shellOf, innerOf, formDomain } from '../game/world.js';
import { TRUTH_GLSL, RUNE_GLOW } from './truth.js';
import { FORMS_GLSL } from './forms.js';

// ---- a BVH over the boxes (median split on the longest axis; leaves of up to 2 boxes; a node's two children sit side by side) ----
export function buildBVH(boxes) {
  const cen = (i, a) => (boxes[i].min[a] + boxes[i].max[a]) / 2;
  function bounds(list) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const i of list) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], boxes[i].min[a]); hi[a] = Math.max(hi[a], boxes[i].max[a]); }
    return [lo, hi];
  }
  function tree(list) {
    const [lo, hi] = bounds(list);
    if (list.length <= 2) return { lo, hi, prims: list };
    const ext = [0, 1, 2].map((a) => hi[a] - lo[a]), axis = ext.indexOf(Math.max(...ext));
    list.sort((p, q) => cen(p, axis) - cen(q, axis));
    const mid = list.length >> 1;
    return { lo, hi, kids: [tree(list.slice(0, mid)), tree(list.slice(mid))] };
  }
  const root = tree(boxes.map((_, i) => i));
  const nodes = [null], order = [], queue = [[root, 0]];
  while (queue.length) {
    const [n, at] = queue.shift();
    if (n.prims) { nodes[at] = { lo: n.lo, hi: n.hi, first: order.length, count: n.prims.length, left: -1 }; order.push(...n.prims); continue; }
    const j = nodes.length;
    nodes.push(null, null);
    nodes[at] = { lo: n.lo, hi: n.hi, left: j, count: 0, first: -1 };
    queue.push([n.kids[0], j], [n.kids[1], j + 1]);
  }
  return { nodes, order };
}

function floatTex(gl, w, h, data, internal = gl.RGBA32F) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, gl.FLOAT, data);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}

const TW = 1024;   // width of the 1D-in-2D data textures

// ---- GLSL: tracing the boxes ----
const GLSL_TRACE = `
${FORMS_GLSL}
// 7 texels a box: (min, material), (max, emitter), (edge flags of faces 0-2, of faces 3-5, glow, form), (shell min, swap), (shell max, -),
// (what is certainly solid in it: min, 1 when it has one), (its max, -)
uniform highp sampler2D uBoxes;
uniform highp sampler2D uNodes;   // 2 texels a node: (lo, left|first), (hi, count), over the boxes' shells
uniform vec3 uEmitMin[5];
uniform vec3 uEmitMax[5];
ivec2 at1(int i) { return ivec2(i % ${TW}, i / ${TW}); }
const int BT = 7;
vec4 boxT(int slot, int k) { return texelFetch(uBoxes, at1(slot * BT + k), 0); }

// every form's truth sampled once on a fine grid in its frame (PathTracer.buildVolumes), packed into one 3D texture (each form's
// grid with its axes in the order that packs best). Rays read this, one filtered read a step; a camera's own hits are refined on the
// exact field.
uniform highp sampler3D uVol;
uniform vec3 uVolSize;
uniform vec4 uVolO[${FORMS.length}];      // per form: where its grid starts in the texture, 1 when its axis 0 repeats
uniform vec4 uVolN[${FORMS.length}];      // its grid points along the frame's three axes
uniform vec4 uVolP[${FORMS.length}];      // which texture axis each of the frame's axes is stored along
uniform vec4 uVolLo[${FORMS.length}];     // the grid's first point in the frame
uniform vec4 uVolStep[${FORMS.length}];   // the grid's spacing
float volTruth(int f, vec3 c) {
  vec4 O = uVolO[f], N = uVolN[f], P = uVolP[f];
  vec3 g = (c - uVolLo[f].xyz) / uVolStep[f].xyz;
  g.x = O.w > 0.5 ? mod(g.x, N.x) : clamp(g.x, 0.0, N.x - 1.0);
  g.y = clamp(g.y, 0.0, N.y - 1.0); g.z = clamp(g.z, 0.0, N.z - 1.0);
  vec3 s;
  s[int(P.x)] = g.x; s[int(P.y)] = g.y; s[int(P.z)] = g.z;
  return texture(uVol, (O.xyz + s + 0.5) / uVolSize).r;
}
// a shaped box, read once: its centre, half sizes and form, in its own axes
struct SBox { vec3 cen; vec3 h; bool swap; int f; };
SBox sbox(int slot) {
  vec4 p = boxT(slot, 0), q = boxT(slot, 1), r = boxT(slot, 2), s = boxT(slot, 3);
  vec3 h = (q.xyz - p.xyz) * 0.5;
  return SBox((p.xyz + q.xyz) * 0.5, s.w > 0.5 ? h.zyx : h, s.w > 0.5, int(r.w + 0.5));
}
// its distance at P, from the sampled truth (fast) or the exact one (forms.js), through its form's frame (world.js formCanon)
float sForm(SBox b, vec3 P) { vec3 x = P - b.cen; if (b.swap) x = x.zyx; float k; vec3 c = formCanon(b.f, x, b.h, k); return volTruth(b.f, c) * k; }
float sFormExact(SBox b, vec3 P) { vec3 x = P - b.cen; if (b.swap) x = x.zyx; float k; vec3 c = formCanon(b.f, x, b.h, k); return formTruth(b.f, c) * k; }
float boxForm(int slot, vec3 P) { return sForm(sbox(slot), P); }
float boxFormExact(int slot, vec3 P) { return sFormExact(sbox(slot), P); }
vec3 sNormal(SBox b, vec3 P) {
  const vec2 e = vec2(1.0, -1.0) * 4e-3;
  return normalize(e.xyy * sForm(b, P + e.xyy) + e.yyx * sForm(b, P + e.yyx) + e.yxy * sForm(b, P + e.yxy) + e.xxx * sForm(b, P + e.xxx));
}
vec3 sNormalExact(SBox b, vec3 P) {
  const vec2 e = vec2(1.0, -1.0) * 4e-4;
  return normalize(e.xyy * sFormExact(b, P + e.xyy) + e.yyx * sFormExact(b, P + e.yyx) + e.yxy * sFormExact(b, P + e.yxy) + e.xxx * sFormExact(b, P + e.xxx));
}
vec3 boxFormNormal(int slot, vec3 P) { return sNormal(sbox(slot), P); }
vec3 boxFormNormalExact(int slot, vec3 P) { return sNormalExact(sbox(slot), P); }
// how tucked in a point of a shaped surface is, read off its own form at three heights over it (the surface painter's cue; the game
// reads the same off its shape painter)
float boxFormAO(int slot, vec3 P, vec3 N) {
  SBox b = sbox(slot);
  float a = 0.5 * (0.03 - sForm(b, P + N * 0.03)) / 0.03 + 0.3 * (0.09 - sForm(b, P + N * 0.09)) / 0.09 + 0.2 * (0.25 - sForm(b, P + N * 0.25)) / 0.25;
  return clamp(a, 0.0, 1.0);
}
// a ray through a shaped box's shell from t0 to t1: where it meets the form (where the form is solid at the shell's own face, that face)
bool marchBox(int slot, vec3 ro, vec3 rd, float t0, float t1, vec3 entryN, out float tH, out vec3 nH) {
  SBox b = sbox(slot);
  float t = max(t0, 0.0);
  float d = sForm(b, ro + rd * t);
  if (d < 0.0) { if (t0 < 1e-4) return false; tH = t0; nH = entryN; return true; }
  for (int i = 0; i < 160; i++) {
    if (d < 2e-3 + 5e-4 * t) { tH = t; nH = sNormal(b, ro + rd * t); return true; }   // (the sampled truth is good to a millimetre or two)
    t += max(d * 0.85, 2e-4);
    if (t > t1) return false;
    d = sForm(b, ro + rd * t);
  }
  return false;
}

uint rngState;
float rnd() { rngState = rngState * 747796405u + 2891336453u; uint w = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u; w = (w >> 22u) ^ w; return float(w) * (1.0 / 4294967296.0); }
void seedRng(uint a, uint b) { rngState = a * 1973u + b * 9277u + 26699u; rnd(); rngState ^= b * 7919u; rnd(); }

vec3 cosineDir(vec3 n) {
  float u = rnd(), v = rnd(), r = sqrt(u), ph = 6.2831853 * v;
  vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0)));
  vec3 b = cross(n, t);
  return normalize(t * (r * cos(ph)) + b * (r * sin(ph)) + n * sqrt(max(0.0, 1.0 - u)));
}

vec2 slab(vec3 ro, vec3 inv, vec3 lo, vec3 hi) {
  vec3 a = (lo - ro) * inv, b = (hi - ro) * inv;
  vec3 mn = min(a, b), mx = max(a, b);
  return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}
vec3 safeInv(vec3 d) { return 1.0 / (sign(d) * max(abs(d), vec3(1e-9)) + vec3(d.x == 0.0 ? 1e-9 : 0.0, d.y == 0.0 ? 1e-9 : 0.0, d.z == 0.0 ? 1e-9 : 0.0)); }

// closest hit: returns the box, the distance and the normal
bool trace(vec3 ro, vec3 rd, out float tHit, out int hitBox, out vec3 nHit) {
  vec3 inv = safeInv(rd);
  int stack[40]; int sp = 0; stack[sp++] = 0;
  tHit = 1e9; hitBox = -1; nHit = vec3(0);
  while (sp > 0) {
    int ni = stack[--sp];
    vec4 a = texelFetch(uNodes, at1(ni * 2), 0), b = texelFetch(uNodes, at1(ni * 2 + 1), 0);
    vec2 h = slab(ro, inv, a.xyz, b.xyz);
    if (h.x > h.y || h.y < 0.0 || h.x > tHit) continue;
    int cnt = int(b.w + 0.5);
    if (cnt > 0) {
      int first = int(a.w + 0.5);
      for (int i = 0; i < 2; i++) {
        if (i >= cnt) break;
        int slot = first + i;
        bool shaped = boxT(slot, 2).w > 0.5;
        vec4 p = boxT(slot, shaped ? 3 : 0), q = boxT(slot, shaped ? 4 : 1);
        vec3 ta = (p.xyz - ro) * inv, tb = (q.xyz - ro) * inv;
        vec3 mn = min(ta, tb), mx = max(ta, tb);
        float tn = max(max(mn.x, mn.y), mn.z), tf = min(min(mx.x, mx.y), mx.z);
        if (tn > tf || tf <= 1e-4 || tn >= tHit) continue;
        vec3 en = tn == mn.x ? vec3(-sign(rd.x), 0, 0) : (tn == mn.y ? vec3(0, -sign(rd.y), 0) : vec3(0, 0, -sign(rd.z)));
        if (!shaped) { if (tn > 1e-4) { tHit = tn; hitBox = slot; nHit = en; } continue; }
        float th; vec3 nh;
        if (marchBox(slot, ro, rd, tn, min(tf, tHit), en, th, nh) && th > 1e-4 && th < tHit) { tHit = th; hitBox = slot; nHit = nh; }
      }
    } else if (sp < 38) {
      // the nearer child first, so a near hit prunes the far shells before they are marched
      int l = int(a.w + 0.5);
      float tl = slab(ro, inv, texelFetch(uNodes, at1(l * 2), 0).xyz, texelFetch(uNodes, at1(l * 2 + 1), 0).xyz).x;
      float tr = slab(ro, inv, texelFetch(uNodes, at1(l * 2 + 2), 0).xyz, texelFetch(uNodes, at1(l * 2 + 3), 0).xyz).x;
      if (tl < tr) { stack[sp++] = l + 1; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = l + 1; }
    }
  }
  return hitBox >= 0;
}

// any hit closer than tMax
bool occluded(vec3 ro, vec3 rd, float tMax) {
  vec3 inv = safeInv(rd);
  int stack[40]; int sp = 0; stack[sp++] = 0;
  while (sp > 0) {
    int ni = stack[--sp];
    vec4 a = texelFetch(uNodes, at1(ni * 2), 0), b = texelFetch(uNodes, at1(ni * 2 + 1), 0);
    vec2 h = slab(ro, inv, a.xyz, b.xyz);
    if (h.x > h.y || h.y < 0.0 || h.x > tMax) continue;
    int cnt = int(b.w + 0.5);
    if (cnt > 0) {
      int first = int(a.w + 0.5);
      for (int i = 0; i < 2; i++) {
        if (i >= cnt) break;
        int slot = first + i;
        bool shaped = boxT(slot, 2).w > 0.5;
        vec4 p = boxT(slot, shaped ? 3 : 0), q = boxT(slot, shaped ? 4 : 1);
        vec2 hh = slab(ro, inv, p.xyz, q.xyz);
        if (hh.x > hh.y || hh.y <= 0.0 || hh.x >= tMax) continue;
        if (!shaped) { if (hh.x > 1e-4) return true; continue; }
        vec4 ia = boxT(slot, 5);
        if (ia.w > 0.5) { vec2 hi = slab(ro, inv, ia.xyz, boxT(slot, 6).xyz); if (hi.x <= hi.y && hi.x > 1e-4 && hi.x < tMax) return true; }
        float th; vec3 nh;
        if (marchBox(slot, ro, rd, hh.x, min(hh.y, tMax), vec3(0), th, nh) && th > 1e-4 && th < tMax) return true;
      }
    } else if (sp < 38) {
      int l = int(a.w + 0.5);
      stack[sp++] = l; stack[sp++] = l + 1;
    }
  }
  return false;
}

// is P inside anything, or within pad of it
bool insideAny(vec3 P, float pad) {
  int stack[40]; int sp = 0; stack[sp++] = 0;
  while (sp > 0) {
    int ni = stack[--sp];
    vec4 a = texelFetch(uNodes, at1(ni * 2), 0), b = texelFetch(uNodes, at1(ni * 2 + 1), 0);
    if (any(lessThan(P, a.xyz - pad)) || any(greaterThan(P, b.xyz + pad))) continue;
    int cnt = int(b.w + 0.5);
    if (cnt > 0) {
      int first = int(a.w + 0.5);
      for (int i = 0; i < 2; i++) {
        if (i >= cnt) break;
        int slot = first + i;
        if (boxT(slot, 2).w > 0.5) {
          vec4 s = boxT(slot, 3), u = boxT(slot, 4);
          if (all(greaterThan(P, s.xyz)) && all(lessThan(P, u.xyz)) && boxForm(slot, P) < pad) return true;
        } else {
          vec4 p = boxT(slot, 0), q = boxT(slot, 1);
          if (all(greaterThan(P, p.xyz - pad)) && all(lessThan(P, q.xyz + pad))) return true;
        }
      }
    } else if (sp < 38) {
      int l = int(a.w + 0.5);
      stack[sp++] = l; stack[sp++] = l + 1;
    }
  }
  return false;
}

vec3 jitteredSun(float t) {
  vec3 s = sunDir(t);
  vec3 u = normalize(cross(s, vec3(0, 1, 0))), v = cross(u, s);
  float r = 0.021 * sqrt(rnd()), ph = 6.2831853 * rnd();
  return normalize(s + u * (r * cos(ph)) + v * (r * sin(ph)));
}
vec3 sunAt(vec3 q, vec3 n, float t) {
  vec3 e = sunIrr(t);
  if (e.r + e.g + e.b < 1e-5) return vec3(0);
  vec3 sd = jitteredSun(t);
  float c = dot(n, sd);
  if (c <= 0.0 || occluded(q + n * 2e-3, sd, 1e4)) return vec3(0);
  return e * c;
}
// irradiance at q from beacon k at unit radiance, by sampling a point on its crystal (four sides and the top); n shades, g is the
// plane the point sits on (light from under it is blocked)
float beaconAt2(vec3 q, vec3 n, vec3 g, int k) {
  vec3 lo = uEmitMin[k], hi = uEmitMax[k], s = hi - lo;
  float aSide = s.x * s.y, aSide2 = s.z * s.y, aTop = s.x * s.z;
  float total = 2.0 * aSide + 2.0 * aSide2 + aTop;
  float pick = rnd() * total, u = rnd(), v = rnd();
  vec3 y, ny;
  if (pick < aSide) { y = vec3(lo.x + u * s.x, lo.y + v * s.y, lo.z); ny = vec3(0, 0, -1); }
  else if (pick < 2.0 * aSide) { y = vec3(lo.x + u * s.x, lo.y + v * s.y, hi.z); ny = vec3(0, 0, 1); }
  else if (pick < 2.0 * aSide + aSide2) { y = vec3(lo.x, lo.y + v * s.y, lo.z + u * s.z); ny = vec3(-1, 0, 0); }
  else if (pick < 2.0 * aSide + 2.0 * aSide2) { y = vec3(hi.x, lo.y + v * s.y, lo.z + u * s.z); ny = vec3(1, 0, 0); }
  else { y = vec3(lo.x + u * s.x, hi.y, lo.z + v * s.z); ny = vec3(0, 1, 0); }
  vec3 w = y - q;
  float d2 = max(dot(w, w), 0.04), d = sqrt(d2);
  vec3 dir = w / d;
  float cq = dot(n, dir), cy = dot(ny, -dir);
  if (cq <= 0.0 || cy <= 0.0 || dot(g, dir) <= 0.0) return 0.0;
  if (occluded(q + g * 2e-3, dir, d - 4e-3)) return 0.0;
  return cq * cy * total / d2;
}
float beaconAt(vec3 q, vec3 n, int k) { return beaconAt2(q, n, n, k); }

// a box's face: its data and its four edge flags
vec4 faceFlags(vec4 r, vec3 n) {
  int a = abs(n.x) > 0.5 ? 0 : (abs(n.y) > 0.5 ? 1 : 2);
  int face = a * 2 + ((n.x + n.y + n.z) > 0.0 ? 1 : 0);
  uint pk = uint(face < 3 ? r.x : r.y), by = (pk >> (8u * uint(face % 3))) & 255u;
  return vec4(float(by & 3u), float((by >> 2u) & 3u), float((by >> 4u) & 3u), float((by >> 6u) & 3u));
}
vec3 bounceAlbedo(int bi, vec3 h, vec3 nh) {
  vec4 p = boxT(bi, 0), q = boxT(bi, 1), r = boxT(bi, 2);
  return truthAlbedo(int(p.w + 0.5), h, nh, p.xyz, q.xyz, faceFlags(r, nh));
}

// the light arriving at a point whose surface faces nB (the bent normal) on a face whose plane faces N, at time t: the sky (with the
// sun's bounces, never its direct beam) and each beacon at unit radiance. Light from under the face's plane is blocked by the face.
void gatherB(vec3 P, vec3 N, vec3 nB, float t, out vec3 sky, out vec3 bk[5]) {
  sky = vec3(0);
  for (int k = 0; k < 5; k++) bk[k] = vec3(beaconAt2(P, nB, N, k));
  vec3 ro = P + N * 5e-3, rd = cosineDir(nB), T = vec3(1);
  if (dot(rd, N) <= 0.0) return;
  for (int bounce = 0; bounce < 4; bounce++) {
    float th; int bi; vec3 nh;
    if (!trace(ro, rd, th, bi, nh)) { sky += T * PI * skyRadiance(rd, t); break; }
    vec4 q = boxT(bi, 1);
    if (q.w > -0.5) break;                         // a crystal: its light is counted by sampling it, never by hitting it
    vec3 h = ro + rd * th;
    T *= bounceAlbedo(bi, h, nh);
    sky += T * sunAt(h, nh, t);
    int k = min(int(rnd() * 5.0), 4);
    bk[k] += T * (5.0 * beaconAt(h, nh, k));
    ro = h + nh * 2e-3; rd = cosineDir(nh);
  }
}
void gather(vec3 P, vec3 N, float t, out vec3 sky, out vec3 bk[5]) { gatherB(P, N, N, t, sky, bk); }
`;

const VS = `#version 300 es
in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_SAMPLES = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
${GLSL_COMMON}
${TRUTH_GLSL}
${GLSL_TRACE}
uniform highp sampler2D uP;     // (position, t)
uniform highp sampler2D uN;     // (normal, -)
uniform highp sampler2D uAcc[5];
uniform int uSpp; uniform uint uSeed;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2; layout(location = 3) out vec4 o3; layout(location = 4) out vec4 o4;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 pt = texelFetch(uP, px, 0); vec3 N = normalize(texelFetch(uN, px, 0).xyz);
  seedRng(uint(px.x + px.y * 4096), uSeed);
  vec3 sky = vec3(0), b[5]; for (int k = 0; k < 5; k++) b[k] = vec3(0);
  for (int s = 0; s < 64; s++) {
    if (s >= uSpp) break;
    vec3 sk, bk[5];
    gather(pt.xyz, N, pt.w, sk, bk);
    sky += sk; for (int k = 0; k < 5; k++) b[k] += bk[k];
  }
  float v[20];
  v[0] = sky.r; v[1] = sky.g; v[2] = sky.b;
  for (int k = 0; k < 5; k++) { v[3 + 3 * k] = b[k].r; v[4 + 3 * k] = b[k].g; v[5 + 3 * k] = b[k].b; }
  v[18] = 0.0; v[19] = 0.0;
  o0 = texelFetch(uAcc[0], px, 0) + vec4(v[0], v[1], v[2], v[3]);
  o1 = texelFetch(uAcc[1], px, 0) + vec4(v[4], v[5], v[6], v[7]);
  o2 = texelFetch(uAcc[2], px, 0) + vec4(v[8], v[9], v[10], v[11]);
  o3 = texelFetch(uAcc[3], px, 0) + vec4(v[12], v[13], v[14], v[15]);
  o4 = texelFetch(uAcc[4], px, 0) + vec4(v[16], v[17], v[18], v[19]);
}`;

// what a point of the detailed world sends to the eye, for the surface painter: the point's own albedo, bent normal and cavity, the light
// gathered around the bent normal (sky with the sun's bounces, each beacon at unit radiance), the sun's direct part and the glow
const FS_SURF = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
${GLSL_COMMON}
${TRUTH_GLSL}
${GLSL_TRACE}
uniform highp sampler2D uP;     // (position, t)
uniform highp sampler2D uN;     // (face normal, box slot)
uniform highp sampler2D uAcc[6];
uniform int uSpp; uniform uint uSeed;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2; layout(location = 3) out vec4 o3; layout(location = 4) out vec4 o4; layout(location = 5) out vec4 o5;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 pt = texelFetch(uP, px, 0), nb = texelFetch(uN, px, 0);
  vec3 P = pt.xyz, N = normalize(nb.xyz);
  int bi = int(nb.w + 0.5);
  vec4 p = boxT(bi, 0), q = boxT(bi, 1), r = boxT(bi, 2);
  int m = int(p.w + 0.5);
  float ao = r.w > 0.5 ? boxFormAO(bi, P, N) : 0.0;
  vec3 alb, nB; float cav, emit;
  truthSurface(m, P, N, p.xyz, q.xyz, faceFlags(r, N), alb, nB, cav, emit);
  seedRng(uint(px.x + px.y * 4096), uSeed);
  vec3 sky = vec3(0), b[5], sun = vec3(0); float vis = 0.0;
  for (int k = 0; k < 5; k++) b[k] = vec3(0);
  for (int s = 0; s < 64; s++) {
    if (s >= uSpp) break;
    vec3 sk, bk[5];
    gatherB(P, N, nB, pt.w, sk, bk);
    sky += sk; for (int k = 0; k < 5; k++) b[k] += bk[k];
    vec3 sd = jitteredSun(pt.w);
    float v = (dot(N, sd) > 0.0 && !occluded(P + N * 2e-3, sd, 1e4)) ? 1.0 : 0.0;
    vis += v; sun += sunIrr(pt.w) * max(dot(nB, sd), 0.0) * v;
  }
  vec3 a = alb / PI;
  float g = m == 8 ? emit : emit * ${RUNE_GLOW.toFixed(3)};
  float n = float(uSpp);   // (the accumulators hold sums; emit and the albedo are the same every pass, so they are added n times too)
  sky *= a * cav; sun *= a * mix(1.0, cav, 0.5); for (int k = 0; k < 5; k++) b[k] *= a * cav;
  o0 = texelFetch(uAcc[0], px, 0) + vec4(sky, sun.r);
  o1 = texelFetch(uAcc[1], px, 0) + vec4(sun.g, sun.b, vis, g * n);
  o2 = texelFetch(uAcc[2], px, 0) + vec4(b[0], b[1].r);
  o3 = texelFetch(uAcc[3], px, 0) + vec4(b[1].g, b[1].b, b[2].r, b[2].g);
  o4 = texelFetch(uAcc[4], px, 0) + vec4(b[2].b, b[3]);
  o5 = texelFetch(uAcc[5], px, 0) + vec4(b[4], ao * n);
}`;

// the detailed sky in chosen directions at chosen times, for the sky painter
const FS_SKYS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
${GLSL_COMMON}
${TRUTH_GLSL}
uniform highp sampler2D uD;     // (direction, t)
layout(location = 0) out vec4 o0;
void main() {
  vec4 d = texelFetch(uD, ivec2(gl_FragCoord.xy), 0);
  o0 = vec4(truthSky(normalize(d.xyz), d.w), starMask(normalize(d.xyz)));
}`;

const FS_CAMERA = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
${GLSL_COMMON}
${TRUTH_GLSL}
${GLSL_TRACE}
uniform highp sampler2D uAccC;
uniform mat4 uInvViewProj; uniform vec3 uEye; uniform vec2 uRes; uniform float uT; uniform int uSpp; uniform uint uSeed;
const int uRefine = 0;
uniform vec3 uBeaconLight[5];      // colour x power x lit: the light each beacon throws
uniform vec3 uGlow[5];             // colour x how brightly it glows: how each crystal looks
layout(location = 0) out vec4 o0;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  seedRng(uint(px.x + px.y * 4096), uSeed);
  vec3 sum = vec3(0);
  for (int s = 0; s < 64; s++) {
    if (s >= uSpp) break;
    vec2 ndc = ((gl_FragCoord.xy + vec2(rnd(), rnd()) - 0.5) / uRes) * 2.0 - 1.0;
    vec4 far = uInvViewProj * vec4(ndc, 1.0, 1.0);
    vec3 rd = normalize(far.xyz / far.w - uEye);
    float th; int bi; vec3 nh;
    vec3 L;
    if (!trace(uEye, rd, th, bi, nh)) {
      L = truthSky(rd, uT);
    } else {
      vec4 p = boxT(bi, 0), q = boxT(bi, 1), r = boxT(bi, 2);
      vec3 P = uEye + rd * th;
      if (uRefine > 0 && r.w > 0.5 && abs(boxFormExact(bi, P)) < 0.02) {
        for (int i = 0; i < 4; i++) P += rd * boxFormExact(bi, P);
        nh = boxFormNormalExact(bi, P);
      }
      int m = int(p.w + 0.5), gk = int(r.z + 0.5) - 1;   // (a shaped box's faces carry no edge flags: its form has its own edges)
      vec3 alb, nB; float cav, emit;
      truthSurface(m, P, nh, p.xyz, q.xyz, faceFlags(r, nh), alb, nB, cav, emit);
      vec3 sky, bk[5];
      gatherB(P, nh, nB, uT, sky, bk);
      vec3 E = sky;
      for (int k = 0; k < 5; k++) E += uBeaconLight[k] * bk[k];
      vec3 sd = jitteredSun(uT);
      float v = (dot(nh, sd) > 0.0 && !occluded(P + nh * 2e-3, sd, 1e4)) ? 1.0 : 0.0;
      L = alb / PI * (cav * E + mix(1.0, cav, 0.5) * sunIrr(uT) * max(dot(nB, sd), 0.0) * v);
      if (gk >= 0 && gk < 5) L += uGlow[gk] * emit * (m == 8 ? 1.0 : ${RUNE_GLOW.toFixed(3)});
      L = applyFog(L, uEye, P, uT);
    }
    sum += L;
  }
  o0 = texelFetch(uAccC, px, 0) + vec4(sum, float(uSpp));
}`;

// a form's truth at points of its frame, for the shape painter
const FS_SHAPE = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
${GLSL_COMMON}
${FORMS_GLSL}
uniform highp sampler2D uC;     // (the point in the form's frame, the form)
layout(location = 0) out vec4 o0;
void main() { vec4 c = texelFetch(uC, ivec2(gl_FragCoord.xy), 0); o0 = vec4(formTruth(int(c.w + 0.5), c.xyz), 0.0, 0.0, 0.0); }`;

// where the painters' teaching points really are: a point in a shaped box's shell is moved onto its form (and kept only where nothing
// else covers it), a point on a box's face is kept unless something stands on it, a point in the air unless it is in (or within 6 cm
// of) something
const FS_PLACE = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
${GLSL_COMMON}
${TRUTH_GLSL}
${GLSL_TRACE}
uniform highp sampler2D uP;     // (candidate, t)
uniform highp sampler2D uN;     // (normal, what it is: the shaped box's slot + 1, 0 a box's face, -1 a point in the air)
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 pt = texelFetch(uP, px, 0), nb = texelFetch(uN, px, 0);
  vec3 P = pt.xyz, N = nb.xyz;
  int mode = int(floor(nb.w + 0.5));
  float ok;
  if (mode > 0) {
    int slot = mode - 1;
    for (int i = 0; i < 16; i++) { float d = boxFormExact(slot, P); P -= boxFormNormalExact(slot, P) * d; }
    N = boxFormNormalExact(slot, P);
    vec4 s = boxT(slot, 3), u = boxT(slot, 4);
    // (on the shell's own face counts: a form whose surface is its box's faces, a chamfered block, has it there)
    bool inShell = all(greaterThan(P, s.xyz - 2e-3)) && all(lessThan(P, u.xyz + 2e-3));
    ok = (abs(boxFormExact(slot, P)) < 1e-3 && inShell && !insideAny(P + N * 8e-3, 0.0)) ? 1.0 : 0.0;
  } else if (mode == 0) ok = insideAny(P + N * 0.01, 0.0) ? 0.0 : 1.0;
  else ok = insideAny(P, 0.06) ? 0.0 : 1.0;
  o0 = vec4(P, ok); o1 = vec4(N, 0.0);
}`;

const FS_SHOW = `#version 300 es
precision highp float; precision highp sampler2D;
${GLSL_COMMON}
uniform highp sampler2D uAccC; uniform float uT;
out vec4 o;
uniform vec2 uRes;
void main() {
  vec4 a = texelFetch(uAccC, ivec2(gl_FragCoord.xy), 0);
  vec3 c = tonemap(a.rgb / max(a.a, 1.0) * exposureAt(uT));
  // the game's own grade (render.js FS_COMPOSE), so a side by side compares the light and nothing else
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.14); c = (c - 0.5) * 1.07 + 0.5;
  vec2 q = gl_FragCoord.xy / uRes - 0.5; c *= 1.0 - dot(q, q) * 0.35;
  o = vec4(c, 1.0);
}`;

function compile(gl, fsSrc) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n').slice(0, 4000));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// a box's third texel: its six faces' edge flags (8 bits a face, three faces to a float) and the beacon that makes it glow (+1). A
// shaped box's faces carry none: its form has its own edges.
export function boxFlagWords(b) {
  const w = [0, 0];
  if (b.form) return w;
  for (let face = 0; face < 6; face++) {
    const fl = edgeFlags(b, face >> 1, face & 1);
    const byte = fl[0] | (fl[1] << 2) | (fl[2] << 4) | (fl[3] << 6);
    w[face < 3 ? 0 : 1] += byte * 2 ** (8 * (face % 3));
  }
  return w;
}

export class PathTracer {
  constructor(gl) {
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float missing');
    const shells = BOXES.map(shellOf);
    const { nodes, order } = buildBVH(shells);
    this.order = order;
    this.slotOf = new Int32Array(BOXES.length); order.forEach((bi, slot) => (this.slotOf[bi] = slot));
    const boxData = new Float32Array(TW * Math.ceil((order.length * 7) / TW) * 4);
    order.forEach((bi, i) => {
      const b = BOXES[bi], fw = boxFlagWords(b), sh = shells[bi], inn = innerOf(b), o = i * 28;
      boxData.set([...b.min, b.m], o);
      boxData.set([...b.max, b.e], o + 4);
      boxData.set([fw[0], fw[1], b.glow + 1, b.form], o + 8);
      boxData.set([...sh.min, sh.swap], o + 12);
      boxData.set([...sh.max, 0], o + 16);
      boxData.set(inn ? [...inn.min, 1] : [0, 0, 0, 0], o + 20);
      boxData.set(inn ? [...inn.max, 0] : [0, 0, 0, 0], o + 24);
    });
    const nodeData = new Float32Array(TW * Math.ceil((nodes.length * 2) / TW) * 4);
    nodes.forEach((n, i) => {
      nodeData.set([...n.lo, n.count > 0 ? n.first : n.left], i * 8);
      nodeData.set([...n.hi, n.count], i * 8 + 4);
    });
    this.nNodes = nodes.length;
    this.boxTex = floatTex(gl, TW, boxData.length / 4 / TW, boxData);
    this.nodeTex = floatTex(gl, TW, nodeData.length / 4 / TW, nodeData);
    this.emitMin = [], this.emitMax = [];
    BEACONS.forEach((_, k) => { const b = BOXES.find((x) => x.e === k); this.emitMin.push(...b.min); this.emitMax.push(...b.max); });
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.progs = {};
  }
  prog(name) {
    const src = { samples: FS_SAMPLES, surface: FS_SURF, sky: FS_SKYS, camera: FS_CAMERA, show: FS_SHOW, shape: FS_SHAPE, place: FS_PLACE }[name];
    return (this.progs[name] ||= compile(this.gl, src));
  }
  // every form a box of the world has, its truth sampled on a grid in its frame (spacing half the shape painter's cell, 1-5 cm),
  // packed into one 3D texture: each grid stored with its longest axis first, laid out in layers of shelves. Rays read this; points
  // placed on a form, and a camera's own hits, use the exact field.
  async buildVolumes() {
    const gl = this.gl, used = [...new Set(BOXES.map((b) => b.form).filter((f) => f > 0))];
    const vols = used.map((f) => {
      const dom = formDomain(f), vox = Math.min(0.05, Math.max(0.01, FORMS[f].cell * 0.5));
      const n = dom.map((a) => (a.wrap ? Math.max(2, Math.round((a.hi - a.lo) / vox)) : Math.max(2, Math.round((a.hi - a.lo) / vox) + 1)));
      const step = dom.map((a, i) => (a.wrap ? (a.hi - a.lo) / n[i] : (a.hi - a.lo) / (n[i] - 1)));
      const wrap = dom[0].wrap ? 1 : 0, stored = [n[0] + wrap, n[1], n[2]];   // (a repeating axis keeps its first point again at the end)
      const order = [0, 1, 2].sort((a, b) => stored[b] - stored[a]);            // texture axis k holds frame axis order[k]
      const at = [0, 0, 0]; order.forEach((ax, k) => (at[ax] = k));
      return { f, dom, n, step, wrap, stored, order, at, dims: order.map((ax) => stored[ax]) };
    });
    // layers (deepest first) of shelves, 512 texels wide
    const W = 512, layers = [];
    for (const v of [...vols].sort((a, b) => b.dims[2] - a.dims[2])) {
      let placed = false;
      for (const L of layers) {
        if (v.dims[2] > L.depth) continue;
        if (L.x + v.dims[0] <= W) { v.o = [L.x, L.y, L.z]; L.x += v.dims[0]; L.shelf = Math.max(L.shelf, v.dims[1]); placed = true; break; }
        if (L.y + L.shelf + v.dims[1] <= 256 && v.dims[0] <= W) { L.y += L.shelf; L.x = v.dims[0]; L.shelf = v.dims[1]; v.o = [0, L.y, L.z]; placed = true; break; }
      }
      if (!placed) { const z = layers.reduce((s2, L) => s2 + L.depth, 0); layers.push({ z, depth: v.dims[2], x: v.dims[0], y: 0, shelf: v.dims[1] }); v.o = [0, 0, z]; }
    }
    const AW = W, AH = Math.max(...vols.map((v) => v.o[1] + v.dims[1])), AD = layers.reduce((s2, L) => s2 + L.depth, 0);
    const img = new Float32Array(AW * AH * AD);
    for (const v of vols) {
      const [nx, ny, nz] = v.n, total = nx * ny * nz, BW = 1024, BH = Math.ceil(total / BW), c4 = new Float32Array(BW * BH * 4);
      let i = 0;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let q = 0; q < nx; q++, i++) c4.set([v.dom[0].lo + q * v.step[0], v.dom[1].lo + j * v.step[1], v.dom[2].lo + k * v.step[2], v.f], i * 4);
      const d = await this.shapeTruth(c4, BW, BH);
      for (let q = 0; q < total; q++) if (!Number.isFinite(d[q])) throw new Error(`form ${FORMS[v.f].name}: its truth is not a number at ${Array.from(c4.subarray(q * 4, q * 4 + 3)).map((x) => x.toFixed(3))}`);
      const put = (q, j, k, val) => { const g = [q, j, k], s3 = [g[v.order[0]], g[v.order[1]], g[v.order[2]]]; img[((v.o[2] + s3[2]) * AH + v.o[1] + s3[1]) * AW + v.o[0] + s3[0]] = val; };
      i = 0;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        for (let q = 0; q < nx; q++, i++) put(q, j, k, d[i]);
        if (v.wrap) put(nx, j, k, d[i - nx]);
      }
    }
    this.volTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.volTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, AW, AH, AD, 0, gl.RED, gl.FLOAT, img);
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, val);
    const NF = FORMS.length, O = new Float32Array(NF * 4), N = new Float32Array(NF * 4), P = new Float32Array(NF * 4), Lo = new Float32Array(NF * 4), St = new Float32Array(NF * 4);
    for (const v of vols) { O.set([...v.o, v.wrap], v.f * 4); N.set(v.n, v.f * 4); P.set(v.at, v.f * 4); Lo.set(v.dom.map((a) => a.lo), v.f * 4); St.set(v.step, v.f * 4); }
    this.vol = { AW, AH, AD, O, N, P, Lo, St, voxels: vols.reduce((s2, v) => s2 + v.n[0] * v.n[1] * v.n[2], 0) };
    return { size: [AW, AH, AD], voxels: this.vol.voxels };
  }
  bindScene(p) {
    const gl = this.gl;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.boxTex); gl.uniform1i(gl.getUniformLocation(p, 'uBoxes'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.nodeTex); gl.uniform1i(gl.getUniformLocation(p, 'uNodes'), 1);
    if (this.vol) {
      gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_3D, this.volTex); gl.uniform1i(gl.getUniformLocation(p, 'uVol'), 15);
      gl.uniform3f(gl.getUniformLocation(p, 'uVolSize'), this.vol.AW, this.vol.AH, this.vol.AD);
      for (const [u, a] of [['uVolO', this.vol.O], ['uVolN', this.vol.N], ['uVolP', this.vol.P], ['uVolLo', this.vol.Lo], ['uVolStep', this.vol.St]]) gl.uniform4fv(gl.getUniformLocation(p, u), a);
    }
    gl.uniform3fv(gl.getUniformLocation(p, 'uEmitMin'), this.emitMin);
    gl.uniform3fv(gl.getUniformLocation(p, 'uEmitMax'), this.emitMax);
  }
  // runs an accumulating pass of nOut RGBA targets over w x h points, spp paths each; returns the mean per point (nOut*4 floats)
  async accumulate(name, inputs, w, h, nOut, spp, perDraw, onProgress) {
    const gl = this.gl;
    const mkSet = () => {
      const texs = [...Array(nOut)].map(() => floatTex(gl, w, h, null));
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { texs, fb };
    };
    let A = mkSet(), Bset = mkSet();
    const p = this.prog(name);
    this.bindScene(p);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    const draws = Math.ceil(spp / perDraw);
    for (let d = 0; d < draws; d++) {
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, Bset.fb);
      inputs.forEach(([uname, tex], i) => { gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(gl.getUniformLocation(p, uname), 2 + i); });
      const base = 2 + inputs.length;
      A.texs.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + base + i); gl.bindTexture(gl.TEXTURE_2D, t); });
      gl.uniform1iv(gl.getUniformLocation(p, 'uAcc'), A.texs.map((_, i) => base + i));
      gl.uniform1i(gl.getUniformLocation(p, 'uSpp'), perDraw);
      gl.uniform1ui(gl.getUniformLocation(p, 'uSeed'), 1000 + d * 7);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 5));
      gl.deleteSync(sync);
      [A, Bset] = [Bset, A];
      onProgress((d + 1) / draws);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
    const out = new Float32Array(w * h * nOut * 4), tmp = new Float32Array(w * h * 4), total = draws * perDraw;
    for (let i = 0; i < nOut; i++) {
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, tmp);
      for (let s = 0; s < w * h; s++) for (let c = 0; c < 4; c++) out[s * nOut * 4 + i * 4 + c] = tmp[s * 4 + c] / total;
    }
    for (const set of [A, Bset]) { set.texs.forEach((t) => gl.deleteTexture(t)); gl.deleteFramebuffer(set.fb); }
    return out;
  }
  // pos4: Float32Array (x,y,z,t) per sample; nrm4: (nx,ny,nz,0). n must be w*h. Returns Float32Array of 18 values a sample (mean over spp).
  async samples(pos4, nrm4, w, h, spp, perDraw = 4, onProgress = () => {}) {
    const gl = this.gl;
    const tP = floatTex(gl, w, h, pos4), tN = floatTex(gl, w, h, nrm4);
    const raw = await this.accumulate('samples', [['uP', tP], ['uN', tN]], w, h, 5, spp, perDraw, onProgress);
    gl.deleteTexture(tP); gl.deleteTexture(tN);
    const out = new Float32Array(w * h * 18);
    for (let s = 0; s < w * h; s++) for (let j = 0; j < 18; j++) out[s * 18 + j] = raw[s * 20 + j];
    return out;
  }
  // pos4: (x,y,z,t); nrm4: (face normal, BOXES index). Returns 24 values a point: sky rgb, sun rgb, vis, glow, then 5 beacons rgb,
  // each already times the point's own albedo / pi (what it sends to the eye); glow is per unit of the crystal's glow
  async surface(pos4, nrm4, w, h, spp, perDraw = 4, onProgress = () => {}) {
    const gl = this.gl;
    const n4 = Float32Array.from(nrm4);
    for (let s = 0; s < w * h; s++) n4[s * 4 + 3] = this.slotOf[nrm4[s * 4 + 3]];
    const tP = floatTex(gl, w, h, pos4), tN = floatTex(gl, w, h, n4);
    const raw = await this.accumulate('surface', [['uP', tP], ['uN', tN]], w, h, 6, spp, perDraw, onProgress);
    gl.deleteTexture(tP); gl.deleteTexture(tN);
    return raw;   // 24 a point: the 23 above and, last, how tucked in a shaped surface is there (0 on a box's face)
  }
  // one pass of a program with outputs read back: n4 inputs, nOut RGBA float targets
  async onePass(name, inputs, w, h, nOut) {
    const gl = this.gl;
    const texs = [...Array(nOut)].map(() => floatTex(gl, w, h, null)), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const p = this.prog(name);
    this.bindScene(p);
    inputs.forEach(([uname, tex], i) => { gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(gl.getUniformLocation(p, uname), 2 + i); });
    gl.viewport(0, 0, w, h); gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 5));
    gl.deleteSync(sync);
    const out = texs.map((_, i) => { const a = new Float32Array(w * h * 4); gl.readBuffer(gl.COLOR_ATTACHMENT0 + i); gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, a); return a; });
    texs.forEach((t) => gl.deleteTexture(t)); gl.deleteFramebuffer(fb);
    return out;
  }
  // candidates (pos4: x, y, z, t; nrm4: normal, mode as makeCandidates writes it) -> where they really are on the detailed world:
  // { pos: (x, y, z, kept 1 | 0), nrm: (normal, -) }
  async place(pos4, nrm4, w, h) {
    const gl = this.gl, n4 = Float32Array.from(nrm4);
    for (let s = 0; s < w * h; s++) { const m = nrm4[s * 4 + 3]; if (m > 0.5) n4[s * 4 + 3] = this.slotOf[Math.round(m) - 1] + 1; }
    const tP = floatTex(gl, w, h, pos4), tN = floatTex(gl, w, h, n4);
    const [pos, nrm] = await this.onePass('place', [['uP', tP], ['uN', tN]], w, h, 2);
    gl.deleteTexture(tP); gl.deleteTexture(tN);
    return { pos, nrm };
  }
  // points of forms' frames (c4: x, y, z, form) -> each form's truth there (one float a point)
  async shapeTruth(c4, w, h) {
    const tC = floatTex(this.gl, w, h, c4);
    const [o] = await this.onePass('shape', [['uC', tC]], w, h, 1);
    this.gl.deleteTexture(tC);
    const d = new Float32Array(w * h); for (let i = 0; i < w * h; i++) d[i] = o[i * 4];
    return d;
  }
  // dirs4: (dx,dy,dz,t). Returns 4 values a direction: the detailed sky's radiance, and whether a star is there (the code's fact)
  async sky(dirs4, w, h) {
    const gl = this.gl;
    const tD = floatTex(gl, w, h, dirs4);
    const tex = floatTex(gl, w, h, null), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const p = this.prog('sky');
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tD); gl.uniform1i(gl.getUniformLocation(p, 'uD'), 2);
    gl.viewport(0, 0, w, h); gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const tmp = new Float32Array(w * h * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, tmp);
    gl.deleteTexture(tD); gl.deleteTexture(tex); gl.deleteFramebuffer(fb);
    return tmp;
  }
  // a path-traced picture; returns the canvas-ready RGBA8 pixels (tone-mapped like the game)
  async camera({ invViewProj, eye, w, h, t, beaconLight, glow, spp, perDraw = 4, onProgress = () => {} }) {
    const gl = this.gl;
    const mk = () => { const tex = floatTex(gl, w, h, null); const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); gl.drawBuffers([gl.COLOR_ATTACHMENT0]); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); return { tex, fb }; };
    let A = mk(), Bs = mk();
    const p = this.prog('camera');
    this.bindScene(p);
    gl.viewport(0, 0, w, h); gl.bindVertexArray(this.vao);
    const draws = Math.ceil(spp / perDraw);
    for (let d = 0; d < draws; d++) {
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, Bs.fb);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, A.tex); gl.uniform1i(gl.getUniformLocation(p, 'uAccC'), 2);
      gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uInvViewProj'), false, invViewProj);
      gl.uniform3fv(gl.getUniformLocation(p, 'uEye'), eye);
      gl.uniform2f(gl.getUniformLocation(p, 'uRes'), w, h);
      gl.uniform1f(gl.getUniformLocation(p, 'uT'), t);
      gl.uniform1i(gl.getUniformLocation(p, 'uSpp'), perDraw);
      gl.uniform1ui(gl.getUniformLocation(p, 'uSeed'), 77 + d * 13);
      gl.uniform3fv(gl.getUniformLocation(p, 'uBeaconLight'), beaconLight);
      gl.uniform3fv(gl.getUniformLocation(p, 'uGlow'), glow);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 5));
      gl.deleteSync(sync);
      [A, Bs] = [Bs, A];
      onProgress((d + 1) / draws);
    }
    // tone-map to the canvas, read it back
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const show = this.prog('show');
    gl.useProgram(show);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(gl.getUniformLocation(show, 'uAccC'), 2);
    gl.uniform1f(gl.getUniformLocation(show, 'uT'), t);
    gl.uniform2f(gl.getUniformLocation(show, 'uRes'), w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (const s of [A, Bs]) { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); }
    return px;
  }
}

// ---- where the painters are asked about. These are CANDIDATES: the GPU places them on the detailed world (PathTracer.place) and
// keeps the ones that are really there. Each one's mode (nrm4.w): -1 a point in the air, 0 a point on a box's face, bi + 1 a point
// in shaped box bi's shell, to be moved onto its form. kind: what the caller keeps with it (the box's index). ----
const BOOST = { banner: 12, basalt: 10, crystal: 16, wood: 3, moss: 3, roof: 1.5, leaf: 1.2, bark: 1.5, plaster: 4 };
function sources({ crystals, boost }) {
  const out = [], inner = (lo, hi) => (Math.abs((lo[0] + hi[0]) / 2) < 14.5 && Math.abs((lo[2] + hi[2]) / 2) < 14.5 ? 3 : 1);
  BOXES.forEach((b, bi) => {
    if (b.e >= 0 && !crystals) return;
    const k = boost ? BOOST[MAT[b.m][0]] || 1 : 1;
    if (b.form) {
      // a shaped box: points anywhere in its shell (clipped to the grid), as many as its shell's surface would take
      const sh = shellOf(b), lo = [...sh.min], hi = [...sh.max];
      for (let a = 0; a < 3; a++) { lo[a] = Math.max(lo[a], GRID.min[a] + 0.3); hi[a] = Math.min(hi[a], GRID.max[a] - 0.3); }
      const e = [0, 1, 2].map((a) => Math.max(0, hi[a] - lo[a]));
      const area = 2 * (e[0] * e[1] + e[1] * e[2]) + (b.min[1] <= 0.001 ? 1 : 2) * e[0] * e[2];
      if (area > 0) out.push({ bi, shell: true, lo, hi, w: area * inner(lo, hi) * k });
      return;
    }
    for (let a = 0; a < 3; a++) for (const side of [0, 1]) {
      if (a === 1 && side === 0 && b.min[1] <= 0.001) continue;   // a face on the ground is never seen
      const lo = [...b.min], hi = [...b.max];
      for (let q = 0; q < 3; q++) { lo[q] = Math.max(lo[q], GRID.min[q] + 0.3); hi[q] = Math.min(hi[q], GRID.max[q] - 0.3); }
      const pos = side ? b.max[a] : b.min[a];
      if (pos < GRID.min[a] + 0.3 || pos > GRID.max[a] - 0.3) continue;
      const u = (a + 1) % 3, v = (a + 2) % 3, area = Math.max(0, hi[u] - lo[u]) * Math.max(0, hi[v] - lo[v]);
      if (area > 0) out.push({ bi, lo, hi, a, side, pos, u, v, w: area * inner(lo, hi) * k });
    }
  });
  return out;
}
function picker(list, r) {
  const cum = []; let tot = 0; for (const f of list) { tot += f.w; cum.push(tot); }
  return () => { const x = r() * tot; let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; } return list[lo]; };
}
function candidates(n, seed, { crystals, boost, air }) {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = picker(sources({ crystals, boost }), r);
  const pos4 = new Float32Array(n * 4), nrm4 = new Float32Array(n * 4), kind = new Int32Array(n);
  const nSurf = Math.round(n * (1 - air));
  for (let i = 0; i < n; i++) {
    const p = [0, 0, 0], nn = [0, 0, 0];
    let mode = -1, bi = -1;
    if (i < nSurf) {
      const f = pick();
      bi = f.bi;
      if (f.shell) { for (let a = 0; a < 3; a++) p[a] = f.lo[a] + r() * (f.hi[a] - f.lo[a]); mode = bi + 1; }
      else { p[f.a] = f.pos; p[f.u] = f.lo[f.u] + r() * (f.hi[f.u] - f.lo[f.u]); p[f.v] = f.lo[f.v] + r() * (f.hi[f.v] - f.lo[f.v]); nn[f.a] = f.side ? 1 : -1; mode = 0; }
    } else {
      const high = r() < 0.3;
      p[0] = (r() * 2 - 1) * 18.5; p[2] = (r() * 2 - 1) * 18.5; p[1] = high ? 0.2 + r() * 8.8 : 0.25 + r() * 2.4;
      const z = r() * 2 - 1, ph = r() * Math.PI * 2, q = Math.sqrt(1 - z * z);
      nn[0] = q * Math.cos(ph); nn[1] = z; nn[2] = q * Math.sin(ph);
    }
    pos4.set([p[0], p[1], p[2], r()], i * 4);
    nrm4.set([nn[0], nn[1], nn[2], mode], i * 4);
    kind[i] = bi;
  }
  return { pos4, nrm4, kind };
}
// the light painter's: on the surfaces (72%, inside the walls three times) and in the air, each at a random time of day
export const makeSampleCandidates = (n, seed = 1) => candidates(n, seed, { crystals: false, boost: false, air: 0.28 });
// the surface painter's: on every surface that can be seen, small things more so each material is learned well
export const makeSurfaceCandidates = (n, seed = 1) => candidates(n, seed, { crystals: true, boost: true, air: 0 });

// ---- where the shape painter is asked about: points all over each form's frame, more near its surface ----
export function makeShapeCandidates(form, n, seed = 1) {
  let s = (seed * 7919 + form * 104729) >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dom = formDomain(form), c4 = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) c4.set([...dom.map((a) => a.lo + r() * (a.hi - a.lo)), form], i * 4);
  return c4;
}

// ---- where the sky painter is asked about: directions over the sky (more near the horizon, where a player looks) and next to the sun ----
export function makeSkySamples(n, seed = 1) {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dirs4 = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = r(), k = r();
    let d;
    if (k < 0.1) {
      // close to the sun: its disk and its halo
      const e = (30 - 50 * t) * Math.PI / 180, h = [0.9, 0, 0.38], hl = Math.hypot(h[0], h[2]);
      const sd = [h[0] / hl * Math.cos(e), Math.sin(e), h[2] / hl * Math.cos(e)];
      const ang = 0.12 * Math.pow(r(), 2), ph = r() * Math.PI * 2;
      const u = [-sd[2], 0, sd[0]].map((x) => x / Math.hypot(sd[0], sd[2])), v = [sd[1] * u[2] - sd[2] * u[1], sd[2] * u[0] - sd[0] * u[2], sd[0] * u[1] - sd[1] * u[0]];
      d = [0, 1, 2].map((j) => sd[j] * Math.cos(ang) + (u[j] * Math.cos(ph) + v[j] * Math.sin(ph)) * Math.sin(ang));
    } else {
      const y = k < 0.16 ? -0.12 * r() : Math.pow(r(), 1.7), ph = r() * Math.PI * 2, q = Math.sqrt(Math.max(0, 1 - y * y));
      d = [q * Math.cos(ph), y, q * Math.sin(ph)];
    }
    const l = Math.hypot(...d);
    dirs4.set([d[0] / l, d[1] / l, d[2] / l, t], i * 4);
  }
  return dirs4;
}
