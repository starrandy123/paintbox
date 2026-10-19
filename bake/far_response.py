# How each material looks from far away, for the surface painter: the average of what its network answers over the material's own
# training points. The game blends a surface toward this once its pattern is smaller than a pixel (the GPU's averaged feature
# texels are not something the network ever saw, and decode into streaks at grazing angles). Writes it into game/surface.bin's
# header (head.far: per material, wInd, wSun, wEm); train_surface.py's export calls it too.
#   /Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13 -I bake/far_response.py
import json, os, struct, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, HERE)


def read_surface(path):
    buf = open(path, 'rb').read()
    assert buf[:4] == b'LPS1'
    hlen = struct.unpack('<I', buf[4:8])[0]
    head = json.loads(buf[8:8 + hlen])
    off = 8 + hlen; off += (-off) % 4
    L, R, F, FG = head['layers'], head['R'], head['features'], head['gridFeatures']
    n1 = head['n1']; cells = n1[0] * n1[1] * n1[2]
    lat0 = np.frombuffer(buf, np.uint8, L * R * R * 4, off); off += L * R * R * 4
    lat1 = np.frombuffer(buf, np.uint8, L * R * R * 4, off); off += L * R * R * 4
    gs = np.frombuffer(buf, np.uint8, cells * 4, off); off += cells * 4
    off += (-off) % 4
    ubo = np.frombuffer(buf, np.float32, head['uboFloats'], off)
    return buf, hlen, head, lat0, lat1, gs, ubo


def unpack_layer(flat, nin_pad, nout_pad):
    """the inverse of train.pack_layer: std140 mat4 blocks [out group][in group], column c = input c of the group"""
    W = np.zeros((nin_pad, nout_pad), np.float32); k = 0
    for o in range(nout_pad // 4):
        for i in range(nin_pad // 4):
            W[i * 4:(i + 1) * 4, o * 4:(o + 1) * 4] = flat[k:k + 16].reshape(4, 4); k += 16
    return W, k


def far_response(head, lat0, lat1, gs, ubo, samples=400000):
    import train_surface as T
    L, R = head['layers'], head['R']
    lat = np.concatenate([lat0.reshape(-1, 4), lat1.reshape(-1, 4)], 1).astype(np.float32) * np.array(head['latScale'], np.float32) + np.array(head['latOffset'], np.float32)
    grid = gs.reshape(-1, 4).astype(np.float32) * np.array(head['gsScale'], np.float32) + np.array(head['gsOffset'], np.float32)
    H, NIN = head['hidden'], head['inputs']
    W1, k = unpack_layer(ubo, NIN, H); W2, k2 = unpack_layer(ubo[k:], H, H); W3, k3 = unpack_layer(ubo[k + k2:], H, 12)
    rest = ubo[k + k2 + k3:]
    b1, b2, b3 = rest[:H], rest[H:2 * H], rest[2 * H:2 * H + 12]
    T.P['LAT'], T.P['GS'] = lat, grid
    T.P.update({'W1': W1, 'b1': b1, 'W2': W2, 'b2': b2, 'W3': W3[:, :9], 'b3': b3[:9]})
    tags = sorted(f[5:-6] for f in os.listdir(os.path.join(ROOT, 'data')) if f.startswith('surf_train') and f.endswith('_x.f32'))[:1]
    S = T.Set(tags)
    D = T.DynSet(60000, np.random.default_rng(31))
    out = []
    for mi in range(L):
        acc = []
        for src in (S, D):
            sel = np.nonzero(src.m == mi)[0][:samples]
            for s in range(0, len(sel), 65536):
                x, _ = T.inputs(src, sel[s:s + 65536])
                z, _ = T.forward(x)
                acc.append(np.logaddexp(0, z) * T.WS)
        w = np.concatenate(acc).mean(0) if acc else np.full(9, -1.0)
        out.append([round(float(v), 6) for v in w])
        print(f'  {head.get("names", [None] * L)[mi] or mi}: wInd {w[0:3].round(4)} wSun {w[3:6].round(4)} wEm {w[6:9].round(4)}', flush=True)
    return out


def write_header(path, buf, hlen, head):
    hj = json.dumps(head).encode()
    old = 8 + hlen; old += (-old) % 4
    new = [b'LPS1', struct.pack('<I', len(hj)), hj, b'\0' * ((-(8 + len(hj))) % 4)]
    open(path, 'wb').write(b''.join(new) + buf[old:])


if __name__ == '__main__':
    path = os.path.join(ROOT, 'game', 'surface.bin')
    buf, hlen, head, lat0, lat1, gs, ubo = read_surface(path)
    head['far'] = far_response(head, lat0, lat1, gs, ubo)
    write_header(path, buf, hlen, head)
    print('surface.bin: head.far written for', len(head['far']), 'materials')
