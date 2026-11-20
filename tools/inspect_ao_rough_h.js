// Verificación local de canales de los PNG *_ao_rough_h.png del preset Río Grande.
// No modifica archivos ni inventa un contrato: solo muestra estadísticas reales de R/G/B/A.
// Uso: node tools/inspect_ao_rough_h.js [archivo.png ...]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('No es PNG: ' + file);
  let off = 8, ihdr = null, idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) throw new Error('CRC inválido en ' + type + ': ' + file);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error('Se espera PNG 8 bit sin interlazar: ' + file);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error('Color type PNG no soportado (' + ihdr.color + '): ' + file);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const out = Buffer.alloc(ihdr.height * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (y > 0 && x >= channels) ? out[(y - 1) * stride + x - channels] : 0;
      let r;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      } else throw new Error('Filtro PNG desconocido ' + filter + ': ' + file);
      out[y * stride + x] = r & 255;
    }
  }
  return { width: ihdr.width, height: ihdr.height, channels, color: ihdr.color, data: out };
}

function stats(img) {
  const n = img.width * img.height;
  const names = ['R', 'G', 'B', 'A'].slice(0, img.channels);
  const res = names.map(name => ({ name, min: 255, max: 0, sum: 0, sumSq: 0 }));
  const vectors = res.map(() => new Float64Array(n));
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < img.channels; c++) {
      const v = img.data[p * img.channels + c];
      const s = res[c];
      s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.sumSq += v * v;
      vectors[c][p] = v;
    }
  }
  for (const s of res) {
    const mean = s.sum / n;
    s.mean = +mean.toFixed(2);
    s.std = +Math.sqrt(Math.max(0, s.sumSq / n - mean * mean)).toFixed(2);
    delete s.sum; delete s.sumSq;
  }
  function corr(i, j) {
    const a = vectors[i], b = vectors[j];
    if (!a || !b) return null;
    const ma = res[i].mean, mb = res[j].mean;
    let num = 0, da = 0, db = 0;
    for (let p = 0; p < n; p++) { const x = a[p] - ma, y = b[p] - mb; num += x * y; da += x * x; db += y * y; }
    return +(num / Math.sqrt(da * db || 1)).toFixed(3);
  }
  return { width: img.width, height: img.height, channels: names.join(''), stats: res, corr: { 'R-G': corr(0, 1), 'R-B': corr(0, 2), 'G-B': corr(1, 2) } };
}

const dir = path.join(__dirname, '..', 'presets', 'pisos', 'ripio_rio_grande', 'texturas');
const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync(dir).filter(n => /_ao_rough_h\.png$/i.test(n)).map(n => path.join(dir, n));
let failed = false;
for (const f of files) {
  try {
    const img = decodePng(f);
    const s = stats(img);
    console.log(JSON.stringify({ file: path.relative(process.cwd(), f), ...s }));
  } catch (e) { failed = true; console.error('ERROR ' + f + ': ' + e.message); }
}
if (failed) process.exitCode = 1;
