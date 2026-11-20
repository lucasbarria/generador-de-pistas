// Modelo de proyectos de reconstrucción de tramos reales.
// Se compila dentro de index.html y también se puede exigir desde Node en los tests.
(function (root) {
  'use strict';

  const SCHEMA = 'recon-project';
  const VERSION = 1;

  const PROVENANCE = Object.freeze({
    MEASURED: 'measured',   // dato medido o procedente de una fuente geográfica
    OBSERVED: 'observed',   // dato observado en una fotografía o imagen
    ESTIMATED: 'estimated', // dato estimado por el usuario o por el sistema
    GENERATED: 'generated', // dato generado artificialmente
  });

  const PROVENANCE_LABEL = Object.freeze({
    measured: 'Medido / fuente geográfica',
    observed: 'Observado en imagen',
    estimated: 'Estimado',
    generated: 'Generado artificialmente',
  });

  const DEFAULT_CONFIDENCE = Object.freeze({
    measured: 0.9,
    observed: 0.7,
    estimated: 0.35,
    generated: 0.15,
  });

  const ROUTE_STATUS = Object.freeze({
    UNSET: 'unset',
    DRAFT: 'draft',
    IMPORTED: 'imported',
    VALIDATED: 'validated',
  });

  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'rp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function now() { return new Date().toISOString(); }

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function blankProject(opts) {
    const o = opts || {};
    const t = now();
    return {
      schema: SCHEMA,
      version: VERSION,
      id: uid(),
      name: o.name || 'Proyecto de reconstrucción',
      createdAt: t,
      updatedAt: t,
      stage: {
        name: o.stageName || null,
        country: o.country || null,
        query: o.query || null,
        anchor: null,
        bbox: null,
        notes: o.notes || null,
      },
      route: {
        status: ROUTE_STATUS.UNSET,
        points: [],
        source: null,
        lengthMeters: 0,
        closed: false,
      },
      elevation: {
        provider: null,
        dataset: null,
        resolutionMeters: null,
        attribution: null,
        fetchedAt: null,
        samples: [],
        rasters: [],
        geographicBase: null,
      },
      imagery: [],
      photos: [],
      changes: [],
      validation: { state: 'not-run', checkedAt: null, issues: [] },
    };
  }

  // Fuente verificada el 2026-11-20 con Nominatim (OpenStreetMap).
  // Es el punto llamado "Aguas blancas" sobre la Ruta Provincial 27, no un recorrido de rally.
  function aguasBlancasSeed() {
    const p = blankProject({
      name: 'Aguas Blancas · Tolhuin',
      stageName: 'Aguas Blancas',
      country: 'Argentina',
      query: 'Aguas blancas, Ruta Provincial 27, Municipio de Tolhuin, Tierra del Fuego, Argentina',
      notes: 'Ancla geográfica verificada en OpenStreetMap. El recorrido real todavía no fue importado ni dibujado: no se inventa trazado.',
    });
    p.stage.anchor = {
      lat: -54.6266558,
      lon: -67.2432701,
      provenance: PROVENANCE.MEASURED,
      confidence: 0.9,
      source: {
        kind: 'osm-nominatim',
        label: 'OpenStreetMap / Nominatim',
        id: 'node/6987631224',
        url: 'https://www.openstreetmap.org/node/6987631224',
        retrievedAt: '2026-11-20',
        detail: 'Amenity=parking, name=Aguas blancas, RP-27, Tolhuin',
      },
    };
    return p;
  }

  function normalizePoint(raw) {
    if (raw === null || raw === undefined) return null;
    let lat, lon, ele = null, time = null, name = null;
    let provenance = PROVENANCE.ESTIMATED, confidence = null, source = null;
    if (Array.isArray(raw)) {
      lat = num(raw[0]); lon = num(raw[1]); ele = num(raw[2]);
    } else {
      lat = num(raw.lat); lon = num(raw.lon !== undefined ? raw.lon : raw.lng);
      ele = num(raw.ele !== undefined ? raw.ele : raw.elevation);
      time = raw.time || raw.t || null;
      name = raw.name || null;
      provenance = Object.values(PROVENANCE).includes(raw.provenance) ? raw.provenance : PROVENANCE.ESTIMATED;
      confidence = num(raw.confidence);
      source = raw.source || null;
    }
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    // IMPORTANTE: no redondear lat/lon. La precisión original se conserva hasta la exportación.
    return {
      lat, lon,
      ele,
      time,
      name,
      provenance,
      confidence: confidence === null ? DEFAULT_CONFIDENCE[provenance] : clamp(confidence, 0, 1),
      source: source ? clone(source) : null,
    };
  }

  function setRoute(project, points, source) {
    if (!project || !project.route) throw new Error('Proyecto inválido.');
    const src = source || { kind: 'manual', label: 'Recorrido marcado en el mapa', provenance: PROVENANCE.OBSERVED, retrievedAt: now() };
    const prov = Object.values(PROVENANCE).includes(src.provenance) ? src.provenance : PROVENANCE.OBSERVED;
    const pts = [];
    for (const raw of points || []) {
      const p = normalizePoint(raw);
      if (!p) continue;
      if (p.provenance === PROVENANCE.ESTIMATED && !raw.provenance) p.provenance = prov;
      p.confidence = raw.confidence === undefined ? DEFAULT_CONFIDENCE[p.provenance] : clamp(num(raw.confidence) || 0, 0, 1);
      p.source = p.source || clone(src);
      pts.push(p);
    }
    project.route.points = pts;
    project.route.source = clone(src);
    project.route.status = pts.length > 1 ? (src.kind === 'manual' ? ROUTE_STATUS.DRAFT : ROUTE_STATUS.IMPORTED) : ROUTE_STATUS.UNSET;
    project.route.lengthMeters = lengthMeters(pts);
    project.updatedAt = now();
    return project.route;
  }

  function setElevationSamples(project, samples, meta) {
    if (!project || !project.elevation) throw new Error('Proyecto inválido.');
    const m = meta || {};
    project.elevation.provider = m.provider || project.elevation.provider;
    project.elevation.dataset = m.dataset || project.elevation.dataset;
    project.elevation.resolutionMeters = num(m.resolutionMeters) === null ? project.elevation.resolutionMeters : num(m.resolutionMeters);
    project.elevation.attribution = m.attribution || project.elevation.attribution;
    project.elevation.fetchedAt = m.fetchedAt || now();
    project.elevation.samples = (samples || []).map(s => {
      const p = normalizePoint(s);
      return p && { lat: p.lat, lon: p.lon, elevation: num(s.elevation !== undefined ? s.elevation : s.ele), provenance: PROVENANCE.MEASURED, confidence: 0.9, source: clone(m.source || null) };
    }).filter(s => s && s.elevation !== null);
    project.updatedAt = now();
    return project.elevation;
  }

  function addPhoto(project, photo) {
    if (!project) throw new Error('Proyecto inválido.');
    const p = clone(photo || {});
    if (!p.url || !p.provider) throw new Error('La foto necesita URL y proveedor.');
    p.provenance = PROVENANCE.OBSERVED;
    p.confidence = p.confidence === undefined ? 0.7 : clamp(num(p.confidence) || 0, 0, 1);
    p.visualVerified = !!p.visualVerified; // nadie afirma que muestra el camino sin revisarlo
    project.photos.push(p);
    project.updatedAt = now();
    return p;
  }

  function addChange(project, change) {
    if (!project) throw new Error('Proyecto inválido.');
    project.changes.push(Object.assign({ at: now(), reversible: true }, clone(change || {})));
    project.updatedAt = now();
  }

  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('El archivo no contiene un proyecto.');
    if (raw.schema && raw.schema !== SCHEMA) throw new Error('Esquema de proyecto desconocido: ' + raw.schema);
    if (raw.version && num(raw.version) > VERSION) throw new Error('Este proyecto es más nuevo que la aplicación.');
    const p = blankProject({ name: raw.name });
    p.id = raw.id || p.id;
    p.createdAt = raw.createdAt || p.createdAt;
    p.updatedAt = raw.updatedAt || p.updatedAt;
    if (raw.stage) {
      p.stage.name = raw.stage.name || null;
      p.stage.country = raw.stage.country || null;
      p.stage.query = raw.stage.query || null;
      p.stage.notes = raw.stage.notes || null;
      p.stage.anchor = raw.stage.anchor ? {
        lat: num(raw.stage.anchor.lat), lon: num(raw.stage.anchor.lon),
        provenance: PROVENANCE.MEASURED, confidence: 0.9, source: clone(raw.stage.anchor.source || null),
      } : null;
      if (p.stage.anchor && (p.stage.anchor.lat === null || p.stage.anchor.lon === null)) p.stage.anchor = null;
      p.stage.bbox = raw.stage.bbox ? clone(raw.stage.bbox) : null;
    }
    if (raw.route) {
      p.route.source = raw.route.source ? clone(raw.route.source) : null;
      p.route.status = Object.values(ROUTE_STATUS).includes(raw.route.status) ? raw.route.status : ROUTE_STATUS.UNSET;
      p.route.closed = !!raw.route.closed;
      p.route.points = (raw.route.points || []).map(normalizePoint).filter(Boolean);
      p.route.lengthMeters = lengthMeters(p.route.points);
      if (!p.route.points.length) p.route.status = ROUTE_STATUS.UNSET;
    }
    if (raw.elevation) {
      p.elevation.provider = raw.elevation.provider || null;
      p.elevation.dataset = raw.elevation.dataset || null;
      p.elevation.resolutionMeters = num(raw.elevation.resolutionMeters);
      p.elevation.attribution = raw.elevation.attribution || null;
      p.elevation.fetchedAt = raw.elevation.fetchedAt || null;
      p.elevation.samples = (raw.elevation.samples || []).map(s => {
        const pt = normalizePoint(s);
        const e = num(s.elevation !== undefined ? s.elevation : s.ele);
        const provenance = Object.values(PROVENANCE).includes(s.provenance) ? s.provenance : PROVENANCE.MEASURED;
        const confidence = num(s.confidence) === null ? DEFAULT_CONFIDENCE[provenance] : clamp(num(s.confidence), 0, 1);
        return pt && e !== null ? { lat: pt.lat, lon: pt.lon, elevation: e, provenance, confidence, source: clone(s.source || null), rasterId: s.rasterId || null } : null;
      }).filter(Boolean);
      p.elevation.rasters = Array.isArray(raw.elevation.rasters) ? clone(raw.elevation.rasters) : [];
      p.elevation.geographicBase = raw.elevation.geographicBase ? clone(raw.elevation.geographicBase) : null;
    }
    p.imagery = Array.isArray(raw.imagery) ? clone(raw.imagery) : [];
    p.photos = Array.isArray(raw.photos) ? clone(raw.photos).filter(f => f && f.url && f.provider) : [];
    p.changes = Array.isArray(raw.changes) ? clone(raw.changes) : [];
    p.validation = raw.validation && typeof raw.validation === 'object' ? clone(raw.validation) : p.validation;
    return p;
  }

  function validateProject(project) {
    const issues = [];
    if (!project || !project.route) return ['Falta el proyecto.'];
    if (project.route.points.length < 2) issues.push('Falta definir el recorrido (al menos dos puntos).');
    if (project.route.points.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) issues.push('Hay coordenadas no válidas.');
    if (project.route.lengthMeters > 20000) issues.push('El tramo supera los 20 km límite del generador actual.');
    if (!project.elevation.samples.length) issues.push('No hay elevación descargada: la geometría 3D dependerá del modelo que usa el generador.');
    if (!project.stage.anchor) issues.push('No hay un ancla geográfica verificada para el piloto.');
    return issues;
  }

  function bbox(points) {
    const pts = (points || []).map(normalizePoint).filter(Boolean);
    if (!pts.length) return null;
    const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon);
    return { south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons) };
  }

  function lengthMeters(points) {
    const pts = (points || []).map(normalizePoint).filter(Boolean);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
    return d;
  }

  function haversine(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // El generador guarda el tramo como G.path ("f:lat,lon") y como S.routeGeom ([lat, lon]).
  // Preferimos routeGeom porque conserva las coordenadas sin convertirlas en claves de texto.
  function pointsFromLegacy(state) {
    const s = state || {};
    if (Array.isArray(s.routeGeom) && s.routeGeom.length > 1) {
      return s.routeGeom.map(v => normalizePoint(Array.isArray(v) ? v : [v[0], v[1]])).filter(Boolean);
    }
    if (Array.isArray(s.gps) && s.gps.length > 1) {
      return s.gps.map(normalizePoint).filter(Boolean);
    }
    if (Array.isArray(s.path)) {
      const pts = [];
      for (const key of s.path) {
        if (typeof key !== 'string' || !key.startsWith('f:')) continue;
        const [lat, lon] = key.slice(2).split(',').map(Number);
        const p = normalizePoint([lat, lon]);
        if (p) pts.push(p);
      }
      if (pts.length > 1) return pts;
    }
    if (Array.isArray(s.wps) && s.wps.length > 1) return s.wps.map(normalizePoint).filter(Boolean);
    return [];
  }

  function sameGeom(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].lat !== b[i].lat || a[i].lon !== b[i].lon) return false;
    }
    return true;
  }

  function syncRouteFromLegacy(project, state, source) {
    const pts = pointsFromLegacy(state);
    if (pts.length < 2) return false;
    const prev = project.route.points || [];
    if (!source && sameGeom(prev, pts)) return false; // no pisar la procedencia al refrescar el dibujo
    const src = source || {
      kind: 'map',
      label: 'Recorrido marcado en el mapa / generador existente',
      provenance: state && state.gps ? PROVENANCE.MEASURED : PROVENANCE.OBSERVED,
      retrievedAt: now(),
    };
    setRoute(project, pts, src);
    return true;
  }

  function summary(project) {
    if (!project) return '';
    const r = project.route;
    const pts = r.points.length;
    const km = r.lengthMeters / 1000;
    const anchor = project.stage.anchor ? `ancla ${project.stage.anchor.lat.toFixed(6)}, ${project.stage.anchor.lon.toFixed(6)}` : 'sin ancla verificada';
    return `${project.name} · ${anchor} · ${pts ? pts.toLocaleString('es-AR') + ' puntos, ' + km.toFixed(2) + ' km' : 'sin recorrido'} · ${project.elevation.samples.length} alturas con procedencia`;
  }

  const api = {
    SCHEMA, VERSION, PROVENANCE, PROVENANCE_LABEL, DEFAULT_CONFIDENCE, ROUTE_STATUS,
    blankProject, aguasBlancasSeed, normalizePoint, normalizeProject, setRoute,
    setElevationSamples, addPhoto, addChange, validateProject, bbox, haversine,
    lengthMeters, pointsFromLegacy, syncRouteFromLegacy, summary, clone, uid, num,
  };

  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  root.Recon = root.Reconstruction; // alias corto usado por app.js
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
