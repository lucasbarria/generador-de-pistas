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
        m.v.push([c.x, c.y, c.h]); m.uv.push([c.u, vv]);
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
  const MAT = { DITCH: 'ditch', ROAD: 'asphalt', GRAVEL: 'gravel', WET: 'wet', LOOSE: 'loose', MUD: 'mud', SNOW: 'snow', ICE: 'ice', GRASS: 'grass', POWDER: 'powder' };

  // ---------- Modo RUTA (tramo / circuito) ----------
  // o: pts, closed, width, hSmooth, height(x,y), lines,
  //    widthAt(d), bankAt(d,k)->grados (con signo de la curva aplicado afuera), offsetAt(d), smoothSecs[{d0,d1}], surfaceAt(d,hLocal)->KEY
  function buildRoute(o) {
    const step = 2, closed = !!o.closed;
    let C = resample(o.pts, step, closed);
    C = smoothPts(C, 3, closed, 2);
    if (o.shapeAt) { // ajustes de forma hechos a mano (arrastrando en 3D)
      let d = 0;
      C = C.map((p, i) => { if (i) d += Math.hypot(p[0] - C[i - 1][0], p[1] - C[i - 1][1]); const [dx, dy] = o.shapeAt(d); return [p[0] + dx, p[1] + dy]; });
    }
    C = resample(C, step, closed);
    const n = C.length;
    const T = tangents(C, closed);
    const dist = [0]; for (let i = 1; i < n; i++) dist.push(dist[i - 1] + Math.hypot(C[i][0] - C[i - 1][0], C[i][1] - C[i - 1][1]));
    const total = dist[n - 1] + (closed ? Math.hypot(C[0][0] - C[n - 1][0], C[0][1] - C[n - 1][1]) : 0);
    // curvatura (1/m, positiva = gira a la izquierda)
    let K = [];
    for (let i = 0; i < n; i++) {
      let a = i - 1, b = i + 1;
      if (closed) { a = (a + n) % n; b = b % n; } else { a = Math.max(0, a); b = Math.min(n - 1, b); }
      const ta = T[a], tb = T[b], ang = Math.atan2(ta[0] * tb[1] - ta[1] * tb[0], ta[0] * tb[0] + ta[1] * tb[1]);
      K.push(ang / Math.max(step, (b - a) * step));
    }
    K = smooth1D(smooth1D(K, 3, closed), 3, closed);
    // alturas
    const raw = C.map(p => o.height(p[0], p[1]));
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
    if (o.offsetAt) hs = hs.map((h, i) => h + o.offsetAt(dist[i]));
    if (o.raise) hs = hs.map((h, i) => h + o.raise(C[i][0], C[i][1])); // rampas de acceso a puentes
    // ancho, peralte, superficie
    let W = dist.map(d => o.widthAt ? o.widthAt(d) : o.width);
    W = smooth1D(smooth1D(W, 4, closed), 4, closed);
    let SL = dist.map((d, i) => {
      const deg = o.bankAt ? o.bankAt(d, K[i]) : 0;
      const side = Math.max(-1, Math.min(1, K[i] * 150));
      return -Math.tan(deg * D2R_) * side;
    });
    SL = smooth1D(smooth1D(SL, 4, closed), 4, closed);
    const SURF = dist.map((d, i) => o.surfaceAt ? o.surfaceAt(d, hs[i]) : 'ROAD');
    // pendiente lateral del terreno real (positiva = el lado izquierdo es más alto): detecta laderas de montaña
    let CS = C.map((p, i) => {
      const nx = -T[i][1], ny = T[i][0], a = o.height(p[0] + nx * 15, p[1] + ny * 15), b = o.height(p[0] - nx * 15, p[1] - ny * 15);
      return (a - b) / 30;
    });
    CS = smooth1D(smooth1D(CS, 8, closed), 8, closed);
    // cunetas: 'auto' = del lado de arriba de la ladera, 'both' = ambos lados, 'none'
    const DW = 2.0, DD = 0.6, SH = o.shoulder || 6, mode = o.ditch || 'none';
    // 'auto': cuneta a ambos lados (como los caminos de ripio del bosque), más honda del lado alto de la ladera
    const autoD = cs => 0.35 + 0.25 * Math.min(1, Math.max(0, (cs - 0.03) / 0.1));
    let DLs = CS.map(cs => mode === 'both' ? DD : mode === 'auto' ? autoD(cs) : 0);
    let DRs = CS.map(cs => mode === 'both' ? DD : mode === 'auto' ? autoD(-cs) : 0);
    DLs = smooth1D(DLs, 5, closed); DRs = smooth1D(DRs, 5, closed);
    const EX = DW + SH;

    const crown = 0.02;
    const surfH = (i, s) => hs[i] + crown * (W[i] / 2 - Math.abs(s)) + SL[i] * s;
    // en horquillas cerradas, el borde interno no puede pasar el centro de la curva (evita que la malla se pliegue)
    const pos = (i, s) => { const nx = -T[i][1], ny = T[i][0], k = K[i]; if (s * k > 0) { const lim = 0.85 / Math.abs(k); if (Math.abs(s) > lim) s = Math.sign(s) * lim; } return [C[i][0] + nx * s, C[i][1] + ny * s]; };
    const sec = (i, j, dOff) => {
      const hw = W[i] / 2;
      return { cols: [-hw, 0, hw].map(s => { const [x, y] = pos(i, s); return { x, y, h: surfH(i, s), u: (s + hw) / W[i] }; }), d: dist[i] + dOff, step };
    };
    // tramos consecutivos con la misma superficie
    const segCount = closed ? n : n - 1, runs = [];
    for (let i = 0; i < segCount; i++) {
      const key = SURF[i], last = runs[runs.length - 1];
      if (last && last.key === key) last.i1 = i; else runs.push({ key, i0: i, i1: i });
    }
    const cnt = counters(), meshes = [];
    for (const run of runs) {
      const secs = [];
      for (let i = run.i0; i <= run.i1 + 1; i++) secs.push(sec(i % n, 0, i >= n ? total : 0));
      for (const m of ribbonMeshes(secs, false, run.key, MAT[run.key], 7, { next: () => cnt(run.key) })) meshes.push(m);
    }
    // banquinas y cunetas a los dos lados
    const DDmax = DLs.map((v, i) => Math.max(v, DRs[i]));
    for (const side of [1, -1]) {
      const Dd = side > 0 ? DLs : DRs, onBridge = i => o.bridge && o.bridge(C[i][0], C[i][1]), sideKey = i => onBridge(i) ? 'NONE' : Dd[i] > 0.12 ? 'DITCH' : 'VERGE', runs2 = [];
      for (let i = 0; i < segCount; i++) { const k = sideKey(i), last = runs2[runs2.length - 1]; if (last && last.key === k) last.i1 = i; else runs2.push({ key: k, i0: i, i1: i }); }
      for (const run of runs2) {
        if (run.key === 'NONE') continue; // en los puentes no hay banquina: se ve el río abajo
        const secs = [];
        for (let ii = run.i0; ii <= run.i1 + 1; ii++) {
          const i = ii % n, hw = W[i] / 2, e = surfH(i, side * hw), low = e - 0.15 - DDmax[i] + 0.03;
          const prof = [[hw, e], [hw + DW / 2, e - Dd[i]], [hw + DW, e - 0.04], [hw + DW + SH, low]];
          const ord = side > 0 ? prof : prof.slice().reverse();
          // u = distancia desde el borde del camino (0) hasta el final de la banquina (1)
          secs.push({ cols: ord.map(([s, h]) => { const [x, y] = pos(i, side * s); return { x, y, h, u: run.key === 'DITCH' ? (s - hw) / 2.5 : (s - hw) / (DW + SH) }; }), d: dist[i] + (ii >= n ? total : 0), step });
        }
        const key = run.key === 'DITCH' ? 'DITCH' : 'GRASS', mat = run.key === 'DITCH' ? 'ditch' : 'verge';
        for (const m of ribbonMeshes(secs, false, key, mat, 7, { next: () => (key === 'GRASS' ? 500 : 0) + cnt(key) })) meshes.push(m);
      }
    }
    if (o.lines) {
      const lw = 0.06, lift = 0.02, painted = k => k === 'ROAD' || k === 'WET';
      const mk = (side, dashed) => {
        const secs = [];
        for (let i = 0; i < n; i++) {
          const hw = W[i] / 2, off = side * (hw - 0.3);
          const cols = [off - lw, off + lw].map((s, k) => { const [x, y] = pos(i, s); return { x, y, h: surfH(i, s) + lift, u: k }; });
          const skip = !painted(SURF[i]) || (dashed && ((dist[i] % 12) > 4 || W[i] < 5.5));
          secs.push({ cols, d: dist[i], step, skip });
        }
        return secs;
      };
      const lc = counterFrom(0);
      for (const [side, dashed] of [[-1, false], [1, false], [0, true]])
        for (const m of ribbonMeshes(mk(side, dashed), closed, 'LINE', 'line', 1, lc)) { m.name = 'LINES_' + m.name.replace(/LINE$/, ''); meshes.push(m); }
    }
    const segs = [];
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % n;
      segs.push([C[i][0], C[i][1], C[j][0], C[j][1], hs[i], hs[j], W[i] / 2, SL[i], SL[j], EX, Math.max(DDmax[i], DDmax[j]), CS[i]]);
    }
    return { meshes, segs, C, T, hs, raw, dist, total, n, K, W, SL, SURF, closed, CS, DL: DLs, DR: DRs, EX };
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

  // ---------- Terreno ----------
  // o.surfAt(hLocal, pendiente, x, y) -> [CLAVE_FISICA, material]
  const DEF_SURF = ['GRASS', 'grass'];
  function buildTerrain(o, progress) {
    const { bbox, res } = o;
    const nx = Math.floor((bbox.maxx - bbox.minx) / res) + 1, ny = Math.floor((bbox.maxy - bbox.miny) / res) + 1;
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
    let near = null;
    if (isFinite(o.margin)) {
      near = new Uint8Array(hx * hy); const rr = Math.ceil(o.margin / cs);
      for (let cy = 0; cy < hy; cy++) for (let cx = 0; cx < hx; cx++) if (cells[cy * hx + cx]) {
        for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
          const X = cx + dx, Y = cy + dy; if (X >= 0 && Y >= 0 && X < hx && Y < hy && (dx * dx + dy * dy) * cs * cs <= (o.margin + cs * 1.5) ** 2) near[Y * hx + X] = 1;
        }
      }
    }
    const F = o.flat, B = o.blend, depth = o.depth;
    const R1 = maxHW + Math.max(Math.max(F, maxEX) + B, o.edgeFix ? 55 : 0), rr1 = Math.ceil(R1 / cs);
    const H = new Float32Array(nx * ny), need = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = bbox.miny + j * res;
      for (let i = 0; i < nx; i++) {
        const x = bbox.minx + i * res, cx = Math.floor((x - bbox.minx) / cs), cy = Math.floor((y - bbox.miny) / cs);
        if (near && !near[cy * hx + cx]) continue;
        need[j * nx + i] = 1;
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
        H[j * nx + i] = h;
      }
      if (progress && j % 50 === 0) progress(j / ny);
    }
    const CH = 60, meshes = [], cnt = counters();
    for (let cj = 0; cj < ny - 1; cj += CH) for (let ci = 0; ci < nx - 1; ci += CH) {
      const parts = {};
      const get = ([key, mat]) => parts[key + '|' + mat] || (parts[key + '|' + mat] = { m: Object.assign(newMesh(`${cnt(key)}${key}`, mat), { terrain: true }), map: new Map() });
      const vid = (P, i, j) => {
        const k = j * nx + i; if (P.map.has(k)) return P.map.get(k);
        const x = bbox.minx + i * res, y = bbox.miny + j * res;
        P.m.v.push([x, y, H[k]]); P.m.uv.push([x / 5, y / 5]); P.map.set(k, P.m.v.length - 1); return P.m.v.length - 1;
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
    return { meshes, nx, ny, H, need };
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
          const e = Math.hypot(s[0] + vx * t - x, s[1] + vy * t - y) - s[6] - (edgeOnly ? ((s[10] || 0) > 0.12 ? 1.6 : 0) : (s[9] || 0)); if (e < best) best = e;
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
        const edge = dr >= 2.2 && dr < CL + 5;
        const dens = (base * base) / (sp * sp) * (edge ? 3.5 : 1);
        if (r0 > dens) continue;
        if (edge && dr < CL + 1.5) kind = 2; else if (dr < CL) continue;
        if (dr < 2.2) continue; // no dentro de la cuneta
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
        if (!wm || wm.v.length > 50000) { wm = newMesh(`${o.wallCounter()}WALL`, 'bark'); walls.push(wm); }
        const r = kind === 0 ? 0.14 + ra * 0.1 : 0.12 + ra * 0.12, top = 2.8, b = wm.v.length, N = 8;
        for (let k = 0; k <= N; k++) { const a = k / N * Math.PI * 2; wm.v.push([x + Math.cos(a) * r, y + Math.sin(a) * r, h - 0.5], [x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, h + top]); wm.uv.push([k / N, 0], [k / N, 2]); }
        for (let k = 0; k < N; k++) { const a0 = b + k * 2, a1 = b + k * 2 + 2; wm.f.push([a0, a1, a1 + 1], [a0, a1 + 1, a0 + 1]); }
      }
    }
    const meshes = [...walls], PER = 3000;
    let m = null, n = 0;
    for (const [x, y, h, kind, ra, rb, , edgeB] of list) {
      if (!m || n >= PER) { m = newMesh('TREES_' + (meshes.length - walls.length), 'tree'); meshes.push(m); n = 0; }
      const Ht = kind === 2 ? (edgeB ? 2.2 + ra * 2.4 : 1.2 + ra * 1.5) : kind === 0 ? 7 + ra * 9 : 6 + ra * 7, W = kind === 0 ? Ht * 0.68 : kind === 1 ? Ht * 0.85 : Ht * 1.3;
      const slot = kind === 1 ? (ra > 0.5 ? 3 : 1) : kind, u0 = slot / 4, u1 = (slot + 1) / 4, ang = rb * Math.PI, z0 = h - 0.3;
      for (const a of [ang, ang + Math.PI / 2]) {
        const dx = Math.cos(a) * W / 2, dy = Math.sin(a) * W / 2, b = m.v.length;
        m.v.push([x - dx, y - dy, z0], [x + dx, y + dy, z0], [x + dx, y + dy, z0 + Ht], [x - dx, y - dy, z0 + Ht]);
        m.uv.push([u0, 0], [u1, 0], [u1, 1], [u0, 1]);
        m.f.push([b, b + 1, b + 2], [b, b + 2, b + 3]);
        const c = m.v.length; // cara trasera (para que se vea de los dos lados)
        m.v.push([x - dx, y - dy, z0], [x + dx, y + dy, z0], [x + dx, y + dy, z0 + Ht], [x - dx, y - dy, z0 + Ht]);
        m.uv.push([u0, 0], [u1, 0], [u1, 1], [u0, 1]);
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
      if (!m || m.v.length > 50000) { m = newMesh(isWall ? `${o.wallCounter()}WALL` : 'ROCKS_' + g.length, 'boulder'); g.push(m); }
      return m;
    };
    for (let i = 0; i < r.n; i++) for (const side of [1, -1]) {
      const dens = o.densityAt(i); if (dens <= 0) continue;
      if (hash2(i, side, 11) > dens * 0.13) continue;
      const size = 0.25 + Math.pow(hash2(i, side, 12), 2.2) * 1.6;
      const lat = side * (r.W[i] / 2 + r.EX + size + hash2(i, side, 13) * 5);
      const nx = -r.T[i][1], ny = r.T[i][0], x = r.C[i][0] + nx * lat, y = r.C[i][1] + ny * lat, h = hAt(x, y);
      if (h == null) continue;
      const isWall = size > 0.55, m = meshFor(isWall), b = m.v.length, rot = hash2(i, side, 14) * 6.283, cr = Math.cos(rot), sr = Math.sin(rot);
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

  return { MAT, buildTrees, buildRocks, roadDistFn, makeProj, resample, smooth1D, buildRoute, buildArea, buildTerrain, toOBJ, toMTL, computeNormals };
})();
if (typeof module !== 'undefined') module.exports = Core;
