const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'docs', 'manifiesto_canales_ao_rough_h.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('manifiesto de *_ao_rough_h: evidencia medida, semántica desconocida, sin PBR', () => {
  assert.equal(manifest.schema, 'ao-rough-h-channel-manifest');
  assert.equal(manifest.semantics.status, 'unknown');
  assert.equal(manifest.semantics.measuredNotAssumed, true);
  assert.equal(manifest.export.pbrClaimed, false);
  assert.equal(manifest.export.aoRoughnessMetalnessSlots, false);
  assert.equal(manifest.export.roleInGenerator, 'none');
  assert.equal(manifest.consumption.mode, 'diagnostic-only');
  assert.equal(manifest.files.length, 4);
  const texturas = path.join(root, 'presets', 'pisos', 'ripio_rio_grande', 'texturas');
  for (const f of manifest.files) {
    const file = path.join(texturas, f.file);
    assert.ok(fs.existsSync(file), 'falta el PNG real ' + f.file);
    assert.equal(fs.statSync(file).size, f.bytes);
    assert.equal(f.colorType, 'RGB');
    assert.equal(f.width, 1024);
    assert.equal(f.height, 1024);
    assert.equal(f.channels.length, 3);
    assert.deepEqual(f.channels.map(c => c.name), ['R', 'G', 'B']);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
});

test('el generador solo mide los mapas: no crea slots AO/roughness/metalness', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
  assert.match(app, /AO_ROUGH_MANIFEST = \/\*AO_MANIFEST\*\/null/);
  assert.match(app, /reportAoRoughH\(got\)/);
  assert.doesNotMatch(app, /\baoMap\s*[:=]|\broughnessMap\s*[:=]|\bmetalnessMap\s*[:=]/);
  const build = fs.readFileSync(path.join(root, 'build.py'), 'utf8');
  assert.match(build, /AO_MANIFEST/);
});
