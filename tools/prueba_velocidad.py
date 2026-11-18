# Prueba automática de velocidad (Etapa 6 · calibración en AC, 18/11/2026)
# "Con el auto de referencia, la velocidad en la recta más larga está entre 130 y 150 km/h."
# Uso: python3 tools/prueba_velocidad.py <carpeta de la pista de AC>   (usa data/surfaces.ini y ai/fast_lane.ai)
# 1) Regla de superficies: en huellas, ripio normal, lomo y pedregoso DAMPING <= 0,006 y DIRT_ADDITIVE = 0 (con 1, AC sin CSP ensucia las cubiertas en ~250 m).
# 2) Modelo de masa puntual sobre la línea de IA (curvas, pendiente real) con el auto de referencia: VW Gol Power 2008
#    (101 CV, 990 kg + 75 kg de piloto, tracción delantera, cubiertas de calle). Todos los datos del auto son ESTIMADOS (ficha comercial),
#    el agarre lateral sale del FRICTION del ripio. El modelo se contrastó con AC: Abarth 500 + 290 kg en la recta de prueba dio 144 km/h
#    a 600 m (AC); el rendimiento efectivo ef=0,63 (transmisión + cambios + patinamiento) se ajustó para que el modelo dé lo mismo (ver --calibrar).
import sys, re, struct, math, json
import numpy as np
AUTO = dict(nombre='VW Gol Power 2008 (referencia)', P_cv=101, masa=990 + 75, CdA=0.34 * 1.95, Crr=0.022, ef=0.63, reparto_del=0.62, mu_cal=1.0)
K_DAMP = 9.7   # ESTIMADO_EN_AC: DAMPING 0,01 ≈ resistencia extra 0,097·m·g (recta de prueba, 18/11/2026)
ABARTH = dict(nombre='Abarth 500 EsseEsse + 290 kg (AC)', P_cv=160, masa=1025 + 75 + 290, CdA=0.33 * 2.05, Crr=0.022, ef=0.63, reparto_del=0.6, mu_cal=1.0)
def superficies(ini):
    S = {}
    for b in re.split(r'\n(?=\[SURFACE_)', open(ini, encoding='utf-8', errors='replace').read()):
        k = re.search(r'\nKEY=(\S+)', '\n' + b)
        if not k: continue
        g = lambda n, d=0: float((re.search(r'\n%s=([-\d.]+)' % n, '\n' + b) or [0, d])[1])
        S[k.group(1)] = dict(friction=g('FRICTION', 1), damping=g('DAMPING'), dirt=g('DIRT_ADDITIVE'), valida=g('IS_VALID_TRACK', 1))
    return S
def linea(ai):
    a = open(ai, 'rb').read(); n = struct.unpack_from('<4i', a)[1]; P = np.frombuffer(a, '<f4', n * 5, 16).reshape(n, 5)
    return P[:, 0], P[:, 1], P[:, 2], P[:, 3]
def perfil(x, y, z, D, car, mu):
    n = len(D); ds = np.maximum(np.diff(D), 1e-3)
    h = np.unwrap(np.arctan2(np.gradient(z), np.gradient(x))); k = np.abs(np.gradient(h) / np.maximum(np.gradient(D), 1e-3))
    k = np.convolve(k, np.ones(9) / 9, 'same'); g = 9.81
    vlat = np.sqrt(mu * car['mu_cal'] * g / np.maximum(k, 1e-5)); vlat = np.minimum(vlat, 90)
    pend = np.r_[np.diff(y) / ds, 0]; P = car['P_cv'] * 735.5 * car['ef']; m = car['masa']
    v = np.zeros(n); v[0] = 0.5
    for i in range(n - 1):   # aceleración (potencia, tracción delantera, aire, rodadura, pendiente)
        F = min(P / max(v[i], 3), mu * m * g * car['reparto_del']) - 0.5 * 1.2 * car['CdA'] * v[i] ** 2 - car['Crr'] * m * g - m * g * pend[i]
        v[i + 1] = min(math.sqrt(max(v[i] ** 2 + 2 * F / m * ds[i], 0.25)), vlat[i + 1])
    for i in range(n - 2, -1, -1):   # frenada (0,8·mu·g)
        v[i] = min(v[i], math.sqrt(v[i + 1] ** 2 + 2 * 0.8 * mu * g * ds[i]))
    return v * 3.6, 1 / np.maximum(k, 1e-5)
def recta_mas_larga(D, R, umbral=250):
    best = (0, 0, 0); s = None
    for i, r in enumerate(R):
        if r > umbral and s is None: s = i
        if (r <= umbral or i == len(R) - 1) and s is not None:
            if D[i] - D[s] > best[2]: best = (s, i, D[i] - D[s])
            s = None
    return best
def prueba(carpeta, lo=130, hi=150):
    S = superficies(carpeta + '/data/surfaces.ini'); x, y, z, D = linea(carpeta + '/ai/fast_lane.ai')
    RODADO = {'GRAVEL', 'LOOSE', 'GRAVELN', 'STONY', 'STONYN', 'STONYL', 'CLAY'}   # huellas, ripio normal, lomo, pedregoso (no banquina, banco ni cuneta)
    camino = {k: v for k, v in S.items() if k.replace('_', '') in RODADO}
    malas = {k: v for k, v in camino.items() if v['damping'] > 0.006 or v['dirt'] > 0}
    mu = min(v['friction'] for v in camino.values()) if camino else 0.8
    damp = float(np.mean([v['damping'] for v in camino.values()])) if camino else 0
    car = dict(AUTO, Crr=AUTO['Crr'] + K_DAMP * damp)   # DAMPING de AC como resistencia extra (medido en AC, ver arriba)
    vk, R = perfil(x, y, z, D, car, mu); s, e, L = recta_mas_larga(D, R); vmax = float(vk[s:e + 1].max())
    ok = not malas and lo <= vmax <= hi
    return dict(ok=ok, recta_m=[round(float(D[s])), round(float(D[e]))], largo_recta_m=round(float(L)), v_max_recta_kmh=round(vmax, 1), rango=[lo, hi],
                agarre_usado=mu, damping_medio=round(damp, 4), superficies_que_frenan_o_ensucian=sorted(malas), tiempo_tramo_s=round(float(np.sum(np.diff(D) / np.maximum(vk[1:] / 3.6, 0.5))), 1))
def calibrar(dist=600, solo=None):
    car = ABARTH; v = 0.5; s = 0; g = 9.81; P = car['P_cv'] * 735.5 * car['ef']; m = car['masa']
    while s < dist:
        F = min(P / max(v, 3), 0.85 * m * g * car['reparto_del']) - 0.5 * 1.2 * car['CdA'] * v * v - car['Crr'] * m * g
        v = math.sqrt(v * v + 2 * F / m * 1.0); s += 1
    return round(v * 3.6, 1)
def calibrar_varios(): return {d: calibrar(d) for d in (200, 400, 600)}
if __name__ == '__main__':
    if '--calibrar' in sys.argv: print('modelo, Abarth + 290 kg (AC midió 104 / 123 / 144 km/h a 200 / 400 / 600 m):', calibrar_varios()); sys.exit()
    r = prueba(sys.argv[1]); print(json.dumps(r, ensure_ascii=False)); sys.exit(0 if r['ok'] else 1)
