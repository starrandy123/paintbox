# Fits the painter: a 3D feature grid (two resolutions) and a tiny network that turns (features, normal, time of day) into the
# light arriving at a point -- the sky's part and each beacon's part. Plain numpy; run with Blender's bundled Python:
#   /Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13 -I bake/train.py [steps]
# Reads data/train_*.f32 and data/val_*.f32 (from bake/run.mjs), writes game/painter.bin and data/train_report.json.
import json, math, os, struct, sys, time
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
GRID = json.load(open(os.path.join(ROOT, 'data', 'grid.json')))
STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 4000
BATCH = 65536
F1, F0, H, NIN, NOUT, NOUT_PAD = 8, 4, 32, 24, 18, 20
S_SKY, S_BEACON = 0.01, 0.002
rng = np.random.default_rng(3)


def load(tag):
    x = np.fromfile(os.path.join(ROOT, 'data', f'{tag}_x.f32'), dtype=np.float32)
    y = np.fromfile(os.path.join(ROOT, 'data', f'{tag}_y.f32'), dtype=np.float32)
    n = y.size // 18
    pos4, nrm4 = x[: n * 4].reshape(n, 4), x[n * 4:].reshape(n, 4)
    y = y.reshape(n, 18)
    ok = np.isfinite(y).all(1) & np.isfinite(pos4).all(1) & np.isfinite(nrm4).all(1)
    if (~ok).sum(): print(f'  {tag}: {(~ok).sum()} of {n} points are not all numbers: left out', flush=True)
    return pos4[ok, :3].copy(), nrm4[ok, :3].copy(), pos4[ok, 3].copy(), y[ok]


def corners(p, nrm, h, n):
    """trilinear corners of the grid read half a cell off the surface: (B,8) flat indices and (B,8) weights"""
    q = p + nrm * GRID['off']
    g = (q - np.array(GRID['min'], np.float32)) / h
    nn = np.array(n, np.float32)
    g = np.clip(g, 0.0, nn - 1.0)
    i0 = np.minimum(np.floor(g), nn - 2.0).astype(np.int64)
    f = (g - i0).astype(np.float32)
    nx, ny = n[0], n[1]
    idx = np.empty((p.shape[0], 8), np.int64)
    w = np.empty((p.shape[0], 8), np.float32)
    c = 0
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                idx[:, c] = (i0[:, 0] + dx) + nx * ((i0[:, 1] + dy) + ny * (i0[:, 2] + dz))
                w[:, c] = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                c += 1
    return idx, w


def tenc(t):
    return np.stack([2 * t - 1, np.sin(math.pi * t), np.cos(math.pi * t), np.cos(2 * math.pi * t)], 1).astype(np.float32)


CRYS = [(np.array(lo, np.float32), np.array(hi, np.float32)) for lo, hi in GRID['crystals']]


def hints(p, nrm):
    """what each crystal would give the point if nothing were in the way (unit radiance, far-field): the network's G-buffer-like input"""
    out = np.empty((p.shape[0], 5), np.float32)
    for k, (lo, hi) in enumerate(CRYS):
        s = hi - lo; c = (lo + hi) / 2
        w = c - p; d2 = np.maximum((w * w).sum(1), 0.09); wn = w / np.sqrt(d2)[:, None]
        area = np.abs(wn[:, 0]) * s[1] * s[2] + np.abs(wn[:, 2]) * s[0] * s[1] + np.maximum(-wn[:, 1], 0) * s[0] * s[2]
        out[:, k] = np.maximum((nrm * wn).sum(1), 0) * area / d2
    return np.log1p(out / S_BEACON) / 8.0


def targets(y):
    out = np.empty_like(y)
    out[:, :3] = np.log1p(np.maximum(y[:, :3], 0) / S_SKY)
    out[:, 3:] = np.log1p(np.maximum(y[:, 3:], 0) / S_BEACON)
    return out


def decode(z):
    out = np.empty_like(z)
    out[:, :3] = S_SKY * np.expm1(z[:, :3])
    out[:, 3:] = S_BEACON * np.expm1(z[:, 3:])
    return np.maximum(out, 0)


C1 = int(np.prod(GRID['n1'])); C0 = int(np.prod(GRID['n0']))
P = {
    'G1': rng.uniform(-1e-4, 1e-4, (C1, F1)).astype(np.float32),
    'G0': rng.uniform(-1e-4, 1e-4, (C0, F0)).astype(np.float32),
    'W1': (rng.standard_normal((NIN, H)) * math.sqrt(2 / NIN)).astype(np.float32), 'b1': np.zeros(H, np.float32),
    'W2': (rng.standard_normal((H, H)) * math.sqrt(2 / H)).astype(np.float32), 'b2': np.zeros(H, np.float32),
    'W3': (rng.standard_normal((H, NOUT)) * math.sqrt(1 / H)).astype(np.float32), 'b3': np.zeros(NOUT, np.float32),
}


def forward(batch, keep=False):
    idx1, w1, idx0, w0, nrm, te, hb = batch
    f1 = np.einsum('bc,bcf->bf', w1, P['G1'][idx1])
    f0 = np.einsum('bc,bcf->bf', w0, P['G0'][idx0])
    x = np.concatenate([f1, f0, nrm, te, hb], 1)
    a1 = x @ P['W1'] + P['b1']; h1 = np.maximum(a1, 0)
    a2 = h1 @ P['W2'] + P['b2']; h2 = np.maximum(a2, 0)
    z = h2 @ P['W3'] + P['b3']
    return (z, (x, a1, h1, a2, h2)) if keep else z


def prep(p, n, t):
    idx1, w1 = corners(p, n, GRID['h1'], GRID['n1'])
    idx0, w0 = corners(p, n, GRID['h0'], GRID['n0'])
    return idx1, w1, idx0, w0, n.astype(np.float32), tenc(t), hints(p, n)


def tv_grad(G, n, lam):
    g = G.reshape(n[2], n[1], n[0], G.shape[1])
    out = np.zeros_like(g); loss = 0.0
    for ax in range(3):
        d = np.diff(g, axis=ax)
        loss += float((d * d).sum())
        sl_hi = [slice(None)] * 4; sl_hi[ax] = slice(1, None)
        sl_lo = [slice(None)] * 4; sl_lo[ax] = slice(None, -1)
        out[tuple(sl_hi)] += 2 * d
        out[tuple(sl_lo)] -= 2 * d
    return lam * out.reshape(G.shape), lam * loss


def main():
    t0 = time.time()
    p, n, t, y = load('train')
    vp, vn, vt, vy = load('val')
    N = y.shape[0]
    Y = targets(y); VY = targets(vy)
    P['b3'][:] = Y.mean(0)
    print(f'train {N:,}  val {vy.shape[0]:,}  grid fine {GRID["n1"]} ({C1:,} cells x {F1})  coarse {GRID["n0"]}  load {time.time()-t0:.1f}s', flush=True)
    vbatch = prep(vp, vn, vt)
    m = {k: np.zeros_like(v) for k, v in P.items()}; v2 = {k: np.zeros_like(v) for k, v in P.items()}
    b1_, b2_, eps = 0.9, 0.99, 1e-10
    history = []
    for step in range(1, STEPS + 1):
        frac = step / STEPS
        lr_scale = 1.0 if frac < 0.5 else (0.3 if frac < 0.8 else 0.08)
        sel = rng.integers(0, N, BATCH)
        batch = prep(p[sel], n[sel], t[sel])
        z, (x, a1, h1, a2, h2) = forward(batch, keep=True)
        err = z - Y[sel]
        loss = float((err * err).mean())
        dz = (2.0 / err.size) * err
        g = {}
        g['W3'] = h2.T @ dz; g['b3'] = dz.sum(0)
        dh2 = dz @ P['W3'].T; da2 = dh2 * (a2 > 0)
        g['W2'] = h1.T @ da2; g['b2'] = da2.sum(0)
        dh1 = da2 @ P['W2'].T; da1 = dh1 * (a1 > 0)
        g['W1'] = x.T @ da1; g['b1'] = da1.sum(0)
        dx = da1 @ P['W1'].T
        df1, df0 = dx[:, :F1], dx[:, F1:F1 + F0]
        idx1, w1, idx0, w0 = batch[0], batch[1], batch[2], batch[3]
        g['G1'] = np.stack([np.bincount(idx1.ravel(), weights=(w1 * df1[:, j:j + 1]).ravel(), minlength=C1) for j in range(F1)], 1).astype(np.float32)
        g['G0'] = np.stack([np.bincount(idx0.ravel(), weights=(w0 * df0[:, j:j + 1]).ravel(), minlength=C0) for j in range(F0)], 1).astype(np.float32)
        tg1, tl1 = tv_grad(P['G1'], GRID['n1'], 2e-6)
        tg0, tl0 = tv_grad(P['G0'], GRID['n0'], 2e-6)
        g['G1'] += tg1; g['G0'] += tg0
        for k in P:
            lr = (0.02 if k in ('G1', 'G0') else 0.004) * lr_scale
            m[k] = b1_ * m[k] + (1 - b1_) * g[k]
            v2[k] = b2_ * v2[k] + (1 - b2_) * g[k] * g[k]
            mh = m[k] / (1 - b1_ ** step); vh = v2[k] / (1 - b2_ ** step)
            P[k] -= (lr * mh / (np.sqrt(vh) + eps)).astype(np.float32)
        if step % 250 == 0 or step == 1:
            vz = forward(vbatch)
            vloss = float(((vz - VY) ** 2).mean())
            pred, ref = decode(vz), vy
            rel_sky = float(np.abs(pred[:, :3] - ref[:, :3]).sum() / max(ref[:, :3].sum(), 1e-9))
            rel_b = float(np.abs(pred[:, 3:] - ref[:, 3:]).sum() / max(ref[:, 3:].sum(), 1e-9))
            history.append({'step': step, 'loss': loss, 'val': vloss, 'rel_sky': rel_sky, 'rel_beacons': rel_b, 'sec': round(time.time() - t0, 1)})
            print(f'step {step:5d}  loss {loss:.4f}  val {vloss:.4f}  sky err {rel_sky*100:5.1f}%  beacon err {rel_b*100:5.1f}%  {time.time()-t0:6.0f}s', flush=True)
    export(history, time.time() - t0)


def pack_layer(W, nin_pad, nout_pad):
    """a (nin x nout) weight matrix as std140 mat4 blocks [out group][in group], each column-major: column c = input c of the group"""
    Wp = np.zeros((nin_pad, nout_pad), np.float32); Wp[: W.shape[0], : W.shape[1]] = W
    out = []
    for o in range(nout_pad // 4):
        for i in range(nin_pad // 4):
            blk = Wp[i * 4:(i + 1) * 4, o * 4:(o + 1) * 4]   # [input c][output r]
            out.append(blk.reshape(-1))                        # column c = blk[c, :] -> (W[c, r] for r) : column-major mat4
    return np.concatenate(out)


def export(history, secs):
    n1, n0 = GRID['n1'], GRID['n0']
    g1 = P['G1'].reshape(n1[2], n1[1], n1[0], F1)
    g0 = P['G0'].reshape(n0[2], n0[1], n0[0], F0)
    b3 = np.zeros(NOUT_PAD, np.float32); b3[:NOUT] = P['b3']
    ubo = np.concatenate([pack_layer(P['W1'], NIN, H), pack_layer(P['W2'], H, H), pack_layer(P['W3'], H, NOUT_PAD), P['b1'], P['b2'], b3]).astype(np.float32)
    head = {'n1': n1, 'n0': n0, 'min': GRID['min'], 'h1': GRID['h1'], 'h0': GRID['h0'], 'off': GRID['off'], 'f1': F1, 'f0': F0,
            'hidden': H, 'inputs': NIN, 'outputs': NOUT, 'sSky': S_SKY, 'sBeacon': S_BEACON, 'uboFloats': int(ubo.size),
            'weights': int(sum(v.size for k, v in P.items() if k not in ('G1', 'G0'))), 'gridValues': int(P['G1'].size + P['G0'].size),
            'trainSeconds': round(secs, 1), 'final': history[-1] if history else None}
    hj = json.dumps(head).encode()
    blob = [b'LPT1', struct.pack('<I', len(hj)), hj]
    pad = (-(8 + len(hj))) % 4
    blob.append(b'\0' * pad)
    blob.append(np.ascontiguousarray(g1[..., 0:4]).astype(np.float16).tobytes())
    blob.append(np.ascontiguousarray(g1[..., 4:8]).astype(np.float16).tobytes())
    blob.append(np.ascontiguousarray(g0).astype(np.float16).tobytes())
    blob.append(ubo.tobytes())
    data = b''.join(blob)
    open(os.path.join(ROOT, 'game', 'painter.bin'), 'wb').write(data)
    np.savez(os.path.join(ROOT, 'data', 'painter_params.npz'), **P)   # the surface trainer reads the light painter from here
    json.dump({'head': head, 'history': history}, open(os.path.join(ROOT, 'data', 'train_report.json'), 'w'), indent=1)
    print(f'painter.bin {len(data)/1e6:.2f} MB  ({head["weights"]:,} network weights + {head["gridValues"]:,} grid values)  in {secs:.0f}s')


if __name__ == '__main__':
    main()
