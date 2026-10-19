# Fits the shape painter: the detailed world's SHAPES, painted from what the code knows about the boxes. For every form (world.js
# FORMS) a grid of 8 learned features in the form's own frame, and one tiny network for them all:
#   - feature 0, read on its own, is a coarse distance that never runs long: the game steps along a ray by it until it is near
#   - the network (8 -> 16 -> 16 -> 1) reads all 8 there and gives the distance to the surface itself, to a millimetre or two
# The game traces each box's shell with them: the battlements, the arches, the columns, the canopies, the bodies all come from here.
# Plain numpy (python3 with numpy):  python3 -I bake/train_shape.py [steps]
# Reads data/shape_*_{x,y}.f32 (bake/run.mjs shapes) and data/boxes.json (the forms' frames); writes game/shape.bin and
# data/shape_report.json.
import json, math, os, struct, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
WORLD = json.load(open(os.path.join(ROOT, 'data', 'boxes.json')))
FORMS = WORLD['forms']
STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
BATCH = 65536
F, H, NIN = 8, 16, 8
OUT = 0.1          # the network's output times this is the distance (metres in the form's frame)
NEAR = 0.15        # the network is asked for the distance out to here; past it, only which side
COARSE = 0.3       # feature 0 holds the distance out to here
rng = np.random.default_rng(3)

# ---- the forms' grids: one block of the feature array each, z-major (z, y, x) as the game's 3D textures hold them ----
GRIDS, off = [], 0
for i, fm in enumerate(FORMS):
    if i == 0:
        GRIDS.append(None); continue
    dom = fm['domain']
    n = [a['n'] for a in dom]
    lo = np.array([a['lo'] for a in dom], np.float64)
    hi = np.array([a['hi'] for a in dom], np.float64)
    wrap = np.array([bool(a['wrap']) for a in dom])
    sp = np.where(wrap, (hi - lo) / np.array(n), (hi - lo) / (np.array(n) - 1))
    GRIDS.append({'n': n, 'lo': lo, 'sp': sp, 'wrap': wrap, 'off': off, 'cells': n[0] * n[1] * n[2]})
    off += n[0] * n[1] * n[2]
CELLS = off
NI = np.array([g['n'] if g else [1, 1, 1] for g in GRIDS], np.int64)
LO = np.array([g['lo'] if g else [0, 0, 0] for g in GRIDS], np.float64)
SP = np.array([g['sp'] if g else [1, 1, 1] for g in GRIDS], np.float64)
WR = np.array([g['wrap'] if g else [False] * 3 for g in GRIDS])
OFF = np.array([g['off'] if g else 0 for g in GRIDS], np.int64)


def load(tag):
    x = np.fromfile(os.path.join(ROOT, 'data', f'shape_{tag}_x.f32'), dtype=np.float32).reshape(-1, 4)
    y = np.fromfile(os.path.join(ROOT, 'data', f'shape_{tag}_y.f32'), dtype=np.float32)
    ok = np.isfinite(y) & np.isfinite(x).all(1)
    if (~ok).sum(): print(f'  {tag}: {(~ok).sum()} of {len(y)} points are not all numbers: left out', flush=True)
    return x[ok, :3].astype(np.float64), x[ok, 3].astype(np.int64), y[ok].astype(np.float32)


def corners(c, f):
    """the 8 grid points around each point of a form's frame and their trilinear weights (as the game's LINEAR 3D texture reads them:
    a repeating axis wraps, any other clamps)"""
    n, g = NI[f], (c - LO[f]) / SP[f]
    nf = n.astype(np.float64)
    gw = np.where(WR[f], np.mod(g, nf), np.clip(g, 0.0, nf - 1.0))
    i0 = np.floor(gw).astype(np.int64)
    fr = (gw - i0).astype(np.float32)
    i0 = np.where(WR[f], np.mod(i0, n), np.minimum(i0, n - 1))
    i1 = np.where(WR[f], np.mod(i0 + 1, n), np.minimum(i0 + 1, n - 1))
    idx, w = [], []
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                ix = i1[:, 0] if dx else i0[:, 0]; iy = i1[:, 1] if dy else i0[:, 1]; iz = i1[:, 2] if dz else i0[:, 2]
                idx.append(OFF[f] + (iz * n[:, 1] + iy) * n[:, 0] + ix)
                wx = fr[:, 0] if dx else 1 - fr[:, 0]; wy = fr[:, 1] if dy else 1 - fr[:, 1]; wz = fr[:, 2] if dz else 1 - fr[:, 2]
                w.append(wx * wy * wz)
    return np.stack(idx, 1), np.stack(w, 1).astype(np.float32)


P = {
    'G': np.zeros((CELLS, F), np.float32),
    'W1': (rng.standard_normal((NIN, H)) * math.sqrt(2 / NIN)).astype(np.float32), 'b1': np.zeros(H, np.float32),
    'W2': (rng.standard_normal((H, H)) * math.sqrt(2 / H)).astype(np.float32), 'b2': np.zeros(H, np.float32),
    'W3': (rng.standard_normal((H, 1)) * math.sqrt(1 / H) * 0.3).astype(np.float32), 'b3': np.zeros(1, np.float32),
}
P['G'][:, 1:] = rng.uniform(-0.05, 0.05, (CELLS, F - 1)).astype(np.float32)


def forward(x):
    a1 = x @ P['W1'] + P['b1']; h1 = np.maximum(a1, 0)
    a2 = h1 @ P['W2'] + P['b2']; h2 = np.maximum(a2, 0)
    z = h2 @ P['W3'] + P['b3']
    return z[:, 0] * OUT, (a1, h1, a2, h2)


def weights(d):
    return (1.0 / (1.0 + np.abs(d) / 0.02)).astype(np.float32)


def evaluate(c, f, d):
    """held out: the network's distance near the surface (mm), which side it puts points on, how often feature 0 runs long"""
    out = {}
    pred = np.empty(len(d), np.float32); coarse = np.empty(len(d), np.float32)
    for s in range(0, len(d), 262144):
        e = slice(s, s + 262144)
        idx, w = corners(c[e], f[e])
        x = np.einsum('bc,bcf->bf', w, P['G'][idx])
        pred[e] = forward(x)[0]; coarse[e] = x[:, 0]
    near = np.abs(d) < 0.03
    out['nearMM'] = float(np.abs(pred[near] - d[near]).mean() * 1000)
    side = (np.abs(d) > 0.004) & (np.abs(d) < 0.1)
    out['sideOK'] = float((np.sign(pred[side]) == np.sign(d[side])).mean())
    mid = np.abs(d) < COARSE
    out['coarseMM'] = float(np.abs(coarse[mid] - d[mid]).mean() * 1000)
    out['coarseLong'] = float((coarse[mid] > d[mid] + 0.01).mean())
    per = {}
    for i in range(1, len(FORMS)):
        k = (f == i) & near
        if k.sum() > 100: per[FORMS[i]['name']] = round(float(np.abs(pred[k] - d[k]).mean() * 1000), 2)
    out['nearMMByForm'] = per
    return out


def smooth(G, rate):
    """a little smoothing of each form's grid (wrapping where its frame repeats), outside the optimiser: points no sample reaches
    stay calm"""
    for i, g in enumerate(GRIDS):
        if not g: continue
        nx, ny, nz = g['n']
        B = G[g['off']: g['off'] + g['cells']].reshape(nz, ny, nx, F)
        lap = np.zeros_like(B)
        for ax, w in ((2, g['wrap'][0]), (1, g['wrap'][1]), (0, g['wrap'][2])):
            if w:
                lap += np.roll(B, 1, ax) + np.roll(B, -1, ax) - 2 * B
            else:
                pad = [(0, 0)] * 4; pad[ax] = (1, 1)
                Bp = np.pad(B, pad, mode='edge')
                sl_lo = [slice(None)] * 4; sl_hi = [slice(None)] * 4
                sl_lo[ax] = slice(0, -2); sl_hi[ax] = slice(2, None)
                lap += Bp[tuple(sl_lo)] + Bp[tuple(sl_hi)] - 2 * B
        B += rate * lap


def train(c, f, d, cv, fv, dv, steps, lr_scale0=1.0, keep=None, history=None, t0=0.0):
    names = keep or list(P)
    m = {k: np.zeros_like(P[k]) for k in names}; v2 = {k: np.zeros_like(P[k]) for k in names}
    lr = {'G': 0.01}
    for step in range(1, steps + 1):
        frac = step / steps
        ls = lr_scale0 * (1.0 if frac < 0.55 else (0.3 if frac < 0.85 else 0.08))
        sel = rng.integers(0, len(d), BATCH)
        idx, w = corners(c[sel], f[sel])
        x = np.einsum('bc,bcf->bf', w, P['G'][idx])
        pred, (a1, h1, a2, h2) = forward(x)
        dt = d[sel]
        wt = weights(dt)
        # the network: the distance near the surface; out past NEAR, at least NEAR on the right side
        tgt = np.clip(dt, -NEAR, NEAR)
        far = np.abs(dt) >= NEAR
        e = pred - tgt
        e = np.where(far & (np.sign(dt) * pred >= NEAR), 0.0, e)
        dpred = (2.0 / BATCH) * wt * e
        # feature 0: the distance out to COARSE, never longer than the real one where the trace steps by it
        dc = np.clip(dt, -COARSE, COARSE)
        ec = x[:, 0] - dc
        wc = np.where(ec > 0, 4.0, 1.0) * (0.3 + 0.7 * wt)
        dx0 = (2.0 / BATCH) * wc * ec * 0.5
        dz = (dpred * OUT)[:, None]
        g = {}
        g['W3'] = h2.T @ dz; g['b3'] = dz.sum(0)
        da2 = (dz @ P['W3'].T) * (a2 > 0)
        g['W2'] = h1.T @ da2; g['b2'] = da2.sum(0)
        da1 = (da2 @ P['W2'].T) * (a1 > 0)
        g['W1'] = x.T @ da1; g['b1'] = da1.sum(0)
        dx = da1 @ P['W1'].T
        dx[:, 0] += dx0
        if 'G' in names:
            g['G'] = np.stack([np.bincount(idx.ravel(), weights=(w * dx[:, j:j + 1]).ravel(), minlength=CELLS) for j in range(F)], 1).astype(np.float32)
        for k in names:
            rate = lr.get(k, 0.003) * ls
            m[k] = 0.9 * m[k] + 0.1 * g[k]
            v2[k] = 0.99 * v2[k] + 0.01 * g[k] * g[k]
            P[k] -= (rate * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(v2[k] / (1 - 0.99 ** step)) + 1e-12)).astype(np.float32)
        if 'G' in names and step % 4 == 0:
            smooth(P['G'], 0.0008)
        if history is not None and (step % 250 == 0 or step == 1):
            vs = rng.integers(0, len(dv), 400000)
            r = evaluate(cv[vs], fv[vs], dv[vs])
            history.append({'step': step, **{k: v for k, v in r.items() if k != 'nearMMByForm'}, 'sec': round(time.time() - t0, 1)})
            print(f"step {step:5d}  held-out: {r['nearMM']:5.2f} mm near the surface, {r['sideOK'] * 100:5.1f}% on the right side; "
                  f"coarse {r['coarseMM']:5.1f} mm, {r['coarseLong'] * 100:4.1f}% long  {time.time() - t0:6.0f}s", flush=True)


def quantize(A):
    lo, hi = np.percentile(A, 0.02, axis=0), np.percentile(A, 99.98, axis=0)
    hi = np.maximum(hi, lo + 1e-4)
    q = np.clip(np.round((A - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)
    return q, (hi - lo) / 255.0, lo


def main():
    t0 = time.time()
    c, f, d = load('train')
    cv, fv, dv = load('val')
    print(f'{len(d):,} points of {len(FORMS) - 1} forms\' frames; {CELLS:,} grid points x {F} features', flush=True)
    history = []
    train(c, f, d, cv, fv, dv, STEPS, history=history, t0=t0)
    # ship 8-bit grids (each form's own scale per feature), and let the network settle onto them
    qs, scales, offsets = [], [], []
    for i, g in enumerate(GRIDS):
        if not g: scales.append(None); offsets.append(None); continue
        B = P['G'][g['off']: g['off'] + g['cells']]
        q, s, o = quantize(B)
        P['G'][g['off']: g['off'] + g['cells']] = q.astype(np.float32) * s + o
        qs.append(q); scales.append(s.tolist()); offsets.append(o.tolist())
    train(c, f, d, cv, fv, dv, 400, lr_scale0=0.2, keep=['W1', 'b1', 'W2', 'b2', 'W3', 'b3'])
    r = evaluate(cv, fv, dv)
    print(f"shipped (8-bit grids): {r['nearMM']:.2f} mm near the surface, {r['sideOK'] * 100:.1f}% on the right side; coarse "
          f"{r['coarseMM']:.1f} mm, {r['coarseLong'] * 100:.1f}% long; by form (mm) {r['nearMMByForm']}", flush=True)
    sys.path.insert(0, HERE)
    import train as light
    b3 = np.zeros(4, np.float32); b3[0] = P['b3'][0]
    ubo = np.concatenate([light.pack_layer(P['W1'], NIN, H), light.pack_layer(P['W2'], H, H), light.pack_layer(P['W3'], H, 4), P['b1'], P['b2'], b3]).astype(np.float32)
    forms, at = [], 0
    for i, g in enumerate(GRIDS):
        if not g: forms.append(None); continue
        forms.append({'name': FORMS[i]['name'], 'n': g['n'], 'lo': g['lo'].tolist(), 'sp': g['sp'].tolist(), 'wrap': g['wrap'].tolist(),
                      'at': at, 'scale': scales[i], 'offset': offsets[i]})
        at += g['cells'] * F
    head = {'forms': forms, 'features': F, 'inputs': NIN, 'hidden': H, 'outScale': OUT, 'uboFloats': int(ubo.size),
            'weights': int(sum(P[k].size for k in ['W1', 'b1', 'W2', 'b2', 'W3', 'b3'])), 'gridValues': int(CELLS * F),
            'trainSeconds': round(time.time() - t0, 1), 'heldOut': r}
    hj = json.dumps(head).encode()
    blob = [b'LPG1', struct.pack('<I', len(hj)), hj, b'\0' * ((-(8 + len(hj))) % 4)]
    for q in qs:
        blob.append(np.ascontiguousarray(q[:, 0:4]).tobytes())   # (z, y, x) order: the first texture, features 0-3
        blob.append(np.ascontiguousarray(q[:, 4:8]).tobytes())   # the second, features 4-7
    blob.append(b'\0' * ((-sum(len(b) for b in blob)) % 4))
    blob.append(ubo.tobytes())
    data = b''.join(blob)
    open(os.path.join(ROOT, 'game', 'shape.bin'), 'wb').write(data)
    json.dump({'head': head, 'history': history}, open(os.path.join(ROOT, 'data', 'shape_report.json'), 'w'), indent=1)
    print(f'shape.bin {len(data) / 1e6:.2f} MB  ({head["weights"]:,} network weights + {CELLS * F:,} grid values)  in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
