# Fits the sky painter: a tiled feature texture over the cloud deck (4 features, 256 x 256 on one tile) and a 16 -> 16 -> 16 -> 3
# network. From the deck's features, where the view points (height over the horizon, how near the sun, which side of the sky), the
# time of day and the code's two facts about the sky (a star is here; the sun's disk is here), it paints the sky.
#   /Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13 -I bake/train_sky.py [steps]
# Reads data/sky_*.f32 (bake/run.mjs sky); writes game/sky.bin and data/sky_report.json.
import json, math, os, struct, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
from train import pack_layer, tenc


def smoothstep(a, b, x):
    k = np.clip((x - a) / (b - a), 0.0, 1.0)
    return k * k * (3 - 2 * k)


def sun_dir(t):
    e = np.radians(30 - 50 * t)
    h = np.array([0.9, 0.0, 0.38]); h /= np.linalg.norm(h)
    return np.stack([h[0] * np.cos(e), np.sin(e), h[2] * np.cos(e)], 1).astype(np.float32)


def exposure(t):
    return (1 + 2.4 * smoothstep(0.45, 0.92, t)).astype(np.float32)


def tonemap(x):
    x = x * 0.8
    x = np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1)
    return x ** (1 / 2.2)

STEPS = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
BATCH = 65536
R, F, H, NIN, NOUT, NOUT_PAD = 256, 4, 16, 16, 3, 4
KNEE = 0.02
rng = np.random.default_rng(9)


def load(tag):
    x = np.fromfile(os.path.join(ROOT, 'data', f'sky_{tag}_x.f32'), dtype=np.float32).reshape(-1, 4)
    y = np.fromfile(os.path.join(ROOT, 'data', f'sky_{tag}_y.f32'), dtype=np.float32).reshape(-1, 4)
    return x[:, :3].copy(), x[:, 3].copy(), y[:, :3].copy(), y[:, 3].copy()


def features(d, t, star):
    """everything but the deck's texture (the shader computes the same): 12 values"""
    s = sun_dir(t)
    c = (d * s).sum(1)
    hd = d[:, [0, 2]] / (np.linalg.norm(d[:, [0, 2]], axis=1, keepdims=True) + 1e-5)
    hs = s[:, [0, 2]] / np.linalg.norm(s[:, [0, 2]], axis=1, keepdims=True)
    az = (hd * hs).sum(1)
    near = np.clip(-np.log(np.maximum(1 - c, 0) + 1e-5) / 11.5, 0, 1)   # how near the sun, on a log scale (sharp halo, soft glow)
    disk = smoothstep(0.99975, 0.99985, c)
    return np.concatenate([np.stack([d[:, 1], c, near, az], 1), tenc(t), np.stack([star, disk, np.maximum(d[:, 1], 0) ** 0.42, np.zeros_like(c)], 1)], 1).astype(np.float32)


def deck_corners(d):
    q = d[:, [0, 2]] / (np.maximum(d[:, 1:2], 0) + 0.05) * 0.12   # truth.js cloudUV
    g = q * R - 0.5
    g0 = np.floor(g); f = (g - g0).astype(np.float32)
    i0 = np.mod(g0, R).astype(np.int64); i1 = np.mod(i0 + 1, R)
    idx = np.stack([i0[:, 1] * R + i0[:, 0], i0[:, 1] * R + i1[:, 0], i1[:, 1] * R + i0[:, 0], i1[:, 1] * R + i1[:, 0]], 1)
    w = np.stack([(1 - f[:, 0]) * (1 - f[:, 1]), f[:, 0] * (1 - f[:, 1]), (1 - f[:, 0]) * f[:, 1], f[:, 0] * f[:, 1]], 1)
    return idx, w


P = {
    'LAT': rng.uniform(-0.05, 0.05, (R * R, F)).astype(np.float32),
    'W1': (rng.standard_normal((NIN, H)) * math.sqrt(2 / NIN)).astype(np.float32), 'b1': np.zeros(H, np.float32),
    'W2': (rng.standard_normal((H, H)) * math.sqrt(2 / H)).astype(np.float32), 'b2': np.zeros(H, np.float32),
    'W3': (rng.standard_normal((H, NOUT)) * math.sqrt(1 / H)).astype(np.float32), 'b3': np.zeros(NOUT, np.float32),
}


def forward(fe, li, lw):
    x = np.concatenate([np.einsum('bc,bcf->bf', lw, P['LAT'][li]), fe], 1)
    a1 = x @ P['W1'] + P['b1']; h1 = np.maximum(a1, 0)
    a2 = h1 @ P['W2'] + P['b2']; h2 = np.maximum(a2, 0)
    return h2 @ P['W3'] + P['b3'], (x, a1, h1, a2, h2)


def main():
    t0 = time.time()
    d, t, y, star = load('train')
    vd, vt, vy, vstar = load('val')
    fe, vfe = features(d, t, star), features(vd, vt, vstar)
    X, vX = exposure(t)[:, None], exposure(vt)[:, None]
    Y = np.log1p(y * X / KNEE)
    li, lw = deck_corners(d); vli, vlw = deck_corners(vd)
    P['b3'][:] = Y.mean(0)
    m = {k: np.zeros_like(v) for k, v in P.items()}; v2 = {k: np.zeros_like(v) for k, v in P.items()}
    history = []
    for step in range(1, STEPS + 1):
        frac = step / STEPS
        lr_scale = 1.0 if frac < 0.55 else (0.3 if frac < 0.85 else 0.08)
        sel = rng.integers(0, len(d), BATCH)
        z, (x, a1, h1, a2, h2) = forward(fe[sel], li[sel], lw[sel])
        err = z - Y[sel]
        loss = float((err * err).mean())
        dz = (2.0 / err.size) * err
        g = {'W3': h2.T @ dz, 'b3': dz.sum(0)}
        da2 = (dz @ P['W3'].T) * (a2 > 0); g['W2'] = h1.T @ da2; g['b2'] = da2.sum(0)
        da1 = (da2 @ P['W2'].T) * (a1 > 0); g['W1'] = x.T @ da1; g['b1'] = da1.sum(0)
        dl = (da1 @ P['W1'].T)[:, :F]
        g['LAT'] = np.stack([np.bincount(li[sel].ravel(), weights=(lw[sel] * dl[:, j:j + 1]).ravel(), minlength=R * R) for j in range(F)], 1).astype(np.float32)
        for k in P:
            rate = (0.01 if k == 'LAT' else 0.003) * lr_scale
            m[k] = 0.9 * m[k] + 0.1 * g[k]; v2[k] = 0.99 * v2[k] + 0.01 * g[k] * g[k]
            P[k] -= (rate * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(v2[k] / (1 - 0.99 ** step)) + 1e-12)).astype(np.float32)
        if step % 250 == 0 or step == 1:
            vz, _ = forward(vfe, vli, vlw)
            pred = KNEE * np.expm1(np.minimum(vz, 14)) / vX
            rel = float(np.abs(pred - vy).sum() / vy.sum())
            tm = float(np.abs(tonemap(pred * vX) - tonemap(vy * vX)).mean() * 255)
            history.append({'step': step, 'loss': loss, 'rel': rel, 'tonemapped': tm})
            print(f'step {step:5d}  loss {loss:.4f}  held-out: {rel * 100:5.1f}% off, {tm:5.2f}/255 on screen  {time.time() - t0:5.0f}s', flush=True)
    export(history, time.time() - t0)


def export(history, secs):
    lo, hi = np.percentile(P['LAT'], 0.05, axis=0), np.percentile(P['LAT'], 99.95, axis=0)
    hi = np.maximum(hi, lo + 1e-4)
    q = np.clip(np.round((P['LAT'] - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)
    b3 = np.zeros(NOUT_PAD, np.float32); b3[:NOUT] = P['b3']
    ubo = np.concatenate([pack_layer(P['W1'], NIN, H), pack_layer(P['W2'], H, H), pack_layer(P['W3'], H, NOUT_PAD), P['b1'], P['b2'], b3]).astype(np.float32)
    head = {'R': R, 'features': F, 'latScale': ((hi - lo) / 255).tolist(), 'latOffset': lo.tolist(), 'knee': KNEE, 'hidden': H, 'inputs': NIN,
            'uboFloats': int(ubo.size), 'weights': int(sum(P[k].size for k in P if k != 'LAT')), 'textureValues': int(q.size),
            'trainSeconds': round(secs, 1), 'final': history[-1] if history else None}
    hj = json.dumps(head).encode()
    blob = [b'LPK1', struct.pack('<I', len(hj)), hj, b'\0' * ((-(8 + len(hj))) % 4), q.tobytes(), ubo.tobytes()]
    data = b''.join(blob)
    open(os.path.join(ROOT, 'game', 'sky.bin'), 'wb').write(data)
    json.dump({'head': head, 'history': history}, open(os.path.join(ROOT, 'data', 'sky_report.json'), 'w'), indent=1)
    print(f'sky.bin {len(data) / 1e6:.2f} MB ({head["weights"]:,} weights + {q.size:,} texture values) in {secs:.0f}s')


if __name__ == '__main__':
    main()
