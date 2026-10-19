// The renderer: plain WebGL2, no engine. Two views of the same frame:
//   0 BOXES     what the code keeps and draws: flat boxes with black lines, no light (the way Matrix-Game 4.0 draws its proxy)
//   1 AI PAINT  every pixel painted by the painters, from what the code knows about each pixel's box: what it is made of, where on
//               its face it is, how near the face's edges, which way it faces, where the sun reaches. The stone, the wood, the moss,
//               the runes, the crystals' glow, the bounced light and the sky are all painted. The code adds only the camera: haze,
//               exposure and the glow around bright things.
import { BOXES, BEACONS, GLSL_COMMON, GRID, FORMS, edgeFlags, formFrame } from './world.js';
import { painterGLSL, surfaceGLSL, skyGLSL, shapeGLSL } from './painter.js';
import { m4 } from './m4.js';

const POISSON = [[-0.613, 0.617], [0.17, -0.04], [-0.299, -0.792], [0.645, 0.493], [-0.651, -0.159], [0.42, -0.81], [-0.09, 0.42], [0.95, -0.12], [0.15, 0.92], [-0.95, 0.27], [0.55, 0.1], [-0.2, -0.33]];

const VS_MAIN = `#version 300 es
layout(location = 0) in vec3 aPos; layout(location = 1) in vec3 aNrm; layout(location = 2) in vec2 aMat;
layout(location = 3) in vec3 aBMin; layout(location = 4) in vec3 aBMax; layout(location = 5) in float aBox;
layout(location = 6) in vec2 aAtlas; layout(location = 7) in vec4 aRect; layout(location = 8) in vec4 aFlags;
uniform mat4 uViewProj; uniform mat4 uModel;
out vec3 vPos; out vec3 vNrm; out vec3 vLocal; out vec3 vLocalN; out vec2 vAtlas;
flat out vec2 vMat; flat out vec3 vBMin; flat out vec3 vBMax; flat out float vBox; flat out vec4 vRect; flat out vec4 vFlags;
invariant gl_Position;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vPos = w.xyz; vNrm = mat3(uModel) * aNrm; vLocal = aPos; vLocalN = aNrm; vAtlas = aAtlas; vRect = aRect; vFlags = aFlags;
  vMat = aMat; vBMin = aBMin; vBMax = aBMax; vBox = aBox;
  gl_Position = uViewProj * w;
}`;

const FS_DEPTH = `#version 300 es
precision mediump float; out vec4 o; void main() { o = vec4(0); }`;

// one source, three programs (a GPU gives a program the registers its biggest path needs, so each path gets its own):
//   'boxes' the boxes view; 'still' the world, light from the atlas; 'moving' the player and the shades, light painted at the pixel
const fsMain = (painters, variant) => `#version 300 es
#define BOXES ${variant === 'boxes' ? 1 : 0}
#define MOVING ${variant === 'moving' ? 1 : 0}
precision highp float; precision highp int; precision highp sampler3D; precision highp sampler2DShadow; precision highp sampler2DArray;
${GLSL_COMMON}
${variant === 'boxes' ? '' : painters}
uniform int uMode; uniform float uT; uniform vec3 uEye; uniform vec3 uSunDir; uniform vec3 uSunIrr;
uniform highp sampler2DShadow uShadow; uniform mat4 uSunMat; uniform float uShadowTexel; uniform float uShadowOn;
uniform vec3 uBeaconLight[5]; uniform vec3 uGlow[5];
uniform vec4 uOccl[8]; uniform int uNOccl;
uniform float uDynamic; uniform vec3 uFlatColor; uniform vec3 uEmissive; uniform int uDynMat; uniform vec3 uDynSize; uniform mat4 uModel;
in vec3 vPos; in vec3 vNrm; in vec3 vLocal; in vec3 vLocalN; in vec2 vAtlas;
flat in vec2 vMat; flat in vec3 vBMin; flat in vec3 vBMax; flat in float vBox; flat in vec4 vRect; flat in vec4 vFlags;
uniform sampler2D uAtlas; uniform vec2 uAtlasSize; uniform float uAtlasOn; uniform float uAtlasRGBM; uniform vec2 uOpenTexel;
out vec4 oColor;
const vec2 POISSON[12] = vec2[12](${POISSON.map((p) => `vec2(${p[0]}, ${p[1]})`).join(', ')});
const vec3 OPEN_FIELD = vec3(${OPEN_FIELD.join(', ')});   // a piece of open lawn inside the painters' volume: what the far field is like
float shadowAt(vec3 P, vec3 N) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 s = uSunMat * vec4(P + N * 0.05, 1.0);
  vec3 c = s.xyz / s.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float sum = 0.0;
  for (int i = 0; i < 12; i++) sum += texture(uShadow, vec3(c.xy + POISSON[i] * uShadowTexel * 1.8, c.z - 0.0009));
  return sum / 12.0;
}
float outline(vec3 L, vec3 lo, vec3 hi, vec3 n, float w) {
  vec3 a = abs(n), d = min(L - lo, hi - L);
  float e = a.x > 0.5 ? min(d.y, d.z) : (a.y > 0.5 ? min(d.x, d.z) : min(d.x, d.y));
  return smoothstep(w * 0.45, w, e);
}
void main() {
  vec3 N = normalize(vNrm), P = vPos;
  int m = int(vMat.x + 0.5), glowK = int(vMat.y + 0.5) - 1;
#if BOXES
  bool dyn = uDynamic > 0.5;
  vec3 c = dyn ? uFlatColor : MAT_PROXY[m];
  if (!dyn) {
    c *= 0.88 + 0.24 * hash3(vec3(vBox * 3.7, 11.0, 5.0));
    if (m == 0 || m == 1) { vec2 uv = faceUV(P, N); c = vec3(mod(floor(uv.x) + floor(uv.y), 2.0) > 0.5 ? 0.46 : 0.36); }
  }
  float o = outline(vLocal, vBMin, vBMax, dyn ? vLocalN : N, dyn ? 0.07 : 0.06);
  oColor = vec4(c * o, 1.0);
#else
  // where the sun reaches: the code's shadow map
  vec3 sunC = uSunIrr * shadowAt(P, N) * smoothstep(-0.02, 0.02, dot(N, uSunDir));
  vec3 wInd, wSun, wEm, L;
#if MOVING
  // a moving thing: the light painter at this pixel; the part's own face in metres from its corner; the code says what it is made
  // of and its colour
  vec3 sky, bk[5];
  paint(P, N, uT, sky, bk);
  vec3 Eind = sky;
  for (int k = 0; k < 5; k++) Eind += uBeaconLight[k] * bk[k];
  vec3 ln = normalize(vLocalN), lp = (vLocal + 0.5) * uDynSize;
  vec2 uv = faceUV(lp, ln), hi = faceUV(uDynSize, ln), lo = vec2(0.0);
  if (abs(ln.y) > 0.5) { uv.y += MAT_UV[uDynMat].w; lo.y += MAT_UV[uDynMat].w; hi.y += MAT_UV[uDynMat].w; }
  vec3 T, B; faceTB(ln, T, B);
  T = normalize(mat3(uModel) * T); B = normalize(mat3(uModel) * B);
  surfacePaint(uDynMat, uv, edgeFeatures(uv, lo, hi, vec4(1.0)), vec3(dot(uSunDir, T), dot(uSunDir, B), dot(uSunDir, N)), N.y, P, P, 0.0, 0.0, vec4(0.0), wInd, wSun, wEm);
  L = uFlatColor * (wInd * Eind + wSun * sunC) + wEm * uEmissive;
#else
  // the world: the light painter's light from the atlas it repainted this frame (darkened where the player and the shades stand)
  vec3 Eind;
  if (uAtlasOn > 0.5 && vRect.x >= 0.0) {
    vec4 a = texture(uAtlas, clamp(vAtlas, vRect.xy, vRect.zw) / uAtlasSize);
    Eind = uAtlasRGBM > 0.5 ? a.rgb * a.a * 64.0 : a.rgb;
  } else {
    vec3 sky, bk[5];
    paint(P, N, uT, sky, bk);
    Eind = sky;
    for (int k = 0; k < 5; k++) Eind += uBeaconLight[k] * bk[k];
  }
  float occ = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uNOccl) break;
    vec3 w = uOccl[i].xyz - P; float d2 = max(dot(w, w), 1e-3);
    occ *= 1.0 - clamp(uOccl[i].w * uOccl[i].w / d2 * max(dot(N, w) * inversesqrt(d2), 0.0), 0.0, 0.8);
  }
  Eind *= occ;
  // past the painters' volume (the far field, seen from the towers) the light and the wear are the open field's, blended in, so the
  // edge of the volume is never stretched out to the horizon
  float far = smoothstep(18.0, 19.6, max(abs(P.x), abs(P.z)));
  if (far > 0.0) {
    vec4 a = texture(uAtlas, uOpenTexel / uAtlasSize);
    Eind = mix(Eind, uAtlasRGBM > 0.5 ? a.rgb * a.a * 64.0 : a.rgb, far);
  }
  // the surface painter: everything about the box's face the code knows, in; how this point takes each light, out
  vec3 T, B; faceTB(N, T, B);
  vec2 uv = matUV(m, P, N, vBMin);
  vec4 ef = edgeFeatures(uv, matUV(m, vBMin, N, vBMin), matUV(m, vBMax, N, vBMin), vFlags);
  surfacePaint(m, uv, ef, vec3(dot(uSunDir, T), dot(uSunDir, B), dot(uSunDir, N)), N.y, P + N * P_OFF, OPEN_FIELD + N * P_OFF, far, 1.0, vec4(0.0), wInd, wSun, wEm);
  L = wInd * Eind + wSun * sunC;
  if (glowK >= 0) L += wEm * uGlow[glowK];
#endif
  L = applyFog(L, uEye, P, uT);
  oColor = vec4(tonemap(L * exposureAt(uT)), 1.0);
#endif
}`;

// ---- the shaped boxes, in two passes. The trace: each one's shell (its box and as far past it as its form reaches) drawn as a cube,
// the learned shape traced inside it, and the nearest hit at each pixel kept (which box, its depth). The paint: once a pixel, the
// painters at that hit. One instance a box (or a moving part): where it is, which way its axes lie, its half sizes and shell, its form,
// what it is made of. ----
const VS_SHAPE = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 iCenter; layout(location = 2) in vec2 iRot; layout(location = 3) in vec3 iHalf;
layout(location = 4) in vec3 iLo; layout(location = 5) in vec3 iHi; layout(location = 6) in vec4 iMisc; layout(location = 7) in vec2 iId;
uniform mat4 uViewProj;
out vec3 vWorld;
flat out vec3 vCenter; flat out vec2 vRot; flat out vec3 vHalf; flat out vec3 vLo; flat out vec3 vHi; flat out vec4 vMisc; flat out vec2 vId;
// a box's own axes to the world's: x and z swapped for a box longer along z (iMisc.x), else turned by its heading (iRot = cos, sin)
vec3 fromLocalV(vec3 v) { return iMisc.x > 0.5 ? v.zyx : vec3(iRot.x * v.x + iRot.y * v.z, v.y, -iRot.y * v.x + iRot.x * v.z); }
void main() {
  vec3 l = mix(-iHalf - iLo, iHalf + iHi, aPos + 0.5);
  vec3 w = iCenter + fromLocalV(l);
  vWorld = w; vCenter = iCenter; vRot = iRot; vHalf = iHalf; vLo = iLo; vHi = iHi; vMisc = iMisc; vId = iId;
  gl_Position = uViewProj * vec4(w, 1.0);
}`;
const LOCAL = `
vec3 toLocalR(vec3 v, vec2 rot, bool swap) { return swap ? v.zyx : vec3(rot.x * v.x - rot.y * v.z, v.y, rot.y * v.x + rot.x * v.z); }
vec3 fromLocalR(vec3 v, vec2 rot, bool swap) { return swap ? v.zyx : vec3(rot.x * v.x + rot.y * v.z, v.y, -rot.y * v.x + rot.x * v.z); }`;
const fsShapeTrace = (shapeG, variant) => `#version 300 es
#define SHADOW ${variant === 'shadow' ? 1 : 0}
precision highp float; precision highp int; precision highp sampler3D;
${GLSL_COMMON}
${shapeG}
${LOCAL}
uniform mat4 uViewProj; uniform vec3 uEye; uniform vec3 uRayDir;
in vec3 vWorld;
flat in vec3 vCenter; flat in vec2 vRot; flat in vec3 vHalf; flat in vec3 vLo; flat in vec3 vHi; flat in vec4 vMisc; flat in vec2 vId;
out vec4 oId;
void main() {
  bool swap = vMisc.x > 0.5;
  // the ray, in the box's own axes: from the eye (the camera), or along the sun's direction (the shadow map)
#if SHADOW
  vec3 rd = toLocalR(uRayDir, vRot, swap), ro = toLocalR(vWorld - vCenter, vRot, swap) - rd * 60.0;
#else
  vec3 ro = toLocalR(uEye - vCenter, vRot, swap), rd = normalize(toLocalR(vWorld - uEye, vRot, swap));
#endif
  vec3 x, fn;
  if (!shapeTraceCoarse(int(vId.x + 0.5), ro, rd, -vHalf - vLo, vHalf + vHi, vHalf, x, fn)) discard;
  vec4 clip = uViewProj * vec4(vCenter + fromLocalR(x, vRot, swap), 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  // which box (+1, over two bytes), and when the hit is the shell's own face, which face (1-6)
  float id = vId.y + 1.0, face = dot(abs(fn), vec3(1.0, 3.0, 5.0)) + (dot(fn, vec3(1.0)) > 0.0 ? 1.0 : 0.0);
  oId = vec4(mod(id, 256.0), floor(id / 256.0), dot(fn, fn) > 0.5 ? face : 0.0, 255.0) / 255.0;
}`;
// a normal in three bytes (octahedral, 12 bits a coordinate), and back
const OCT = `
vec2 octOf(vec3 n) { n /= abs(n.x) + abs(n.y) + abs(n.z); vec2 p = n.xy; if (n.z < 0.0) p = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0); return p; }
vec3 packNormal(vec3 n) {
  uvec2 u = uvec2(clamp(octOf(n) * 0.5 + 0.5, 0.0, 1.0) * 4095.0 + 0.5);
  return vec3(float(u.x & 255u), float((u.x >> 8u) | ((u.y & 15u) << 4u)), float(u.y >> 4u)) / 255.0;
}
vec3 unpackNormal(vec3 c) {
  uvec3 b = uvec3(c * 255.0 + 0.5);
  vec2 p = vec2(float(b.x | ((b.y & 15u) << 8u)), float((b.y >> 4u) | (b.z << 4u))) / 4095.0 * 2.0 - 1.0;
  vec3 n = vec3(p, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return normalize(n);
}`;
// the shapes' geometry, once a pixel: the shape painter places the surface the trace found (to a centimetre) along the pixel's ray,
// gives its normal (or the shell's face, where the shape was solid at it) and how tucked in it is
const fsShapeGeom = (shapeG) => `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
${GLSL_COMMON}
${shapeG}
${LOCAL}
${OCT}
uniform highp sampler2D uSId; uniform highp sampler2D uSDepth; uniform highp sampler2D uInst;
uniform mat4 uInvViewProj; uniform mat4 uViewProj; uniform vec2 uRes; uniform vec3 uEye;
out vec4 oGeom;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 idv = texelFetch(uSId, px, 0);
  float idf = floor(idv.r * 255.0 + 0.5) + floor(idv.g * 255.0 + 0.5) * 256.0;
  if (idf < 0.5) discard;
  int i = int(idf) - 1;
  float z = texelFetch(uSDepth, px, 0).r;
  vec4 wp = uInvViewProj * vec4((gl_FragCoord.xy / uRes) * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = wp.xyz / wp.w;
  vec4 t0 = texelFetch(uInst, ivec2(0, i), 0), t1 = texelFetch(uInst, ivec2(1, i), 0), t2 = texelFetch(uInst, ivec2(2, i), 0);
  int f = int(t0.w + 0.5);
  bool swap = t1.z > 0.5, moving = t1.w > 0.5;
  vec3 h = t2.xyz, x = toLocalR(P - t0.xyz, t1.xy, swap);
  float face = floor(idv.b * 255.0 + 0.5), ao = 0.0;
  vec3 nl;
  if (face > 0.5) { float a = floor((face - 1.0) / 2.0); nl = vec3(a < 0.5 ? 1.0 : 0.0, a > 0.5 && a < 1.5 ? 1.0 : 0.0, a > 1.5 ? 1.0 : 0.0) * (mod(face - 1.0, 2.0) > 0.5 ? 1.0 : -1.0); }
  else {
    vec3 rl = toLocalR(normalize(P - uEye), t1.xy, swap);
    x += rl * clamp(shapeFine(f, x, h), -0.02, 0.02);
    float d0 = shapeFine(f, x, h);
    // a ray that only grazed the shape (the coarse distance came within a centimetre of an edge it passes): no surface here
    if (abs(d0) > 0.004) discard;
    x += rl * d0;
    vec4 clip = uViewProj * vec4(t0.xyz + fromLocalR(x, t1.xy, swap), 1.0);
    z = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
    nl = shapeNormalAt(f, x, h, 0.0);
    if (!moving) ao = shapeAO(f, x, h, nl);   // (a moving part's cue: none; it was taught without one)
  }
  oGeom = vec4(packNormal(normalize(fromLocalR(nl, t1.xy, swap))), ao);
  gl_FragDepth = z;
}`;
const fsShapePaint = (painters) => `#version 300 es
precision highp float; precision highp int; precision highp sampler3D; precision highp sampler2DShadow; precision highp sampler2DArray;
${GLSL_COMMON}
${painters}
${LOCAL}
${OCT}
uniform highp sampler2D uSId; uniform highp sampler2D uGeom; uniform highp sampler2D uGDepth; uniform highp sampler2D uInst;
uniform mat4 uInvViewProj; uniform vec2 uRes;
uniform int uMode; uniform float uT; uniform vec3 uEye; uniform vec3 uSunDir; uniform vec3 uSunIrr;
uniform highp sampler2DShadow uShadow; uniform mat4 uSunMat; uniform float uShadowTexel; uniform float uShadowOn;
uniform vec3 uBeaconLight[5]; uniform vec3 uGlow[5];
uniform vec4 uOccl[8]; uniform int uNOccl;
uniform sampler2D uAtlas; uniform vec2 uAtlasSize; uniform float uAtlasRGBM; uniform vec2 uOpenTexel;
out vec4 oColor;
const vec2 POISSON[12] = vec2[12](${POISSON.map((p) => `vec2(${p[0]}, ${p[1]})`).join(', ')});
const vec3 OPEN_FIELD = vec3(${OPEN_FIELD.join(', ')});
float shadowAt(vec3 P, vec3 N) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 s = uSunMat * vec4(P + N * 0.05, 1.0);
  vec3 c = s.xyz / s.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float sum = 0.0;
  for (int i = 0; i < 12; i++) sum += texture(uShadow, vec3(c.xy + POISSON[i] * uShadowTexel * 1.8, c.z - 0.0009));
  return sum / 12.0;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uGDepth, px, 0).r;
  if (z >= 1.0) discard;
  vec4 idv = texelFetch(uSId, px, 0), g = texelFetch(uGeom, px, 0);
  int i = int(floor(idv.r * 255.0 + 0.5) + floor(idv.g * 255.0 + 0.5) * 256.0) - 1;
  vec4 wp = uInvViewProj * vec4((gl_FragCoord.xy / uRes) * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
  vec3 P = wp.xyz / wp.w;
  // the box: centre and form, heading and how its axes lie, half sizes and material, shell, glow, colour, glow colour, box min
  vec4 t0 = texelFetch(uInst, ivec2(0, i), 0), t1 = texelFetch(uInst, ivec2(1, i), 0), t2 = texelFetch(uInst, ivec2(2, i), 0), t3 = texelFetch(uInst, ivec2(3, i), 0);
  int m = int(t2.w + 0.5), glowK = int(t3.w + 0.5) - 1;
  bool swap = t1.z > 0.5, moving = t1.w > 0.5;
  vec3 h = t2.xyz, x = toLocalR(P - t0.xyz, t1.xy, swap);
  vec3 N = unpackNormal(g.rgb), nl = toLocalR(N, t1.xy, swap);
  float ao = g.a;
  vec3 sunC = uSunIrr * shadowAt(P, N) * smoothstep(-0.02, 0.02, dot(N, uSunDir));
  // the light painter's light at this pixel
  vec3 sky, bk[5];
  paint(P, N, uT, sky, bk);
  vec3 Eind = sky;
  for (int k = 0; k < 5; k++) Eind += uBeaconLight[k] * bk[k];
  float far = 0.0;
  if (!moving) {
    float occ = 1.0;
    for (int j = 0; j < 8; j++) {
      if (j >= uNOccl) break;
      vec3 w = uOccl[j].xyz - P; float d2 = max(dot(w, w), 1e-3);
      occ *= 1.0 - clamp(uOccl[j].w * uOccl[j].w / d2 * max(dot(N, w) * inversesqrt(d2), 0.0), 0.0, 0.8);
    }
    Eind *= occ;
    far = smoothstep(18.0, 19.6, max(abs(P.x), abs(P.z)));
    if (far > 0.0) { vec4 a = texture(uAtlas, uOpenTexel / uAtlasSize); Eind = mix(Eind, uAtlasRGBM > 0.5 ? a.rgb * a.a * 64.0 : a.rgb, far); }
  }
  // the surface painter: what the shape is made of, where on it the point is, which way it faces, how tucked in it is
  vec3 T, B, wInd, wSun, wEm;
  vec2 uv;
  if (moving) {
    vec3 lp = x + h;
    uv = faceUV(lp, nl);
    if (domAxis(nl) == 1) uv.y += MAT_UV[m].w;
    faceTB(nl, T, B); T = normalize(fromLocalR(T, t1.xy, swap)); B = normalize(fromLocalR(B, t1.xy, swap));
  } else { uv = matUV(m, P, N, texelFetch(uInst, ivec2(7, i), 0).xyz); faceTB(N, T, B); }
  surfacePaint(m, uv, vec4(0.0), vec3(dot(uSunDir, T), dot(uSunDir, B), dot(uSunDir, N)), N.y, P + N * P_OFF, OPEN_FIELD + N * P_OFF, far, moving ? 0.0 : 1.0, vec4(ao, 1.0, 0.0, 0.0), wInd, wSun, wEm);
  vec3 L;
  if (moving) L = texelFetch(uInst, ivec2(5, i), 0).xyz * (wInd * Eind + wSun * sunC) + wEm * texelFetch(uInst, ivec2(6, i), 0).xyz;
  else { L = wInd * Eind + wSun * sunC; if (glowK >= 0) L += wEm * uGlow[glowK]; }
  L = applyFog(L, uEye, P, uT);
  oColor = vec4(tonemap(L * exposureAt(uT)), 1.0);
  gl_FragDepth = z;
}`;

const VS_LIGHT = `#version 300 es
layout(location = 0) in vec2 aPix; layout(location = 1) in vec3 aWorld; layout(location = 2) in vec3 aNrm;
uniform vec2 uAtlasSize;
out vec3 vWorld; flat out vec3 vN;
void main() { vWorld = aWorld; vN = aNrm; gl_Position = vec4(aPix / uAtlasSize * 2.0 - 1.0, 0.0, 1.0); }`;
const fsLight = (painter) => `#version 300 es
precision highp float; precision highp int; precision highp sampler3D;
${GLSL_COMMON}
${painter}
uniform float uT; uniform vec3 uBeaconLight[5]; uniform float uRGBM;
in vec3 vWorld; flat in vec3 vN;
out vec4 o;
void main() {
  vec3 sky, bk[5];
  paint(vWorld, vN, uT, sky, bk);
  vec3 E = sky;
  for (int k = 0; k < 5; k++) E += uBeaconLight[k] * bk[k];
  if (uRGBM > 0.5) {
    float m = clamp(max(max(E.r, E.g), max(E.b, 1e-6)) / 64.0, 1.0 / 255.0, 1.0);
    m = ceil(m * 255.0) / 255.0;
    o = vec4(E / (m * 64.0), m);
  } else o = vec4(E, 1.0);
}`;

const VS_FULL = `#version 300 es
const vec2 V[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() { vec2 p = V[gl_VertexID]; vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 1.0, 1.0); }`;

const fsSky = (painter) => `#version 300 es
precision highp float; precision highp int;
${GLSL_COMMON}
${painter}
uniform mat4 uInvViewProj; uniform vec3 uEye; uniform float uT; uniform int uMode;
in vec2 vUv; out vec4 o;
void main() {
  if (uMode == 0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 f = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(f.xyz / f.w - uEye);
  // the sky ends at the horizon: at and below it (past the land's far edge) is the haze just above the horizon, where the sky
  // painter learned it well
  if (d.y < 0.02) d = normalize(vec3(d.x, 0.02 * length(d.xz), d.z));
  o = vec4(tonemap(skyPaint(d, uT) * exposureAt(uT)), 1.0);
}`;

const FS_BRIGHT = `#version 300 es
precision mediump float; uniform sampler2D uSrc; in vec2 vUv; out vec4 o;
void main() { vec3 c = texture(uSrc, vUv).rgb; float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); o = vec4(c * smoothstep(0.86, 1.0, l), 1.0); }`;
const FS_BLUR = `#version 300 es
precision mediump float; uniform sampler2D uSrc; uniform vec2 uDir; in vec2 vUv; out vec4 o;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 0.227027;
  c += (texture(uSrc, vUv + uDir * 1.3846).rgb + texture(uSrc, vUv - uDir * 1.3846).rgb) * 0.3162162;
  c += (texture(uSrc, vUv + uDir * 3.2308).rgb + texture(uSrc, vUv - uDir * 3.2308).rgb) * 0.0702703;
  o = vec4(c, 1.0);
}`;
const FS_COMPOSE = `#version 300 es
precision mediump float; uniform sampler2D uScene; uniform sampler2D uB1; uniform sampler2D uB2; uniform float uBloom; in vec2 vUv; out vec4 o;
void main() {
  vec3 c = texture(uScene, vUv).rgb + (texture(uB1, vUv).rgb * 0.45 + texture(uB2, vUv).rgb * 0.65) * uBloom;
  if (uBloom > 0.5) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.14); c = (c - 0.5) * 1.07 + 0.5; }
  vec2 q = vUv - 0.5; c *= 1.0 - dot(q, q) * 0.35 * uBloom;
  o = vec4(c, 1.0);
}`;

function program(gl, vs, fs, name) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n'), m = /ERROR: \d+:(\d+)/.exec(log || ''), at = m ? +m[1] : 0;
      throw new Error(`${name}: ${log}\n` + lines.slice(Math.max(0, at - 4), at + 2).map((l, i) => `${at - 3 + i}: ${l}`).join('\n'));
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); const key = u.name.replace(/\[0\]$/, ''); loc[key] = gl.getUniformLocation(p, u.name); }
  return { p, loc };
}

// a piece of open lawn inside the painters' volume: what the far field past it is like (its light is one atlas texel)
const OPEN_FIELD = [-19.5, 0.0, -10.0];
// static geometry: every box face that is not buried inside another box
function buildStatic(withShaped = true) {
  const v = [], openQuad = [];
  const faces = [
    { n: [1, 0, 0], q: (lo, hi) => [[hi[0], lo[1], hi[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]]] },
    { n: [-1, 0, 0], q: (lo, hi) => [[lo[0], lo[1], lo[2]], [lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [lo[0], hi[1], lo[2]]] },
    { n: [0, 1, 0], q: (lo, hi) => [[lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]] },
    { n: [0, -1, 0], q: (lo, hi) => [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [lo[0], lo[1], hi[2]]] },
    { n: [0, 0, 1], q: (lo, hi) => [[lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]] },
    { n: [0, 0, -1], q: (lo, hi) => [[hi[0], lo[1], lo[2]], [lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]]] },
  ];
  // a face is left out only when one other box covers all of it (a face partly covered is still drawn)
  const inBox = (b, p) => p[0] > b.min[0] && p[0] < b.max[0] && p[1] > b.min[1] && p[1] < b.max[1] && p[2] > b.min[2] && p[2] < b.max[2];
  const kept = [];
  BOXES.forEach((b, bi) => {
    if (b.form && !withShaped) return;
    for (const f of faces) {
      const c = f.q(b.min, b.max), mid = [0, 1, 2].map((a) => (c[0][a] + c[2][a]) / 2);
      const probe = [...c.map((p) => p.map((x, a) => x * 0.995 + mid[a] * 0.005 + f.n[a] * 0.01)), mid.map((x, a) => x + f.n[a] * 0.01)];
      if (BOXES.some((o, oi) => oi !== bi && probe.every((p) => inBox(o, p)))) continue;
      if (f.n[1] === -1 && b.min[1] <= 0.001) continue;
      kept.push({ b, bi, f, c });
    }
  });
  // the light atlas: every face inside the painter's volume gets a rectangle of texels (one every TEXEL metres, a border of one)
  const TEXEL = 0.2, AW = 1024, rects = [];
  for (const k of kept) {
    const a = k.f.n.findIndex((x) => x !== 0), u = (a + 1) % 3, w = (a + 2) % 3, plane = k.f.n[a] > 0 ? k.b.max[a] : k.b.min[a];
    if (k.b.e >= 0 || plane < GRID.min[a] || plane > GRID.max[a]) continue;
    const lo = [Math.max(k.b.min[u], GRID.min[u]), Math.max(k.b.min[w], GRID.min[w])], hi = [Math.min(k.b.max[u], GRID.max[u]), Math.min(k.b.max[w], GRID.max[w])];
    if (hi[0] <= lo[0] || hi[1] <= lo[1]) continue;
    const nu = Math.max(1, Math.ceil((hi[0] - lo[0]) / TEXEL)), nv = Math.max(1, Math.ceil((hi[1] - lo[1]) / TEXEL));
    k.rect = { a, u, w, plane, lo, hi, nu, nv };
    rects.push(k.rect);
  }
  rects.sort((p, q) => q.nv - p.nv);
  // and one texel for the open field past the painters' volume (OPEN_FIELD, facing up): its light, painted with the rest each frame
  const open = { open: true, nu: 1, nv: 1 };
  rects.push(open);
  let x = 0, y = 0, shelf = 0;
  for (const r of rects) {
    if (x + r.nu + 2 > AW) { x = 0; y += shelf; shelf = 0; }
    r.x = x; r.y = y; x += r.nu + 2; shelf = Math.max(shelf, r.nv + 2);
  }
  const AH = y + shelf;
  { const c4 = [[open.x, open.y], [open.x + 3, open.y], [open.x + 3, open.y + 3], [open.x, open.y + 3]].map(([px, py]) => [px, py, ...OPEN_FIELD, 0, 1, 0]);
    for (const i of [0, 1, 2, 0, 2, 3]) openQuad.push(...c4[i]); }
  const atlasOf = (r, p) => [r.x + 1 + ((p[r.u] - r.lo[0]) / (r.hi[0] - r.lo[0])) * r.nu, r.y + 1 + ((p[r.w] - r.lo[1]) / (r.hi[1] - r.lo[1])) * r.nv];
  const quads = openQuad;
  for (const k of kept) {
    const r = k.rect, rect = r ? [r.x + 1, r.y + 1, r.x + 1 + r.nu, r.y + 1 + r.nv] : [-1, -1, -1, -1];
    const a = k.f.n.findIndex((x) => x !== 0), fl = edgeFlags(k.b, a, k.f.n[a] > 0 ? 1 : 0);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const at = r ? atlasOf(r, k.c[i]) : [0, 0];
      v.push(...k.c[i], ...k.f.n, k.b.m, k.b.glow + 1, ...k.b.min, ...k.b.max, k.bi, ...at, ...rect, ...fl);
    }
    if (r) {
      // the light pass draws the whole padded rectangle; its world corners run one texel past the face on every side
      const du = (r.hi[0] - r.lo[0]) / r.nu, dv = (r.hi[1] - r.lo[1]) / r.nv;
      const corner = (px, py) => { const p = [0, 0, 0]; p[r.a] = r.plane; p[r.u] = r.lo[0] + (px - r.x - 1) * du; p[r.w] = r.lo[1] + (py - r.y - 1) * dv; return [px, py, ...p, ...k.f.n]; };
      const c4 = [corner(r.x, r.y), corner(r.x + r.nu + 2, r.y), corner(r.x + r.nu + 2, r.y + r.nv + 2), corner(r.x, r.y + r.nv + 2)];
      for (const i of [0, 1, 2, 0, 2, 3]) quads.push(...c4[i]);
    }
  }
  return { verts: new Float32Array(v), quads: new Float32Array(quads), AW, AH, open: [open.x + 1.5, open.y + 1.5], texels: rects.reduce((s, r) => s + (r.nu + 2) * (r.nv + 2), 0) };
}
function buildCube() {
  const v = [], lo = [-0.5, -0.5, -0.5], hi = [0.5, 0.5, 0.5];
  const q = [
    [[1, 0, 0], [[hi[0], lo[1], hi[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]]]],
    [[-1, 0, 0], [[lo[0], lo[1], lo[2]], [lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [lo[0], hi[1], lo[2]]]],
    [[0, 1, 0], [[lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]]],
    [[0, -1, 0], [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [lo[0], lo[1], hi[2]]]],
    [[0, 0, 1], [[lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]]],
    [[0, 0, -1], [[hi[0], lo[1], lo[2]], [lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]]]],
  ];
  for (const [n, c] of q) for (const k of [0, 1, 2, 0, 2, 3]) v.push(...c[k], ...n, 0, 0, ...lo, ...hi, 0, 0, 0, -1, -1, -1, -1, 1, 1, 1, 1);
  return new Float32Array(v);
}

// a unit cube's corners (buildCube's faces, wound the same way), for the shaped boxes' shells
const CUBE36 = (() => { const v = buildCube(), out = []; for (let i = 0; i < v.length; i += 25) out.push(v[i], v[i + 1], v[i + 2]); return new Float32Array(out); })();
const INST = 29;   // floats an instance: centre 3, heading 2, half sizes 3, shell below 3, shell above 3, (swap, material, glow + 1, moving) 4, colour 3, glow colour 3, box min 3, (form, index) 2
// an instance: { c, rot, fr (formFrame), swap, mat, glow1, moving, color, emit, bmin, form, index }, as the trace's vertex data and as a
// row of the paint pass's table (8 texels: centre and form, heading and how its axes lie, half sizes and material, shell below and
// glow, shell above, colour, glow colour, box min)
const instanceArr = (o) => [...o.c, ...o.rot, ...o.fr.h, ...o.fr.lo, ...o.fr.hi, o.swap, o.mat, o.glow1, o.moving, ...o.color, ...o.emit, ...o.bmin, o.form, o.index];
const tableRow = (o) => [...o.c, o.form, ...o.rot, o.swap, o.moving, ...o.fr.h, o.mat, ...o.fr.lo, o.glow1, ...o.fr.hi, 0, ...o.color, 0, ...o.emit, 0, ...o.bmin, 0];
const MAX_MOVING = 64;

export class Renderer {
  // painters: { light, surface, sky, shape } (painter.js); without a shape painter every box is painted as a box
  constructor(canvas, painters, { preserve = false } = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: preserve });
    if (!gl) throw new Error('This browser has no WebGL2.');
    this.gl = gl; this.canvas = canvas; this.painters = painters; this.painter = painters.light;
    const crystals = BEACONS.map((_, k) => { const b = BOXES.find((x) => x.e === k); return [b.min, b.max]; });
    const lightGLSL = painterGLSL(painters.light.head, crystals);
    const both = lightGLSL + surfaceGLSL(painters.surface.head);
    this.progs = { boxes: program(gl, VS_MAIN, fsMain(both, 'boxes'), 'boxes'), still: program(gl, VS_MAIN, fsMain(both, 'still'), 'still'), moving: program(gl, VS_MAIN, fsMain(both, 'moving'), 'moving') };
    if (painters.shape) {
      const shapeG = shapeGLSL(painters.shape.head);
      this.progs.trace = program(gl, VS_SHAPE, fsShapeTrace(shapeG, 'camera'), 'shape trace');
      this.progs.traceShadow = program(gl, VS_SHAPE, fsShapeTrace(shapeG, 'shadow'), 'shape shadow');
      this.progs.shapeGeom = program(gl, VS_FULL, fsShapeGeom(shapeG), 'shape geometry');
      this.progs.shape = program(gl, VS_FULL, fsShapePaint(both), 'shape paint');
    }
    this.depth = program(gl, VS_MAIN, FS_DEPTH, 'depth');
    this.sky = program(gl, VS_FULL, fsSky(skyGLSL(painters.sky.head)), 'sky');
    this.bright = program(gl, VS_FULL, FS_BRIGHT, 'bright');
    this.blur = program(gl, VS_FULL, FS_BLUR, 'blur');
    this.compose = program(gl, VS_FULL, FS_COMPOSE, 'compose');
    const mkVao = (data) => {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const S = 25 * 4;
      [[0, 3, 0], [1, 3, 3], [2, 2, 6], [3, 3, 8], [4, 3, 11], [5, 1, 14], [6, 2, 15], [7, 4, 17], [8, 4, 21]].forEach(([l, n, o]) => { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, S, o * 4); });
      return { vao, count: data.length / 25 };
    };
    // every box's faces for the boxes view; only the boxes with no form for the painted one (a shaped box is traced in its shell)
    const built = buildStatic(!painters.shape);
    this.statikAll = painters.shape ? mkVao(buildStatic(true).verts) : null;
    this.statik = mkVao(built.verts);
    this.cube = mkVao(buildCube());
    if (painters.shape) this.buildShapes();
    // the light atlas and the pass that repaints it
    this.atlas = { w: built.AW, h: built.AH, texels: built.texels, open: built.open };
    this.light = program(gl, VS_LIGHT, fsLight(lightGLSL), 'light');
    this.lightVao = gl.createVertexArray(); gl.bindVertexArray(this.lightVao);
    { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, built.quads, gl.STATIC_DRAW);
      [[0, 2, 0], [1, 3, 2], [2, 3, 5]].forEach(([l, n, o]) => { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, 8 * 4, o * 4); }); }
    this.lightCount = built.quads.length / 8;
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const mkAtlas = (half) => {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, half ? gl.RGBA16F : gl.RGBA8, this.atlas.w, this.atlas.h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); return null; }
      return { tex, fb, rgbm: !half };
    };
    Object.assign(this.atlas, (floatOk && mkAtlas(true)) || mkAtlas(false));
    this.useAtlas = true;
    this.emptyVao = gl.createVertexArray();
    // the sun's shadow map
    this.shadowSize = 2048;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    if (this.progs.shape) {
      // the still world's shadows, kept while the sun has not moved (tracing every shell into the map is the frame's dearest pass); each
      // frame the map starts from it and only the moving things are drawn in
      const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
      this.stillShadowFb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.stillShadowFb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
      this.stillShadowSun = null;
    }
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    this.w = 0; this.h = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // the shaped boxes' instances (one vertex array for them all: every form's grid is in one texture) and the moving parts' (refilled
  // each frame), and the paint pass's table of them
  buildShapes() {
    const gl = this.gl, rows = [];
    BOXES.forEach((b) => {
      if (!b.form) return;
      const fr = formFrame(b.form, b.min, b.max), c = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2);
      rows.push({ c, rot: [1, 0], fr, swap: fr.swap ? 1 : 0, mat: b.m, glow1: b.glow + 1, moving: 0, color: [1, 1, 1], emit: [0, 0, 0], bmin: b.min, form: b.form, index: rows.length });
    });
    this.shapeCount = rows.length;
    const data = new Float32Array(rows.length * INST), table = new Float32Array((rows.length + MAX_MOVING) * 32);
    rows.forEach((r, i) => { data.set(instanceArr(r), i * INST); table.set(tableRow(r), i * 32); });
    this.cubeBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeBuf); gl.bufferData(gl.ARRAY_BUFFER, CUBE36, gl.STATIC_DRAW);
    this.shapeBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeBuf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.shapeVao = this.instVao(this.shapeBuf);
    this.movingBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.movingBuf); gl.bufferData(gl.ARRAY_BUFFER, MAX_MOVING * INST * 4, gl.DYNAMIC_DRAW);
    this.movingVao = this.instVao(this.movingBuf);
    this.instTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.instTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 8, rows.length + MAX_MOVING, 0, gl.RGBA, gl.FLOAT, table);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.movingCount = 0;
  }
  instVao(buf) {
    const gl = this.gl, vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    [[1, 3, 0], [2, 2, 3], [3, 3, 5], [4, 3, 8], [5, 3, 11], [6, 4, 14], [7, 2, 27]].forEach(([l, n, o]) => {
      gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, n, gl.FLOAT, false, INST * 4, o * 4); gl.vertexAttribDivisor(l, 1);
    });
    return vao;
  }
  // the moving parts that have a form: their instances and their rows of the table (after the boxes')
  movingShapes(dynamics) {
    const gl = this.gl, list = dynamics.filter((d) => d.form).slice(0, MAX_MOVING);
    this.movingCount = list.length;
    if (!list.length) return list;
    const data = new Float32Array(list.length * INST), table = new Float32Array(list.length * 32);
    list.forEach((d, i) => {
      const h = d.size.map((x) => x / 2), fr = formFrame(d.form, h.map((x) => -x), h, false);
      const o = { c: d.pos, rot: [Math.cos(d.yaw), Math.sin(d.yaw)], fr, swap: 0, mat: d.mat, glow1: 0, moving: 1, color: d.color, emit: d.emissive || [0, 0, 0], bmin: [0, 0, 0], form: d.form, index: this.shapeCount + i };
      data.set(instanceArr(o), i * INST); table.set(tableRow(o), i * 32);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.movingBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.bindTexture(gl.TEXTURE_2D, this.instTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.shapeCount, 8, list.length, gl.RGBA, gl.FLOAT, table);
    return list;
  }
  // the shells, traced (prog: the trace into the shapes' target, or the one into the sun's shadow map): the boxes', the moving parts'
  traceShapes(prog, still = true, moving = true) {
    const gl = this.gl;
    this.painters.shape.bind(prog.p);
    if (still) { gl.bindVertexArray(this.shapeVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.shapeCount); }
    if (moving && this.movingCount) { gl.bindVertexArray(this.movingVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.movingCount); }
  }
  resize(w, h) {
    const gl = this.gl;
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    const free = (o) => o && (o.tex && gl.deleteTexture(o.tex), o.fb && gl.deleteFramebuffer(o.fb));
    [this.msaa, this.resolve, this.b1a, this.b1b, this.b2a, this.b2b].forEach(free);
    if (this.msaa) { gl.deleteRenderbuffer(this.msaa.color); gl.deleteRenderbuffer(this.msaa.depth); }
    const color = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
    const depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.msaa = { fb, color, depth };
    const target = (tw, th) => {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tw, th);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb: f, w: tw, h: th };
    };
    this.resolve = target(w, h);
    if (this.progs.shape) {
      // the shapes' trace target: which box is nearest at each pixel, and its depth
      if (this.shapeT) { gl.deleteTexture(this.shapeT.id); gl.deleteTexture(this.shapeT.depth); gl.deleteFramebuffer(this.shapeT.fb); }
      const id = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, id); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      const dep = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dep); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      for (const t of [id, dep]) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); }
      const sfb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, sfb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, id, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dep, 0);
      this.shapeT = { id, depth: dep, fb: sfb };
      if (this.geomT) { gl.deleteTexture(this.geomT.col); gl.deleteTexture(this.geomT.depth); gl.deleteFramebuffer(this.geomT.fb); }
      const col = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, col); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      const gd = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, gd); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      for (const t of [col, gd]) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); }
      const gfb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, gfb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, col, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, gd, 0);
      this.geomT = { col, depth: gd, fb: gfb };
    }
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1), qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.b1a = target(hw, hh); this.b1b = target(hw, hh); this.b2a = target(qw, qh); this.b2b = target(qw, qh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // the sun's view, fitted around the level
  sunMatrix(sd) {
    const center = [0, 2, 0], eye = [center[0] + sd[0] * 70, center[1] + sd[1] * 70, center[2] + sd[2] * 70];
    const view = m4.lookAt(eye, center, Math.abs(sd[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0]);
    return m4.mul(m4.ortho(-27, 27, -27, 27, 20, 150), view);
  }
  setMain(prog, f) {
    const gl = this.gl, { p, loc } = prog;
    gl.useProgram(p);
    if (prog !== this.progs.boxes) { this.painters.light.bind(p); this.painters.surface.bind(p); }
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.shadowTex); gl.uniform1i(loc.uShadow, 7);
    gl.uniform1i(loc.uMode, f.mode); gl.uniform1f(loc.uT, f.t);
    gl.uniform3fv(loc.uEye, f.eye); gl.uniform3fv(loc.uSunDir, f.sunDir); gl.uniform3fv(loc.uSunIrr, f.sunIrr);
    gl.uniformMatrix4fv(loc.uSunMat, false, f.sunMat); gl.uniform1f(loc.uShadowTexel, 1 / this.shadowSize); gl.uniform1f(loc.uShadowOn, f.shadowOn ? 1 : 0);
    gl.uniform3fv(loc.uBeaconLight, f.beaconLight); gl.uniform3fv(loc.uGlow, f.beaconGlow);
    const occ = new Float32Array(32); (f.occluders || []).slice(0, 8).forEach((o, i) => occ.set(o, i * 4));
    gl.uniform4fv(loc.uOccl, occ); gl.uniform1i(loc.uNOccl, Math.min(8, (f.occluders || []).length));
    gl.uniformMatrix4fv(loc.uViewProj, false, f.viewProj);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, this.atlas.tex); gl.uniform1i(loc.uAtlas, 8);
    gl.uniform2f(loc.uAtlasSize, this.atlas.w, this.atlas.h);
    gl.uniform1f(loc.uAtlasOn, this.useAtlas ? 1 : 0); gl.uniform1f(loc.uAtlasRGBM, this.atlas.rgbm ? 1 : 0);
    gl.uniform2fv(loc.uOpenTexel, this.atlas.open);
  }
  drawStill(prog, all = false) {
    const gl = this.gl, { loc } = prog, vao = all && this.statikAll ? this.statikAll : this.statik;
    gl.bindVertexArray(vao.vao);
    gl.uniformMatrix4fv(loc.uModel, false, m4.ident());
    if (loc.uDynamic) gl.uniform1f(loc.uDynamic, 0);
    gl.drawArrays(gl.TRIANGLES, 0, vao.count);
  }
  drawMoving(prog, list) {
    const gl = this.gl, { loc } = prog;
    gl.bindVertexArray(this.cube.vao);
    if (loc.uDynamic) gl.uniform1f(loc.uDynamic, 1);
    for (const d of list) {
      gl.uniformMatrix4fv(loc.uModel, false, d.model);
      if (loc.uFlatColor) gl.uniform3fv(loc.uFlatColor, d.color);
      if (loc.uEmissive) gl.uniform3fv(loc.uEmissive, d.emissive || [0, 0, 0]);
      if (loc.uDynMat) gl.uniform1i(loc.uDynMat, d.mat);
      if (loc.uDynSize) gl.uniform3fv(loc.uDynSize, d.size);
      gl.drawArrays(gl.TRIANGLES, 0, this.cube.count);
    }
  }
  // the boxes and parts drawn as boxes: in the boxes view every one, in the painted view the ones with no form
  drawScene(prog, f) {
    this.drawStill(prog, f.mode === 0);
    this.drawMoving(prog, f.mode === 0 || !this.progs.shape ? f.dynamics : f.dynamics.filter((d) => !d.form));
  }
  // f: { mode, t, eye, view, proj, beaconLight[15], beaconGlow[15], dynamics[{model,color,emissive,mat,size}], occluders[[x,y,z,r]], time }
  frame(f) {
    const gl = this.gl;
    f.viewProj = m4.mul(f.proj, f.view);
    f.shapes = this.progs.shape && f.mode >= 1 ? this.movingShapes(f.dynamics) || [] : null;
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    // 1. the sun's shadow map
    f.shadowOn = f.mode > 0 && f.sunIrr[0] + f.sunIrr[1] + f.sunIrr[2] > 1e-4;
    if (f.shadowOn) {
      f.sunMat = this.sunMatrix(f.sunDir);
      const S = this.shadowSize, sd = f.sunDir;
      const traceInto = (still, moving) => {
        const P = this.progs.traceShadow;
        gl.useProgram(P.p);
        gl.uniformMatrix4fv(P.loc.uViewProj, false, f.sunMat); gl.uniform3fv(P.loc.uRayDir, sd.map((x) => -x));
        this.traceShapes(P, still, moving);
      };
      gl.viewport(0, 0, S, S);
      gl.cullFace(gl.FRONT);
      if (f.shapes) {
        // the still world: again only when the sun has moved a tenth of a degree
        const old = this.stillShadowSun;
        if (!old || old[0] * sd[0] + old[1] * sd[1] + old[2] * sd[2] < 0.9999985) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.stillShadowFb);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.useProgram(this.depth.p);
          gl.uniformMatrix4fv(this.depth.loc.uViewProj, false, f.sunMat);
          this.drawStill(this.depth);
          traceInto(true, false);
          this.stillShadowSun = sd.slice();
        }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.stillShadowFb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.shadowFb);
        gl.blitFramebuffer(0, 0, S, S, 0, 0, S, S, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
        gl.useProgram(this.depth.p);
        gl.uniformMatrix4fv(this.depth.loc.uViewProj, false, f.sunMat);
        this.drawMoving(this.depth, f.dynamics.filter((d) => !d.form));
        traceInto(false, true);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.useProgram(this.depth.p);
        gl.uniformMatrix4fv(this.depth.loc.uViewProj, false, f.sunMat);
        this.drawScene(this.depth, f);
      }
      gl.cullFace(gl.BACK);
    } else f.sunMat = m4.ident();
    // 1b. the painter repaints every surface's light into the atlas
    if (f.mode >= 1 && this.useAtlas) {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlas.fb);
      gl.viewport(0, 0, this.atlas.w, this.atlas.h);
      gl.useProgram(this.light.p);
      this.painters.light.bind(this.light.p);
      gl.uniform2f(this.light.loc.uAtlasSize, this.atlas.w, this.atlas.h);
      gl.uniform1f(this.light.loc.uT, f.t);
      gl.uniform3fv(this.light.loc.uBeaconLight, f.beaconLight);
      gl.uniform1f(this.light.loc.uRGBM, this.atlas.rgbm ? 1 : 0);
      gl.bindVertexArray(this.lightVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.lightCount);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    }
    // 1c. the shapes' trace: the nearest shaped box at each pixel, and its depth
    if (f.shapes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shapeT.fb);
      gl.viewport(0, 0, this.w, this.h);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.depthFunc(gl.LESS); gl.cullFace(gl.FRONT);
      const P = this.progs.trace;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.loc.uViewProj, false, f.viewProj); gl.uniform3fv(P.loc.uEye, f.eye);
      this.traceShapes(P);
      gl.cullFace(gl.BACK);
      // 1d. the shapes' geometry at those hits, once a pixel
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.geomT.fb);
      gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.depthFunc(gl.ALWAYS); gl.disable(gl.CULL_FACE);
      const G = this.progs.shapeGeom;
      gl.useProgram(G.p);
      this.painters.shape.bind(G.p);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shapeT.id); gl.uniform1i(G.loc.uSId, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.shapeT.depth); gl.uniform1i(G.loc.uSDepth, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.instTex); gl.uniform1i(G.loc.uInst, 3);
      gl.uniformMatrix4fv(G.loc.uInvViewProj, false, m4.invert(f.viewProj)); gl.uniformMatrix4fv(G.loc.uViewProj, false, f.viewProj);
      gl.uniform2f(G.loc.uRes, this.w, this.h); gl.uniform3fv(G.loc.uEye, f.eye);
      gl.bindVertexArray(this.emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthFunc(gl.LESS); gl.enable(gl.CULL_FACE);
    }
    // 2. depth first, so the frame is shaded once a pixel
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaa.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.useProgram(this.depth.p);
    gl.uniformMatrix4fv(this.depth.loc.uViewProj, false, f.viewProj);
    gl.depthFunc(gl.LESS);
    this.drawScene(this.depth, f);
    gl.colorMask(true, true, true, true);
    // 3. the frame
    gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    if (f.mode === 0) { this.setMain(this.progs.boxes, f); this.drawScene(this.progs.boxes, f); }
    else {
      this.setMain(this.progs.still, f); this.drawStill(this.progs.still);
      const plain = f.shapes ? f.dynamics.filter((d) => !d.form) : f.dynamics;
      if (plain.length) { this.setMain(this.progs.moving, f); this.drawMoving(this.progs.moving, plain); }
      if (f.shapes) {
        // the shapes, painted once a pixel at the trace's hits (their depth is the traced surface's)
        const P = this.progs.shape;
        gl.depthMask(true); gl.depthFunc(gl.LESS);
        this.setMain(P, f);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shapeT.id); gl.uniform1i(P.loc.uSId, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.geomT.col); gl.uniform1i(P.loc.uGeom, 2);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.instTex); gl.uniform1i(P.loc.uInst, 3);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.geomT.depth); gl.uniform1i(P.loc.uGDepth, 0);
        gl.uniformMatrix4fv(P.loc.uInvViewProj, false, m4.invert(f.viewProj)); gl.uniform2f(P.loc.uRes, this.w, this.h);
        gl.bindVertexArray(this.emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
      }
    }
    // 4. the sky where nothing was drawn
    gl.useProgram(this.sky.p);
    this.painters.sky.bind(this.sky.p);
    gl.uniformMatrix4fv(this.sky.loc.uInvViewProj, false, m4.invert(f.viewProj));
    gl.uniform3fv(this.sky.loc.uEye, f.eye); gl.uniform1f(this.sky.loc.uT, f.t); gl.uniform1i(this.sky.loc.uMode, f.mode);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    // 5. resolve, glow, out
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolve.fb);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    const pass = (prog, dst, src, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
      gl.viewport(0, 0, dst ? dst.w : this.w, dst ? dst.h : this.h);
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(prog.loc.uSrc ?? prog.loc.uScene, 0);
      if (setup) setup(prog.loc);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const bloom = f.mode === 0 ? 0 : 1;
    if (bloom) {
      pass(this.bright, this.b1a, this.resolve);
      pass(this.blur, this.b1b, this.b1a, (l) => gl.uniform2f(l.uDir, 1 / this.b1a.w, 0));
      pass(this.blur, this.b1a, this.b1b, (l) => gl.uniform2f(l.uDir, 0, 1 / this.b1a.h));
      pass(this.blur, this.b2a, this.b1a, (l) => gl.uniform2f(l.uDir, 1 / this.b2a.w, 0));
      pass(this.blur, this.b2b, this.b2a, (l) => gl.uniform2f(l.uDir, 0, 1 / this.b2a.h));
    }
    pass(this.compose, null, this.resolve, (l) => {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.b1a.tex); gl.uniform1i(l.uB1, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.b2b.tex); gl.uniform1i(l.uB2, 2);
      gl.uniform1f(l.uBloom, bloom);
    });
  }
}
