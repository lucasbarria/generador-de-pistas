const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../src/recon/model.js');
const E = require('../src/recon/evidence.js');

const ROOT = path.join(__dirname, '..');

function projectWithApprovedPhoto(overrides) {
  const o = overrides || {};
  const p = M.blankProject();
  const photo = M.addPhoto(p, Object.assign({
    id: 'commons:42',
    provider: 'commons',
    url: 'https://upload.test/42.jpg',
    author: 'A. Pérez',
    license: 'CC BY-SA 4.0',
    date: '2026-11-20',
    time: '2026-11-20T10:00:00Z',
    resolution: '4000x3000',
    lat: -54.6266558,
    lon: -67.2432701,
    visualVerified: false,
  }, o.photo || {}));
  const review = E.reviewPhoto(p, photo.id, Object.assign({
    approved: true,
    materialClass: 'ripio',
    vegetationClass: 'lenga',
    sector: { d0: 100, d1: 200 },
    reviewer: 'Lucas',
    reviewedAt: '2026-11-20T12:00:00Z',
    notes: 'Revisado en el costado de la RP-27.',
  }, o.decision || {}));
  return { p, photo, review };
}

test('licencia no permitida: rechazo con error claro y registro rejected', () => {
  const p = M.blankProject();
  const photo = M.addPhoto(p, {
    id: 'commons:bad', provider: 'commons', url: 'https://upload.test/bad.jpg',
    lat: -54.62, lon: -67.24, license: 'All Rights Reserved', author: 'X',
  });

  assert.throws(
    () => E.reviewPhoto(p, photo.id, { approved: true, materialClass: 'ripio', reviewer: 'Lucas' }),
    /no figura entre las licencias aceptables/i,
  );
  assert.equal(p.evidence.reviews.length, 1);
  assert.equal(p.evidence.reviews[0].status, 'rejected');
  assert.match(p.evidence.reviews[0].reason, /licencia/i);
  assert.equal(photo.visualVerified, false);
});

test('Mapillary queda excluido por defecto, pero allowedLicenses es configurable', () => {
  const p = M.blankProject();
  const photo = M.addPhoto(p, {
    id: 'mapillary:1', provider: 'mapillary', url: 'https://images.test/1.jpg',
    lat: -54.63, lon: -67.25, license: 'Mapillary Terms', author: 'Y',
  });
  const decision = { approved: true, materialClass: 'ripio', reviewer: 'Lucas', sector: { d0: 0, d1: 50 } };

  assert.throws(() => E.reviewPhoto(p, photo.id, decision), /excluida/i);
  assert.equal(E.summaryEvidence(p).licensePolicy.mapillaryAllowed, false);

  const r = E.reviewPhoto(p, photo.id, decision, {
    allowedLicenses: [{ id: 'Mapillary Terms', label: 'Permiso explícito del titular', pattern: '^mapillary', allowed: true }],
  });
  assert.equal(r.status, 'approved');
  assert.equal(p.evidence.config.allowedLicenses.find(x => x.id === 'Mapillary Terms').allowed, true);
  assert.equal(E.summaryEvidence(p).licensePolicy.mapillaryAllowed, true);
});

test('review aprobado conserva autor/licencia/fecha/coordenadas y NO marca visualVerified solo', () => {
  const { photo, review } = projectWithApprovedPhoto();

  assert.equal(review.status, 'approved');
  assert.equal(review.photo.author, 'A. Pérez');
  assert.equal(review.photo.license, 'CC BY-SA 4.0');
  assert.equal(review.photo.date, '2026-11-20');
  assert.equal(review.photo.lat, -54.6266558);
  assert.equal(review.photo.lon, -67.2432701);
  assert.equal(review.photo.resolution, '4000x3000');
  assert.equal(review.photo.locationKind, 'coords');
  assert.equal(review.reviewer, 'Lucas');
  assert.equal(review.reviewedAt, '2026-11-20T12:00:00Z');
  assert.equal(review.sector.d0, 100);
  assert.equal(review.sector.d1, 200);
  assert.equal(review.provenance, 'observed');
  assert.equal(review.source.kind, 'photo-review');
  assert.equal(review.source.license, 'CC BY-SA 4.0');
  assert.equal(review.visualVerifiedRequested, false);
  assert.equal(review.visualVerifiedApplied, false);
  assert.equal(photo.visualVerified, false, 'aprobar una revisión no verifica visualmente la foto');

  const other = M.blankProject();
  const otherPhoto = M.addPhoto(other, {
    id: 'commons:explicit', provider: 'commons', url: 'https://upload.test/explicit.jpg',
    lat: -54.62, lon: -67.24, license: 'CC0', visualVerified: false,
  });
  const explicit = E.reviewPhoto(other, otherPhoto.id, {
    approved: true, materialClass: 'tierra', reviewer: 'Lucas', visualVerified: true,
    sector: { d0: 0, d1: 10 },
  });
  assert.equal(explicit.visualVerifiedApplied, true);
  assert.equal(otherPhoto.visualVerified, true, 'solo el true explícito marca la foto');
});

test('deriveMaterials usa un preset real del repo y no genera textura alguna', () => {
  const { p, review } = projectWithApprovedPhoto();
  const materials = E.deriveMaterials(p);

  assert.equal(materials.length, 1);
  assert.equal(materials.textureDerivation, E.TEXTURE_DERIVATION);
  assert.equal(materials.generatedTextures, 0);
  assert.equal(materials[0].materialClass, 'ripio');
  assert.equal(materials[0].presetMaterial, E.MATERIAL_CLASS_BY_ID.ripio.presetMaterial);
  assert.ok(
    fs.existsSync(path.join(ROOT, materials[0].presetMaterial)),
    'el presetMaterial debe ser un archivo real: ' + materials[0].presetMaterial,
  );
  assert.match(materials[0].presetMaterial, /^presets\/pisos\/ripio_rio_grande\/texturas\//);
  assert.equal(materials[0].textureDerivation, 'none-reviewed-assignment');
  assert.equal(materials[0].generatedTextures, 0);
  assert.equal(materials[0].provenance, 'observed');
  assert.equal(materials[0].photoId, review.photoId);
  assert.equal(materials[0].sector.d0, 100);
  assert.equal(materials[0].sector.d1, 200);
  assert.equal(materials[0].source.kind, 'photo-review');
  assert.match(materials[0].note, /no se derivó/i);
});

test('deriveMaterials sin evidencia: fallback procedural explícito, sin textura derivada', () => {
  const out = E.deriveMaterials(M.blankProject());

  assert.equal(out.length, 1);
  assert.equal(out[0].fallback, 'generator-default-no-evidence');
  assert.equal(out[0].provenance, 'procedural');
  assert.equal(out[0].presetMaterial, null);
  assert.equal(out[0].textureDerivation, E.TEXTURE_DERIVATION);
  assert.equal(out[0].generatedTextures, 0);
  assert.match(out[0].note, /no se derivó/i);
  assert.equal(out[0].source.kind, 'generator-fallback');
});

test('deriveVegetation: especie OSM explícita del catálogo del repo → identified', () => {
  const p = M.blankProject();
  const veg = E.deriveVegetation(p, {
    catalog: E.DEFAULT_CATALOG,
    osmFeatures: [{
      id: 'way/123', lat: -54.62, lon: -67.24,
      tags: { natural: 'wood', species: 'Nothofagus pumilio' },
      retrievedAt: '2026-11-20',
    }],
  });

  assert.equal(veg.length, 1);
  assert.equal(veg[0].type, 'identified');
  assert.equal(veg[0].species, 'lenga');
  assert.match(veg[0].speciesLabel, /Hoja ancha/);
  assert.equal(veg[0].source.kind, 'osm');
  assert.equal(veg[0].source.tags.species, 'Nothofagus pumilio');
  assert.equal(veg[0].measured, false);
  assert.ok(veg[0].density > 0 && veg[0].patchiness > 0);
});

test('deriveVegetation sin evidencia: estimated con species null y nota honesta', () => {
  const veg = E.deriveVegetation(M.blankProject());

  assert.equal(veg.length, 1);
  assert.equal(veg[0].type, 'estimated');
  assert.equal(veg[0].species, null);
  assert.equal(veg[0].speciesLabel, null);
  assert.match(veg[0].note, /sin evidencia/i);
  assert.equal(veg[0].measured, false);
  assert.ok(veg[0].density > 0 && veg[0].density < 1);
  assert.ok(veg[0].patchiness > 0 && veg[0].patchiness <= 1);
  assert.match(veg[0].distributionNote, /parámetros de distribución/i);
});

test('sectores distintos no se mezclan ni en materiales ni en vegetación', () => {
  const p = M.blankProject();
  const a = M.addPhoto(p, {
    id: 'commons:a', provider: 'commons', url: 'https://upload.test/a.jpg',
    lat: -54.62, lon: -67.24, license: 'CC0', author: 'A',
  });
  const b = M.addPhoto(p, {
    id: 'commons:b', provider: 'commons', url: 'https://upload.test/b.jpg',
    lat: -54.63, lon: -67.25, license: 'CC BY 4.0', author: 'B',
  });
  E.reviewPhoto(p, a.id, { approved: true, materialClass: 'ripio', reviewer: 'Lucas', sector: { d0: 0, d1: 100 } });
  E.reviewPhoto(p, b.id, { approved: true, materialClass: 'grava', reviewer: 'Lucas', sector: { d0: 200, d1: 300 } });

  const materials = E.deriveMaterials(p);
  assert.equal(materials.length, 2);
  assert.deepEqual(materials.map(m => m.sector.d0), [0, 200]);
  assert.deepEqual(materials.map(m => m.sector.d1), [100, 300]);
  assert.equal(materials[0].presetMaterial, E.MATERIAL_CLASS_BY_ID.ripio.presetMaterial);
  assert.equal(materials[1].presetMaterial, E.MATERIAL_CLASS_BY_ID.grava.presetMaterial);
  assert.notEqual(materials[0].presetMaterial, materials[1].presetMaterial);
  assert.equal(materials[0].photoId, a.id);
  assert.equal(materials[1].photoId, b.id);

  const veg = E.deriveVegetation(p, {
    osmFeatures: [
      { sector: { d0: 0, d1: 100 }, tags: { natural: 'wood', species: 'Pinus' } },
      { sector: { d0: 200, d1: 300 }, tags: { landuse: 'grass' } },
    ],
  });
  assert.equal(veg.length, 2);
  assert.deepEqual(veg.map(v => v.sector.d0), [0, 200]);
  assert.equal(veg[0].type, 'identified');
  assert.equal(veg[0].species, 'pino');
  assert.equal(veg[1].type, 'estimated');
  assert.equal(veg[1].species, null);
  assert.equal(veg[1].vegetationClass, 'pastizal');
});

test('persistencia: JSON roundtrip con normalizeProjectWithEvidence conserva la revisión', () => {
  const { p } = projectWithApprovedPhoto();
  const saved = JSON.parse(JSON.stringify(p));

  // El modelo base no conoce "evidence": hace falta el normalizador de este módulo.
  const plain = M.normalizeProject(saved);
  assert.equal(plain.evidence, undefined);

  const loaded = E.normalizeProjectWithEvidence(saved);
  assert.equal(loaded.evidence.reviews.length, 1);
  const r = loaded.evidence.reviews[0];
  assert.equal(r.status, 'approved');
  assert.equal(r.photo.author, 'A. Pérez');
  assert.equal(r.photo.license, 'CC BY-SA 4.0');
  assert.equal(r.photo.date, '2026-11-20');
  assert.equal(r.photo.lat, -54.6266558);
  assert.equal(r.photo.lon, -67.2432701);
  assert.equal(r.photoVisualVerified, false);
  assert.equal(loaded.photos[0].visualVerified, false);

  const materials = E.deriveMaterials(loaded);
  assert.equal(materials[0].presetMaterial, E.MATERIAL_CLASS_BY_ID.ripio.presetMaterial);
});

test('summaryEvidence: conteos, procedencia, licencias y validación coherente', () => {
  const p = M.blankProject();
  const ok = M.addPhoto(p, {
    id: 'commons:ok', provider: 'commons', url: 'https://upload.test/ok.jpg',
    lat: -54.62, lon: -67.24, license: 'CC0', author: 'A',
  });
  E.reviewPhoto(p, ok.id, {
    approved: true, materialClass: 'grava', vegetationClass: 'lenga',
    reviewer: 'Lucas', sector: { d0: 0, d1: 50 },
  });
  const bad = M.addPhoto(p, {
    id: 'panoramax:bad', provider: 'panoramax', url: 'https://images.test/bad.jpg',
    lat: -54.63, lon: -67.25, license: 'Mapillary Terms', author: 'B',
  });
  assert.throws(() => E.reviewPhoto(p, bad.id, { approved: true, materialClass: 'ripio', reviewer: 'Lucas' }), /excluida/i);

  E.deriveMaterials(p);
  E.deriveVegetation(p);
  const s = E.summaryEvidence(p);

  assert.equal(s.photos, 2);
  assert.deepEqual(s.reviews, { total: 2, approved: 1, rejected: 1 });
  assert.equal(s.materials.total, 1);
  assert.equal(s.materials.byProvenance.observed, 1);
  assert.deepEqual(s.materials.presetMaterials, [E.MATERIAL_CLASS_BY_ID.grava.presetMaterial]);
  assert.equal(s.vegetation.total, 1);
  assert.equal(s.vegetation.byType.identified, 1);
  assert.deepEqual(s.vegetation.identifiedSpecies, ['lenga']);
  assert.equal(s.textureDerivation, 'none-reviewed-assignment');
  assert.equal(s.generatedTextures, 0);
  assert.equal(s.licensePolicy.mapillaryAllowed, false);
  assert.deepEqual(s.issues, []);
  assert.equal(s.valid, true);
  assert.match(s.note, /no se derivan texturas/i);
});
