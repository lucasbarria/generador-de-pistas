// ===== Editor directo en 3D =====
// Clic sobre el camino = elegir punto (Shift+clic = tramo). Aparecen manipuladores según la herramienta
// (altura, pendiente, peralte, salto, lomada, bache, guardaganado, ancho, curva, suavizado).
// Mientras se arrastra solo se mueven los vértices del camino que cambian; al soltar se ajusta el terreno
// únicamente alrededor de la zona editada. El perfil del panel y el de la vista 3D muestran lo mismo.

const ED = { tool: 'height', active: null, undo: [], redo: [], drag: null, pending: false, gz: [], hover: null, anchor: null, keys: new Set(), commitT: null };
const ED_KIND = { height: 'raise', bank: 'bank', jump: 'jump', bump: 'bump', pothole: 'pothole', cattle: 'cattle', width: 'width', curve: 'shape', smooth: 'smooth' };
const ED_TOOLS = [
  ['height', '⇕ Altura / pendiente', 'Punto: subir o bajar. Tramo: manijas al inicio y al final para armar la pendiente; las naranjas alargan la transición.'],
  ['bank', '⟋ Peralte', 'Subí o bajá un borde del camino para inclinarlo (también invertido o en rectas).'],
  ['jump', '⤴ Salto', 'Crea o edita un salto: altura, rampa de entrada y recepción.'],
  ['bump', '◠ Lomada', 'Lomada: altura y largo.'],
  ['pothole', '◡ Depresión', 'Bache o depresión: profundidad y largo.'],
  ['cattle', '▥ Guardaganado', 'Guardaganado: foso con barras de hierro a lo ancho del camino.'],
  ['width', '↔ Ancho', 'Arrastrá los bordes verdes para ensanchar o angostar el tramo.'],
  ['curve', '✋ Curva', 'Arrastrá los puntos amarillos para mover el trazado; el alcance define cuánto camino se mueve.'],
  ['smooth', '≈ Suavizar', 'Suaviza las alturas del tramo elegido (quita escalones y saltos falsos).'],
];
// parámetros editables con número (clave, nombre, unidad, paso, mín, máx)
const ED_PARAMS = {
  raise: e => e.d1 - e.d0 < 1 ? [['h', 'Altura', 'm', 0.1, -60, 60], ['r', 'Transición', 'm', 1, 3, 400]]
    : [['h', 'Altura al inicio', 'm', 0.1, -60, 60], ['h1', 'Altura al final', 'm', 0.1, -60, 60], ['f0', 'Transición antes', 'm', 1, 0, 400], ['f1', 'Transición después', 'm', 1, 0, 400], ['d0', 'Desde', 'm', 1], ['d1', 'Hasta', 'm', 1]],
  jump: () => [['h', 'Altura', 'm', 0.1, 0.1, 8], ['len', 'Rampa de entrada', 'm', 1, 3, 200], ['land', 'Recepción', 'm', 0.5, 1, 120], ['d', 'Cresta en', 'm', 1]],
  bump: () => [['h', 'Altura', 'm', 0.05, 0.02, 4], ['len', 'Largo', 'm', 0.5, 2, 120], ['d', 'Centro en', 'm', 1]],
  pothole: () => [['h', 'Profundidad', 'm', 0.05, 0.02, 4], ['len', 'Largo', 'm', 0.5, 1, 120], ['d', 'Centro en', 'm', 1]],
  cattle: () => [['h', 'Desnivel del foso', 'm', 0.01, 0, 0.4], ['len', 'Largo', 'm', 0.1, 1.5, 6], ['d', 'Centro en', 'm', 1]],
  bank: () => [['deg', 'Inclinación (+ = izquierda arriba)', '°', 0.5, -35, 35], ['d0', 'Desde', 'm', 1], ['d1', 'Hasta', 'm', 1]],
  width: () => [['w', 'Ancho', 'm', 0.1, 3, 25], ['d0', 'Desde', 'm', 1], ['d1', 'Hasta', 'm', 1]],
  shape: () => [['dx', 'Mover al este', 'm', 0.5], ['dy', 'Mover al norte', 'm', 0.5], ['r', 'Alcance', 'm', 5, 8, 500]],
  smooth: () => [['d0', 'Desde', 'm', 1], ['d1', 'Hasta', 'm', 1]],
  width_: null,
};

// ---------- utilidades de la ruta ----------
const edR = () => S.result && S.result.mode === 'route' ? S.result.res : null;
function edClampD(d) { const r = edR(); if (!r) return d; return r.closed ? ((d % r.total) + r.total) % r.total : Math.max(0, Math.min(r.total, d)); }
// posición sobre el camino a la distancia d, corrida lat metros a la izquierda (interpolada entre secciones)
function edAt(d, lat = 0) {
  const r = edR(); d = edClampD(d);
  let i = Math.max(0, Math.min(r.n - 1, Math.round(d / 2))); while (i > 0 && r.dist[i] > d) i--; while (i < r.n - 1 && r.dist[i + 1] <= d) i++;
  const j = Math.min(r.n - 1, i + 1), L = r.dist[j] - r.dist[i], t = L > 0 ? Math.max(0, Math.min(1, (d - r.dist[i]) / L)) : 0;
  const lp = (a, b) => a + (b - a) * t;
  const cx = lp(r.C[i][0], r.C[j][0]), cy = lp(r.C[i][1], r.C[j][1]), hs = lp(r.hs[i], r.hs[j]), SL = lp(r.SL[i], r.SL[j]), hw = lp(r.W[i], r.W[j]) / 2;
  const tx = r.T[i][0], ty = r.T[i][1], nx = -ty, ny = tx, lc = Math.max(-hw, Math.min(hw, lat));
  return { x: cx + nx * lat, y: cy + ny * lat, h: hs + SL * lc + 0.02 * (hw - Math.abs(lc)), i, hw, T: [tx, ty], N: [nx, ny], SL, hs };
}
const v3 = (x, y, h) => new THREE.Vector3(x, h, -y);
function edNearestD(x, y) {
  const r = edR(); let bi = 0, bd = Infinity;
  for (let i = 0; i < r.n; i++) { const dx = r.C[i][0] - x, dy = r.C[i][1] - y, q = dx * dx + dy * dy; if (q < bd) { bd = q; bi = i; } }
  const t = r.T[bi], along = (x - r.C[bi][0]) * t[0] + (y - r.C[bi][1]) * t[1];
  return { d: edClampD(r.dist[bi] + along), dist: Math.sqrt(bd), i: bi };
}

// ---------- extensión de cada edición (para encontrarla al hacer clic) ----------
function edExtent(e) {
  if (e.d !== undefined) {
    if (e.kind === 'jump') return [e.d - e.len, e.d + (e.land != null ? e.land : e.len * 0.3)];
    if (e.kind === 'shape') return [e.d - e.r, e.d + e.r];
    const h = (e.len || 2.6) / 2 + 1; return [e.d - h, e.d + h];
  }
  if (e.kind === 'raise' && e.d1 - e.d0 < 1) return [e.d0 - (e.r || 30), e.d0 + (e.r || 30)];
  return [e.d0, e.d1];
}
const edCenter = e => e.d !== undefined ? e.d : (e.d0 + e.d1) / 2;
function edSecSel() { const s = S.sel; return s.d1 - s.d0 < 10 ? { d0: Math.max(0, s.d0 - 25), d1: Math.min(edR().total, s.d0 + 25) } : { d0: s.d0, d1: s.d1 }; }
// la edición que manipulan las manijas de la herramienta actual (puede no existir todavía: se crea al arrastrar)
function edTarget() {
  const kind = ED_KIND[ED.tool]; if (!S.sel) return null;
  if (ED.active && ED.active.kind === kind && S.edits.includes(ED.active)) return ED.active;
  const s = S.sel, pt = s.d1 - s.d0 < 1;
  if (kind === 'raise') return S.edits.find(e => e.kind === 'raise' && (pt ? e.d1 - e.d0 < 1 && Math.abs(e.d0 - s.d0) < 1.5 : Math.abs(e.d0 - s.d0) < 1.5 && Math.abs(e.d1 - s.d1) < 1.5)) || null;
  if (kind === 'bank' || kind === 'width' || kind === 'smooth') { const q = edSecSel(); return S.edits.find(e => e.kind === kind && Math.abs(e.d0 - q.d0) < 1.5 && Math.abs(e.d1 - q.d1) < 1.5) || null; }
  if (kind === 'shape') return null;
  const c = (s.d0 + s.d1) / 2; return S.edits.find(e => e.kind === kind && c >= edExtent(e)[0] && c <= edExtent(e)[1]) || null;
}
function edMake(kind) {
  const s = S.sel, c = (s.d0 + s.d1) / 2, r = edR();
  if (kind === 'raise') return s.d1 - s.d0 < 1 ? { kind, d0: s.d0, d1: s.d0, h: 0, r: 30 } : { kind, d0: s.d0, d1: s.d1, h: 0, h1: 0, f0: 25, f1: 25 };
  if (kind === 'bank') { const q = edSecSel(), p = edAt((q.d0 + q.d1) / 2); return { kind, ...q, abs: true, deg: +(Math.atan(p.SL) / D2R).toFixed(2) }; }
  if (kind === 'width') { const q = edSecSel(); return { kind, ...q, w: +(edAt((q.d0 + q.d1) / 2).hw * 2).toFixed(2) }; }
  if (kind === 'smooth') return { kind, ...edSecSel() };
  if (kind === 'jump') return { kind, d: c, h: 1.2, len: 24, land: 8 };
  if (kind === 'bump') return { kind, d: c, h: 0.5, len: 10 };
  if (kind === 'pothole') return { kind, d: c, h: 0.3, len: 6 };
  if (kind === 'cattle') return { kind, d: c, h: 0.08, len: 2.6 };
  return null;
}
function edEnsure() { let e = edTarget(); if (!e) { e = edMake(ED_KIND[ED.tool]); if (e) S.edits.push(e); } if (e) ED.active = e; return e; }

// ---------- deshacer ----------
function edPushUndo() { ED.undo.push(JSON.stringify(S.edits)); if (ED.undo.length > 100) ED.undo.shift(); ED.redo = []; }
function edUndo(redo) {
  const from = redo ? ED.redo : ED.undo, to = redo ? ED.undo : ED.redo; if (!from.length) return;
  to.push(JSON.stringify(S.edits)); S.edits = JSON.parse(from.pop()); ED.active = null; editsChanged();
}

// ---------- actualización en vivo ----------
// recalcula el camino con las ediciones actuales. Si solo cambiaron alturas o peralte, mueve los vértices
// existentes (rápido); si cambió el trazado, el ancho o la superficie, rearma solo las mallas del camino.
function liveRoute() {
  const R = S.result, L = S.live, B = S.base; if (!R || !L || R.mode !== 'route') return false;
  const old = R.res, o = R.o;
  const args = { ...L.routeArgs, ...editFns(o, S.lastTotal, B.closed), cache: L.cache };
  const prof = Core.buildRoute({ ...args, profileOnly: true });
  const same = (a, b, eps) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false; return true; };
  const fast = prof.C === old.C && same(prof.W, old.W, 1e-6) && prof.SURF.every((k, i) => k === old.SURF[i]);
  let i0 = Infinity, i1 = -1;
  if (fast) {
    const n = old.n, dh = new Float64Array(n), ds = new Float64Array(n);
    for (let i = 0; i < n; i++) { dh[i] = prof.hs[i] - old.hs[i]; ds[i] = prof.SL[i] - old.SL[i]; if (Math.abs(dh[i]) > 1e-6 || Math.abs(ds[i]) > 1e-7) { if (i < i0) i0 = i; i1 = i; } }
    if (i1 >= 0) for (const m of R.meshes) {
      if (!m.route || !m.ri) continue;
      if (m.riMin == null) { m.riMin = Infinity; m.riMax = -1; for (const i of m.ri) { if (i < m.riMin) m.riMin = i; if (i > m.riMax) m.riMax = i; } }
      if (m.riMax < i0 || m.riMin > i1) continue;
      const mesh = PV.byMesh && PV.byMesh.get(m), a = mesh && mesh.geometry.attributes.position.array; let t = false;
      for (let v = 0; v < m.v.length; v++) {
        const i = m.ri[v], dz = dh[i] + ds[i] * m.rs[v]; if (dz === 0) continue;
        m.v[v][2] += dz; if (a) a[v * 3 + 1] += dz; t = true;
      }
      if (t && mesh) { mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere(); }
    }
    for (const k of ['hs', 'SL', 'W', 'SURF', 'DL', 'DR']) old[k] = prof[k];
    old.segs = prof.segs.concat(L.sideSegs);
  } else {
    const nr = Core.buildRoute(args);
    // rango que cambió (por el principio y por el final) para saber qué terreno recalcular después
    let a = 0; const m0 = Math.min(nr.n, old.n);
    while (a < m0 && Math.abs(nr.C[a][0] - old.C[a][0]) < 1e-6 && Math.abs(nr.C[a][1] - old.C[a][1]) < 1e-6 && Math.abs(nr.hs[a] - old.hs[a]) < 1e-6 && Math.abs(nr.W[a] - old.W[a]) < 1e-6 && Math.abs(nr.SL[a] - old.SL[a]) < 1e-7) a++;
    let b = 0;
    while (b < m0 - a && (() => { const p = nr.n - 1 - b, q = old.n - 1 - b; return Math.abs(nr.C[p][0] - old.C[q][0]) < 1e-6 && Math.abs(nr.C[p][1] - old.C[q][1]) < 1e-6 && Math.abs(nr.hs[p] - old.hs[q]) < 1e-6 && Math.abs(nr.W[p] - old.W[q]) < 1e-6 && Math.abs(nr.SL[p] - old.SL[q]) < 1e-7; })()) b++;
    edDirty(old, a, old.n - 1 - b); i0 = a; i1 = nr.n - 1 - b;
    if (prof.C !== old.C) L.dirtyXY = true;
    if (!same(prof.W, old.W, 1e-6)) L.dirtyXY = true;
    const keep = R.meshes.filter(m => !m.route), oldRoute = R.meshes.filter(m => m.route);
    oldRoute.forEach(pvRemove);
    for (const k of ['zone', 'sideJ', 'bridges']) nr[k] = old[k];
    nr.segs = nr.segs.concat(L.sideSegs);
    R.res = nr; R.meshes = [...keep, ...nr.meshes];
    nr.meshes.forEach(pvAdd);
    if (prof.C !== old.C) { R.info.ll = nr.C.map(p => B.P.inv(p[0], p[1])); R.outline = [nr.C]; }
  }
  const r = R.res; S.lastTotal = r.total; R.length = r.total;
  if (i1 >= 0) edDirty(r, i0, i1);
  // barras de los guardaganados
  const cm = R.meshes.filter(m => m.cattle); cm.forEach(pvRemove);
  R.meshes = R.meshes.filter(m => !m.cattle); const nc = cattleMeshes(r); R.meshes.push(...nc); nc.forEach(pvAdd);
  return i1 >= 0;
}
// zona a recalcular al soltar (en metros del modelo)
function edDirty(r, i0, i1) {
  const L = S.live; i0 = Math.max(0, i0 - 2); i1 = Math.min(r.n - 1, i1 + 2); if (i1 < i0) return;
  const q = L.dirty || (L.dirty = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity });
  for (let i = i0; i <= i1; i++) { const [x, y] = r.C[i]; if (x < q.minx) q.minx = x; if (x > q.maxx) q.maxx = x; if (y < q.miny) q.miny = y; if (y > q.maxy) q.maxy = y; }
}
function edMeshBB(m) {
  if (m._bb) return m._bb;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const v of m.v) { if (v[0] < a) a = v[0]; if (v[0] > c) c = v[0]; if (v[1] < b) b = v[1]; if (v[1] > d) d = v[1]; }
  return (m._bb = { minx: a, miny: b, maxx: c, maxy: d });
}
const edHit = (bb, q) => bb.maxx >= q.minx && bb.minx <= q.maxx && bb.maxy >= q.miny && bb.miny <= q.maxy;
// al soltar: laterales, terreno de la zona editada, objetos apoyados encima, agarre y notas
function liveCommit() {
  const R = S.result, L = S.live; if (!R || !L) return;
  if (ED.pending) { ED.pending = false; liveRoute(); }
  const r = R.res, B = S.base, routeSegs = r.segs.slice(0, r.segs.length - L.sideSegs.length);
  const q0 = L.dirty; L.dirty = null; const xy = L.dirtyXY; L.dirtyXY = false;
  if (q0) {
    const touched = new Set();
    // caminos laterales: se vuelven a pegar al camino
    if (L.sideArgs) {
      R.meshes.filter(m => m.side).forEach(pvRemove); R.meshes = R.meshes.filter(m => !m.side);
      const sd = Core.buildSideRoads({ ...L.sideArgs, routeSegs }); sd.meshes.forEach(m => { m.side = true; R.meshes.push(m); pvAdd(m); });
      L.sideSegs = sd.segs;
      r.sideJ = sd.junctions.map(p => edNearestD(p[0], p[1]).d);
    }
    r.segs = routeSegs.concat(L.sideSegs);
    // terreno: solo el rectángulo afectado
    const ter = R.ter, o = L.terOpts, pad = Math.max(o.flat, r.EX || 0) + o.blend + (o.edgeFix ? 55 : 0) + 12;
    const q = { minx: q0.minx - pad, miny: q0.miny - pad, maxx: q0.maxx + pad, maxy: q0.maxy + pad };
    o.segs = r.segs;
    const pt = Core.patchTerrain(ter, o, q), old = new Map();
    for (let k = 0; k < pt.changed.length; k += 2) old.set(pt.changed[k], pt.changed[k + 1]);
    if (old.size) {
      for (const m of R.meshes) if (m.terrain && m.gk && edHit(edMeshBB(m), q)) {
        let t = false; for (let v = 0; v < m.v.length; v++) { const k = m.gk[v]; if (old.has(k)) { m.v[v][2] = ter.H[k]; t = true; } }
        if (t) touched.add(m);
      }
      // árboles, piedras, alambrados, carteles…: suben o bajan lo mismo que el terreno debajo
      const { nx, ny } = ter, bb = R.bbox, res = o.res;
      const dAt = (x, y) => {
        const fi = (x - bb.minx) / res, fj = (y - bb.miny) / res, i = Math.floor(fi), j = Math.floor(fj);
        if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return 0;
        const a = fi - i, b = fj - j, dk = k => old.has(k) ? ter.H[k] - old.get(k) : 0, k = j * nx + i;
        return dk(k) * (1 - a) * (1 - b) + dk(k + 1) * a * (1 - b) + dk(k + nx) * (1 - a) * b + dk(k + nx + 1) * a * b;
      };
      for (const m of R.meshes) {
        if (m.terrain || m.route || m.side || m.cattle || !edHit(edMeshBB(m), q)) continue;
        let t = false;
        for (const v of m.v) { if (v[0] < q.minx || v[0] > q.maxx || v[1] < q.miny || v[1] > q.maxy) continue; const dz = dAt(v[0], v[1]); if (dz) { v[2] += dz; t = true; } }
        if (t) touched.add(m);
      }
    }
    // si el camino se movió o se ensanchó: sacar los árboles y piedras que quedaron encima
    if (xy) {
      const rd = Core.roadDistFn(r.segs, true);
      for (const m of R.meshes) {
        if (!m.block || !edHit(edMeshBB(m), q)) continue;
        const lim = m.mat === 'tree' ? 1.0 : 0.4; let t = false;
        for (let b = 0; b + m.block <= m.v.length; b += m.block) {
          let cx = 0, cy = 0; for (let k = 0; k < m.block; k++) { cx += m.v[b + k][0]; cy += m.v[b + k][1]; } cx /= m.block; cy /= m.block;
          if (cx < q.minx || cx > q.maxx || cy < q.miny || cy > q.maxy) continue;
          if (m.v[b][0] === m.v[b + 1][0] && m.v[b][1] === m.v[b + 1][1] && m.v[b][2] === m.v[b + 1][2]) continue; // ya quitado
          if (rd(cx, cy, 12) < lim) { const p0 = m.v[b].slice(); for (let k = 0; k < m.block; k++) m.v[b + k] = p0.slice(); t = true; }
        }
        if (t) touched.add(m);
      }
    }
    touched.forEach(pvSync);
  }
  // análisis y paneles
  R.info.grip = gripAnalysis(r); r.bridges = r.bridges || []; R.info.notes = paceNotes(r, R.info.grip);
  R.spawnList = routeEmpties(r, R.o, r.closed);
  drawProfile(); drawHeat(); renderCrit(); renderEdits(); drawSel(); renderNotes(); edRefresh();
}
function edSchedule() {
  if (ED.pending) return; ED.pending = true;
  requestAnimationFrame(() => { if (!ED.pending) return; ED.pending = false; liveRoute(); edRefresh(true); drawProfile(); });
}
// cambió la lista de ediciones (botones, lista, deshacer): en vivo si se puede, si no, regenerar
function editsChanged() {
  if (!S.live || !S.result || S.result.mode !== 'route' || !PV.byMesh) { applyEdits(); return; }
  try { liveRoute(); liveCommit(); }
  catch (e) { console.error(e); log('La edición en vivo falló (' + e.message + '); regenero todo.', 'err'); applyEdits(); }
}

// ---------- guardaganado: barras de hierro a lo ancho y postes en los costados ----------
function cattleMeshes(r) {
  const list = S.edits.filter(e => e.kind === 'cattle'); if (!list.length) return [];
  const bars = { name: 'OBJECTS_CATTLE', mat: 'brail', v: [], uv: [], f: [], cattle: true }, posts = { name: 'OBJECTS_CATTLE_POSTS', mat: 'bconc', v: [], uv: [], f: [], cattle: true };
  const idx = d => { d = r.closed ? ((d % r.total) + r.total) % r.total : Math.max(0, Math.min(r.total, d)); let i = Math.max(0, Math.min(r.n - 1, Math.round(d / 2))); while (i > 0 && r.dist[i] > d) i--; while (i < r.n - 1 && r.dist[i + 1] <= d) i++; return i; };
  const box = (m, c, ax, ay, lx, ly, z0, z1) => { // caja orientada: centro c, ejes (ax,ay) y normal, medias longitudes
    const bx = -ay, by = ax, P = (sx, sy, z) => [c[0] + ax * lx * sx + bx * ly * sy, c[1] + ay * lx * sx + by * ly * sy, z], b = m.v.length;
    for (const z of [z0, z1]) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { m.v.push(P(sx, sy, z)); m.uv.push([(sx + 1) / 2, z === z0 ? 0 : 1]); }
    for (let k = 0; k < 4; k++) { const a = b + k, n = b + (k + 1) % 4; m.f.push([a, n, n + 4], [a, n + 4, a + 4]); }
    m.f.push([b + 4, b + 5, b + 6], [b + 4, b + 6, b + 7]);
  };
  for (const e of list) {
    const len = e.len || 2.6, depth = e.h != null ? e.h : 0.08, nb = Math.max(4, Math.round(len / 0.14));
    for (let k = 0; k < nb; k++) {
      const d = e.d - len / 2 + (k + 0.5) * len / nb, i = idx(d), j = Math.min(r.n - 1, i + 1), t = r.dist[j] > r.dist[i] ? Math.max(0, Math.min(1, (d - r.dist[i]) / (r.dist[j] - r.dist[i]))) : 0;
      const cx = r.C[i][0] + (r.C[j][0] - r.C[i][0]) * t, cy = r.C[i][1] + (r.C[j][1] - r.C[i][1]) * t, h = r.hs[i] + (r.hs[j] - r.hs[i]) * t + depth;
      const [tx, ty] = r.T[i], hw = r.W[i] / 2 + 0.25;
      box(bars, [cx, cy], -ty, tx, hw, 0.025, h - 0.06, h + 0.01);
    }
    const i = idx(e.d), [tx, ty] = r.T[i], hw = r.W[i] / 2 + 0.45;
    for (const sd of [1, -1]) for (const off of [-len / 2, len / 2]) {
      const p = [r.C[i][0] + tx * off - ty * hw * sd, r.C[i][1] + ty * off + tx * hw * sd];
      box(posts, p, tx, ty, 0.12, 0.12, r.hs[i] - 0.4, r.hs[i] + 0.9);
    }
  }
  return [bars, posts];
}

// ---------- manipuladores (gizmos) ----------
// tipo: 'up' = arrastre vertical, 'along' = a lo largo del camino, 'side' = hacia los costados, 'plane' = libre en planta
const GZ_COL = { up: 0xff5c8a, both: 0xc77dff, along: 0xffb020, side: 0x2ecc71, plane: 0xffd200, move: 0xffffff };
function edGizmoDefs() {
  const r = edR(); if (!r || !S.sel) return [];
  const e = edTarget(), kind = ED_KIND[ED.tool], s = S.sel, out = [];
  const G = (type, d, lat, yOff, drag, tip, col) => out.push({ type, d: edClampD(d), lat, yOff, drag, tip, col: col || type });
  const clampMin = (v, m) => Math.max(m, v);
  if (kind === 'raise') {
    if (s.d1 - s.d0 < 1) {
      const rr = e ? e.r || 30 : 30;
      G('up', s.d0, 0, 1.6, (e0, x, e) => { e.h = e0.h + x; }, 'Arrastrá arriba/abajo: subir o bajar este punto');
      G('along', s.d0 - rr, 0, 0.4, (e0, x, e) => { e.r = clampMin((e0.r || 30) - x, 3); }, 'Largo de la transición');
      G('along', s.d0 + rr, 0, 0.4, (e0, x, e) => { e.r = clampMin((e0.r || 30) + x, 3); }, 'Largo de la transición');
    } else {
      const f0 = e && e.f0 != null ? e.f0 : 25, f1 = e && e.f1 != null ? e.f1 : 25;
      G('up', s.d0, 0, 1.6, (e0, x, e) => { e.h = e0.h + x; }, 'Altura al inicio del tramo (pendiente)');
      G('up', s.d1, 0, 1.6, (e0, x, e) => { e.h1 = (e0.h1 != null ? e0.h1 : e0.h) + x; }, 'Altura al final del tramo (pendiente)');
      G('up', (s.d0 + s.d1) / 2, 0, 2.2, (e0, x, e) => { e.h = e0.h + x; e.h1 = (e0.h1 != null ? e0.h1 : e0.h) + x; }, 'Subir o bajar todo el tramo', 'both');
      G('along', s.d0 - f0, 0, 0.4, (e0, x, e) => { e.f0 = clampMin((e0.f0 != null ? e0.f0 : 25) - x, 0); }, 'Transición de entrada: más larga = más suave');
      G('along', s.d1 + f1, 0, 0.4, (e0, x, e) => { e.f1 = clampMin((e0.f1 != null ? e0.f1 : 25) + x, 0); }, 'Transición de salida: más larga = más suave');
    }
  } else if (kind === 'bank' || kind === 'width' || kind === 'smooth') {
    const q = e || edSecSel(), mid = (q.d0 + q.d1) / 2, hw = edAt(mid).hw;
    if (kind === 'bank') {
      const tilt = (e0, x, e, sg) => { if (!e0.abs) { e0.abs = true; e0.deg = Math.atan(edAt(mid).SL) / D2R; } e.abs = true; e.deg = Math.max(-35, Math.min(35, Math.atan(Math.tan(e0.deg * D2R) + sg * x / hw) / D2R)); };
      G('up', mid, hw, 0.8, (e0, x, e) => tilt(e0, x, e, 1), 'Borde izquierdo: subilo o bajalo para peraltar');
      G('up', mid, -hw, 0.8, (e0, x, e) => tilt(e0, x, e, -1), 'Borde derecho: subilo o bajalo para peraltar');
    }
    if (kind === 'width') {
      G('side', mid, hw, 0.5, (e0, x, e) => { e.w = Math.max(3, Math.min(25, e0.w + 2 * x)); }, 'Borde izquierdo: arrastrá hacia afuera para ensanchar');
      G('side', mid, -hw, 0.5, (e0, x, e) => { e.w = Math.max(3, Math.min(25, e0.w - 2 * x)); }, 'Borde derecho: arrastrá hacia afuera para ensanchar');
    }
    G('along', q.d0, 0, 0.4, (e0, x, e) => { e.d0 = Math.max(0, Math.min(e0.d1 - 2, e0.d0 + x)); }, 'Comienzo del tramo');
    G('along', q.d1, 0, 0.4, (e0, x, e) => { e.d1 = Math.min(r.total, Math.max(e0.d0 + 2, e0.d1 + x)); }, 'Final del tramo');
  } else if (kind === 'jump' && e) {
    const land = e.land != null ? e.land : e.len * 0.3;
    G('up', e.d, 0, 1.6, (e0, x, e) => { e.h = Math.max(0.1, e0.h + x); }, 'Altura del salto');
    G('along', e.d - e.len, 0, 0.4, (e0, x, e) => { e.len = Math.max(3, e0.len - x); }, 'Comienzo de la rampa: más largo = entrada más suave');
    G('along', e.d + land, 0, 0.4, (e0, x, e) => { e.land = Math.max(1, (e0.land != null ? e0.land : e0.len * 0.3) + x); }, 'Recepción: más largo = aterrizaje más suave');
    G('move', e.d, edAt(e.d).hw + 1.2, 0.3, (e0, x, e) => { e.d = edClampD(e0.d + x); }, 'Mover el salto por el camino');
  } else if ((kind === 'bump' || kind === 'pothole' || kind === 'cattle') && e) {
    const sg = kind === 'bump' ? 1 : -1, half = (e.len || 2.6) / 2, mn = kind === 'cattle' ? 1.5 : 1;
    G('up', e.d, 0, 1.2, (e0, x, e) => { e.h = Math.max(kind === 'cattle' ? 0 : 0.02, e0.h + sg * x); if (kind === 'cattle') e.h = Math.min(0.4, e.h); }, kind === 'bump' ? 'Altura de la lomada' : 'Profundidad');
    G('along', e.d - half, 0, 0.4, (e0, x, e) => { e.len = Math.max(mn, (e0.len || 2.6) - 2 * x); }, 'Largo');
    G('along', e.d + half, 0, 0.4, (e0, x, e) => { e.len = Math.max(mn, (e0.len || 2.6) + 2 * x); }, 'Largo');
    G('move', e.d, edAt(e.d).hw + 1.2, 0.3, (e0, x, e) => { e.d = edClampD(e0.d + x); }, 'Mover por el camino');
  } else if (kind === 'shape') {
    // puntos de control del trazado alrededor de la selección
    const c = (s.d0 + s.d1) / 2, span = Math.max(150, (s.d1 - s.d0) / 2 + 80), every = Math.max(8, Math.round(span / 12));
    for (let d = Math.max(0, c - span); d <= Math.min(r.total, c + span); d += every) G('plane', d, 0, 0.8, null, 'Arrastrá para mover el trazado (alcance: ' + $('#dragR').value + ' m)');
    if (e) {
      G('along', e.d - e.r, 0, 0.4, (e0, x, e) => { e.r = Math.max(8, e0.r - x); }, 'Alcance de la curva');
      G('along', e.d + e.r, 0, 0.4, (e0, x, e) => { e.r = Math.max(8, e0.r + x); }, 'Alcance de la curva');
    }
  }
  return out;
}
function edGizmoPos(g) { const p = edAt(g.d, g.lat); return v3(p.x, p.y, p.h + g.yOff); }
const GZ_GEO = {};
function edGizmoMesh(g) {
  const geo = GZ_GEO[g.type] || (GZ_GEO[g.type] = g.type === 'up' ? new THREE.SphereGeometry(1, 16, 12) : g.type === 'along' ? new THREE.BoxGeometry(1.5, 1.5, 1.5) : g.type === 'side' ? new THREE.BoxGeometry(1.4, 1.4, 1.4) : g.type === 'move' ? new THREE.OctahedronGeometry(1.2) : new THREE.SphereGeometry(0.9, 12, 8));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: GZ_COL[g.col], depthTest: false, transparent: true, opacity: 0.95 }));
  m.renderOrder = 20; return m;
}
function edBuildGizmos() {
  if (!PV.scene) return;
  if (ED.gzGroup) { PV.scene.remove(ED.gzGroup); ED.gzGroup.traverse(o => { if (o.material) o.material.dispose(); if (o.geometry && !Object.values(GZ_GEO).includes(o.geometry)) o.geometry.dispose(); }); }
  ED.gzGroup = new THREE.Group(); PV.scene.add(ED.gzGroup);
  if (!edOn()) { ED.gz = []; return; }
  ED.gz = edGizmoDefs();
  for (const g of ED.gz) {
    g.mesh = edGizmoMesh(g); ED.gzGroup.add(g.mesh);
    if (g.type === 'up' || g.type === 'side') { // tallo hasta el camino
      g.stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: GZ_COL[g.col], depthTest: false }));
      g.stem.renderOrder = 19; ED.gzGroup.add(g.stem);
    }
  }
  edPlaceGizmos();
}
function edPlaceGizmos() {
  if (!edR()) return;
  for (const g of ED.gz) {
    const p = edGizmoPos(g); g.pos = p; g.mesh.position.copy(p);
    if (g.stem) { const a = g.stem.geometry.attributes.position; const q = edAt(g.d, g.lat); a.setXYZ(0, p.x, p.y, p.z); a.setXYZ(1, p.x, q.h, p.z); a.needsUpdate = true; g.stem.geometry.computeBoundingSphere(); }
  }
  edBuildSelMesh();
}
// el tamaño en pantalla de las manijas no depende de la distancia
function edFrame() {
  if (ED.gz.length && PV.camera) for (const g of ED.gz) { const k = PV.camera.position.distanceTo(g.mesh.position) * 0.011 * (ED.hover === g || (ED.drag && ED.drag.g === g) ? 1.45 : 1); g.mesh.scale.setScalar(Math.max(0.05, k)); }
  // teclado: WASD / flechas = desplazarse, Q/E = girar, R/F = acercar/alejar
  if (ED.keys.size && PV.camera && $('#viewer').style.display !== 'none') {
    const c = PV.controls, cam = PV.camera, off = cam.position.clone().sub(c.target), dist = off.length(), sp = Math.max(0.6, dist * 0.02);
    const fw = new THREE.Vector3(-off.x, 0, -off.z).normalize(), rt = new THREE.Vector3(-fw.z, 0, fw.x), mv = new THREE.Vector3();
    if (ED.keys.has('w') || ED.keys.has('arrowup')) mv.add(fw); if (ED.keys.has('s') || ED.keys.has('arrowdown')) mv.sub(fw);
    if (ED.keys.has('d') || ED.keys.has('arrowright')) mv.add(rt); if (ED.keys.has('a') || ED.keys.has('arrowleft')) mv.sub(rt);
    if (mv.lengthSq()) { mv.normalize().multiplyScalar(sp); cam.position.add(mv); c.target.add(mv); }
    if (ED.keys.has('q') || ED.keys.has('e')) { const a = (ED.keys.has('q') ? 1 : -1) * 0.025; off.applyAxisAngle(new THREE.Vector3(0, 1, 0), a); cam.position.copy(c.target).add(off); }
    if (ED.keys.has('r') || ED.keys.has('f')) { const k = ED.keys.has('r') ? 0.97 : 1.03; if (dist * k > 1.5) cam.position.copy(c.target).add(off.multiplyScalar(k)); }
  }
}
// franja celeste sobre la selección
function edBuildSelMesh() {
  if (ED.selMesh) { PV.scene.remove(ED.selMesh); ED.selMesh.geometry.dispose(); ED.selMesh = null; }
  const r = edR(); if (!r || !S.sel || !PV.scene || $('#viewer').style.display === 'none') return;
  let d0 = S.sel.d0, d1 = S.sel.d1; if (d1 - d0 < 1) { d0 -= 1.5; d1 += 1.5; }
  const pos = [], idx = [], N = Math.max(2, Math.min(4000, Math.ceil((d1 - d0) / 2)));
  for (let k = 0; k <= N; k++) {
    const d = d0 + (d1 - d0) * k / N, a = edAt(d), hw = a.hw + 0.25;
    for (const lat of [hw, -hw]) { const p = edAt(d, lat); pos.push(p.x, p.h + 0.06, -p.y); }
    if (k) { const b = (k - 1) * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  ED.selMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }));
  ED.selMesh.renderOrder = 5; PV.scene.add(ED.selMesh);
}
function edScreen(p) {
  const rect = PV.renderer.domElement.getBoundingClientRect(), v = p.clone().project(PV.camera);
  return v.z > 1 ? null : { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
}
function edPickGizmo(ev) {
  const rect = PV.renderer.domElement.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top; let best = null;
  for (const g of ED.gz) { const s = edScreen(g.pos); if (!s) continue; const d = Math.hypot(s.x - mx, s.y - my); if (d < 16 && (!best || d < best.d)) best = { d, g }; }
  return best && best.g;
}
function edRay(ev) {
  const rect = PV.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2((ev.clientX - rect.left) / rect.width * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), PV.camera);
  return rc;
}
function edPlaneHit(rc, plane) { const h = new THREE.Vector3(); return rc.ray.intersectPlane(plane, h) ? h : null; }
// cuánto se arrastró, en metros, según el tipo de manija
function edDragDelta(ev) {
  const D = ED.drag, rc = edRay(ev), g = D.g;
  if (g.type === 'up') {
    const cd = new THREE.Vector3(); PV.camera.getWorldDirection(cd); cd.y = 0; if (cd.lengthSq() < 1e-6) cd.set(0, 0, 1); cd.normalize();
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(cd, D.p0), h = edPlaneHit(rc, pl); return h ? h.y - D.p0.y : null;
  }
  const h = edPlaneHit(rc, new THREE.Plane(new THREE.Vector3(0, 1, 0), -D.p0.y)); if (!h) return null;
  const dx = h.x - D.p0.x, dy = -(h.z - D.p0.z);
  if (g.type === 'along' || g.type === 'move') return dx * D.T[0] + dy * D.T[1];
  if (g.type === 'side') return dx * D.N[0] + dy * D.N[1];
  return [dx, dy];
}
function edStartDrag(g, src) {
  edPushUndo();
  let e;
  if (g.type === 'plane') { e = { kind: 'shape', d: g.d, dx: 0, dy: 0, r: +$('#dragR').value }; S.edits.push(e); ED.active = e; }
  else { e = edEnsure(); if (!e) { ED.undo.pop(); return false; } }
  const a = edAt(g.d);
  ED.drag = { g, e, e0: JSON.parse(JSON.stringify(e)), p0: g.pos.clone(), T: a.T, N: a.N, src, moved: false };
  return true;
}
function edApplyDrag(x, fine) {
  const D = ED.drag; if (x == null) return;
  if (fine) x = Array.isArray(x) ? x.map(v => v * 0.25) : x * 0.25;
  if (D.g.type === 'plane') { D.e.dx = +(D.e0.dx + x[0]).toFixed(3); D.e.dy = +(D.e0.dy + x[1]).toFixed(3); }
  else D.g.drag(JSON.parse(JSON.stringify(D.e0)), x, D.e);
  D.moved = true; edSchedule(); edLiveReadout();
}
function edEndDrag() {
  const D = ED.drag; ED.drag = null; if (PV.controls) PV.controls.enabled = true;
  if (!D) return;
  if (!D.moved) { ED.undo.pop(); if (D.g.type === 'plane') { S.edits.splice(S.edits.indexOf(D.e), 1); ED.active = null; } edRefresh(); return; }
  if (D.e.kind === 'shape' && Math.hypot(D.e.dx, D.e.dy) < 0.2) { S.edits.splice(S.edits.indexOf(D.e), 1); ED.active = null; }
  // si la selección era la de la edición, que la siga
  if (D.e.d0 !== undefined && D.e.kind !== 'raise') S.sel = { d0: D.e.d0, d1: D.e.d1 };
  liveCommit(); selInfo();
}
function edLiveReadout() {
  const D = ED.drag; if (!D) return;
  const txt = EDIT_TXT[D.e.kind] ? EDIT_TXT[D.e.kind](D.e) : '';
  const p = edAt(D.g.d); edHint(`${txt} · ${(D.g.d / 1000).toFixed(3)} km · camino a ${(p.hs + S.result.h0).toFixed(2)} m · ${D.g.tip}  (Shift = fino)`);
  edPanel(true);
}
const edHint = t => { const h = $('#vhint'); h.style.display = t ? '' : 'none'; h.textContent = t || ''; };
const edOn = () => !!(S.result && S.result.mode === 'route' && ED.panelOn);

// ---------- selección ----------
function edSelect(d, extend) {
  const r = edR(); if (!r) return;
  d = edClampD(d);
  if (extend && ED.anchor != null) S.sel = { d0: Math.min(ED.anchor, d), d1: Math.max(ED.anchor, d) };
  else { S.sel = { d0: d, d1: d }; ED.anchor = d; }
  // si hay un salto, lomada, bache o guardaganado ahí, queda elegido para editarlo
  if (!extend) {
    const hit = S.edits.filter(e => ['jump', 'bump', 'pothole', 'cattle'].includes(e.kind)).find(e => { const [a, b] = edExtent(e); return d >= a && d <= b; });
    if (hit) { ED.active = hit; ED.tool = Object.keys(ED_KIND).find(k => ED_KIND[k] === hit.kind); }
    else if (ED.active && !(ED.active.d0 !== undefined && d >= ED.active.d0 && d <= ED.active.d1)) ED.active = null;
  }
  selInfo(); drawSel(); drawProfile(); edRefresh(); renderEdits();
}
function edFocusEdit(e, fly) {
  if (!e || !edR()) return;
  ED.active = e; ED.tool = Object.keys(ED_KIND).find(k => ED_KIND[k] === e.kind) || ED.tool;
  const [a, b] = e.d !== undefined ? [e.d, e.d] : [e.d0, e.d1]; S.sel = { d0: a, d1: b }; ED.anchor = a;
  selInfo(); drawSel(); drawProfile(); edRefresh(); renderEdits();
  if (fly && $('#viewer').style.display !== 'none') edFly(edCenter(e));
}
function edFly(d) {
  const p = edAt(d), c = PV.controls, cam = PV.camera, to = v3(p.x, p.y, p.h), off = cam.position.clone().sub(c.target);
  const L = off.length(); if (L > 120) off.multiplyScalar(120 / L); if (L < 15) off.multiplyScalar(15 / Math.max(1, L));
  const t0 = c.target.clone(), c0 = cam.position.clone(), c1 = to.clone().add(off), T0 = performance.now();
  const step = () => { const k = Math.min(1, (performance.now() - T0) / 350), s = k * k * (3 - 2 * k); c.target.lerpVectors(t0, to, s); cam.position.lerpVectors(c0, c1, s); if (k < 1) requestAnimationFrame(step); };
  step();
}
function edPickRoad(ev) {
  const rc = edRay(ev), list = [];
  for (const [m, mesh] of PV.byMesh) if (m.route && !/^LINES_/.test(m.name)) list.push(mesh);
  let h = rc.intersectObjects(list, false)[0];
  if (!h) { const ter = PV.terrain.map(t => t.mesh); h = rc.intersectObjects(ter, false)[0]; if (!h) return null; }
  const q = edNearestD(h.point.x, -h.point.z); return q.dist < edAt(q.d).hw + 12 ? q : null;
}

// ---------- panel de la vista 3D ----------
function edRefresh(light) {
  if (!PV.scene) return;
  const route = !!edR();
  $('#vpanel').style.display = route && ED.panelOn ? '' : 'none'; $('#vprof').style.display = route && ED.panelOn ? '' : 'none';
  $('#editCurves').classList.toggle('on', !!ED.panelOn);
  $('#dragRw').style.display = route && ED.panelOn && ED.tool === 'curve' ? '' : 'none';
  if (!route) { ED.gz = []; if (ED.gzGroup) PV.scene.remove(ED.gzGroup); return; }
  if (light && ED.gz.length) { edPlaceGizmos(); edPanel(true); return; }
  edBuildGizmos(); edPanel(); if (ED.panelOn && $('#viewer').style.display !== 'none') PROF3.draw();
}
function edPanel(light) {
  const R = S.result, r = edR(); if (!r || !ED.panelOn) return;
  document.querySelectorAll('#vpTools button').forEach(b => b.classList.toggle('on', b.dataset.tool === ED.tool));
  const s = S.sel, h0 = R.h0;
  if (!s) { $('#vpSel').textContent = 'Hacé clic sobre el camino'; $('#vpData').innerHTML = '<div class="mut">Clic = elegir un punto · Shift+clic = elegir hasta ahí (tramo).</div>'; $('#vpParams').innerHTML = ''; $('#vpNear').innerHTML = ''; return; }
  const d = (s.d0 + s.d1) / 2, p = edAt(d), i = p.i, g = R.info.grip;
  const hAt = x => edAt(x).hs, grade = (hAt(d + 4) - hAt(d - 4)) / 8 * 100;
  const k = r.K[i], tilt = Math.atan(p.SL) / D2R, rad = Math.abs(k) > 1 / 2000 ? 1 / Math.abs(k) : 0;
  const bankTxt = Math.abs(tilt) < 0.05 ? 'plano' : rad ? `${Math.abs(tilt).toFixed(1)}° ${p.SL * k < 0 ? 'hacia adentro' : 'hacia afuera (invertido)'}` : `${Math.abs(tilt).toFixed(1)}° (${tilt > 0 ? 'izquierda' : 'derecha'} más alta)`;
  const rows = [];
  if (s.d1 - s.d0 < 1) {
    $('#vpSel').textContent = `Punto en ${(d / 1000).toFixed(3)} km`;
    rows.push(['Altura', `${(p.hs + h0).toFixed(2)} m`], ['Pendiente', `${grade >= 0 ? '+' : ''}${grade.toFixed(1)} %`], ['Peralte', bankTxt], ['Curva', rad ? `radio ${rad.toFixed(0)} m, ${k > 0 ? 'izquierda' : 'derecha'}` : 'recta'], ['Ancho', `${(p.hw * 2).toFixed(1)} m`], ['Superficie', SURF[r.SURF[i]].name]);
    if (g && g.V) rows.push(['Vel. segura', `≈ ${g.V[i].toFixed(0)} km/h`]);
    const nb = [-50, -20, 20, 50].filter(o => d + o >= 0 && d + o <= r.total).map(o => `<span class="${o < 0 ? 'pv' : 'nx'}">${o > 0 ? '+' : ''}${o} m: <b>${(hAt(d + o) + h0).toFixed(1)}</b> (${fmtH(+(hAt(d + o) - p.hs).toFixed(2))})</span>`).join('');
    rows.push(['Antes / después', `<div class="nbh">${nb}</div>`]);
  } else {
    const a = edAt(s.d0), b = edAt(s.d1); let mx = -Infinity, mn = Infinity, gmax = 0;
    for (let x = s.d0; x <= s.d1; x += 2) { const h = hAt(x); mx = Math.max(mx, h); mn = Math.min(mn, h); if (x + 4 <= s.d1) gmax = Math.max(gmax, Math.abs(hAt(x + 4) - h) / 4 * 100); }
    $('#vpSel').textContent = `Tramo ${(s.d0 / 1000).toFixed(3)}–${(s.d1 / 1000).toFixed(3)} km (${(s.d1 - s.d0).toFixed(0)} m)`;
    rows.push(['Altura inicio / fin', `${(a.hs + h0).toFixed(1)} → ${(b.hs + h0).toFixed(1)} m`], ['Desnivel', `${fmtH(+(b.hs - a.hs).toFixed(2))} m`], ['Pendiente media', `${((b.hs - a.hs) / (s.d1 - s.d0) * 100).toFixed(1)} %`],
      ['Pendiente máxima', `${gmax.toFixed(1)} %`], ['Mín / máx', `${(mn + h0).toFixed(1)} / ${(mx + h0).toFixed(1)} m`], ['Peralte al medio', bankTxt]);
  }
  rows.push(['Desde el inicio', `${(d / 1000).toFixed(3)} km de ${(r.total / 1000).toFixed(2)}`]);
  $('#vpData').innerHTML = rows.map(([k, v]) => `<div class="vr"><span>${k}</span><span>${v}</span></div>`).join('');
  // parámetros de la edición elegida (se pueden escribir: precisión)
  const e = edTarget(), kind = ED_KIND[ED.tool];
  if (!light || !ED.drag) {
    const ps = e && ED_PARAMS[e.kind] ? ED_PARAMS[e.kind](e) : [];
    let html = `<div class="vp-t">${ED_TOOLS.find(t => t[0] === ED.tool)[2]}</div>`;
    if (e) {
      html += `<div class="vp-e"><b>${EDIT_TXT[e.kind](e)}</b> <button class="b sm" id="vpDel" title="Eliminar este cambio (Supr)">🗑 Eliminar</button></div>`;
      html += ps.map(([key, name, unit, step, mn, mx]) => { const val = e[key] != null ? e[key] : (key === 'h1' ? e.h : key === 'f0' || key === 'f1' ? 25 : key === 'r' ? 30 : key === 'land' ? e.len * 0.3 : 0);
        return `<label class="vp-p">${name} <span><input type="number" data-k="${key}" value="${+(+val).toFixed(3)}" step="${step}"${mn != null ? ` min="${mn}"` : ''}${mx != null ? ` max="${mx}"` : ''}> ${unit}</span></label>`; }).join('');
      const tr = edTransInfo(e); if (tr) html += `<div class="mut">${tr}</div>`;
    } else if (['jump', 'bump', 'pothole', 'cattle'].includes(kind)) html += `<button class="b wide" id="vpMake">Crear ${ED_TOOLS.find(t => t[0] === ED.tool)[1].slice(2)} acá</button>`;
    else if (kind === 'smooth') html += `<button class="b wide" id="vpMake">Suavizar ${s.d1 - s.d0 < 10 ? 'alrededor del punto (±25 m)' : 'el tramo elegido'}</button>`;
    else if (kind === 'shape') html += '<div class="mut">Arrastrá un punto amarillo.</div>';
    else html += '<div class="mut">Arrastrá una manija para crear el cambio.</div>';
    html += `<div class="vp-surf"><select id="vpSurf">${$('#surfKey').innerHTML}</select><button class="b sm" id="vpSurfGo">Superficie al tramo</button></div>`;
    $('#vpParams').innerHTML = html;
    $('#vpSurf').value = $('#surfKey').value;
    $('#vpParams').querySelectorAll('input[data-k]').forEach(inp => {
      inp.onfocus = () => { inp._undo = false; };
      inp.oninput = () => { const v = parseFloat(inp.value); if (!isFinite(v)) return; if (!inp._undo) { edPushUndo(); inp._undo = true; } e[inp.dataset.k] = v; if (e.d1 !== undefined && e.d1 < e.d0) [e.d0, e.d1] = [e.d1, e.d0]; edSchedule(); clearTimeout(ED.commitT); ED.commitT = setTimeout(() => { liveCommit(); }, 350); };
    });
    const del = $('#vpDel'); if (del) del.onclick = () => edDelete(e);
    const mk = $('#vpMake'); if (mk) mk.onclick = () => { edPushUndo(); const ne = edMake(kind); S.edits.push(ne); ED.active = ne; editsChanged(); };
    $('#vpSurfGo').onclick = () => { edPushUndo(); const ne = { kind: 'surface', ...edSecSel(), key: $('#vpSurf').value }; S.edits.push(ne); editsChanged(); };
  }
  // ediciones cercanas y sus transiciones
  const near = S.edits.filter(x => { const [a, b] = edExtent(x); return b >= d - 200 && a <= d + 200; });
  $('#vpNear').innerHTML = near.length ? '<div class="vp-t">Cambios cercanos</div>' + near.map(x => `<div class="vp-n${x === ED.active ? ' on' : ''}" data-k="${S.edits.indexOf(x)}">${EDIT_TXT[x.kind](x)} <span class="mut">· ${where(x)}${edTransInfo(x) ? ' · ' + edTransInfo(x) : ''}</span></div>`).join('') : '';
  $('#vpNear').querySelectorAll('.vp-n').forEach(div => div.onclick = () => edFocusEdit(S.edits[+div.dataset.k], true));
}
function edTransInfo(e) {
  if (e.kind === 'raise') return e.d1 - e.d0 < 1 ? `transición ±${(e.r || 30).toFixed(0)} m` : `transiciones ${(e.f0 != null ? e.f0 : 25).toFixed(0)} / ${(e.f1 != null ? e.f1 : 25).toFixed(0)} m`;
  if (e.kind === 'jump') { const land = e.land != null ? e.land : e.len * 0.3; return `entrada ${(e.h / e.len * 100).toFixed(0)}% en ${e.len.toFixed(0)} m · recepción ${(e.h / land * 100).toFixed(0)}% en ${land.toFixed(1)} m`; }
  if (e.kind === 'bump' || e.kind === 'pothole') return `largo ${(+e.len).toFixed(1)} m`;
  return '';
}
function edDelete(e) {
  if (!e || !S.edits.includes(e)) return;
  edPushUndo(); S.edits.splice(S.edits.indexOf(e), 1); if (ED.active === e) ED.active = null; editsChanged();
}

// ---------- perfil de alturas (panel lateral y vista 3D, sincronizados) ----------
function makeProf(cv, opt) {
  const P = { cv, pad: { l: 40, r: 8, t: 10, b: opt.strips ? 36 : 20 }, down: null, hover: null, drag: null, lock: null };
  const geom = () => {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    return { w, h, dpr, pw: w - P.pad.l - P.pad.r, ph: h - P.pad.t - P.pad.b };
  };
  P.win = () => { const r = edR(); return P.lock ? P.lock.win : opt.window ? opt.window(r) : [0, r.total]; };
  P.draw = () => {
    const R = S.result; if (!R || R.mode !== 'route' || !cv.clientWidth) return;
    const r = R.res, G = geom(), ctx = cv.getContext('2d'), p = P.pad, h0 = R.h0, [w0, w1] = P.win();
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0); ctx.clearRect(0, 0, G.w, G.h);
    const a = Math.max(0, fixIdx(w0) - 1), b = Math.min(r.n - 1, fixIdx(w1) + 1);
    let mn = Infinity, mx = -Infinity; for (let i = a; i <= b; i++) { mn = Math.min(mn, r.hs[i], r.raw[i]); mx = Math.max(mx, r.hs[i], r.raw[i]); }
    if (P.lock) { mn = P.lock.mn; mx = P.lock.mx; } else { const pad = Math.max(opt.strips ? 5 : 2, (mx - mn) * 0.12); mn -= pad; mx += pad; }
    const X = d => p.l + (d - w0) / (w1 - w0) * G.pw, Y = h => p.t + (1 - (h - mn) / (mx - mn)) * G.ph;
    Object.assign(P, { X, Y, mn, mx, G, w0, w1, inv: x => Math.max(0, Math.min(r.total, w0 + (x - p.l) / G.pw * (w1 - w0))) });
    ctx.save(); ctx.beginPath(); ctx.rect(p.l, 0, G.pw, G.h); ctx.clip();
    ctx.font = '10px Inter, sans-serif'; ctx.fillStyle = '#8b939c'; ctx.strokeStyle = '#262a30'; ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) { const y = Y(mn + (mx - mn) * k / 3); ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(G.w - p.r, y); ctx.stroke(); }
    // terreno original y camino
    ctx.strokeStyle = '#59606a'; ctx.setLineDash([3, 3]); ctx.beginPath();
    for (let i = a; i <= b; i++) { const x = X(r.dist[i]), y = Y(r.raw[i]); i > a ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(X(r.dist[a]), p.t + G.ph); for (let i = a; i <= b; i++) ctx.lineTo(X(r.dist[i]), Y(r.hs[i])); ctx.lineTo(X(r.dist[b]), p.t + G.ph); ctx.closePath();
    ctx.fillStyle = 'rgba(255,210,0,0.10)'; ctx.fill();
    ctx.strokeStyle = '#ffd200'; ctx.lineWidth = 1.6; ctx.beginPath(); for (let i = a; i <= b; i++) { const x = X(r.dist[i]), y = Y(r.hs[i]); i > a ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
    // ediciones
    for (const e of S.edits) {
      const [ea, eb] = edExtent(e); if (eb < w0 || ea > w1) continue;
      ctx.fillStyle = e === ED.active ? '#ff7ad9' : 'rgba(255,122,217,0.8)';
      if (e.d !== undefined) { ctx.fillRect(X(e.d) - 0.5, p.t, 1, G.ph); ctx.globalAlpha = e === ED.active ? 0.16 : 0.07; ctx.fillRect(X(ea), p.t, Math.max(1, X(eb) - X(ea)), G.ph); ctx.globalAlpha = 1; }
      else { ctx.globalAlpha = e === ED.active ? 0.2 : 0.1; ctx.fillRect(X(e.d0), p.t, Math.max(2, X(e.d1) - X(e.d0)), G.ph); ctx.globalAlpha = 1; }
    }
    if (S.sel) {
      ctx.fillStyle = 'rgba(0,200,255,0.16)'; ctx.strokeStyle = '#00c8ff';
      const sa = X(S.sel.d0), sb = X(S.sel.d1); ctx.fillRect(sa, p.t, Math.max(2, sb - sa), G.ph); ctx.strokeRect(sa, p.t, Math.max(2, sb - sa), G.ph);
    }
    // manijas (las mismas que en 3D)
    P.handles = [];
    if (edOn() || !opt.dock) for (const g of (ED.gz.length ? ED.gz : edGizmoDefs())) {
      if (g.lat || g.type === 'side' || g.type === 'plane') continue;
      const hy = edAt(g.d).hs, x = X(g.d), y = g.type === 'up' ? Y(hy) : Y(hy) + 0; if (x < p.l - 2 || x > G.w - p.r + 2) continue;
      P.handles.push({ g, x, y });
      ctx.fillStyle = '#' + GZ_COL[g.col].toString(16).padStart(6, '0'); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.beginPath();
      if (g.type === 'up') ctx.arc(x, y, ED.drag && ED.drag.g === g ? 7 : 5.5, 0, 7); else if (g.type === 'move') { ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath(); } else ctx.rect(x - 4.5, y - 4.5, 9, 9);
      ctx.fill(); ctx.stroke();
    }
    if (P.hover != null) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(P.hover), p.t); ctx.lineTo(X(P.hover), p.t + G.ph); ctx.stroke(); }
    ctx.restore();
    // ejes
    ctx.fillStyle = '#8b939c'; ctx.font = '10px Inter, sans-serif';
    for (let k = 1; k <= 3; k++) { const h = mn + (mx - mn) * k / 3; ctx.fillText(Math.round(h + h0) + ' m', 2, Y(h) + 3); }
    const span = w1 - w0, stepKm = span > 20000 ? 5000 : span > 8000 ? 2000 : span > 3000 ? 1000 : span > 1200 ? 500 : span > 500 ? 100 : 50;
    for (let d = Math.ceil(w0 / stepKm) * stepKm; d <= w1; d += stepKm) ctx.fillText(stepKm >= 1000 ? (d / 1000).toFixed(0) + ' km' : (d / 1000).toFixed(stepKm < 100 ? 2 : 1) + ' km', X(d) - 10, G.h - (opt.strips ? 2 : 4));
    if (opt.strips) {
      const sy = p.t + G.ph + 4, gy = sy + 8, grip = R.info.grip;
      for (let i = a; i < b; i++) {
        const x0 = X(r.dist[i]), x1 = Math.max(x0 + 0.6, X(r.dist[i + 1]));
        ctx.fillStyle = SURF[r.SURF[i]].ui; ctx.fillRect(x0, sy, x1 - x0, 6);
        ctx.fillStyle = CLS_COL[grip.CLS[i]]; ctx.fillRect(x0, gy, x1 - x0, 6);
      }
      ctx.fillStyle = '#8b939c'; ctx.fillText('sup.', 4, sy + 6); ctx.fillText('agarre', 2, gy + 6);
    }
    if (opt.dock && P.hover != null) { const i = fixIdx(P.hover); ctx.fillStyle = '#fff'; ctx.fillText(`${(P.hover / 1000).toFixed(3)} km · ${(r.hs[i] + h0).toFixed(2)} m`, p.l + 6, p.t + 11); }
  };
  const handleAt = (x, y) => { let best = null; for (const h of P.handles || []) { const d = Math.hypot(h.x - x, h.y - y); if (d < 10 && (!best || d < best.d)) best = { d, h }; } return best && best.h; };
  cv.addEventListener('pointerdown', ev => {
    if (!edR()) return; cv.setPointerCapture(ev.pointerId);
    const h = handleAt(ev.offsetX, ev.offsetY);
    if (h) { // arrastrar una manija desde el perfil: misma edición que en 3D
      if (!ED.gz.length) ED.gz = edGizmoDefs();
      const g = ED.gz.find(q => q.type === h.g.type && Math.abs(q.d - h.g.d) < 0.01 && q.tip === h.g.tip) || h.g; g.pos = edGizmoPos(g);
      if (!edStartDrag(g, 'prof')) return;
      P.drag = { x0: ev.offsetX, y0: ev.offsetY, mpp: (P.mx - P.mn) / P.G.ph, dpp: (P.w1 - P.w0) / P.G.pw };
      P.lock = { mn: P.mn, mx: P.mx, win: [P.w0, P.w1] }; return;
    }
    P.down = P.inv(ev.offsetX); P.shift = ev.shiftKey;
    if (ev.shiftKey && S.sel) { P.down = ED.anchor != null ? ED.anchor : S.sel.d0; }
  });
  cv.addEventListener('pointermove', ev => {
    if (!edR()) return;
    if (P.drag && ED.drag) {
      const g = ED.drag.g, x = g.type === 'up' ? -(ev.offsetY - P.drag.y0) * P.drag.mpp : (ev.offsetX - P.drag.x0) * P.drag.dpp;
      edApplyDrag(x, ev.shiftKey); return;
    }
    const d = P.inv(ev.offsetX); P.hover = d;
    cv.style.cursor = handleAt(ev.offsetX, ev.offsetY) ? 'grab' : 'crosshair';
    if (P.down != null) S.sel = { d0: Math.min(P.down, d), d1: Math.max(P.down, d) };
    if (opt.hoverInfo) opt.hoverInfo(d);
    drawProfile();
  });
  cv.addEventListener('pointerup', ev => {
    if (P.drag) { P.drag = null; P.lock = null; edEndDrag(); drawProfile(); return; }
    if (P.down == null) return;
    const d = P.inv(ev.offsetX), r = edR(), tiny = Math.abs(d - P.down) < (P.w1 - P.w0) / 300;
    if (tiny && !P.shift) edSelect(P.down, false);
    else { const a = Math.min(P.down, d), b = Math.max(P.down, d); ED.anchor = P.down; S.sel = { d0: a, d1: tiny ? a : b }; if (ED.active && !(ED.active.d0 !== undefined && Math.abs(ED.active.d0 - a) < 1.5)) ED.active = null; selInfo(); drawSel(); drawProfile(); edRefresh(); renderEdits(); }
    P.down = null;
  });
  cv.addEventListener('pointerleave', () => { P.hover = null; if (opt.leave) opt.leave(); drawProfile(); });
  return P;
}
const PROF = makeProf($('#profile'), {
  strips: true,
  hoverInfo: d => {
    const r = S.result.res, i = fixIdx(d), g = S.result.info.grip;
    $('#hoverInfo').textContent = `${(d / 1000).toFixed(3)} km · ${(r.hs[i] + S.result.h0).toFixed(0)} m · pendiente ${(g.GR[i] * 100).toFixed(1)}% · ancho ${r.W[i].toFixed(1)} m · ${SURF[r.SURF[i]].name} · vel. segura ≈ ${g.V[i].toFixed(0)} km/h`;
    const ll = S.result.info.ll[i]; if (!PROF.dot) PROF.dot = L.circleMarker(ll, { radius: 6, color: '#fff', fillColor: '#00c8ff', fillOpacity: 1 }).addTo(map); else PROF.dot.setLatLng(ll);
  },
  leave: () => { if (PROF.dot) { map.removeLayer(PROF.dot); PROF.dot = null; } },
});
const PROF3 = makeProf($('#vprof'), {
  dock: true,
  window: r => {
    if (!S.sel) return [0, r.total];
    const c = (S.sel.d0 + S.sel.d1) / 2, ext = ED.active ? edExtent(ED.active) : [S.sel.d0, S.sel.d1];
    const half = Math.max(120, (Math.max(S.sel.d1, ext[1]) - Math.min(S.sel.d0, ext[0])) / 2 * 1.35 + 40);
    let a = c - half, b = c + half; if (a < 0) { b -= a; a = 0; } if (b > r.total) { a -= b - r.total; b = r.total; } return [Math.max(0, a), b];
  },
});
function drawProfile() { PROF.draw(); if ($('#viewer').style.display !== 'none' && ED.panelOn) PROF3.draw(); }
window.addEventListener('resize', () => drawProfile());

// ---------- eventos de la vista 3D ----------
ED.panelOn = true;
$('#editCurves').onclick = () => { ED.panelOn = !ED.panelOn; edRefresh(); edBuildSelMesh(); drawProfile(); };
$('#vpTools').innerHTML = ED_TOOLS.map(([k, name, tip]) => `<button class="b" data-tool="${k}" title="${tip}">${name}</button>`).join('');
$('#vpTools').querySelectorAll('button').forEach(b => b.onclick = () => {
  const t = b.dataset.tool; ED.tool = t; if (ED.active && ED.active.kind !== ED_KIND[t]) ED.active = null;
  // salto, lomada, bache, guardaganado: se crean al tocar la herramienta (en el punto elegido)
  if (S.sel && ['jump', 'bump', 'pothole', 'cattle'].includes(t) && !edTarget()) { edPushUndo(); const e = edMake(ED_KIND[t]); S.edits.push(e); ED.active = e; editsChanged(); return; }
  edRefresh(); drawProfile();
});
$('#dragR').onchange = () => edRefresh();
function edHookViewer() {
  const el = PV.renderer && PV.renderer.domElement; if (!el || el.__ed) return; el.__ed = true;
  const c = PV.controls;
  // navegación: izquierdo o central = desplazar, derecho (o Ctrl+izquierdo) = girar, rueda = acercar hacia el cursor
  c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  c.screenSpacePanning = false; c.enableZoom = false; c.maxPolarAngle = Math.PI * 0.495; c.panSpeed = 1; c.rotateSpeed = 0.7;
  c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  PV.onFrame = edFrame;
  let down = null;
  el.addEventListener('pointerdown', ev => {
    down = { x: ev.clientX, y: ev.clientY, b: ev.button };
    if (ev.button !== 0 || !edOn()) return;
    const g = edPickGizmo(ev); if (!g) return;
    if (!edStartDrag(g, '3d')) return;
    PV.controls.enabled = false; el.setPointerCapture(ev.pointerId); el.style.cursor = 'grabbing';
    ev.stopImmediatePropagation(); ev.preventDefault();
  }, true);
  el.addEventListener('pointermove', ev => {
    if (ED.drag && ED.drag.src === '3d') { edApplyDrag(edDragDelta(ev), ev.shiftKey); return; }
    if (!edOn() || ev.buttons) return;
    const g = edPickGizmo(ev); if (g !== ED.hover) { ED.hover = g; el.style.cursor = g ? 'grab' : ''; edHint(g ? g.tip : ''); }
  });
  el.addEventListener('pointerup', ev => {
    if (ED.drag && ED.drag.src === '3d') { edEndDrag(); el.style.cursor = ''; edHint(''); return; }
    // clic sin arrastrar sobre el camino = elegir
    if (down && down.b === 0 && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 5 && edR() && !PV.drive) {
      const q = edPickRoad(ev); if (q) edSelect(q.d, ev.shiftKey);
    }
    down = null;
  });
  el.addEventListener('contextmenu', ev => ev.preventDefault());
  el.addEventListener('wheel', ev => {
    ev.preventDefault(); if (PV.drive) return;
    const cam = PV.camera, t = c.target, f = Math.pow(1.0012, ev.deltaY * (ev.deltaMode === 1 ? 30 : 1));
    const hit = edPlaneHit(edRay(ev), new THREE.Plane(new THREE.Vector3(0, 1, 0), -t.y)) || t.clone();
    if (f < 1 && cam.position.distanceTo(t) < 2) return;
    if (hit.distanceTo(cam.position) > 20000) hit.copy(t);
    cam.position.sub(hit).multiplyScalar(f).add(hit); t.sub(hit).multiplyScalar(f).add(hit);
  }, { passive: false });
  el.addEventListener('dblclick', ev => {
    const rc = edRay(ev), list = [...PV.byMesh.entries()].filter(([m]) => m.route || m.terrain).map(([, mesh]) => mesh), h = rc.intersectObjects(list, false)[0];
    if (!h) return;
    const to = h.point, off = PV.camera.position.clone().sub(c.target), L = off.length(); off.multiplyScalar(Math.min(1, 60 / L));
    const t0 = c.target.clone(), c0 = PV.camera.position.clone(), c1 = to.clone().add(off), T0 = performance.now();
    const step = () => { const k = Math.min(1, (performance.now() - T0) / 350), s = k * k * (3 - 2 * k); c.target.lerpVectors(t0, to, s); PV.camera.position.lerpVectors(c0, c1, s); if (k < 1) requestAnimationFrame(step); };
    step();
  });
  const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'); };
  window.addEventListener('keydown', ev => {
    if ($('#viewer').style.display === 'none' || typing()) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); edUndo(ev.shiftKey); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); edUndo(true); return; }
    if ((k === 'delete' || k === 'backspace') && ED.active) { ev.preventDefault(); edDelete(ED.active); return; }
    if (k === 'escape') { S.sel = null; ED.active = null; selInfo(); drawSel(); drawProfile(); edRefresh(); edBuildSelMesh(); return; }
    if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) && !ev.ctrlKey && !ev.metaKey) { ED.keys.add(k); if (k.startsWith('arrow')) ev.preventDefault(); }
  });
  window.addEventListener('keyup', ev => ED.keys.delete(ev.key.toLowerCase()));
  window.addEventListener('blur', () => ED.keys.clear());
}
