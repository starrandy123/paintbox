# Fits the surface painter: what every point of the detailed world looks like, painted from what the code knows about the boxes.
#   - a tiled feature texture per material (8 features, 256 x 256 over the material's tile): the stone, the joints, the grain, the runes
#   - a half-metre grid of 4 features over the world: the world's own wear (damp, moss, rain marks) and what the light painter misses
#   - a 20 -> 16 -> 16 -> 9 network: from those features, the face's edges and the sun's direction, how the point answers each light:
#       colour = wInd * (the light painter's light) + wSun * (the sun, where the code's shadow map lets it through) + wEm * (its glow)
# Plain numpy; run with Blender's bundled Python:
#   /Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13 -I bake/train_surface.py [steps]
# Reads data/surf_*.f32 (bake/run.mjs surface), data/boxes.json (bake/run.mjs boxes), data/painter_params.npz (bake/train.py);
# writes game/surface.bin and data/surface_report.json.
import json, math, os, struct, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
import train as light   # the light painter: its grid reader, its network, its decoder
_pp = np.load(os.path.join(ROOT, 'data', 'painter_params.npz'))
light.P.update({k: _pp[k] for k in _pp.files})   # the trained one, as shipped in painter.bin

WORLD = json.load(open(os.path.join(ROOT, 'data', 'boxes.json')))
GRID = light.GRID
STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
BATCH = 65536
R, F, FG, H, NIN, NOUT, NOUT_PAD = 256, 8, 4, 16, 20, 9, 12
WS = np.array([0.1] * 3 + [0.1] * 3 + [1.0] * 3, np.float32)   # the outputs' scales: light taken in, sun taken in, glow
KNEE = 0.02                                                     # the loss is on log(1 + radiance x exposure / KNEE)
BEACON_POWER, GLOW_LIT = 9.0, 0.3
rng = np.random.default_rng(5)

BOX = WORLD['boxes']
BMIN = np.array([b['min'] for b in BOX], np.float32)
BMAX = np.array([b['max'] for b in BOX], np.float32)
BM = np.array([b['m'] for b in BOX], np.int64)
BGLOW = np.array([b['glow'] for b in BOX], np.int64)
BFL = np.array([b['flags'] for b in BOX], np.int64)
MUV = np.array([(m['uv'] + [0, 0, 0, 0])[:4] for m in WORLD['mats']], np.float32)   # mode, tile u, tile v, vTop
NMAT = len(WORLD['mats'])
COL = np.array([b['color'] for b in WORLD['beacons']], np.float32)
UA, VA = np.array([2, 0, 0]), np.array([1, 2, 1])               # faceUV's u and v axes for a face across x, y, z
TAX = np.array([[0, 0, 1], [1, 0, 0], [1, 0, 0]], np.float32)  # faceTB's T
BAX = np.array([[0, 1, 0], [0, 0, 1], [0, 1, 0]], np.float32)  # faceTB's B


def smoothstep(a, b, x):
    k = np.clip((x - a) / (b - a), 0.0, 1.0)
    return k * k * (3 - 2 * k)


def sun_dir(t):
    e = np.radians(30 - 50 * t)
    h = np.array([0.9, 0.0, 0.38]); h /= np.linalg.norm(h)
    return np.stack([h[0] * np.cos(e), np.sin(e), h[2] * np.cos(e)], 1).astype(np.float32)


def sun_irr(t):
    e = 30 - 50 * t
    w, vis, mag = smoothstep(2, 24, e), smoothstep(-0.5, 3.5, e), 1.7 + 1.5 * smoothstep(2, 20, e)
    return (np.stack([np.ones_like(e), 0.33 + 0.49 * w, 0.09 + 0.53 * w], 1) * (vis * mag)[:, None]).astype(np.float32)


def exposure(t):
    return (1 + 2.4 * smoothstep(0.45, 0.92, t)).astype(np.float32)


def geometry(p, n, bi):
    """what the game's shader knows at each point (world.js matUV / edgeFeatures / faceTB): material, pattern coordinates, edges, frame"""
    rows = np.arange(len(n))
    a = np.argmax(np.abs(n), 1)
    side = (n[rows, a] > 0).astype(np.int64)
    m = BM[bi]
    local = MUV[m, 0] > 0.5
    bmin, bmax = BMIN[bi], BMAX[bi]
    base = np.where(local[:, None], bmin, 0.0)
    ua, va = UA[a], VA[a]
    vtop = np.where(local & (a == 1), MUV[m, 3], 0.0)

    def uvof(q):
        qq = q - base
        return np.stack([qq[rows, ua], qq[rows, va] + vtop], 1).astype(np.float32)

    uv, lo, hi = uvof(p), uvof(bmin), uvof(bmax)
    face = a * 2 + side
    word = np.where(face < 3, BFL[bi, 0], BFL[bi, 1])
    byte = (word >> (8 * (face % 3))) & 255
    fl = np.stack([byte & 3, (byte >> 2) & 3, (byte >> 4) & 3, (byte >> 6) & 3], 1)
    d = np.stack([uv[:, 0] - lo[:, 0], hi[:, 0] - uv[:, 0], uv[:, 1] - lo[:, 1], hi[:, 1] - uv[:, 1]], 1)
    r6, r30, r50 = 1 - np.clip(d / 0.06, 0, 1), 1 - np.clip(d / 0.3, 0, 1), 1 - np.clip(d / 0.5, 0, 1)
    cx, cc = (fl == 1).astype(np.float32), (fl == 2).astype(np.float32)
    ef = np.stack([r6[:, 1] * cx[:, 1] - r6[:, 0] * cx[:, 0], r6[:, 3] * cx[:, 3] - r6[:, 2] * cx[:, 2], (r50 * cc).max(1), (r30 * cx).max(1)], 1)
    return m, uv, ef.astype(np.float32), TAX[a], BAX[a]


def lat_corners(m, uv):
    """bilinear corners in the material's tiled feature texture (REPEAT), texel centres at (i + 0.5) / R"""
    tile = MUV[m, 1:3]
    g = uv / tile * R - 0.5
    g0 = np.floor(g)
    f = (g - g0).astype(np.float32)
    i0 = np.mod(g0, R).astype(np.int64); i1 = np.mod(i0 + 1, R)
    base = m * R * R
    idx = np.stack([base + i0[:, 1] * R + i0[:, 0], base + i0[:, 1] * R + i1[:, 0], base + i1[:, 1] * R + i0[:, 0], base + i1[:, 1] * R + i1[:, 0]], 1)
    w = np.stack([(1 - f[:, 0]) * (1 - f[:, 1]), f[:, 0] * (1 - f[:, 1]), (1 - f[:, 0]) * f[:, 1], f[:, 0] * f[:, 1]], 1)
    return idx, w


def load(tag):
    x = np.fromfile(os.path.join(ROOT, 'data', f'surf_{tag}_x.f32'), dtype=np.float32)
    y = np.fromfile(os.path.join(ROOT, 'data', f'surf_{tag}_y.f32'), dtype=np.float32)
    n = y.size // 23
    pos4, nrm4 = x[: n * 4].reshape(n, 4), x[n * 4:].reshape(n, 4)
    return pos4[:, :3].copy(), nrm4[:, :3].copy(), pos4[:, 3].copy(), nrm4[:, 3].astype(np.int64), y.reshape(n, 23)


def light_predict(p, n, t):
    """the light painter's answer at each point (what the game's light atlas holds there): sky (3) and each beacon (5 x 3)"""
    out = np.empty((len(p), 18), np.float32)
    for s in range(0, len(p), 262144):
        e = slice(s, s + 262144)
        out[e] = light.decode(light.forward(light.prep(p[e], n[e], t[e])))
    return out


class Set:
    def __init__(self, tags):
        parts = [load(tg) for tg in tags]
        self.p, self.n, self.t, self.bi, y = [np.concatenate([q[i] for q in parts]) for i in range(5)]
        self.N = len(self.p)
        self.sky, self.sun, self.vis, self.em = y[:, 0:3].copy(), y[:, 3:6].copy(), y[:, 6].copy(), y[:, 7].copy()
        self.bk = y[:, 8:23].reshape(-1, 5, 3).astype(np.float16)   # (half precision: four million points have to fit beside everything else)
        del y
        self.m, self.uv, self.ef, T, B = geometry(self.p, self.n, self.bi)
        sd = sun_dir(self.t)
        self.ltan = np.stack([(sd * T).sum(1), (sd * B).sum(1), (sd * self.n).sum(1)], 1).astype(np.float32)
        self.ny = self.n[:, 1:2].astype(np.float32)
        self.sunCV = (sun_irr(self.t) * self.vis[:, None]).astype(np.float32)
        self.X = exposure(self.t)
        self.glow = BGLOW[self.bi]
        t0 = time.time()
        lp = light_predict(self.p, self.n, self.t)
        self.Esky, self.Eb = lp[:, 0:3].copy(), lp[:, 3:18].reshape(-1, 5, 3).astype(np.float16)
        del lp
        print(f'  {self.N:,} points, light painter read in {time.time() - t0:.1f}s', flush=True)

    def lights(self, sel, r):
        """a random state of the beacons for each point: how much light each throws and how brightly the point's own crystal glows"""
        B = len(sel)
        u = r.random((B, 5))
        lvl = np.where(u < 0.45, 0.0, np.where(u < 0.8, 1.0, r.random((B, 5)))).astype(np.float32)
        BL = lvl[:, :, None] * BEACON_POWER * COL[None]
        E_in = self.Esky[sel] + (BL * self.Eb[sel].astype(np.float32)).sum(1)
        T_ind = self.sky[sel] + (BL * self.bk[sel].astype(np.float32)).sum(1)
        k = self.glow[sel]
        g = np.where(r.random(B) < 0.4, 2.4 + 0.6 * r.random(B), 5.0 * r.random(B)).astype(np.float32)
        glowRGB = np.where((k >= 0)[:, None], COL[np.maximum(k, 0)] * g[:, None] + 0.04, 0.0).astype(np.float32)
        target = T_ind + self.sun[sel] + self.em[sel][:, None] * glowRGB
        return E_in, glowRGB, target


# ---- what moving things are made of: the player's cloth and skin, a shade's smoke. Their truth is written here (the path tracer only
# has the still world); the light on them is the light painter's own, as the game gives it at every pixel ----
DYN_PARTS = {
    'cloth': [[0.2, 0.62, 0.22], [0.56, 0.68, 0.34], [0.6, 0.12, 0.38], [0.15, 0.56, 0.16], [0.26, 0.07, 0.02]],
    'skin': [[0.38, 0.38, 0.38]],
    'shade': [[0.75, 1.25, 0.75], [0.42, 0.4, 0.42], [0.13, 0.08, 0.03]],
}
SHADE_EYES = np.array([7.0, 0.9, 1.6], np.float32)


def nhash(ix, iy, seed):
    h = (ix.astype(np.int64) * 73856093) ^ (iy.astype(np.int64) * 19349663) ^ (seed * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def npnoise(p, per, seed):
    i = np.floor(p); f = p - i; f = f * f * (3 - 2 * f)
    i0 = np.mod(i, per); i1 = np.mod(i + 1, per)
    a, b = nhash(i0[:, 0], i0[:, 1], seed), nhash(i1[:, 0], i0[:, 1], seed)
    c, d = nhash(i0[:, 0], i1[:, 1], seed), nhash(i1[:, 0], i1[:, 1], seed)
    return (a + (b - a) * f[:, 0]) * (1 - f[:, 1]) + (c + (d - c) * f[:, 0]) * f[:, 1]


def npfbm(uv, tile, f, oct, seed):
    s, a, n = 0.0, 0.5, 0.0
    for k in range(oct):
        s = s + a * npnoise(uv * f, tile * f, seed + 101 * k); n += a; a *= 0.5; f *= 2
    return s / n


def dyn_truth(name, uv, tile, dE):
    """albedo (grey: the code's colour for the part multiplies it), height, cavity and glow, at points of a moving thing's face"""
    if name == 'cloth':
        weave = 0.5 + 0.25 * (np.sin(uv[:, 0] * 2 * np.pi * 50) + np.sin(uv[:, 1] * 2 * np.pi * 50))
        nz = npfbm(uv, tile, 6.0, 3, 3)
        seam = (np.abs(dE - 0.016) < 0.0025) * (np.sin((uv[:, 0] + uv[:, 1]) * 2 * np.pi * 60) > 0)
        alb = 0.8 * (0.86 + 0.14 * weave) * (0.88 + 0.24 * nz) * (0.72 + 0.28 * smoothstep(0, 0.04, dE)) * np.where(seam, 0.55, 1.0)
        return alb, 0.0006 * weave - 0.0015 * seam + 0.003 * nz, 0.85 + 0.15 * weave, np.zeros_like(alb)
    if name == 'skin':
        nz = npfbm(uv, tile, 10.0, 3, 5)
        alb = 0.9 * (0.94 + 0.12 * nz) * (0.84 + 0.16 * smoothstep(0, 0.06, dE))
        return alb, 0.001 * nz, np.full_like(alb, 0.95), np.zeros_like(alb)
    smoke = npfbm(uv, tile, 5.0, 4, 7)
    vein = 1 - np.abs(2 * npfbm(uv + 0.37, tile, 5.0, 3, 9) - 1)
    alb = 0.6 + 0.6 * smoke
    return alb, 0.004 * smoke, 0.7 + 0.3 * smoke, 0.25 + 0.75 * smoothstep(0.82, 0.97, vein)


class DynSet:
    """points on moving things' faces, anywhere the light painter was taught (its free-space points), in any pose"""
    dyn = True

    def __init__(self, n, r):
        x = np.fromfile(os.path.join(ROOT, 'data', 'train_x.f32'), dtype=np.float32)
        k = x.size // 8
        pos4, nrm4 = x[: k * 4].reshape(k, 4), x[k * 4:].reshape(k, 4)
        free = np.nonzero(nrm4[:, 3] == 0)[0]
        pick = free[r.integers(0, len(free), n)]
        self.p, self.t = pos4[pick, :3].copy(), pos4[pick, 3].copy()
        names = list(DYN_PARTS)
        which = r.integers(0, len(names), n)
        mi = np.array([[mm['name'] for mm in WORLD['mats']].index(nm) for nm in names])[which]
        size = np.zeros((n, 3), np.float32)
        for j, nm in enumerate(names):
            sel = np.nonzero(which == j)[0]
            sz = np.array(DYN_PARTS[nm], np.float32)
            size[sel] = sz[r.integers(0, len(sz), len(sel))]
        a = r.integers(0, 3, n); side = r.integers(0, 2, n)
        ua, va = UA[a], VA[a]
        rows = np.arange(n)
        vtop = np.where(a == 1, MUV[mi, 3], 0.0)
        uv = np.stack([r.random(n) * size[rows, ua], r.random(n) * size[rows, va] + vtop], 1).astype(np.float32)
        lo = np.stack([np.zeros(n), vtop], 1); hi = np.stack([size[rows, ua], size[rows, va] + vtop], 1)
        d = np.stack([uv[:, 0] - lo[:, 0], hi[:, 0] - uv[:, 0], uv[:, 1] - lo[:, 1], hi[:, 1] - uv[:, 1]], 1)
        r6, r30 = 1 - np.clip(d / 0.06, 0, 1), 1 - np.clip(d / 0.3, 0, 1)
        self.ef = np.stack([r6[:, 1] - r6[:, 0], r6[:, 3] - r6[:, 2], np.zeros(n), r30.max(1)], 1).astype(np.float32)
        dE = d.min(1)
        # the face's frame in the part's own space, then turned by a random heading (moving things turn about the vertical)
        Nl = np.zeros((n, 3), np.float32); Nl[rows, a] = np.where(side == 1, 1.0, -1.0)
        Tl, Bl = TAX[a], BAX[a]
        yaw = r.random(n) * 2 * np.pi
        cy, sy = np.cos(yaw), np.sin(yaw)
        rot = lambda v: np.stack([v[:, 0] * cy + v[:, 2] * sy, v[:, 1], -v[:, 0] * sy + v[:, 2] * cy], 1).astype(np.float32)
        self.n, T, B = rot(Nl), rot(Tl), rot(Bl)
        tile = MUV[mi, 1:3]
        alb = np.zeros(n); h0 = np.zeros(n); h1 = np.zeros(n); h2 = np.zeros(n); cav = np.zeros(n); em = np.zeros(n)
        e = 0.003
        for j, nm in enumerate(names):
            sel = np.nonzero(which == j)[0]
            A_, H_, C_, E_ = dyn_truth(nm, uv[sel], tile[sel], dE[sel])
            alb[sel], h0[sel], cav[sel], em[sel] = A_, H_, C_, E_
            h1[sel] = dyn_truth(nm, uv[sel] + [e, 0], tile[sel], dE[sel])[1]
            h2[sel] = dyn_truth(nm, uv[sel] + [0, e], tile[sel], dE[sel])[1]
        g = np.clip(np.stack([(h1 - h0) / e, (h2 - h0) / e], 1), -2.5, 2.5)
        nB = self.n - g[:, 0:1] * T - g[:, 1:2] * B
        nB /= np.linalg.norm(nB, axis=1, keepdims=True)
        self.N = n
        self.m, self.uv = mi.astype(np.int64), uv
        sd = sun_dir(self.t)
        self.ltan = np.stack([(sd * T).sum(1), (sd * B).sum(1), (sd * self.n).sum(1)], 1).astype(np.float32)
        self.ny = self.n[:, 1:2].astype(np.float32)
        self.vis = (r.random(n) < 0.7).astype(np.float32) * (self.ltan[:, 2] > 0)
        self.sunCV = (sun_irr(self.t) * self.vis[:, None]).astype(np.float32)
        self.X = exposure(self.t)
        lp = light_predict(self.p, self.n, self.t)
        self.Esky, self.Eb = lp[:, 0:3].copy(), lp[:, 3:18].reshape(-1, 5, 3).astype(np.float16)
        a_pi = (alb / np.pi)[:, None].astype(np.float32)
        self.sky = a_pi * cav[:, None] * self.Esky
        self.bk = (a_pi[:, :, None] * cav[:, None, None] * lp[:, 3:18].reshape(-1, 5, 3)).astype(np.float16)
        self.sun = a_pi * (0.5 + 0.5 * cav)[:, None] * sun_irr(self.t) * (np.maximum((nB * sd).sum(1), 0) * self.vis)[:, None]
        self.em = em.astype(np.float32)
        self.glow = np.where(self.m == [mm['name'] for mm in WORLD['mats']].index('shade'), 0, -1)
        self.p_dummy = None
        print(f'  {n:,} points on moving things', flush=True)

    def lights(self, sel, r):
        B = len(sel)
        u = r.random((B, 5))
        lvl = np.where(u < 0.45, 0.0, np.where(u < 0.8, 1.0, r.random((B, 5)))).astype(np.float32)
        BL = lvl[:, :, None] * BEACON_POWER * COL[None]
        E_in = self.Esky[sel] + (BL * self.Eb[sel].astype(np.float32)).sum(1)
        T_ind = self.sky[sel] + (BL * self.bk[sel].astype(np.float32)).sum(1)
        glowRGB = np.where((self.glow[sel] >= 0)[:, None], SHADE_EYES[None] * (0.05 + 0.95 * r.random(B))[:, None], 0.0).astype(np.float32)
        return E_in, glowRGB, T_ind + self.sun[sel] + self.em[sel][:, None] * glowRGB


C1 = int(np.prod(GRID['n1']))
P = {
    'LAT': rng.uniform(-0.05, 0.05, (NMAT * R * R, F)).astype(np.float32),
    'GS': np.zeros((C1, FG), np.float32),
    'W1': (rng.standard_normal((NIN, H)) * math.sqrt(2 / NIN)).astype(np.float32), 'b1': np.zeros(H, np.float32),
    'W2': (rng.standard_normal((H, H)) * math.sqrt(2 / H)).astype(np.float32), 'b2': np.zeros(H, np.float32),
    'W3': (rng.standard_normal((H, NOUT)) * math.sqrt(1 / H) * 0.3).astype(np.float32), 'b3': np.zeros(NOUT, np.float32),
}


def inputs(S, sel):
    li, lw = lat_corners(S.m[sel], S.uv[sel])
    lat = np.einsum('bc,bcf->bf', lw, P['LAT'][li])
    if getattr(S, 'dyn', False):
        gi, gw, gs = None, None, np.zeros((len(sel), FG), np.float32)   # a moving thing reads no wear grid
    else:
        gi, gw = light.corners(S.p[sel], S.n[sel], GRID['h1'], GRID['n1'])
        gs = np.einsum('bc,bcf->bf', gw, P['GS'][gi])
    x = np.concatenate([lat, S.ef[sel], S.ltan[sel], S.ny[sel], gs], 1)
    return x, (li, lw, gi, gw)


def forward(x):
    a1 = x @ P['W1'] + P['b1']; h1 = np.maximum(a1, 0)
    a2 = h1 @ P['W2'] + P['b2']; h2 = np.maximum(a2, 0)
    z = h2 @ P['W3'] + P['b3']
    return z, (a1, h1, a2, h2)


def paint(z, E_in, sunCV, glowRGB):
    w = np.logaddexp(0, z) * WS
    return w[:, 0:3] * E_in + w[:, 3:6] * sunCV + w[:, 6:9] * glowRGB, w


def tonemap(x):
    x = x * 0.8
    x = np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1)
    return x ** (1 / 2.2)


def evaluate(V, vsel, vl):
    x, _ = inputs(V, vsel)
    z, _ = forward(x)
    E_in, glowRGB, target = vl
    pred, _ = paint(z, E_in, V.sunCV[vsel], glowRGB)
    rel = float(np.abs(pred - target).sum() / max(target.sum(), 1e-9))
    X = V.X[vsel][:, None]
    tm = float(np.abs(tonemap(pred * X) - tonemap(target * X)).mean() * 255)
    per = {}
    for mi in range(NMAT):
        k = V.m[vsel] == mi
        if k.sum() > 50:
            per[WORLD['mats'][mi]['name']] = round(float(np.abs(tonemap(pred[k] * X[k]) - tonemap(target[k] * X[k])).mean() * 255), 2)
    return rel, tm, per


def main():
    t0 = time.time()
    tags = sorted(f[5:-6] for f in os.listdir(os.path.join(ROOT, 'data')) if f.startswith('surf_train') and f.endswith('_x.f32'))
    print('loading', tags, flush=True)
    S = Set(tags)
    V = Set(['val'])
    D = DynSet(600000, np.random.default_rng(21))
    DV = DynSet(40000, np.random.default_rng(23))
    vsel = np.arange(V.N)
    vl = V.lights(vsel, np.random.default_rng(11))
    dvsel = np.arange(DV.N)
    dvl = DV.lights(dvsel, np.random.default_rng(13))
    m = {k: np.zeros_like(v) for k, v in P.items()}; v2 = {k: np.zeros_like(v) for k, v in P.items()}
    b1_, b2_, eps = 0.9, 0.99, 1e-12
    history = []
    lr = {'LAT': 0.01, 'GS': 0.01}
    for step in range(1, STEPS + 1):
        frac = step / STEPS
        lr_scale = 1.0 if frac < 0.55 else (0.3 if frac < 0.85 else 0.08)
        nd = BATCH // 8
        sel, dsel = rng.integers(0, S.N, BATCH - nd), rng.integers(0, D.N, nd)
        x, (li, lw, gi, gw) = inputs(S, sel)
        xd, (dli, dlw, _, _) = inputs(D, dsel)
        x = np.concatenate([x, xd]); li = np.concatenate([li, dli]); lw = np.concatenate([lw, dlw])
        z, (a1, h1, a2, h2) = forward(x)
        E_in, glowRGB, target = [np.concatenate(q) for q in zip(S.lights(sel, rng), D.lights(dsel, rng))]
        sunCV = np.concatenate([S.sunCV[sel], D.sunCV[dsel]])
        pred, w = paint(z, E_in, sunCV, glowRGB)
        X = (np.concatenate([S.X[sel], D.X[dsel]]) / KNEE)[:, None]
        err = np.log1p(pred * X) - np.log1p(target * X)
        loss = float((err * err).mean())
        dpred = (2.0 / err.size) * err * X / (1 + pred * X)
        dw = np.concatenate([dpred * E_in, dpred * sunCV, dpred * glowRGB], 1)
        dz = dw * WS * (0.5 * (1 + np.tanh(0.5 * z)))
        g = {}
        g['W3'] = h2.T @ dz; g['b3'] = dz.sum(0)
        da2 = (dz @ P['W3'].T) * (a2 > 0)
        g['W2'] = h1.T @ da2; g['b2'] = da2.sum(0)
        da1 = (da2 @ P['W2'].T) * (a1 > 0)
        g['W1'] = x.T @ da1; g['b1'] = da1.sum(0)
        dx = da1 @ P['W1'].T
        dl, dg = dx[:, :F], dx[:, 16:20]
        g['LAT'] = np.stack([np.bincount(li.ravel(), weights=(lw * dl[:, j:j + 1]).ravel(), minlength=P['LAT'].shape[0]) for j in range(F)], 1).astype(np.float32)
        dg = dg[: len(sel)]   # (the moving things read no grid)
        g['GS'] = np.stack([np.bincount(gi.ravel(), weights=(gw * dg[:, j:j + 1]).ravel(), minlength=C1) for j in range(FG)], 1).astype(np.float32)
        for k in P:
            rate = lr.get(k, 0.003) * lr_scale
            m[k] = b1_ * m[k] + (1 - b1_) * g[k]
            v2[k] = b2_ * v2[k] + (1 - b2_) * g[k] * g[k]
            P[k] -= (rate * (m[k] / (1 - b1_ ** step)) / (np.sqrt(v2[k] / (1 - b2_ ** step)) + eps)).astype(np.float32)
        if step % 4 == 0:
            # a little smoothing of the textures, outside the optimiser (so texels no point reaches stay calm, and noise is damped)
            L = P['LAT'].reshape(NMAT, R, R, F)
            L += 0.0006 * (np.roll(L, 1, 1) + np.roll(L, -1, 1) + np.roll(L, 1, 2) + np.roll(L, -1, 2) - 4 * L)
        if step % 250 == 0 or step == 1:
            rel, tm, _ = evaluate(V, vsel, vl)
            _, dtm, _ = evaluate(DV, dvsel, dvl)
            history.append({'step': step, 'loss': loss, 'rel': rel, 'tonemapped': tm, 'movingTonemapped': dtm, 'sec': round(time.time() - t0, 1)})
            print(f'step {step:5d}  loss {loss:.4f}  held-out: {rel * 100:5.1f}% off in light, {tm:5.2f}/255 on screen (moving things {dtm:5.2f})  {time.time() - t0:6.0f}s', flush=True)
    export(S, V, vsel, vl, history, time.time() - t0, D)


def quantize(A):
    lo, hi = np.percentile(A, 0.05, axis=0), np.percentile(A, 99.95, axis=0)
    hi = np.maximum(hi, lo + 1e-4)
    q = np.clip(np.round((A - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)
    return q, (hi - lo) / 255.0, lo


def export(S, V, vsel, vl, history, secs, D=None):
    # ship 8-bit textures, and let the network settle onto them
    ql, ls, lo_l = quantize(P['LAT'])
    qg, gs_s, lo_g = quantize(P['GS'])
    P['LAT'] = (ql.astype(np.float32) * ls + lo_l).astype(np.float32)
    P['GS'] = (qg.astype(np.float32) * gs_s + lo_g).astype(np.float32)
    keep = ['W1', 'b1', 'W2', 'b2', 'W3', 'b3']
    m = {k: np.zeros_like(P[k]) for k in keep}; v2 = {k: np.zeros_like(P[k]) for k in keep}
    for step in range(1, 401):
        nd = BATCH // 8
        sel, dsel = rng.integers(0, S.N, BATCH - nd), rng.integers(0, D.N, nd)
        x = np.concatenate([inputs(S, sel)[0], inputs(D, dsel)[0]])
        z, (a1, h1, a2, h2) = forward(x)
        E_in, glowRGB, target = [np.concatenate(q) for q in zip(S.lights(sel, rng), D.lights(dsel, rng))]
        sunCV = np.concatenate([S.sunCV[sel], D.sunCV[dsel]])
        pred, _ = paint(z, E_in, sunCV, glowRGB)
        X = (np.concatenate([S.X[sel], D.X[dsel]]) / KNEE)[:, None]
        err = np.log1p(pred * X) - np.log1p(target * X)
        dpred = (2.0 / err.size) * err * X / (1 + pred * X)
        dz = np.concatenate([dpred * E_in, dpred * sunCV, dpred * glowRGB], 1) * WS * (0.5 * (1 + np.tanh(0.5 * z)))
        g = {'W3': h2.T @ dz, 'b3': dz.sum(0)}
        da2 = (dz @ P['W3'].T) * (a2 > 0); g['W2'] = h1.T @ da2; g['b2'] = da2.sum(0)
        da1 = (da2 @ P['W2'].T) * (a1 > 0); g['W1'] = x.T @ da1; g['b1'] = da1.sum(0)
        for k in keep:
            m[k] = 0.9 * m[k] + 0.1 * g[k]; v2[k] = 0.99 * v2[k] + 0.01 * g[k] * g[k]
            P[k] -= (0.0006 * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(v2[k] / (1 - 0.99 ** step)) + 1e-12)).astype(np.float32)
    rel, tm, per = evaluate(V, vsel, vl)
    print(f'shipped (8-bit textures): held-out {rel * 100:.1f}% off in light, {tm:.2f}/255 on screen; by material {per}', flush=True)
    n1 = GRID['n1']
    lat = ql.reshape(NMAT, R, R, F)
    gsq = qg.reshape(n1[2], n1[1], n1[0], FG)
    b3 = np.zeros(NOUT_PAD, np.float32); b3[:NOUT] = P['b3']
    ubo = np.concatenate([light.pack_layer(P['W1'], NIN, H), light.pack_layer(P['W2'], H, H), light.pack_layer(P['W3'], H, NOUT_PAD), P['b1'], P['b2'], b3]).astype(np.float32)
    head = {'R': R, 'layers': NMAT, 'features': F, 'gridFeatures': FG, 'n1': n1, 'min': GRID['min'], 'h1': GRID['h1'], 'off': GRID['off'],
            'latScale': ls.tolist(), 'latOffset': lo_l.tolist(), 'gsScale': gs_s.tolist(), 'gsOffset': lo_g.tolist(),
            'hidden': H, 'inputs': NIN, 'outputs': NOUT, 'outScale': WS.tolist(), 'uboFloats': int(ubo.size),
            'weights': int(sum(P[k].size for k in keep)), 'textureValues': int(lat.size), 'gridValues': int(gsq.size),
            'trainSeconds': round(secs, 1), 'heldOut': {'lightOff': rel, 'screenOff255': tm, 'byMaterial': per}}
    hj = json.dumps(head).encode()
    blob = [b'LPS1', struct.pack('<I', len(hj)), hj, b'\0' * ((-(8 + len(hj))) % 4)]
    blob.append(np.ascontiguousarray(lat[..., 0:4]).tobytes())
    blob.append(np.ascontiguousarray(lat[..., 4:8]).tobytes())
    blob.append(np.ascontiguousarray(gsq).tobytes())
    blob.append(b'\0' * ((-sum(len(b) for b in blob)) % 4))
    blob.append(ubo.tobytes())
    data = b''.join(blob)
    open(os.path.join(ROOT, 'game', 'surface.bin'), 'wb').write(data)
    # how each material looks from far away (the game blends a sub-pixel pattern toward it)
    import far_response
    fb, fh, fhead, fl0, fl1, fgs, fubo = far_response.read_surface(os.path.join(ROOT, 'game', 'surface.bin'))
    fhead['far'] = far_response.far_response(fhead, fl0, fl1, fgs, fubo)
    far_response.write_header(os.path.join(ROOT, 'game', 'surface.bin'), fb, fh, fhead)
    data = open(os.path.join(ROOT, 'game', 'surface.bin'), 'rb').read()
    json.dump({'head': head, 'history': history}, open(os.path.join(ROOT, 'data', 'surface_report.json'), 'w'), indent=1)
    print(f'surface.bin {len(data) / 1e6:.2f} MB  ({head["weights"]:,} network weights + {lat.size:,} texture values + {gsq.size:,} grid values)  in {secs:.0f}s')


if __name__ == '__main__':
    main()
