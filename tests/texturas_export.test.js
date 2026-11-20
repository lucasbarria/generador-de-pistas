// node tests/texturas_export.test.js — extrae las funciones reales de src/app.js (sin copiar código) y
// comprueba que un píxel transparente no quede negro en DXT1 y que el horneado RBR nunca devuelva negro.
const fs = require('fs'), path = require('path'), app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const grab = start => { const i = app.indexOf(start); if (i < 0) throw new Error('no encuentro ' + start); let d = 0, j = app.indexOf('{', i); for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; } return app.slice(i, j + 1); };
const TEX = {}, DETAIL = { terrain: () => DETAIL.T };
const raw = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const q = f(i); for (let c = 0; c < 4; c++) d[i * 4 + c] = q[c]; } return { width: w, height: w, w, h, __raw: d }; };
// canvas mínimo para que ddsToCanvas pueda ejecutarse en Node (sólo validación y píxeles)
global.document = { createElement: () => { const c = { width: 0, height: 0 }; c.getContext = () => ({ createImageData: (W, H) => (c._img = { data: new Uint8ClampedArray(W * H * 4) }), putImageData: () => { } }); return c; } };
const code = [grab('function bleedRGB('), grab('function dxt1Encode('), grab('function dxt5Encode('), grab('function rgbaToDDS('), app.match(/const rbrPow2 = [^\n]+/)[0], grab('function rgbaOf('), grab('function rgbaResize('), grab('function rbrBakeChan('), grab('function ddsToCanvas(')].join('\n') + '\nreturn { rgbaToDDS, ddsToCanvas, rbrBakeChan };';
const F = new Function('TEX', 'DETAIL', code)(TEX, DETAIL);
let fallos = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'MAL ') + m); if (!c) fallos++; };
// 1) DXT1 con un píxel transparente negro: el color debe sangrar desde el vecino
const img = raw(4, 4, i => i === 0 ? [0, 0, 0, 0] : [240, 240, 240, 255]).__raw;
const dds = F.rgbaToDDS(img, 4, 4, false);
ok(dds[84] === 0x44 && dds[85] === 0x58 && dds[86] === 0x54 && dds[87] === 0x31, 'DDS DXT1');
const c1 = dds[130] | (dds[131] << 8), g1 = ((c1 >> 5) & 63), b1 = (c1 & 31);
ok(g1 > 50 && b1 > 25, `DXT1 sin negro bajo el alfa (endpoint oscuro ${c1.toString(16)})`);
// 2) horneado RBR sin máscara: devuelve la base
TEX.base = raw(4, 4, () => [200, 100, 50, 255]); TEX.mk_base = null;
const bake1 = F.rbrBakeChan('base', {});
ok(bake1.d[0] >= 190 && bake1.d[1] >= 90 && bake1.d[2] >= 40, 'RBR sin máscara conserva la base');
// 3) horneado con máscara vacía y detalles negros: nunca negro
TEX.mk_base = raw(4, 4, () => [0, 0, 0, 0]);
DETAIL.T = { R: raw(4, 4, () => [0, 0, 0, 255]), G: DETAIL.T && DETAIL.T.R, B: raw(4, 4, () => [0, 0, 0, 255]), A: raw(4, 4, () => [0, 0, 0, 255]) };
DETAIL.T.G = DETAIL.T.R;
const bake2 = F.rbrBakeChan('base', {});
ok(bake2.d[0] >= 150 && bake2.d[1] >= 75 && bake2.d[2] >= 37, `RBR con máscara vacía no ennegrece (${bake2.d[0]},${bake2.d[1]},${bake2.d[2]})`);
// 4) ida y vuelta DDS: el píxel que era transparente-negro debe decodificarse claro
const round = F.ddsToCanvas(dds.buffer.slice(0));
ok(round._img && round._img.data[1] > 200 && round._img.data[2] > 200, 'DDS ida y vuelta: sin píxel negro bajo el alfa');
// 5) archivos corruptos: mensajes claros en vez de RangeError
let msg = ''; try { F.ddsToCanvas(new ArrayBuffer(64)); } catch (e) { msg = e.message; }
ok(/cabecera incompleta/.test(msg), 'DDS cortado: error explícito');
const mal = new ArrayBuffer(128), md = new DataView(mal); md.setUint32(0, 0x20534444, true); md.setUint32(12, 20000, true); md.setUint32(16, 20000, true);
msg = ''; try { F.ddsToCanvas(mal); } catch (e) { msg = e.message; }
ok(/dimensiones/.test(msg), 'DDS con dimensiones imposibles: error explícito');
console.log(fallos ? `\nFALLÓ (${fallos})` : '\nOK: texturas/exportación');
process.exit(fallos ? 1 : 0);
