# Qué superficie física de AC hay debajo de cada rueda: cruza los puntos de contacto que registra la app rg_telemetria
# (TyreContactPoint por rueda) con las mallas físicas del .kn5 (nombre <número><CLAVE>), por rayo vertical.
# Uso: python3 ac_superficie_ruedas.py pista.kn5 telemetria.csv salida.csv
import struct, sys, re, csv, collections, numpy as np
kn5, tel, out = sys.argv[1:4]
d = open(kn5, 'rb').read(); p = 6
def rd(fmt):
    global p; v = struct.unpack_from('<' + fmt, d, p); p += struct.calcsize('<' + fmt); return v if len(v) > 1 else v[0]
def s():
    global p; n = rd('i'); v = d[p:p + n].decode('utf8', 'replace'); p += n; return v
ver = rd('i'); (rd('i') if ver > 5 else 0)
for _ in range(rd('i')): rd('i'); s(); ln = rd('I'); p += ln
for _ in range(rd('i')):
    s(); s(); rd('B'); rd('?'); rd('i')
    for _ in range(rd('i')): s(); rd('f'); rd('9f')
    for _ in range(rd('i')): s(); rd('i'); s()
tris = []  # (key, v0, v1, v2)
def node(M):
    cls = rd('i'); name = s(); nch = rd('i'); rd('?')
    if cls == 1: M = np.array(rd('16f')).reshape(4, 4) @ M
    elif cls in (2, 3):
        rd('3?'); nv = rd('I'); vb = np.frombuffer(d, '<f4', nv * 11, p).reshape(nv, 11); globals()['p'] += nv * 44
        ni = rd('I'); idx = np.frombuffer(d, '<u2', ni, p).reshape(-1, 3); globals()['p'] += ni * 2
        rd('2I'); rd('2f'); rd('3f'); rd('f'); rd('?')
        m = re.match(r'^\d+([A-Z_]+)$', name)
        if m:
            V = np.c_[vb[:, :3], np.ones(nv)] @ M; tris.append((m.group(1), V[idx][:, :, :3]))
    for _ in range(nch): node(M)
node(np.eye(4))
K = np.concatenate([[k] * len(t) for k, t in tris]); T = np.concatenate([t for _, t in tris])
G = collections.defaultdict(list); C = 4.0
mn = T[:, :, [0, 2]].min(1); mx = T[:, :, [0, 2]].max(1)
for i in range(len(T)):
    for gx in range(int(mn[i, 0] // C), int(mx[i, 0] // C) + 1):
        for gz in range(int(mn[i, 1] // C), int(mx[i, 1] // C) + 1): G[(gx, gz)].append(i)
def under(x, y, z):
    best = None
    for i in G.get((int(x // C), int(z // C)), []):
        a, b, c = T[i]; v0, v1, v2 = b - a, c - a, np.array([x, 0, z]) - a
        den = v0[0] * v1[2] - v1[0] * v0[2]
        if abs(den) < 1e-9: continue
        u = (v2[0] * v1[2] - v1[0] * v2[2]) / den; w = (v0[0] * v2[2] - v2[0] * v0[2]) / den
        if u < -1e-4 or w < -1e-4 or u + w > 1 + 1e-4: continue
        h = a[1] + u * v0[1] + w * v1[1]
        if best is None or abs(h - y) < abs(best[1] - y): best = (K[i], h)
    return best
rows = list(csv.DictReader(open(tel)))
with open(out, 'w', newline='') as f:
    W = csv.writer(f); W.writerow(['t', 'pos', 'kmh'] + [f'sup_{w}' for w in ('FL', 'FR', 'RL', 'RR')] + [f'dh_{w}' for w in ('FL', 'FR', 'RL', 'RR')])
    for r in rows:
        if float(r['kmh']) < 1: continue
        res = [under(float(r['cx_' + w]), float(r['cy_' + w]), float(r['cz_' + w])) for w in ('FL', 'FR', 'RL', 'RR')]
        W.writerow([r['t'], r['pos'], r['kmh']] + [x[0] if x else 'NINGUNA' for x in res] + [round(float(r['cy_' + w]) - x[1], 3) if x else '' for w, x in zip(('FL', 'FR', 'RL', 'RR'), res)])
print('mallas físicas', len(tris), 'triángulos', len(T))
