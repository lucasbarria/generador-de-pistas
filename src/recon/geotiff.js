// Importación real de GeoTIFF local al modelo de reconstrucción.
// Usa los bundles vendorizados de geotiff.js (BSD-3-Clause) y proj4js (MIT), incrustados por build.py.
// Ningún CRS, unidad o resolución se asume silenciosamente: si no se puede identificar, se informa.
(function (root) {
  'use strict';

  const api = {};
  const WGS84 = 'EPSG:4326';
  const handles = new Map();
  const windowCache = new Map();
  const MAX_CACHED_WINDOWS = 16;
  const MAX_WINDOW_PIXELS = 12e6;

  const LINEAR_UNITS = Object.freeze({ 9001: 'metre', 9002: 'foot', 9003: 'US survey foot' });
  const ANGULAR_UNITS = Object.freeze({ 9101: 'radian', 9102: 'degree' });
  const COMPRESSION = Object.freeze({ 1: 'none', 5: 'LZW', 7: 'JPEG', 8: 'deflate', 32946: 'deflate', 34712: 'JPEG2000', 34887: 'LERC', 34925: 'LZMA', 50000: 'ZSTD' });
  const SAMPLE_FORMAT = Object.freeze({ 1: 'uint', 2: 'int', 3: 'float', 4: 'undefined' });
  const DEG_TO_M = 111320;

  function loadGeoTIFF() {
    if (typeof require === 'function') {
      // El bundle browser necesita estos globals; en Node los proveemos antes de exigirlo.
      if (typeof globalThis.Worker === 'undefined') globalThis.Worker = class { constructor() { throw new Error('worker no disponible'); } };
      if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
      return require('../vendor/geotiff.js');
    }
    return root.GeoTIFF || (root.geotiff && root.geotiff.GeoTIFF) || null;
  }

  function loadProj4() {
    if (typeof require === 'function') return require('../vendor/proj4.js');
    return root.proj4 || null;
  }

  function now() { return new Date().toISOString(); }

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function asArray(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v);
    if (typeof v === 'object' && typeof v.length === 'number') return Array.from(v);
    if (typeof v === 'object' && !Number.isNaN(Number(Object.keys(v)[0]))) {
      return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]);
    }
    return null;
  }

  function hashId(filename, bytes) {
    let h = 2166136261;
    const s = String(filename || 'geotiff') + ':' + bytes;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'gt-' + (h >>> 0).toString(16).padStart(8, '0');
  }

  function parseCRS(geo, opts) {
    const warnings = [];
    const projected = num(geo.ProjectedCSTypeGeoKey);
    const geographic = num(geo.GeographicTypeGeoKey);
    const proj4String = typeof geo.Proj4StringGeoKey === 'string' ? geo.Proj4StringGeoKey : null;
    const customId = 'RECON:' + hashId(proj4String || '', Object.keys(geo).length);

    if (proj4String) {
      const P = loadProj4();
      if (P) P.defs(customId, proj4String);
      return { code: customId, eclipsed: 'custom', kind: /\+proj=(utm|tmerc|merc|lcc)/.test(proj4String) ? 'projected' : 'geographic', label: 'CRS definida en el GeoTIFF', proj4String, known: true, warnings };
    }
    if (projected !== null && projected !== 32767) {
      const code = 'EPSG:' + projected;
      const P = loadProj4();
      const known = !!(P && P.defs(code));
      if (!known) warnings.push('La CRS proyectada ' + code + ' no está en proj4js: se necesita su definición (no se inventa).');
      return { code, eclipsed: projected, kind: 'projected', label: known ? code : code + ' (definición no disponible)', known, warnings };
    }
    if (geographic !== null && geographic !== 32767) {
      const code = 'EPSG:' + geographic;
      const P = loadProj4();
      const known = !!(P && P.defs(code));
      if (!known) warnings.push('La CRS geográfica ' + code + ' no está en proj4js: se necesita su definición (no se inventa).');
      return { code, eclipsed: geographic, kind: 'geographic', label: known ? code : code + ' (definición no disponible)', known, warnings };
    }

    // Las zonas UTM son datos del propio archivo, no una suposición. El hemisferio no siempre está codificado.
    const zone = num(geo.ProjUtmZoneGeoKey !== undefined ? geo.ProjUtmZoneGeoKey : geo.GeogUtmZoneGeoKey);
    if (zone !== null && zone >= 1 && zone <= 60) {
      const P = loadProj4();
      const south = typeof geo.GeogUtmZoneGeoKey === 'number' && geo.GeogUtmZoneGeoKey < 0;
      const def = '+proj=utm +zone=' + zone + (south ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs';
      const id = 'RECON:utm-' + zone + (south ? 's' : 'n');
      if (P) P.defs(id, def);
      warnings.push('CRS reconstruida desde la zona UTM ' + zone + (south ? ' sur' : ' (hemisferio no confirmado; se usa norte)') + ' declarada en el archivo.');
      return { code: id, eclipsed: zone, kind: 'projected', label: 'UTM zona ' + zone, proj4String: def, known: true, warnings };
    }

    if (opts && opts.crsOverride) {
      warnings.push('Se aplicó una CRS indicada explícitamente por el usuario: ' + opts.crsOverride + '. No proviene del archivo.');
      return { code: opts.crsOverride, eclipsed: null, kind: /\+proj=(utm|tmerc|merc|lcc)/.test(opts.crsOverride) ? 'projected' : 'geographic', label: 'CRS declarada por el usuario', known: true, warnings, userOverride: true };
    }
    warnings.push('El GeoTIFF no declara CRS identificable. No se transforman coordenadas y la confianza se reduce.');
    return { code: null, eclipsed: null, kind: 'unknown', label: 'CRS no identificada', known: false, warnings };
  }

  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    if (input && typeof input.arrayBuffer === 'function') return null; // se resuelve en el llamador asíncrono
    throw new Error('Se espera un ArrayBuffer o Uint8Array con el GeoTIFF.');
  }

  async function openGeoTIFF(input, opts) {
    const o = opts || {};
    let buffer = null;
    if (input && typeof input.arrayBuffer === 'function' && !(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) buffer = await input.arrayBuffer();
    else buffer = toArrayBuffer(input);
    const bytes = buffer.byteLength;
    const G = loadGeoTIFF();
    if (!G) throw new Error('No está disponible el lector de GeoTIFF (geotiff.js).');
    const P = loadProj4();
    const tiff = await G.fromArrayBuffer(buffer);
    const count = await tiff.getImageCount();
    const index = Math.max(0, Math.min(count - 1, num(o.imageIndex) === null ? 0 : num(o.imageIndex)));
    const image = await tiff.getImage(index);
    const geo = image.getGeoKeys() || {};
    const fd = image.getFileDirectory() || {};
    // geotiff.js devuelve el IFD con nombres (ModelPixelScale) o con códigos numéricos; soportamos ambos.
    const tag = (name, code) => fd[name] !== undefined ? fd[name] : fd[code];
    const crs = parseCRS(geo, o);
    const warnings = crs.warnings.slice();
    const width = image.getWidth();
    const height = image.getHeight();
    const bands = image.getSamplesPerPixel();
    const bits = asArray(image.getBitsPerSample()) || [];
    const formats = asArray(image.getSampleFormat()) || [];
    const comp = num(tag('Compression', 259));
    const compressionCode = comp === null ? 1 : comp;
    const resolution = asArray(image.getResolution()) || [];
    const origin = asArray(image.getOrigin()) || [];
    const bbox = asArray(image.getBoundingBox()) || [];
    const matrixRaw = asArray(tag('ModelTransformation', 34264));
    const tieRaw = asArray(tag('ModelTiepoint', 33922));
    const scaleRaw = asArray(tag('ModelPixelScale', 33550));
    const matrix = matrixRaw && matrixRaw.length === 16 ? matrixRaw.map(Number) : null;
    const tiepoint = tieRaw ? tieRaw.map(Number) : null;
    const pixelScale = scaleRaw ? scaleRaw.map(Number) : null;
    const horizontalCode = crs.kind === 'geographic' ? num(geo.GeogAngularUnitsGeoKey) : num(geo.ProjLinearUnitsGeoKey);
    const horizontalUnits = crs.kind === 'geographic'
      ? { code: horizontalCode, label: ANGULAR_UNITS[horizontalCode] || null, known: !!ANGULAR_UNITS[horizontalCode] }
      : { code: horizontalCode, label: LINEAR_UNITS[horizontalCode] || null, known: !!LINEAR_UNITS[horizontalCode] };
    // GeoTIFF spec: VerticalUnitsGeoKey = 4099 (NO confundir con 2050).
    const verticalCode = num(geo.VerticalUnitsGeoKey);
    const verticalUnits = { code: verticalCode, label: LINEAR_UNITS[verticalCode] || null, known: !!LINEAR_UNITS[verticalCode] };
    const nd = image.getGDALNoData();
    const nodataValue = num(nd);
    const resX = Math.abs(num(resolution[0]) || 0);
    const resY = Math.abs(num(resolution[1]) || 0);
    let metersX = null, metersY = null;
    if (resX && resY) {
      if (horizontalUnits.label === 'metre') { metersX = resX; metersY = resY; }
      else if (horizontalUnits.label === 'foot') { metersX = resX * 0.3048; metersY = resY * 0.3048; }
      else if (horizontalUnits.label === 'US survey foot') { metersX = resX * (1200 / 3937); metersY = resY * (1200 / 3937); }
      else if (horizontalUnits.label === 'degree') {
        const latRef = num(bbox[1]) !== null ? Math.abs((num(bbox[1]) + num(bbox[3])) / 2) : 54;
        metersX = resX * DEG_TO_M * Math.max(0.01, Math.cos(latRef * Math.PI / 180));
        metersY = resY * DEG_TO_M;
      } else {
        warnings.push('No se puede convertir la resolución a metros: unidades horizontales desconocidas (código ' + horizontalCode + ').');
      }
    }
    if (!horizontalUnits.known) warnings.push('Unidades horizontales no declaradas o desconocidas (código ' + horizontalCode + '): no se asumió ninguna unidad.');
    if (!verticalUnits.known) warnings.push('Unidades verticales no declaradas o desconocidas (código ' + verticalCode + '): las elevaciones se entregan sin conversión y con confianza reducida.');
    if (!resX || !resY) warnings.push('No se pudo leer la resolución espacial del raster.');
    if (bands > 1) warnings.push('El raster tiene ' + bands + ' bandas; se usa la banda 1 para elevación.');
    if (matrix) warnings.push('Se detectó ModelTransformationTag (matriz 4x4): se usa para transformar píxel ↔ coordenadas.');
    if (compressionCode !== 1 && !COMPRESSION[compressionCode]) warnings.push('Compresión TIFF código ' + compressionCode + ' no reconocida; se intentará lectura directa.');

    const resolutionMeters = metersX && metersY ? Math.max(metersX, metersY) : null;
    const suitable = resolutionMeters !== null && resolutionMeters <= 5;
    if (resolutionMeters !== null && !suitable) warnings.push('Resolución de ' + resolutionMeters.toFixed(1) + ' m/píxel: insuficiente para cunetas, roderas o baches. Solo sirve como elevación base del terreno.');
    const confidence = crs.known && verticalUnits.known && horizontalUnits.known ? 0.9 : (crs.known ? 0.65 : 0.4);

    const meta = {
      id: o.id || hashId(o.filename, bytes),
      filename: o.filename || 'raster.tif',
      sizeBytes: bytes,
      obtainedAt: o.obtainedAt || now(),
      imageIndex: index,
      imageCount: count,
      width, height, bands,
      bitsPerSample: Array.from(bits || []),
      sampleFormat: Array.from(formats || []).map(f => SAMPLE_FORMAT[f] || String(f)),
      compression: { code: compressionCode, label: COMPRESSION[compressionCode] || 'desconocida' },
      crs: { code: crs.code, label: crs.label, kind: crs.kind, known: crs.known, proj4String: crs.proj4String || null, userOverride: !!crs.userOverride },
      resolution: { x: resX, y: resY, units: horizontalUnits.label || 'unknown', unitsCode: horizontalCode, metersX, metersY, meters: resolutionMeters },
      horizontalUnits,
      verticalUnits,
      bbox: bbox.length >= 4 ? { minX: num(bbox[0]), minY: num(bbox[1]), maxX: num(bbox[2]), maxY: num(bbox[3]) } : null,
      origin: origin.length >= 2 ? [num(origin[0]), num(origin[1])] : null,
      transform: {
        kind: matrix ? 'matrix' : (tiepoint && pixelScale ? 'tiepoint-pixelscale' : 'none'),
        matrix,
        tiepoint,
        pixelScale,
        applied: [matrix ? 'ModelTransformationTag' : 'ModelTiepointTag + ModelPixelScaleTag', crs.code ? 'proj4 ' + crs.code + ' → EPSG:4326' : 'sin transformación de CRS'],
      },
      nodata: { value: nodataValue, present: nodataValue !== null, policy: 'mask', count: 0 },
      quality: { confidence, suitableForRoadDetail: suitable, warnings },
      layer: 'geographic-base',
      provenance: 'measured',
    };

    // La componente Y con signo es necesaria para pasar de coordenadas de mundo a fila de píxel.
    const signedResolutionY = num(resolution[1]);
    const handle = { meta, image, tiff, crs, origin, resolution: [resX, signedResolutionY === null ? -resY : signedResolutionY], matrix, nodataValue };
    handles.set(meta.id, handle);
    clearWindows(meta.id);
    return { id: meta.id, meta, handle };
  }

  function clearWindows(id) {
    for (const key of [...windowCache.keys()]) if (!id || key.startsWith(id + ':')) windowCache.delete(key);
  }

  function clearCache(id) {
    if (id) { handles.delete(id); clearWindows(id); }
    else { handles.clear(); windowCache.clear(); }
  }

  function getHandle(rasterOrId) {
    if (rasterOrId && rasterOrId.handle) return rasterOrId.handle;
    const id = typeof rasterOrId === 'string' ? rasterOrId : (rasterOrId && rasterOrId.meta && rasterOrId.meta.id);
    const h = id ? handles.get(id) : null;
    if (!h) throw new Error('El raster ' + id + ' no está en memoria: volvé a importar el GeoTIFF para consultarlo.');
    return h;
  }

  function worldToPixel(h, lat, lon) {
    if (!h.crs.code || !h.crs.known) return { px: NaN, py: NaN, transformed: false };
    const P = loadProj4();
    if (!P) return { px: NaN, py: NaN, transformed: false };
    let x = lon, y = lat;
    if (h.crs.code !== WGS84) {
      const converted = P(WGS84, h.crs.code, [lon, lat]);
      x = converted[0]; y = converted[1];
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { px: NaN, py: NaN, transformed: false };
    if (h.matrix) {
      const m = h.matrix;
      const a = m[0], b = m[1], d = m[4], e = m[5];
      const det = a * e - b * d;
      if (!det) return { px: NaN, py: NaN, transformed: false };
      const rx = x - m[3], ry = y - m[7];
      return { px: (e * rx - b * ry) / det, py: (-d * rx + a * ry) / det, transformed: true };
    }
    const ox = num(h.origin[0]), oy = num(h.origin[1]);
    if (ox === null || oy === null || !h.resolution[0] || !h.resolution[1]) return { px: NaN, py: NaN, transformed: false };
    // getResolution devuelve la componente Y con signo; el origen ya está en la esquina superior.
    return { px: (x - ox) / h.resolution[0], py: (y - oy) / h.resolution[1], transformed: true };
  }

  async function readWindow(h, box) {
    const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(h.meta.width - 1, Math.ceil(box[2])), y1 = Math.min(h.meta.height - 1, Math.ceil(box[3]));
    if (x1 < x0 || y1 < y0) throw new Error('La ventana del raster quedó vacía.');
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_WINDOW_PIXELS) throw new Error('La ventana del raster es demasiado grande; reducí el tramo o usá un raster teselado.');
    const key = h.meta.id + ':' + [x0, y0, x1, y1].join(',');
    let cached = windowCache.get(key);
    if (!cached) {
      // geotiff.js usa right/bottom exclusivos: x1/y1 son los últimos píxeles válidos inclusive.
      const rasters = await h.image.readRasters({ window: [x0, y0, x1 + 1, y1 + 1], samples: [0], interleave: false });
      const data = rasters[0] || rasters;
      cached = { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1, values: data, reads: 0 };
      windowCache.set(key, cached);
      if (windowCache.size > MAX_CACHED_WINDOWS) windowCache.delete(windowCache.keys().next().value);
    }
    cached.reads++;
    return cached;
  }

  function isNoData(h, v) { return !Number.isFinite(v) || (h.nodataValue !== null && v === h.nodataValue); }

  function valueAt(data, x, y) {
    if (x < 0 || y < 0 || x >= data.width || y >= data.height) return null;
    return Number(data.values[y * data.width + x]);
  }

  function interpolate(data, px, py, method) {
    if (method === 'nearest') {
      const nx = Math.min(data.width - 1, Math.max(0, Math.round(px)));
      const ny = Math.min(data.height - 1, Math.max(0, Math.round(py)));
      const v = valueAt(data, nx, ny);
      return v === null || !Number.isFinite(v) ? null : v;
    }
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    // En el borde de la ventana se usa la última celda real en vez de exigir una vecina inexistente.
    const x1 = Math.min(x0 + 1, data.width - 1), y1 = Math.min(y0 + 1, data.height - 1);
    const v00 = valueAt(data, x0, y0), v10 = valueAt(data, x1, y0);
    const v01 = valueAt(data, x0, y1), v11 = valueAt(data, x1, y1);
    if ([v00, v10, v01, v11].some(v => v === null || !Number.isFinite(v))) return null;
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  }

  function normalizePoint(p) {
    if (Array.isArray(p)) return { lat: num(p[0]), lon: num(p[1]), ele: num(p[2]) };
    return { lat: num(p && (p.lat !== undefined ? p.lat : p[0])), lon: num(p && (p.lon !== undefined ? p.lon : p.lng)), ele: num(p && (p.ele !== undefined ? p.ele : p.elevation)) };
  }

  async function sampleRaster(rasterOrId, points, opts) {
    const o = opts || {};
    const h = getHandle(rasterOrId);
    const list = (points || []).map(normalizePoint).filter(p => p.lat !== null && p.lon !== null);
    if (!list.length) return { samples: [], missing: [], meta: h.meta, quality: h.meta.quality };
    const pixels = list.map(p => worldToPixel(h, p.lat, p.lon));
    const valid = pixels.map((q, i) => ({ ...q, i })).filter(q => Number.isFinite(q.px) && Number.isFinite(q.py));
    if (!valid.length) {
      return { samples: [], missing: list.map((p, i) => ({ index: i, lat: p.lat, lon: p.lon, reason: 'coordenada no convertible a la CRS del raster' })), meta: h.meta, quality: h.meta.quality };
    }
    const pad = o.interpolation === 'nearest' ? 1 : 2;
    const box = [
      Math.min(...valid.map(q => q.px)) - pad,
      Math.min(...valid.map(q => q.py)) - pad,
      Math.max(...valid.map(q => q.px)) + pad,
      Math.max(...valid.map(q => q.py)) + pad,
    ];
    const data = await readWindow(h, box);
    const samples = [], missing = [];
    let inside = 0;
    for (let i = 0; i < list.length; i++) {
      const q = pixels[i], p = list[i];
      if (!Number.isFinite(q.px) || !Number.isFinite(q.py)) { missing.push({ index: i, lat: p.lat, lon: p.lon, reason: 'coordenada no convertible a la CRS del raster' }); continue; }
      // Se admite hasta la mitad de la última celda: el interpolador usa esa celda en el borde.
      if (q.px < 0 || q.py < 0 || q.px > h.meta.width - 0.5 || q.py > h.meta.height - 0.5) { missing.push({ index: i, lat: p.lat, lon: p.lon, reason: 'fuera de la extensión del raster' }); continue; }
      inside++;
      const v = interpolate(data, q.px - data.x0, q.py - data.y0, o.interpolation);
      if (v === null || isNoData(h, v)) { missing.push({ index: i, lat: p.lat, lon: p.lon, reason: 'NoData o celdas sin información' }); continue; }
      const vunit = h.meta.verticalUnits.label;
      const elevation = vunit === 'foot' ? v * 0.3048 : (vunit === 'US survey foot' ? v * (1200 / 3937) : v);
      samples.push({
        lat: p.lat, lon: p.lon, elevation,
        provenance: 'measured',
        confidence: h.meta.quality.confidence,
        rasterId: h.meta.id,
        source: {
          kind: 'geotiff',
          label: 'GeoTIFF local: ' + h.meta.filename,
          filename: h.meta.filename,
          dataset: h.meta.filename,
          crs: h.meta.crs.code,
          horizontalUnits: h.meta.horizontalUnits.label,
          verticalUnits: h.meta.verticalUnits.label || 'unknown',
          resolutionMeters: h.meta.resolution.meters,
          bbox: h.meta.bbox,
          transformations: h.meta.transform.applied,
          obtainedAt: h.meta.obtainedAt,
          sampledAt: now(),
          nodata: h.meta.nodata.value,
          interpolation: o.interpolation === 'nearest' ? 'nearest' : 'bilinear',
          layer: 'geographic-base',
        },
      });
    }
    h.meta.nodata.count = missing.filter(m => /NoData/.test(m.reason)).length;
    return { samples, missing, meta: h.meta, quality: h.meta.quality, window: { x0: data.x0, y0: data.y0, x1: data.x0 + data.width - 1, y1: data.y0 + data.height - 1, reads: data.reads } };
  }

  function distanceMeters(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function profileFromSamples(samples, opts) {
    const o = opts || {};
    const pts = (samples || []).filter(s => Number.isFinite(Number(s.elevation !== undefined ? s.elevation : s.ele)))
      .map(s => ({ lat: num(s.lat), lon: num(s.lon), elevation: num(s.elevation !== undefined ? s.elevation : s.ele) }))
      .filter(s => s.lat !== null && s.lon !== null);
    if (!pts.length) return { lengthMeters: 0, dropMeters: 0, maxSlopePercent: 0, minElevation: null, maxElevation: null, stations: [], warnings: ['Sin muestras de elevación válidas.'] };
    let d = 0;
    const stations = [{ distanceMeters: 0, elevation: pts[0].elevation, slopePercent: null }];
    let maxSlope = 0, maxSpacing = 0;
    for (let i = 1; i < pts.length; i++) {
      const step = distanceMeters(pts[i - 1], pts[i]);
      d += step; maxSpacing = Math.max(maxSpacing, step);
      const slope = step > 0 ? ((pts[i].elevation - pts[i - 1].elevation) / step) * 100 : 0;
      maxSlope = Math.max(maxSlope, Math.abs(slope));
      stations.push({ distanceMeters: d, elevation: pts[i].elevation, slopePercent: slope });
    }
    const warnings = [];
    if (maxSpacing > 30 && o.nominalSpacingMeters === undefined) warnings.push('Separación máxima entre muestras de ' + maxSpacing.toFixed(1) + ' m: el perfil puede perder detalle.');
    if (o.nominalSpacingMeters && maxSpacing > 2 * o.nominalSpacingMeters) warnings.push('Hay huecos de muestreo mayores al doble del espaciado nominal.');
    const elevations = pts.map(p => p.elevation);
    return {
      lengthMeters: d,
      dropMeters: elevations[elevations.length - 1] - elevations[0],
      maxSlopePercent: maxSlope,
      minElevation: Math.min(...elevations),
      maxElevation: Math.max(...elevations),
      stations,
      warnings,
    };
  }

  function attachRaster(project, imported, samples, opts) {
    if (!project || !project.elevation) throw new Error('Proyecto inválido.');
    const o = opts || {};
    const meta = JSON.parse(JSON.stringify(imported.meta));
    const src = { ...(samples && samples[0] && samples[0].source ? samples[0].source : {}), kind: 'geotiff', filename: meta.filename };
    project.elevation.provider = 'geotiff-local';
    project.elevation.dataset = meta.filename;
    project.elevation.resolutionMeters = meta.resolution.meters;
    project.elevation.attribution = 'GeoTIFF local: ' + meta.filename + ' · CRS ' + (meta.crs.code || 'no identificada') + ' · unidades ' + (meta.verticalUnits.label || 'desconocidas');
    project.elevation.fetchedAt = meta.obtainedAt;
    // No usamos setElevationSamples: conserva menos procedencia por muestra.
    project.elevation.samples = (samples || []).map(s => ({
      lat: s.lat, lon: s.lon, elevation: s.elevation,
      provenance: s.provenance || 'measured',
      confidence: s.confidence === undefined ? meta.quality.confidence : s.confidence,
      source: JSON.parse(JSON.stringify(s.source || src)),
      rasterId: meta.id,
    }));
    project.elevation.rasters = project.elevation.rasters || [];
    const idx = project.elevation.rasters.findIndex(r => r && r.id === meta.id);
    if (idx >= 0) project.elevation.rasters[idx] = meta;
    else project.elevation.rasters.push(meta);
    project.elevation.geographicBase = {
      layer: 'geographic-base',
      detailSeparated: true,
      note: 'La elevación del raster es base geográfica. Cunetas, roderas y baches se mantienen como geometría de detalle separada; no se derivan de este raster.',
    };
    project.updatedAt = now();
    if (o.changeLabel && typeof require === 'function') {
      try { require('./model.js').addChange(project, { kind: 'geotiff-import', detail: o.changeLabel, reversible: true }); } catch (e) { /* no bloquea */ }
    }
    return { meta, samples: project.elevation.samples.length };
  }

  function rasterSummary(meta) {
    if (!meta) return 'sin raster';
    const res = meta.resolution.meters ? meta.resolution.meters.toFixed(1) + ' m/píxel' : (meta.resolution.x + ' ' + (meta.resolution.units || '') + '/píxel');
    return meta.filename + ' · ' + meta.width + '×' + meta.height + ' · ' + res + ' · ' + (meta.crs.code || 'CRS no identificada') + ' · ' + (meta.verticalUnits.label || 'unidades verticales desconocidas') + (meta.quality.suitableForRoadDetail ? '' : ' · no apto para detalle de calzada');
  }

  Object.assign(api, {
    openGeoTIFF,
    sampleRaster,
    profileFromSamples,
    attachRaster,
    rasterSummary,
    clearCache,
    worldToPixel,
    parseCRS,
    constants: { WGS84, DEG_TO_M, LINEAR_UNITS, ANGULAR_UNITS, COMPRESSION, SAMPLE_FORMAT },
  });

  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  root.Recon = root.Reconstruction;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
