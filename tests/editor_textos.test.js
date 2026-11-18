// Prueba (node tests/editor_textos.test.js): los textos del panel "Cambios cercanos" no muestran NaN/undefined para ningún tipo de cambio,
// y los cambios fuera del tramo se recortan o se borran. Extrae las funciones reales de src/ (sin copiar código).
const fs = require('fs'), path = require('path'), src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const ed = src('editor3d.js'), app = src('app.js');
const grab = (code, start) => { const i = code.indexOf(start); if (i < 0) throw new Error('no encuentro ' + start); let d = 0, j = code.indexOf('{', i); for (; j < code.length; j++) { if (code[j] === '{') d++; else if (code[j] === '}' && --d === 0) break; } return code.slice(i, j + 1); };
const RAS_NAME = { cresta: 'Cresta', valle: 'Valle', compresion: 'Compresión', depresion: 'Depresión', ondulacion: 'Ondulaciones' };
const SURF = { GRAVEL: { name: 'Ripio' }, MUD: { name: 'Barro' } }, D2R = Math.PI / 180, fmtG = g => (g * 100).toFixed(1) + ' %';
const S = { edits: [] }, logs = [], log = (m) => logs.push(m);
const fmtH = h => (h > 0 ? '+' : '') + (+h.toFixed(2));
const ctx = { RAS_NAME, SURF, D2R, fmtG, fmtH, S, log, Math, isFinite, JSON };
const code = `${grab(app, 'const EDIT_TXT = {')};\n${grab(ed, 'function edExtent(e)')}\n${grab(ed, 'function edTransInfo(e)')}\n${grab(ed, 'function edClampToRoute(T, closed)')}\nreturn { EDIT_TXT, edTransInfo, edClampToRoute, edExtent };`;
const F = new Function(...Object.keys(ctx), code)(...Object.values(ctx));
const casos = [
  { kind: 'surface', d0: 2710, d1: 2760, key: 'MUD' }, { kind: 'raise', d0: 100, d1: 100, h: 1 }, { kind: 'raise', d0: 100, d1: 300, h: 1, h1: 3 }, { kind: 'raise', d0: 100, d1: 300, h: 2 },
  { kind: 'bump', d: 50, h: 0.5, len: 10 }, { kind: 'pothole', d: 50, h: 0.3, len: 6 }, { kind: 'jump', d: 60, h: 1.2, len: 24, land: 8 }, { kind: 'smooth', d0: 0, d1: 50 },
  { kind: 'ruts', d0: 500, d1: 600, D: 0.14, rw: 0.23, sep: 1.56, irr: 0.4, ramp: 15 }, { kind: 'ruts', d0: 500, d1: 600 }, { kind: 'width', d0: 10, d1: 40, w: 6 },
];
let mal = 0;
for (const e of casos) { const t = (F.EDIT_TXT[e.kind] ? F.EDIT_TXT[e.kind](e) : '') + ' · ' + F.edTransInfo(e); if (/NaN|undefined/.test(t)) { mal++; console.log('MAL', e.kind, '→', t); } else console.log('ok ', e.kind.padEnd(8), t); }
// cambios fuera del tramo (2,67 km): el de barro 2,71–2,76 km se borra; uno que cruza el final se recorta
S.edits = [{ kind: 'surface', d0: 2710, d1: 2760, key: 'MUD' }, { kind: 'surface', d0: 2600, d1: 2760, key: 'MUD' }, { kind: 'bump', d: 2700, h: 0.5, len: 10 }, { kind: 'ruts', d0: 100, d1: 200 }];
const r = F.edClampToRoute(2671.6, false);
const okClamp = r.borrados.length === 2 && r.cortados.length === 1 && S.edits.length === 2 && Math.abs(S.edits[0].d1 - 2671.6) < 1e-6;
console.log(okClamp ? 'ok  recorte: ' : 'MAL recorte: ', JSON.stringify(r), JSON.stringify(S.edits));
if (mal || !okClamp) { console.log(`\nFALLÓ (${mal} textos con NaN${okClamp ? '' : ', recorte mal'})`); process.exit(1); } console.log('\nOK: sin NaN en los textos y cambios fuera del tramo recortados/borrados');
