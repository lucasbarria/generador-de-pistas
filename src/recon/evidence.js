// Evidencia → materiales/vegetación: sistema explícito y honesto.
// Regla de oro: una foto revisada puede autorizar el USO de un material existente del repo.
// NUNCA se genera una textura, normal, AO ni mapa PBR nuevo a partir de la foto.
// Los materiales y las especies mencionados acá ya existen en el repositorio.
(function (root) {
  'use strict';

  const M = (typeof module !== 'undefined' && module.exports) ? require('./model.js') : (root.Reconstruction || {});
  const PROVENANCE = M.PROVENANCE || {
    MEASURED: 'measured', OBSERVED: 'observed', ESTIMATED: 'estimated', GENERATED: 'generated',
  };
  const DEFAULT_CONFIDENCE = M.DEFAULT_CONFIDENCE || {
    measured: 0.9, observed: 0.7, estimated: 0.35, generated: 0.15,
  };

  const TEXTURE_DERIVATION = 'none-reviewed-assignment';
  const PRESET_ID = 'ripio_rio_grande';
  const PRESET_ROOT = 'presets/pisos/ripio_rio_grande/texturas/';
  const presetFile = name => PRESET_ROOT + name;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function now() { return new Date().toISOString(); }
  function toNumber(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function uid(prefix) {
    if (root.crypto && root.crypto.randomUUID) return prefix + ':' + root.crypto.randomUUID();
    return prefix + ':' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function normText(v) {
    return String(v == null ? '' : v).trim().toLowerCase()
      .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  }
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // ---------------------------------------------------------------------------
  // 1) Clases de material. Todos los presetMaterial son archivos reales del repo.
  //    barro no tiene material aprobado para producción: se declara, no se inventa.
  // ---------------------------------------------------------------------------
  const materialList = [
    {
      id: 'tierra', label: 'Tierra', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_tire_loose_soil.png'), generatorMaterial: 'det_dirt',
      productionApproved: true, note: 'Tierra fina del borde y del fondo de cuneta del preset Río Grande.',
    },
    {
      id: 'ripio', label: 'Ripio compactado', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_track_compacted.png'), generatorMaterial: 'det_track',
      productionApproved: true, note: 'Huella de ripio compactado del preset Río Grande.',
    },
    {
      id: 'grava', label: 'Grava suelta', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_gravel_loose.png'), generatorMaterial: 'det_loose',
      productionApproved: true, note: 'Grava suelta de lomo y cordones del preset Río Grande.',
    },
    {
      id: 'barro', label: 'Barro / fondo blando', presetId: PRESET_ID,
      presetMaterial: null, candidateTexture: presetFile('rg_ditch_cracked.png'),
      generatorMaterial: null, productionApproved: false,
      note: 'El preset tiene texturas de cuneta, pero el generador las marca como no aprobadas para producción; no se asigna automáticamente.',
    },
    {
      id: 'pasto', label: 'Pasto / vegetación de borde', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_edge_vegetation_v2.png'), generatorMaterial: 'det_grass',
      productionApproved: true, note: 'Vegetación de borde del preset Río Grande.',
    },
    {
      id: 'rocas', label: 'Rocas y canto grueso', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_stones_east.png'), generatorMaterial: 'stones_e',
      productionApproved: true, note: 'Canto grueso del preset Río Grande.',
    },
    {
      id: 'banquina', label: 'Banquina de tierra y ripio', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_bank_soil.png'), generatorMaterial: 'bank',
      productionApproved: true, note: 'Banquina / banco de tierra del preset Río Grande.',
    },
    {
      id: 'cuneta', label: 'Cuneta (fondo de tierra)', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_tire_loose_soil.png'), generatorMaterial: 'det_dirt',
      productionApproved: true, note: 'Fondo blando de cuneta; los taludes se tratan como clase aparte.',
    },
    {
      id: 'talud', label: 'Talud / cordón de tierra removida', presetId: PRESET_ID,
      presetMaterial: presetFile('rg_shoulder_berm.png'), generatorMaterial: 'det_berm',
      productionApproved: true, note: 'Cordón y talud del preset Río Grande.',
    },
  ];

  const MATERIAL_CLASSES = (function () {
    for (const c of materialList) {
      Object.freeze(c);
      Object.defineProperty(materialList, c.id, { value: c, enumerable: false, configurable: false, writable: false });
    }
    return Object.freeze(materialList);
  })();

  const MATERIAL_CLASS_BY_ID = Object.freeze(materialList.reduce((acc, c) => {
    acc[c.id] = c;
    return acc;
  }, {}));

  // ---------------------------------------------------------------------------
  // Clases de vegetación. Las especies con speciesId son exactamente las claves de
  // src/objetos.js:OB_SPECIES. bosque/pastizal/pasto son TIPOS de cobertura (no especies).
  // ---------------------------------------------------------------------------
  const vegetationList = [
    { id: 'pasto', label: 'Pasto / estepa', speciesId: null, type: 'estimated', note: 'Cobertura de pasto de la estepa fueguina; sin especie identificada.' },
    { id: 'bosque', label: 'Bosque (OSM natural=wood / landuse=forest)', speciesId: null, type: 'estimated', note: 'Etiqueta OSM de cobertura; no identifica especie.' },
    { id: 'pastizal', label: 'Pastizal / campo (OSM landuse=grass|farm)', speciesId: null, type: 'estimated', note: 'Etiqueta OSM de cobertura; no identifica especie.' },
    { id: 'arbusto', label: 'Arbustos y monte bajo', speciesId: 'arbusto', type: 'identified', note: 'Especie/categoría presente en el catálogo del repo.' },
    { id: 'lenga', label: 'Hoja ancha (lenga, ñire)', speciesId: 'lenga', type: 'identified', note: 'Especie/categoría presente en el catálogo del repo.' },
    { id: 'pino', label: 'Pinos', speciesId: 'pino', type: 'identified', note: 'Especie/categoría presente en el catálogo del repo.' },
    { id: 'selva', label: 'Selva / yungas (alto, tupido)', speciesId: 'selva', type: 'identified', note: 'Especie/categoría presente en el catálogo del repo.' },
    { id: 'mixto', label: 'Mixto', speciesId: 'mixto', type: 'identified', note: 'Especie/categoría presente en el catálogo del repo.' },
  ];

  const VEGETATION_CLASSES = (function () {
    for (const c of vegetationList) {
      Object.freeze(c);
      Object.defineProperty(vegetationList, c.id, { value: c, enumerable: false, configurable: false, writable: false });
    }
    return Object.freeze(vegetationList);
  })();

  const VEGETATION_CLASS_BY_ID = Object.freeze(vegetationList.reduce((acc, c) => {
    acc[c.id] = c;
    return acc;
  }, {}));

  const VEGETATION_LEVELS = Object.freeze(['identified', 'estimated', 'procedural']);
  const VEGETATION_PROVENANCE = Object.freeze({
    identified: PROVENANCE.OBSERVED, estimated: PROVENANCE.ESTIMATED, procedural: 'procedural',
  });

  // Catálogo leído de src/objetos.js:OB_SPECIES. No se agregan especies nuevas.
  const DEFAULT_CATALOG = Object.freeze([
    Object.freeze({ id: 'selva', label: 'Selva / yungas (alto, tupido)', aliases: ['yungas', 'selva'], source: 'src/objetos.js:OB_SPECIES' }),
    Object.freeze({ id: 'mixto', label: 'Mixto', aliases: ['mixed', 'mixto'], source: 'src/objetos.js:OB_SPECIES' }),
    Object.freeze({ id: 'lenga', label: 'Hoja ancha (lenga, ñire)', aliases: ['lenga', 'nothofagus pumilio', 'nothofagus antarctica', 'ñire', 'nire', 'hoja ancha'], source: 'src/objetos.js:OB_SPECIES' }),
    Object.freeze({ id: 'pino', label: 'Pinos', aliases: ['pino', 'pinos', 'pine', 'pinus'], source: 'src/objetos.js:OB_SPECIES' }),
    Object.freeze({ id: 'arbusto', label: 'Arbustos y monte bajo', aliases: ['arbusto', 'arbustos', 'shrub', 'monte bajo'], source: 'src/objetos.js:OB_SPECIES' }),
  ]);

  const DEFAULT_CATALOG_BY_ID = Object.freeze(DEFAULT_CATALOG.reduce((acc, c) => {
    acc[c.id] = c;
    return acc;
  }, {}));

  const DISTRIBUTION_NOTE = 'density y patchiness son PARÁMETROS DE DISTRIBUCIÓN del generador, no datos medidos. Se aplican por sector para evitar paredes uniformes.';
  const DISTRIBUTION_DEFAULTS = Object.freeze({
    identified: Object.freeze({ density: 0.35, patchiness: 0.6 }),
    estimated: Object.freeze({ density: 0.3, patchiness: 0.55 }),
    procedural: Object.freeze({ density: 0.3, patchiness: 0.6 }),
    pasto: Object.freeze({ density: 0.8, patchiness: 0.3 }),
    bosque: Object.freeze({ density: 0.45, patchiness: 0.7 }),
    pastizal: Object.freeze({ density: 0.75, patchiness: 0.35 }),
    arbusto: Object.freeze({ density: 0.55, patchiness: 0.75 }),
    pino: Object.freeze({ density: 0.4, patchiness: 0.65 }),
    selva: Object.freeze({ density: 0.45, patchiness: 0.7 }),
    mixto: Object.freeze({ density: 0.35, patchiness: 0.65 }),
  });

  // ---------------------------------------------------------------------------
  // Política de licencias. Mapillary queda explícitamente NO permitida por defecto:
  // este módulo no implementa su cliente y un token no habilita el uso de imágenes.
  // ---------------------------------------------------------------------------
  const DEFAULT_ALLOWED_LICENSES = Object.freeze([
    Object.freeze({ id: 'CC0', label: 'CC0 / sin restricciones', pattern: '^cc0(?:[\\s-]*1\\.0)?$', allowed: true }),
    Object.freeze({ id: 'CC BY-SA', label: 'Creative Commons BY-SA', pattern: '^cc[\\s-]*by[\\s-]*sa(?:[\\s-]+\\d+(?:\\.\\d+)*)?$', allowed: true }),
    Object.freeze({ id: 'CC BY', label: 'Creative Commons BY', pattern: '^cc[\\s-]*by(?:[\\s-]+\\d+(?:\\.\\d+)*)?$', allowed: true }),
    Object.freeze({ id: 'Public Domain', label: 'Dominio público / Public Domain Mark', pattern: '^(?:public[\\s-]*domain|dominio[\\s-]+p[úu]blico|pd)(?:[\\s-]+mark)?(?:[\\s-]+\\d+(?:\\.\\d+)*)?$', allowed: true }),
    Object.freeze({ id: 'CC BY-NC', label: 'CC BY-NC (no comercial): excluida por defecto', pattern: '^cc[\\s-]*by[\\s-]*nc', allowed: false }),
    Object.freeze({ id: 'Mapillary Terms', label: 'Mapillary Terms: excluida por defecto (requiere aceptación explícita del revisor)', pattern: '^(?:mapillary\\b.*|.*mapillary[\\s-]+terms.*)$', allowed: false }),
  ]);

  function resolveAllowedLicenses(configured) {
    const list = clone(DEFAULT_ALLOWED_LICENSES);
    let items = configured;
    if (!items) return list;
    if (!Array.isArray(items)) items = Array.isArray(items.list) ? items.list : [];
    for (const raw of items) {
      if (typeof raw === 'string') {
        const key = normText(raw);
        if (!key) continue;
        list.push({
          id: key, label: raw,
          pattern: '^' + escapeRegExp(key).replace(/\s+/g, '[\\s-]+') + '$',
          allowed: true,
        });
        continue;
      }
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || raw.license || '').trim();
      const pattern = String(raw.pattern || '').trim();
      if (!id || !pattern) continue;
      const entry = {
        id, label: raw.label || id, pattern,
        allowed: raw.allowed !== false,
      };
      const idx = list.findIndex(x => normText(x.id) === normText(id));
      if (idx >= 0) list[idx] = entry; else list.push(entry);
    }
    return list;
  }

  function licenseDecision(license, allowedLicenses) {
    const policy = Array.isArray(allowedLicenses) ? allowedLicenses : DEFAULT_ALLOWED_LICENSES;
    if (!license || !String(license).trim()) {
      return { allowed: false, reason: 'La foto no declara licencia ni permiso explícito: no puede aprobarse como evidencia.' };
    }
    const key = normText(String(license).replace(/^creative commons[\s-]+/i, ''));
    for (const rule of policy) {
      let re;
      try { re = new RegExp(rule.pattern, 'i'); } catch (e) { continue; }
      if (!re.test(key)) continue;
      if (rule.allowed === false) {
        return { allowed: false, reason: 'La licencia "' + license + '" está explícitamente excluida (' + (rule.label || rule.id) + ').' };
      }
      return { allowed: true, matched: rule.id, label: rule.label || rule.id };
    }
    return { allowed: false, reason: 'La licencia "' + license + '" no figura entre las licencias aceptables configuradas.' };
  }

  // ---------------------------------------------------------------------------
  // Ubicación y sectores
  // ---------------------------------------------------------------------------
  function normalizeBBox(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let south, west, north, east;
    if (Array.isArray(raw)) {
      west = toNumber(raw[0]); south = toNumber(raw[1]); east = toNumber(raw[2]); north = toNumber(raw[3]);
    } else {
      south = toNumber(raw.south !== undefined ? raw.south : raw.minLat);
      west = toNumber(raw.west !== undefined ? raw.west : raw.minLon !== undefined ? raw.minLon : raw.lon);
      north = toNumber(raw.north !== undefined ? raw.north : raw.maxLat);
      east = toNumber(raw.east !== undefined ? raw.east : raw.maxLon !== undefined ? raw.maxLon : raw.lat);
    }
    if ([south, west, north, east].some(v => v === null || !Number.isFinite(v))) return null;
    if (Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) return null;
    if (south > north || west > east) return null;
    return { south, west, north, east };
  }

  function photoLocation(photo) {
    const lat = toNumber(photo && photo.lat), lon = toNumber(photo && photo.lon);
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { ok: true, kind: 'coords', lat, lon };
    }
    const bbox = normalizeBBox((photo && photo.bbox) || (photo && photo.zone && photo.zone.bbox));
    if (bbox) return { ok: true, kind: 'bbox', bbox };
    const zone = photo && photo.zone;
    if (typeof zone === 'string' && zone.trim()) return { ok: true, kind: 'zone', zone: zone.trim() };
    if (zone && typeof zone === 'object' && (zone.id || zone.label || zone.name)) {
      return { ok: true, kind: 'zone', zone: clone(zone) };
    }
    return { ok: false, kind: null, reason: 'La foto no tiene coordenadas ni zona conocida declarada.' };
  }

  function normalizeSector(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') throw new Error('El sector debe ser un objeto {d0,d1} o {bbox}.');
    if (raw.d0 !== undefined || raw.d1 !== undefined) {
      const d0 = toNumber(raw.d0), d1 = toNumber(raw.d1);
      if (d0 === null || d1 === null || d0 < 0 || d1 <= d0) {
        throw new Error('El sector {d0,d1} necesita números válidos con d1 > d0 >= 0.');
      }
      return { d0, d1 };
    }
    const bbox = normalizeBBox(raw.bbox || raw);
    if (!bbox) throw new Error('El sector necesita {d0,d1} o un {bbox} válido (south, west, north, east).');
    return { bbox };
  }

  function sectorKey(sector) {
    if (!sector) return 'sin-sector';
    if (sector.d0 !== undefined) return 'd:' + sector.d0 + ':' + sector.d1;
    if (sector.bbox) return 'b:' + [sector.bbox.south, sector.bbox.west, sector.bbox.north, sector.bbox.east].join(',');
    return 'otro';
  }

  function decorateArray(arr, props) {
    Object.keys(props).forEach(k => Object.defineProperty(arr, k, { value: props[k], enumerable: false, configurable: true, writable: true }));
    Object.defineProperty(arr, 'assignments', { get() { return arr; }, enumerable: false, configurable: true });
    return arr;
  }

  function ensureEvidence(project) {
    if (!project || typeof project !== 'object') throw new Error('Proyecto inválido.');
    if (!project.evidence || typeof project.evidence !== 'object') project.evidence = {};
    const e = project.evidence;
    if (!Array.isArray(e.reviews)) e.reviews = [];
    if (!Array.isArray(e.materials)) e.materials = [];
    if (!Array.isArray(e.vegetation)) e.vegetation = [];
    if (!e.config || typeof e.config !== 'object') e.config = {};
    if (!Array.isArray(e.config.allowedLicenses)) e.config.allowedLicenses = clone(DEFAULT_ALLOWED_LICENSES);
    if (!e.materialsMeta || typeof e.materialsMeta !== 'object') {
      e.materialsMeta = { textureDerivation: TEXTURE_DERIVATION, generatedTextures: 0 };
    }
    if (!e.vegetationMeta || typeof e.vegetationMeta !== 'object') {
      e.vegetationMeta = { distributionNote: DISTRIBUTION_NOTE };
    }
    return e;
  }

  function findPhoto(project, photoId) {
    const photos = Array.isArray(project.photos) ? project.photos : [];
    return photos.find(p => p && String(p.id) === String(photoId)) || null;
  }

  // ---------------------------------------------------------------------------
  // 2) Revisión de fotos
  // ---------------------------------------------------------------------------
  function reviewPhoto(project, photoId, decision, opts) {
    const e = ensureEvidence(project);
    const d = decision && typeof decision === 'object' ? decision : {};
    const o = opts && typeof opts === 'object' ? opts : {};
    const photo = findPhoto(project, photoId);
    if (!photo) throw new Error('No existe la foto "' + photoId + '" en el proyecto.');

    const configured = o.allowedLicenses !== undefined ? o.allowedLicenses
      : d.allowedLicenses !== undefined ? d.allowedLicenses : undefined;
    if (configured !== undefined) e.config.allowedLicenses = resolveAllowedLicenses(configured);
    const policy = e.config.allowedLicenses;

    const reviewer = typeof d.reviewer === 'string' ? d.reviewer.trim() : '';
    const reviewedAt = d.reviewedAt || now();
    const loc = photoLocation(photo);
    const lic = licenseDecision(photo.license, policy);

    let reason = null;
    if (!lic.allowed) reason = lic.reason;
    if (!loc.ok && !reason) reason = loc.reason;
    if (!reviewer && !reason) reason = 'La revisión necesita un reviewer identificado.';
    if (typeof d.approved !== 'boolean' && !reason) reason = 'decision.approved debe ser true o false.';

    let sector = null;
    if (!reason && d.sector !== undefined && d.sector !== null) {
      try { sector = normalizeSector(d.sector); } catch (err) { reason = err.message; }
    }
    if (!reason && d.materialClass && !MATERIAL_CLASS_BY_ID[d.materialClass]) {
      reason = 'Clase de material desconocida: "' + d.materialClass + '".';
    }
    if (!reason && d.vegetationClass && !VEGETATION_CLASS_BY_ID[d.vegetationClass]) {
      reason = 'Clase de vegetación desconocida: "' + d.vegetationClass + '".';
    }

    const approved = d.approved === true && !reason;
    const status = approved ? 'approved' : 'rejected';
    if (!approved && !reason) {
      reason = typeof d.notes === 'string' && d.notes.trim()
        ? 'Rechazado por el revisor: ' + d.notes.trim()
        : 'Rechazado por el revisor.';
    }

    // Regla explícita: jamás se marca visualVerified por aprobar una revisión.
    const visualVerifiedApplied = approved && d.visualVerified === true;
    if (visualVerifiedApplied) photo.visualVerified = true;

    const visualVerifiedBefore = !!(photo.visualVerified && !visualVerifiedApplied);
    const entry = {
      id: uid('review'),
      status,
      projectId: project.id || null,
      photoId: photo.id || null,
      reviewer: reviewer || null,
      reviewedAt,
      notes: typeof d.notes === 'string' ? d.notes : null,
      reason: approved ? null : reason,
      approved,
      materialClass: d.materialClass || null,
      vegetationClass: d.vegetationClass || null,
      materialProvenance: d.materialProvenance === 'estimated' || d.materialProvenance === PROVENANCE.ESTIMATED
        ? 'estimated' : 'observed',
      materialConfidence: toNumber(d.materialConfidence),
      sector: sector ? clone(sector) : null,
      visualVerifiedBefore,
      visualVerifiedApplied,
      visualVerifiedRequested: d.visualVerified === true,
      photoVisualVerified: !!photo.visualVerified,
      provenance: PROVENANCE.OBSERVED,
      source: {
        kind: 'photo-review',
        label: 'Revisión visual manual de una fotografía',
        provenance: PROVENANCE.OBSERVED,
        license: photo.license || null,
        licenseMatched: lic.matched || null,
        reviewer,
        retrievedAt: reviewedAt,
      },
      photo: {
        id: photo.id || null,
        provider: photo.provider || null,
        url: photo.url || null,
        author: photo.author || null,
        license: photo.license || null,
        date: photo.date || photo.time || null,
        time: photo.time || photo.date || null,
        resolution: photo.resolution || null,
        lat: toNumber(photo.lat),
        lon: toNumber(photo.lon),
        bbox: loc.kind === 'bbox' ? clone(loc.bbox) : (photo.bbox ? clone(photo.bbox) : null),
        zone: loc.kind === 'zone' ? clone(loc.zone) : (photo.zone ? clone(photo.zone) : null),
        locationKind: loc.kind,
      },
    };

    e.reviews.push(entry);
    e.updatedAt = now();
    project.updatedAt = now();

    // Un intento de aprobación inválido queda registrado como rejected y además se informa.
    if (d.approved === true && reason) throw new Error(reason);
    if (typeof d.approved !== 'boolean') throw new Error(reason);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // 3) Materiales: solo asignación de presets existentes. Cero derivación de textura.
  // ---------------------------------------------------------------------------
  function materialSource(review, provenance) {
    return {
      kind: 'photo-review',
      label: 'Revisión visual aprobada de una fotografía',
      reviewId: review.id || null,
      photoId: review.photoId || null,
      author: review.photo && review.photo.author || null,
      license: review.photo && review.photo.license || null,
      url: review.photo && review.photo.url || null,
      retrievedAt: review.reviewedAt || null,
      provenance,
    };
  }

  function fallbackMaterialAssignment(opts) {
    const o = opts || {};
    let sector = null;
    if (o.sector) {
      try { sector = normalizeSector(o.sector); } catch (e) { sector = null; }
    }
    return {
      materialClass: null,
      label: 'Sin clase de material observada',
      presetMaterial: null,
      fallbackPresetMaterial: MATERIAL_CLASS_BY_ID.ripio.presetMaterial,
      presetId: null,
      generatorMaterial: null,
      sector,
      photoId: null,
      provenance: 'procedural',
      confidence: DEFAULT_CONFIDENCE.generated,
      textureDerivation: TEXTURE_DERIVATION,
      generatedTextures: 0,
      fallback: 'generator-default-no-evidence',
      note: 'No hay revisión aprobada con materialClass. No se derivó textura de ninguna foto: el generador usa su material procedural por defecto.',
      source: {
        kind: 'generator-fallback',
        label: 'Fallback procedural del generador',
        provenance: PROVENANCE.GENERATED,
      },
    };
  }

  function deriveMaterials(project, opts) {
    const e = ensureEvidence(project);
    const o = opts || {};
    const assignments = [];

    for (const review of e.reviews) {
      if (!review || review.status !== 'approved' || !review.materialClass) continue;
      const cls = MATERIAL_CLASS_BY_ID[review.materialClass];
      if (!cls) continue; // validateEvidence/ summary lo informa como problema de coherencia.
      const hasPreset = !!cls.presetMaterial && cls.productionApproved !== false;
      const provenance = hasPreset
        ? (review.materialProvenance === 'estimated' ? 'estimated' : 'observed')
        : 'procedural';
      const confidence = toNumber(review.materialConfidence) === null
        ? (provenance === 'estimated' ? DEFAULT_CONFIDENCE.estimated
          : provenance === 'observed' ? DEFAULT_CONFIDENCE.observed : DEFAULT_CONFIDENCE.generated)
        : toNumber(review.materialConfidence);

      assignments.push({
        materialClass: cls.id,
        label: cls.label,
        presetMaterial: hasPreset ? cls.presetMaterial : null,
        presetId: hasPreset ? cls.presetId : null,
        generatorMaterial: hasPreset ? cls.generatorMaterial : null,
        sector: review.sector ? clone(review.sector) : null,
        photoId: review.photoId || null,
        provenance,
        confidence,
        textureDerivation: TEXTURE_DERIVATION,
        generatedTextures: 0,
        fallback: hasPreset ? null : 'sin-material-real-verificado',
        note: hasPreset
          ? 'Se reutiliza un material existente del preset ' + cls.presetId + '; no se derivó textura de la foto ni se generaron mapas PBR nuevos.'
          : (cls.note || 'No hay material real aprobado para esta clase; no se derivó textura de la foto.'),
        source: materialSource(review, provenance),
      });
    }

    if (!assignments.length) assignments.push(fallbackMaterialAssignment(o));

    e.materials = clone(assignments);
    e.materialsMeta = {
      textureDerivation: TEXTURE_DERIVATION,
      generatedTextures: 0,
      assignments: assignments.length,
      note: 'Solo se asocian materiales existentes del repositorio; no se crean mapas PBR, normales ni AO a partir de fotografías.',
    };
    return decorateArray(assignments, {
      textureDerivation: TEXTURE_DERIVATION,
      generatedTextures: 0,
      fallback: assignments.length === 1 && assignments[0].provenance === 'procedural',
    });
  }

  // ---------------------------------------------------------------------------
  // 4) Vegetación: identified / estimated / procedural, siempre por sector.
  // ---------------------------------------------------------------------------
  function catalogIndex(catalog) {
    let list = catalog;
    if (!Array.isArray(list)) {
      if (list && typeof list === 'object') {
        list = Object.keys(list).map(id => typeof list[id] === 'object'
          ? Object.assign({ id }, list[id]) : { id, label: String(list[id]) });
      } else list = [];
    }
    const map = new Map();
    for (const entry of list) {
      if (!entry || !entry.id) continue;
      const item = {
        id: String(entry.id),
        label: entry.label || String(entry.id),
        aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
        source: entry.source || null,
      };
      map.set(normText(item.id), item);
      for (const alias of item.aliases) {
        const k = normText(alias);
        if (k && !map.has(k)) map.set(k, item);
      }
    }
    return map;
  }

  function resolveCatalogSpecies(raw, index) {
    if (!raw) return null;
    const key = normText(raw);
    if (!key) return null;
    return index.get(key) || null;
  }

  function osmVegetationEvidence(feature, index) {
    const tags = feature.tags && typeof feature.tags === 'object'
      ? feature.tags
      : (feature.properties && typeof feature.properties === 'object' ? feature.properties : {});
    const natural = normText(tags.natural);
    const landuse = normText(tags.landuse);
    const rawSpecies = tags.species || tags['tree:species'] || tags.trees
      || (natural === 'tree' ? tags.name : null) || null;
    const species = resolveCatalogSpecies(rawSpecies, index);

    let level = 'estimated';
    let vegetationClass = null;
    let label = null;
    let note = null;

    if (species) {
      level = 'identified';
      species && (vegetationClass = VEGETATION_CLASS_BY_ID[species.id] ? species.id : null);
      label = species.label;
      note = 'Especie declarada en una etiqueta OSM real y presente en el catálogo del repo.';
    } else if (natural === 'wood' || landuse === 'forest') {
      vegetationClass = 'bosque';
      label = VEGETATION_CLASS_BY_ID.bosque.label;
      note = 'Cobertura boscosa según etiqueta OSM; no se identificó especie.';
    } else if (landuse === 'grass' || landuse === 'farm' || landuse === 'meadow') {
      vegetationClass = 'pastizal';
      label = VEGETATION_CLASS_BY_ID.pastizal.label;
      note = 'Cobertura de pastizal/campo según etiqueta OSM; no se identificó especie.';
    } else if (natural === 'grassland' || natural === 'heath') {
      vegetationClass = 'pasto';
      label = VEGETATION_CLASS_BY_ID.pasto.label;
      note = 'Cobertura de pasto según etiqueta OSM; no se identificó especie.';
    } else {
      return null; // etiquetas sin señal de vegetación: no inference inventada.
    }

    if (!species && rawSpecies) note += ' El valor OSM "' + rawSpecies + '" no está en el catálogo del repo: se conserva como dato, no como especie identificada.';

    return {
      level,
      speciesId: species ? species.id : null,
      speciesLabel: species ? species.label : null,
      vegetationClass,
      label,
      rawSpecies: rawSpecies || null,
      note,
      source: {
        kind: 'osm',
        label: 'OpenStreetMap: ' + (tags.natural ? 'natural=' + tags.natural : '') + (tags.landuse ? (tags.natural ? ', ' : '') + 'landuse=' + tags.landuse : '') || 'OpenStreetMap',
        provenance: PROVENANCE.MEASURED,
        tags: clone(tags),
        featureId: feature.id || feature.osmId || null,
        retrievedAt: feature.retrievedAt || null,
      },
    };
  }

  function reviewVegetationEvidence(review, index) {
    if (!review || review.status !== 'approved' || !review.vegetationClass) return null;
    const cls = VEGETATION_CLASS_BY_ID[review.vegetationClass];
    if (!cls) return null; // summary lo marca como revisión incoherente.
    const species = cls.speciesId ? index.get(normText(cls.speciesId)) : null;
    const level = species ? 'identified' : 'estimated';
    return {
      level,
      speciesId: species ? species.id : null,
      speciesLabel: species ? species.label : null,
      vegetationClass: cls.id,
      label: cls.label,
      rawSpecies: null,
      note: species
        ? 'Especie/Categoría declarada en una revisión aprobada y presente en el catálogo del repo.'
        : 'Clase de vegetación observada; sin especie identificada en el catálogo disponible.',
      source: {
        kind: 'photo-review',
        label: 'Revisión visual aprobada de una fotografía',
        reviewId: review.id || null,
        photoId: review.photoId || null,
        license: review.photo && review.photo.license || null,
        retrievedAt: review.reviewedAt || null,
        provenance: PROVENANCE.OBSERVED,
      },
    };
  }

  function sectorFromFeature(feature) {
    if (feature.sector) return normalizeSector(feature.sector);
    if (feature.bbox) return normalizeSector({ bbox: feature.bbox });
    const lat = toNumber(feature.lat), lon = toNumber(feature.lon);
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { bbox: { south: lat, west: lon, north: lat, east: lon } };
    }
    return null;
  }

  function distributionFor(level, vegetationClass) {
    return {
      density: DISTRIBUTION_DEFAULTS[vegetationClass]?.density ?? DISTRIBUTION_DEFAULTS[level].density,
      patchiness: DISTRIBUTION_DEFAULTS[vegetationClass]?.patchiness ?? DISTRIBUTION_DEFAULTS[level].patchiness,
    };
  }

  function proceduralVegetation(opts) {
    const o = opts || {};
    const type = o.fallbackType === 'procedural' ? 'procedural' : 'estimated';
    const dist = distributionFor(type, null);
    const note = type === 'procedural'
      ? 'Fallback del generador: no hay evidencia utilizable; esta es una distribución procedural, no un dato observado.'
      : 'Sin evidencia: no hay reviews aprobadas ni etiquetas OSM. No se identificó especie; el tipo es una estimación honesta, no un dato medido.';
    return {
      sector: o.sector ? (() => { try { return normalizeSector(o.sector); } catch (e) { return null; } })() : null,
      type,
      provenance: VEGETATION_PROVENANCE[type],
      vegetationClass: null,
      label: null,
      species: null,
      speciesLabel: null,
      confidence: type === 'procedural' ? DEFAULT_CONFIDENCE.generated : DEFAULT_CONFIDENCE.estimated,
      density: dist.density,
      patchiness: dist.patchiness,
      measured: false,
      distributionNote: DISTRIBUTION_NOTE,
      note,
      evidence: [],
      source: {
        kind: type === 'procedural' ? 'generator-fallback' : 'no-evidence',
        label: type === 'procedural' ? 'Fallback procedural del generador' : 'Ausencia de evidencia declarada',
        provenance: type === 'procedural' ? PROVENANCE.GENERATED : PROVENANCE.ESTIMATED,
      },
    };
  }

  function deriveVegetation(project, opts) {
    const e = ensureEvidence(project);
    const o = opts || {};
    const catalog = o.catalog !== undefined ? o.catalog : (e.catalog !== undefined ? e.catalog : DEFAULT_CATALOG);
    const index = catalogIndex(catalog);
    const osmFeatures = Array.isArray(o.osmFeatures) ? o.osmFeatures
      : (Array.isArray(e.osmFeatures) ? e.osmFeatures : []);
    if (Array.isArray(o.osmFeatures)) e.osmFeatures = clone(o.osmFeatures);
    if (o.catalog !== undefined) e.catalog = clone(o.catalog);

    const zones = new Map();
    function zoneFor(sector) {
      const key = sectorKey(sector);
      let z = zones.get(key);
      if (!z) {
        z = { sector: sector ? clone(sector) : null, evidences: [] };
        zones.set(key, z);
      }
      return z;
    }

    for (const review of e.reviews) {
      const ev = reviewVegetationEvidence(review, index);
      if (!ev) continue;
      zoneFor(review.sector || null).evidences.push(ev);
    }

    for (const feature of osmFeatures) {
      if (!feature || typeof feature !== 'object') continue;
      let sector;
      try { sector = sectorFromFeature(feature); } catch (err) { throw new Error('osmFeatures: ' + err.message); }
      const ev = osmVegetationEvidence(feature, index);
      if (!ev) continue;
      zoneFor(sector).evidences.push(ev);
    }

    const rank = { identified: 3, estimated: 2, procedural: 1 };
    const results = [];
    for (const z of zones.values()) {
      let best = null;
      for (const ev of z.evidences) {
        if (!best || rank[ev.level] > rank[best.level]
          || (rank[ev.level] === rank[best.level] && ev.source.kind === 'photo-review' && best.source.kind !== 'photo-review')) {
          best = ev;
        }
      }
      if (!best) continue;
      const dist = distributionFor(best.level, best.vegetationClass);
      results.push({
        sector: z.sector,
        type: best.level,
        provenance: VEGETATION_PROVENANCE[best.level],
        vegetationClass: best.vegetationClass,
        label: best.label,
        species: best.speciesId,
        speciesLabel: best.speciesLabel,
        confidence: best.level === 'identified' ? DEFAULT_CONFIDENCE.observed : DEFAULT_CONFIDENCE.estimated,
        density: dist.density,
        patchiness: dist.patchiness,
        measured: false,
        distributionNote: DISTRIBUTION_NOTE,
        note: best.note,
        evidence: z.evidences.map(ev => ({
          level: ev.level,
          species: ev.speciesId,
          rawSpecies: ev.rawSpecies,
          vegetationClass: ev.vegetationClass,
          source: ev.source,
          note: ev.note,
        })),
        source: best.source,
      });
    }

    if (!results.length) results.push(proceduralVegetation(o));

    e.vegetation = clone(results);
    e.vegetationMeta = {
      distributionNote: DISTRIBUTION_NOTE,
      levels: VEGETATION_LEVELS.slice(),
      catalogSource: catalog === DEFAULT_CATALOG ? 'src/objetos.js:OB_SPECIES' : 'catalog-inyectado',
      zones: results.length,
    };
    return decorateArray(results, {
      levels: VEGETATION_LEVELS.slice(),
      distributionNote: DISTRIBUTION_NOTE,
    });
  }

  // ---------------------------------------------------------------------------
  // 5) Normalización, validación y resumen
  // ---------------------------------------------------------------------------
  function normalizeEvidence(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {
      config: { allowedLicenses: resolveAllowedLicenses(src.config && src.config.allowedLicenses) },
      reviews: [],
      materials: Array.isArray(src.materials) ? clone(src.materials) : [],
      vegetation: Array.isArray(src.vegetation) ? clone(src.vegetation) : [],
      materialsMeta: src.materialsMeta && typeof src.materialsMeta === 'object' ? clone(src.materialsMeta) : {
        textureDerivation: TEXTURE_DERIVATION, generatedTextures: 0,
      },
      vegetationMeta: src.vegetationMeta && typeof src.vegetationMeta === 'object' ? clone(src.vegetationMeta) : {
        distributionNote: DISTRIBUTION_NOTE,
      },
      updatedAt: src.updatedAt || null,
    };
    for (const r of (Array.isArray(src.reviews) ? src.reviews : [])) {
      if (!r || typeof r !== 'object') continue;
      const n = clone(r);
      n.status = n.status === 'approved' ? 'approved' : 'rejected';
      n.id = n.id || uid('review');
      out.reviews.push(n);
    }
    if (Array.isArray(src.osmFeatures)) out.osmFeatures = clone(src.osmFeatures);
    if (src.catalog !== undefined) out.catalog = clone(src.catalog);
    return out;
  }

  function modelApi() {
    return (typeof module !== 'undefined' && module.exports) ? require('./model.js') : (root.Reconstruction || M);
  }

  function normalizeProjectWithEvidence(raw) {
    const model = modelApi();
    const p = model.normalizeProject(raw);
    p.evidence = normalizeEvidence(raw && raw.evidence);
    return p;
  }

  function attachEvidence(project, rawEvidence) {
    ensureEvidence(project);
    project.evidence = normalizeEvidence(rawEvidence);
    return project.evidence;
  }

  function validateEvidence(project) {
    const issues = [];
    const e = project && project.evidence;
    if (!e) return issues; // no hay evidencia declarada: no es un error, derive() lo informa.
    const reviews = Array.isArray(e.reviews) ? e.reviews : [];
    const photos = Array.isArray(project.photos) ? project.photos : [];
    const policy = resolveAllowedLicenses(e.config && e.config.allowedLicenses);
    const seen = new Set();

    for (const r of reviews) {
      if (!r || typeof r !== 'object') { issues.push('Hay una revisión vacía en evidence.reviews.'); continue; }
      if (!r.id || seen.has(r.id)) issues.push('Las revisiones necesitan un id único.');
      if (r.id) seen.add(r.id);
      if (r.status !== 'approved' && r.status !== 'rejected') issues.push('Revisión ' + (r.id || '?') + ' con estado desconocido.');
      const photo = photos.find(p => p && String(p.id) === String(r.photoId));
      if (!photo) {
        issues.push('La revisión ' + (r.id || '?') + ' referencia una foto que ya no está en el proyecto.');
        continue;
      }
      if (r.status !== 'approved') continue;
      const lic = licenseDecision(photo.license || (r.photo && r.photo.license), policy);
      if (!lic.allowed) issues.push('La revisión aprobada ' + (r.id || '?') + ' usa una licencia no aceptable: ' + lic.reason);
      if (!photoLocation(photo).ok && !(r.photo && r.photo.locationKind)) {
        issues.push('La revisión aprobada ' + (r.id || '?') + ' no tiene coordenadas ni zona conocida.');
      }
      if (r.materialClass && !MATERIAL_CLASS_BY_ID[r.materialClass]) issues.push('Revisión ' + (r.id || '?') + ' con materialClass desconocido: ' + r.materialClass);
      if (r.vegetationClass && !VEGETATION_CLASS_BY_ID[r.vegetationClass]) issues.push('Revisión ' + (r.id || '?') + ' con vegetationClass desconocido: ' + r.vegetationClass);
      if (r.visualVerifiedApplied === true && photo.visualVerified !== true) {
        issues.push('La revisión ' + (r.id || '?') + ' dice haber marcado visualVerified pero la foto no está marcada.');
      }
    }

    const meta = e.materialsMeta || {};
    if (meta.textureDerivation && meta.textureDerivation !== TEXTURE_DERIVATION) {
      issues.push('La derivación de textura declarada no es "none-reviewed-assignment".');
    }
    if (toNumber(meta.generatedTextures) !== 0 && toNumber(meta.generatedTextures) !== null) {
      issues.push('El sistema declara texturas generadas: este módulo no genera texturas.');
    }
    for (const a of (Array.isArray(e.materials) ? e.materials : [])) {
      if (!a || typeof a !== 'object') continue;
      if (a.textureDerivation !== TEXTURE_DERIVATION || a.generatedTextures !== 0) {
        issues.push('Una asignación de material no declara textureDerivation="none-reviewed-assignment" y generatedTextures=0.');
      }
      if (a.provenance === 'procedural' && !a.fallback) {
        issues.push('Una asignación procedural no declara su fallback.');
      }
    }
    for (const v of (Array.isArray(e.vegetation) ? e.vegetation : [])) {
      if (!v || typeof v !== 'object') continue;
      if (!VEGETATION_LEVELS.includes(v.type)) issues.push('Nivel de vegetación desconocido: ' + v.type);
      if (v.type !== 'identified' && v.species) issues.push('Hay una especie declarada en un nivel "no identified".');
      if (typeof v.density !== 'number' || typeof v.patchiness !== 'number') {
        issues.push('Faltan parámetros de distribución (density/patchiness) por sector.');
      }
    }
    return issues;
  }

  function summaryEvidence(project) {
    const e = project && project.evidence && typeof project.evidence === 'object' ? project.evidence : {};
    const reviews = Array.isArray(e.reviews) ? e.reviews : [];
    const materials = Array.isArray(e.materials) ? e.materials : [];
    const vegetation = Array.isArray(e.vegetation) ? e.vegetation : [];
    const policy = resolveAllowedLicenses(e.config && e.config.allowedLicenses);
    const byProvenance = { observed: 0, estimated: 0, procedural: 0 };
    const byType = { identified: 0, estimated: 0, procedural: 0 };
    const presetMaterials = new Set();
    const species = new Set();

    for (const a of materials) {
      if (byProvenance[a.provenance] !== undefined) byProvenance[a.provenance]++;
      if (a.presetMaterial) presetMaterials.add(a.presetMaterial);
    }
    for (const v of vegetation) {
      if (byType[v.type] !== undefined) byType[v.type]++;
      if (v.species) species.add(v.species);
    }
    const issues = validateEvidence(project);

    return {
      photos: Array.isArray(project && project.photos) ? project.photos.length : 0,
      reviews: {
        total: reviews.length,
        approved: reviews.filter(r => r && r.status === 'approved').length,
        rejected: reviews.filter(r => r && r.status === 'rejected').length,
      },
      materials: {
        total: materials.length,
        byProvenance,
        presetMaterials: Array.from(presetMaterials),
      },
      vegetation: {
        total: vegetation.length,
        byType,
        identifiedSpecies: Array.from(species),
      },
      licensePolicy: {
        configured: policy.length,
        mapillaryAllowed: policy.some(r => normText(r.id).includes('mapillary') && r.allowed !== false),
        allowed: policy.filter(r => r.allowed !== false).map(r => ({ id: r.id, label: r.label })),
      },
      textureDerivation: (e.materialsMeta && e.materialsMeta.textureDerivation) || TEXTURE_DERIVATION,
      generatedTextures: 0,
      issues,
      valid: issues.length === 0,
      note: 'La evidencia solo asocia materiales y vegetación ya existentes en el repo; no se derivan texturas de las fotos.',
    };
  }

  const api = {
    // constantes
    TEXTURE_DERIVATION, PRESET_ID, PRESET_ROOT,
    MATERIAL_CLASSES, MATERIAL_CLASS_BY_ID,
    VEGETATION_CLASSES, VEGETATION_CLASS_BY_ID, VEGETATION_LEVELS, VEGETATION_PROVENANCE,
    DEFAULT_CATALOG, DEFAULT_CATALOG_BY_ID, DISTRIBUTION_NOTE, DISTRIBUTION_DEFAULTS,
    DEFAULT_ALLOWED_LICENSES,
    // licencias y sectores
    resolveAllowedLicenses, licenseDecision, normalizeBBox, normalizeSector,
    // flujo de evidencia
    reviewPhoto, deriveMaterials, deriveVegetation,
    // persistencia y control
    ensureEvidence, normalizeEvidence, normalizeProjectWithEvidence, attachEvidence,
    validateEvidence, summaryEvidence,
  };

  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  root.Recon = root.Reconstruction;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
