const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../src/recon/model.js');
const F = require('../src/recon/formats.js');
const D = require('../src/recon/dem.js');
const P = require('../src/recon/photos.js');
const N = require('../src/recon/networks.js');

test('piloto Aguas Blancas: ancla real OSM y ningún recorrido inventado', () => {
  const p = M.aguasBlancasSeed();
  assert.equal(p.schema, 'recon-project');
  assert.equal(p.version, 1);
  assert.equal(p.stage.anchor.lat, -54.6266558);
  assert.equal(p.stage.anchor.lon, -67.2432701);
  assert.match(p.stage.anchor.source.url, /openstreetmap\.org\/node\/6987631224/);
  assert.equal(p.stage.anchor.provenance, M.PROVENANCE.MEASURED);
  assert.equal(p.route.points.length, 0);
  assert.equal(p.route.status, M.ROUTE_STATUS.UNSET);
  const issues = M.validateProject(p);
  assert.ok(issues.some(x => /recorrido/.test(x)));
  assert.ok(issues.some(x => /elevación/.test(x)));
  assert.match(p.stage.notes, /no se inventa/i);
});

test('GPX: conserva decimales originales, altura y procedencia del archivo', () => {
  const gpx = `<?xml version="1.0"?>
  <gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Aguas Blancas</name><trkseg>
  <trkpt lat="-54.626655812345678" lon="-67.243270198765432"><ele>812.5</ele><time>2026-11-20T12:00:00Z</time></trkpt>
  <trkpt lat="-54.6267812" lon="-67.2433999"><ele>813.25</ele></trkpt>
  <trkpt lat="91" lon="0"/><trkpt lat="-54.6269" lon="-67.2435"/>
  </trkseg></trk></gpx>`;
  const parsed = F.parseRouteText(gpx, 'tramo.gpx');
  assert.equal(parsed.format, 'gpx');
  assert.equal(parsed.routes.length, 1);
  assert.equal(parsed.routes[0].name, 'Aguas Blancas');
  assert.equal(parsed.routes[0].points[0].lat, -54.626655812345678);
  assert.equal(parsed.routes[0].points[0].lon, -67.243270198765432);
  assert.equal(parsed.routes[0].points[0].ele, 812.5);
  assert.equal(parsed.routes[0].points[0].time, '2026-11-20T12:00:00Z');
  assert.equal(parsed.routes[0].points.length, 3);
  assert.equal(parsed.warnings.length, 1);
  const p = M.blankProject();
  M.setRoute(p, parsed.routes[0].points, { kind: 'gpx-file', filename: 'tramo.gpx', provenance: M.PROVENANCE.MEASURED });
  assert.equal(p.route.points[0].lat, -54.626655812345678);
  assert.equal(p.route.points[0].provenance, M.PROVENANCE.MEASURED);
  assert.equal(p.route.status, M.ROUTE_STATUS.IMPORTED);
  assert.deepEqual(F.toLegacyPath([p.route.points[0]]), ['f:' + Number(-54.626655812345678) + ',' + Number(-67.243270198765432)]);
});

test('KML: interpreta lon,lat,alt y separa varias LineString', () => {
  const kml = `<kml><Document>
    <Placemark><LineString><coordinates>-67.2432701,-54.6266558,120.5 -67.2433,-54.6267,121.25</coordinates></LineString></Placemark>
    <Placemark><LineString><coordinates>-67.25,-54.63,1 -67.26,-54.64,2 -67.27,-54.65,3</coordinates></LineString></Placemark>
  </Document></kml>`;
  const parsed = F.parseRouteText(kml, 'tramo.kml');
  assert.equal(parsed.format, 'kml');
  assert.equal(parsed.routes.length, 2);
  assert.equal(parsed.primary, 1);
  assert.equal(parsed.routes[0].points[0].lat, -54.6266558);
  assert.equal(parsed.routes[0].points[0].lon, -67.2432701);
  assert.equal(parsed.routes[0].points[0].ele, 120.5);
});

test('proyecto: guardar y recuperar conserva procedencia, elevación y precisión', () => {
  const p = M.aguasBlancasSeed();
  M.setRoute(p, [[-54.626655812345678, -67.243270198765432, 812.5], [-54.6267, -67.2433, 813]],
    { kind: 'gpx-file', filename: 'real.gpx', provenance: M.PROVENANCE.MEASURED });
  M.setElevationSamples(p, [
    { lat: -54.626655812345678, lon: -67.243270198765432, elevation: 812.5, source: { provider: 'open-meteo' } },
    { lat: -54.6267, lon: -67.2433, elevation: 813, source: { provider: 'open-meteo' } },
  ], { provider: 'open-meteo', dataset: 'Copernicus DEM GLO-90', resolutionMeters: 90 });
  M.addPhoto(p, { provider: 'commons', url: 'https://example.test/a.jpg', license: 'CC BY 4.0', visualVerified: false });
  M.addChange(p, { kind: 'elevation-import', detail: '90 m' });
  const saved = JSON.parse(JSON.stringify(p));
  const loaded = M.normalizeProject(saved);
  assert.equal(loaded.route.points[0].lat, -54.626655812345678);
  assert.equal(loaded.route.points[0].provenance, M.PROVENANCE.MEASURED);
  assert.equal(loaded.elevation.resolutionMeters, 90);
  assert.equal(loaded.elevation.samples[0].elevation, 812.5);
  assert.equal(loaded.elevation.samples[0].provenance, M.PROVENANCE.MEASURED);
  assert.equal(loaded.photos.length, 1);
  assert.equal(loaded.photos[0].visualVerified, false);
  assert.equal(loaded.changes[0].reversible, true);
  assert.deepEqual(M.validateProject(loaded), []);
  assert.ok(M.summary(loaded).includes('0.01 km') || M.summary(loaded).includes(' km'));
});

test('proyectos anteriores del generador se convierten sin perder procedencia declarada', () => {
  const p = M.blankProject();
  const pts = [[-54.6266558, -67.2432701], [-54.6267, -67.2433]];
  const legacy = { routeGeom: pts, path: pts.map(x => 'f:' + x[0] + ',' + x[1]), gps: null, wps: [] };
  assert.equal(M.syncRouteFromLegacy(p, legacy), true);
  assert.equal(p.route.points[0].lat, -54.6266558);
  assert.equal(p.route.source.provenance, M.PROVENANCE.OBSERVED);
  assert.equal(M.syncRouteFromLegacy(p, legacy), false, 'un refresco igual no debe pisar la fuente');
  assert.equal(p.route.source.provenance, M.PROVENANCE.OBSERVED);
  const withGps = M.blankProject();
  M.syncRouteFromLegacy(withGps, { routeGeom: pts, gps: pts }, { kind: 'gpx-file', provenance: M.PROVENANCE.MEASURED });
  assert.equal(withGps.route.source.provenance, M.PROVENANCE.MEASURED);
});

test('DEM: usa lotes de 100, declara procedencia y cachea respuestas reales', async () => {
  const calls = [];
  const pts = Array.from({ length: 101 }, (_, i) => ({ lat: -54.6266 - i * 0.0001, lon: -67.2432 }));
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url);
    const lats = u.searchParams.get('latitude').split(',');
    return { ok: true, status: 200, text: async () => JSON.stringify({ elevation: lats.map((_, i) => 800 + i) }) };
  };
  const cache = new Map();
  const r = await D.sampleElevations(pts, { fetch: fetchImpl, cache, batchSize: 100 });
  assert.equal(calls.length, 2);
  assert.equal(r.samples.length, 101);
  assert.equal(r.samples[0].elevation, 800);
  assert.equal(r.samples[0].source.dataset, 'Copernicus DEM 2021 GLO-90');
  assert.equal(r.samples[0].source.resolutionMeters, 90);
  assert.equal(r.meta.provider, 'open-meteo');
  assert.equal(r.samples[0].provenance, 'measured');
  const r2 = await D.sampleElevations(pts, { fetch: fetchImpl, cache, batchSize: 100 });
  assert.equal(calls.length, 2, 'la segunda lectura sale de caché sin otra llamada');
  assert.equal(r2.samples.length, 101);
  await assert.rejects(() => D.sampleElevations([{ lat: -54.6, lon: -67.2 }], {
    fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: true, reason: 'lat' }) }),
    cache: new Map(),
  }), /Open-Meteo: lat/);
});

test('fotos: Commons, Panoramax y Mapillary son clientes reales; sin token queda pending', async () => {
  assert.equal(P.status().find(x => x.provider === 'mapillary').status, 'pending-client');
  const status = P.status('MLY|token-de-prueba');
  assert.equal(status.find(x => x.provider === 'mapillary').ready, true);
  assert.equal(status.find(x => x.provider === 'mapillary').status, 'ready');
  assert.equal(N.statusMapillary({ token: 'MLY|token-de-prueba' }).status, 'ready');
  const commons = {
    query: { pages: { '123': { pageid: 123, title: 'File:AB.jpg', coordinates: [{ lat: -54.6267, lon: -67.2433 }], imageinfo: [{ url: 'https://upload.test/AB.jpg?utm_source=x', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<b>Nombre</b>' } } }] } } },
  };
  const fetched = [];
  const fetchImpl = async url => {
    fetched.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(/commons/.test(url) ? commons : { features: [] }) };
  };
  const photos = await P.searchCommons({ lat: -54.6266558, lon: -67.2432701 }, { fetch: fetchImpl, radiusMeters: 500 });
  assert.equal(photos.length, 1);
  assert.equal(photos[0].url, 'https://upload.test/AB.jpg');
  assert.equal(photos[0].license, 'CC BY-SA 4.0');
  assert.equal(photos[0].author, 'Nombre');
  assert.equal(photos[0].visualVerified, false);
  assert.match(fetched[0], /ggscoord=-54\.6266558%7C-67\.2432701/);
  const px = await P.searchPanoramax({ lat: -54.6266558, lon: -67.2432701 }, { fetch: fetchImpl, radiusMeters: 500 });
  assert.deepEqual(px, []);
  assert.match(fetched[1], /api\.panoramax\.xyz\/api\/search\?bbox=/);
});
