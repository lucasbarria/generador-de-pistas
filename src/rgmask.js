// ---------- MÁSCARAS DEL CAMINO V3 (Etapa 4) ----------
// Dónde va cada parte del camino de tierra: huellas compactadas, lomo central, cordones de grava, manchones de grava
// media y canto grueso, banquina de tierra y pasto. Es la misma receta de las máscaras V3 de Blender
// (V3/mascaras_camino.py), pero calculada sobre la traza: s = metros desde el eje (+ izquierda), d = metros a lo largo,
// hw = medio ancho del camino en ese punto. No se repite (no hay período) y no usa ninguna imagen: sirve para
// cualquier camino. La pintura de la tira (RGLIB.color) y la deformación de la malla (RELIEF.at) leen de acá, así la
// huella pintada y la hundida son la misma.
// Todos los anchos/distancias salen de PHYS.mascaras (config/parametros_fisicos.json): son PROVISIONALES.
const RGMASK = (() => {
  const h32 = (x, y, s) => { let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0; h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const vnz = (x, y, s) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h32(i, j, s), b = h32(i + 1, j, s), c = h32(i, j + 1, s), e = h32(i + 1, j + 1, s); return a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy; };
  // ruido fractal crudo (0..1): `scale` = tamaño de la celda más grande en metros (como en el script de Blender)
  const fbmRaw = (x, y, scale, oct, rough, seed) => { let acc = 0, amp = 1, tot = 0, s = scale;
    for (let o = 0; o < oct; o++) { acc += amp * vnz(x / s, y / s, seed + o * 101); tot += amp; amp *= rough; s /= 2; } return acc / tot; };
  // normalización como en numpy (media 0,5 y desvío 0,16): se mide una vez por combinación, con una muestra fija
  const NORM = new Map();
  const norm = (scale, oct, rough, warp, seed) => { const k = `${scale}|${oct}|${rough}|${warp}|${seed}`; let v = NORM.get(k); if (v) return v;
    let m = 0, m2 = 0; const N = 3000; for (let i = 0; i < N; i++) { const x = (h32(i, 1, 77) - 0.5) * 40, y = h32(i, 2, 77) * 400, z = raw(x, y, scale, oct, rough, warp, seed); m += z; m2 += z * z; }
    m /= N; v = { m, sd: Math.sqrt(Math.max(1e-9, m2 / N - m * m)) }; NORM.set(k, v); return v; };
  const raw = (x, y, scale, oct, rough, warp, seed) => { if (warp > 0) { const w1 = fbmRaw(x, y, scale * 1.7, 3, 0.5, seed + 7001), w2 = fbmRaw(x + 31.3, y, scale * 1.7, 3, 0.5, seed + 7002);
      x += warp * scale * (w1 - 0.5) * 2; y += warp * scale * (w2 - 0.5) * 2; } return fbmRaw(x, y, scale, oct, rough, seed); };
  const vnoiseG = (x, y, scale, oct, rough, warp, seed) => { const n = norm(scale, oct, rough, warp, seed); return 0.5 + (raw(x, y, scale, oct, rough, warp, seed) - n.m) / n.sd * 0.16; };
  // ruido 1D a lo largo (igual en todo el ancho), centrado, desvío ~1
  const NY = new Map();
  const vY = (y, scale, seed) => { let n = NY.get(scale + '|' + seed); const f = yy => { let acc = 0, amp = 1, tot = 0, c = scale; for (let o = 0; o < 3; o++) { acc += amp * vnz(yy / c, 0.5, seed + o * 31); tot += amp; amp *= 0.5; c /= 2; } return acc / tot; };
    if (!n) { let m = 0, m2 = 0; for (let i = 0; i < 2000; i++) { const z = f(i * 1.37); m += z; m2 += z * z; } m /= 2000; n = { m, sd: Math.sqrt(m2 / 2000 - m * m) }; NY.set(scale + '|' + seed, n); }
    return Math.max(-2, Math.min(2, (f(y) - n.m) / n.sd)); }; // recortado a ±2 desvíos: sin anchos casi nulos
  const ss = (v, a, b) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const c0 = n => (n - 0.5) / 0.16 * 0.5;
  const DEF = { separacion_huellas: 1.7, ancho_huella: 0.62, corrimiento_huella: 0.18, variacion_ancho: 0.4, intensidad_huellas: 1, grava_cruza_huella: 0.5, halo_tierra_m: 0.22,
    lomo_medio_ancho: 0.42, cordon_medio_ancho: 0.5, cordon_dist_borde: 0.6, canto_grueso: 0.9, grava_manchones: 0.8, banquina_ancho: 0.5, matas: 0.5,
    irregularidad_borde: 0.18, serpenteo_borde: 0.25, semilla: 7 };
  // ---------- TIPOS DE PISO (Etapa 5): pedregoso / ripio suelto ----------
  // FL.pts: cambios de piso ordenados [{ d, from, to, len, irr }]; FL.start: piso al principio; FL.ed: tramos editados a mano
  // [{ d0, d1, type, len, irr }] que mandan sobre lo automático. pBase(d) = peso del piso pedregoso (0–1) en el eje.
  const FL = { start: 'ripio', pts: [], ed: [], adv: 0.25, irr: 0.6, len: 120,
    // sin el bloque "pisos" del archivo de parámetros los dos pisos son neutros (igual que la V4: sin piedras grandes, factores 1)
    P: { pedregoso: { piedras_grandes: 0, grava_suelta: 1, canto_grueso: 1, relieve_irregular: 1, cordones: 1 },
         ripio: { piedras_grandes: 0, grava_suelta: 1, canto_grueso: 1, relieve_irregular: 1, cordones: 1 } } };
  const wOf = t => t === 'pedregoso' ? 1 : 0;
  const ramp = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / ((b - a) || 1e-9))); return t * t * (3 - 2 * t); };
  FL.pBase = d => { let w = wOf(FL.start), irr = FL.irr;
    for (const c of FL.pts) { const L = Math.max(1, c.len ?? FL.len), t = ramp(d, c.d - L / 2, c.d + L / 2); if (t > 0) { w = wOf(c.from) + (wOf(c.to) - wOf(c.from)) * t; if (t < 1) irr = c.irr ?? FL.irr; } }
    for (const e of FL.ed) { const L = Math.max(1, e.len ?? FL.len), t = Math.min(ramp(d, e.d0 - L / 2, e.d0 + L / 2), 1 - ramp(d, e.d1 - L / 2, e.d1 + L / 2)); if (t > 0) { w = w + (wOf(e.type) - w) * t; if (t < 1) irr = e.irr ?? FL.irr; } }
    return { w, irr }; };
  // curvas (Etapa 5): arrays cada 1 m que arma la app desde la curvatura del eje. b = banco de ripio afuera (0..1), bs = lado de
  // afuera (+1 izquierda, -1 derecha), cut = cuánto se corren las huellas hacia adentro y se marca el lomo (0..1), cs = lado de adentro
  const CV = { B: null, BS: null, CUT: null, CS: null, n: 0, shift: 0.35, ancho: 1.6 };
  const cvAt = d => { if (!CV.n) return null; const f = Math.max(0, Math.min(CV.n - 1.001, d)), i = Math.floor(f), u = f - i;
    return { b: CV.B[i] * (1 - u) + CV.B[i + 1] * u, bs: CV.BS[u < 0.5 ? i : i + 1], cut: CV.CUT[i] * (1 - u) + CV.CUT[i + 1] * u, cs: CV.CS[u < 0.5 ? i : i + 1] }; };
  const M = {
    P: { ...DEF }, CV,
    setCurves(o) { if (!o) { CV.n = 0; return; } Object.assign(CV, o); CV.n = o.B ? o.B.length : 0; },
    cvAt,
    // carga los valores del archivo de parámetros (cada entrada { valor, unidad, estado, ... } o un número)
    load(cfg) { if (!cfg) return this; for (const k in DEF) { const v = cfg[k]; const x = v && typeof v === 'object' ? v.valor : v; if (x != null && isFinite(+x)) this.P[k] = +x; } NORM.clear(); NY.clear(); return this; },
    FL,
    // configuración de pisos: el bloque "pisos" del archivo de parámetros
    loadFloors(cfg) { if (!cfg) return this; const v = (o, def) => o && typeof o === 'object' && 'valor' in o ? o.valor : (o ?? def);
      FL.len = +v(cfg.transicion_m, 120); FL.irr = +v(cfg.irregularidad, 0.6); FL.adv = +v(cfg.avance_por_bordes, 0.25); FL.start = (cfg.auto_cambios && cfg.auto_cambios.inicio) || v(cfg.tipo_por_defecto, 'ripio');
      for (const t of ['pedregoso', 'ripio']) if (cfg[t]) for (const k in FL.P[t]) { const x = +v(cfg[t][k]); if (isFinite(x)) FL.P[t][k] = x; } return this; },
    setFloors(start, pts, ed) { FL.start = start || FL.start; FL.pts = (pts || []).slice().sort((a, b) => a.d - b.d); FL.ed = ed || []; },
    // peso del piso pedregoso en (d, s): transición orgánica (manchones), y el ripio entra primero por el lomo y los cordones
    floorP(d, s, m) { const { w, irr } = FL.pBase(d); if (w <= 0.001 || w >= 0.999) return w; const k = 4 * w * (1 - w);
      const n = 0.65 * vnoiseG(s, d, 7, 4, 0.55, 1.0, 9101) + 0.35 * vnoiseG(s, d, 2.2, 3, 0.5, 0.6, 9102) - 0.5;
      let p = w + k * (irr * n * 1.9 + FL.adv * ((m ? m.trk : 0) * 0.6 - (m ? Math.max(m.ridge, m.windrow) : 0)));
      p = Math.max(0, Math.min(1, p)); const sh = ss(p, 0.3, 0.7); return p * (1 - irr * 0.6) + sh * irr * 0.6; },
    floorParam(k, p) { return FL.P.ripio[k] + (FL.P.pedregoso[k] - FL.P.ripio[k]) * p; },
    // máscaras en (d, s) para un camino de medio ancho hw. Devuelve valores 0..1:
    //  trk huellas compactadas · loose grava media (manchones, lomo, cordón) · coarse canto grueso · ridge lomo · windrow cordón
    //  soil banquina de tierra (fuera de la calzada) · veg pasto y matas · inroad dentro de la calzada · tc centro de la huella (m)
    // geo = true: versión para la MALLA (detalle fino suavizado: la malla tiene una columna cada ~0,35 m y una sección cada 0,5 m;
    // los bordes de manchas de pocos cm, que en la pintura están bien, en la malla serían escalones)
    at(d, s, hw, geo) {
      const P = this.P, sd = (P.semilla | 0) * 1000, X = s, Y = d, vnoise2 = geo ? (x, y, sc, oct, r, w, se) => vnoiseG(x, y, Math.max(sc, 1.2), Math.min(oct, 2), r, w * 0.3, se) : vnoiseG;
      // el ancho de la huella y su separación no pueden pasar el ancho del camino (caminos angostos)
      const sep = Math.min(P.separacion_huellas, Math.max(0.6, hw * 2 - 1.2)), hw0 = hw;
      const meander = vY(Y, 18, sd + 1) * 0.5 * P.serpenteo_borde;
      const rag = c0(vnoise2(X, Y, 0.45, 6, 0.55, 0.8, sd + 2)) * P.irregularidad_borde;
      const ax = Math.abs(X) + meander + rag, inroad = ss(ax, hw0 + 0.15, hw0 - 0.25);
      const cv = cvAt(d), cut = cv ? cv.cut : 0, sh = cv ? cv.cut * CV.shift * cv.cs : 0, XT = X - sh; // en curva las huellas se corren hacia adentro
      let trkMax = 0, haloMax = 0; const wd = [];
      for (const [side, sg] of [[1, 1], [2, -1]]) {
        const wander = vY(Y, 11, sd + 10 + side) * 0.5 * P.corrimiento_huella, c = sep / 2 + wander;
        const jit = c0(vnoise2(X, Y, 0.22, 4, 0.55, 1.2, sd + 12 + side)) * 0.12, dd = Math.abs(XT * sg + jit - c);
        const hwT = P.ancho_huella / 2 * (1 + vY(Y, 21, sd + 14 + side) * 0.5 * P.variacion_ancho);
        const core = geo ? ss(dd, hwT + 0.3, Math.max(0, hwT - 0.1)) : ss(dd, hwT + 0.16, hwT), inten = Math.max(0.55, Math.min(1, 0.8 + vY(Y, 27, sd + 16 + side) * 0.12));
        haloMax = Math.max(haloMax, ss(dd, hwT + 0.16 + P.halo_tierra_m, hwT + 0.05)); trkMax = Math.max(trkMax, core * inten); wd.push({ wander, c });
      }
      const holes = geo ? ss(vnoise2(X, Y, 1.1, 5, 0.55, 1.6, sd + 20), 0.45 - 0.08 * P.grava_cruza_huella, 0.95) : ss(vnoise2(X, Y, 1.1, 5, 0.55, 1.6, sd + 20), 0.62 - 0.08 * P.grava_cruza_huella, 0.67);
      let trk = Math.max(0, Math.min(1, trkMax * (1 - 0.9 * holes * (1 - 0.6 * cut)) * P.intensidad_huellas * (1 + 0.15 * cut) * inroad)); // en curva: huellas más limpias
      const mid = (wd[0].wander - wd[1].wander) * 0.5, dr = Math.abs(XT + c0(vnoise2(X, Y, 0.3, 4, 0.55, 1.0, sd + 21)) * 0.12 - mid);
      const rw = P.lomo_medio_ancho * (1 + vY(Y, 14, sd + 22) * 0.25) * (0.8 + 0.45 * cut), ridge = Math.max(0, Math.min(1, ss(dr, geo ? rw + 0.1 : rw, geo ? Math.max(0, rw - 0.3) : rw * 0.25) * (0.35 + 0.9 * vnoise2(X, Y, 1.6, 4, 0.55, 0.8, sd + 23)) * (0.85 + 0.3 * cut))); // lomo más angosto en recta, más marcado en curva
      const wc = hw0 - (P.cordon_dist_borde + vY(Y, 9, sd + 24) * 0.12), ww = P.cordon_medio_ancho * (1 + vY(Y, 13, sd + 25) * 0.3);
      const windrow = Math.max(0, Math.min(1, ss(Math.abs(ax - wc), geo ? ww + 0.1 : ww, geo ? Math.max(0, ww - 0.3) : ww * 0.2) * (0.25 + 1.1 * vnoise2(X, Y, 1.3, 5, 0.55, 1.0, sd + 26))));
      // banco de ripio suelto afuera de la curva (foto 6885): pegado al borde de afuera, se pierde hacia el centro con borde irregular
      let bank = 0, bankH = 0; if (cv && cv.b > 0.02) { const e = hw0 - X * cv.bs, BW = CV.ancho * (0.85 + 0.3 * vY(Y, 17, sd + 41)) * (0.35 + 0.65 * Math.min(1, cv.b * 1.5));
        bank = Math.max(0, Math.min(1, Math.min(1, 0.45 + 0.8 * cv.b) * ss(e + c0(vnoise2(X, Y, 0.8, 4, 0.55, 1.0, sd + 42)) * 0.35 * BW, BW, BW * 0.2) * (0.8 + 0.4 * vnoise2(X, Y, 1.4, 3, 0.55, 0.6, sd + 43)) * inroad)); }
      if (bank > 0) { trk *= 1 - 0.9 * bank; bankH = bank * Math.min(1, cv.b * 1.3); } // en curvas abiertas el banco es angosto y bajo
      const halo = Math.max(0, Math.min(1, haloMax * (0.35 + 0.9 * vnoise2(X, Y, 0.7, 4, 0.55, 0.5, sd + 33)) * inroad)), notrk = Math.max(0, 1 - Math.max(trk, 0.7 * halo));
      const fp = this.floorP(d, s, { trk, ridge, windrow }), fq = k => this.floorParam(k, fp); // peso del piso pedregoso y parámetros mezclados
      const gpatch = geo ? ss(vnoise2(X, Y, 2.6, 5, 0.55, 1.2, sd + 27), 0.5 - 0.2 * P.grava_manchones, 0.85) : ss(vnoise2(X, Y, 2.6, 5, 0.55, 1.2, sd + 27), 0.66 - 0.2 * P.grava_manchones, 0.68);
      const cpatch = geo ? ss(vnoise2(X, Y, 0.9, 5, 0.55, 1.5, sd + 28), 0.55 - 0.08 * P.canto_grueso, 0.95) : ss(vnoise2(X, Y, 0.9, 5, 0.55, 1.5, sd + 28), 0.70 - 0.08 * P.canto_grueso, 0.76);
      const loose = Math.max(0, Math.min(1, Math.max(Math.max(gpatch, 0.9 * ridge, 0.9 * windrow) * notrk * inroad * fq('grava_suelta'), 0.95 * bank)));
      const coreC = Math.max(ss(windrow, 0.2, 0.6) * P.canto_grueso, ss(ridge, 0.35, 0.75) * P.canto_grueso * 0.8);
      const coarse = Math.max(0, Math.min(1, Math.max(Math.max(coreC, cpatch * P.canto_grueso * 0.9) * notrk * inroad * fq('canto_grueso'), bank * 0.55 * fq('canto_grueso'))));
      // cantos grandes y rocas claras sueltas (piso pedregoso, foto 6902): manchas de 10–20 cm repartidas, menos en las huellas
      const rk = fq('piedras_grandes'), rocks = rk > 0.01 ? Math.max(0, Math.min(1, ss(vnoise2(X, Y, 0.32, 3, 0.5, 0.5, sd + 40), 0.80 - 0.14 * rk - (geo ? 0.1 : 0), 0.84 - 0.14 * rk + (geo ? 0.1 : 0)) * (1 - 0.7 * trk) * inroad * Math.min(1, rk / 0.5) * (1 + 0.8 * bank))) : 0; // en el pedregoso el banco tiene más piedras grandes
      const sb = P.banquina_ancho * (1 + vY(Y, 7, sd + 29) * 0.35), outside = 1 - inroad;
      const grass0 = ss(ax + c0(vnoise2(X, Y, 0.9, 5, 0.55, 1.4, sd + 30)) * 0.3, hw0 + sb, hw0 + sb + 0.35);
      const tufts = ss(vnoise2(X, Y, 0.18, 3, 0.5, 0.6, sd + 31), 0.62 - 0.08 * P.matas, 0.66) * outside;
      const bald = ss(vnoise2(X, Y, 1.2, 5, 0.55, 1.0, sd + 32), 0.76, 0.80);
      const veg = Math.max(0, Math.min(1, Math.max(grass0 * (1 - 0.85 * bald), 0.95 * tufts) * outside));
      return { trk, loose, coarse, rocks, fp, bank, bankH, cut, ridge: ridge * inroad, windrow: windrow * inroad, soil: outside, veg, inroad, tc: sep / 2 };
    },
    // grilla precalculada (para pintar millones de píxeles): canales a `res` m, lectura bilineal
    grid(d0, len, HW, hwAt, res = 0.08) {
      const nx = Math.ceil(2 * HW / res) + 2, ny = Math.ceil(len / res) + 2, K = ['trk', 'loose', 'coarse', 'rocks', 'fp', 'bank', 'ridge', 'windrow', 'soil', 'veg', 'inroad'], G = K.map(() => new Float32Array(nx * ny));
      for (let j = 0; j < ny; j++) { const d = d0 + j * res, hw = hwAt(d); for (let i = 0; i < nx; i++) { const s = -HW + i * res, m = this.at(d, s, hw); for (let k = 0; k < K.length; k++) G[k][j * nx + i] = m[K[k]]; } }
      return (d, s) => { const fx = Math.max(0, Math.min(nx - 1.001, (s + HW) / res)), fy = Math.max(0, Math.min(ny - 1.001, (d - d0) / res)), i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, o = {};
        for (let k = 0; k < K.length; k++) { const g = G[k], a = j * nx + i; o[K[k]] = (g[a] * (1 - u) + g[a + 1] * u) * (1 - v) + (g[a + nx] * (1 - u) + g[a + nx + 1] * u) * v; } return o; };
    },
    // cobertura media en un tramo recto de prueba (24 × 100 m como el de Blender): sirve para validar contra las máscaras V3
    stats(hw = 3.5, len = 100, res = 0.1) { const S = { trk: 0, loose: 0, coarse: 0, soil: 0, veg: 0 }; let n = 0;
      for (let d = res / 2; d < len; d += res) for (let s = -12 + res / 2; s < 12; s += res) { const m = this.at(d, s, hw); for (const k in S) S[k] += m[k]; n++; }
      for (const k in S) S[k] /= n; return S; },
  };
  return M;
})();
if (typeof module !== 'undefined') module.exports = RGMASK;
