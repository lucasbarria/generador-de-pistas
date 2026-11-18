# Mueve la salida (AC_PIT_n, AC_START_n, AC_HOTLAP_START_0) de un .kn5 de pista a un punto del recorrido (en metros desde la largada,
# según ai/fast_lane.ai), con la orientación del camino. Solo para pruebas de velocidad (recta larga). No toca mallas ni física.
# Uso: python3 kn5_mover_salida.py pista.kn5 fast_lane.ai metros salida.kn5 [lateral_m]
import struct, sys, math, numpy as np
src, ai, dm, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]; lat = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
d = bytearray(open(src, 'rb').read()); p = 6
def rd(fmt):
    global p; v = struct.unpack_from('<' + fmt, d, p); p += struct.calcsize('<' + fmt); return v if len(v) > 1 else v[0]
def s():
    global p; n = rd('i'); v = bytes(d[p:p + n]).decode('utf8', 'replace'); p += n; return v
ver = rd('i'); extra = rd('i') if ver > 5 else 0
for _ in range(rd('i')): rd('i'); s(); ln = rd('I'); p += ln
for _ in range(rd('i')):
    s(); s(); rd('B'); rd('?'); rd('i')
    for _ in range(rd('i')): s(); rd('f'); rd('9f')
    for _ in range(rd('i')): s(); rd('i'); s()
mats_end = p; dummies = {}
def node():
    global p
    cls = rd('i'); name = s(); nch = rd('i'); rd('?')
    if cls == 1: dummies[name] = p; rd('16f')
    elif cls in (2, 3):
        rd('3?'); nv = rd('I'); p += nv * 44; ni = rd('I'); p += ni * 2; rd('2I'); rd('2f'); rd('3f'); rd('f'); rd('?')
    for _ in range(nch): node()
node()
b = open(ai, 'rb').read(); n = struct.unpack_from('<i', b, 4)[0]
P = np.array([struct.unpack_from('<4f', b, 16 + i * 20) for i in range(n)])
def at(dist):
    i = int(np.clip(np.searchsorted(P[:, 3], dist), 1, n - 1)); a, c = P[i - 1], P[i]; t = (dist - a[3]) / max(1e-6, c[3] - a[3]); q = a + (c - a) * t
    j0, j1 = max(0, i - 5), min(n - 1, i + 5); dx, dz = P[j1, 0] - P[j0, 0], P[j1, 2] - P[j0, 2]; return q, math.atan2(dx, dz)
moved = []
for name, off in sorted(dummies.items()):
    if not (name.startswith('AC_PIT_') or name.startswith('AC_START_') or name.startswith('AC_HOTLAP_START')): continue
    M = np.array(struct.unpack_from('<16f', d, off)).reshape(4, 4); t0 = M[3, :3]
    k = int(np.argmin(np.hypot(P[:, 0] - t0[0], P[:, 2] - t0[2]))); _, h0 = at(P[k, 3])
    idx = int(name.rsplit('_', 1)[1]) if name.rsplit('_', 1)[1].isdigit() else 0
    q, h1 = at(dm - idx * 12.0); yaw = h1 - h0; c, sn = math.cos(yaw), math.sin(yaw)
    Ry = np.array([[c, 0, -sn], [0, 1, 0], [sn, 0, c]])
    R = M[:3, :3] @ Ry
    nx, nz = math.cos(h1), -math.sin(h1)
    M[:3, :3] = R; M[3, :3] = [q[0] + nx * lat, q[1] + 0.6, q[2] + nz * lat]
    struct.pack_into('<16f', d, off, *M.reshape(-1)); moved.append((name, round(P[k, 3], 1), round(dm - idx * 12.0, 1), round(math.degrees(yaw), 1)))
open(out, 'wb').write(d); print(moved)
