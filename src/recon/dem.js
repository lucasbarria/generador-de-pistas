// Cliente real de elevación: Open-Meteo Elevation API (Copernicus DEM GLO-90, 90 m).
// Sin credenciales para uso no comercial. La resolución NEVER se disfraza de precisión centimétrica.
(function (root) {
  'use strict';

  const PROVIDER = Object.freeze({
    id: 'open-meteo',
    label: 'Open-Meteo Elevation API',
    dataset: 'Copernicus DEM 2021 GLO-90',
    resolutionMeters: 90,
    endpoint: 'https://api.open-meteo.com/v1/elevation',
    attribution: 'Elevación: Copernicus DEM GLO-90 vía Open-Meteo (CC-BY 4.0 por Copernicus; uso no comercial en el endpoint público).',
    citation: 'https://doi.org/10.5270/ESA-c5d3d65',
    maxBatch: 100,
  });

  const cache = new Map();

  function keyOf(lat, lon) { return Number(lat) + ',' + Number(lon); }

  function buildUrl(batch) {
    const lats = batch.map(p => Number(p.lat)).join(',');
    const lons = batch.map(p => Number(p.lon)).join(',');
    return PROVIDER.endpoint + '?latitude=' + encodeURIComponent(lats) + '&longitude=' + encodeURIComponent(lons);
  }

  function normalize(raw) {
    const lat = Number(raw && (raw.lat !== undefined ? raw.lat : raw[0]));
    const lon = Number(raw && (raw.lon !== undefined ? raw.lon : raw[1]));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error('Coordenada no válida para elevación: ' + JSON.stringify(raw));
    }
    return { lat, lon };
  }

  // Obtiene elevaciones reales para cada punto del recorrido. Devuelve procedencia por muestra.
  async function sampleElevations(points, options) {
    const o = options || {};
    const fetchImpl = o.fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!fetchImpl) throw new Error('Este entorno no tiene fetch: inyectá options.fetch.');
    const list = (points || []).map(normalize);
    if (!list.length) return { samples: [], meta: null };
    const batchSize = Math.max(1, Math.min(PROVIDER.maxBatch, o.batchSize || PROVIDER.maxBatch));
    const store = o.cache || cache;
    const samples = new Array(list.length).fill(null);
    const pending = [];
    const seen = new Map();
    list.forEach((p, i) => {
      const k = keyOf(p.lat, p.lon);
      if (store.has(k)) { samples[i] = store.get(k); return; }
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(i);
    });
    const unique = [...seen.values()].map(indices => indices[0]);
    for (let i = 0; i < unique.length; i += batchSize) pending.push(unique.slice(i, i + batchSize));

    let lastUrl = null;
    for (const idx of pending) {
      const batch = idx.map(i => list[i]);
      const url = buildUrl(batch);
      lastUrl = url;
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('Open-Meteo devolvió una respuesta no JSON: ' + text.slice(0, 120)); }
      if (!response.ok || json.error) throw new Error('Open-Meteo: ' + (json.reason || ('HTTP ' + response.status)));
      const values = json.elevation;
      if (!Array.isArray(values) || values.length !== batch.length) throw new Error('Open-Meteo devolvió ' + (values && values.length) + ' alturas para ' + batch.length + ' puntos.');
      const retrievedAt = new Date().toISOString();
      idx.forEach((originalIndex, j) => {
        const e = Number(values[j]);
        if (!Number.isFinite(e)) throw new Error('Open-Meteo devolvió una altura no numérica.');
        const sample = {
          lat: list[originalIndex].lat,
          lon: list[originalIndex].lon,
          elevation: e,
          provenance: 'measured',
          confidence: 0.9,
          source: {
            kind: 'dem',
            provider: PROVIDER.id,
            label: PROVIDER.label,
            dataset: PROVIDER.dataset,
            resolutionMeters: PROVIDER.resolutionMeters,
            url,
            retrievedAt,
            attribution: PROVIDER.attribution,
          },
        };
        const duplicates = seen.get(keyOf(sample.lat, sample.lon)) || [originalIndex];
        duplicates.forEach(k => { samples[k] = sample; });
        store.set(keyOf(sample.lat, sample.lon), sample);
      });
    }
    return {
      samples: samples.filter(Boolean),
      meta: {
        provider: PROVIDER.id,
        label: PROVIDER.label,
        dataset: PROVIDER.dataset,
        resolutionMeters: PROVIDER.resolutionMeters,
        attribution: PROVIDER.attribution,
        citation: PROVIDER.citation,
        url: lastUrl,
        fetchedAt: new Date().toISOString(),
      },
    };
  }

  function clearCache() { cache.clear(); }

  const api = { PROVIDER, sampleElevations, buildUrl, clearCache, keyOf };
  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
