# -*- coding: utf-8 -*-
"""Chequeos automáticos ANTES de armar el tramo en RBR (Etapa 4). Sólo necesita Python 3 + numpy
(sirve el Python de Blender). Lee track_*.obj, track.mtl y rbr_datos.json de la carpeta del tramo.

Comprueba, a lo largo de toda la driveline (cada 0,5 m y en 7 posiciones a lo ancho de la calzada):
  1. continuidad: debajo de cada punto hay superficie de manejo con física (sin huecos)
  2. solapamientos: no hay dos superficies de manejo a alturas distintas en el mismo punto
  3. normales: la superficie de manejo mira hacia arriba
  4. escalones: no hay saltos de altura bruscos a lo largo ni a lo ancho (uniones de mallas)
  5. colisión: % de la traza cubierta por mallas con física, por tramos de 100 m
  6. texturas: todas las texturas del .mtl y de rbr_datos.json existen
Uso:  python chequeo_previo.py <carpeta_del_tramo>      → escribe chequeo_previo.json y chequeo_previo.txt
"""
import json
import math
import os
import re
import sys

import numpy as np

UMBRAL_SOLAPE = 0.03     # m: dos superficies de manejo separadas más que esto en el mismo punto = solapamiento
UMBRAL_ESCALON = 0.12    # m entre muestras a 0,5 m (a lo largo) o ~0,6 m (a lo ancho): más que esto = escalón
NORMAL_MIN = 0.5         # componente vertical mínima de la normal de la calzada
NO_MANEJO = ("WALL", "TRUNK", "ROCK")  # con colisión pero no son piso (postes, carteles, troncos, rocas)
POS_ANCHO = (-0.85, -0.6, -0.3, 0.0, 0.3, 0.6, 0.85)  # fracción del medio ancho


def leer_obj(carpeta, D):
    fis = {k: (v or {}).get("fis") for k, v in D.get("objetos", {}).items()}
    V, tris, obj_of = [], [], []
    nombres, mats = [], {}
    cur = None
    for fn in D.get("modelo", []):
        with open(os.path.join(carpeta, fn), encoding="utf-8", errors="replace") as f:
            for ln in f:
                c = ln[:2]
                if c == "v ":
                    p = ln.split()
                    V.append((float(p[1]), float(p[2]), float(p[3])))
                elif c == "f ":
                    if cur is None:
                        continue
                    idx = [int(t.split("/")[0]) for t in ln.split()[1:]]
                    idx = [i - 1 if i > 0 else len(V) + i for i in idx]
                    for k in range(1, len(idx) - 1):
                        tris.append((idx[0], idx[k], idx[k + 1]))
                        obj_of.append(cur)
                elif c == "o ":
                    nombres.append(ln[2:].strip())
                    f0 = fis.get(nombres[-1])
                    cur = len(nombres) - 1 if f0 and f0 not in NO_MANEJO else None
                elif ln.startswith("usemtl ") and nombres:
                    mats.setdefault(nombres[-1], ln.split(None, 1)[1].strip())
    V = np.array(V, dtype=np.float64)
    T = np.array(tris, dtype=np.int64).reshape(-1, 3)
    return V, T, np.array(obj_of, dtype=np.int64), nombres, fis, mats


def main(carpeta):
    D = json.load(open(os.path.join(carpeta, "rbr_datos.json"), encoding="utf-8"))
    res = {"carpeta": carpeta, "problemas": [], "avisos": []}
    # 6. texturas
    falt = [k for k, t in D.get("texturas", {}).items() if not os.path.exists(os.path.join(carpeta, t["dds"]))]
    mtl = os.path.join(carpeta, "track.mtl")
    if os.path.exists(mtl):
        for m in re.findall(r"map_Kd\s+(.+)", open(mtl, encoding="utf-8", errors="replace").read()):
            if not os.path.exists(os.path.join(carpeta, m.strip())):
                falt.append(m.strip())
    res["texturas_faltantes"] = falt
    if falt:
        res["problemas"].append(f"faltan {len(falt)} texturas: {', '.join(falt[:8])}")
    V, T, OBJ, nombres, fis, mats = leer_obj(carpeta, D)
    # OBJ: (x, altura, -y)
    P = np.stack([V[:, 0], -V[:, 2], V[:, 1]], 1)
    A, B, C = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    nrm = np.cross(B - A, C - A)
    ln = np.linalg.norm(nrm, axis=1) + 1e-12
    nz = nrm[:, 2] / ln
    def es_calzada(n):  # tiras del camino (no las piedras 3D con colisión: llevan el material 'stone')
        return bool(re.match(r"^\d+(GRAVEL|LOOSE|CLAY|MUD|ROAD|WET|SNOW|ICE)$", n)) and not str(mats.get(n, "")).startswith(("stone", "boulder"))
    camino = np.array([es_calzada(nombres[o]) for o in OBJ]) if len(OBJ) else np.zeros(0, bool)
    res["triangulos_con_fisica"] = int(len(T))
    res["triangulos_calzada"] = int(camino.sum())
    # grilla 2D de triángulos (celdas de 2 m)
    CS = 2.0
    mn = np.minimum(np.minimum(A, B), C)[:, :2]
    mx = np.maximum(np.maximum(A, B), C)[:, :2]
    grid = {}
    i0 = np.floor(mn / CS).astype(int)
    i1 = np.floor(mx / CS).astype(int)
    for t in range(len(T)):
        for gx in range(i0[t, 0], i1[t, 0] + 1):
            for gy in range(i0[t, 1], i1[t, 1] + 1):
                grid.setdefault((gx, gy), []).append(t)
    grid = {k: np.array(v) for k, v in grid.items()}

    def hits(x, y):
        c = grid.get((int(math.floor(x / CS)), int(math.floor(y / CS))))
        if c is None:
            return []
        a, b, cc = A[c], B[c], C[c]
        v0, v1, v2 = cc[:, :2] - a[:, :2], b[:, :2] - a[:, :2], np.array([x, y]) - a[:, :2]
        d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d02 = (v0 * v2).sum(1); d11 = (v1 * v1).sum(1); d12 = (v1 * v2).sum(1)
        den = d00 * d11 - d01 * d01
        ok = np.abs(den) > 1e-12
        den = np.where(ok, den, 1)
        u = (d11 * d02 - d01 * d12) / den
        v = (d00 * d12 - d01 * d02) / den
        ins = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6)
        out = []
        for j in np.nonzero(ins)[0]:
            z = a[j, 2] + u[j] * (cc[j, 2] - a[j, 2]) + v[j] * (b[j, 2] - a[j, 2])
            out.append((float(z), int(c[j])))
        return out

    # driveline remuestreada cada 0,5 m, con su medio ancho aproximado (de la calzada encontrada)
    dl = np.array(D["driveline"], dtype=np.float64)
    seg = np.hypot(np.diff(dl[:, 0]), np.diff(dl[:, 1]))
    cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]
    ds = np.arange(0, L, 0.5)
    xs = np.interp(ds, cum, dl[:, 0]); ys = np.interp(ds, cum, dl[:, 1])
    tx = np.gradient(xs); ty = np.gradient(ys); tl = np.hypot(tx, ty) + 1e-9; nx, ny = -ty / tl, tx / tl
    # medio ancho local de la calzada: desde el eje hacia cada lado, hasta donde hay malla de calzada (pasos de 0,1 m)
    def hw_local(i):
        out = []
        for sg in (1, -1):
            w = 0.0
            for k in range(1, 80):
                x, y = xs[i] + nx[i] * sg * k * 0.1, ys[i] + ny[i] * sg * k * 0.1
                if not any(camino[t] for _, t in hits(x, y)):
                    break
                w = k * 0.1
            out.append(w)
        return min(out)
    Z = np.full((len(ds), len(POS_ANCHO)), np.nan)
    HW = np.zeros(len(ds))
    huecos, solapes, normales_mal, sin_calzada = [], [], [], []
    for i, d in enumerate(ds):
        hw = HW[i] = hw_local(i)
        if hw < 1.0 and 1.0 <= d <= L - 1.0:  # el primer/último metro de la driveline puede caer justo en el borde de la malla
            sin_calzada.append(round(float(d), 1))
        for j, f in enumerate(POS_ANCHO):
            x, y = xs[i] + nx[i] * f * hw, ys[i] + ny[i] * f * hw
            h = hits(x, y)
            hc = [(z, t) for z, t in h if camino[t]]
            if not h:
                huecos.append((round(float(d), 1), f))
                continue
            if not hc:
                continue
            zz = [z for z, _ in hc]
            Z[i, j] = max(zz)
            if len(hc) > 1 and max(zz) - min(zz) > UMBRAL_SOLAPE:
                solapes.append((round(float(d), 1), f, round(max(zz) - min(zz), 3)))
            for z, t in hc:
                if nz[t] < NORMAL_MIN:
                    normales_mal.append((round(float(d), 1), f, round(float(nz[t]), 2)))
    res["medio_ancho_local_m"] = {"min": round(float(HW.min()), 2), "medio": round(float(HW.mean()), 2), "max": round(float(HW.max()), 2)}
    res["puntos_sin_calzada"] = sin_calzada[:50]
    if sin_calzada:
        res["problemas"].append(f"{len(sin_calzada)} puntos de la driveline sin calzada debajo (medio ancho < 1 m)")
    # 4. escalones
    dz_long = np.abs(np.diff(Z, axis=0))
    dz_lat = np.abs(np.diff(Z, axis=1))
    esc_l = [(round(float(ds[i]), 1), POS_ANCHO[j], round(float(dz_long[i, j]), 3)) for i, j in zip(*np.nonzero(np.nan_to_num(dz_long) > UMBRAL_ESCALON))]
    esc_t = [(round(float(ds[i]), 1), POS_ANCHO[j], round(float(dz_lat[i, j]), 3)) for i, j in zip(*np.nonzero(np.nan_to_num(dz_lat) > UMBRAL_ESCALON))]
    # 5. colisión por tramos de 100 m
    cub = []
    for k in range(int(math.ceil(L / 100))):
        m = (ds >= k * 100) & (ds < (k + 1) * 100)
        if m.any():
            cub.append(round(float(np.isfinite(Z[m]).mean() * 100), 1))
    res.update({
        "largo_driveline_m": round(float(L), 1), "muestras": int(Z.size),
        "cobertura_superficie_pct": round(float(np.isfinite(Z).mean() * 100), 2), "medio_ancho_usado_m": "local", "cobertura_por_100m_pct": cub,
        "huecos": huecos[:50], "n_huecos": len(huecos), "solapamientos": solapes[:50], "n_solapamientos": len(solapes),
        "normales_invertidas": normales_mal[:50], "n_normales_invertidas": len(normales_mal),
        "escalones_a_lo_largo": esc_l[:50], "n_escalones_largo": len(esc_l), "escalones_a_lo_ancho": esc_t[:50], "n_escalones_ancho": len(esc_t),
        "max_salto_largo_m": round(float(np.nanmax(dz_long)) if np.isfinite(dz_long).any() else 0, 3),
        "max_salto_ancho_m": round(float(np.nanmax(dz_lat)) if np.isfinite(dz_lat).any() else 0, 3),
        "umbrales": {"solape_m": UMBRAL_SOLAPE, "escalon_m": UMBRAL_ESCALON, "normal_min": NORMAL_MIN},
    })
    if huecos:
        res["problemas"].append(f"{len(huecos)} puntos sin superficie de manejo (huecos)")
    if solapes:
        res["problemas"].append(f"{len(solapes)} puntos con dos superficies de manejo superpuestas")
    if normales_mal:
        res["problemas"].append(f"{len(normales_mal)} puntos con la normal de la calzada invertida o muy inclinada")
    if esc_l or esc_t:
        res["problemas"].append(f"{len(esc_l)} escalones a lo largo y {len(esc_t)} a lo ancho (> {UMBRAL_ESCALON} m)")
    res["ok"] = not res["problemas"]
    json.dump(res, open(os.path.join(carpeta, "chequeo_previo.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with open(os.path.join(carpeta, "chequeo_previo.txt"), "w", encoding="utf-8") as f:
        f.write(f"CHEQUEO PREVIO A RBR — {'OK' if res['ok'] else 'CON PROBLEMAS'}\n")
        for k in ("largo_driveline_m", "muestras", "cobertura_superficie_pct", "n_huecos", "n_solapamientos", "n_normales_invertidas",
                  "n_escalones_largo", "n_escalones_ancho", "max_salto_largo_m", "max_salto_ancho_m", "triangulos_con_fisica", "triangulos_calzada"):
            f.write(f"  {k}: {res[k]}\n")
        f.write(f"  texturas faltantes: {len(falt)}\n  cobertura por 100 m (%): {cub}\n")
        for p in res["problemas"]:
            f.write(f"  PROBLEMA: {p}\n")
    return res


if __name__ == "__main__":
    r = main(sys.argv[1] if len(sys.argv) > 1 else ".")
    print(json.dumps({k: r[k] for k in ("ok", "cobertura_superficie_pct", "n_huecos", "n_solapamientos", "n_normales_invertidas", "n_escalones_largo", "n_escalones_ancho", "max_salto_largo_m", "max_salto_ancho_m", "problemas")}, ensure_ascii=False))
