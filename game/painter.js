// The painter at run time: a feature grid in two 3D textures plus a tiny network in one uniform block, read by the fragment shader.
// It answers, for any point and normal at any time of day: the light from the sky (with the sun's bounces) and from each beacon.

export async function loadPainter(gl, url) {
  const buf = await (await fetch(url)).arrayBuffer();
  return painterFrom(gl, buf);
}

export function painterFrom(gl, buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'LPT1') throw new Error('not a painter file');
  const hlen = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  let off = 8 + hlen; off += (4 - (off % 4)) % 4;
  const [nx, ny, nz] = head.n1, [mx, my, mz] = head.n0;
  const c1 = nx * ny * nz, c0 = mx * my * mz;
  const halves = (count) => { const a = new Uint16Array(buf, off, count); off += count * 2; return a; };
  const g1a = halves(c1 * 4), g1b = halves(c1 * 4), g0 = halves(c0 * 4);
  const ubo = new Float32Array(buf, off, head.uboFloats);
  const tex3 = (w, h, d, data) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, w, h, d, 0, gl.RGBA, gl.HALF_FLOAT, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    return t;
  };
  const ub = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, ub);
  gl.bufferData(gl.UNIFORM_BUFFER, ubo, gl.STATIC_DRAW);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  return {
    head,
    tex: [tex3(nx, ny, nz, g1a), tex3(nx, ny, nz, g1b), tex3(mx, my, mz, g0)],
    ubo: ub,
    bytes: buf.byteLength,
    // binds the textures to units 4,5,6 and the block to binding 0 for program p
    bind(p) {
      const tex = this.tex;
      [4, 5, 6].forEach((unit, i) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_3D, tex[i]); });
      gl.uniform1i(gl.getUniformLocation(p, 'uPF1a'), 4);
      gl.uniform1i(gl.getUniformLocation(p, 'uPF1b'), 5);
      gl.uniform1i(gl.getUniformLocation(p, 'uPF0'), 6);
      const bi = gl.getUniformBlockIndex(p, 'Painter');
      if (bi !== gl.INVALID_INDEX) { gl.uniformBlockBinding(p, bi, 0); gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo); }
    },
  };
}

// The painter's GLSL. Inputs in the order the trainer used: fine features (8), coarse (4), normal (3), time (4), the beacons' unblocked light (5).
export function painterGLSL(head, crystals) {
  const v3 = (a) => `vec3(${a.map((x) => x.toFixed(4)).join(', ')})`;
  const ins = head.inputs / 4, hid = head.hidden / 4, outs = 5;
  return `
uniform highp sampler3D uPF1a;
uniform highp sampler3D uPF1b;
uniform highp sampler3D uPF0;
layout(std140) uniform Painter { mat4 PM1[${hid * ins}]; mat4 PM2[${hid * hid}]; mat4 PM3[${outs * hid}]; vec4 PB1[${hid}]; vec4 PB2[${hid}]; vec4 PB3[${outs}]; };
const vec3 P_MIN = ${v3(head.min)};
const vec3 P_N1 = ${v3(head.n1)};
const vec3 P_N0 = ${v3(head.n0)};
const float P_H1 = ${head.h1.toFixed(4)}, P_H0 = ${head.h0.toFixed(4)}, P_OFF = ${head.off.toFixed(4)};
const float S_SKY = ${head.sSky}, S_BEACON = ${head.sBeacon};
const vec3 CRYS_LO[5] = vec3[5](${crystals.map((c) => v3(c[0])).join(', ')});
const vec3 CRYS_HI[5] = vec3[5](${crystals.map((c) => v3(c[1])).join(', ')});
float beaconHint(vec3 P, vec3 N, int k) {
  vec3 lo = CRYS_LO[k], hi = CRYS_HI[k], s = hi - lo, w = (lo + hi) * 0.5 - P;
  float d2 = max(dot(w, w), 0.09);
  vec3 wn = w * inversesqrt(d2);
  float area = abs(wn.x) * s.y * s.z + abs(wn.z) * s.x * s.y + max(-wn.y, 0.0) * s.x * s.z;
  return log(1.0 + max(dot(N, wn), 0.0) * area / d2 / S_BEACON) / 8.0;
}
void paint(vec3 P, vec3 N, float t, out vec3 sky, out vec3 bk[5]) {
  vec3 q = P + N * P_OFF;
  vec3 c1 = ((q - P_MIN) / P_H1 + 0.5) / P_N1;
  vec3 c0 = ((q - P_MIN) / P_H0 + 0.5) / P_N0;
  vec4 x[${ins}];
  x[0] = texture(uPF1a, c1);
  x[1] = texture(uPF1b, c1);
  x[2] = texture(uPF0, c0);
  x[3] = vec4(N, 2.0 * t - 1.0);
  x[4] = vec4(sin(PI * t), cos(PI * t), cos(2.0 * PI * t), beaconHint(P, N, 0));
  x[5] = vec4(beaconHint(P, N, 1), beaconHint(P, N, 2), beaconHint(P, N, 3), beaconHint(P, N, 4));
  vec4 h1[${hid}], h2[${hid}], z[${outs}];
  for (int o = 0; o < ${hid}; o++) { vec4 a = PB1[o]; for (int i = 0; i < ${ins}; i++) a += PM1[o * ${ins} + i] * x[i]; h1[o] = max(a, 0.0); }
  for (int o = 0; o < ${hid}; o++) { vec4 a = PB2[o]; for (int i = 0; i < ${hid}; i++) a += PM2[o * ${hid} + i] * h1[i]; h2[o] = max(a, 0.0); }
  for (int o = 0; o < ${outs}; o++) { vec4 a = PB3[o]; for (int i = 0; i < ${hid}; i++) a += PM3[o * ${hid} + i] * h2[i]; z[o] = a; }
  sky = max(S_SKY * (exp(z[0].xyz) - 1.0), 0.0);
  bk[0] = max(S_BEACON * (exp(vec3(z[0].w, z[1].x, z[1].y)) - 1.0), 0.0);
  bk[1] = max(S_BEACON * (exp(vec3(z[1].z, z[1].w, z[2].x)) - 1.0), 0.0);
  bk[2] = max(S_BEACON * (exp(z[2].yzw) - 1.0), 0.0);
  bk[3] = max(S_BEACON * (exp(z[3].xyz) - 1.0), 0.0);
  bk[4] = max(S_BEACON * (exp(vec3(z[3].w, z[4].x, z[4].y)) - 1.0), 0.0);
}
`;
}

// ---- the surface painter: a tiled feature texture per material, a half-metre grid of the world's own wear, and a tiny network ----
// It answers, for a point of a face: how that point takes the light painter's light (wInd), the sun (wSun) and its own glow (wEm).
export function surfaceFrom(gl, buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'LPS1') throw new Error('not a surface painter file');
  const hlen = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  let off = 8 + hlen; off += (4 - (off % 4)) % 4;
  const { R, layers } = head, [nx, ny, nz] = head.n1;
  const take = (count) => { const a = new Uint8Array(buf, off, count); off += count; return a; };
  const lat0 = take(layers * R * R * 4), lat1 = take(layers * R * R * 4), grid = take(nx * ny * nz * 4);
  off += (4 - (off % 4)) % 4;
  const ubo = new Float32Array(buf, off, head.uboFloats);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const array = (data) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, R, R, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  };
  const g = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, g);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, nx, ny, nz, 0, gl.RGBA, gl.UNSIGNED_BYTE, grid);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
  const ub = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, ub); gl.bufferData(gl.UNIFORM_BUFFER, ubo, gl.STATIC_DRAW); gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  return {
    head, tex: [array(lat0), array(lat1), g], ubo: ub, bytes: buf.byteLength,
    // units 9, 10 (the material textures), 11 (the wear grid); block binding 1
    bind(p) {
      gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex[0]);
      gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex[1]);
      gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_3D, this.tex[2]);
      gl.uniform1i(gl.getUniformLocation(p, 'uSL0'), 9); gl.uniform1i(gl.getUniformLocation(p, 'uSL1'), 10); gl.uniform1i(gl.getUniformLocation(p, 'uSG'), 11);
      const bi = gl.getUniformBlockIndex(p, 'Surface');
      if (bi !== gl.INVALID_INDEX) { gl.uniformBlockBinding(p, bi, 1); gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this.ubo); }
    },
  };
}

// Its GLSL (after painterGLSL, whose grid constants it shares). Inputs in the trainer's order: the material's 8 features, the face's
// edges (4), the sun's direction in the face's frame (3), which way the face looks up (1), the wear grid's 4 features.
export function surfaceGLSL(head) {
  const v4 = (a) => `vec4(${a.map((x) => x.toPrecision(7)).join(', ')})`;
  const ins = head.inputs / 4, hid = head.hidden / 4, outs = 3;
  // the file's scales are per step of 255; a texture hands the shader its bytes as 0..1
  const k255 = (a) => a.map((x) => x * 255);
  const [s0, s1] = [k255(head.latScale.slice(0, 4)), k255(head.latScale.slice(4, 8))], [o0, o1] = [head.latOffset.slice(0, 4), head.latOffset.slice(4, 8)];
  return `
uniform highp sampler2DArray uSL0;
uniform highp sampler2DArray uSL1;
uniform highp sampler3D uSG;
layout(std140) uniform Surface { mat4 SM1[${hid * ins}]; mat4 SM2[${hid * hid}]; mat4 SM3[${outs * hid}]; vec4 SB1[${hid}]; vec4 SB2[${hid}]; vec4 SB3[${outs}]; };
const vec4 SL_S0 = ${v4(s0)}, SL_O0 = ${v4(o0)}, SL_S1 = ${v4(s1)}, SL_O1 = ${v4(o1)};
const vec4 SG_S = ${v4(k255(head.gsScale))}, SG_O = ${v4(head.gsOffset)};
vec3 softplus3(vec3 z) { return max(z, 0.0) + log(1.0 + exp(-abs(z))); }
// how each material looks from far away (bake/far_response.py): a surface whose pattern is smaller than a pixel blends toward it
${(() => { const far = head.far || []; const n = head.layers; const f3 = (w, k) => `vec3(${w.slice(k, k + 3).map((x) => x.toPrecision(5)).join(', ')})`;
  const pick = (k) => far.length === n ? far.map((w) => f3(w, k)).join(', ') : new Array(n).fill('vec3(0.0)').join(', ');
  return `const float HAS_FAR = ${far.length === n ? '1.0' : '0.0'};
const vec3 FAR_IND[${n}] = vec3[${n}](${pick(0)});
const vec3 FAR_SUN[${n}] = vec3[${n}](${pick(3)});
const vec3 FAR_EM[${n}] = vec3[${n}](${pick(6)});`; })()}
// m: material; uv: its pattern coordinates (matUV); ef: edgeFeatures; ltan: the sun in the face's frame (T, B, N); ny: the face's N.y;
// q: the point lifted off the face (P + N * P_OFF), where the wear grid is read, blended toward q2 by k2 (beyond the painters' volume
// the field's wear is the open field's, not the edge stretched outward); grid 0 for a thing that moves (it has no wear); extra: how
// tucked in a shaped surface is there, and 1 on a shaped surface (a box's face: 0, 0)
void surfacePaint(int m, vec2 uv, vec4 ef, vec3 ltan, float ny, vec3 q, vec3 q2, float k2, float grid, vec4 extra, out vec3 wInd, out vec3 wSun, out vec3 wEm) {
  vec3 tc = vec3(uv / MAT_UV[m].yz, float(m));
  vec4 x[${ins}];
  x[0] = texture(uSL0, tc) * SL_S0 + SL_O0;
  x[1] = texture(uSL1, tc) * SL_S1 + SL_O1;
  x[2] = ef;
  x[3] = vec4(ltan, ny);
  vec4 g = texture(uSG, ((q - P_MIN) / P_H1 + 0.5) / P_N1);
  if (k2 > 0.0) g = mix(g, texture(uSG, ((q2 - P_MIN) / P_H1 + 0.5) / P_N1), k2);
  x[4] = grid > 0.5 ? g * SG_S + SG_O : vec4(0.0);
${ins > 5 ? '  x[5] = extra;' : '  // (this surface painter was taught on box faces only: it reads no extra)'}
  vec4 h1[${hid}], h2[${hid}], z[${outs}];
  for (int o = 0; o < ${hid}; o++) { vec4 a = SB1[o]; for (int i = 0; i < ${ins}; i++) a += SM1[o * ${ins} + i] * x[i]; h1[o] = max(a, 0.0); }
  for (int o = 0; o < ${hid}; o++) { vec4 a = SB2[o]; for (int i = 0; i < ${hid}; i++) a += SM2[o * ${hid} + i] * h1[i]; h2[o] = max(a, 0.0); }
  for (int o = 0; o < ${outs}; o++) { vec4 a = SB3[o]; for (int i = 0; i < ${hid}; i++) a += SM3[o * ${hid} + i] * h2[i]; z[o] = a; }
  wInd = softplus3(z[0].xyz) * ${head.outScale[0].toFixed(4)};
  wSun = softplus3(vec3(z[0].w, z[1].xy)) * ${head.outScale[3].toFixed(4)};
  wEm = softplus3(vec3(z[1].zw, z[2].x)) * ${head.outScale[6].toFixed(4)};
  // far away (many texels to a pixel, along the steepest direction) the material's own average look
  vec2 tx = tc.xy * ${head.R.toFixed(1)}, ddx = dFdx(tx), ddy = dFdy(tx);
  float lod = 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 1e-8));
  float kf = HAS_FAR * smoothstep(1.5, 3.5, lod);
  wInd = mix(wInd, FAR_IND[m], kf); wSun = mix(wSun, FAR_SUN[m], kf); wEm = mix(wEm, FAR_EM[m], kf);
}
`;
}

// ---- the sky painter: a tiled feature texture over the cloud deck and a tiny network ----
export function skyFrom(gl, buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'LPK1') throw new Error('not a sky painter file');
  const hlen = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  let off = 8 + hlen; off += (4 - (off % 4)) % 4;
  const R = head.R, lat = new Uint8Array(buf, off, R * R * 4); off += R * R * 4;
  const ubo = new Float32Array(buf, off, head.uboFloats);
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, R, R, 0, gl.RGBA, gl.UNSIGNED_BYTE, lat);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const ub = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, ub); gl.bufferData(gl.UNIFORM_BUFFER, ubo, gl.STATIC_DRAW); gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  return {
    head, tex: t, ubo: ub, bytes: buf.byteLength,
    // unit 12; block binding 2
    bind(p) {
      gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(gl.getUniformLocation(p, 'uKL'), 12);
      const bi = gl.getUniformBlockIndex(p, 'Sky');
      if (bi !== gl.INVALID_INDEX) { gl.uniformBlockBinding(p, bi, 2); gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, this.ubo); }
    },
  };
}
export function skyGLSL(head) {
  const v4 = (a) => `vec4(${a.map((x) => x.toPrecision(7)).join(', ')})`;
  const ins = head.inputs / 4, hid = head.hidden / 4;
  return `
uniform highp sampler2D uKL;
layout(std140) uniform Sky { mat4 KM1[${hid * ins}]; mat4 KM2[${hid * hid}]; mat4 KM3[${hid}]; vec4 KB1[${hid}]; vec4 KB2[${hid}]; vec4 KB3[1]; };
const vec4 KL_S = ${v4(head.latScale.map((x) => x * 255))}, KL_O = ${v4(head.latOffset)};   // (per step of 255; the texture gives 0..1)
// the sky's radiance in direction d at time t, painted from the cloud deck's features and the code's facts (stars, the sun's disk)
vec3 skyPaint(vec3 d, float t) {
  vec3 s = sunDir(t);
  float c = dot(d, s);
  vec2 hd = d.xz / (length(d.xz) + 1e-5), hs = normalize(s.xz);
  vec4 x[${ins}];
  // the deck's features (truth.js cloudUV); down at the horizon, where the deck has faded out, its own average (its smallest mip),
  // so the band there never reads one column of the deck per column of the screen
  x[0] = mix(textureLod(uKL, vec2(0.5), 16.0), texture(uKL, d.xz / (max(d.y, 0.0) + 0.05) * 0.12), smoothstep(0.03, 0.08, d.y)) * KL_S + KL_O;
  x[1] = vec4(d.y, c, clamp(-log(max(1.0 - c, 0.0) + 1e-5) / 11.5, 0.0, 1.0), dot(hd, hs));
  x[2] = vec4(2.0 * t - 1.0, sin(PI * t), cos(PI * t), cos(2.0 * PI * t));
  x[3] = vec4(starMask(d), sunDisk(d, t), pow(max(d.y, 0.0), 0.42), 0.0);
  vec4 h1[${hid}], h2[${hid}];
  for (int o = 0; o < ${hid}; o++) { vec4 a = KB1[o]; for (int i = 0; i < ${ins}; i++) a += KM1[o * ${ins} + i] * x[i]; h1[o] = max(a, 0.0); }
  for (int o = 0; o < ${hid}; o++) { vec4 a = KB2[o]; for (int i = 0; i < ${hid}; i++) a += KM2[o * ${hid} + i] * h1[i]; h2[o] = max(a, 0.0); }
  vec4 z = KB3[0]; for (int i = 0; i < ${hid}; i++) z += KM3[i] * h2[i];
  return ${head.knee.toFixed(4)} * (exp(min(z.xyz, 14.0)) - 1.0) / exposureAt(t);
}
`;
}

// ---- the shape painter: for every form, a grid of 8 learned features in the form's own frame, and one tiny network for them all.
// Feature 0 alone is a coarse distance the trace steps by; the network gives the surface itself. Every form's grid is packed into one
// pair of 3D textures (features 0-3, 4-7), so one shader reads any form. ----
export function shapeFrom(gl, buf) {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'LPG1') throw new Error('not a shape painter file');
  const hlen = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  let off = 8 + hlen; off += (4 - (off % 4)) % 4;
  const base = off, NF = head.forms.length;
  // each form's grid, stored with one more point along an axis that repeats (its first again), in layers of shelves 256 wide
  const vols = [];
  let end = base;
  head.forms.forEach((fm, f) => {
    if (!fm) return;
    const dims = fm.n.map((n, a) => n + (fm.wrap[a] ? 1 : 0));
    vols.push({ fm, f, dims });
    end = Math.max(end, base + fm.at + fm.n[0] * fm.n[1] * fm.n[2] * 8);
  });
  const W = 256, layers = [];
  for (const v of [...vols].sort((a, b) => b.dims[2] - a.dims[2])) {
    let placed = false;
    for (const L of layers) {
      if (v.dims[2] > L.depth) continue;
      if (L.x + v.dims[0] <= W && v.dims[1] <= L.shelf + 0) { v.o = [L.x, L.y, L.z]; L.x += v.dims[0]; placed = true; break; }
      if (L.y + L.shelf + v.dims[1] <= 256 && v.dims[0] <= W) { L.y += L.shelf; L.x = v.dims[0]; L.shelf = v.dims[1]; v.o = [0, L.y, L.z]; placed = true; break; }
    }
    if (!placed) { const z = layers.reduce((s2, L) => s2 + L.depth, 0); layers.push({ z, depth: v.dims[2], x: v.dims[0], y: 0, shelf: v.dims[1] }); v.o = [0, 0, z]; }
  }
  const AW = W, AH = Math.max(...vols.map((v) => v.o[1] + v.dims[1])), AD = layers.reduce((s2, L) => s2 + L.depth, 0);
  const A = new Uint8Array(AW * AH * AD * 4), Bt = new Uint8Array(AW * AH * AD * 4);
  const table = new Float32Array(NF * 8 * 4);
  for (const v of vols) {
    const { fm } = v, [nx, ny, nz] = fm.n, cells = nx * ny * nz, a = base + fm.at;
    const srcA = new Uint8Array(buf, a, cells * 4), srcB = new Uint8Array(buf, a + cells * 4, cells * 4);
    for (let z = 0; z < v.dims[2]; z++) for (let y = 0; y < v.dims[1]; y++) for (let x = 0; x < v.dims[0]; x++) {
      const sx = x % nx, sy = y % ny, sz = z % nz, si = ((sz * ny + sy) * nx + sx) * 4;
      const di = (((v.o[2] + z) * AH + v.o[1] + y) * AW + v.o[0] + x) * 4;
      for (let k = 0; k < 4; k++) { A[di + k] = srcA[si + k]; Bt[di + k] = srcB[si + k]; }
    }
    const wrapBits = (fm.wrap[0] ? 1 : 0) + (fm.wrap[1] ? 2 : 0) + (fm.wrap[2] ? 4 : 0);
    // (the file's scales are per step of 255; a texture hands the shader its bytes as 0..1)
    table.set([...v.o, wrapBits, ...fm.n, 0, ...fm.lo, 0, ...fm.sp, 0, ...fm.scale.slice(0, 4).map((x) => x * 255), ...fm.offset.slice(0, 4), ...fm.scale.slice(4, 8).map((x) => x * 255), ...fm.offset.slice(4, 8)], v.f * 32);
  }
  const tex = (data) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, AW, AH, AD, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    return t;
  };
  off = end; off += (4 - (off % 4)) % 4;
  const ubo = new Float32Array(buf, off, head.uboFloats);
  const ub = gl.createBuffer(), tb = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, ub); gl.bufferData(gl.UNIFORM_BUFFER, ubo, gl.STATIC_DRAW);
  gl.bindBuffer(gl.UNIFORM_BUFFER, tb); gl.bufferData(gl.UNIFORM_BUFFER, table, gl.STATIC_DRAW);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  return {
    head, size: [AW, AH, AD], tex: [tex(A), tex(Bt)], ubo: ub, table: tb, bytes: buf.byteLength,
    // the grids to units 13 and 14, the network to block binding 3, the forms' table to 4, for program p
    bind(p) {
      gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_3D, this.tex[0]);
      gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_3D, this.tex[1]);
      gl.uniform1i(gl.getUniformLocation(p, 'uGA'), 13); gl.uniform1i(gl.getUniformLocation(p, 'uGB'), 14);
      gl.uniform3fv(gl.getUniformLocation(p, 'uGSize'), this.size);
      const bi = gl.getUniformBlockIndex(p, 'Shape');
      if (bi !== gl.INVALID_INDEX) { gl.uniformBlockBinding(p, bi, 3); gl.bindBufferBase(gl.UNIFORM_BUFFER, 3, this.ubo); }
      const ti = gl.getUniformBlockIndex(p, 'ShapeForms');
      if (ti !== gl.INVALID_INDEX) { gl.uniformBlockBinding(p, ti, 4); gl.bindBufferBase(gl.UNIFORM_BUFFER, 4, this.table); }
    },
  };
}

// Its GLSL (after GLSL_COMMON, whose formCanon it reads a box through). f: the form; x: a point in the box's own axes, from its centre;
// h: the box's half sizes there.
export function shapeGLSL(head) {
  const hid = head.hidden / 4, ins = head.inputs / 4, NF = head.forms.length;
  return `
uniform highp sampler3D uGA;
uniform highp sampler3D uGB;
uniform vec3 uGSize;
layout(std140) uniform Shape { mat4 GM1[${hid * ins}]; mat4 GM2[${hid * hid}]; mat4 GM3[${hid}]; vec4 GB1[${hid}]; vec4 GB2[${hid}]; vec4 GB3[1]; };
// per form: where its grid starts in the textures (and which axes repeat), its points, its first point and spacing in its frame, the
// two textures' scales and offsets
layout(std140) uniform ShapeForms { vec4 SF[${NF * 8}]; };
vec3 shapeTC(int f, vec3 c) {
  vec4 o = SF[f * 8], n = SF[f * 8 + 1];
  vec3 g = (c - SF[f * 8 + 2].xyz) / SF[f * 8 + 3].xyz;
  float wb = o.w;
  g.x = mod(wb, 2.0) > 0.5 ? mod(g.x, n.x) : clamp(g.x, 0.0, n.x - 1.0);
  g.y = mod(floor(wb / 2.0), 2.0) > 0.5 ? mod(g.y, n.y) : clamp(g.y, 0.0, n.y - 1.0);
  g.z = wb > 3.5 ? mod(g.z, n.z) : clamp(g.z, 0.0, n.z - 1.0);
  return (o.xyz + g + 0.5) / uGSize;
}
// the coarse distance (feature 0): never longer than the real one
float shapeCoarse(int f, vec3 x, vec3 h) { float k; vec3 c = formCanon(f, x, h, k); return (texture(uGA, shapeTC(f, c)).r * SF[f * 8 + 4].r + SF[f * 8 + 5].r) * k; }
// the network's distance: the surface itself
float shapeFine(int f, vec3 x, vec3 h) {
  float k; vec3 c = formCanon(f, x, h, k);
  vec3 tc = shapeTC(f, c);
  vec4 q[${ins}];
  q[0] = texture(uGA, tc) * SF[f * 8 + 4] + SF[f * 8 + 5];
  q[1] = texture(uGB, tc) * SF[f * 8 + 6] + SF[f * 8 + 7];
  vec4 h1[${hid}], h2[${hid}];
  for (int o = 0; o < ${hid}; o++) { vec4 a = GB1[o]; for (int i = 0; i < ${ins}; i++) a += GM1[o * ${ins} + i] * q[i]; h1[o] = max(a, 0.0); }
  for (int o = 0; o < ${hid}; o++) { vec4 a = GB2[o]; for (int i = 0; i < ${hid}; i++) a += GM2[o * ${hid} + i] * h1[i]; h2[o] = max(a, 0.0); }
  vec4 z = GB3[0]; for (int i = 0; i < ${hid}; i++) z += GM3[i] * h2[i];
  return z.x * ${head.outScale.toFixed(4)} * k;
}
// the normal by forward differences, d0 the distance at x already in hand (three more of the network instead of four)
vec3 shapeNormalAt(int f, vec3 x, vec3 h, float d0) {
  const float e = 8e-3;   // (the network is good to half a millimetre: differences over less than a centimetre would be its noise)
  return normalize(vec3(shapeFine(f, x + vec3(e, 0.0, 0.0), h), shapeFine(f, x + vec3(0.0, e, 0.0), h), shapeFine(f, x + vec3(0.0, 0.0, e), h)) - d0);
}
vec3 shapeNormal(int f, vec3 x, vec3 h) {
  const vec2 e = vec2(1.0, -1.0) * 8e-3;
  return normalize(e.xyy * shapeFine(f, x + e.xyy, h) + e.yyx * shapeFine(f, x + e.yyx, h) + e.yxy * shapeFine(f, x + e.yxy, h) + e.xxx * shapeFine(f, x + e.xxx, h));
}
// how tucked in a point of the shape is (the surface painter's cue), off the coarse distance at three heights over it
float shapeAO(int f, vec3 x, vec3 h, vec3 n) {
  float a = 0.5 * (0.03 - shapeCoarse(f, x + n * 0.03, h)) / 0.03 + 0.3 * (0.09 - shapeCoarse(f, x + n * 0.09, h)) / 0.09 + 0.2 * (0.25 - shapeCoarse(f, x + n * 0.25, h)) / 0.25;
  return clamp(a, 0.0, 1.0);
}
// a ray (ro, rd, in the box's axes) through its shell lo..hi: where it meets the shape (x), and the shell's face normal when that is
// where (n; else zero). Steps by the coarse distance until it is near, then lets the network place the surface.
bool shapeTrace(int f, vec3 ro, vec3 rd, vec3 lo, vec3 hi, vec3 h, out vec3 x, out vec3 n) {
  n = vec3(0.0);
  vec3 inv = 1.0 / (sign(rd) * max(abs(rd), vec3(1e-7)));
  vec3 ta = (lo - ro) * inv, tb = (hi - ro) * inv, mn = min(ta, tb), mx = max(ta, tb);
  float t0 = max(max(mn.x, mn.y), mn.z), t1 = min(min(mx.x, mx.y), mx.z);
  if (t1 <= max(t0, 0.0)) return false;
  float t = max(t0, 0.0);
  float d = shapeCoarse(f, ro + rd * t, h);
  if (d < 0.0 && t0 > 0.0) {
    // solid where it enters the shell (the network says so too): the shell's own face
    x = ro + rd * t;
    float df = shapeFine(f, x, h);
    if (df < 0.0) { n = t0 == mn.x ? vec3(-sign(rd.x), 0, 0) : (t0 == mn.y ? vec3(0, -sign(rd.y), 0) : vec3(0, 0, -sign(rd.z))); return true; }
    d = df;
  }
  for (int i = 0; i < 72; i++) {
    if (d < 0.006) break;
    t += d * 0.9;
    if (t > t1) return false;
    d = shapeCoarse(f, ro + rd * t, h);
  }
  // one step by the network places the surface (the coarse distance had it within 6 mm); a step that would move it far says the
  // coarse distance was wrong there, and there is no surface
  float df = shapeFine(f, ro + rd * t, h);
  t += df;
  if (abs(df) > 0.012 || t > t1 + 1e-3 || t < 0.0) return false;
  x = ro + rd * t;
  return true;
}
// the same on the coarse distance alone (to a centimetre): the trace pass and the sun's shadow map (the paint pass lets the network
// place the surface, once a pixel). fn: the shell's own face normal where the shape is solid at the shell's face, else zero
bool shapeTraceCoarse(int f, vec3 ro, vec3 rd, vec3 lo, vec3 hi, vec3 h, out vec3 x, out vec3 fn) {
  fn = vec3(0.0);
  vec3 inv = 1.0 / (sign(rd) * max(abs(rd), vec3(1e-7)));
  vec3 ta = (lo - ro) * inv, tb = (hi - ro) * inv, mn = min(ta, tb), mx = max(ta, tb);
  float t0 = max(max(mn.x, mn.y), mn.z), t1 = min(min(mx.x, mx.y), mx.z);
  if (t1 <= max(t0, 0.0)) return false;
  float t = max(t0, 0.0);
  float d = shapeCoarse(f, ro + rd * t, h);
  if (d < 0.0) {
    if (t0 <= 0.0) return false;   // (the eye is inside the shape)
    x = ro + rd * t; fn = t0 == mn.x ? vec3(-sign(rd.x), 0, 0) : (t0 == mn.y ? vec3(0, -sign(rd.y), 0) : vec3(0, 0, -sign(rd.z)));
    return true;
  }
  for (int i = 0; i < 48; i++) {
    if (d < 0.01) { x = ro + rd * t; return true; }
    t += d * 0.9;
    if (t > t1) return false;
    d = shapeCoarse(f, ro + rd * t, h);
  }
  return false;
}
`;
}
