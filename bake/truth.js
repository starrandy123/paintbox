// The detailed world: what the boxes stand for. It plays the part Unreal Engine 5's scenes play for Matrix-Game 4.0, and only the bake
// has it. The path tracer renders it; the painter learns to paint it from the boxes; the game ships the boxes and the painter.
//
// Every material's pattern repeats exactly on its tile (MAT_UV in world.js), so a tiled feature texture can hold it. The wear on top
// (damp at the foot of a wall, moss where water stands, rain under the tops) is the world's own and changes slowly enough for the
// painter's half-metre grid to hold it.
import { MAT } from '../game/world.js';

export const RUNE_GLOW = 0.35;   // a pedestal's runes glow at this share of its crystal's glow

export const TRUTH_GLSL = `
struct Surf { vec3 alb; float h; float cav; float emit; };   // albedo, height (m), how open to the sky (1) or tucked in (0), glow

// ---- periodic noise ----
float ph(vec2 c, vec2 per, uint seed) { c = mod(c, per); return float(hashu(uvec3(uvec2(c), seed))) * (1.0 / 4294967295.0); }
float pnoise(vec2 p, vec2 per, uint seed) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ph(i, per, seed), ph(i + vec2(1.0, 0.0), per, seed), f.x), mix(ph(i + vec2(0.0, 1.0), per, seed), ph(i + vec2(1.0, 1.0), per, seed), f.x), f.y);
}
// on a tile, f cells a metre (tile * f whole numbers)
float tn(vec2 uv, vec2 tile, float f, uint seed) { return pnoise(uv * f, tile * f, seed); }
float tf(vec2 uv, vec2 tile, float f, int oct, uint seed) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 5; k++) { if (k >= oct) break; s += a * pnoise(uv * f, tile * f, seed + uint(k) * 101u); n += a; a *= 0.5; f *= 2.0; }
  return s / n;
}
// cellular: (nearest, second nearest, the nearest cell's own number)
vec3 tcell(vec2 uv, vec2 tile, float f, uint seed) {
  vec2 p = uv * f, per = tile * f, i = floor(p), fr = fract(p);
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), c = i + g;
    vec2 o = 0.15 + 0.7 * vec2(ph(c, per, seed), ph(c, per, seed + 7u));
    float d = length(g + o - fr);
    if (d < d1) { d2 = d1; d1 = d; id = ph(c, per, seed + 13u); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
float segDist(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }

// courses rh metres high; in each course the blocks are tile.x / k long (k from kMin, kSpan choices), each course shifted its own way
void course(vec2 uv, vec2 tile, float rh, float kMin, float kSpan, uint seed, out vec2 id, out vec2 q, out vec2 sz) {
  float rows = tile.y / rh, row = floor(uv.y / rh), r = mod(row, rows);
  float k = kMin + floor(ph(vec2(r, 0.0), vec2(64.0), seed) * kSpan);
  float bl = tile.x / k, u = uv.x + ph(vec2(r, 0.0), vec2(64.0), seed + 1u) * tile.x, col = floor(u / bl);
  id = vec2(mod(col, k), r); q = vec2(u - col * bl, uv.y - row * rh); sz = vec2(bl, rh);
}

// ---- the materials ----
const vec2 T4 = vec2(4.0);

Surf lawn(vec2 uv) {
  float patches = tf(uv, T4, 1.5, 4, 21u), tuft = tf(uv, T4, 12.0, 3, 23u);
  float blade = pnoise(uv * vec2(64.0, 16.0), vec2(256.0, 64.0), 25u);
  vec3 alb = mix(vec3(0.085, 0.17, 0.04), vec3(0.19, 0.27, 0.065), tuft) * (0.78 + 0.44 * blade);
  alb = mix(alb, vec3(0.29, 0.26, 0.11), smoothstep(0.6, 0.8, patches) * 0.55);
  float clover = smoothstep(0.66, 0.82, tf(uv + 0.31, T4, 4.0, 3, 27u));
  alb = mix(alb, vec3(0.06, 0.15, 0.055), clover * 0.6);
  vec3 c = tcell(uv, T4, 9.0, 29u);
  float fl = smoothstep(0.11, 0.06, c.x) * step(0.84, c.z);
  alb = mix(alb, mix(vec3(0.82, 0.8, 0.72), vec3(0.85, 0.62, 0.1), step(0.93, c.z)), fl);
  return Surf(alb, 0.02 * tuft + 0.006 * blade + 0.006 * fl, 0.72 + 0.28 * tuft, 0.0);
}

Surf flagstone(vec2 uv) {
  float y = mod(uv.y, 4.0);
  float r = y < 0.9 ? 0.0 : y < 1.6 ? 1.0 : y < 2.6 ? 2.0 : y < 3.2 ? 3.0 : 4.0;
  float y0 = r == 0.0 ? 0.0 : r == 1.0 ? 0.9 : r == 2.0 ? 1.6 : r == 3.0 ? 2.6 : 3.2;
  float rh = r == 0.0 ? 0.9 : r == 1.0 ? 0.7 : r == 2.0 ? 1.0 : r == 3.0 ? 0.6 : 0.8;
  float k = 3.0 + floor(ph(vec2(r, 0.0), vec2(64.0), 31u) * 3.0), bl = 4.0 / k;
  float u = uv.x + ph(vec2(r, 0.0), vec2(64.0), 32u) * 4.0, col = floor(u / bl);
  vec2 id = vec2(mod(col, k), r), q = vec2(u - col * bl, y - y0), sz = vec2(bl, rh);
  float rb = ph(id, vec2(64.0), 33u), rb2 = ph(id, vec2(64.0), 35u), rb3 = ph(id, vec2(64.0), 37u);
  vec2 dq = min(q, sz - q); float d = min(dq.x, dq.y);
  float wear = tf(uv, T4, 5.0, 3, 39u), gw = 0.010 + 0.006 * tn(uv, T4, 10.0, 41u);
  float face = smoothstep(gw, gw + 0.015 + 0.035 * wear, d);
  vec2 tilt = (vec2(rb2, rb3) - 0.5) * 0.035;   // every slab sits at its own slight tilt: the low sun picks them out one by one
  float h = -0.01 * (1.0 - face) + dot(q - sz * 0.5, tilt) * face + 0.0025 * tf(uv, T4, 16.0, 3, 43u);
  float crack = 1.0;
  if (rb > 0.76) {
    float l = (q.y - sz.y * (0.3 + 0.4 * rb2)) - (q.x - sz.x * 0.5) * (rb3 - 0.5) * 0.9 + 0.035 * (tn(uv, T4, 14.0, 45u) - 0.5);
    crack = smoothstep(0.0015, 0.006, abs(l));
  }
  h -= 0.005 * (1.0 - crack);
  vec3 stone = mix(vec3(0.44, 0.42, 0.39), vec3(0.57, 0.50, 0.41), rb) * (0.84 + 0.26 * tf(uv, T4, 8.0, 4, 47u));
  stone *= mix(vec3(1.0), vec3(0.84, 0.88, 0.95), step(0.72, rb3) * 0.7);
  vec3 grout = mix(vec3(0.10, 0.09, 0.07), vec3(0.08, 0.15, 0.045), smoothstep(0.35, 0.65, tn(uv, T4, 20.0, 49u)));
  return Surf(mix(grout, stone, face) * mix(0.5, 1.0, crack), h, mix(0.45, 1.0, face) * mix(0.6, 1.0, crack), 0.0);
}

Surf sandstone(vec2 uv) {
  vec2 id, q, sz; course(uv, T4, 0.4, 3.0, 4.0, 11u, id, q, sz);
  float rb = ph(id, vec2(64.0), 3u), rb2 = ph(id, vec2(64.0), 5u);
  vec2 dq = min(q, sz - q); float d = min(dq.x, dq.y);
  float chips = tf(uv, T4, 6.0, 3, 7u), jw = 0.009 + 0.005 * tn(uv, T4, 12.0, 9u);
  float face = smoothstep(jw, jw + 0.008 + 0.025 * chips * chips, d);
  float tool = tf(uv, T4, 20.0, 3, 13u);
  float h = -0.012 * (1.0 - face) + 0.005 * smoothstep(0.0, 0.12, d) * face + 0.003 * tool;
  vec3 tint = mix(vec3(1.07, 1.0, 0.9), vec3(0.92, 0.86, 0.78), rb);
  tint = mix(tint, vec3(1.1, 0.8, 0.58), step(0.85, rb2) * 0.65);   // a few iron-rich blocks
  float band = tn(vec2(uv.y + rb * 1.7, 0.0), vec2(4.0, 1.0), 10.0, 17u);
  vec3 alb = vec3(0.60, 0.47, 0.33) * tint * (0.86 + 0.24 * tool) * (0.92 + 0.14 * band);
  vec3 mortar = vec3(0.53, 0.50, 0.45) * (0.8 + 0.35 * tn(uv, T4, 40.0, 19u));
  return Surf(mix(mortar, alb, face), h, mix(0.64, 1.0, face) * (0.93 + 0.07 * tool), 0.0);
}

Surf granite(vec2 uv) {
  vec2 id, q, sz; course(uv, T4, 0.5, 3.0, 3.0, 51u, id, q, sz);
  float rb = ph(id, vec2(64.0), 53u);
  vec2 dq = min(q, sz - q); float d = min(dq.x, dq.y);
  float rough = tf(uv, T4, 10.0, 4, 55u);
  float face = smoothstep(0.012, 0.03 + 0.045 * rough, d);
  float h = -0.016 * (1.0 - face) + 0.009 * rough + 0.004 * smoothstep(0.0, 0.15, d);
  vec3 c = vec3(0.25, 0.25, 0.26) * mix(0.82, 1.12, rb) * (0.78 + 0.42 * rough) * (0.85 + 0.3 * tn(uv, T4, 48.0, 57u));
  vec3 mortar = vec3(0.28, 0.27, 0.25) * (0.8 + 0.3 * rough);
  return Surf(mix(mortar, c, face), h, mix(0.5, 1.0, face), 0.0);
}

Surf planks(vec2 uv, float dEdge) {
  float pw = 0.2, row = floor(uv.y / pw), r = mod(row, 20.0);
  float k = 2.0 + floor(ph(vec2(r, 0.0), vec2(64.0), 61u) * 3.0), bl = 4.0 / k;
  float u = uv.x + ph(vec2(r, 0.0), vec2(64.0), 62u) * 4.0, col = floor(u / bl);
  vec2 id = vec2(mod(col, k), r), q = vec2(u - col * bl, uv.y - row * pw);
  float rp = ph(id, vec2(64.0), 63u);
  float gap = smoothstep(0.003, 0.009, min(q.y, pw - q.y)) * smoothstep(0.002, 0.007, min(q.x, bl - q.x));
  float gr = pnoise(vec2(u * 3.0, q.y * 40.0 + rp * 17.0), vec2(12.0, 4096.0), 65u);
  float lines = 0.5 + 0.5 * sin(q.y * 95.0 + gr * 5.0 + rp * 20.0);
  vec3 wood = mix(vec3(0.21, 0.12, 0.055), vec3(0.40, 0.25, 0.12), 0.4 * lines + 0.6 * gr) * mix(0.8, 1.15, rp);
  vec3 alb = mix(vec3(0.045, 0.03, 0.02), wood, gap);
  float h = 0.0015 * lines + 0.002 * gr - 0.006 * (1.0 - gap);
  float band = 1.0 - smoothstep(0.052, 0.06, dEdge);   // iron bands along the box's outside corners
  vec3 iron = vec3(0.075, 0.068, 0.062) * (0.75 + 0.5 * tf(uv, T4, 25.0, 2, 67u));
  iron = mix(iron, vec3(0.20, 0.09, 0.04), smoothstep(0.55, 0.8, tn(uv, T4, 12.0, 69u)) * 0.6);
  return Surf(mix(alb, iron, band), mix(h, 0.004, band), mix(0.55, 1.0, max(gap, band)), 0.0);
}

Surf rooftiles(vec2 uv) {
  float rh = 0.2, row = floor(uv.y / rh), r = mod(row, 20.0);
  float u = uv.x + mod(r, 2.0) * 0.125, col = floor(u / 0.25);
  vec2 id = vec2(mod(col, 16.0), r), q = vec2(u - col * 0.25, uv.y - row * rh);
  float rb = ph(id, vec2(64.0), 71u);
  float arch = sin(3.14159265 * q.x / 0.25), lap = smoothstep(0.0, 0.035, q.y);
  float h = 0.022 * arch + 0.014 * (q.y / rh) - 0.012 * (1.0 - lap);
  float side = smoothstep(0.0, 0.02, min(q.x, 0.25 - q.x));
  vec3 terr = mix(vec3(0.45, 0.14, 0.075), vec3(0.58, 0.27, 0.12), rb) * (0.82 + 0.32 * tf(uv, T4, 12.0, 3, 73u));
  terr = mix(terr, vec3(0.30, 0.30, 0.12), smoothstep(0.62, 0.8, tf(uv, T4, 3.0, 3, 75u)) * 0.5);   // lichen
  return Surf(terr * mix(0.5, 1.0, side) * mix(0.55, 1.0, lap), h, mix(0.5, 1.0, side * lap), 0.0);
}

Surf plasterWall(vec2 uv) {
  float n1 = tf(uv, T4, 2.0, 4, 81u), n2 = tf(uv, T4, 14.0, 3, 83u);
  vec3 alb = vec3(0.71, 0.67, 0.59) * (0.88 + 0.16 * n1) * (0.95 + 0.08 * n2);
  float h = 0.006 * n1 + 0.0015 * n2;
  vec3 c = tcell(uv, T4, 3.0, 85u);
  float crack = mix(1.0, smoothstep(0.012, 0.03, c.y - c.x), step(0.6, tn(uv, T4, 1.5, 87u)));   // hairline cracks, here and there
  alb *= mix(0.62, 1.0, crack); h -= 0.002 * (1.0 - crack);
  float bareN = tf(uv + 1.7, T4, 1.25, 4, 89u), bare = smoothstep(0.71, 0.735, bareN);   // where the plaster has come away
  float br = floor(uv.y / 0.08), bu = uv.x + mod(br, 2.0) * 0.125;
  vec2 bid = vec2(mod(floor(bu / 0.25), 16.0), mod(br, 50.0)), bq = vec2(mod(bu, 0.25), mod(uv.y, 0.08));
  float bm = smoothstep(0.004, 0.009, min(min(bq.x, 0.25 - bq.x), min(bq.y, 0.08 - bq.y)));
  vec3 brick = mix(vec3(0.34, 0.11, 0.065), vec3(0.50, 0.23, 0.12), ph(bid, vec2(64.0), 91u)) * (0.85 + 0.3 * n2);
  float lip = smoothstep(0.67, 0.71, bareN) * (1.0 - bare);
  alb = mix(alb * (1.0 - 0.25 * lip), mix(vec3(0.44, 0.41, 0.37), brick, bm), bare);
  h = mix(h, -0.012 + 0.003 * bm, bare);
  return Surf(alb, h, mix(1.0, mix(0.6, 0.85, bm), bare) * mix(1.0, 0.75, lip) * crack, 0.0);
}

float glyphDist(vec2 p, float r) {
  uint b = uint(r * 255.0);
  float d = segDist(p, vec2(0.5, 0.08), vec2(0.5, 0.92));
  if ((b & 1u) != 0u) d = min(d, segDist(p, vec2(0.5, 0.92), vec2(0.15, 0.62)));
  if ((b & 2u) != 0u) d = min(d, segDist(p, vec2(0.5, 0.92), vec2(0.85, 0.62)));
  if ((b & 4u) != 0u) d = min(d, segDist(p, vec2(0.5, 0.5), vec2(0.15, 0.25)));
  if ((b & 8u) != 0u) d = min(d, segDist(p, vec2(0.5, 0.5), vec2(0.85, 0.25)));
  if ((b & 16u) != 0u) d = min(d, segDist(p, vec2(0.18, 0.5), vec2(0.82, 0.5)));
  if ((b & 32u) != 0u) d = min(d, segDist(p, vec2(0.5, 0.08), vec2(0.18, 0.3)));
  if ((b & 64u) != 0u) d = min(d, segDist(p, vec2(0.5, 0.08), vec2(0.82, 0.3)));
  return d;
}
// a crystal's pedestal: polished basalt with a band of runes on its sides and a ring on its top; runes and ring glow with the crystal
Surf basaltStone(vec2 uv) {
  const vec2 TB = vec2(1.0, 1.6);
  float n = tf(uv, TB, 10.0, 4, 93u);
  vec3 alb = vec3(0.065, 0.065, 0.075) * (0.8 + 0.45 * n);
  alb += vec3(0.05, 0.05, 0.055) * smoothstep(0.02, 0.0, abs(tf(uv, TB, 5.0, 3, 95u) - 0.5)) * 0.5;
  float g = 9.0;
  if (uv.y < 0.6) {
    if (uv.y > 0.2 && uv.y < 0.42) {
      float ci = floor(uv.x / 0.125);
      vec2 p = (vec2((uv.x - ci * 0.125) / 0.125, (uv.y - 0.2) / 0.22) - 0.5) * vec2(1.25, 1.12) + 0.5;
      g = glyphDist(p, ph(vec2(ci, 0.0), vec2(8.0, 1.0), 97u)) * 0.2;
    }
    g = min(g, min(abs(uv.y - 0.17), abs(uv.y - 0.45)));
  } else {
    vec2 c = vec2(uv.x - 0.5, uv.y - 1.1);
    float rr = length(c), a = atan(c.y, c.x);
    g = abs(rr - 0.4);
    if (rr > 0.42 && rr < 0.47) g = min(g, abs(fract(a / 6.2831853 * 16.0) - 0.5) * 6.2831853 / 16.0 * rr);
  }
  float stroke = smoothstep(0.009, 0.004, g), halo = smoothstep(0.03, 0.0, g);
  return Surf(mix(alb, vec3(0.03), stroke), 0.002 * n - 0.004 * stroke, mix(1.0, 0.7, stroke), stroke + 0.25 * halo);
}

// a crystal: dark glass that glows from inside, brighter in its core and along its edges
Surf crystalGlass(vec2 uv) {
  const vec2 TC = vec2(0.5, 1.8);
  float g;
  if (uv.y < 1.3) {
    float u = uv.x / 0.5, v = uv.y / 1.3;
    float core = 1.0 - abs(u - 0.5) * 1.5, facets = 0.5 + 0.5 * cos((u * 2.0 + v * 1.4) * 6.2831853);
    float rim = smoothstep(0.1, 0.0, min(u, 1.0 - u)), veins = tf(uv, TC, 20.0, 3, 99u);
    g = 0.5 + 0.35 * core + 0.3 * facets * (1.0 - abs(v - 0.55)) + 0.45 * rim + 0.35 * smoothstep(0.58, 0.78, veins);
    g *= mix(0.7, 1.15, smoothstep(0.0, 0.85, v));
  } else g = 1.2 + 0.4 * smoothstep(0.2, 0.0, length(uv - vec2(0.25, 1.55)));
  return Surf(vec3(0.03, 0.035, 0.04), 0.0, 1.0, g);
}

Surf mossBed(vec2 uv) {
  vec3 c = tcell(uv, T4, 8.0, 101u);
  float cushion = 1.0 - smoothstep(0.0, 0.9, c.x), n = tf(uv, T4, 16.0, 3, 103u);
  vec3 alb = mix(vec3(0.05, 0.11, 0.03), vec3(0.20, 0.32, 0.07), cushion * 0.7 + 0.3 * n) * mix(0.8, 1.2, c.z);
  vec3 c2 = tcell(uv, T4, 5.0, 105u);   // a few small white flowers
  alb = mix(alb, vec3(0.78, 0.76, 0.7), smoothstep(0.08, 0.04, c2.x) * step(0.8, c2.z));
  return Surf(alb, 0.02 * cushion + 0.004 * n, mix(0.55, 1.0, cushion), 0.0);
}

// a banner: red wool with four folds, a gold border and a gold sun in the middle
Surf bannerCloth(vec2 uv) {
  float u = uv.x, v = uv.y;
  float fold = sin(u * 6.2831853 * 4.0);
  float border = min(min(u, 1.0 - u), min(v, 2.4 - v));
  float trim = smoothstep(0.066, 0.06, border) * smoothstep(0.02, 0.026, border);
  vec2 c = vec2(u - 0.5, v - 1.45);
  float rr = length(c), a = atan(c.y, c.x);
  float disc = smoothstep(0.17, 0.16, rr) * (1.0 - smoothstep(0.1, 0.11, rr) * smoothstep(0.125, 0.115, rr));
  float rays = smoothstep(0.0, 0.06, cos(a * 12.0) - 0.55) * smoothstep(0.33, 0.30, rr) * step(0.2, rr);
  float gold = max(trim, max(disc, rays));
  vec3 red = vec3(0.42, 0.05, 0.05) * (0.86 + 0.14 * fold) * (0.88 + 0.12 * tf(uv, vec2(1.0, 2.4), 20.0, 2, 107u));
  vec3 alb = mix(red, vec3(0.62, 0.42, 0.12) * (0.9 + 0.2 * tn(uv, vec2(1.0, 2.4), 40.0, 109u)), gold);
  alb *= mix(0.72, 1.0, smoothstep(0.0, 0.5, v));   // grimier at the hem
  return Surf(alb, 0.012 * fold + 0.0015 * gold, 0.9 + 0.1 * fold, 0.0);
}

Surf barkWood(vec2 uv) {
  float f = tf(vec2(uv.x * 4.0, uv.y * 0.6), vec2(16.0, 2.4), 2.5, 4, 121u);
  float furrow = smoothstep(0.35, 0.6, f);
  vec3 alb = mix(vec3(0.05, 0.035, 0.025), vec3(0.22, 0.16, 0.11), furrow) * (0.85 + 0.3 * tn(uv, T4, 20.0, 123u));
  return Surf(alb, 0.02 * furrow, mix(0.5, 1.0, furrow), 0.0);
}

Surf foliage(vec2 uv) {
  vec3 c = tcell(uv, T4, 10.0, 111u), c2 = tcell(uv + 0.37, T4, 22.0, 113u);
  float leaf = smoothstep(0.75, 0.25, c.x), small = smoothstep(0.8, 0.3, c2.x), n = tf(uv, T4, 3.0, 3, 115u);
  vec3 alb = mix(vec3(0.03, 0.07, 0.02), mix(vec3(0.08, 0.18, 0.04), vec3(0.18, 0.26, 0.05), c.z), max(leaf, small * 0.8)) * (0.8 + 0.4 * n);
  return Surf(alb, 0.04 * max(leaf, 0.6 * small), mix(0.35, 1.0, max(leaf, small * 0.7)), 0.0);
}

// a material's pattern at (uv), with the face's outside corners rounded off (stone more, and chipped)
Surf matSurf(int m, vec2 uv, float dEdge) {
  Surf s;
  if (m == 0) s = lawn(uv);
  else if (m == 1) s = flagstone(uv);
  else if (m == 2) s = sandstone(uv);
  else if (m == 3) s = granite(uv);
  else if (m == 4) s = planks(uv, dEdge);
  else if (m == 5) s = rooftiles(uv);
  else if (m == 6) s = plasterWall(uv);
  else if (m == 7) s = basaltStone(uv);
  else if (m == 8) s = crystalGlass(uv);
  else if (m == 9) s = mossBed(uv);
  else if (m == 10) s = bannerCloth(uv);
  else if (m == 11) s = barkWood(uv);
  else s = foliage(uv);
  float r = (m == 2 || m == 3) ? 0.03 + 0.035 * tn(uv, T4, 5.0, 131u) : (m == 1 || m == 6 || m == 7) ? 0.02 : 0.008;
  float x = clamp(1.0 - dEdge / r, 0.0, 1.0);
  s.h -= r * (1.0 - sqrt(1.0 - x * x));
  if (m == 2 || m == 3 || m == 6) s.alb *= 1.0 + 0.12 * smoothstep(0.05, 0.0, dEdge);   // worn pale on the corners
  return s;
}

// distances to the face's nearest outside corner and nearest inside corner (edge flags as in world.js)
vec2 cornerDist(vec2 uv, vec2 lo, vec2 hi, vec4 fl) {
  vec4 d = vec4(uv.x - lo.x, hi.x - uv.x, uv.y - lo.y, hi.y - uv.y);
  float cx = 1e3, cc = 1e3;
  for (int i = 0; i < 4; i++) { if (fl[i] == 1.0) cx = min(cx, d[i]); else if (fl[i] == 2.0) cc = min(cc, d[i]); }
  return vec2(cx, cc);
}

// the world's own wear, on top of a material
void weather(int m, vec3 P, vec3 N, vec3 bmax, float dInside, inout Surf s) {
  float big = vnoise(P * 0.35 + 3.0) * 0.6 + vnoise(P * 0.9 + 11.0) * 0.4;
  float side = 1.0 - step(0.5, abs(N.y));
  float corner = smoothstep(0.45, 0.0, dInside);
  if (m == 2 || m == 3 || m == 6 || m == 7) {   // sandstone, granite, plaster, basalt
    float wet = side * smoothstep(0.75 + 0.7 * big, 0.0, P.y);
    s.alb *= 1.0 - 0.3 * wet;
    float green = max(wet * smoothstep(0.42, 0.72, big), step(0.5, N.y) * smoothstep(0.5, 0.78, big) * 0.8);
    green = clamp(green * mix(1.0, 1.6, 1.0 - s.cav), 0.0, 0.85);   // it takes the joints first
    s.alb = mix(s.alb, vec3(0.085, 0.15, 0.045) * (0.75 + 0.5 * vnoise(P * 2.0)), green);
    float streak = smoothstep(0.35, 0.7, vnoise(vec3((P.x + P.z) * 1.1, P.y * 0.2, 5.0)));
    s.alb *= 1.0 - side * 0.25 * smoothstep(1.8, 0.0, bmax.y - P.y) * streak;   // rain under the tops
    s.alb *= (0.9 + 0.2 * big) * (1.0 - 0.22 * corner);
  } else if (m == 1) {   // the courtyard floor: grimier toward the walls
    float edge = smoothstep(8.5, 12.8, max(abs(P.x), abs(P.z)));
    s.alb *= (1.0 - 0.2 * edge) * (0.92 + 0.16 * big) * (1.0 - 0.25 * corner);
    s.alb = mix(s.alb, vec3(0.08, 0.14, 0.045), edge * smoothstep(0.5, 0.78, big) * 0.55 * (1.6 - s.cav));
  } else if (m == 0) {   // the lawn: trodden outside the gate and the arch
    float path = smoothstep(2.6, 0.0, abs(P.x)) * step(P.z, -14.0) + smoothstep(2.0, 0.0, abs(P.x + 4.9)) * step(14.0, P.z);
    s.alb = mix(s.alb, vec3(0.22, 0.17, 0.10), clamp(path, 0.0, 1.0) * 0.6 * smoothstep(0.3, 0.6, big + 0.2));
    s.alb *= (0.88 + 0.24 * big) * (1.0 - 0.2 * corner);
  } else if (m == 4 || m == 5) {   // wood and roof: greyer where the weather gets them
    s.alb *= 0.9 + 0.2 * big;
    s.alb = mix(s.alb, vec3(dot(s.alb, vec3(0.333))), 0.25 * smoothstep(0.4, 0.8, big));
  }
}

// the detailed surface at P on a face (box bmin..bmax, face normal N, edge flags fl): albedo, bent normal, cavity, glow
void truthSurface(int m, vec3 P, vec3 N, vec3 bmin, vec3 bmax, vec4 fl, out vec3 alb, out vec3 nB, out float cav, out float emit) {
  vec2 lo = matUV(m, bmin, N, bmin), hi = matUV(m, bmax, N, bmin), uv = matUV(m, P, N, bmin);
  vec2 cd = cornerDist(uv, lo, hi, fl);
  Surf s = matSurf(m, uv, cd.x);
  const float e = 0.003;
  float hu = matSurf(m, uv + vec2(e, 0.0), cornerDist(uv + vec2(e, 0.0), lo, hi, fl).x).h;
  float hv = matSurf(m, uv + vec2(0.0, e), cornerDist(uv + vec2(0.0, e), lo, hi, fl).x).h;
  vec2 g = clamp(vec2(hu - s.h, hv - s.h) / e, -2.5, 2.5);
  vec3 T, B; faceTB(N, T, B);
  nB = normalize(N - g.x * T - g.y * B);
  weather(m, P, N, bmax, cd.y, s);
  alb = s.alb; cav = s.cav; emit = s.emit;
}
// the same surface for a bounce: only how much light it sends on
vec3 truthAlbedo(int m, vec3 P, vec3 N, vec3 bmin, vec3 bmax, vec4 fl) {
  vec2 lo = matUV(m, bmin, N, bmin), hi = matUV(m, bmax, N, bmin), uv = matUV(m, P, N, bmin);
  vec2 cd = cornerDist(uv, lo, hi, fl);
  Surf s = matSurf(m, uv, cd.x);
  weather(m, P, N, bmax, cd.y, s);
  return s.alb * mix(1.0, s.cav, 0.5);
}

// ---- the sky: the gradient, the sun, a deck of clouds lit by the time of day, and the stars where it is clear ----
vec2 cloudUV(vec3 d) { return d.xz / (max(d.y, 0.0) + 0.05) * 0.12; }
vec3 truthSky(vec3 d, float t) {
  vec3 col = skyRadiance(d, t);
  vec3 s = sunDir(t);
  float c = dot(d, s);
  col += sunIrr(t) * (sunDisk(d, t) * 60.0 + pow(max(c, 0.0), 400.0) * 1.5);
  if (d.y <= 0.0) return col;
  float dens = tf(cloudUV(d), vec2(1.0), 4.0, 5, 141u);
  float cover = smoothstep(0.5, 0.74, dens) * smoothstep(0.03, 0.22, d.y), thick = smoothstep(0.55, 0.9, dens);
  float fwd = pow(max(c, 0.0), 5.0);
  vec3 lit = skyHorizon(t) * 0.85 + skyZenith(t) * 0.4 + sunIrr(t) * (0.12 + 0.7 * fwd) * (1.0 - 0.55 * thick) + skyGlow(t) * (0.5 + 1.1 * fwd);
  col = mix(col, lit * (1.0 - 0.5 * thick), cover * 0.92);
  col += vec3(0.85, 0.9, 1.0) * starMask(d) * smoothstep(0.68, 0.95, t) * 0.6 * (1.0 - cover);
  return col;
}
`;
export const TRUTH_MATERIALS = MAT.map((m) => m[0]);
