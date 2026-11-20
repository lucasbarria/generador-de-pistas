// Clientes reales de redes geográficas: Mapillary (Graph API v4) y Overpass.
// Verificado el 2026-11-20 contra https://www.mapillary.com/developer/api-documentation:
// el endpoint vigente es REST https://graph.mapillary.com/images con Authorization: OAuth <token>.
// El antiguo GraphQL v3 no está implementado: se usa el oficial actual, sin tokens escritos en código.
// El token se resuelve en cada llamada y NUNCA se guarda ni aparece en URLs, caché o resultados.
(function (root) {
  'use strict';

  const MAPILLARY = Object.freeze({
    id: 'mapillary',
    label: 'Mapillary Graph API',
    apiVersion: 'v4',
    endpoint: 'https://graph.mapillary.com/images',
    authHeader: 'Authorization: OAuth <token>',
    termsUrl: 'https://www.mapillary.com/terms',
    docsUrl: 'https://www.mapillary.com/developer/api-documentation',
    attribution: 'Imágenes: Mapillary, sujetas a Mapillary Terms of Use (https://www.mapillary.com/terms).',
    fields: Object.freeze([
      'id', 'geometry', 'computed_geometry', 'captured_at', 'creator', 'organization',
      'sequence', 'compass_angle', 'computed_compass_angle', 'is_pano',
      'thumb_256_url', 'thumb_512_url', 'thumb_1024_url', 'thumb_2048_url', 'thumb_original_url',
    ]),
    maxRadiusMeters: 50,   // límite oficial del radius search
    maxLimit: 200,         // tope local por búsqueda (el servicio admite hasta 2000)
    maxPages: 5,           // paginación controlada por cursor after
    maxSectors: 16,        // tope local de sectores por bbox
    bboxMaxSpanDeg: 0.009, // la API exige bbox menor a 0.01 grados cuadrados
    defaultTimeoutMs: 8000,
  });

  const OVERPASS = Object.freeze({
    instances: Object.freeze([
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.nchc.org.tw/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
    ]),
    defaultTimeoutMs: 15000,
    defaultRetries: 3,
    defaultBaseDelayMs: 250,
    defaultJitterMs: 100,
    defaultSectorSpanDeg: 0.005,
    maxSectors: 16,
  });

  const mapillaryCache = new Map();
  const overpassCache = new Map();

  function now() { return new Date().toISOString(); }

  function clampNumber(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function clampInt(value, lo, hi, fallback) {
    return Math.round(clampNumber(value, lo, hi, fallback));
  }

  function hostOf(url) {
    try { return new URL(String(url)).host; } catch (e) { return String(url).slice(0, 60); }
  }

  function redact(text, secret) {
    let s = String(text === null || text === undefined ? '' : text);
    if (secret) s = s.split(String(secret)).join('<redactado>');
    s = s.replace(/MLY\|[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)?/g, '<token>');
    return s.slice(0, 300);
  }

  function fetcher(options, label) {
    const o = options || {};
    const f = o.fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!f) throw new Error(label + ': este entorno no tiene fetch: inyectá options.fetch.');
    return f;
  }

  function normalizeCenter(center) {
    const c = center || {};
    const lat = Number(c.lat);
    const lon = Number(c.lon !== undefined ? c.lon : c.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function bboxAround(center, radiusMeters) {
    const c = normalizeCenter(center);
    if (!c) return null;
    const r = clampNumber(radiusMeters, 10, 20000, 1000);
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.max(0.01, Math.cos(c.lat * Math.PI / 180)));
    return [c.lon - dLon, c.lat - dLat, c.lon + dLon, c.lat + dLat];
  }

  function normalizeBbox(bbox) {
    if (Array.isArray(bbox)) {
      if (bbox.length !== 4) return null;
      return bbox.map(Number);
    }
    if (bbox && typeof bbox === 'object') {
      return [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].map(Number);
    }
    return null;
  }

  // Parte un bbox en sectores pequeños. Si hace falta más sectores que el tope,
  // falla con mensaje claro en vez de lanzar consultas gigantes a servicios públicos.
  function splitBboxIntoSectors(bbox, options) {
    const o = options || {};
    const b = normalizeBbox(bbox);
    if (!b || b.some(v => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3]) {
      throw new Error('BBox inválido: se espera [minLon, minLat, maxLon, maxLat].');
    }
    const maxSpan = clampNumber(o.maxSpanDeg, 0.0001, 0.009, MAPILLARY.bboxMaxSpanDeg);
    const maxSectors = clampInt(o.maxSectors, 1, 64, MAPILLARY.maxSectors);
    const nx = Math.ceil((b[2] - b[0]) / maxSpan);
    const ny = Math.ceil((b[3] - b[1]) / maxSpan);
    if (nx * ny > maxSectors) {
      throw new Error('BBox demasiado grande: ' + (nx * ny) + ' sectores supera el máximo de ' + maxSectors + '. Reducí el área.');
    }
    const stepX = (b[2] - b[0]) / nx;
    const stepY = (b[3] - b[1]) / ny;
    const sectors = [];
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const minLon = Number((b[0] + ix * stepX).toFixed(7));
        const minLat = Number((b[1] + iy * stepY).toFixed(7));
        const maxLon = ix === nx - 1 ? Number(b[2].toFixed(7)) : Number((b[0] + (ix + 1) * stepX).toFixed(7));
        const maxLat = iy === ny - 1 ? Number(b[3].toFixed(7)) : Number((b[1] + (iy + 1) * stepY).toFixed(7));
        sectors.push({ bbox: [minLon, minLat, maxLon, maxLat], index: sectors.length });
      }
    }
    return sectors;
  }

  // ---------------------------------------------------------------- Mapillary

  function envValue(name) {
    try {
      if (typeof process !== 'undefined' && process.env && process.env[name]) return String(process.env[name]);
    } catch (e) { /* entorno sin process */ }
    return null;
  }

  function localStorageValue() {
    try {
      const store = root.localStorage || (typeof window !== 'undefined' ? window.localStorage : null);
      return store && store.getItem ? store.getItem('mlyToken') : null;
    } catch (e) { return null; }
  }

  function resolveToken(options) {
    const o = options || {};
    let value = o.token;
    if (typeof value === 'string' && value.trim()) return { token: value.trim(), source: 'option' };
    value = (typeof globalThis !== 'undefined' ? globalThis.MLY_TOKEN : null) || root.MLY_TOKEN;
    if (typeof value === 'string' && value.trim()) return { token: value.trim(), source: 'global' };
    value = envValue('MLY_TOKEN');
    if (value && value.trim()) return { token: value.trim(), source: 'env' };
    value = localStorageValue();
    if (value && value.trim()) return { token: value.trim(), source: 'localStorage' };
    return { token: null, source: null };
  }

  function mapillaryConfig() {
    return {
      provider: 'mapillary',
      endpoint: MAPILLARY.endpoint,
      apiVersion: MAPILLARY.apiVersion,
      docsUrl: MAPILLARY.docsUrl,
      termsUrl: MAPILLARY.termsUrl,
      authentication: {
        header: 'Authorization',
        scheme: 'OAuth',
        example: 'Authorization: OAuth <MAPILLY_CLIENT_TOKEN>',
        note: 'El token se lee en cada llamada; nunca se escribe en código, URLs, caché ni resultados.',
      },
      tokenSources: [
        "searchMapillary(punto, { token: '<MAPILLY_CLIENT_TOKEN>' })",
        'globalThis.MLY_TOKEN = token',
        'process.env.MLY_TOKEN',
        "localStorage['mlyToken'] (solo navegador)",
      ],
      limits: {
        radiusMeters: MAPILLARY.maxRadiusMeters,
        limit: MAPILLARY.maxLimit,
        pages: MAPILLARY.maxPages,
        sectors: MAPILLARY.maxSectors,
        bboxMaxSpanDeg: MAPILLARY.bboxMaxSpanDeg,
      },
      attribution: MAPILLARY.attribution,
      license: 'No se inventa una licencia abierta: si la API no devuelve una, se declaran los Mapillary Terms of Use.',
    };
  }

  function statusMapillary(options) {
    const auth = resolveToken(options || {});
    return {
      provider: 'mapillary',
      ready: !!auth.token,
      status: auth.token ? 'ready' : 'pending-client',
      tokenSource: auth.source,
      detail: auth.token
        ? 'Token disponible; cliente Graph API v4 listo (Authorization: OAuth).'
        : 'Falta Client Token: no se simulan resultados. Ver mapillaryConfig().',
      endpoint: MAPILLARY.endpoint,
    };
  }

  function pendingMapillary(errors) {
    return {
      provider: 'mapillary',
      status: 'pending-client',
      ready: false,
      photos: [],
      errors: errors || [],
      areas: [],
      pages: 0,
      cached: false,
    };
  }

  function buildMapillaryUrl(params) {
    const url = new URL(MAPILLARY.endpoint);
    url.searchParams.set('fields', MAPILLARY.fields.join(','));
    url.searchParams.set('limit', String(params.limit));
    if (params.after) url.searchParams.set('after', String(params.after));
    if (params.bbox) {
      url.searchParams.set('bbox', params.bbox.join(','));
    } else {
      url.searchParams.set('lat', String(params.lat));
      url.searchParams.set('lng', String(params.lon));
      url.searchParams.set('radius', String(params.radius));
    }
    return url.toString();
  }

  // Aborta por señal y también por Promise.race por si un fetch inyectado ignora signal.
  async function requestJson(fetchImpl, url, init, options, label) {
    const o = options || {};
    const timeoutMs = clampInt(o.timeoutMs, 1, 120000, 8000);
    let controller = null;
    let signal = init.signal;
    if (!signal && typeof AbortController !== 'undefined') {
      controller = new AbortController();
      signal = controller.signal;
    }
    const effectiveInit = Object.assign({}, init);
    if (signal) effectiveInit.signal = signal;
    let timer = null;
    const timeoutError = Object.assign(new Error(label + ': timeout tras ' + timeoutMs + ' ms'), { kind: 'timeout' });
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([fetchImpl(url, effectiveInit), timeoutPromise]);
      const text = await Promise.race([
        Promise.resolve(response && typeof response.text === 'function' ? response.text() : ''),
        timeoutPromise,
      ]);
      const status = Number(response && response.status) || 0;
      let json = null;
      let parseError = null;
      try { json = text ? JSON.parse(text) : {}; } catch (e) { parseError = e; }
      const apiMessage = json ? apiErrorMessage(json, o.secret) : null;
      if (!response || !response.ok) {
        if (status === 429) {
          throw Object.assign(new Error(label + ': límite de solicitudes alcanzado (429). Reintentá más tarde.'),
            { kind: 'rate-limit', status: 429 });
        }
        const detail = apiMessage || redact(text, o.secret) || ('HTTP ' + status);
        const kind = status >= 500 || status === 408 ? 'service-error' : (status ? 'query-error' : 'network');
        throw Object.assign(new Error(label + ': ' + detail + ' (HTTP ' + status + ')'), { kind, status });
      }
      if (parseError) throw Object.assign(new Error(label + ': respuesta no JSON'), { kind: 'format' });
      if (o.checkApiErrors && apiMessage) {
        throw Object.assign(new Error(label + ' (GraphQL/API): ' + apiMessage), { kind: 'api-error' });
      }
      return json || {};
    } catch (e) {
      if (e === timeoutError) throw e;
      if (e && e.kind) throw e;
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
      if (aborted) throw Object.assign(new Error(label + ': fetch abortado'), { kind: 'timeout' });
      throw Object.assign(new Error(label + ': error de red: ' + redact(e && e.message || e, o.secret)),
        { kind: 'network' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function apiErrorMessage(json, secret) {
    if (!json || typeof json !== 'object') return null;
    if (Array.isArray(json.errors) && json.errors.length) {
      return json.errors.map(e => redact(e && e.message ? e.message : e, secret)).join('; ');
    }
    if (json.error) {
      const e = json.error;
      return redact(e && e.message ? e.message : e, secret);
    }
    if (json.message) return redact(json.message, secret);
    return null;
  }

  function distanceMeters(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function normalizeMapillaryPhoto(raw, center) {
    const g = (raw && (raw.computed_geometry || raw.geometry)) || {};
    const coords = Array.isArray(g.coordinates) ? g.coordinates : [];
    const lon = Number(coords[0]), lat = Number(coords[1]);
    if (!raw || !raw.id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const id = String(raw.id);
    const url = raw.thumb_original_url || raw.thumb_2048_url || raw.thumb_1024_url
      || raw.thumb_512_url || raw.thumb_256_url
      || ('https://www.mapillary.com/embed?image_key=' + encodeURIComponent(id) + '&style=photo');
    const captured = Number(raw.captured_at);
    const bearing = raw.computed_compass_angle !== undefined && raw.computed_compass_angle !== null
      ? Number(raw.computed_compass_angle) : Number(raw.compass_angle);
    return {
      id: 'mapillary:' + id,
      provider: 'mapillary',
      title: raw.sequence ? 'Mapillary · secuencia ' + String(raw.sequence) : null,
      url: String(url),
      thumbUrl: String(raw.thumb_512_url || raw.thumb_256_url || url),
      descriptionUrl: 'https://www.mapillary.com/app/?pKey=' + encodeURIComponent(id),
      lat, lon,
      time: Number.isFinite(captured) && captured > 0 ? new Date(captured).toISOString() : null,
      author: (raw.creator && (raw.creator.username || raw.creator.id))
        || (raw.organization && (raw.organization.name || raw.organization.slug)) || null,
      // La API no expone licencia abierta: no se inventa una.
      license: raw.license || raw.license_name || 'Mapillary Terms of Use',
      azimuth: Number.isFinite(bearing) ? bearing : null,
      isPano: raw.is_pano === true,
      distanceMeters: center ? distanceMeters(center, { lat, lon }) : null,
      provenance: 'observed',
      confidence: 0.8,
      visualVerified: false,
      attribution: MAPILLARY.attribution,
      source: {
        kind: 'mapillary-graph-v4',
        label: MAPILLARY.label,
        retrievedAt: now(),
        attribution: MAPILLARY.attribution,
        termsUrl: MAPILLARY.termsUrl,
      },
    };
  }

  function mapillaryAreas(center, options) {
    const o = options || {};
    if (normalizeBbox(o.bbox)) {
      return splitBboxIntoSectors(o.bbox, {
        maxSpanDeg: o.bboxMaxSpanDeg || MAPILLARY.bboxMaxSpanDeg,
        maxSectors: o.maxSectors || MAPILLARY.maxSectors,
      }).map(s => ({ mode: 'bbox', bbox: s.bbox }));
    }
    const radius = clampNumber(o.radiusMeters, 1, 20000, MAPILLARY.maxRadiusMeters);
    if (radius <= MAPILLARY.maxRadiusMeters && !o.forceBbox) {
      return [{ mode: 'radius', lat: center.lat, lon: center.lon, radius: Number(radius.toFixed(3)) }];
    }
    // Radius search llega hasta 50 m: para radios mayores se usan bboxes pequeños.
    const radiusDeg = bboxAround(center, Math.min(radius, 20000));
    return splitBboxIntoSectors(radiusDeg, {
      maxSpanDeg: o.bboxMaxSpanDeg || MAPILLARY.bboxMaxSpanDeg,
      maxSectors: o.maxSectors || MAPILLARY.maxSectors,
    }).map(s => ({ mode: 'bbox', bbox: s.bbox }));
  }

  function clearMapillaryCache() { mapillaryCache.clear(); }

  async function searchMapillary(center, options) {
    const o = options || {};
    const auth = resolveToken(o);
    if (!auth.token) {
      return pendingMapillary(['pending-client: falta Client Token de Mapillary. Configuralo con options.token, globalThis.MLY_TOKEN, process.env.MLY_TOKEN o localStorage.mlyToken; no se simulan resultados.']);
    }
    const c = normalizeCenter(center);
    if (!c) throw new Error('Mapillary: se necesita center.lat y center.lon válidos.');
    const fetchImpl = fetcher(o, 'Mapillary');
    const store = o.cache || mapillaryCache;
    const limit = clampInt(o.limit, 1, MAPILLARY.maxLimit, 50);
    const maxPages = clampInt(o.maxPages, 1, MAPILLARY.maxPages, 3);
    const pageSize = Math.min(100, limit, clampInt(o.pageSize, 1, 100, Math.min(100, limit)));
    const areas = mapillaryAreas(c, o);
    const photos = [], errors = [], seen = new Set();
    let pages = 0, cached = false;

    for (const area of areas) {
      let after = null;
      for (let page = 0; page < maxPages && photos.length < limit; page++) {
        const params = Object.assign({ limit: pageSize, after }, area);
        const url = buildMapillaryUrl(params);
        const key = 'mapillary:' + url;
        let payload = null;
        if (store.has(key)) {
          payload = store.get(key);
          cached = true;
        } else {
          try {
            const json = await requestJson(fetchImpl, url, {
              method: 'GET',
              headers: { Accept: 'application/json', Authorization: 'OAuth ' + auth.token },
            }, { timeoutMs: o.timeoutMs, secret: auth.token, checkApiErrors: true }, 'Mapillary');
            pages++;
            const normalized = (Array.isArray(json.data) ? json.data : [])
              .map(raw => normalizeMapillaryPhoto(raw, c)).filter(Boolean);
            payload = { photos: normalized, after: json.paging && json.paging.cursors && json.paging.cursors.after ? String(json.paging.cursors.after) : null };
            store.set(key, payload); // la clave no contiene el token
          } catch (e) {
            errors.push(redact(e && e.message || e, auth.token));
            break;
          }
        }
        for (const p of payload.photos) {
          if (photos.length >= limit) break;
          if (!seen.has(p.id)) { seen.add(p.id); photos.push(p); }
        }
        // La URL "next" del servicio puede traer access_token: nunca se sigue; se reconstruye con after.
        if (!payload.after) break;
        after = payload.after;
      }
    }

    if (!photos.length && errors.length) {
      throw new Error('Mapillary: ' + errors.join(' | '));
    }
    photos.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return {
      provider: 'mapillary',
      status: 'ready',
      ready: true,
      photos,
      errors,
      areas,
      pages,
      cached,
      tokenSource: auth.source,
    };
  }

  // ----------------------------------------------------------------- Overpass

  function sleepDefault(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function backoffDelay(attempt, options) {
    const o = options || {};
    const base = clampNumber(o.baseDelayMs, 0, 60000, OVERPASS.defaultBaseDelayMs);
    const exponential = base * Math.pow(2, attempt);
    const jitter = o.jitter === false ? 0
      : clampNumber(o.jitterMs, 0, 60000, OVERPASS.defaultJitterMs) * (o.random || Math.random)();
    return Math.round(exponential + jitter);
  }

  function buildOverpassQuery(bbox, options) {
    const o = options || {};
    const b = normalizeBbox(bbox);
    if (!b) throw new Error('BBox inválido para Overpass.');
    const tag = String(o.tag || 'highway').replace(/["';]/g, '');
    const timeout = clampInt(o.overpassTimeoutSec, 1, 180, 25);
    return '[out:json][timeout:' + timeout + '];(nwr["' + tag + '"](' + b.join(',') + '););out tags center;';
  }

  function normalizeInstances(instances) {
    const list = Array.isArray(instances) && instances.length ? instances : OVERPASS.instances;
    const out = [];
    for (const item of list) {
      const url = String(item || '').trim();
      if (url && !out.includes(url)) out.push(url);
    }
    if (!out.length) throw new Error('Overpass: no hay instancias configuradas.');
    return out;
  }

  async function overpassGet(query, options) {
    const o = options || {};
    if (!query || typeof query !== 'string') throw new Error('Overpass: se necesita una query QL.');
    const fetchImpl = fetcher(o, 'Overpass');
    const store = o.cache || overpassCache;
    const key = 'overpass:' + query;
    if (store.has(key)) return Object.assign({}, store.get(key), { cached: true });

    const instances = normalizeInstances(o.instances);
    const retries = clampInt(o.retries, 1, 6, OVERPASS.defaultRetries);
    const sleepImpl = typeof o.sleep === 'function' ? o.sleep : sleepDefault;
    const errors = [];
    let attempts = 0;

    instancesLoop:
    for (const instance of instances) {
      const label = 'Overpass ' + hostOf(instance);
      for (let attempt = 0; attempt < retries; attempt++) {
        attempts++;
        try {
          const json = await requestJson(fetchImpl, instance, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: 'data=' + encodeURIComponent(query),
          }, { timeoutMs: o.timeoutMs }, label);
          const elements = Array.isArray(json.elements) ? json.elements : [];
          const result = {
            elements,
            errors: errors.slice(),
            unavailable: false,
            empty: elements.length === 0,
            status: elements.length ? 'ok' : 'empty-result',
            instance,
            attempts,
            cached: false,
          };
          store.set(key, result);
          return result;
        } catch (e) {
          const status = e && e.status ? ' HTTP ' + e.status : '';
          const kind = e && e.kind === 'query-error' ? 'query-error' : 'service-error';
          const message = kind + ' ' + hostOf(instance) + status + ': ' + redact(e && e.message || e, null) + ' (intento ' + (attempt + 1 + '/' + retries) + ')';
          errors.push(message);
          if (kind === 'query-error') {
            return { elements: [], errors, unavailable: false, empty: false, status: 'query-error', instance, attempts, cached: false };
          }
          if (attempt + 1 < retries) await sleepImpl(backoffDelay(attempt, o));
        }
      }
    }
    // Nunca lanzar: degradar con detalle. 502 jamás se trató como "no hay datos".
    return { elements: [], errors, unavailable: true, empty: false, status: 'service-error', instance: null, attempts, cached: false };
  }

  function clearOverpassCache() { overpassCache.clear(); }

  async function overpassNear(lat, lon, options) {
    const o = options || {};
    const center = normalizeCenter({ lat, lon });
    if (!center) throw new Error('Overpass: coordenadas inválidas.');
    const radius = clampNumber(o.radiusMeters, 50, 10000, 1000);
    const sectors = splitBboxIntoSectors(bboxAround(center, radius), {
      maxSpanDeg: o.sectorSpanDeg || OVERPASS.defaultSectorSpanDeg,
      maxSectors: o.maxSectors || OVERPASS.maxSectors,
    });
    const store = o.cache || overpassCache;
    const elements = [], errors = [], seen = new Set();
    let responded = false, unavailableCount = 0, attempts = 0;

    for (const sector of sectors) {
      const query = buildOverpassQuery(sector.bbox, o);
      const r = await overpassGet(query, Object.assign({}, o, { cache: store }));
      attempts += r.attempts || 0;
      errors.push.apply(errors, (r.errors || []).map(msg => 'sector ' + sector.index + ': ' + msg));
      if (r.unavailable) unavailableCount++;
      else responded = true;
      for (const el of r.elements || []) {
        const id = String(el.type) + ':' + String(el.id);
        if (!seen.has(id)) { seen.add(id); elements.push(el); }
      }
    }
    const unavailable = sectors.length > 0 && !responded;
    return {
      elements,
      errors,
      unavailable,
      empty: elements.length === 0 && !unavailable,
      status: unavailable ? 'service-error' : (elements.length ? 'ok' : 'empty-result'),
      sectors: sectors.map(s => s.bbox),
      sectorCount: sectors.length,
      unavailableSectors: unavailableCount,
      attempts,
    };
  }

  const api = {
    MAPILLARY,
    OVERPASS,
    // Mapillary
    searchMapillary,
    statusMapillary,
    mapillaryConfig,
    buildMapillaryUrl,
    normalizeMapillaryPhoto,
    mapillaryAreas,
    clearMapillaryCache,
    // Overpass
    overpassGet,
    overpassNear,
    buildOverpassQuery,
    splitBboxIntoSectors,
    backoffDelay,
    clearOverpassCache,
    // compartido
    distanceMeters,
  };
  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
