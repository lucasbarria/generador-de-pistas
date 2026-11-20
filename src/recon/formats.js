// Lectores de recorridos reales: GPX, KML y GeoJSON.
// No redondean coordenadas y devuelven rutas separadas cuando el archivo trae varias.
(function (root) {
  'use strict';

  const MAX_POINTS = 200000;

  function attr(tag, name) {
    const m = new RegExp('\\b' + name + '\\s*=\\s*(["\'])\\s*([-+0-9.Ee]+)\\s*\\1', 'i').exec(tag || '');
    return m ? Number(m[2]) : null;
  }

  function tagText(body, name) {
    const m = new RegExp('\\<(?:[\\w-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?' + name + '\\>', 'i').exec(body || '');
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
  }

  function point(lat, lon, ele, time, name) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const e = ele === null || ele === undefined || ele === '' ? null : Number(ele);
    return {
      lat,
      lon,
      ele: Number.isFinite(e) ? e : null,
      time: time || null,
      name: name || null,
    };
  }

  function parseGpx(text) {
    const routes = [], warnings = [];
    const tracks = [...text.matchAll(/\<(?:[\w-]+:)?trk\b[^>]*>([\s\S]*?)\<\/(?:[\w-]+:)?trk\>/gi)].map(m => m[1]);
    const blocks = [];
    if (tracks.length) {
      for (const trk of tracks) {
        const name = tagText(trk, 'name');
        const segs = [...trk.matchAll(/\<(?:[\w-]+:)?trkseg\b[^>]*>([\s\S]*?)\<\/(?:[\w-]+:)?trkseg\>/gi)];
        if (segs.length) segs.forEach(m => blocks.push({ body: m[1], name }));
        else blocks.push({ body: trk, name });
      }
    } else blocks.push({ body: text, name: tagText(text, 'name') });
    for (const seg of blocks) {
      const pts = [];
      const re = /\<(?:[\w-]+:)?(trkpt|rtept|wpt)\b([^>]*?)(?:\/\s*>|\>([\s\S]*?)\<\/(?:[\w-]+:)?\1\>)/gi;
      for (const m of seg.body.matchAll(re)) {
        if (pts.length >= MAX_POINTS) { warnings.push('Se alcanzó el límite de puntos por ruta.'); break; }
        const p = point(attr(m[2], 'lat'), attr(m[2], 'lon'), tagText(m[3], 'ele'), tagText(m[3], 'time'), tagText(m[3], 'name'));
        if (!p) { warnings.push('Se descartó un punto GPX con coordenadas fuera de rango.'); continue; }
        pts.push(p);
      }
      if (pts.length > 1) routes.push({ name: seg.name || tagText(seg.body, 'name') || null, points: pts, sourceFormat: 'gpx' });
    }
    if (!routes.length) warnings.push('El GPX no tiene un segmento con al menos dos puntos válidos.');
    return { format: 'gpx', routes, warnings };
  }

  function parseKml(text) {
    const routes = [], warnings = [];
    for (const m of text.matchAll(/\<(?:[\w-]+:)?LineString\b[^>]*>([\s\S]*?)\<\/(?:[\w-]+:)?LineString\>/gi)) {
      const pts = [];
      for (const c of m[1].matchAll(/\<(?:[\w-]+:)?coordinates\b[^>]*>([\s\S]*?)\<\/(?:[\w-]+:)?coordinates\>/gi)) {
        for (const token of c[1].trim().split(/\s+/)) {
          if (!token) continue;
          const v = token.split(',').map(Number);
          if (v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) { warnings.push('Se descartó una coordenada KML no válida.'); continue; }
          const p = point(v[1], v[0], v.length > 2 ? v[2] : null, null, null);
          if (p) pts.push(p);
          if (pts.length >= MAX_POINTS) { warnings.push('Se alcanzó el límite de puntos por ruta.'); break; }
        }
      }
      if (pts.length > 1) routes.push({ name: null, points: pts, sourceFormat: 'kml' });
    }
    // gx:Track: cada gx:coord es "lon lat alt" (KML con datos de cámara/GPS).
    for (const m of text.matchAll(/\<(?:[\w-]+:)?Track\b[^>]*>([\s\S]*?)\<\/(?:[\w-]+:)?Track\>/gi)) {
      const pts = [];
      for (const c of m[1].matchAll(/\<(?:[\w-]+:)?coord\b[^>]*>([\s\S]*?)\<\/(?:[\w-]+:)?coord\>/gi)) {
        const v = c[1].trim().split(/\s+/).map(Number);
        const p = v.length >= 2 ? point(v[1], v[0], v[2], tagText(c[1], 'when'), null) : null;
        if (p) pts.push(p);
      }
      if (pts.length > 1) routes.push({ name: tagText(m[1], 'name'), points: pts, sourceFormat: 'kml-gx-track' });
    }
    if (!routes.length) warnings.push('El KML no tiene una LineString con al menos dos coordenadas válidas.');
    return { format: 'kml', routes, warnings };
  }

  function parseGeoJson(text) {
    const routes = [], warnings = [];
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('GeoJSON no válido: ' + e.message); }
    const walk = (g, name) => {
      if (!g) return;
      if (g.type === 'FeatureCollection') { (g.features || []).forEach(f => walk(f.geometry, f.properties && f.properties.name)); return; }
      if (g.type === 'Feature') { walk(g.geometry, g.properties && g.properties.name); return; }
      if (g.type === 'GeometryCollection') { (g.geometries || []).forEach(x => walk(x, name)); return; }
      let lines = null;
      if (g.type === 'LineString') lines = [g.coordinates];
      else if (g.type === 'MultiLineString') lines = g.coordinates;
      if (!lines) return;
      for (const line of lines || []) {
        const pts = [];
        for (const c of line) {
          const p = Array.isArray(c) ? point(c[1], c[0], c[2], null, null) : null;
          if (p) pts.push(p);
          if (pts.length >= MAX_POINTS) break;
        }
        if (pts.length > 1) routes.push({ name: name || null, points: pts, sourceFormat: 'geojson' });
      }
    };
    walk(j, null);
    if (!routes.length) warnings.push('El GeoJSON no tiene LineString/MultiLineString con al menos dos puntos.');
    return { format: 'geojson', routes, warnings };
  }

  function parseRouteText(text, filename) {
    const t = String(text || '');
    if (!t.trim()) throw new Error('El archivo está vacío.');
    let out;
    if (/<gpx\b/i.test(t)) out = parseGpx(t);
    else if (/<kml\b/i.test(t) || /<coordinates\b/i.test(t)) out = parseKml(t);
    else if (/^\s*[{[]/.test(t)) out = parseGeoJson(t);
    else throw new Error('Formato no reconocido (se esperaba GPX, KML o GeoJSON): ' + (filename || 'archivo'));
    out.filename = filename || null;
    out.primary = out.routes.length ? out.routes.reduce((best, r, i) => (r.points.length > out.routes[best].points.length ? i : best), 0) : -1;
    return out;
  }

  function toLegacyPath(points) {
    return (points || []).map(p => {
      const lat = p.lat !== undefined ? p.lat : p[0];
      const lon = p.lon !== undefined ? p.lon : p[1];
      // Sin toFixed: conservamos los decimales originales del archivo o del mapa.
      return 'f:' + Number(lat) + ',' + Number(lon);
    });
  }

  const api = { parseRouteText, parseGpx, parseKml, parseGeoJson, toLegacyPath };
  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
