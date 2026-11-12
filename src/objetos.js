// ===== Objetos puestos a mano en la vista 3D =====
// Árboles (de a uno o con pincel), casas, galpones, personas, público, piedras, puentes y lagos, en cualquier lugar.
// Se guardan en S.placed con su latitud/longitud (así siguen en su lugar aunque se regenere el tramo) y se arman
// como mallas aparte (m.placed): agregar o mover algo no rehace el camino ni el terreno (salvo los lagos, que
// cavan el terreno solo en su zona). La goma también saca árboles automáticos y deja la zona marcada sin árboles.

const OB = {
  type: 'select', species: 'selva', hMin: 9, hMax: 20, radius: 12, density: 6, sel: null,
  paint: null, move: null, pending: false, ring: null, selRing: null, lastPaint: 0, clearXY: [],
};
const OB_TYPES = [
  ['select', '👆 Elegir / mover', 'Clic sobre un objeto o árbol para elegirlo; arrastralo para moverlo. Supr lo borra.'],
  ['brush', '🌳 Pincel de árboles', 'Arrastrá sobre el terreno para llenar de árboles (radio y densidad abajo).'],
  ['erase', '🧽 Goma de árboles', 'Arrastrá para borrar árboles: los puestos a mano y los automáticos (esa zona queda sin árboles automáticos).'],
  ['tree', '🌲 Un árbol', 'Clic donde quieras un árbol.'],
  ['house', '🏠 Casa', 'Clic para poner una casa.'],
  ['shed', '🏚 Galpón', 'Clic para poner un galpón.'],
  ['person', '🧍 Persona', 'Clic para poner una persona.'],
  ['crowd', '👥 Público', 'Clic para poner un grupo de espectadores.'],
  ['rock', '🪨 Piedra', 'Clic para poner una piedra grande (se choca).'],
  ['bridge', '🌉 Puente', 'Clic en el centro del puente; después ajustá largo, ancho, altura y giro.'],
  ['lake', '💧 Lago', 'Clic en el centro del lago: se cava el terreno y se llena de agua.'],
];
const OB_SPECIES = { selva: 'Selva / yungas (alto, tupido)', mixto: 'Mixto', lenga: 'Hoja ancha (lenga, ñire)', pino: 'Pinos', arbusto: 'Arbustos y monte bajo' };
const OB_NAME = { tree: 'Árbol', house: 'Casa', shed: 'Galpón', person: 'Persona', crowd: 'Público', rock: 'Piedra', bridge: 'Puente', lake: 'Lago', clear: 'Zona sin árboles' };

// ---------- coordenadas ----------
const obXY = o => S.base.P.fwd(o.ll[0], o.ll[1]);
const obLL = (x, y) => { const [la, lo] = S.base.P.inv(x, y); return [+la.toFixed(7), +lo.toFixed(7)]; };
function obGround(ter) {
  const R = ter || (S.result && S.result.ter), B = S.base; if (!R) return (x, y) => B.height(x, y);
  const res = (B.bbox.maxx - B.bbox.minx) / (R.nx - 1), f = Core.terrainHeightFn(R, B.bbox, res);
  return (x, y) => { const h = f(x, y); return h == null ? B.height(x, y) : h; };
}
// lagos para el terreno: el nivel del agua es la parte más baja de la orilla (así el agua nunca queda colgando)
function obLakes(B) {
  OB.clearXY = S.placed.filter(o => o.k === 'clear').map(o => { const [x, y] = B.P.fwd(o.ll[0], o.ll[1]); return [x, y, o.r * o.r]; });
  const L = S.placed.filter(o => o.k === 'lake').map(o => {
    const [x, y] = B.P.fwd(o.ll[0], o.ll[1]); let h = Infinity;
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; h = Math.min(h, B.height(x + Math.cos(a) * (o.r + 3), y + Math.sin(a) * (o.r + 3))); }
    o._h = h; return { x, y, r: o.r, depth: o.depth || 2, bank: 6, h };
  });
  return L.length ? L : null;
}
function obCleared(x, y) { for (const c of OB.clearXY) { const dx = x - c[0], dy = y - c[1]; if (dx * dx + dy * dy < c[2]) return true; } return false; }
function obStats() {
  const c = {}; for (const o of S.placed) if (o.k !== 'clear') c[o.k] = (c[o.k] || 0) + 1;
  return Object.entries(c).map(([k, n]) => `${n} ${OB_NAME[k].toLowerCase()}${n > 1 ? (k === 'tree' ? 'es' : k === 'crowd' || k === 'clear' ? '' : 's') : ''}`).join(', ') || 'ninguno';
}

// ---------- mallas ----------
const OB_ICO = (() => { const t = (1 + Math.sqrt(5)) / 2, V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v => { const L = Math.hypot(...v); return v.map(c => c / L); });
  return { V, F: [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]] }; })();
function obMeshes(B, ter) {
  const hAt = obGround(ter), out = [], seq = {};
  const M = (name, mat, extra) => { const m = Object.assign({ name, mat, v: [], uv: [], f: [], placed: true }, extra || {}); out.push(m); return m; };
  const pool = (key, mk, limit = 48000) => { const l = seq[key] || (seq[key] = []); let m = l[l.length - 1]; if (!m || m.v.length > limit) { m = mk(l.length); l.push(m); } return m; };
  // triángulo orientado hacia afuera de 'inside' (Assetto Corsa no dibuja la cara de atrás)
  const tri = (m, a, b, c, inside) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (inside && nx * ((a[0] + b[0] + c[0]) / 3 - inside[0]) + ny * ((a[1] + b[1] + c[1]) / 3 - inside[1]) + nz * ((a[2] + b[2] + c[2]) / 3 - inside[2]) < 0) [b, c] = [c, b];
    const k = m.v.length; m.v.push(a, b, c); m.uv.push([0, 0], [1, 0], [1, 1]); m.f.push([k, k + 1, k + 2]);
  };
  const quad = (m, a, b, c, d, inside) => { tri(m, a, b, c, inside); tri(m, a, c, d, inside); };
  const box = (m, cx, cy, ang, lx, ly, z0, z1, skipBottom) => { // caja girada: centro, ángulo, medio largo y medio ancho
    const ca = Math.cos(ang), sa = Math.sin(ang), P = (sx, sy, z) => [cx + ca * lx * sx - sa * ly * sy, cy + sa * lx * sx + ca * ly * sy, z], ins = [cx, cy, (z0 + z1) / 2];
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < 4; i++) { const [a, b] = [c[i], c[(i + 1) % 4]]; quad(m, P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], z1), P(a[0], a[1], z1), ins); }
    quad(m, P(-1, -1, z1), P(1, -1, z1), P(1, 1, z1), P(-1, 1, z1), ins);
    if (!skipBottom) quad(m, P(-1, -1, z0), P(1, -1, z0), P(1, 1, z0), P(-1, 1, z0), ins);
  };
  // planos cruzados con textura (árboles y personas), con cara de atrás
  const billboard = (m, x, y, z0, Ht, W, ang, u0, u1) => {
    for (const a of [ang, ang + Math.PI / 2]) {
      const dx = Math.cos(a) * W / 2, dy = Math.sin(a) * W / 2, b = m.v.length;
      m.v.push([x - dx, y - dy, z0], [x + dx, y + dy, z0], [x + dx, y + dy, z0 + Ht], [x - dx, y - dy, z0 + Ht]); m.uv.push([u0, 0], [u1, 0], [u1, 1], [u0, 1]); m.f.push([b, b + 1, b + 2], [b, b + 2, b + 3]);
      const c = m.v.length; m.v.push([x - dx, y - dy, z0], [x + dx, y + dy, z0], [x + dx, y + dy, z0 + Ht], [x - dx, y - dy, z0 + Ht]); m.uv.push([u0, 0], [u1, 0], [u1, 1], [u0, 1]); m.f.push([c, c + 2, c + 1], [c, c + 3, c + 2]);
    }
  };
  let nWall = 0, nRoad = 0, nWater = 0;
  for (const o of S.placed) {
    if (o.k === 'clear') continue;
    const [x, y] = B.P.fwd(o.ll[0], o.ll[1]), h = hAt(x, y), ang = (o.rot || 0) * D2R, s = o.s || 1;
    if (o.k === 'tree') {
      const m = pool('tree', i => M('TREES_PLACED_' + i, 'tree', { block: 16 }));
      const slot = o.sp, Ht = o.h * s, W = Ht * (slot === 0 ? 0.68 : slot === 2 ? 1.3 : 0.85);
      billboard(m, x, y, h - 0.3, Ht, W, ang, slot / 4, (slot + 1) / 4);
    } else if (o.k === 'person' || o.k === 'crowd') {
      const m = pool('people', i => M('OBJECTS_PEOPLE_' + i, 'people'));
      const list = o.k === 'person' ? [[0, 0, o.v || 0]] : Array.from({ length: o.n || 10 }, (_, i) => { const r = (o.r || 4) * Math.sqrt(((i * 0.618034) % 1)), a = i * 2.39996; return [Math.cos(a) * r, Math.sin(a) * r, i]; });
      for (const [dx, dy, v] of list) { const px = x + dx, py = y + dy, slot = Math.abs(v) % 4; billboard(m, px, py, hAt(px, py) - 0.05, 1.75 * s, 0.62 * s, ang + v * 0.7, slot / 4, (slot + 1) / 4); }
    } else if (o.k === 'rock') {
      const m = pool('rock', i => M(`${9200 + i}WALL`, 'boulder')), r = 0.6 * s, b = m.v.length;
      OB_ICO.V.forEach(([X, Y, Z], k) => { const f = r * (0.75 + 0.5 * ((Math.sin(k * 12.9898 + o.ll[0] * 1e5) * 43758.5453) % 1 + 1) % 1); const lx = X * f * 1.2, ly = -Z * f, lz = Y * f * 0.8; m.v.push([x + lx * Math.cos(ang) - ly * Math.sin(ang), y + lx * Math.sin(ang) + ly * Math.cos(ang), h - r * 0.25 + lz]); m.uv.push([(X + 1) / 2, (Y + 1) / 2]); });
      OB_ICO.F.forEach(([a, bb, c]) => m.f.push([b + a, b + bb, b + c]));
    } else if (o.k === 'house' || o.k === 'shed') {
      const big = o.k === 'shed', L = (big ? 8 : 4.5) * s, Wd = (big ? 5 : 3.5) * s, wallH = (big ? 4.5 : 2.8) * s;
      const ca = Math.cos(ang), sa = Math.sin(ang), P = (u, v) => [x + ca * u - sa * v, y + sa * u + ca * v];
      let lo = Infinity, hi = -Infinity; for (const [u, v] of [[-L, -Wd], [L, -Wd], [L, Wd], [-L, Wd]]) { const g = hAt(...P(u, v)); lo = Math.min(lo, g); hi = Math.max(hi, g); }
      const z0 = lo - 0.3, z1 = hi + wallH, ridge = z1 + (big ? 1.6 : 1.9) * s;
      const walls = M(`${9100 + (++nWall)}WALL`, big ? 'broofs' : 'bwall'); box(walls, x, y, ang, L, Wd, z0, z1, true);
      const roofMat = big ? 'broofs' : ['broofr', 'broofb', 'broofg', 'broofr'][(o.v || 0) % 4], roof = pool('roof_' + roofMat, i => M('OBJECTS_PLACED_ROOF_' + roofMat + '_' + i, roofMat));
      const e = 0.4, A = [...P(-L - e, -Wd - e), z1], Bq = [...P(L + e, -Wd - e), z1], C = [...P(L + e, Wd + e), z1], D = [...P(-L - e, Wd + e), z1], R0 = [...P(-L - e, 0), ridge], R1 = [...P(L + e, 0), ridge];
      const ins = [x, y, z1]; quad(roof, A, Bq, R1, R0, ins); quad(roof, C, D, R0, R1, ins);   // dos aguas (vistas desde arriba y desde abajo)
      quad(roof, A, R0, R1, Bq, [x, y, ridge + 5]); quad(roof, D, C, R1, R0, [x, y, ridge + 5]);
      tri(walls, [...P(-L, -Wd), z1], [...P(-L, Wd), z1], [...P(-L, 0), ridge - 0.05], [x, y, z1]); tri(walls, [...P(L, -Wd), z1], [...P(L, Wd), z1], [...P(L, 0), ridge - 0.05], [x, y, z1]);  // hastiales
    } else if (o.k === 'bridge') {
      const L = (o.len || 20) / 2, Wd = (o.w || 7) / 2, top = (o.top != null ? o.top : h) + (o.lift || 0);
      o._top = top;
      const deck = M(`${9300 + (++nRoad)}ROAD`, 'asphalt'), conc = pool('bconc', i => M('OBJECTS_PLACED_BRIDGE_' + i, 'bconc')), rail = M(`${9100 + (++nWall)}WALL`, 'brail');
      const ca = Math.cos(ang), sa = Math.sin(ang), P = (u, v) => [x + ca * u - sa * v, y + sa * u + ca * v];
      quad(deck, [...P(-L, -Wd), top], [...P(L, -Wd), top], [...P(L, Wd), top], [...P(-L, Wd), top], [x, y, top - 1]);     // calzada (se maneja)
      box(conc, x, y, ang, L, Wd + 0.3, top - 0.7, top - 0.02);                                                              // tablero
      for (const sg of [1, -1]) { const [rx, ry] = P(0, sg * (Wd + 0.15)); box(rail, rx, ry, ang, L, 0.12, top, top + 0.8); }  // barandas
      for (const u of [-L + 0.6, 0, L - 0.6]) for (const v of [-Wd + 0.8, Wd - 0.8]) { const [px, py] = P(u, v), g = hAt(px, py); if (g < top - 1.2) box(conc, px, py, ang, 0.5, 0.5, g - 0.5, top - 0.7); }  // pilares
    } else if (o.k === 'lake') {
      const lvl = (o._h != null ? o._h : h) - 0.12, r = o.r + 0.4, m = M(`${9700 + (++nWater)}WATER`, 'water'), seg = Math.max(24, Math.round(o.r * 1.5));
      m.v.push([x, y, lvl]); m.uv.push([x / 8, y / 8]);
      for (let k = 0; k < seg; k++) { const a = k / seg * Math.PI * 2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; m.v.push([px, py, lvl]); m.uv.push([px / 8, py / 8]); }
      for (let k = 0; k < seg; k++) m.f.push([0, 1 + k, 1 + (k + 1) % seg]);
    }
  }
  return out.filter(m => m.f.length);
}

// ---------- actualización en vivo ----------
function obRefresh() {
  const R = S.result; if (!R || R.mode !== 'route' || !PV.byMesh) return;
  R.meshes.filter(m => m.placed).forEach(pvRemove);
  R.meshes = R.meshes.filter(m => !m.placed);
  const nm = obMeshes(S.base, R.ter); R.meshes.push(...nm); nm.forEach(pvAdd);
  obRings(); obDrawMini();
}
function obSchedule() { if (OB.pending) return; OB.pending = true; requestAnimationFrame(() => { OB.pending = false; obRefresh(); obPanel(true); }); }
// el lago cambió: recalcular el terreno solo alrededor de él
function obLakeCommit(rects) {
  const L = S.live; if (!L || !L.terOpts) { obRefresh(); return; }
  L.terOpts.lakes = obLakes(S.base);
  const q = L.dirty || (L.dirty = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity });
  for (const r of rects) { q.minx = Math.min(q.minx, r[0] - r[2] - 8); q.maxx = Math.max(q.maxx, r[0] + r[2] + 8); q.miny = Math.min(q.miny, r[1] - r[2] - 8); q.maxy = Math.max(q.maxy, r[1] + r[2] + 8); }
  liveCommit(); obRefresh();
}
// goma sobre los árboles automáticos (los que armó la generación): se sacan ya y la zona queda marcada
function obClearAuto(x, y, r) {
  const R = S.result; if (!R) return; const r2 = r * r;
  for (const m of R.meshes) {
    if (m.placed || !m.block || !(m.mat === 'tree' || m.mat === 'bark')) continue;
    const bb = edMeshBB(m); if (bb.maxx < x - r || bb.minx > x + r || bb.maxy < y - r || bb.miny > y + r) continue;
    let t = false;
    for (let b = 0; b + m.block <= m.v.length; b += m.block) {
      const cx = (m.v[b][0] + m.v[b + 1][0]) / 2, cy = (m.v[b][1] + m.v[b + 1][1]) / 2;
      if ((cx - x) ** 2 + (cy - y) ** 2 > r2) continue;
      if (m.v[b][0] === m.v[b + 2][0] && m.v[b][2] === m.v[b + 2][2]) continue;
      const p0 = m.v[b].slice(); for (let k = 0; k < m.block; k++) m.v[b + k] = p0.slice(); t = true;
    }
    if (t) pvSync(m);
  }
}

// ---------- pincel ----------
function obSpecies() {
  const r = Math.random(), sp = OB.species;
  if (sp === 'pino') return 0; if (sp === 'lenga') return r < 0.5 ? 1 : 3; if (sp === 'arbusto') return 2;
  if (sp === 'selva') return r < 0.42 ? 1 : r < 0.84 ? 3 : 2;
  return r < 0.3 ? 0 : r < 0.6 ? 1 : r < 0.85 ? 3 : 2;
}
function obPaintAt(x, y, erase) {
  const r = OB.radius, r2 = r * r;
  if (erase) {
    const before = S.placed.length;
    S.placed = S.placed.filter(o => { if (o.k !== 'tree') return true; const [px, py] = obXY(o); return (px - x) ** 2 + (py - y) ** 2 > r2; });
    if (OB.sel && !S.placed.includes(OB.sel)) OB.sel = null;
    const ll = obLL(x, y), near = S.placed.find(o => o.k === 'clear' && Math.hypot(...(([a, b]) => [a - x, b - y])(obXY(o))) < r * 0.4);
    if (!near) S.placed.push({ k: 'clear', ll, r }); else near.r = Math.max(near.r, r);
    OB.clearXY = S.placed.filter(o => o.k === 'clear').map(o => { const [cx, cy] = obXY(o); return [cx, cy, o.r * o.r]; });
    obClearAuto(x, y, r);
    return S.placed.length !== before || true;
  }
  // densidad: árboles cada 100 m². Se completa lo que falta dentro del círculo, separados al menos 1,6 m
  const want = Math.round(OB.density * Math.PI * r2 / 100), inside = [];
  for (const o of S.placed) if (o.k === 'tree') { const [px, py] = obXY(o); if ((px - x) ** 2 + (py - y) ** 2 < r2) inside.push([px, py]); }
  const road = Core.roadDistFn(S.result.res.segs, true);
  let add = want - inside.length, tries = add * 6;
  while (add > 0 && tries-- > 0) {
    const a = Math.random() * Math.PI * 2, d = r * Math.sqrt(Math.random()), px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
    if (inside.some(q => (q[0] - px) ** 2 + (q[1] - py) ** 2 < 2.6)) continue;
    if (road(px, py, 4) < 0.6) continue; // nunca arriba del camino
    const sp = obSpecies(), hMin = sp === 2 ? 1.2 : OB.hMin, hMax = sp === 2 ? 3 : OB.hMax;
    S.placed.push({ k: 'tree', ll: obLL(px, py), sp, h: +(hMin + Math.random() * (hMax - hMin)).toFixed(1), rot: Math.round(Math.random() * 180) });
    inside.push([px, py]); add--;
  }
  return true;
}

// ---------- interacción ----------
function obHit(ev) {
  const rc = edRay(ev), list = [];
  for (const [m, mesh] of PV.byMesh) if (m.terrain || m.route || m.side || (m.placed && m.mat === 'asphalt')) list.push(mesh);
  const h = rc.intersectObjects(list, false)[0]; return h ? { x: h.point.x, y: -h.point.z, h: h.point.y } : null;
}
function obNear(ev, maxPx) {
  const rect = PV.renderer.domElement.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top, hAt = obGround(); let best = null;
  for (const o of S.placed) {
    if (o.k === 'clear') continue;
    const [x, y] = obXY(o), z = o.k === 'bridge' && o._top != null ? o._top : hAt(x, y) + (o.k === 'tree' ? 1.5 : 0.8), s = edScreen(v3(x, y, z)); if (!s) continue;
    const d = Math.hypot(s.x - mx, s.y - my); if (d < maxPx && (!best || d < best.d)) best = { d, o };
  }
  return best && best.o;
}
function obNew(type, p) {
  const ll = obLL(p.x, p.y), cam = PV.camera.position, yaw = Math.round(Math.atan2(-(cam.z) - p.y, cam.x - p.x) / D2R + 90);
  if (type === 'tree') { const sp = obSpecies(); return { k: 'tree', ll, sp, h: sp === 2 ? 2 : +(OB.hMin + Math.random() * (OB.hMax - OB.hMin)).toFixed(1), rot: Math.round(Math.random() * 180) }; }
  if (type === 'house' || type === 'shed') return { k: type, ll, rot: yaw, s: 1, v: Math.floor(Math.random() * 4) };
  if (type === 'person') return { k: 'person', ll, rot: yaw, s: 1, v: Math.floor(Math.random() * 4) };
  if (type === 'crowd') return { k: 'crowd', ll, rot: yaw, s: 1, n: 12, r: 4 };
  if (type === 'rock') return { k: 'rock', ll, rot: Math.round(Math.random() * 360), s: 1.5 };
  if (type === 'bridge') { // a lo largo del camino si se pone cerca, si no mirando desde la cámara
    const q = edNearestD(p.x, p.y), a = q.dist < 30 ? edAt(q.d) : null;
    return { k: 'bridge', ll, rot: a ? Math.round(Math.atan2(a.T[1], a.T[0]) / D2R) : yaw - 90, len: 24, w: a ? +(a.hw * 2 + 1).toFixed(1) : 7, top: +p.h.toFixed(2), lift: 0 };
  }
  if (type === 'lake') return { k: 'lake', ll, r: 15, depth: 2 };
  return null;
}
OB.onDown = ev => {
  if (ED.tool !== 'place' || !S.result) return false;
  if (OB.type === 'brush' || OB.type === 'erase') {
    const p = obHit(ev); if (!p) return false;
    edPushUndoPlaced(); OB.paint = { erase: OB.type === 'erase' || ev.shiftKey }; obPaintAt(p.x, p.y, OB.paint.erase); obSchedule(); return true;
  }
  if (OB.type === 'select' && OB.sel && obNear(ev, 24) === OB.sel) {
    const [x, y] = obXY(OB.sel), p = obHit(ev); if (!p) return false;
    edPushUndoPlaced(); OB.move = { o: OB.sel, dx: x - p.x, dy: y - p.y, lake0: OB.sel.k === 'lake' ? [x, y, OB.sel.r] : null, moved: false }; return true;
  }
  return false;
};
OB.onMove = ev => {
  if (OB.paint) { const now = performance.now(); if (now - OB.lastPaint < 35) return; OB.lastPaint = now; const p = obHit(ev); if (p) { obPaintAt(p.x, p.y, OB.paint.erase || ev.shiftKey); obSchedule(); obRings(p); } return; }
  if (OB.move) { const p = obHit(ev); if (!p) return; OB.move.o.ll = obLL(p.x + OB.move.dx, p.y + OB.move.dy); if (OB.move.o.k === 'bridge') OB.move.o.top = +p.h.toFixed(2); OB.move.moved = true; obSchedule(); return; }
};
OB.hover = ev => {
  if (ED.tool !== 'place') { if (OB.ring) OB.ring.visible = false; return; }
  const p = (OB.type === 'brush' || OB.type === 'erase' || OB.type === 'lake') ? obHit(ev) : null; obRings(p);
  const near = OB.type === 'select' ? obNear(ev, 24) : null;
  PV.renderer.domElement.style.cursor = near && near === OB.sel ? 'move' : OB.type === 'select' ? (near ? 'pointer' : '') : OB.type === 'brush' || OB.type === 'erase' ? 'crosshair' : 'copy';
};
OB.active = () => !!(OB.paint || OB.move);
OB.onUp = (ev, click) => {
  if (OB.paint) { OB.paint = null; obRefresh(); obPanel(); saveSoon(); return true; }
  if (OB.move) { const mv = OB.move; OB.move = null; if (!mv.moved) { ED.undo.pop(); return true; } if (mv.o.k === 'lake') { const [x, y] = obXY(mv.o); obLakeCommit([mv.lake0, [x, y, mv.o.r]]); } else obRefresh(); obPanel(); saveSoon(); return true; }
  if (!click || ED.tool !== 'place') return false;
  if (OB.type === 'select') { OB.sel = obNear(ev, 24) || null; obRings(); obPanel(); return true; }
  if (OB.type === 'brush' || OB.type === 'erase') return true;
  const p = obHit(ev); if (!p) return true;
  const o = obNew(OB.type, p); if (!o) return true;
  edPushUndoPlaced(); S.placed.push(o); OB.sel = o;
  if (o.k === 'lake') { const [x, y] = obXY(o); obLakeCommit([[x, y, o.r]]); } else obRefresh();
  obPanel(); saveSoon(); return true;
};
OB.del = () => {
  const o = OB.sel; if (!o) return; edPushUndoPlaced(); S.placed.splice(S.placed.indexOf(o), 1); OB.sel = null;
  if (o.k === 'lake') { const [x, y] = obXY(o); obLakeCommit([[x, y, o.r]]); } else obRefresh(); obPanel(); saveSoon();
};
// deshacer: el historial guarda también los objetos
function edPushUndoPlaced() { edPushUndo(); }
const saveSoon = () => {};

// ---------- anillos: pincel y objeto elegido ----------
function obCircle(r, col) {
  const pts = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
  l.renderOrder = 30; return l;
}
function obRings(p) {
  if (!PV.scene || !S.base) return;
  if (p !== undefined) {
    if (OB.ring) { PV.scene.remove(OB.ring); OB.ring = null; }
    if (p && ED.tool === 'place') { const r = OB.type === 'lake' ? 15 : OB.radius; OB.ring = obCircle(r, OB.type === 'erase' || (OB.paint && OB.paint.erase) ? 0xff5c5c : OB.type === 'lake' ? 0x4aa8ff : 0x7cff7c); OB.ring.position.set(p.x, p.h + 0.4, -p.y); PV.scene.add(OB.ring); }
  }
  if (OB.selRing) { PV.scene.remove(OB.selRing); OB.selRing = null; }
  if (OB.sel && ED.tool === 'place' && S.placed.includes(OB.sel)) {
    const o = OB.sel, [x, y] = obXY(o), r = o.k === 'lake' ? o.r : o.k === 'bridge' ? (o.len || 20) / 2 : o.k === 'shed' ? 9 * (o.s || 1) : o.k === 'house' ? 5.5 * (o.s || 1) : o.k === 'crowd' ? (o.r || 4) + 1 : 1.5;
    OB.selRing = obCircle(r, 0x00e5ff); OB.selRing.position.set(x, (o.k === 'bridge' ? o._top : obGround()(x, y)) + 0.3, -y); PV.scene.add(OB.selRing);
  }
}

// ---------- panel ----------
function obPanel(light) {
  if (ED.tool !== 'place' || !$('#vpParams')) return;
  if (light && (OB.paint || OB.move)) { const st = $('#obStats'); if (st) st.textContent = obStats(); return; }
  const t = OB_TYPES.find(q => q[0] === OB.type), o = OB.sel && S.placed.includes(OB.sel) ? OB.sel : null;
  const num = (id, label, val, step, unit, mn, mx) => `<label class="vp-p">${label} <span><input type="number" id="${id}" value="${val}" step="${step}"${mn != null ? ` min="${mn}"` : ''}${mx != null ? ` max="${mx}"` : ''}> ${unit}</span></label>`;
  let html = `<div class="ob-types">${OB_TYPES.map(([k, n, tip]) => `<button class="b${k === OB.type ? ' on' : ''}" data-ob="${k}" title="${tip}">${n}</button>`).join('')}</div><div class="vp-t">${t[2]}</div>`;
  if (OB.type === 'brush' || OB.type === 'tree') {
    html += `<label class="vp-p">Especie <select id="obSp">${Object.entries(OB_SPECIES).map(([k, n]) => `<option value="${k}"${k === OB.species ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`
      + num('obHmin', 'Altura mínima', OB.hMin, 1, 'm', 2, 40) + num('obHmax', 'Altura máxima', OB.hMax, 1, 'm', 2, 45);
  }
  if (OB.type === 'brush' || OB.type === 'erase') html += num('obR', 'Radio del pincel', OB.radius, 1, 'm', 2, 80);
  if (OB.type === 'brush') html += num('obD', 'Densidad', OB.density, 0.5, 'árboles / 100 m²', 0.5, 40) + `<div class="mut">Shift + arrastrar = borrar. Mientras pintás, la cámara se mueve con el botón derecho, la rueda o WASD.</div>`;
  if (o) {
    html += `<div class="vp-e"><b>${OB_NAME[o.k]}</b> <button class="b sm" id="obDel" title="Borrar (Supr)">🗑 Borrar</button></div><div class="mut">Para moverlo: modo "Elegir / mover" y arrastralo.</div>`;
    if (o.k !== 'lake' && o.k !== 'tree') html += `<div class="row"><button class="b sm" data-rot="-15">↺ 15°</button><button class="b sm" data-rot="15">↻ 15°</button></div>` + num('obRot', 'Giro', o.rot || 0, 5, '°');
    if (o.k === 'tree') html += num('obTh', 'Altura', o.h, 0.5, 'm', 0.5, 45) + num('obRot', 'Giro', o.rot || 0, 5, '°');
    if (['house', 'shed', 'person', 'crowd', 'rock'].includes(o.k)) html += num('obS', 'Tamaño', o.s || 1, 0.1, '×', 0.2, 6);
    if (o.k === 'crowd') html += num('obN', 'Personas', o.n || 12, 1, '', 1, 200) + num('obCr', 'Radio del grupo', o.r || 4, 0.5, 'm', 1, 60);
    if (o.k === 'lake') html += num('obLr', 'Radio', o.r, 1, 'm', 3, 300) + num('obLd', 'Profundidad', o.depth || 2, 0.5, 'm', 0.3, 20);
    if (o.k === 'bridge') html += num('obBl', 'Largo', o.len || 24, 1, 'm', 4, 300) + num('obBw', 'Ancho', o.w || 7, 0.5, 'm', 2, 30) + num('obBt', 'Altura de la calzada', ((o.top || 0) + (o.lift || 0) + S.result.h0).toFixed(2), 0.1, 'm');
  }
  html += `<div class="vp-t">Puestos a mano: <span id="obStats">${obStats()}</span></div>
    <div class="row"><button class="b sm" id="obClrT">Borrar árboles puestos</button><button class="b sm" id="obClrZ">Devolver árboles automáticos</button></div>`;
  $('#vpParams').innerHTML = html;
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onchange = () => { const v = parseFloat(el.value); if (isFinite(v)) fn(v, el); }; };
  $('#vpParams').querySelectorAll('[data-ob]').forEach(b => b.onclick = () => { OB.type = b.dataset.ob; obPanel(); obRings(null); });
  const sp = $('#obSp'); if (sp) sp.onchange = () => { OB.species = sp.value; if (sp.value === 'selva') { OB.hMin = 9; OB.hMax = 20; } else if (sp.value === 'arbusto') { OB.hMin = 1.2; OB.hMax = 3; } else if (sp.value === 'pino') { OB.hMin = 8; OB.hMax = 16; } else { OB.hMin = 6; OB.hMax = 13; } obPanel(); };
  on('obHmin', v => { OB.hMin = Math.min(v, OB.hMax); }); on('obHmax', v => { OB.hMax = Math.max(v, OB.hMin); });
  on('obR', v => { OB.radius = Math.max(1, v); }); on('obD', v => { OB.density = Math.max(0.1, v); });
  if (o) {
    const ch = (fn, lake) => v => { edPushUndoPlaced(); const old = obXY(o).concat([o.r]); fn(v); if (lake) obLakeCommit([old, obXY(o).concat([o.r])]); else obRefresh(); obPanel(); };
    $('#obDel').onclick = OB.del;
    $('#vpParams').querySelectorAll('[data-rot]').forEach(b => b.onclick = () => ch(v => { o.rot = ((o.rot || 0) + v) % 360; })(+b.dataset.rot));
    on('obRot', ch(v => { o.rot = v; })); on('obTh', ch(v => { o.h = v; })); on('obS', ch(v => { o.s = v; }));
    on('obN', ch(v => { o.n = Math.round(v); })); on('obCr', ch(v => { o.r = v; }));
    on('obLr', ch(v => { o.r = v; }, true)); on('obLd', ch(v => { o.depth = v; }, true));
    on('obBl', ch(v => { o.len = v; })); on('obBw', ch(v => { o.w = v; })); on('obBt', ch(v => { o.top = v - S.result.h0; o.lift = 0; }));
  }
  $('#obClrT').onclick = () => { edPushUndoPlaced(); S.placed = S.placed.filter(q => q.k !== 'tree'); if (OB.sel && OB.sel.k === 'tree') OB.sel = null; obRefresh(); obPanel(); };
  $('#obClrZ').onclick = () => { if (!S.placed.some(q => q.k === 'clear')) return; edPushUndoPlaced(); S.placed = S.placed.filter(q => q.k !== 'clear'); OB.clearXY = []; log('Las zonas borradas vuelven a tener árboles automáticos al regenerar (botón Generar).'); obPanel(); };
}

// ---------- navegación simple: mapa chico, botones y barra de kilómetros ----------
function obDrawMini() {
  const cv = $('#vmini'), R = S.result; if (!cv || !R || !S.base || R.mode !== 'route' || $('#viewer').style.display === 'none') return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d'), C = R.res.C; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of C) { a = Math.min(a, p[0]); c = Math.max(c, p[0]); b = Math.min(b, p[1]); d = Math.max(d, p[1]); }
  const pad = 12, sc = Math.min((W - 2 * pad) / Math.max(1, c - a), (H - 2 * pad) / Math.max(1, d - b)), ox = (W - (c - a) * sc) / 2, oy = (H - (d - b) * sc) / 2;
  const X = x => ox + (x - a) * sc, Y = y => H - (oy + (y - b) * sc);
  OB.mini = { inv: (px, py) => [a + (px - ox) / sc, b + (H - py - oy) / sc] };
  ctx.strokeStyle = '#ffd200'; ctx.lineWidth = 2.5; ctx.beginPath(); C.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))); ctx.stroke();
  ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.arc(X(C[0][0]), Y(C[0][1]), 4, 0, 7); ctx.fill(); ctx.fillStyle = '#e74c3c'; ctx.beginPath(); ctx.arc(X(C[C.length - 1][0]), Y(C[C.length - 1][1]), 4, 0, 7); ctx.fill();
  let nt = 0; for (const o of S.placed) { if (o.k === 'clear') continue; if (o.k === 'tree' && (nt++ % 4)) continue; const [x, y] = obXY(o); ctx.fillStyle = o.k === 'tree' ? 'rgba(80,200,90,0.8)' : o.k === 'lake' ? '#4aa8ff' : '#ffffff'; ctx.fillRect(X(x) - 1, Y(y) - 1, o.k === 'tree' ? 2 : 4, o.k === 'tree' ? 2 : 4); }
  if (S.sel) { const p = edAt((S.sel.d0 + S.sel.d1) / 2); ctx.strokeStyle = '#00c8ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 6, 0, 7); ctx.stroke(); }
  const t = PV.controls.target, cam = PV.camera.position, dx = t.x - cam.x, dz = t.z - cam.z, L = Math.hypot(dx, dz) || 1;
  const px = X(t.x), py = Y(-t.z), fx = dx / L, fy = -dz / L;            // cámara: hacia dónde mira
  ctx.fillStyle = '#00e5ff'; ctx.beginPath(); ctx.moveTo(px + fx * 10, py - fy * 10); ctx.lineTo(px - fx * 5 - fy * 6, py + fy * 5 - fx * 6); ctx.lineTo(px - fx * 5 + fy * 6, py + fy * 5 + fx * 6); ctx.closePath(); ctx.fill();
}
function obGoto(x, y) {
  const c = PV.controls, cam = PV.camera, h = obGround()(x, y), off = cam.position.clone().sub(c.target), to = new THREE.Vector3(x, h, -y);
  const t0 = c.target.clone(), c0 = cam.position.clone(), c1 = to.clone().add(off), T0 = performance.now();
  const step = () => { const k = Math.min(1, (performance.now() - T0) / 300), s = k * k * (3 - 2 * k); c.target.lerpVectors(t0, to, s); cam.position.lerpVectors(c0, c1, s); if (k < 1) requestAnimationFrame(step); };
  step();
}
(function setupNav() {
  const cv = $('#vmini');
  if (cv) {
    let down = false; const go = ev => { if (!OB.mini) return; const r = cv.getBoundingClientRect(), [x, y] = OB.mini.inv(ev.clientX - r.left, ev.clientY - r.top); obGoto(x, y); };
    cv.addEventListener('pointerdown', ev => { down = true; cv.setPointerCapture(ev.pointerId); go(ev); });
    cv.addEventListener('pointermove', ev => { if (down) go(ev); });
    cv.addEventListener('pointerup', () => { down = false; });
  }
  document.querySelectorAll('#vnav [data-key]').forEach(b => {
    const k = b.dataset.key, stop = () => ED.keys.delete(k);
    b.addEventListener('pointerdown', ev => { ev.preventDefault(); ED.keys.add(k); b.setPointerCapture(ev.pointerId); });
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('pointerleave', stop);
  });
  const view = (dist, h) => { const c = PV.controls, cam = PV.camera, off = cam.position.clone().sub(c.target); off.y = 0; if (off.lengthSq() < 1e-6) off.set(0, 0, 1); off.normalize().multiplyScalar(dist); off.y = h; cam.position.copy(c.target).add(off); };
  const tb = $('#navTop'); if (tb) tb.onclick = () => view(8, 160);
  const gb = $('#navLow'); if (gb) gb.onclick = () => view(14, 3.5);
  const km = $('#navKm');
  if (km) km.oninput = () => { const r = edR(); if (!r) return; const d = +km.value / 1000 * r.total; edFly(d); $('#navKmTxt').textContent = (d / 1000).toFixed(2) + ' km'; };
  let n = 0; const prev = PV.onFrame; PV.onFrameOB = () => { if (++n % 6 === 0) obDrawMini(); };
})();

// textura de personas: 4 espectadores con ropa distinta, fondo transparente (se usa con planos cruzados)
TEX.people = (() => {
  const W = 512, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  const looks = [['#c0392b', '#2c3e50', '#f1c27d'], ['#2e86de', '#3d3d3d', '#e0ac69'], ['#f39c12', '#1e3799', '#c68642'], ['#27ae60', '#4a4a4a', '#ffdbac']];
  looks.forEach(([shirt, pants, skin], i) => {
    const cx = i * 128 + 64, s = H / 1.75 / 100; // 1 px = 1 cm aprox.
    const R = (x0, y0, w, h, col) => { x.fillStyle = col; x.fillRect(cx + x0 * s, H - (y0 + h) * s, w * s, h * s); };
    R(-14, 0, 12, 82, pants); R(2, 0, 12, 82, pants);                  // piernas
    R(-17, 0, 15, 5, '#222'); R(2, 0, 15, 5, '#222');                  // zapatillas
    R(-20, 80, 40, 62, shirt);                                         // torso
    R(-27, 88, 8, 52, shirt); R(19, 88, 8, 52, shirt);                 // brazos
    R(-27, 82, 8, 8, skin); R(19, 82, 8, 8, skin);                     // manos
    x.fillStyle = skin; x.beginPath(); x.ellipse(cx, H - 156 * s, 11 * s, 13 * s, 0, 0, 7); x.fill();   // cabeza
    x.fillStyle = i % 2 ? '#3b2a1a' : '#1b1b1b'; x.beginPath(); x.ellipse(cx, H - 164 * s, 11.5 * s, 7 * s, 0, Math.PI, 0); x.fill();  // pelo / gorra
  });
  return c;
})();
TEXDEF.people = { col: [150, 120, 100], amp: 0 };
