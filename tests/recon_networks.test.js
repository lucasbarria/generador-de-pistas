const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('../src/recon/networks.js');

const CENTER = { lat: -54.6266558, lon: -67.2432701 };
const TOKEN = 'MLY|TEST|abc123secret';

function okJson(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
}

function rawImage(id, lon, lat, capturedAt) {
  return {
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    captured_at: capturedAt,
    creator: { username: 'ana' },
    thumb_512_url: 'https://images.test/' + id + '.jpg',
  };
}

test('Mapillary sin token: pending-client, sin llamadas de red ni resultados simulados', async () => {
  const savedEnv = process.env.MLY_TOKEN;
  const savedGlobal = globalThis.MLY_TOKEN;
  delete process.env.MLY_TOKEN;
  delete globalThis.MLY_TOKEN;
  try {
    const status = N.statusMapillary();
    assert.equal(status.ready, false);
    assert.equal(status.status, 'pending-client');
    assert.equal(status.tokenSource, null);

    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('no debió llamarse'); };
    const result = await N.searchMapillary(CENTER, { fetch: fetchImpl, cache: new Map() });
    assert.equal(calls, 0);
    assert.equal(result.ready, false);
    assert.equal(result.status, 'pending-client');
    assert.deepEqual(result.photos, []);
    assert.match(result.errors[0], /pending-client/);
    assert.doesNotMatch(result.errors[0], /secreto/);
    assert.match(N.mapillaryConfig().authentication.note, /nunca se escribe/);
  } finally {
    if (savedEnv === undefined) delete process.env.MLY_TOKEN; else process.env.MLY_TOKEN = savedEnv;
    if (savedGlobal === undefined) delete globalThis.MLY_TOKEN; else globalThis.MLY_TOKEN = savedGlobal;
  }
});

test('Mapillary con token: Graph API v4, normalización, paginación por after y caché', async () => {
  const captured = Date.parse('2024-05-01T12:00:00.000Z');
  const calls = [];
  const pages = {
    first: {
      data: [rawImage('1', CENTER.lon + 0.001, CENTER.lat, captured)],
      paging: { cursors: { after: 'CUR2' }, next: 'https://graph.mapillary.com/images?after=CUR2&access_token=SECRETO_DEL_NEXT' },
    },
    second: {
      data: [rawImage('2', CENTER.lon - 0.0005, CENTER.lat, captured)],
      paging: { cursors: { after: 'CUR3' } },
    },
    third: { data: [rawImage('3', CENTER.lon, CENTER.lat + 0.0005, captured)] },
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    assert.equal(u.host, 'graph.mapillary.com');
    assert.equal(init.headers.Authorization, 'OAuth ' + TOKEN);
    assert.match(u.searchParams.get('fields'), /thumb_original_url/);
    assert.equal(u.searchParams.get('radius'), '25');
    const after = u.searchParams.get('after');
    return okJson(!after ? pages.first : after === 'CUR2' ? pages.second : pages.third);
  };

  const ready = N.statusMapillary({ token: TOKEN });
  assert.equal(ready.ready, true);
  assert.equal(ready.tokenSource, 'option');
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(TOKEN.replace(/\|/g, '\\|')));

  const cache = new Map();
  const options = { token: TOKEN, fetch: fetchImpl, cache, radiusMeters: 25, limit: 3, pageSize: 1, maxPages: 3 };
  const result = await N.searchMapillary(CENTER, options);

  assert.equal(calls.length, 3, 'debió pedir 3 páginas con cursor');
  assert.equal(new URL(calls[1].url).searchParams.get('after'), 'CUR2');
  assert.equal(new URL(calls[2].url).searchParams.get('after'), 'CUR3');
  assert.ok(!calls.some(c => c.url.includes(TOKEN) || c.url.includes('SECRETO_DEL_NEXT')), 'el token nunca va en la URL');
  assert.equal(result.pages, 3);
  assert.equal(result.photos.length, 3);
  assert.deepEqual(new Set(result.photos.map(p => p.id)), new Set(['mapillary:1', 'mapillary:2', 'mapillary:3']));
  const distances = result.photos.map(p => p.distanceMeters);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'se ordenan por distancia al punto');
  const first = result.photos.find(p => p.id === 'mapillary:1');
  assert.equal(first.provider, 'mapillary');
  assert.equal(first.url, 'https://images.test/1.jpg');
  assert.equal(first.lat, CENTER.lat);
  assert.equal(first.license, 'Mapillary Terms of Use');
  assert.equal(first.attribution, N.MAPILLARY.attribution);
  assert.equal(first.provenance, 'observed');
  assert.equal(first.visualVerified, false);
  assert.equal(first.time, new Date(captured).toISOString());
  assert.ok(first.distanceMeters < 200);
  assert.doesNotMatch(JSON.stringify(result), /abc123secret|SECRETO_DEL_NEXT/);
  assert.doesNotMatch([...cache.keys()].join(' '), /abc123secret|SECRETO_DEL_NEXT/);

  const again = await N.searchMapillary(CENTER, options);
  assert.equal(calls.length, 3, 'la segunda búsqueda salió toda de caché');
  assert.equal(again.cached, true);
  assert.equal(again.photos.length, 3);
});

test('Mapillary: errores GraphQL errors[] se reportan con claridad', async () => {
  const fetchImpl = async () => okJson({ errors: [{ message: 'Campo inexistente solicitado' }], data: null });
  await assert.rejects(
    () => N.searchMapillary(CENTER, { token: TOKEN, fetch: fetchImpl, cache: new Map() }),
    /GraphQL|Campo inexistente solicitado/,
  );
});

test('Mapillary: 429 se distingue como límite de solicitudes', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 429,
    text: async () => JSON.stringify({ error: { message: 'Application request limit reached' } }),
  });
  await assert.rejects(
    () => N.searchMapillary(CENTER, { token: TOKEN, fetch: fetchImpl, cache: new Map() }),
    /429.*límite|límite.*429/i,
  );
});

test('Overpass: 502 reintenta con backoff y sigue en otra instancia', async () => {
  const calls = [], sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('a.test')) return { ok: false, status: 502, text: async () => 'bad gateway' };
    return okJson({ elements: [{ type: 'node', id: 7, lat: CENTER.lat, lon: CENTER.lon }] });
  };
  const result = await N.overpassGet('[out:json];node(1,2,3,4);out;', {
    fetch: fetchImpl,
    instances: ['https://a.test/api/interpreter', 'https://b.test/api/interpreter'],
    retries: 2,
    baseDelayMs: 10,
    jitter: false,
    cache: new Map(),
    sleep: async ms => { sleeps.push(ms); },
  });
  assert.equal(result.elements.length, 1);
  assert.equal(result.unavailable, false);
  assert.equal(result.status, 'ok');
  assert.equal(result.errors.length, 2, 'los 502 se conservan como service-error');
  assert.match(result.errors[0], /service-error.*502/);
  assert.deepEqual(sleeps, [10], 'backoff exponencial: primer reintento a 10 ms');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /data=/);
});

test('Overpass: todas las instancias fallan → unavailable true con errores detallados', async () => {
  const sleeps = [];
  const fetchImpl = async url => {
    if (url.includes('a.test')) return { ok: false, status: 502, text: async () => 'bad gateway' };
    throw new Error('network down');
  };
  const result = await N.overpassGet('[out:json];node(1,2,3,4);out;', {
    fetch: fetchImpl,
    instances: ['https://a.test/api/interpreter', 'https://b.test/api/interpreter'],
    retries: 2,
    baseDelayMs: 5,
    jitter: false,
    cache: new Map(),
    sleep: async ms => { sleeps.push(ms); },
  });
  assert.deepEqual(result.elements, []);
  assert.equal(result.unavailable, true);
  assert.equal(result.empty, false, 'un 502 no es "sin datos"');
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some(e => /service-error.*502/.test(e)));
  assert.ok(result.errors.some(e => /network down/.test(e)));
  assert.deepEqual(sleeps, [5, 5]);
});

test('Overpass: 200 con elements vacíos → unavailable false y empty true', async () => {
  const result = await N.overpassGet('[out:json];node(1,2,3,4);out;', {
    fetch: async () => okJson({ elements: [] }),
    instances: ['https://a.test/api/interpreter'],
    cache: new Map(),
  });
  assert.deepEqual(result.elements, []);
  assert.equal(result.unavailable, false);
  assert.equal(result.empty, true);
  assert.equal(result.status, 'empty-result');
  assert.deepEqual(result.errors, []);
});

test('Overpass: caché evita la segunda llamada', async () => {
  let calls = 0;
  const options = {
    fetch: async () => { calls++; return okJson({ elements: [{ type: 'way', id: 9 }] }); },
    instances: ['https://a.test/api/interpreter'],
    cache: new Map(),
  };
  const first = await N.overpassGet('[out:json];way(1,2,3,4);out;', options);
  const second = await N.overpassGet('[out:json];way(1,2,3,4);out;', options);
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.elements, first.elements);
});

test('Overpass cerca de un punto: divide en sectores pequeños', async () => {
  let calls = 0;
  const result = await N.overpassNear(CENTER.lat, CENTER.lon, {
    radiusMeters: 600,
    sectorSpanDeg: 0.005,
    maxSectors: 12,
    retries: 1,
    cache: new Map(),
    fetch: async (url, init) => {
      calls++;
      assert.equal(new URL(url).host, 'a.test');
      assert.match(init.body, /data=/);
      return okJson({ elements: [] });
    },
    instances: ['https://a.test/api/interpreter'],
  });
  assert.ok(result.sectorCount >= 4, 'el radio de 1.2 km debe partirse en varios sectores');
  assert.equal(calls, result.sectorCount);
  assert.ok(result.sectors.every(b => b[2] - b[0] <= 0.0051 && b[3] - b[1] <= 0.0051));
  assert.equal(result.unavailable, false);
  assert.equal(result.empty, true);
});
