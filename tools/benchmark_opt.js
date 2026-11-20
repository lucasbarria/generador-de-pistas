// Benchmark reproducible de geometría (sin navegador). Uso: node tools/benchmark_opt.js [salida.json]
// Pista SINTÉTICA de referencia (no ubicación real): 2,7 km, curvas 25-150 m, pendientes, cunetas y costados Río Grande.
// Mide Core.buildRoute real extraído de src/core.js. No inventa tiempos: usa performance.now().
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'core.js'), 'utf8').replace(/if \(typeof module !== 'undefined'\) module\.exports = Core;/, '');
const Core = new Function(src + '\nreturn Core;')();
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'parametros_fisicos.json'), 'utf8'));
const geo = cfg.geometria || {}, BORDES = geo.bordes_rio_grande || {}, CUN5 = geo.cunetas_v5 || {}, TAL = geo.taludes || {};
const opts = { bordes: BORDES, cun5: CUN5, tal: TAL && TAL.activo ? { ...TAL, fp: () => 0 } : null };
// traza determinista
const pts = []; let x = 0, y = 0;
for (let d = 0; d <= 2700; d += 20) { const h = Math.sin(d / 180) * 0.55 + Math.sin(d / 70) * 0.13; pts.push([x, y]); x += Math.cos(h) * 20; y += Math.sin(h) * 20; }
const height = (px, py) => 100 + 8 * Math.sin(px / 220) + 3 * Math.sin(py / 95);
const base = { pts, height, width: 6, hSmooth: 12, ditch: 'auto', humAt: d => 0.3 + 0.25 * Math.sin(d / 210), forestAt: d => 0.4 + 0.3 * Math.sin(d / 330), ...opts, procAccess: false };
const med = a => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
const t = fn => { const v = []; for (let k = 0; k < 3; k++) { const t0 = performance.now(); const r = fn(); v.push([performance.now() - t0, r]); } return { ms: +med(v.map(q => q[0])).toFixed(2), result: v[2][1] }; };
const hash = o => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const full = t(() => Core.buildRoute({ ...base, cache: { keyFn: () => 'base' } }));
const cache = { keyFn: () => 'base' };
Core.buildRoute({ ...base, cache }); // calienta geometría en planta
const edit = t(() => Core.buildRoute({ ...base, cache, offsetAt: d => d > 1200 && d < 1300 ? 0.5 : 0 }));
const prof = t(() => Core.buildRoute({ ...base, cache, profileOnly: true }));
const r = full.result, verts = r.meshes.reduce((a, m) => a + m.v.length, 0), faces = r.meshes.reduce((a, m) => a + m.f.length, 0);
const uvOk = r.meshes.every(m => m.uv && m.uv.length === m.v.length);
const out = { pista: 'sintetica_2k7_curvas', longitud_m: +r.total.toFixed(1), puntos_eje: r.n, mallas: r.meshes.length, vertices: verts, caras: faces, uv_ok: uvOk,
  build_ms: full.ms, edit_ms: edit.ms, profile_ms: prof.ms,
  hash_geometria: hash([r.C, r.hs, r.W, r.SL, r.SURF]), hash_mallas: hash(r.meshes.map(m => [m.v.length, m.f.length, m.mat])),
  materiales: [...new Set(r.meshes.map(m => m.mat))].sort() };
const dest = process.argv[2] && path.resolve(process.argv[2]);
if (dest) fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
