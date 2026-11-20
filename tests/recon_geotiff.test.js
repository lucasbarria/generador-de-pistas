// Pruebas técnicas con rasters SINTÉTICOS generados en memoria.
// NO son datos geográficos reales: solo validan lectura, CRS, unidades y NoData.
const test = require('node:test');
const assert = require('node:assert/strict');

// geotiff.js espera Worker/self en el bundle browser; en Node los proveemos antes de exigirlo.
if (typeof globalThis.Worker === 'undefined') globalThis.Worker = class { constructor() { throw new Error('worker no disponible'); } };
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

const G = require('../src/vendor/geotiff.js');
const P = require('../src/vendor/proj4.js');
const M = require('../src/recon/model.js');
const R = require('../src/recon/geotiff.js');

function directory(entries) {
  return [1, 1, 0, entries.length, ...entries.flatMap(([id, value]) => [id, 0, 1, value])];
}

async function syntheticTiff(values, width, height, opts) {
  const o = opts || {};
  const metadata = {
    width, height,
    // geotiff.js writeArrayBuffer es beta y escribe uint8; los datos sintéticos se eligen dentro de 0..255.
    ModelPixelScale: [o.scale || 0.001, o.scale || 0.001, 0],
    ModelTiepoint: [0, 0, 0, o.originX, o.originY, 0],
    GeoKeyDirectory: directory(o.keys),
    GeographicTypeGeoKey: o.keys.find(k => k[0] === 2048 || k[0] === 3072)[1],
  };
  if (o.nodata !== undefined) metadata.GDAL_NODATA = String(o.nodata);
  const buffer = await G.writeArrayBuffer(values, metadata);
  return buffer;
}

const GEO_KEYS_M = directory([[2048, 4326], [2054, 9102], [4099, 9001]]);
const PROJ_KEYS_M = directory([[3072, 32619], [3076, 9001], [4099, 9001]]);
const GEO_KEYS_FT = directory([[2048, 4326], [2054, 9102], [4099, 9002]]);
const UNKNOWN_KEYS = directory([[2048, 32767], [4099, 9001]]);

test('GeoTIFF geográfico sintético: dimensiones, CRS, unidades, NoData y muestreo con procedencia', async () => {
  // 5x5, SYNTHETIC TEST DATA: elevaciones 100..124 m, con 255 (NoData) en el centro.
  const values = Array.from({ length: 25 }, (_, i) => (i === 12 ? 255 : 100 + i));
  const buffer = await syntheticTiff(values, 5, 5, { keys: [[2048, 4326], [2054, 9102], [4099, 9001]], originX: -67.245, originY: -54.626, scale: 0.001, nodata: 255 });
  const imported = await R.openGeoTIFF(buffer, { filename: 'SINTETICO_geo.tif', obtainedAt: '2026-11-20T00:00:00Z' });
  assert.equal(imported.meta.width, 5);
  assert.equal(imported.meta.height, 5);
  assert.equal(imported.meta.crs.code, 'EPSG:4326');
  assert.equal(imported.meta.horizontalUnits.label, 'degree');
  assert.equal(imported.meta.verticalUnits.label, 'metre');
  assert.equal(imported.meta.nodata.value, 255);
  assert.equal(imported.meta.resolution.meters > 0, true);
  assert.equal(imported.meta.quality.suitableForRoadDetail, false);
  assert.ok(imported.meta.quality.warnings.some(w => /cunetas/i.test(w)));

  // El punto del centro cae exactamente en NoData; el de al lado no.
  // 2.4 celdas para que nearest elija la fila/columna 2; 2.5 redondearía hacia arriba.
  const centerLon = -67.245 + 2.4 * 0.001;
  const centerLat = -54.626 - 2.4 * 0.001;
  const nearLon = -67.245 + 3.4 * 0.001;
  const nearLat = -54.626 - 1.4 * 0.001;
  const result = await R.sampleRaster(imported, [[centerLat, centerLon], [nearLat, nearLon], [0, 0]], { interpolation: 'nearest' });
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].elevation, 100 + 8);
  assert.equal(result.samples[0].provenance, 'measured');
  assert.equal(result.samples[0].source.kind, 'geotiff');
  assert.equal(result.samples[0].source.verticalUnits, 'metre');
  assert.equal(result.missing.length, 2);
  assert.ok(result.missing.some(m => /NoData/.test(m.reason)));
  assert.ok(result.missing.some(m => /fuera de la extensión/.test(m.reason)));
  assert.match(R.rasterSummary(imported.meta), /SINTETICO_geo\.tif/);
});

test('GeoTIFF proyectado UTM: transforma coordenadas y respeta unidades lineales', async () => {
  const scale = 30;
  // proj4 usa el orden [longitud, latitud]; los datos SYNTETIC TEST DATA no son geografía real.
  const centerWorld = P('EPSG:4326', 'EPSG:32619', [-67.2432701, -54.6266558]);
  const originX = centerWorld[0] - 2.5 * scale;
  const originY = centerWorld[1] + 2.5 * scale;
  const values = Array.from({ length: 25 }, (_, i) => 200 + i);
  const buffer = await syntheticTiff(values, 5, 5, { keys: [[3072, 32619], [3076, 9001], [4099, 9001]], originX, originY, scale });
  const imported = await R.openGeoTIFF(buffer, { filename: 'SINTETICO_utm.tif' });
  assert.equal(imported.meta.crs.kind, 'projected');
  assert.equal(imported.meta.crs.code, 'EPSG:32619');
  assert.equal(imported.meta.horizontalUnits.label, 'metre');
  assert.equal(imported.meta.resolution.meters, 30);
  const q = R.worldToPixel(imported.handle, -54.6266558, -67.2432701);
  assert.ok(Math.abs(q.px - 2.5) < 1e-6, 'px=' + q.px);
  assert.ok(Math.abs(q.py - 2.5) < 1e-6, 'py=' + q.py);
  const r = await R.sampleRaster(imported, [[-54.6266558, -67.2432701]], { interpolation: 'nearest' });
  assert.equal(r.samples.length, 1);
  // nearest redondea 2.5 → 3, así que cae en la celda (3,3): valor 218 del raster sintético.
  assert.equal(r.samples[0].elevation, 218);
  assert.equal(r.samples[0].source.crs, 'EPSG:32619');
});

test('CRS no identificada: no se asume EPSG:4326 y baja la confianza', async () => {
  const values = Array.from({ length: 4 }, (_, i) => 1 + i);
  const buffer = await syntheticTiff(values, 2, 2, { keys: [[2048, 32767], [4099, 9001]], originX: -67.2, originY: -54.6 });
  const imported = await R.openGeoTIFF(buffer, { filename: 'SINTETICO_sin_crs.tif' });
  assert.equal(imported.meta.crs.code, null);
  assert.equal(imported.meta.crs.known, false);
  assert.equal(imported.meta.quality.confidence, 0.4);
  assert.ok(imported.meta.quality.warnings.some(w => /no declara CRS/i.test(w)));
  const r = await R.sampleRaster(imported, [[-54.6, -67.2]]);
  assert.equal(r.samples.length, 0);
  assert.match(r.missing[0].reason, /no convertible/);
  const overridden = await R.openGeoTIFF(buffer, { filename: 'SINTETICO_sin_crs.tif', crsOverride: 'EPSG:4326' });
  assert.equal(overridden.meta.crs.userOverride, true);
  assert.ok(overridden.meta.quality.warnings.some(w => /usuario/.test(w)));
});

test('Unidades verticales en pies: se convierten a metros y se declara la conversión', async () => {
  const values = Array.from({ length: 4 }, (_, i) => 100 + i);
  const buffer = await syntheticTiff(values, 2, 2, { keys: [[2048, 4326], [2054, 9102], [4099, 9002]], originX: -67.2, originY: -54.6 });
  const imported = await R.openGeoTIFF(buffer, { filename: 'SINTETICO_pies.tif' });
  assert.equal(imported.meta.verticalUnits.label, 'foot');
  const r = await R.sampleRaster(imported, [[-54.6005, -67.1995]], { interpolation: 'nearest' });
  assert.equal(r.samples.length, 1);
  assert.ok(Math.abs(r.samples[0].elevation - 101 * 0.3048) < 1e-9);
  assert.equal(r.samples[0].source.verticalUnits, 'foot');
});

test('Perfil longitudinal y adjunción al proyecto conservan resolución y procedencia', async () => {
  const values = Array.from({ length: 9 }, (_, i) => 100 + i * 2);
  const buffer = await syntheticTiff(values, 3, 3, { keys: [[2048, 4326], [2054, 9102], [4099, 9001]], originX: -67.244, originY: -54.627 });
  const imported = await R.openGeoTIFF(buffer, { filename: 'SINTETICO_perfil.tif', obtainedAt: '2026-11-19T12:00:00Z' });
  const coords = [];
  // Las coordenadas enteras de píxel son los centros de celda en GeoTIFF: bilinear devuelve el valor exacto.
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) coords.push([-54.627 - row * 0.001, -67.244 + col * 0.001]);
  const r = await R.sampleRaster(imported, coords, { interpolation: 'bilinear' });
  assert.equal(r.samples.length, 9);
  const profile = R.profileFromSamples(r.samples);
  assert.ok(profile.lengthMeters > 400);
  assert.ok(Math.abs(profile.dropMeters - 16) < 1e-6, 'drop=' + profile.dropMeters);
  assert.equal(profile.stations.length, 9);

  const p = M.blankProject({ name: 'Prueba técnica (sintética)' });
  const attached = R.attachRaster(p, imported, r.samples, { changeLabel: 'carga técnica' });
  assert.equal(attached.samples, 9);
  assert.equal(p.elevation.provider, 'geotiff-local');
  assert.equal(p.elevation.resolutionMeters, imported.meta.resolution.meters);
  assert.equal(p.elevation.rasters.length, 1);
  assert.equal(p.elevation.geographicBase.layer, 'geographic-base');
  assert.equal(p.elevation.geographicBase.detailSeparated, true);
  const loaded = M.normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(loaded.elevation.rasters[0].crs.code, 'EPSG:4326');
  assert.equal(loaded.elevation.samples[0].source.kind, 'geotiff');
  assert.equal(loaded.elevation.samples[0].provenance, 'measured');
  assert.ok(Math.abs(loaded.elevation.samples[0].elevation - 100) < 1e-6);
  assert.equal(loaded.elevation.resolutionMeters, p.elevation.resolutionMeters);
});
