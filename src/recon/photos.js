// Búsqueda real de fotografías georreferenciadas.
// Wikimedia Commons y Panoramax funcionan sin credenciales. Mapillary usa el cliente REST v4
// de networks.js: sin Client Token devuelve pending-client y NUNCA resultados simulados.
(function (root) {
  'use strict';

  const SOURCES = Object.freeze({
    commons: {
      label: 'Wikimedia Commons',
      endpoint: 'https://commons.wikimedia.org/w/api.php',
      attribution: 'Fotos: Wikimedia Commons, según la licencia de cada archivo.',
    },
    panoramax: {
      label: 'Panoramax',
      endpoint: 'https://api.panoramax.xyz/api/search',
      attribution: 'Fotos: Panoramax, según la licencia de cada imagen.',
    },
    mapillary: {
      label: 'Mapillary',
      status: 'pending-client',
      reason: 'Requiere Client Token. El cliente Graph API v4 está en networks.js; sin token no se simulan resultados.',
    },
  });

  function fetcher(options) {
    const f = (options || {}).fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!f) throw new Error('Este entorno no tiene fetch: inyectá options.fetch.');
    return f;
  }

  function stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }

  async function getJson(fetchImpl, url) {
    const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('Respuesta no JSON de ' + new URL(url).host + ': ' + text.slice(0, 100)); }
    if (!r.ok || j.error) throw new Error('Fallo en ' + new URL(url).host + ': ' + (j.reason || j.error || 'HTTP ' + r.status));
    return j;
  }

  function distanceMeters(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  async function searchCommons(center, options) {
    const o = options || {}, f = fetcher(o), radius = Math.max(50, Math.min(10000, o.radiusMeters || 1000)), limit = Math.max(1, Math.min(50, o.limit || 20));
    const url = SOURCES.commons.endpoint + '?action=query&generator=geosearch'
      + '&ggsprimary=all&ggsnamespace=6&ggsradius=' + encodeURIComponent(radius)
      + '&ggscoord=' + encodeURIComponent(center.lat + '|' + center.lon)
      + '&prop=coordinates|imageinfo&iiprop=url|extmetadata&iilimit=1&format=json&origin=*';
    const j = await getJson(f, url);
    const pages = j.query && j.query.pages ? Object.values(j.query.pages) : [];
    const photos = [];
    for (const page of pages) {
      const c = page.coordinates && page.coordinates[0], info = page.imageinfo && page.imageinfo[0];
      if (!c || !info || !info.url) continue;
      const meta = info.extmetadata || {};
      photos.push({
        id: 'commons:' + page.pageid,
        provider: 'commons',
        title: page.title || null,
        url: String(info.url).split('?')[0],
        descriptionUrl: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(page.title || '').replace(/^File:/, 'File:')),
        thumbUrl: info.thumburl || String(info.url).split('?')[0],
        lat: Number(c.lat), lon: Number(c.lon),
        time: meta.DateTime ? stripHtml(meta.DateTime.value) : null,
        author: meta.Artist ? stripHtml(meta.Artist.value) : null,
        license: meta.LicenseShortName ? stripHtml(meta.LicenseShortName.value) : (meta.License ? stripHtml(meta.License.value) : null),
        distanceMeters: distanceMeters(center, { lat: Number(c.lat), lon: Number(c.lon) }),
        provenance: 'observed',
        confidence: 0.8,
        visualVerified: false,
        attribution: SOURCES.commons.attribution,
      });
    }
    return photos.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, limit);
  }

  async function searchPanoramax(center, options) {
    const o = options || {}, f = fetcher(o), radius = Math.max(50, Math.min(10000, o.radiusMeters || 1000)), limit = Math.max(1, Math.min(50, o.limit || 20));
    const dLat = radius / 111320, dLon = radius / (111320 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180)));
    const bbox = [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat].map(v => Number(v.toFixed(7))).join(',');
    const url = SOURCES.panoramax.endpoint + '?bbox=' + encodeURIComponent(bbox) + '&limit=' + encodeURIComponent(limit);
    const j = await getJson(f, url);
    return (j.features || []).map(feature => {
      const c = feature.geometry && feature.geometry.coordinates, p = feature.properties || {};
      const lat = c && Number(c[1]), lon = c && Number(c[0]);
      return {
        id: 'panoramax:' + feature.id,
        provider: 'panoramax',
        title: p['original_file:name'] || null,
        url: (p['geovisio:image'] || (feature.assets && feature.assets.hd && feature.assets.hd.href) || '').split('?')[0],
        thumbUrl: (p['geovisio:thumbnail'] || (feature.assets && feature.assets.thumb && feature.assets.thumb.href) || '').split('?')[0],
        lat, lon,
        time: p.datetime || null,
        author: p['geovisio:producer'] || null,
        license: p.license || null,
        azimuth: Number(p['view:azimuth']) || null,
        distanceMeters: distanceMeters(center, { lat, lon }),
        provenance: 'observed',
        confidence: 0.8,
        visualVerified: false,
        attribution: SOURCES.panoramax.attribution,
      };
    }).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon) && x.url).slice(0, limit);
  }

  function status(token) {
    const R = root.Reconstruction || {};
    const mly = typeof R.statusMapillary === 'function'
      ? R.statusMapillary({ token })
      : { ready: false, status: 'pending-client', detail: SOURCES.mapillary.reason };
    return [
      { provider: 'commons', ready: true, detail: 'geosearch + imageinfo, sin credenciales' },
      { provider: 'panoramax', ready: true, detail: 'STAC /api/search?bbox=…, sin credenciales' },
      { provider: 'mapillary', ready: !!mly.ready, status: mly.status, detail: mly.detail },
    ];
  }

  // Toma pocas muestras del recorrido para no saturar los servicios públicos.
  async function searchAlongRoute(points, options) {
    const o = options || {}, pts = points || [];
    if (!pts.length) return { photos: [], errors: [], sampled: [] };
    const maxSamples = Math.max(1, Math.min(12, o.maxSamples || 6));
    const step = Math.max(1, Math.floor(pts.length / maxSamples));
    const sampled = [];
    for (let i = 0; i < pts.length && sampled.length < maxSamples; i += step) sampled.push({ lat: Number(pts[i].lat), lon: Number(pts[i].lon) });
    const photos = [], errors = [], seen = new Set();
    const providers = o.providers || ['commons', 'panoramax'];
    const R = root.Reconstruction || {};
    for (const point of sampled) {
      for (const provider of providers) {
        try {
          let found = [];
          if (provider === 'commons') found = await searchCommons(point, o);
          else if (provider === 'panoramax') found = await searchPanoramax(point, o);
          else if (provider === 'mapillary') {
            if (typeof R.searchMapillary !== 'function') throw new Error('cliente Mapillary no disponible en este entorno');
            const r = await R.searchMapillary(point, o);
            found = r.photos || [];
            (r.errors || []).forEach(msg => errors.push('mapillary: ' + msg));
          }
          for (const p of found) { if (!seen.has(p.id)) { seen.add(p.id); photos.push(p); } }
        } catch (e) { errors.push(provider + ': ' + e.message); }
      }
    }
    return { photos, errors, sampled };
  }

  const api = { SOURCES, searchCommons, searchPanoramax, searchAlongRoute, status, distanceMeters };
  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
