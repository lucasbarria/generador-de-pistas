# -*- coding: utf-8 -*-
"""Texturas con transparencia para RBR: relleno de color bajo el alfa y DDS con mipmaps (DXT5 o DXT1 de 1 bit).

Problema que corrige: donde el alfa es 0 el generador deja el color en NEGRO. Si el juego no aplica el alfa
(o lo filtra en los mipmaps), ese negro aparece como un cuadrado o un borde oscuro alrededor de matas,
alambrados y carteles. Rellenar el color bajo el alfa con el de los píxeles visibles vecinos no cambia
el aspecto donde la textura es opaca (los píxeles con alfa > 0 quedan idénticos).

Uso (sin Blender):  python dds_alfa.py entrada.dds salida.dds [--dxt1]
"""
import struct
import sys
import io

import numpy as np
from PIL import Image


def rellenar_rgb(rgba, umbral=8, pasos=64):
    """Extiende el color de los píxeles visibles (alfa > umbral) hacia los transparentes. El alfa no cambia."""
    a = rgba.astype(np.float32)
    rgb, al = a[..., :3].copy(), a[..., 3]
    ok = al > umbral
    if not ok.any():
        return rgba.copy()
    for _ in range(pasos):
        if ok.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(ok.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            okS = np.roll(np.roll(ok, dy, 0), dx, 1)
            acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * okS[..., None]
            cnt += okS
        nuevo = (~ok) & (cnt > 0)
        rgb[nuevo] = acc[nuevo] / cnt[nuevo][:, None]
        ok = ok | nuevo
    if not ok.all():  # lo que quedó lejos: color medio de lo visible
        rgb[~ok] = a[..., :3][al > umbral].mean(0)
    out = rgba.copy()
    out[..., :3] = np.clip(rgb + 0.5, 0, 255).astype(np.uint8)
    out[al > umbral, :3] = rgba[al > umbral, :3]  # lo visible, idéntico
    return out


def _bloques(img, fmt):
    b = io.BytesIO()
    img.save(b, format="DDS", pixel_format=fmt)
    return b.getvalue()[128:]


def guardar_dds(rgba, ruta, fmt="DXT5"):
    """DDS con cadena completa de mipmaps. Los mipmaps del alfa se calculan premultiplicados (sin halo oscuro)."""
    h, w = rgba.shape[:2]
    niveles, datos = 0, b""
    cur = rgba
    while True:
        datos += _bloques(Image.fromarray(cur, "RGBA"), fmt)
        niveles += 1
        if cur.shape[0] <= 4 or cur.shape[1] <= 4:
            break
        f = cur.astype(np.float32)
        al = f[..., 3:4] / 255.0
        pm = f[..., :3] * al
        H2, W2 = cur.shape[0] // 2, cur.shape[1] // 2
        red = lambda x: (x[0::2, 0::2] + x[1::2, 0::2] + x[0::2, 1::2] + x[1::2, 1::2])[:H2, :W2] / 4
        a2 = red(al)
        c2 = np.where(a2 > 1e-3, red(pm) / np.maximum(a2, 1e-3), red(f[..., :3]))
        nxt = np.dstack([c2, a2 * 255]).clip(0, 255).astype(np.uint8)
        if fmt == "DXT1":  # 1 bit: conserva la cobertura del nivel (sin que la mata se borre de lejos)
            nxt[..., 3] = np.where(nxt[..., 3] >= 100, 255, 0)
        cur = nxt
    blk = 8 if fmt == "DXT1" else 16
    hdr = bytearray(128)
    hdr[0:4] = b"DDS "
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000
    struct.pack_into("<IIIIIII", hdr, 4, 124, flags, h, w, max(1, w // 4) * max(1, h // 4) * blk, 0, niveles)
    struct.pack_into("<II", hdr, 76, 32, 0x4 | (0x1 if fmt == "DXT1" else 0))
    hdr[84:88] = fmt.encode()
    struct.pack_into("<IIII", hdr, 108, 0x1000 | 0x8 | 0x400000, 0, 0, 0)
    with open(ruta, "wb") as fh:
        fh.write(bytes(hdr) + datos)
    return niveles


def leer_rgba(ruta):
    return np.asarray(Image.open(ruta).convert("RGBA")).copy()


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    fmt = "DXT1" if "--dxt1" in sys.argv else "DXT5"
    px = rellenar_rgb(leer_rgba(src))
    if fmt == "DXT1":
        px[..., 3] = np.where(px[..., 3] >= 128, 255, 0)
    print(dst, guardar_dds(px, dst, fmt), "niveles")
