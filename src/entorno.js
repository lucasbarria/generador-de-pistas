// ============================================================================================================
// Etapa 7 · ENTORNO: horizonte real, referencias del lugar (OSM) y chequeos automáticos
// ------------------------------------------------------------------------------------------------------------
// Horizonte: terreno lejano desde el modelo de elevación (Copernicus GLO-30 / Terrarium a z11 ≈ 45 m) hasta HZ.R m del
// centro del tramo, en una grilla con celdas que crecen con la distancia (niveles de detalle por geometría). Cerca del tramo
// usa la MISMA elevación fina que el terreno detallado (sin escalón); adentro del terreno detallado queda escondido 0,4 m
// abajo. Curvatura de la Tierra con refracción (k = 0,13). Textura propia (estepa con manchas secas, tierra, caminos y
// lagunas de OSM con fondo rojizo y barranca), más el detalle del pasto de cerca. Sin choque: solo se ve.
// Valores marcados PROVISIONAL / ESTIMADO_DE_FOTOS (6872, 6891, 6893): no son medidas del lugar.
// ============================================================================================================
const HZ = { R: 15000, S0: 30, G: 1.17, PAD: 1300, TEX: 2048, SINK: 0.4,
  COL: { // ESTIMADO_DE_FOTOS (tonos medios de la estepa en 6872 / 6891 / 6893, vistos de lejos con cielo nublado)
    verde: [112, 118, 76], seco: [158, 148, 104], tierra: [126, 108, 86], laguna: [172, 124, 110], orilla: [196, 186, 164], barranca: [140, 96, 80], agua: [150, 158, 162], camino: [168, 160, 146] } };

const DEMF = Object.assign(Object.create(DEM), { tiles: new Map(), custom: [] }); // segundo modelo de elevación, grueso, para lo lejano

function hzSmooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

async function overpassFar(B, ext) {
  const P = B.P, cx = (B.bbox.minx + B.bbox.maxx) / 2, cy = (B.bbox.miny + B.bbox.maxy) / 2, [n, w] = P.inv(cx - ext, cy + ext), [s, e] = P.inv(cx + ext, cy - ext), bb = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:40];(way["natural"~"water|wetland"](${bb});relation["natural"~"water|wetland"](${bb});way["water"](${bb});way["building"](${bb});node["place"~"farm|isolated_dwelling|hamlet"](${bb});way["power"~"line|minor_line"](${bb});way["highway"~"track|unclassified|tertiary|secondary|primary|trunk"](${bb}););out geom;`;
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try { const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal }); clearTimeout(tm); if (!r.ok) continue;
      const j = await r.json(), out = { water: [], blds: [], farms: [], power: [], roads: [] }, pts = g => g.map(p => P.fwd(p.lat, p.lon));
      for (const el of j.elements || []) { const t = el.tags || {};
        if (el.type === 'node') { out.farms.push({ p: P.fwd(el.lat, el.lon), name: t.name || '' }); continue; }
        if (el.type === 'relation') { for (const m of el.members || []) if (m.geometry && m.role !== 'inner') out.water.push({ pts: pts(m.geometry), wet: t.natural === 'wetland', int: t.intermittent === 'yes' || t.seasonal === 'yes' || /intermittent|salt/.test(t.water || '') }); continue; }
        if (!el.geometry) continue; const g = pts(el.geometry);
        if (t.building) out.blds.push(g); else if (t.power) out.power.push(g); else if (t.highway) out.roads.push({ pts: g, k: t.highway });
        else out.water.push({ pts: g, wet: t.natural === 'wetland', int: t.intermittent === 'yes' || t.seasonal === 'yes' || /intermittent|salt/.test(t.water || '') }); }
      return out; } catch (e) { }
  }
  return null;
}

// textura del campo lejano: estepa con manchas (dos escalas), tierra, sombreado suave del relieve, caminos y lagunas de OSM
function paintFarland(ext, cx, cy, hAt, osm) {
  const N = HZ.TEX, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'), im = x.createImageData(N, N), o = im.data, C = HZ.COL, mpp = 2 * ext / N;
  const SH = 256, hs = new Float32Array(SH * SH); for (let j = 0; j < SH; j++) for (let i = 0; i < SH; i++) hs[j * SH + i] = hAt(cx - ext + (i + 0.5) / SH * 2 * ext, cy + ext - (j + 0.5) / SH * 2 * ext);
  const cell = 2 * ext / SH;
  for (let py = 0; py < N; py++) { const wy = cy + ext - (py + 0.5) * mpp, gj = Math.min(SH - 2, Math.max(0, Math.floor((py + 0.5) / N * SH - 0.5)));
    for (let px = 0; px < N; px++) { const wx = cx - ext + (px + 0.5) * mpp, gi = Math.min(SH - 2, Math.max(0, Math.floor((px + 0.5) / N * SH - 0.5)));
      const k = gj * SH + gi, gx = (hs[k + 1] - hs[k]) / cell, gy = (hs[k] - hs[k + SH]) / cell, slope = Math.hypot(gx, gy), shade = 1 + Math.max(-0.12, Math.min(0.12, (-gx * 0.5 + gy * 0.8) * 6));
      const dry = hzSmooth(0.45, 0.75, vn2(wx / 900, wy / 900, 901) * 0.6 + vn2(wx / 210, wy / 210, 902) * 0.4), dirt = hzSmooth(0.78, 0.92, vn2(wx / 140, wy / 140, 903)) * 0.7, tex = 0.94 + 0.12 * vn2(wx / 37, wy / 37, 904);
      let r = C.verde[0] * (1 - dry) + C.seco[0] * dry, g = C.verde[1] * (1 - dry) + C.seco[1] * dry, b = C.verde[2] * (1 - dry) + C.seco[2] * dry;
      r = r * (1 - dirt) + C.tierra[0] * dirt; g = g * (1 - dirt) + C.tierra[1] * dirt; b = b * (1 - dirt) + C.tierra[2] * dirt;
      const bar = hzSmooth(0.12, 0.3, slope); r = r * (1 - bar) + C.barranca[0] * bar; g = g * (1 - bar) + C.barranca[1] * bar; b = b * (1 - bar) + C.barranca[2] * bar; // barrancas: tierra rojiza en las pendientes fuertes
      const q = (py * N + px) * 4; o[q] = Math.min(255, r * shade * tex); o[q + 1] = Math.min(255, g * shade * tex); o[q + 2] = Math.min(255, b * shade * tex); o[q + 3] = 255; } }
  x.putImageData(im, 0, 0);
  const tp = p => [(p[0] - (cx - ext)) / mpp, ((cy + ext) - p[1]) / mpp];
  if (osm) {
    x.lineCap = x.lineJoin = 'round';
    for (const rd of osm.roads) { x.strokeStyle = `rgb(${C.camino})`; x.lineWidth = Math.max(1, (rd.k === 'track' ? 4 : 8) / mpp); x.beginPath(); rd.pts.forEach((p, i) => { const [u, v] = tp(p); i ? x.lineTo(u, v) : x.moveTo(u, v); }); x.stroke(); }
    for (const w of osm.water) { if (w.pts.length < 3) continue; const path = () => { x.beginPath(); w.pts.forEach((p, i) => { const [u, v] = tp(p); i ? x.lineTo(u, v) : x.moveTo(u, v); }); x.closePath(); };
      // laguna seca (fondo rojizo) con orilla clara; las permanentes con un centro gris de agua baja. Mojadales: solo más verde y oscuro.
      if (w.wet) { path(); x.fillStyle = 'rgba(70,92,52,0.45)'; x.fill(); continue; }
      path(); x.strokeStyle = `rgba(${C.orilla},0.9)`; x.lineWidth = Math.max(2, 14 / mpp); x.stroke(); x.fillStyle = `rgb(${C.laguna})`; x.fill();
      if (!w.int) { x.save(); path(); x.clip(); x.strokeStyle = `rgba(${C.laguna},1)`; x.lineWidth = Math.max(3, 60 / mpp); path(); x.fillStyle = `rgba(${C.agua},0.55)`; x.fill(); x.stroke(); x.restore(); } }
  }
  c.__dxt = true; return c;
}

// grilla con celdas que crecen con la distancia: coordenadas a lo largo de un eje (en metros desde el centro)
function hzAxis(half) { const inner = [], n = Math.ceil(2 * half / HZ.S0); for (let i = 0; i <= n; i++) inner.push(-half + i * 2 * half / n);
  const outer = []; let p = half, st = HZ.S0; while (p < HZ.R) { st *= HZ.G; p = Math.min(HZ.R, p + st); outer.push(p); }
  return [...outer.slice().reverse().map(v => -v), ...inner, ...outer]; }

async function buildHorizon(B, o, res, ter, meshes) {
  if (B.mode !== 'route') return null; const t0 = performance.now(), P = B.P, bb = B.bbox, cx = (bb.minx + bb.maxx) / 2, cy = (bb.miny + bb.maxy) / 2;
  const hx = (bb.maxx - bb.minx) / 2 + HZ.PAD, hy = (bb.maxy - bb.miny) / 2 + HZ.PAD, ext = HZ.R + Math.max(hx, hy);
  // elevación gruesa del área lejana (una vez por recorrido)
  if (!B.farDem) { const [n, w] = P.inv(cx - ext, cy + ext), [s, e] = P.inv(cx + ext, cy - ext); log(`Horizonte: bajando elevación de ${(2 * ext / 1000).toFixed(0)} × ${(2 * ext / 1000).toFixed(0)} km…`);
    DEMF.lat0 = B.lat0; DEMF.smoothM = 60; await DEMF.load(s, w, n, e, 11); B.farDem = { tiles: DEMF.tiles, z: 11 }; }
  else { DEMF.tiles = B.farDem.tiles; DEMF.z = B.farDem.z; }
  if (B.farOsm === undefined) { try { B.farOsm = await overpassFar(B, ext); } catch (e) { B.farOsm = null; } } // null = no respondió (no se reintenta en cada regeneración)
  const osm = B.farOsm, hT = Core.terrainHeightFn(ter, bb, o.res), off = B.demOff || 0;
  // borde de la elevación fina (tiles cargados a z de DEM): se mezcla con la gruesa en los últimos 500 m
  let tx0 = Infinity, tx1 = -Infinity, ty0 = Infinity, ty1 = -Infinity; for (const k of DEM.tiles.keys()) { const [a, b] = k.split(',').map(Number); tx0 = Math.min(tx0, a); tx1 = Math.max(tx1, a); ty0 = Math.min(ty0, b); ty1 = Math.max(ty1, b); }
  const mppF = 156543.03 * Math.cos(B.lat0 * D2R) / 2 ** DEM.z, Kc = (1 - 0.13) / (2 * 6371000);
  const hAt = (x, y) => { const [la, lo] = P.inv(x, y), coarse = DEMF.sample(la, lo) - B.h0 - off; let h = coarse;
    if (DEM.tiles.size) { const [fx, fy] = DEM.px(la, lo), dIn = Math.min(fx - tx0 * 256, (tx1 + 1) * 256 - fx, fy - ty0 * 256, (ty1 + 1) * 256 - fy) * mppF;
      if (dIn > 0) { const wf = hzSmooth(0, 500, dIn); h = coarse * (1 - wf) + B.height(x, y) * wf; } }
    const dc = Math.hypot(x - cx, y - cy), micro = (vn2(x / 170, y / 170, 991) - 0.5) * 1.6 * (1 - hzSmooth(1500, 4500, dc)); // lomitas que el modelo de 30 m no tiene (PROVISIONAL)
    return h + micro - dc * dc * Kc; };
  const xs = hzAxis(hx), ys = hzAxis(hy), NX = xs.length, NY = ys.length, V = [], UV = [], inside = new Uint8Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const x = cx + xs[i], y = cy + ys[j], t = hT(x, y); let h;
    if (t != null) { h = t - HZ.SINK; inside[j * NX + i] = 1; } else h = hAt(x, y);
    V.push([x, y, h]); UV.push([(x - (cx - ext)) / (2 * ext), (y - (cy - ext)) / (2 * ext)]); }
  const F = []; for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, c = a + NX + 1, d = a + NX;
    if (inside[a] && inside[b] && inside[c] && inside[d]) continue; F.push([a, b, c], [a, c, d]); }
  TEX.farland = paintFarland(ext, cx, cy, hAt, osm); TEX.farland.__ext = ext; TEX_DEFAULT.farland = TEX.farland; if (PV.mats && PV.mats.farland) { try { PV.mats.farland.map.dispose(); } catch (e) { } delete PV.mats.farland; }
  const m = { name: 'far_terreno', mat: 'farland', v: V, uv: UV, f: F, far: true, ext }; m.n = Core.computeNormals ? Core.computeNormals(m) : undefined; if (!m.n || m.n.length !== V.length) delete m.n;
  meshes.push(m);
  const land = await buildLandmarks(B, o, res, hAt, hT, osm, cx, cy); meshes.push(...land.meshes);
  const nw = osm ? osm.water.length : 0;
  log(`Horizonte: terreno lejano hasta ${(HZ.R / 1000).toFixed(0)} km con el modelo de elevación (z11) y curvatura de la Tierra · ${V.length.toLocaleString()} vértices · celdas de ${HZ.S0} m cerca a ${Math.round(Math.max(...xs.map((v, i) => i ? Math.abs(v - xs[i - 1]) : 0)))} m lejos · ${osm ? `OSM: ${nw} lagunas/mallines, ${osm.roads.length} caminos, ${osm.blds.length} edificios, ${osm.power.length} líneas eléctricas` : 'sin datos de OSM (no respondió)'} · ${land.txt} (${((performance.now() - t0) / 1000).toFixed(1)} s).`, 'ok');
  return { hAt, ext };
}

// ---------- referencias del lugar: casco de estancia, postes de luz, alambrados que siguen el camino y se pierden ----------
async function buildLandmarks(B, o, res, hAt, hT, osm, cx, cy) {
  for (const k of OBJ_MATS) if (!TEX[k] || !TEX[k].__obj) { TEX[k] = TEX_DEFAULT[k] = objTex(k); TEX[k].__obj = 1; }
  const meshes = [], M = {}, mesh = mat => { if (!M[mat] || M[mat].v.length > 40000) { M[mat] = { name: `far_obj_${mat}_${meshes.length}`, mat, v: [], uv: [], f: [] }; meshes.push(M[mat]); } return M[mat]; };
  const gz = (x, y) => { const t = hT(x, y); return t != null ? t : hAt(x, y); };
  const box = (mat, x, y, w, d, z0, z1, ang) => { const m = mesh(mat), b = m.v.length, ca = Math.cos(ang), sa = Math.sin(ang), P = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => [x + ca * u - sa * v, y + sa * u + ca * v]);
    for (let k = 0; k < 4; k++) { const p = P[k], q = P[(k + 1) % 4], L = Math.hypot(q[0] - p[0], q[1] - p[1]), c = m.v.length; m.v.push([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]); m.uv.push([0, 0], [L / 3, 0], [L / 3, (z1 - z0) / 3], [0, (z1 - z0) / 3]); m.f.push([c, c + 1, c + 2], [c, c + 2, c + 3]); }
    const c = m.v.length; m.v.push(...P.map(p => [p[0], p[1], z1])); m.uv.push([0, 0], [1, 0], [1, 1], [0, 1]); m.f.push([c, c + 1, c + 2], [c, c + 2, c + 3]); void b; };
  const house = (x, y, L, W, H, ang, wall, roof) => { const z = gz(x, y) - 0.3; box(wall, x, y, L, W, z, z + H + 0.3, ang);
    const m = mesh(roof), ca = Math.cos(ang), sa = Math.sin(ang), at = (u, v) => [x + ca * u - sa * v, y + sa * u + ca * v], rh = W * 0.32, zt = z + H + 0.3, e = 0.4;
    const A = at(-L / 2 - e, -W / 2 - e), Bq = at(L / 2 + e, -W / 2 - e), C = at(L / 2 + e, 0), D = at(-L / 2 - e, 0), E = at(L / 2 + e, W / 2 + e), F = at(-L / 2 - e, W / 2 + e), c = m.v.length;
    m.v.push([A[0], A[1], zt], [Bq[0], Bq[1], zt], [C[0], C[1], zt + rh], [D[0], D[1], zt + rh], [E[0], E[1], zt], [F[0], F[1], zt]); m.uv.push([0, 0], [L / 3, 0], [L / 3, 1.5], [0, 1.5], [L / 3, 0], [0, 0]);
    m.f.push([c, c + 1, c + 2], [c, c + 2, c + 3], [c + 3, c + 2, c + 4], [c + 3, c + 4, c + 5]); };
  const rdD = Core.roadDistFn(res.segs, true); let txt = [];
  // 1) casco de estancia: donde OSM tiene una estancia/puesto o edificios (lo más cerca del tramo, a más de 400 m); si no hay, uno al azar con semilla
  let sites = []; if (osm) { for (const f of osm.farms) sites.push({ p: f.p, name: f.name }); for (const b of osm.blds) { const c0 = b.reduce((a, p) => [a[0] + p[0] / b.length, a[1] + p[1] / b.length], [0, 0]); sites.push({ p: c0, bld: b }); } }
  sites = sites.filter(s => rdD(s.p[0], s.p[1], 500) > 400 && Math.hypot(s.p[0] - cx, s.p[1] - cy) < 9000).sort((a, b) => Math.hypot(a.p[0] - cx, a.p[1] - cy) - Math.hypot(b.p[0] - cx, b.p[1] - cy));
  const seed = (typeof RELIEF !== 'undefined' && RELIEF.SD) || 1, rnd = k => hashU(seed, k, 4242);
  let fromOsm = sites.length > 0; if (!sites.length) { for (let k = 0; k < 40 && !sites.length; k++) { const a = rnd(k) * 6.283, r = 1800 + 2200 * rnd(k + 100), p = [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; if (rdD(p[0], p[1], 600) > 500) sites.push({ p, name: '' }); } }
  const placed = []; for (const s0 of sites) { if (placed.some(q => Math.hypot(q[0] - s0.p[0], q[1] - s0.p[1]) < 600) || placed.length >= 3) continue; placed.push(s0.p);
    const ang = rnd(placed.length * 7) * Math.PI, [x, y] = s0.p, ca = Math.cos(ang), sa = Math.sin(ang), at = (u, v) => [x + ca * u - sa * v, y + sa * u + ca * v];
    house(x, y, 14, 8, 2.8, ang, 'bwall', 'broofr'); { const p = at(26, 6); house(p[0], p[1], 24, 12, 4.2, ang, 'bconc', 'broofs'); } { const p = at(-8, 24); house(p[0], p[1], 9, 6, 2.5, ang + 0.05, 'bwall', 'broofs'); } }
  txt.push(placed.length ? `${placed.length} casco(s) de estancia ${fromOsm ? 'en lugares de OSM' : '(sin dato en OSM: lugar al azar con la semilla)'}` : 'sin cascos');
  // 2) postes de luz: solo donde OSM tiene una línea (cada 80 m, tendido en dos cables)
  let npl = 0; if (osm) for (const ln of osm.power) { let acc = 0; for (let i = 1; i < ln.length; i++) { const a = ln[i - 1], b = ln[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      for (let t = (80 - acc) % 80; t < L; t += 80) { const x = a[0] + (b[0] - a[0]) * t / L, y = a[1] + (b[1] - a[1]) * t / L; if (Math.hypot(x - cx, y - cy) > 7000) continue; const z = gz(x, y); box('fpost', x, y, 0.24, 0.24, z - 0.5, z + 8, ang); box('fpost', x, y, 1.6, 0.12, z + 7.4, z + 7.55, ang + Math.PI / 2); npl++; } acc = (acc + L) % 80; } }
  txt.push(npl ? `${npl} postes de luz (OSM)` : 'sin líneas eléctricas en OSM');
  // 3) alambrados que siguen el camino más allá de las puntas del tramo (por el camino de OSM si sigue), hasta 3,5 km: postes cada 5 m
  //    de madera irregulares (alto 1,1–1,35 m, algunos torcidos) con uno de hierro cada 4 (fina, gris), y dos hilos
  let npo = 0; const ends = [[res.C[0], [-res.T[0][0], -res.T[0][1]]], [res.C[res.n - 1], res.T[res.n - 1]]];
  const follow = (p0, dir) => { // sigue el camino de OSM que arranca en la punta, o una recta
    let best = null; if (osm) for (const rd of osm.roads) for (let i = 0; i < rd.pts.length; i++) { const q = rd.pts[i], d = Math.hypot(q[0] - p0[0], q[1] - p0[1]); if (d < 60 && (!best || d < best.d)) best = { rd, i, d }; }
    const out = [p0]; if (best) { const pts = best.rd.pts, nx = pts[Math.min(pts.length - 1, best.i + 1)], pv = pts[Math.max(0, best.i - 1)], fwd = (nx[0] - p0[0]) * dir[0] + (nx[1] - p0[1]) * dir[1] > (pv[0] - p0[0]) * dir[0] + (pv[1] - p0[1]) * dir[1];
      for (let i = best.i; fwd ? i < pts.length : i >= 0; i += fwd ? 1 : -1) { out.push(pts[i]); if (out.length > 2 && Math.hypot(pts[i][0] - p0[0], pts[i][1] - p0[1]) > 3500) break; } }
    if (out.length < 3) for (let s = 50; s <= 3500; s += 50) out.push([p0[0] + dir[0] * s, p0[1] + dir[1] * s]);
    return out; };
  for (const [p0, dir] of ends) { const path = follow(p0, dir), Lr = Math.hypot(dir[0], dir[1]) || 1; void Lr;
    for (const sg of [1, -1]) { let acc = 0, k = 0; const off = (res.W[0] / 2 || 3) + 7;
      for (let i = 1; i < path.length; i++) { const a = path[i - 1], b = path[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.01) continue; const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L, nx = -ty * sg, ny = tx * sg;
        for (let t = (5 - acc % 5) % 5; t < L; t += 5) { const x = a[0] + tx * t + nx * off, y = a[1] + ty * t + ny * off; if (hT(x, y) != null && rdD(x, y, 30) < 25) continue; const z = gz(x, y), r1 = hashU(k, sg, 77), iron = k % 4 === 3;
          const hgt = iron ? 1.2 : 1.1 + 0.25 * r1, lean = iron ? 0 : (r1 - 0.5) * 0.18; box(iron ? 'brail' : 'fpost', x + lean * nx, y + lean * ny, iron ? 0.05 : 0.11 + 0.04 * r1, iron ? 0.05 : 0.11, z - 0.2, z + hgt, Math.atan2(ty, tx) + (r1 - 0.5) * 0.3); k++; npo++; }
        acc += L; } } }
  txt.push(`${npo} postes de alambrado siguiendo el camino fuera del tramo`);
  return { meshes, txt: txt.join(' · ') };
}

// ============================================================================================================
// CHEQUEOS AUTOMÁTICOS (Etapa 7): caras degeneradas o sueltas, cambios fuera del tramo, NaN en parámetros, sprites sin alfa
// ============================================================================================================
const CHEQ = {
  // caras: área ~0, lados de largo absurdo (vértices fuera de lugar), o "cuchillas": triángulos larguísimos y finos
  faces(meshes) { const out = { deg: 0, cuchillas: 0, nan: 0, malas: [] };
    for (const m of meshes) { if (!m.v || !m.f || m.far) continue; let bad = 0;
      for (const f of m.f) { const a = m.v[f[0]], b = m.v[f[1]], c = m.v[f[2]]; if (!a || !b || !c || [a, b, c].some(p => !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2]))) { out.nan++; bad++; continue; }
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], area = Math.hypot(...cr) / 2;
        const L = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]));
        if (area < 1e-7) { out.deg++; bad++; } else if (L > 60 && area / (L * L) < 0.002 && !/TREES|line|fwire|far_/.test(m.name + m.mat)) { out.cuchillas++; bad++; } }
      if (bad) out.malas.push(`${m.name} (${m.mat}): ${bad}`); }
    return out; },
  edits(total) { const out = []; for (const e of S.edits || []) { const [a, b] = typeof edExtent === 'function' ? edExtent(e) : [e.d0 ?? e.d, e.d1 ?? e.d];
      if (e.kind !== 'raise' && (a < -0.01 || b > total + 0.01)) out.push(`${e.kind} ${(a / 1000).toFixed(2)}–${(b / 1000).toFixed(2)} km`); } return out; },
  nan() { const out = []; for (const e of S.edits || []) for (const [k, v] of Object.entries(e)) if (typeof v === 'number' && !isFinite(v)) out.push(`${e.kind}.${k}`);
    // textos del panel "Cambios cercanos": ningún NaN
    if (typeof edTransInfo === 'function' && typeof EDIT_TXT !== 'undefined') for (const e of S.edits || []) { const s = (EDIT_TXT[e.kind] ? EDIT_TXT[e.kind](e) : '') + ' ' + edTransInfo(e); if (/NaN|undefined/.test(s)) out.push(`texto: ${s}`); }
    return out; },
  // sprites con transparencia: el material de la vista web tiene que usar alphaTest y la textura tiene que tener alfa real y color sangrado (sin bordes negros)
  sprites(meshes) { const out = []; const mats = new Set(meshes.filter(m => /tuft|tree|leaves|lenga|fwire|grassblade/.test(m.mat)).map(m => m.mat));
    for (const k of mats) { const cv = TEX[k]; if (!cv) { out.push(`${k}: sin textura`); continue; } const d = cv.__raw || (cv.getContext && cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data); if (!d) continue;
      let tr = 0, dark = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 53) { n++; if (d[i + 3] < 128) { tr++; if (d[i] + d[i + 1] + d[i + 2] < 30) dark++; } }
      if (!tr) out.push(`${k}: sin transparencia`); else if (dark / tr > 0.5 && !cv.__raw) out.push(`${k}: borde transparente negro (sin sangrado de color)`);
      const pm = PV.mats && PV.mats[k]; if (pm && !(pm.alphaTest > 0) && !pm.transparent) out.push(`${k}: material sin alphaTest`); }
    return out; },
  run(R) { R = R || S.result; if (!R) return null; const total = R.res ? R.res.total : 0, f = this.faces(R.meshes), e = this.edits(total), n = this.nan(), s = this.sprites(R.meshes);
    const ok = !f.deg && !f.cuchillas && !f.nan && !e.length && !n.length && !s.length;
    return { ok, caras: f, fuera_del_tramo: e, nan: n, sprites: s }; },
  report(R) { const r = this.run(R); if (!r) return; const f = r.caras;
    log(`Chequeo automático: caras degeneradas ${f.deg} · cuchillas ${f.cuchillas} · vértices NaN ${f.nan} · cambios fuera del tramo ${r.fuera_del_tramo.length} · NaN en parámetros ${r.nan.length} · sprites con alfa mal ${r.sprites.length}${r.ok ? ' ✓' : ' — ' + [...f.malas.slice(0, 4), ...r.fuera_del_tramo, ...r.nan, ...r.sprites].join('; ')}`, r.ok ? 'ok' : 'err'); return r; },
};

// ---------- Assetto Corsa + CSP: ext_config.ini (solo tiene efecto con Custom Shaders Patch) ----------
// GrassFX: pasto con volumen sobre el terreno y el pasto de los costados (no sobre el camino ni las bandas de ripio/cordón).
// Material_DistantGeometry: el campo lejano se dibuja aunque esté a 15 km. La bruma y el cielo en AC los pone el clima de CSP
// (WeatherFX: Sol / Pure): la pista no puede imponerlos; se recomienda clima nublado ("heavy clouds"/"overcast").
function cspExtConfig(R) {
  const mats = [...new Set(R.meshes.filter(m => !m.physOnly && !m.pvHide).map(m => m.mat))], has = re => mats.filter(k => re.test(k));
  const grass = [...new Set([...has(/^tc_/).length ? ['tc_?'] : [], ...has(/^(grass|side_[a-d])$/)])], occ = [...new Set([...has(/^rs_/).length ? ['rs_?'] : [], ...has(/^sb_/).length ? ['sb_?'] : [], ...has(/^(gravel|loose|clay|asphalt|ditch\w*|verge|mud|water|bank)$/)])];
  return [`; ext_config.ini generado por el Generador de Pistas (Etapa 7). Requiere Custom Shaders Patch (CSP) ≥ 0.1.79.`, ``,
    `[INCLUDE: common/materials_track.ini]`, ``,
    `[GRASS_FX]`, `; pasto corto de estepa: verde con manchas secas (ESTIMADO_DE_FOTOS 6870, 6873, 6891). Denso cerca, más ralo lejos (lo maneja CSP).`,
    `GRASS_MATERIALS = ${grass.join(', ')}`, `OCCLUDING_MATERIALS = ${occ.join(', ')}`, `ORIGINAL_GRASS_MATERIALS = tuft`,
    `MASK_MAIN_THRESHOLD = -1`, `MASK_RED_THRESHOLD = 0`, `SHAPE_SIZE = 0.55`, `SHAPE_TIDY = 0.15`, `SHAPE_CUT = 0.3`, `SHAPE_WIDTH = 1.0`, ``,
    `[Material_DistantGeometry]`, `Meshes = far_terreno?`, ``,
    `[LIGHTING]`, `LIT_MULT = 1`, `SPECULAR_MULT = 0.6`, ``].join('\r\n');
}

// ---------- Vista web: pasto con volumen instanciado alrededor de la cámara (equivalente a GrassFX de CSP) ----------
// Matas de 5 hojas (5–14 cm), manchas secas con el mismo ruido que el terreno, flores amarillas (diente de león), rosetas planas con
// centro rojizo y yuyos más altos (20–45 cm) en el borde del camino donde el costado es de pasto (tipos C y D). Denso cerca, ralo lejos:
// 14 matas/m² hasta 10 m, 5 hasta 25 m, 1,2 hasta 45 m y 0,3 hasta 70 m. Se rearma cuando la cámara se mueve más de 8 m.
// Densidades y tamaños ESTIMADO_DE_FOTOS (6870, 6873, 6891).
const PVGRASS = { on: true, last: null, objs: [],
  geo() { if (this.G) return this.G; const mk = (nb, w, lean) => { const pos = []; for (let k = 0; k < nb; k++) { const a = k / nb * 6.283 + 0.4 * Math.sin(k * 7.1), ca = Math.cos(a), sa = Math.sin(a), l = lean * (0.6 + 0.4 * Math.sin(k * 3.3));
        pos.push(-sa * w, 0, ca * w, sa * w, 0, -ca * w, ca * l, 1, sa * l); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0); return g; };
    const ros = (() => { const pos = []; for (let k = 0; k < 7; k++) { const a = k / 7 * 6.283, ca = Math.cos(a), sa = Math.sin(a), b = a + 0.35, cb = Math.cos(b), sb = Math.sin(b), c = a - 0.35, cc = Math.cos(c), sc = Math.sin(c);
        pos.push(0, 0.01, 0, cb * 0.45, 0.03, sb * 0.45, ca, 0.06, sa, 0, 0.01, 0, ca, 0.06, sa, cc * 0.45, 0.03, sc * 0.45); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g; })();
    const flw = (() => { const g = new THREE.BufferGeometry(), pos = [], r = 0.5; for (let k = 0; k < 8; k++) { const a = k / 8 * 6.283, b = (k + 1) / 8 * 6.283; pos.push(0, 1, 0, Math.cos(a) * r, 1, Math.sin(a) * r, Math.cos(b) * r, 1, Math.sin(b) * r); } pos.push(0, 0, 0, 0.04, 0, 0, 0, 1, 0); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0); return g; })();
    return (this.G = { tuft: mk(5, 0.09, 0.35), weed: mk(7, 0.06, 0.25), ros, flw }); },
  clear() { for (const o of this.objs) { PV.scene.remove(o); o.dispose && o.dispose(); } this.objs = []; },
  // alturas: terreno detallado (exacto) y bandas de los costados (vértice más cercano en celdas de 0,5 m)
  prep(R) { const res = R.res; this.R = R; this.hT = Core.terrainHeightFn(R.ter, R.bbox, R.o.res); const H = new Map(), key = (x, y) => (Math.round(x * 2) + 200000) * 400000 + Math.round(y * 2) + 200000;
    for (const m of R.meshes) if (m.sideVis || (m.route && /grass|verge|side_|^tc_/.test(m.mat) && !m.physOnly)) for (const v of m.v) { const k = key(v[0], v[1]); if (!H.has(k)) H.set(k, v[2]); }
    this.hB = (x, y) => { const k = key(x, y); if (H.has(k)) return H.get(k); for (const [dx, dy] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) { const k2 = key(x + dx, y + dy); if (H.has(k2)) return H.get(k2); } return null; };
    this.MAT = { A: ['loose', 'loose', 'canal', 'canal', 'cordon'], B: ['loose', 'loose', 'canal', 'canal', 'wall'], C: ['weed', 'shoulder', 'shoulder', 'shoulder', 'cordon'], D: ['stones', 'stones', 'grass', 'grass', 'grass'] }; this.last = null; },
  bandMat(tag, d, arc) { const rows = this.R.res.sideBands && this.R.res.sideBands[tag]; if (!rows || !rows.length) return 'grass'; let lo = 0, hi = rows.length - 1; while (hi - lo > 1) { const mi = (lo + hi) >> 1; if (rows[mi].d < d) lo = mi; else hi = mi; }
    const r = rows[lo]; if (arc >= r.arcK[5]) return 'grass'; let k = 0; while (k < 4 && arc >= r.arcK[k + 1]) k++; const ty = ['A', 'B', 'C', 'D'].reduce((a, t) => (r.w[t] || 0) > (r.w[a] || 0) ? t : a, 'B'); const mt = this.MAT[ty][k]; return mt === 'cordon' && r.old ? 'grass' : mt; },
  update() { if (!this.on || !PV.scene || !this.R || !this.R.res || this.R.mode !== 'route') return; const cam = PV.camera.position, cx = cam.x, cy = -cam.z;
    if (this.last && Math.hypot(cx - this.last[0], cy - this.last[1]) < 8 && Math.abs(cam.y - this.last[2]) < 20) return; this.last = [cx, cy, cam.y];
    const res = this.R.res; let bi = 0, bd = Infinity; for (let i = 0; i < res.n; i += 2) { const q = Math.hypot(res.C[i][0] - cx, res.C[i][1] - cy); if (q < bd) { bd = q; bi = i; } }
    this.clear(); const camH = cam.y - res.hs[bi]; if (bd > 110 || camH > 60) return;
    const G = this.geo(), T = { tuft: [], weed: [], ros: [], flw: [] }, d0 = res.dist[bi], zones = [[10, 14], [25, 5], [45, 1.2], [70, 0.3]];
    const idxAt = d => { let lo = 0, hi = res.n - 1; while (hi - lo > 1) { const mi = (lo + hi) >> 1; if (res.dist[mi] < d) lo = mi; else hi = mi; } return lo; };
    let rmin = 0; for (const [rmax, dens] of zones) { const st = 1 / Math.sqrt(dens);
      for (let d = Math.max(0, d0 - rmax - 5); d < Math.min(res.total, d0 + rmax + 5); d += st) { const i = idxAt(d), C = res.C[i], Tt = res.T[i], hw = res.W[i] / 2;
        for (let s = -rmax - 5; s < rmax + 5; s += st) { const j1 = hashU(Math.round(d / st), Math.round(s / st), 11 + rmax), j2 = hashU(Math.round(d / st), Math.round(s / st), 13 + rmax), dd = d + (j1 - 0.5) * st, ss = s + (j2 - 0.5) * st;
          if (Math.abs(ss) < hw + 0.05) continue; const x = C[0] - Tt[1] * ss + Tt[0] * (dd - d), y = C[1] + Tt[0] * ss + Tt[1] * (dd - d), r = Math.hypot(x - cx, y - cy); if (r < rmin || r >= rmax) continue;
          const arc = Math.abs(ss) - hw, tag = ss > 0 ? 'L' : 'R', mt = arc < 6.6 ? this.bandMat(tag, dd, arc) : 'grass'; if (mt !== 'grass' && mt !== 'weed') continue;
          let z = arc < 6.6 ? this.hB(x, y) : null; if (z == null) z = this.hT(x, y); if (z == null) continue;
          const u = hashU(Math.round(x * 7), Math.round(y * 7), 21), dry = vn2(x / 7, y / 7, 905) * 0.7 + vn2(x / 1.9, y / 1.9, 906) * 0.3;
          if (mt === 'weed' || (arc < 0.9 && arc > 0.05 && u < 0.35)) T.weed.push([x, y, z, 0.2 + 0.25 * u, dry]);
          else if (u < 0.05) T.flw.push([x, y, z, 0.07 + 0.05 * u * 20, dry]); else if (u < 0.12) T.ros.push([x, y, z, 0.06 + 0.06 * (u - 0.05) * 14, dry]); else T.tuft.push([x, y, z, 0.06 + 0.11 * u, dry]); } }
      rmin = rmax; }
    const mat = (col) => new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide }), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), Sc = new THREE.Vector3(), cl = new THREE.Color();
    const put = (geo, list, base, colFn, flat) => { if (!list.length) return; const im = new THREE.InstancedMesh(geo, mat(0xffffff), list.length);
      list.forEach((p, k) => { E.set(flat ? 0 : (hashU(k, 1, 31) - 0.5) * 0.3, hashU(k, 2, 31) * 6.283, flat ? 0 : (hashU(k, 3, 31) - 0.5) * 0.3); Q.setFromEuler(E); V.set(p[0], p[2] - 0.01, -p[1]); const sc = p[3]; Sc.set(flat ? sc : sc * 0.9, flat ? 1 : sc, flat ? sc : sc * 0.9); M.compose(V, Q, Sc); im.setMatrixAt(k, M); colFn(cl, p, k); im.setColorAt(k, cl); });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; im.frustumCulled = false; im.receiveShadow = true; PV.scene.add(im); this.objs.push(im); };
    const green = [0.33, 0.40, 0.19], dryc = [0.62, 0.56, 0.36];
    put(G.tuft, T.tuft, null, (c, p, k) => { const w = Math.max(0, Math.min(1, (p[4] - 0.42) / 0.3)), v = 0.85 + 0.3 * hashU(k, 5, 7); c.setRGB((green[0] * (1 - w) + dryc[0] * w) * v, (green[1] * (1 - w) + dryc[1] * w) * v, (green[2] * (1 - w) + dryc[2] * w) * v); });
    put(G.weed, T.weed, null, (c, p, k) => { const v = 0.8 + 0.35 * hashU(k, 6, 7), w = 0.35 + 0.4 * p[4]; c.setRGB((0.30 * (1 - w) + 0.58 * w) * v, (0.36 * (1 - w) + 0.52 * w) * v, (0.18 * (1 - w) + 0.32 * w) * v); });
    put(G.ros, T.ros, null, (c, p, k) => { const red = hashU(k, 8, 7) < 0.4; c.setRGB(red ? 0.42 : 0.24, red ? 0.30 : 0.36, red ? 0.20 : 0.16); }, true);
    put(G.flw, T.flw, null, (c) => c.setRGB(0.95, 0.80, 0.12));
    this.count = T.tuft.length + T.weed.length + T.ros.length + T.flw.length; },
};

// ---------- Huellones (Etapa 7): a mano (herramienta del editor) y al azar con semilla ----------
// Forma: dos surcos (profundidad D, ancho rw) separados 'sep' (centro a centro), lomo del medio y labios más altos con ripio suelto,
// fondo compactado y más oscuro/húmedo. En curva se corren hacia afuera (Core). Transición en las puntas DENTRO del tramo elegido.
// Al azar: ~1 tramo cada 1,5 km de 40–120 m, 5–11 cm de hondo (PROVISIONAL), misma semilla = mismos huellones.
const RUTS = { azar: true,
  vn1(x, s) { const i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f); return hashU(i, s, 61) * (1 - t) + hashU(i + 1, s, 61) * t; },
  zones(total) { const sd = (typeof RELIEF !== 'undefined' && RELIEF.SD) || 1, key = sd + ':' + Math.round(total || 0); if (this._z && this._z.key === key) return this._z.list;
    const list = []; if (this.azar && total > 400) { const n = Math.max(0, Math.round(total / 1500 * (0.6 + 0.8 * hashU(sd, 1, 71))));
      for (let k = 0; k < n * 4 && list.length < n; k++) { const L = 40 + 80 * hashU(sd, k, 72), a = 150 + (total - 300 - L) * hashU(sd, k, 73); if (list.some(z => a < z.b + 150 && a + L > z.a - 150)) continue;
        list.push({ a, b: a + L, D: 0.05 + 0.06 * hashU(sd, k, 74), rw: 0.2 + 0.06 * hashU(sd, k, 75), sep: 1.5 + 0.14 * hashU(sd, k, 76), irr: 0.5, ramp: Math.min(L / 3, 18), azar: true }); } }
    this._z = { key, list }; return list; },
  shape(z, d, seed) { const R = Math.max(1, z.ramp ?? 15), w0 = Math.min(1, (d - z.a) / R, (z.b - d) / R); if (w0 <= 0) return null; const w = w0 * w0 * (3 - 2 * w0), irr = z.irr ?? 0.4;
    return { D: (z.D ?? 0.14) * w * (1 + irr * (this.vn1(d / 6.5, seed) - 0.5) * 1.1), tw: (z.sep ?? 1.56) / 2 + irr * 0.07 * (this.vn1(d / 13, seed + 1) - 0.5) * 2, rw: (z.rw ?? 0.23) * (1 + irr * 0.25 * (this.vn1(d / 9, seed + 2) - 0.5)), hump: 0.2, man: !z.azar }; },
  at(d) { const E = S.edits || []; for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (e.kind !== 'ruts' || d < e.d0 || d > e.d1) continue; return this.shape({ a: e.d0, b: e.d1, D: e.D, rw: e.rw, sep: e.sep, irr: e.irr, ramp: e.ramp }, d, 7 + i); }
    const tot = S.lastTotal || (S.result && S.result.res && S.result.res.total) || 0; for (const z of this.zones(tot)) if (d >= z.a && d <= z.b) return this.shape(z, d, 3);
    return typeof PHOTOMAT !== 'undefined' && PHOTOMAT.rutAt ? PHOTOMAT.rutAt(d) : null; },
  // para pintar: 0..1 de "fondo de huella" en (d, s) y 0..1 de lomo/labio (ripio suelto)
  paint(d, s, K) { const r = this.at(d); if (!r || !(r.D > 0.005)) return null; const c = -Math.sign(K || 0) * Math.min(0.3, Math.abs(K || 0) * 15), x = Math.abs(Math.abs(s - c) - r.tw), rw = r.rw || 0.23, k = Math.min(1, r.D / 0.12);
    return { bot: k * Math.max(0, 1 - (x / rw) ** 2), lip: k * (x > rw && x < rw + 0.2 ? Math.sin((x - rw) / 0.2 * Math.PI) : Math.abs(s - c) < r.tw - rw - 0.1 ? 0.5 : 0) }; },
};
function fixIdxR(r, d) { const D = r.dist; let lo = 0, hi = D.length - 1; if (!(hi > 0)) return 0; while (hi - lo > 1) { const mi = (lo + hi) >> 1; if (D[mi] < d) lo = mi; else hi = mi; } return lo; }
// detalle "pasa-altos": le saca a la textura de detalle las manchas grandes (claro/oscuro a escala de la repetición), que son las que
// arman el mosaico visible de lejos; deja el grano fino (hojas, piedritas). Desenfoque de caja separable con borde envolvente (3 pasadas).
function hipassDetail(cv, frac = 0.12, keep = 0.25) {
  if (!cv || cv.__hp) return cv; const W = cv.width, H = cv.height, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.drawImage(cv, 0, 0);
  const im = x.getImageData(0, 0, W, H), d = im.data, r = Math.max(2, Math.round(Math.min(W, H) * frac / 2)), N = W * H, ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N)], mean = [0, 0, 0];
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) { ch[k][i] = d[i * 4 + k]; mean[k] += d[i * 4 + k] / N; }
  const blur = a => { const t = new Float32Array(N); for (let pass = 0; pass < 3; pass++) { for (let y = 0; y < H; y++) { let s = 0; for (let q = -r; q <= r; q++) s += a[y * W + ((q % W) + W) % W]; for (let xx = 0; xx < W; xx++) { t[y * W + xx] = s / (2 * r + 1); s += a[y * W + (xx + r + 1) % W] - a[y * W + ((xx - r) % W + W) % W]; } }
      for (let xx = 0; xx < W; xx++) { let s = 0; for (let q = -r; q <= r; q++) s += t[(((q % H) + H) % H) * W + xx]; for (let y = 0; y < H; y++) { a[y * W + xx] = s / (2 * r + 1); s += t[((y + r + 1) % H) * W + xx] - t[(((y - r) % H + H) % H) * W + xx]; } } } return a; };
  for (let k = 0; k < 3; k++) { const lo = blur(Float32Array.from(ch[k])); for (let i = 0; i < N; i++) d[i * 4 + k] = Math.max(0, Math.min(255, ch[k][i] - lo[i] + mean[k] + (lo[i] - mean[k]) * keep)); }
  x.putImageData(im, 0, 0); c.__hp = true; return c; }

// ---------- Etapa 8 · cámara de las fotos: render desde la posición/rumbo/inclinación EXACTOS de cada foto (GPS + EXIF) ----------
// fov vertical 67,3° = iPhone 13 gran angular (26 mm equiv.) en vertical; inclinación estimada del horizonte de la foto.
// idPass: misma vista con colores planos por zona (cielo, camino, costado, pasto) para medir el color por zona en foto y render.
const FOTOCAM = {
  place(v) { const R = S.result, B = S.base; if (!R || !B) return null; const [x, y] = B.P.fwd(v.lat, v.lon), z = -y; let g = null;
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 2000, z), new THREE.Vector3(0, -1, 0)); for (const h of rc.intersectObjects(PV.group.children, false)) { const s = h.object.userData.src; if (h.object.visible && !(s && /TREES|ROCKS|SIGN|FENCE|OBJECTS|far_obj/.test(s.name))) { g = h.point.y; break; } }
    const b = v.rumbo * Math.PI / 180, p = (v.pitch || 0) * Math.PI / 180, dx = Math.sin(b) * Math.cos(p), dy = Math.cos(b) * Math.cos(p), dz = Math.sin(p);
    PV.drive = null; PV.camera.fov = v.fov || 67.3; PV.camera.near = 0.03; PV.camera.far = 40000; PV.camera.position.set(x, (g ?? 0) + (v.h ?? 1.5), z);
    PV.controls.target.set(x + dx * 10, (g ?? 0) + (v.h ?? 1.5) + dz * 10, z - dy * 10); PV.controls.update(); return g; },
  zone(m) { const s = m.userData.src || {}; const k = s.mat || '', n = s.name || ''; if (/^rs_|^road|asphalt/.test(k) || /^\d+(GRAVEL|STONY|LOOSE|MUD|CLAY|ROAD)/.test(n) && !/^tc_|grass/.test(k)) return 0xff0000;
    if (/^sb_|ditch|bank|verge|loose|BLOOSE|CORDON|DWALL|DBOT/.test(k + n)) return 0x0000ff; if (/^tc_|grass|farland|side_|tuft/.test(k)) return 0x00ff00; return 0xffff00; },
  async render(W, H, id) { const r = PV.renderer, old = r.getSize(new THREE.Vector2()); r.setSize(W, H, false); PV.camera.aspect = W / H; PV.camera.updateProjectionMatrix(); let saved = null;
    if (id) { saved = { bg: PV.scene.background, fog: PV.scene.fog, mats: new Map() }; PV.scene.background = new THREE.Color(0); PV.scene.fog = null; const cache = {};
      PV.scene.traverse(o => { if (o.isMesh || o.isInstancedMesh) { saved.mats.set(o, o.material); const c = o.isInstancedMesh ? 0x00ff00 : this.zone(o); o.material = cache[c] || (cache[c] = new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); } }); }
    else if (typeof PVGRASS !== 'undefined') { PVGRASS.last = null; PVGRASS.update(); }
    PV.render(); const blob = await new Promise(q => r.domElement.toBlob(q, id ? 'image/png' : 'image/jpeg', 0.9));
    if (saved) { PV.scene.background = saved.bg; PV.scene.fog = saved.fog; for (const [o, m] of saved.mats) o.material = m; }
    r.setSize(old.x, old.y, false); PV.camera.aspect = old.x / old.y; PV.camera.updateProjectionMatrix(); return blob; },
  async panel(vistas, name) { const zip = new JSZip(); for (const [k, v] of Object.entries(vistas)) { this.place(v); zip.file(k + '_render.jpg', await this.render(600, 800)); zip.file(k + '_id.png', await this.render(600, 800, true)); }
    const blob = await zip.generateAsync({ type: 'blob' }), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'panel_fotos.zip'; document.body.appendChild(a); a.click(); return blob.size; },
};
