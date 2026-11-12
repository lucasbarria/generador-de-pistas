// ===== Núcleo geométrico: no depende del navegador =====
const Core = (() => {
  const R = 6378137, D2R = Math.PI / 180;

  function makeProj(lat0, lon0) {
    const kx = Math.cos(lat0 * D2R) * R * D2R, ky = R * D2R;
    return {
      fwd: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
      inv: (x, y) => [lat0 + y / ky, lon0 + x / kx],
    };
  }

  function resample(pts, step, closed) {
    const P = closed ? pts.concat([pts[0]]) : pts.slice();
    const out = [P[0].slice()];
    let acc = 0;
    for (let i = 1; i < P.length; i++) {
      const [ax, ay] = P[i - 1], [bx, by] = P[i];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      let d = step - acc;
      while (d <= L) { const t = d / L; out.push([ax + (bx - ax) * t, ay + (by - ay) * t]); d += step; }
      acc = L - (d - step);
    }
    if (!closed) {
      const last = P[P.length - 1], lo = out[out.length - 1];
      if (Math.hypot(last[0] - lo[0], last[1] - lo[1]) > step * 0.3) out.push(last.slice());
    } else {
      const lo = out[out.length - 1];
      if (out.length > 2 && Math.hypot(lo[0] - out[0][0], lo[1] - out[0][1]) < step * 0.5) out.pop();
    }
    return out;
  }

  function smooth1D(a, r, closed, keepEnds) {
    const n = a.length; if (r < 1 || n < 3) return a.slice();
    const o = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        let j = i + k;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        s += a[j]; c++;
      }
      o[i] = s / c;
    }
    if (!closed && keepEnds) { o[0] = a[0]; o[n - 1] = a[n - 1]; }
    return o;
  }

  function smoothPts(C, r, closed, passes = 2) {
    let xs = C.map(p => p[0]), ys = C.map(p => p[1]);
    for (let p = 0; p < passes; p++) { xs = smooth1D(xs, r, closed, true); ys = smooth1D(ys, r, closed, true); }
    return xs.map((x, i) => [x, ys[i]]);
  }

  function tangents(C, closed) {
    const n = C.length, T = [];
    for (let i = 0; i < n; i++) {
      let a = i - 2, b = i + 2;
      if (closed) { a = (a + n) % n; b = b % n; } else { a = Math.max(0, a); b = Math.min(n - 1, b); }
      let dx = C[b][0] - C[a][0], dy = C[b][1] - C[a][1];
      const L = Math.hypot(dx, dy) || 1; T.push([dx / L, dy / L]);
    }
    return T;
  }

  function newMesh(name, mat) { return { name, mat, v: [], uv: [], f: [] }; }
  // v: [x(east), y(north), h(up)]

  // Malla en forma de cinta: secciones S[i] = array de columnas {x,y,h,u}
  function ribbonMeshes(sections, closed, baseName, mat, vScale, counter, chunk = 1500) {
    const meshes = [], n = sections.length;
    const segCount = closed ? n : n - 1;
    for (let s0 = 0; s0 < segCount; s0 += chunk) {
      const s1 = Math.min(segCount, s0 + chunk);
      const m = newMesh(`${counter.next()}${baseName}`, mat);
      const idx = new Map();
      const vid = (i, k) => {
        const key = i * 64 + k;
        if (idx.has(key)) return idx.get(key);
        const ii = i % n, c = sections[ii].cols[k];
        const vv = sections[ii].d / vScale + (i >= n ? sections[n - 1].d / vScale + sections[n - 1].step / vScale - sections[0].d / vScale : 0);
        m.v.push([c.x, c.y, c.h]); m.uv.push([c.u, vv]); if (c.s !== undefined) (m.ds || (m.ds = [])).push([sections[ii].d, c.s]);
        if (c.i !== undefined) { (m.ri || (m.ri = [])).push(c.i); (m.rs || (m.rs = [])).push(c.sc); }
        idx.set(key, m.v.length - 1); return m.v.length - 1;
      };
      for (let i = s0; i < s1; i++) {
        const A = sections[i % n], B = sections[(i + 1) % n];
        if (A.skip || B.skip) continue;
        const nc = A.cols.length;
        for (let k = 0; k < nc - 1; k++) {
          const a = vid(i, k), b = vid(i + 1, k), c = vid(i + 1, k + 1), d = vid(i, k + 1);
          m.f.push([a, b, c], [a, c, d]);
        }
      }
      if (m.f.length) meshes.push(m);
    }
    return meshes;
  }

  function counterFrom(start) { let i = start; return { next: () => i++ }; }
  const D2R_ = Math.PI / 180;
  function counters() { const c = {}; return k => { c[k] = (c[k] || 0) + 1; return c[k]; }; }
  const MAT = { DITCH: 'ditch', ROAD: 'asphalt', GRAVEL: 'gravel', CLAY: 'clay', WET: 'wet', LOOSE: 'loose', MUD: 'mud', SNOW: 'snow', ICE: 'ice', GRASS: 'grass', POWDER: 'powder' };

  // ---------- Perfil por puntos de control ----------
  // pts: [{d, h, gin?, gout?}] ordenados por d. mode: 'linear' | 'pchip' (suave, sin pasarse) | 'spline' (curva) |
  // 'parabola' (rectas de pendiente unidas con curvas verticales parabólicas de largo vc, como en el diseño vial).
  // gin / gout: pendiente forzada (m/m) al llegar y al salir de cada punto (en los modos suaves); si difieren hay quiebre.
  function profileInterp(pts, mode, vc) {
    const n = pts.length; if (!n) return () => 0; if (n === 1) return () => pts[0].h;
    const D = pts.map(p => p.d), Hh = pts.map(p => p.h), G = [];
    for (let i = 0; i < n - 1; i++) G.push((Hh[i + 1] - Hh[i]) / Math.max(1e-6, D[i + 1] - D[i]));
    const seg = d => { let lo = 0, hi = n - 1; if (d <= D[0]) return 0; if (d >= D[n - 1]) return n - 2; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; } return lo; };
    if (mode === 'linear') return d => { if (d <= D[0]) return Hh[0]; if (d >= D[n - 1]) return Hh[n - 1]; const i = seg(d); return Hh[i] + G[i] * (d - D[i]); };
    if (mode === 'parabola') {
      // largo de cada curva vertical: no más que el 90% del tramo recto más corto de los dos lados
      const Lv = pts.map((p, i) => i === 0 || i === n - 1 ? 0 : Math.min(vc || 30, 0.9 * (D[i] - D[i - 1]), 0.9 * (D[i + 1] - D[i])));
      return d => {
        if (d <= D[0]) return Hh[0]; if (d >= D[n - 1]) return Hh[n - 1];
        const i = seg(d);
        for (const k of [i, i + 1]) if (k > 0 && k < n - 1 && Lv[k] > 0 && Math.abs(d - D[k]) <= Lv[k] / 2) {
          const x = d - (D[k] - Lv[k] / 2); return Hh[k] - G[k - 1] * Lv[k] / 2 + G[k - 1] * x + (G[k] - G[k - 1]) * x * x / (2 * Lv[k]);
        }
        return Hh[i] + G[i] * (d - D[i]);
      };
    }
    // tangentes (Hermite cúbico): pchip = Fritsch-Carlson (no sobrepasa los puntos), spline = Catmull-Rom
    const Tin = new Array(n), Tout = new Array(n);
    for (let i = 0; i < n; i++) {
      let m;
      if (i === 0) m = G[0]; else if (i === n - 1) m = G[n - 2];
      else if (mode === 'spline') m = (Hh[i + 1] - Hh[i - 1]) / (D[i + 1] - D[i - 1]);
      else { const a = G[i - 1], b = G[i]; if (a * b <= 0) m = 0; else { const w1 = 2 * (D[i + 1] - D[i]) + (D[i] - D[i - 1]), w2 = (D[i + 1] - D[i]) + 2 * (D[i] - D[i - 1]); m = (w1 + w2) / (w1 / a + w2 / b); } }
      Tin[i] = pts[i].gin != null ? pts[i].gin : m; Tout[i] = pts[i].gout != null ? pts[i].gout : (pts[i].gin != null && pts[i].gout == null ? pts[i].gin : m);
    }
    return d => {
      if (d <= D[0]) return Hh[0]; if (d >= D[n - 1]) return Hh[n - 1];
      const i = seg(d), L = D[i + 1] - D[i], t = (d - D[i]) / L, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * Hh[i] + (t3 - 2 * t2 + t) * L * Tout[i] + (-2 * t3 + 3 * t2) * Hh[i + 1] + (t3 - t2) * L * Tin[i + 1];
    };
  }

  // ---------- Modo RUTA (tramo / circuito) ----------
  // o: pts, closed, width, hSmooth, height(x,y), lines,
  //    widthAt(d), bankAt(d,k)->grados (con signo de la curva aplicado afuera), offsetAt(d), smoothSecs[{d0,d1}], surfaceAt(d,hLocal)->KEY
  function buildRoute(o) {
    const step = 2, closed = !!o.closed;
    // geometría en planta (no cambia al editar alturas, peralte o ancho): se puede reutilizar entre ediciones en vivo
    const geoKey = o.cache ? o.cache.keyFn() : null;
    let C, T, dist, total, K, raw, CS, n, SLL, SLR, OFL, OFR;
    if (o.cache && o.cache.geo && o.cache.geo.key === geoKey) ({ C, T, dist, total, K, raw, CS, n, SLL, SLR, OFL, OFR } = o.cache.geo);
    else {
    C = resample(o.pts, step, closed);
    C = smoothPts(C, 3, closed, 2);
    if (o.shapeAt) { // ajustes de forma hechos a mano (arrastrando en 3D)
      let d = 0;
      C = C.map((p, i) => { if (i) d += Math.hypot(p[0] - C[i - 1][0], p[1] - C[i - 1][1]); const [dx, dy] = o.shapeAt(d); return [p[0] + dx, p[1] + dy]; });
    }
    C = resample(C, step, closed);
    n = C.length;
    T = tangents(C, closed);
    dist = [0]; for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(C[i][0] - C[i - 1][0], C[i][1] - C[i - 1][1]));
    total = dist[n - 1] + (closed ? Math.hypot(C[0][0] - C[n - 1][0], C[0][1] - C[n - 1][1]) : 0);
    // curvatura (1/m, positiva = gira a la izquierda)
    K = [];
    for (let i = 0; i < n; i++) {
      let a = i - 1, b = i + 1;
      if (closed) { a = (a + n) % n; b = b % n; } else { a = Math.max(0, a); b = Math.min(n - 1, b); }
      const ta = T[a], tb = T[b], ang = Math.atan2(ta[0] * tb[1] - ta[1] * tb[0], ta[0] * tb[0] + ta[1] * tb[1]);
      K.push(ang / Math.max(step, (b - a) * step));
    }
    K = smooth1D(smooth1D(K, 3, closed), 3, closed);
    // alturas
    raw = C.map(p => { const g = o.roadH ? o.roadH(p[0], p[1]) : null; return g != null ? g : o.height(p[0], p[1]); }); // altura del GPS si la hay
    // pendiente lateral del terreno real (positiva = el lado izquierdo es más alto): detecta laderas de montaña
    CS = C.map((p, i) => {
      const nx = -T[i][1], ny = T[i][0], a = o.height(p[0] + nx * 15, p[1] + ny * 15), b = o.height(p[0] - nx * 15, p[1] - ny * 15);
      return (a - b) / 30;
    });
    CS = smooth1D(smooth1D(CS, 8, closed), 8, closed);
    // pendiente de cada lado por separado (+ = el terreno sube al alejarse del camino): camino entre cerros, ladera, terraplén.
    // Se mide entre 10 y 28 m del eje: las dos muestras caen en el mismo tipo de cobertura, así la altura de las copas se cancela.
    // off = cuánto se aparta el modelo de elevación de ese plano a 10 m (sesgo de las copas), para restarlo cerca del camino.
    SLL = []; SLR = []; OFL = []; OFR = [];
    for (let i = 0; i < n; i++) {
      const p = C[i], nx = -T[i][1], ny = T[i][0], h0 = raw[i];
      for (const sd of [1, -1]) {
        const a = o.height(p[0] + sd * nx * 10, p[1] + sd * ny * 10), b = o.height(p[0] + sd * nx * 28, p[1] + sd * ny * 28), sl = (b - a) / 18;
        (sd > 0 ? SLL : SLR).push(sl); (sd > 0 ? OFL : OFR).push(a - (h0 + sl * 10));
      }
    }
    const clampS = A => smooth1D(smooth1D(A, 8, closed), 8, closed).map(v => Math.max(-0.6, Math.min(0.6, v)));
    SLL = clampS(SLL); SLR = clampS(SLR); OFL = smooth1D(OFL, 8, closed); OFR = smooth1D(OFR, 8, closed);
    if (o.cache) o.cache.geo = { key: geoKey, C, T, dist, total, K, raw, CS, n, SLL, SLR, OFL, OFR };
    }
    let hs = raw; const r = Math.max(1, Math.round((o.hSmooth || 0) / step / 2));
    for (let p = 0; p < 3; p++) hs = smooth1D(hs, r, closed, false);
    if (o.smoothSecs && o.smoothSecs.length) {
      let strong = hs; for (let p = 0; p < 4; p++) strong = smooth1D(strong, Math.max(8, r * 3), closed, false);
      const fe = 15;
      hs = hs.map((h, i) => {
        let wgt = 0; const d = dist[i];
        for (const s of o.smoothSecs) {
          const w = d < s.d0 ? 1 - (s.d0 - d) / fe : d > s.d1 ? 1 - (d - s.d1) / fe : 1;
          wgt = Math.max(wgt, Math.max(0, Math.min(1, w)));
        }
        return h * (1 - wgt) + strong[i] * wgt;
      });
    }
    if (o.profileApply) hs = hs.map((h, i) => o.profileApply(dist[i], h)); // perfiles por puntos de control
    if (o.offsetAt) hs = hs.map((h, i) => h + o.offsetAt(dist[i]));
    if (o.raise) hs = hs.map((h, i) => h + o.raise(C[i][0], C[i][1])); // rampas de acceso a puentes
    // ancho, peralte, superficie
    let W = dist.map(d => o.widthAt ? o.widthAt(d) : o.width);
    W = smooth1D(smooth1D(W, 4, closed), 4, closed);
    let SL = dist.map((d, i) => {
      const deg = o.bankAt ? o.bankAt(d, K[i]) : 0;
      if (typeof deg === 'object') return Math.tan(deg.abs * D2R_); // inclinación fija (+ = lado izquierdo más alto), también en rectas
      const side = Math.max(-1, Math.min(1, K[i] * 150));
      return -Math.tan(deg * D2R_) * side;
    });
    SL = smooth1D(smooth1D(SL, 4, closed), 4, closed);
    const SURF = dist.map((d, i) => o.surfaceAt ? o.surfaceAt(d, hs[i]) : 'ROAD');
    const segCount = closed ? n : n - 1;
    const crown = 0.02;
    const surfH = (i, s) => hs[i] + crown * (W[i] / 2 - Math.abs(s)) + SL[i] * s;
    // cunetas: 'auto' = a los dos lados salvo donde el terreno cae fuerte (terraplén), más honda del lado del cerro;
    // 'both' = siempre a los dos lados; 'none' = sin cunetas
    const mode = o.ditch || 'none';
    // humedad (0 = firme y seco, 1 = barro) y bosque (0 = campo abierto, 1 = bosque cerrado) en cada punto del eje
    const HUM = dist.map(d => o.humAt ? Math.max(0, Math.min(1, o.humAt(d))) : 0.3), FOR = dist.map(d => o.forestAt ? Math.max(0, Math.min(1, o.forestAt(d))) : 0.5);
    // hondonadas: el camino pasa más bajo que su entorno (±60 m) → junta agua
    const HO = (() => { let a = hs; for (let p = 0; p < 3; p++) a = smooth1D(a, 30, closed, false); return hs.map((h, i) => Math.max(0, Math.min(1, (a[i] - h - 0.15) / 0.8))); })();
    const WETP = HUM.map((h, i) => Math.max(h, HO[i] * 0.8));                     // humedad efectiva del camino
    // ruido suave a lo largo (determinista) para que las cunetas no sean iguales en todo el tramo
    const hsh = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
    const vn1 = (x, sd) => { const i0 = Math.floor(x), f = x - i0, t = f * f * (3 - 2 * f); return hsh(i0, sd) * (1 - t) + hsh(i0 + 1, sd) * t; };
    // cuneta: en el bosque, zanja cavada (0,38–0,6 m) más honda del lado del cerro; en campo húmedo, baja y ancha con agua (0,16–0,28 m)
    const autoD = (sl, i, sd) => { if (sl < -0.15) return 0; const v = 0.75 + 0.5 * vn1(dist[i] / 70, sd * 3 + 1), open = (1 - FOR[i]) * Math.min(1, WETP[i] * 1.6);
      const deep = (0.38 + 0.22 * Math.min(1, Math.max(0, (sl + 0.02) / 0.15))) * v, shallow = 0.16 + 0.12 * vn1(dist[i] / 40, sd * 5 + 2);
      return deep * (1 - open) + shallow * open; };
    // accesos y entradas (OSM + procedurales): la cuneta se corta y queda un paso de tierra a nivel
    const ACC = [];
    if (mode !== 'none') {
      for (const a of (o.accesses || [])) ACC.push({ d: a.d, sd: a.sd, w: a.w || 4, osm: true });
      if (o.procAccess !== false) for (let k = 0; k * 260 < total; k++) { const d = k * 260 + hsh(k, 7) * 200 + 30, sd = hsh(k, 8) < 0.5 ? 1 : -1;
        if (d > total - 40 || hsh(k, 9) > 0.32) continue; const i = Math.min(n - 1, Math.round(d / step)), sl = sd > 0 ? SLL[i] : SLR[i];
        if (Math.abs(sl) > 0.12 || FOR[i] > 0.85 || ACC.some(q => Math.abs(q.d - d) < 120)) continue; ACC.push({ d, sd, w: 3.4 + hsh(k, 10) * 1.2 }); }
    }
    const accCut = (i, sd) => { let c = 0; for (const a of ACC) if (a.sd === sd) { const x = Math.abs(dist[i] - a.d) - a.w / 2; c = Math.max(c, x <= 0 ? 1 : Math.max(0, 1 - x / 3)); } return c; };
    let DLs = SLL.map((sl, i) => mode === 'both' ? 0.45 : mode === 'auto' ? autoD(sl, i, 1) : 0);
    let DRs = SLR.map((sl, i) => mode === 'both' ? 0.45 : mode === 'auto' ? autoD(sl, i, -1) : 0);
    DLs = smooth1D(DLs, 5, closed); DRs = smooth1D(DRs, 5, closed);
    if (ACC.length) { DLs = DLs.map((v, i) => v * (1 - accCut(i, 1))); DRs = DRs.map((v, i) => v * (1 - accCut(i, -1))); }
    // perfil transversal de cada costado (distancias desde el borde del ripio):
    // berma de piedras → cuneta en V con fondo → contratalud que sube (o baja) hasta el terreno real de ese lado
    const sideProf = (i, sd, force) => {
      const sl = sd > 0 ? SLL[i] : SLR[i], Dd = force === true ? Math.max(0.13, sd > 0 ? DLs[i] : DRs[i]) : force === false ? 0 : sd > 0 ? DLs[i] : DRs[i], hw = W[i] / 2, edge = surfH(i, sd * hw);
      const bare = o.bareAt ? o.bareAt(dist[i], sd) : 1, bw = Math.max(0.25, Math.min(1.0, 0.35 * bare + 0.15));
      const tg = e => hs[i] + sl * (hw + e) - 0.05;
      let pts, xe, clear;
      if (Dd > 0.12) {
        // zanja angosta cavada al borde del camino (como en Aguas Blancas): pared casi vertical del lado del camino,
        // fondo de ~0,3 m, pared de tierra arcillosa del otro lado con terrones apilados encima (desparejo a lo largo)
        const d = dist[i], open = (1 - FOR[i]) * Math.min(1, WETP[i] * 1.6), wf = (0.85 + 0.35 * vn1(d / 45, sd * 7)) * (1 + 0.6 * open);
        const lump = (0.1 + 0.08 * Math.sin(d * 0.37 + sd) * Math.sin(d * 0.113 + 2 * sd) + 0.06 * Math.sin(d * 1.3 + sd * 3)) * (1 - 0.75 * open); // en el campo casi sin terrones
        const bot = edge - Dd, mtop = edge + Math.max(0.02, lump), a0 = 0.1 * wf, a1 = 0.32 * wf, a2 = 0.62 * wf, a3 = 0.9 * wf, a4 = 1.3 * wf;
        xe = a4 + 0.8; for (let k = 0; k < 3; k++) { const dh = tg(xe) - mtop; xe = Math.min(9, a4 + Math.max(0.8, Math.abs(dh) * (dh < 0 ? 1.5 : 1.1))); }
        const top = tg(xe);
        pts = [[0, edge], [a0, edge - 0.04], [a1, bot], [a2, bot + 0.03], [a3, mtop - 0.04], [a4, mtop - 0.06], [(a4 + xe) / 2, mtop + (top - mtop) * 0.5], [xe, top]];
        clear = a4 + 0.3;
      } else {
        const b0 = edge - 0.06; xe = bw + 1;
        for (let k = 0; k < 3; k++) { const dh = tg(xe) - b0; xe = Math.min(9, bw + Math.max(1, Math.abs(dh) * (dh < 0 ? 1.5 : 1.2))); }
        const top = tg(xe), L = (f) => [bw + (xe - bw) * f, b0 + (top - b0) * f];
        pts = [[0, edge], [bw, b0], L(0.33), L(0.66), L(0.85), [xe, top]];
        clear = bw + 0.3;
      }
      // solapa sobre el plano del terreno (una celda de la grilla) y faldón que se mete debajo: sin rajas ni pozos en la unión
      const F = (o.terrRes || 4) * 1.1;
      const Rr = (o.terrRes || 4) * 0.95; pts.push([xe + F, tg(xe + F) + 0.02], [xe + F + Rr, tg(xe + F + Rr) - 0.12]);
      return { pts, xe: xe + F, clear, Dd, sl };
    };
    const SP = []; for (let i = 0; i < n; i++) SP.push([sideProf(i, 1), sideProf(i, -1)]);
    const routeSegs = () => {
      const segs = [];
      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % n, L = SP[i][0], R = SP[i][1], xL = Math.max(L.xe, SP[j][0].xe), xR = Math.max(R.xe, SP[j][1].xe);
        segs.push([C[i][0], C[i][1], C[j][0], C[j][1], hs[i], hs[j], W[i] / 2, SL[i], SL[j], Math.max(xL, xR) + 0.6, Math.max(DLs[i], DRs[i], DLs[j], DRs[j]), CS[i],
          SLL[i], SLR[i], xL, xR, Math.max(DLs[i], DLs[j]), Math.max(DRs[i], DRs[j]), OFL[i], OFR[i], L.clear, R.clear]);
      }
      return segs;
    };
    const EX = (() => { const a = SP.map(p => Math.max(p[0].xe, p[1].xe)).sort((p, q) => p - q); return a[Math.floor(a.length * 0.75)] + 0.6; })(); // ancho típico del costado (para ubicar carteles)
    // solo el perfil (alturas, peralte, ancho): para la edición en vivo, sin armar las mallas
    if (o.profileOnly) return { C, T, hs, raw, dist, total, n, K, W, SL, SURF, closed, CS, DL: DLs, DR: DRs, EX, segs: routeSegs() };

    // en horquillas cerradas, el borde interno no puede pasar el centro de la curva (evita que la malla se pliegue)
    const pos = (i, s) => { const nx = -T[i][1], ny = T[i][0], k = K[i]; if (s * k > 0) { const lim = 0.85 / Math.abs(k); if (Math.abs(s) > lim) s = Math.sign(s) * lim; } return [C[i][0] + nx * s, C[i][1] + ny * s]; };
    // huellones (o.rutAt): dos surcos con bordes de barro levantado, tallados en la malla del camino (física real)
    const rutOff = (r, s) => { const x = Math.abs(Math.abs(s) - r.tw), rw = 0.23;
      if (x <= rw) { const t = x / rw; return -r.D * (1 - t * t); }                    // canal del surco (fondo redondeado)
      if (x <= rw + 0.16) { const t = (x - rw) / 0.16; return r.D * 0.35 * Math.sin(t * Math.PI); } // labio de barro empujado
      return Math.abs(s) < r.tw - rw - 0.16 ? r.D * 0.12 : 0; };                         // lomo central algo más alto
    const sec = (i, j, dOff, rutMode) => {
      const hw = W[i] / 2;
      if (rutMode) { // todas las secciones del tramo con la misma cantidad de columnas (la malla no se rompe)
        let r = o.rutAt(dist[i]) || { D: 0, tw: 0.78 }; if (hw < r.tw + 0.5) r = { D: 0, tw: Math.max(0.45, hw - 0.5) };
        const T0 = r.tw, cl = v => Math.min(hw - 0.02, v), side = [T0 + 0.39, T0 + 0.31, T0 + 0.23, T0 + 0.12, T0, T0 - 0.12, T0 - 0.23, T0 - 0.31, T0 - 0.39].map(cl);
        const S2 = [-hw, ...side.map(v => -v), 0, ...side.slice().reverse(), hw];
        return { cols: S2.map(s => { const [x, y] = pos(i, s); return { x, y, h: surfH(i, s) + rutOff(r, s), u: (s + hw) / W[i], s, i, sc: s }; }), d: dist[i] + dOff, step };
      }
      const SC = o.reliefAt ? [-1, -0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1] : [-1, -0.5, 0, 0.5, 1];
      return { cols: SC.map(f => { const s = f * hw, [x, y] = pos(i, s); return { x, y, h: surfH(i, s), u: (s + hw) / W[i], s, i, sc: s }; }), d: dist[i] + dOff, step };
    };
    // relieve del piso (baches, surcos de agua, morros suaves): se suma a la malla del camino, que es la superficie física.
    // Es todo continuo (sin bordes verticales): la suspensión lo copia y no hay golpes fantasma.
    const ctxAt = d => { const f = Math.max(0, Math.min(n - 1.001, d / step)), k = Math.floor(f), u = f - k; return { hum: HUM[k] * (1 - u) + HUM[k + 1] * u, hollow: HO[k] * (1 - u) + HO[k + 1] * u, forest: FOR[k] }; };
    const addRelief = sc => { if (!o.reliefAt) return sc; const c = ctxAt(sc.d), hw = W[sc.cols[0].i] / 2;
      for (const q of sc.cols) if (Math.abs(q.s) < hw - 0.01) q.h += o.reliefAt(sc.d, q.s, hw, c); return sc; };
    // secciones intermedias cada 0,5 m (entre los puntos del eje, que van cada 2 m): los baches necesitan esa resolución
    const subSecs = (A, B, parts) => { const out = []; for (let k = 1; k < parts; k++) { const t = k / parts;
      out.push({ cols: A.cols.map((a, j) => { const b = B.cols[j]; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: a.h + (b.h - a.h) * t, u: a.u + (b.u - a.u) * t, s: a.s + (b.s - a.s) * t, i: a.i, sc: a.sc + (b.sc - a.sc) * t }; }), d: A.d + (B.d - A.d) * t, step: A.step / parts }); } return out; };
    // tramos consecutivos con la misma superficie
    const runs = [];
    for (let i = 0; i < segCount; i++) {
      const key = SURF[i], last = runs[runs.length - 1];
      if (last && last.key === key) last.i1 = i; else runs.push({ key, i0: i, i1: i });
    }
    const cnt = counters(), meshes = [];
    for (const run of runs) {
      const secs = [];
      let rutMode = false; if (o.rutAt && run.key === 'MUD') for (let i = run.i0; i <= run.i1 + 1 && !rutMode; i++) if (o.rutAt(dist[i % n])) rutMode = true;
      let prev = null;
      for (let i = run.i0; i <= run.i1 + 1; i++) { const cur = sec(i % n, 0, i >= n ? total : 0, rutMode);
        if (prev && o.reliefAt) for (const q of subSecs(prev, cur, 4)) secs.push(addRelief(q));
        secs.push(prev = cur); }
      if (o.reliefAt) for (const q of secs) if (q.step === step) addRelief(q);
      for (const m of ribbonMeshes(secs, false, run.key, MAT[run.key], 7, { next: () => cnt(run.key) })) { m.road = true; meshes.push(m); }
    }
    // costados: berma, cuneta y contratalud (o banquina y terraplén donde no hay cuneta)
    // dos cintas por costado: la zanja (o la berma) con su textura a lo ancho, y el talud de pasto con textura
    // a escala real (u = metros / 5), así el pasto no queda estirado en rayas
    const UD = [0, 0.06, 0.28, 0.4, 0.55, 0.64], UV = [0, 0.25, 0.6], CUT_D = 5, CUT_V = 2;
    for (const side of [1, -1]) {
      const Dd = side > 0 ? DLs : DRs, SLs = side > 0 ? SLL : SLR, onBridge = i => o.bridge && o.bridge(C[i][0], C[i][1]);
      // cuneta con barro y agua donde el suelo es húmedo; con piedra donde corta la ladera en seco; normal en el resto
      const sideKey = i => onBridge(i) ? 'NONE' : Dd[i] > 0.12 ? (WETP[i] > 0.55 ? 'DITCHMUD' : SLs[i] > 0.28 && WETP[i] < 0.4 ? 'DITCHROCK' : 'DITCH') : 'VERGE', runs2 = [];
      for (let i = 0; i < segCount; i++) { const k = sideKey(i), last = runs2[runs2.length - 1]; if (last && last.key === k) last.i1 = i; else runs2.push({ key: k, i0: i, i1: i }); }
      for (const run of runs2) {
        if (run.key === 'NONE') continue; // en los puentes no hay banquina: se ve el río abajo
        const isD = run.key.startsWith('DITCH'), cut = isD ? CUT_D : CUT_V, U = isD ? UD : UV, inner = [], outer = [];
        for (let ii = run.i0; ii <= run.i1 + 1; ii++) {
          const i = ii % n, hw = W[i] / 2, sp0 = SP[i][side > 0 ? 0 : 1], P = (sp0.Dd > 0.12) === isD ? sp0.pts : sideProf(i, side, isD).pts;
          const col = ([e, h], u) => { const [x, y] = pos(i, side * (hw + e)); return { x, y, h, u, i, sc: side * hw }; }, d = dist[i] + (ii >= n ? total : 0);
          const A = P.slice(0, cut + 1).map((q, k) => col(q, U[k])), Bc = P.slice(cut).map((q, k) => { const c = col(q, q[0] / 5);
            if (o.sideLumpAt && k > 0 && k < P.length - cut - 2) c.h += o.sideLumpAt(d, side, q[0]); return c; }); // montículos del talud (catálogo de costados)
          inner.push({ cols: side > 0 ? A : A.reverse(), d, step }); outer.push({ cols: side > 0 ? Bc : Bc.reverse(), d, step, mat: o.sideMatAt ? o.sideMatAt(d, side) : null });
        }
        const key = run.key === 'DITCHMUD' ? 'SOFT' : isD ? 'DITCH' : 'GRASS', mat = run.key === 'DITCHMUD' ? 'ditchmud' : run.key === 'DITCHROCK' ? 'ditchrock' : isD ? 'ditchside' : 'verge';
        for (const m of ribbonMeshes(inner, false, key, mat, 7, { next: () => (key === 'GRASS' ? 500 : key === 'SOFT' ? 700 : 0) + cnt(key) })) meshes.push(m);
        // el talud cambia de tipo a lo largo (pasto con flores, tierra con agujas de pino, pasto seco con piedras): una malla por tramo
        let a0 = 0; for (let k = 1; k <= outer.length; k++) { if (k < outer.length && (outer[k].mat || 'grass') === (outer[a0].mat || 'grass')) continue;
          const part = outer.slice(a0, Math.min(outer.length, k + 1)); if (part.length > 1) for (const m of ribbonMeshes(part, false, 'GRASS', outer[a0].mat || 'grass', 7, { next: () => 500 + cnt('GRASS') })) meshes.push(m); a0 = k; }
      }
    }
    // accesos: un tramo corto de tierra que sale del camino hacia la propiedad o el sendero (12 m), sin cuneta debajo
    const accessPts = [];
    for (const a of ACC) {
      const i = Math.max(0, Math.min(n - 1, Math.round(a.d / step))), hw = W[i] / 2, sd = a.sd, sl = sd > 0 ? SLL[i] : SLR[i], edge = surfH(i, sd * hw), secsA = [];
      const tx = T[i][0], ty = T[i][1], nx = -ty * sd, ny = tx * sd, x0 = C[i][0] + nx * hw, y0 = C[i][1] + ny * hw, wv = a.w / 2;
      for (let e = 0; e <= 12.001; e += 1.5) { const tgt = hs[i] + sl * (hw + e) - 0.05, t = Math.min(1, e / 5), h = edge * (1 - t * t * (3 - 2 * t)) + tgt * (t * t * (3 - 2 * t)) + 0.04;
        const cx = x0 + nx * e, cy = y0 + ny * e, ww = wv * (1 + 0.15 * Math.min(1, e / 12));
        secsA.push({ cols: [-1, 1].map(k => ({ x: cx + tx * ww * k, y: cy + ty * ww * k, h, u: (k + 1) / 2 * a.w / 5 })), d: e, step: 1.5 }); }
      for (const m of ribbonMeshes(secsA, false, 'GRAVEL', 'gravel', 5, { next: () => cnt('GRAVEL') })) { m.access = true; meshes.push(m); }
      accessPts.push({ x: x0 + nx * 6, y: y0 + ny * 6, r: 8, d: a.d, sd, osm: !!a.osm });
    }
    if (o.lines) {
      const lw = 0.06, lift = 0.02, painted = k => k === 'ROAD' || k === 'WET';
      const mk = (side, dashed) => {
        const secs = [];
        for (let i = 0; i < n; i++) {
          const hw = W[i] / 2, off = side * (hw - 0.3);
          const cols = [off - lw, off + lw].map((s, k) => { const [x, y] = pos(i, s); return { x, y, h: surfH(i, s) + lift, u: k, i, sc: s }; });
          const skip = !painted(SURF[i]) || (dashed && ((dist[i] % 12) > 4 || W[i] < 5.5));
          secs.push({ cols, d: dist[i], step, skip });
        }
        return secs;
      };
      const lc = counterFrom(0);
      for (const [side, dashed] of [[-1, false], [1, false], [0, true]])
        for (const m of ribbonMeshes(mk(side, dashed), closed, 'LINE', 'line', 1, lc)) { m.name = 'LINES_' + m.name.replace(/LINE$/, ''); meshes.push(m); }
    }
    const segs = routeSegs();
    for (const m of meshes) m.route = true;
    return { meshes, segs, C, T, hs, raw, dist, total, n, K, W, SL, SURF, closed, CS, DL: DLs, DR: DRs, EX, SP, HUM, HO, FOR, accessPts, ctxAt };
  }

  // ---------- Modo ZONA (mundo abierto) ----------
  function buildArea(o) {
    const step = o.step || 2, meshes = [], segs = [], cnt = counters(), allLines = [];
    for (const way of o.ways) {
      if (way.pts.length < 2) continue;
      let C = resample(way.pts, step, false);
      if (C.length < 2) continue;
      if (C.length > 6) C = smoothPts(C, 1, false, 1);
      const T = tangents(C, false), hw = way.width / 2, n = C.length;
      const dist = [0]; for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(C[i][0] - C[i - 1][0], C[i][1] - C[i - 1][1]));
      const secs = [];
      let hsum = 0;
      for (let i = 0; i < n; i++) {
        const nx = -T[i][1], ny = T[i][0];
        const cols = [-hw, hw].map(s => { const x = C[i][0] + nx * s, y = C[i][1] + ny * s; const h = o.heightS(x, y); hsum += h; return { x, y, h: h + way.lift, u: (s + hw) / way.width }; });
        secs.push({ cols, d: dist[i], step });
      }
      const key = o.keyFor ? o.keyFor(way, hsum / (2 * n)) : way.key;
      meshes.push(...ribbonMeshes(secs, false, key, MAT[key], 7, { next: () => cnt(key) }));
      for (let i = 0; i < n - 1; i++) segs.push([C[i][0], C[i][1], C[i + 1][0], C[i + 1][1], NaN, NaN, hw, 0, 0]);
      allLines.push(C);
    }
    return { meshes, segs, lines: allLines };
  }

  // ---------- Caminos laterales (modo RUTA) ----------
  // Calles que salen del tramo o lo cruzan. Se pegan al camino principal: en el cruce toman su altura
  // y en ~30 m pasan a seguir el terreno. Lo que queda debajo del camino principal se esconde unos cm abajo.
  // o: ways [{pts, width, key}], routeSegs (segs de buildRoute), heightS(x,y), maxDist (m desde el eje del tramo)
  function buildSideRoads(o) {
    const meshes = [], segs = [], lines = [], junctions = [], RS = o.routeSegs, cs = 30, cells = new Map();
    const BLEND = o.blend || 30, VW = 1.2, step = 2;
    let total = 0, k0 = 0, kv = 0;
    RS.forEach((s, si) => {
      const x0 = Math.floor(Math.min(s[0], s[2]) / cs), x1 = Math.floor(Math.max(s[0], s[2]) / cs), y0 = Math.floor(Math.min(s[1], s[3]) / cs), y1 = Math.floor(Math.max(s[1], s[3]) / cs);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = x + ',' + y; (cells.get(k) || cells.set(k, []).get(k)).push(si); }
    });
    const nearest = (x, y, R) => {
      const r = Math.ceil(R / cs), cx = Math.floor(x / cs), cy = Math.floor(y / cs); let best = null;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const list = cells.get((cx + dx) + ',' + (cy + dy)); if (!list) continue;
        for (const si of list) {
          const s = RS[si], vx = s[2] - s[0], vy = s[3] - s[1], L2 = vx * vx + vy * vy || 1e-9;
          let t = ((x - s[0]) * vx + (y - s[1]) * vy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(s[0] + vx * t - x, s[1] + vy * t - y);
          if (!best || d < best.d) best = { d, s, t, lat: (vx * (y - s[1]) - vy * (x - s[0])) / Math.sqrt(L2) };
        }
      }
      return best && best.d <= R ? best : null;
    };
    const routeH = q => { const s = q.s, hw = s[6], lat = Math.max(-hw, Math.min(hw, q.lat)); return s[4] + (s[5] - s[4]) * q.t + (s[7] + (s[8] - s[7]) * q.t) * lat + 0.02 * (hw - Math.abs(lat)); };
    // altura de la superficie del lateral en (x, y)
    const hAt = (x, y) => {
      const q = nearest(x, y, BLEND + 40);
      if (!q || isNaN(q.s[4])) return o.heightS(x, y);
      const e = q.d - q.s[6];
      if (e < 0.3) return routeH(q) - 0.04; // debajo del camino principal: queda tapado
      let w = Math.min(1, e / BLEND); w = w * w * (3 - 2 * w);
      return routeH(q) * (1 - w) + o.heightS(x, y) * w + 0.04 * Math.min(1, e / 1.5);
    };
    for (const way of o.ways) {
      if (way.pts.length < 2) continue;
      let C0 = resample(way.pts, step, false);
      if (C0.length > 6) C0 = smoothPts(C0, 1, false, 1);
      // partes dentro del margen de terreno
      const runs = []; let cur = null;
      for (const p of C0) { const q = nearest(p[0], p[1], o.maxDist); if (q) { if (!cur) runs.push(cur = []); cur.push(p); } else cur = null; }
      for (const C of runs) {
        if (C.length < 3) continue;
        const n = C.length, T = tangents(C, false), hw = way.width / 2;
        const dist = [0]; for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(C[i][0] - C[i - 1][0], C[i][1] - C[i - 1][1]));
        total += dist[n - 1];
        const road = [], vL = [], vR = [], HC = [], SLp = [];
        for (let i = 0; i < n; i++) {
          const nx = -T[i][1], ny = T[i][0], P = sg => [C[i][0] + nx * sg, C[i][1] + ny * sg];
          const [xl, yl] = P(-hw), [xr, yr] = P(hw), hl = hAt(xl, yl), hr = hAt(xr, yr);
          const q = nearest(C[i][0], C[i][1], o.maxDist + 50), inside = q && q.d < q.s[6] + (q.s[9] || 0) + 0.5;
          road.push({ cols: [{ x: xl, y: yl, h: hl, u: 0 }, { x: xr, y: yr, h: hr, u: 1 }], d: dist[i], step });
          const [xo, yo] = P(-hw - VW), [xo2, yo2] = P(hw + VW);
          vL.push({ cols: [{ x: xo, y: yo, h: hAt(xo, yo) - 0.12, u: 1 }, { x: xl, y: yl, h: hl - 0.01, u: 0 }], d: dist[i], step, skip: inside });
          vR.push({ cols: [{ x: xr, y: yr, h: hr - 0.01, u: 0 }, { x: xo2, y: yo2, h: hAt(xo2, yo2) - 0.12, u: 1 }], d: dist[i], step, skip: inside });
          HC.push((hl + hr) / 2 - 0.04); SLp.push((hl - hr) / (2 * hw));
        }
        for (const m of ribbonMeshes(road, false, way.key, MAT[way.key], 7, { next: () => 3000 + (k0++) })) meshes.push(m);
        for (const secs of [vL, vR]) for (const m of ribbonMeshes(secs, false, 'GRASS', 'verge', 7, { next: () => 3600 + (kv++) })) meshes.push(m);
        for (let i = 0; i < n - 1; i++) segs.push([C[i][0], C[i][1], C[i + 1][0], C[i + 1][1], HC[i], HC[i + 1], hw, SLp[i], SLp[i + 1], VW, 0, 0]);
        for (let i = 0; i < n; i++) { const q = nearest(C[i][0], C[i][1], 20); if (q && q.d < q.s[6] + 3 && !junctions.some(j => Math.hypot(j[0] - C[i][0], j[1] - C[i][1]) < 15)) junctions.push(C[i]); }
        lines.push(C);
      }
    }
    return { meshes, segs, lines, junctions, total };
  }

  // ---------- Terreno ----------
  // o.surfAt(hLocal, pendiente, x, y) -> [CLAVE_FISICA, material]
  const DEF_SURF = ['GRASS', 'grass'];
  // índice de segmentos del camino y parámetros para calcular la altura del terreno en cualquier punto
  function terrainCtx(o) {
    const { bbox } = o;
    const cs = 40, hx = Math.ceil((bbox.maxx - bbox.minx) / cs) + 1, hy = Math.ceil((bbox.maxy - bbox.miny) / cs) + 1;
    const cells = new Array(hx * hy);
    let maxHW = 0, maxEX = 0;
    o.segs.forEach((s, si) => {
      maxHW = Math.max(maxHW, s[6]); maxEX = Math.max(maxEX, s[9] || 0);
      const x0 = Math.floor((Math.min(s[0], s[2]) - bbox.minx) / cs), x1 = Math.floor((Math.max(s[0], s[2]) - bbox.minx) / cs);
      const y0 = Math.floor((Math.min(s[1], s[3]) - bbox.miny) / cs), y1 = Math.floor((Math.max(s[1], s[3]) - bbox.miny) / cs);
      for (let cy = Math.max(0, y0); cy <= Math.min(hy - 1, y1); cy++)
        for (let cx = Math.max(0, x0); cx <= Math.min(hx - 1, x1); cx++) { const k = cy * hx + cx; (cells[k] || (cells[k] = [])).push(si); }
    });
    const R1 = maxHW + Math.max(Math.max(o.flat, maxEX) + o.blend, o.edgeFix ? 55 : 0, maxEX + 20);
    return { o, cs, hx, hy, cells, R1, rr1: Math.ceil(R1 / cs) };
  }
  // altura del terreno en (x, y): el natural, aplanado y fundido bajo el camino
  function terrainPointH(ctx, x, y) {
    const { o, cs, hx, hy, cells, rr1 } = ctx, bbox = o.bbox, F = o.flat, B = o.blend, depth = o.depth;
    const cx = Math.floor((x - bbox.minx) / cs), cy = Math.floor((y - bbox.miny) / cs);
    let h = o.height(x, y); const hNat = h;
    let best = Infinity, bS = null, bT = 0, bLat = 0;
    for (let dy = -rr1; dy <= rr1; dy++) for (let dx = -rr1; dx <= rr1; dx++) {
      const X = cx + dx, Y = cy + dy; if (X < 0 || Y < 0 || X >= hx || Y >= hy) continue;
      const list = cells[Y * hx + X]; if (!list) continue;
      for (const si of list) {
        const s = o.segs[si], vx = s[2] - s[0], vy = s[3] - s[1], L2 = vx * vx + vy * vy || 1e-9;
        let t = ((x - s[0]) * vx + (y - s[1]) * vy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = s[0] + vx * t - x, py = s[1] + vy * t - y, e = Math.sqrt(px * px + py * py) - s[6];
        if (e < best) { best = e; bS = s; bT = t; bLat = (vx * (y - s[1]) - vy * (x - s[0])) / Math.sqrt(L2); }
      }
    }
    // tramo con perfil transversal propio (cuneta + contratalud): el terreno sigue la ladera de ESE lado
    if (bS && bS[12] !== undefined && !isNaN(bS[4])) {
      const left = bLat > 0, sl = left ? bS[12] : bS[13], xe = left ? bS[14] : bS[15], Dd = left ? bS[16] : bS[17], off = left ? bS[18] : bS[19];
      const hc = bS[4] + (bS[5] - bS[4]) * bT, hw = bS[6], tg = e => hc + sl * (hw + e) - 0.05;
      const slr = bS[7] + (bS[8] - bS[7]) * bT, edgeH = hc + slr * (left ? hw : -hw);
      if (best < 0) h = hc + slr * Math.max(-hw, Math.min(hw, bLat)) - depth - (bS[10] || 0);
      else if (best < xe + 0.1) h = Math.min(edgeH - Dd, tg(xe)) - 0.45 - 0.5 * Math.max(0, -sl) * (o.res || 4);
      else {
        const t = tg(best);
        if (o.edgeFix) {
          // el detalle natural del terreno se suma de a poco (sin el sesgo de las copas), y desde 30 m vuelve al natural
          const allow = 0.15 + 0.1 * (best - xe), hc2 = t + Math.max(-allow, Math.min(allow, h - off - t));
          if (best <= 30) h = hc2; else { let w = Math.min(1, (best - 30) / 25); w = w * w * (3 - 2 * w); h = hc2 * (1 - w) + h * w; }
        } else { let w = Math.min(1, (best - xe) / Math.max(6, B)); w = w * w * (3 - 2 * w); h = t * (1 - w) + h * w; }
      }
      if (o.carve) { const cv = o.carve(x, y); if (cv > 0) h = Math.min(h, hNat - 0.15) - cv; }
      if (o.lakes) h = lakeAdj(o.lakes, x, y, h);
      return h;
    }
    const Fz = bS ? Math.max(F, bS[9] || 0) : F, dd = bS ? (bS[10] || 0) : 0;
    // relieve junto al camino: la elevación del satélite incluye la altura de las copas de los árboles y arma
    // paredones falsos al lado del camino. Cerca del camino el terreno sigue el plano de la ladera real
    // (pendiente lateral medida a 15 m de cada lado) y solo se aparta de a poco; desde 30 m vuelve al natural.
    if (o.edgeFix && bS && !isNaN(bS[4]) && best < 55) {
      const target = bS[4] + (bS[5] - bS[4]) * bT + (bS[11] || 0) * bLat, allow = 0.4 + 0.08 * Math.max(0, best - Fz);
      const hc = target + Math.max(-allow, Math.min(allow, h - target));
      if (best <= 30) h = hc; else { let w = (best - 30) / 25; w = w * w * (3 - 2 * w); h = hc * (1 - w) + h * w; }
    }
    if (bS && best < Fz + B) {
      let bH;
      if (isNaN(bS[4])) bH = o.heightS(x, y);
      else {
        const sl = bS[7] + (bS[8] - bS[7]) * bT, lat = Math.max(-bS[6], Math.min(bS[6], bLat));
        bH = bS[4] + (bS[5] - bS[4]) * bT + sl * lat;
      }
      if (best < Fz) h = bH - depth - dd;
      else { let t = (best - Fz) / B; t = t * t * (3 - 2 * t); h = (bH - depth - dd) * (1 - t) + h * t; }
    }
    if (o.carve) { const cv = o.carve(x, y); if (cv > 0) h = Math.min(h, hNat - 0.15) - cv; } // el cauce sigue su nivel natural aunque el camino suba al puente
    if (o.lakes) h = lakeAdj(o.lakes, x, y, h);
    return h;
  }
  // lagos puestos a mano: lecho hundido adentro y orilla aplanada hasta el nivel del agua
  function lakeAdj(lakes, x, y, h) {
    for (const L of lakes) {
      const d = Math.hypot(x - L.x, y - L.y), bank = L.bank || 6; if (d >= L.r + bank) continue;
      if (d < L.r) { let t = Math.min(1, (L.r - d) / Math.max(1, L.r * 0.35)); t = t * t * (3 - 2 * t); h = Math.min(h, L.h - 0.35 - L.depth * t); }
      else { let t = 1 - (d - L.r) / bank; t = t * t * (3 - 2 * t); h = h * (1 - t) + Math.min(h, L.h + 0.05) * t; }
    }
    return h;
  }
  // recalcula el terreno solo dentro de un rectángulo (edición en vivo). Devuelve los puntos de la grilla que cambiaron.
  function patchTerrain(ter, o, rect) {
    const ctx = terrainCtx(o), { bbox, res } = o, { nx, ny, H, need } = ter, changed = [];
    const i0 = Math.max(0, Math.floor((rect.minx - bbox.minx) / res)), i1 = Math.min(nx - 1, Math.ceil((rect.maxx - bbox.minx) / res));
    const j0 = Math.max(0, Math.floor((rect.miny - bbox.miny) / res)), j1 = Math.min(ny - 1, Math.ceil((rect.maxy - bbox.miny) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i; if (!need[k]) continue;
      const h = terrainPointH(ctx, bbox.minx + i * res, bbox.miny + j * res);
      if (Math.abs(h - H[k]) > 1e-4) { changed.push(k, H[k]); H[k] = h; }
    }
    return { changed, i0, i1, j0, j1 };
  }

  function buildTerrain(o, progress) {
    const { bbox, res } = o;
    const nx = Math.floor((bbox.maxx - bbox.minx) / res) + 1, ny = Math.floor((bbox.maxy - bbox.miny) / res) + 1;
    const ctx = terrainCtx(o), { cs, hx, hy, cells } = ctx;
    let near = null;
    if (isFinite(o.margin)) {
      near = new Uint8Array(hx * hy);
      // margen por tramo (o.segMargin[si]): en bosque cerrado no hace falta generar tanto campo, no se ve
      for (let cy = 0; cy < hy; cy++) for (let cx = 0; cx < hx; cx++) { const list = cells[cy * hx + cx]; if (!list) continue;
        const mg = o.segMargin ? Math.max(...list.map(si => o.segMargin[si] != null ? o.segMargin[si] : o.margin)) : o.margin, rr = Math.ceil(mg / cs);
        for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
          const X = cx + dx, Y = cy + dy; if (X >= 0 && Y >= 0 && X < hx && Y < hy && (dx * dx + dy * dy) * cs * cs <= (mg + cs * 1.5) ** 2) near[Y * hx + X] = 1;
        }
      }
    }
    const H = new Float32Array(nx * ny), need = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = bbox.miny + j * res;
      for (let i = 0; i < nx; i++) {
        const x = bbox.minx + i * res, cx = Math.floor((x - bbox.minx) / cs), cy = Math.floor((y - bbox.miny) / cs);
        if (near && !near[cy * hx + cx]) continue;
        need[j * nx + i] = 1;
        H[j * nx + i] = terrainPointH(ctx, x, y);
      }
      if (progress && j % 50 === 0) progress(j / ny);
    }
    const CH = 60, meshes = [], cnt = counters();
    for (let cj = 0; cj < ny - 1; cj += CH) for (let ci = 0; ci < nx - 1; ci += CH) {
      const parts = {};
      const get = ([key, mat]) => parts[key + '|' + mat] || (parts[key + '|' + mat] = { m: Object.assign(newMesh(`${cnt(key)}${key}`, mat), { terrain: true, chunk: [ci, cj] }), map: new Map() });
      const vid = (P, i, j) => {
        const k = j * nx + i; if (P.map.has(k)) return P.map.get(k);
        const x = bbox.minx + i * res, y = bbox.miny + j * res;
        P.m.v.push([x, y, H[k]]); P.m.uv.push([x / 5, y / 5]); (P.m.gk || (P.m.gk = [])).push(k); P.map.set(k, P.m.v.length - 1); return P.m.v.length - 1;
      };
      for (let j = cj; j < Math.min(ny - 1, cj + CH); j++) for (let i = ci; i < Math.min(nx - 1, ci + CH); i++) {
        const k00 = j * nx + i, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
        if (!(need[k00] && need[k10] && need[k01] && need[k11])) continue;
        let km = DEF_SURF;
        if (o.surfAt) {
          const hm = (H[k00] + H[k10] + H[k01] + H[k11]) / 4;
          const sx = (H[k10] + H[k11] - H[k00] - H[k01]) / (2 * res), sy = (H[k01] + H[k11] - H[k00] - H[k10]) / (2 * res);
          km = o.surfAt(hm, Math.hypot(sx, sy), bbox.minx + (i + 0.5) * res, bbox.miny + (j + 0.5) * res) || DEF_SURF;
        }
        const P = get(km);
        const a = vid(P, i, j), b = vid(P, i + 1, j), c = vid(P, i + 1, j + 1), d = vid(P, i, j + 1);
        P.m.f.push([a, b, c], [a, c, d]);
      }
      for (const k in parts) meshes.push(parts[k].m);
    }
    return { meshes, nx, ny, H, need, CH };
  }


  // ---------- Distancia al camino (para no plantar árboles encima) ----------
  function roadDistFn(segs, edgeOnly) {
    const cs = 30, cells = new Map();
    segs.forEach((s, si) => {
      const x0 = Math.floor(Math.min(s[0], s[2]) / cs), x1 = Math.floor(Math.max(s[0], s[2]) / cs), y0 = Math.floor(Math.min(s[1], s[3]) / cs), y1 = Math.floor(Math.max(s[1], s[3]) / cs);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = x + ',' + y; (cells.get(k) || cells.set(k, []).get(k)).push(si); }
    });
    return (x, y, maxD) => {
      const r = Math.ceil(maxD / cs), cx = Math.floor(x / cs), cy = Math.floor(y / cs); let best = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const list = cells.get((cx + dx) + ',' + (cy + dy)); if (!list) continue;
        for (const si of list) {
          const s = segs[si], vx = s[2] - s[0], vy = s[3] - s[1], L2 = vx * vx + vy * vy || 1e-9;
          let t = ((x - s[0]) * vx + (y - s[1]) * vy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          let clr = s[9] || 0;
          if (edgeOnly) clr = s[20] !== undefined ? ((vx * (y - s[1]) - vy * (x - s[0])) > 0 ? s[20] : s[21]) : ((s[10] || 0) > 0.12 ? 3.8 : 2.2);
          const e = Math.hypot(s[0] + vx * t - x, s[1] + vy * t - y) - s[6] - clr; if (e < best) best = e;
        }
      }
      return best;
    };
  }
  // número pseudoaleatorio estable según la posición (los árboles no cambian al regenerar)
  function hash2(x, y, s) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  // ---------- Árboles: dos planos cruzados con textura recortada (como en los simuladores) ----------
  // o: ter (resultado de buildTerrain), bbox, res, segs, spacingAt(x,y,h,slope) -> metros entre árboles (0 = ninguno),
  //    kindAt(x,y,h) -> 0 pino, 1 árbol de hoja, 2 arbusto, maxTrees
  function buildTrees(o) {
    const { ter, bbox, res } = o, nx = ter.nx, ny = ter.ny, H = ter.H, need = ter.need;
    const hAt = (x, y) => {
      const fi = (x - bbox.minx) / res, fj = (y - bbox.miny) / res, i = Math.floor(fi), j = Math.floor(fj);
      if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return null;
      const k = j * nx + i; if (!(need[k] && need[k + 1] && need[k + nx] && need[k + nx + 1])) return null;
      const a = fi - i, b = fj - j;
      return { h: H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + nx] * (1 - a) * b + H[k + nx + 1] * a * b, slope: Math.hypot(H[k + 1] - H[k], H[k + nx] - H[k]) / res };
    };
    const rd = roadDistFn(o.segs, true), base = o.base || 4, cand = [], CL = o.clear || 3;
    for (let gy = Math.floor(bbox.miny / base); gy <= Math.ceil(bbox.maxy / base); gy++)
      for (let gx = Math.floor(bbox.minx / base); gx <= Math.ceil(bbox.maxx / base); gx++) {
        const r0 = hash2(gx, gy, 1), x = (gx + hash2(gx, gy, 2)) * base, y = (gy + hash2(gx, gy, 3)) * base;
        const t = hAt(x, y); if (!t || t.slope > 1.3) continue;
        const sp = o.spacingAt(x, y, t.h, t.slope); if (!sp) continue;
        let kind = o.kindAt(x, y, t.h);
        const dr = rd(x, y, 120);
        // franja pegada al camino: monte bajo denso (como en los caminos de bosque reales)
        // dr = distancia desde la línea libre (fin de la cuneta, o la berma donde no hay cuneta)
        const edge = dr >= 0 && dr < CL + 5;
        const dens = (base * base) / (sp * sp) * (edge ? 3.5 : 1);
        if (r0 > dens) continue;
        if (edge && dr < CL + 0.7) kind = 2; else if (dr < CL) continue;
        if (dr < 0) continue; // no dentro de la cuneta
        cand.push([x, y, t.h, kind, hash2(gx, gy, 4), hash2(gx, gy, 5), r0 * (1 + Math.max(0, Math.min(dr, 140) - 40) / 50), edge && kind === 2]);
      }
    let list = cand;
    if (list.length > o.maxTrees) { list = cand.slice().sort((a, b) => a[6] - b[6]).slice(0, o.maxTrees); }
    // troncos con choque (objetos WALL) para los árboles cercanos al camino
    const walls = [];
    if (o.trunkDist) {
      let wm = null;
      for (const [x, y, h, kind, ra] of list) {
        if (kind === 2 || rd(x, y, o.trunkDist + 1) > o.trunkDist) continue;
        if (!wm || wm.v.length > 50000) { wm = newMesh(`${o.wallCounter()}WALL`, 'bark'); wm.block = 18; walls.push(wm); }
        const r = kind === 0 ? 0.14 + ra * 0.1 : 0.12 + ra * 0.12, top = 2.8, b = wm.v.length, N = 8;
        for (let k = 0; k <= N; k++) { const a = k / N * Math.PI * 2; wm.v.push([x + Math.cos(a) * r, y + Math.sin(a) * r, h - 0.5], [x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, h + top]); wm.uv.push([k / N, 0], [k / N, 2]); }
        for (let k = 0; k < N; k++) { const a0 = b + k * 2, a1 = b + k * 2 + 2; wm.f.push([a0, a1, a1 + 1], [a0, a1 + 1, a0 + 1]); }
      }
    }
    const meshes = [...walls], PER = 3000;
    let m = null, n = 0;
    for (const [x, y, h, kind, ra, rb, , edgeB] of list) {
      if (!m || n >= PER) { m = newMesh('TREES_' + (meshes.length - walls.length), 'tree'); m.block = 16; meshes.push(m); n = 0; }
      const Ht = kind === 2 ? (edgeB ? 2.2 + ra * 2.4 : 1.2 + ra * 1.5) : kind === 0 ? 7 + ra * 9 : 6 + ra * 7, W = kind === 0 ? Ht * 0.68 : kind === 1 ? Ht * 0.85 : Ht * 1.3;
      const slot = kind === 1 ? (ra > 0.5 ? 3 : 1) : kind, u0 = slot / 4 + 0.006, u1 = (slot + 1) / 4 - 0.006, ang = rb * Math.PI, z0 = h - 0.3; // sin rayas del árbol vecino del atlas
      for (const a of [ang, ang + Math.PI / 2]) {
        const dx = Math.cos(a) * W / 2, dy = Math.sin(a) * W / 2, b = m.v.length;
        m.v.push([x - dx, y - dy, z0], [x + dx, y + dy, z0], [x + dx, y + dy, z0 + Ht], [x - dx, y - dy, z0 + Ht]);
        m.uv.push([u0, 0.004], [u1, 0.004], [u1, 0.992], [u0, 0.992]);
        m.f.push([b, b + 1, b + 2], [b, b + 2, b + 3]);
        const c = m.v.length; // cara trasera (para que se vea de los dos lados)
        m.v.push([x - dx, y - dy, z0], [x + dx, y + dy, z0], [x + dx, y + dy, z0 + Ht], [x - dx, y - dy, z0 + Ht]);
        m.uv.push([u0, 0.004], [u1, 0.004], [u1, 0.992], [u0, 0.992]);
        m.f.push([c, c + 2, c + 1], [c, c + 3, c + 2]);
      }
      n++;
    }
    return { meshes, count: list.length, candidates: cand.length, trunks: walls.reduce((a, m) => a + m.f.length / 16, 0) };
  }


  // ---------- Piedras a los costados del camino ----------
  // o: r (resultado de buildRoute), ter, bbox, res, densityAt(i) -> 0..1, wallCounter()
  const ICO_T = (1 + Math.sqrt(5)) / 2;
  const ICO_V = [[-1, ICO_T, 0], [1, ICO_T, 0], [-1, -ICO_T, 0], [1, -ICO_T, 0], [0, -1, ICO_T], [0, 1, ICO_T], [0, -1, -ICO_T], [0, 1, -ICO_T], [ICO_T, 0, -1], [ICO_T, 0, 1], [-ICO_T, 0, -1], [-ICO_T, 0, 1]].map(v => { const L = Math.hypot(...v); return v.map(c => c / L); });
  const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  function terrainHeightFn(ter, bbox, res) {
    const { nx, ny, H, need } = ter;
    return (x, y) => {
      const fi = (x - bbox.minx) / res, fj = (y - bbox.miny) / res, i = Math.floor(fi), j = Math.floor(fj);
      if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return null;
      const k = j * nx + i; if (!(need[k] && need[k + 1] && need[k + nx] && need[k + nx + 1])) return null;
      const a = fi - i, b = fj - j;
      return H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + nx] * (1 - a) * b + H[k + nx + 1] * a * b;
    };
  }
  function buildRocks(o) {
    const r = o.r, hAt = terrainHeightFn(o.ter, o.bbox, o.res), groups = { wall: [], vis: [] };
    let count = 0, big = 0;
    const meshFor = (isWall) => {
      const g = isWall ? groups.wall : groups.vis; let m = g[g.length - 1];
      if (!m || m.v.length > 50000) { m = newMesh(isWall ? `${o.wallCounter()}WALL` : 'ROCKS_' + g.length, 'boulder'); m.block = 12; g.push(m); }
      return m;
    };
    for (let i = 0; i < r.n; i++) for (const side of [1, -1]) {
      const dens = o.densityAt(i); if (dens <= 0) continue;
      if (hash2(i, side, 11) > dens * 0.13) continue;
      const size = 0.25 + Math.pow(hash2(i, side, 12), 2.2) * 1.6;
      const lat = side * (r.W[i] / 2 + r.EX + size + hash2(i, side, 13) * 5);
      const nx = -r.T[i][1], ny = r.T[i][0], x = r.C[i][0] + nx * lat, y = r.C[i][1] + ny * lat, h = hAt(x, y);
      if (h == null) continue;
      const isWall = size > 0.9, m = meshFor(isWall), b = m.v.length, rot = hash2(i, side, 14) * 6.283, cr = Math.cos(rot), sr = Math.sin(rot);
      ICO_V.forEach(([X, Y, Z], k) => {
        const f = size * (0.7 + 0.6 * hash2(i * 13 + k, side, 15));
        const lx = X * f * 1.2, ly = -Z * f, lz = Y * f * 0.75; // (X,Y,Z) Y-arriba -> (este, norte, arriba)
        m.v.push([x + lx * cr - ly * sr, y + lx * sr + ly * cr, h - size * 0.3 + lz]); m.uv.push([(X + 1) / 2, (Y + 1) / 2]);
      });
      ICO_F.forEach(([a, bb, cc]) => m.f.push([b + a, b + bb, b + cc]));
      count++; if (isWall) big++;
    }
    return { meshes: [...groups.wall, ...groups.vis], count, big };
  }

  function computeNormals(m) {
    const N = m.v.map(() => [0, 0, 0]);
    for (const [a, b, c] of m.f) {
      const A = m.v[a], B = m.v[b], Cc = m.v[c];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { N[k][0] += nx; N[k][1] += ny; N[k][2] += nz; }
    }
    return N.map(n => { const L = Math.hypot(...n) || 1; return [n[0] / L, n[1] / L, n[2] / L]; });
  }

  // OBJ en Y-arriba: X = este, Y = altura, Z = -norte
  function toOBJ(meshes, mtlName) {
    const out = [`# Generado por Generador de Pistas\nmtllib ${mtlName}\n`];
    let off = 1;
    for (const m of meshes) {
      const N = computeNormals(m), L = [`o ${m.name}`];
      for (const v of m.v) L.push(`v ${v[0].toFixed(3)} ${v[2].toFixed(3)} ${(-v[1]).toFixed(3)}`);
      for (const t of m.uv) L.push(`vt ${t[0].toFixed(4)} ${t[1].toFixed(4)}`);
      for (const n of N) L.push(`vn ${n[0].toFixed(4)} ${n[2].toFixed(4)} ${(-n[1]).toFixed(4)}`);
      L.push(`usemtl ${m.mat}`, 's 1');
      for (const f of m.f) { const a = f[0] + off, b = f[1] + off, c = f[2] + off; L.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`); }
      off += m.v.length; out.push(L.join('\n') + '\n');
    }
    return out.join('');
  }

  function toMTL(mats) {
    return mats.map(([name, tex, kd]) => `newmtl ${name}\nKa 1 1 1\nKd ${kd}\nKs 0 0 0\nd 1\nillum 1\nmap_Kd ${tex}\n`).join('\n');
  }

  return { MAT, profileInterp, buildTrees, buildRocks, roadDistFn, patchTerrain, terrainHeightFn, makeProj, resample, smooth1D, buildRoute, buildArea, buildSideRoads, buildTerrain, toOBJ, toMTL, computeNormals };
})();
if (typeof module !== 'undefined') module.exports = Core;
