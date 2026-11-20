// Asistente determinista para reconstrucción de tramos reales.
// No usa IA externa ni hace llamadas de red: todas las reglas se evalúan sobre datos
// inyectados (project / route / opts). La evidencia cita SIEMPRE un dato existente;
// la explicación de por qué puede ser un problema va en `inference`, separada.
(function (root) {
  'use strict';

  const EVIDENCE_TYPES = Object.freeze(['measured', 'observed', 'estimated']);

  // Umbrales explícitos y configurables. Los valores por defecto son reglas de
  // revisión, no mediciones: se pueden sobreescribir con opts.config.
  const DEFAULT_CONFIG = Object.freeze({
    uniformMeters: 300,       // tramo mínimo sin cambios de material para sospechar uniformidad
    maxElevationStepMeters: 1.5,
    minStepDistanceMeters: 12,
    maxGrade: 0.15,           // 15 %
    minGradeDeltaMeters: 0.5, // evita marcar ruido de elevación como pendiente
    minTransitionMeters: 25,  // separación mínima entre materiales distintos
    slopeMin: 0.3,            // H:V, mismo rango que la edición de taludes del generador
    slopeMax: 4,
    pointSpanMeters: 20,      // scope usado cuando una review es puntual (solo d)
  });

  const EPSILON = 1e-3;
  const CONFIDENCE = Object.freeze({ measured: 0.9, observed: 0.7, estimated: 0.35 });
  const tokens = new Map();
  let tokenSeq = 0;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function finite(v) { const n = num(v); return n !== null && Number.isFinite(n); }
  function list(v) { return Array.isArray(v) ? v : []; }
  function round3(v) { return Math.round(Number(v) * 1000) / 1000; }
  function fmt(v) { return String(round3(v)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function overlaps(a0, a1, b0, b1) { return a0 <= b1 + EPSILON && b0 <= a1 + EPSILON; }

  function haversine(a, b) {
    const latA = num(Array.isArray(a) ? a[0] : a && a.lat);
    const lonA = num(Array.isArray(a) ? a[1] : a && (a.lon !== undefined ? a.lon : a.lng));
    const latB = num(Array.isArray(b) ? b[0] : b && b.lat);
    const lonB = num(Array.isArray(b) ? b[1] : b && (b.lon !== undefined ? b.lon : b.lng));
    if (latA === null || lonA === null || latB === null || lonB === null) return 0;
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (latB - latA) * rad, dLon = (lonB - lonA) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function polylineLength(points) {
    const pts = list(points);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
    return d;
  }

  // Fuentes auxiliares: primero opts (inyección explícita en tests), luego
  // project.assist (datos inyectados en el propio proyecto). Nunca se consulta red.
  function sourcesOf(project, opts) {
    const o = opts || {};
    const embedded = (project && project.assist) || {};
    const pick = key => (o[key] !== undefined ? o[key] : embedded[key]);
    return {
      surface: list(pick('surface')),
      profile: list(pick('profile') || pick('profileSamples')),
      vegetation: list(pick('vegetation') || pick('vegetationZones')),
      slopes: list(pick('slopes') || pick('slopeZones')),
      reviews: list(pick('reviews')),
      osm: list(pick('osm') || pick('osmEvidence')),
      materials: list(pick('materials')),
      suggestedMaterialClass: pick('suggestedMaterialClass'),
      config: Object.assign({}, DEFAULT_CONFIG, embedded.config || {}, o.config || {}),
    };
  }

  function refOf(rec, prefix, index) {
    if (!rec) return prefix + '[' + index + ']';
    return String(rec.ref || rec.id || prefix + '[' + index + ']');
  }

  // Un ref sin procedencia declarada se cita como `estimated`: es lo que el
  // llamador inyectó, no una mediciónInventada por este módulo.
  function evidenceOf(rec, fallbackType, prefix, index) {
    if (!rec) return null;
    const raw = String(rec.provenance || rec.evidenceType || rec.type || '').toLowerCase();
    let type = fallbackType;
    if (raw === 'measured' || raw === 'osm' || raw === 'gpx' || raw === 'dem') type = 'measured';
    else if (raw === 'observed' || raw === 'review' || raw === 'photo') type = 'observed';
    else if (raw === 'estimated' || raw === 'generated' || raw === 'procedural') type = 'estimated';
    if (!EVIDENCE_TYPES.includes(type)) type = 'estimated';
    return { type, ref: refOf(rec, prefix, index) };
  }

  function dOf(rec, prefix) {
    if (!rec) return null;
    return num(rec.d !== undefined ? rec.d : rec[prefix]);
  }

  function elevationOf(rec) { return rec ? num(rec.elevation !== undefined ? rec.elevation : rec.ele) : null; }
  function materialOf(rec) { return rec ? (rec.materialClass || rec.material || rec.value || null) : null; }

  function findRecord(src, ref) {
    if (!ref) return null;
    const pools = [src.surface, src.profile, src.vegetation, src.slopes, src.reviews, src.osm];
    for (const pool of pools) {
      for (const rec of pool) {
        if (rec && String(rec.ref || rec.id) === String(ref)) return rec;
      }
    }
    return null;
  }

  function findInPool(src, poolName, ref) {
    if (!ref) return null;
    return (src[poolName] || []).find(r => r && String(r.ref || r.id) === String(ref)) || null;
  }

  function emitter() {
    const issues = [], seen = new Map();
    return {
      emit(kind, d0, d1, severity, evidence, inference) {
        if (!finite(d0) || !finite(d1) || d1 <= d0) return;
        const base = kind + '@' + fmt(d0) + '-' + fmt(d1);
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        issues.push({
          id: n === 1 ? base : base + '#' + n,
          kind,
          d0: round3(d0),
          d1: round3(d1),
          severity,
          evidence: list(evidence).filter(Boolean),
          inference: 'Inferencia (no es un dato medido): ' + inference,
        });
      },
      result() {
        return issues.slice().sort((a, b) =>
          (a.d0 - b.d0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      },
    };
  }

  // --- reglas explícitas ---

  function ruleUniformSurface(src, out) {
    const cfg = src.config;
    const arr = src.surface.filter(r => r && finite(dOf(r, 'd0')) && materialOf(r))
      .slice().sort((a, b) => dOf(a, 'd0') - dOf(b, 'd0'));
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i], m = materialOf(a), d0 = dOf(a, 'd0'), d1 = dOf(b, 'd0');
      if (materialOf(b) !== m || d1 - d0 < cfg.uniformMeters) continue;
      const between = arr.filter(r => dOf(r, 'd0') > d0 && dOf(r, 'd0') < d1);
      if (between.some(r => materialOf(r) !== m)) continue;
      out.emit('surface-uniform', d0, d1, d1 - d0 >= cfg.uniformMeters * 2 ? 'high' : 'medium', [
        evidenceOf(a, 'estimated', 'surface', src.surface.indexOf(a)),
        evidenceOf(b, 'estimated', 'surface', src.surface.indexOf(b)),
      ], 'Entre esas dos muestras (' + fmt(d1 - d0) + ' m) no se registra cambio de materialClass (' + m
        + '). La apariencia uniforme es una hipótesis a revisar, no una medición visual.');
    }
  }

  function ruleProfile(src, out) {
    const cfg = src.config;
    const arr = src.profile.filter(r => r && finite(dOf(r, 'd0')) && finite(elevationOf(r)))
      .slice().sort((a, b) => dOf(a, 'd0') - dOf(b, 'd0'));
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      const d0 = dOf(a, 'd0'), d1 = dOf(b, 'd0'), dd = d1 - d0;
      if (dd <= 0) continue;
      const delta = Math.abs(elevationOf(b) - elevationOf(a)), grade = delta / dd;
      const step = dd <= cfg.minStepDistanceMeters && delta > cfg.maxElevationStepMeters;
      const steep = grade > cfg.maxGrade && delta >= cfg.minGradeDeltaMeters;
      if (!step && !steep) continue;
      const why = [];
      if (step) why.push('salto de ' + fmt(delta) + ' m en ' + fmt(dd) + ' m (umbral ' + fmt(cfg.maxElevationStepMeters) + ' m)');
      if (steep) why.push('pendiente ' + fmt(grade * 100) + ' % (umbral ' + fmt(cfg.maxGrade * 100) + ' %)');
      out.emit('profile-inconsistent', d0, d1, step && delta > cfg.maxElevationStepMeters * 2 ? 'high' : 'medium', [
        evidenceOf(a, 'estimated', 'profile', src.profile.indexOf(a)),
        evidenceOf(b, 'estimated', 'profile', src.profile.indexOf(b)),
      ], why.join(' y ') + ': el perfil/cuneta podría estar desconectado; la causa no está determinada por estos datos.');
    }
  }

  function ruleVegetation(src, out) {
    const external = src.osm.map(r => ({ rec: r, pool: 'osm' }))
      .concat(src.reviews.map(r => ({ rec: r, pool: 'reviews' })));
    for (const veg of src.vegetation) {
      if (!veg || !finite(num(veg.d0)) || !finite(num(veg.d1))) continue;
      const mode = String(veg.mode || veg.source || '').toLowerCase();
      if (veg.procedural !== true && !/proced/.test(mode)) continue;
      for (const item of external) {
        const rec = item.rec;
        if (!rec || !rec.cover || !finite(num(rec.d0))) continue;
        const b1 = finite(num(rec.d1)) ? num(rec.d1) : num(rec.d0) + src.config.pointSpanMeters;
        if (rec.cover === veg.value || !overlaps(num(veg.d0), num(veg.d1), num(rec.d0), b1)) continue;
        const a0 = Math.max(num(veg.d0), num(rec.d0)), a1 = Math.min(num(veg.d1), b1);
        out.emit('vegetation-mismatch', a0, a1, item.pool === 'osm' ? 'high' : 'medium', [
          evidenceOf(veg, 'estimated', 'vegetation', src.vegetation.indexOf(veg)),
          evidenceOf(rec, item.pool === 'reviews' ? 'observed' : 'measured', item.pool, (item.pool === 'reviews' ? src.reviews : src.osm).indexOf(rec)),
        ], 'La cobertura ' + rec.cover + ' señalada por ' + item.pool + ' no coincide con la vegetación procedural '
          + veg.value + '; conviene revisar la zona antes de cambiarla.');
      }
    }
  }

  function ruleSlopes(src, out) {
    const cfg = src.config;
    for (const rec of src.slopes) {
      if (!rec || !finite(num(rec.d0)) || !finite(num(rec.d1))) continue;
      const ratio = num(rec.ratio !== undefined ? rec.ratio : rec.slope);
      if (!finite(ratio) || (ratio >= cfg.slopeMin && ratio <= cfg.slopeMax)) continue;
      out.emit('artificial-slope', num(rec.d0), num(rec.d1), 'medium', [
        evidenceOf(rec, 'estimated', 'slopes', src.slopes.indexOf(rec)),
      ], 'La relación lateral ' + fmt(ratio) + ':1 queda fuera del rango configurado '
        + fmt(cfg.slopeMin) + '–' + fmt(cfg.slopeMax) + ':1; el talud puede leerse como geometría artificial.');
    }
  }

  function ruleTexture(src, out) {
    for (const review of src.reviews) {
      if (!review || !review.materialClass || !(review.status === 'approved' || review.approved === true)) continue;
      const d0 = num(review.d0 !== undefined ? review.d0 : review.d);
      if (!finite(d0)) continue;
      const d1 = finite(num(review.d1)) ? num(review.d1) : d0 + src.config.pointSpanMeters;
      let emitted = false;
      for (const s of src.surface) {
        const ds = dOf(s, 'd0');
        if (!s || !finite(ds) || !materialOf(s) || materialOf(s) === review.materialClass) continue;
        if (ds < d0 - EPSILON || ds > d1 + EPSILON) continue;
        out.emit('texture-mismatch', d0, Math.max(d1, d0 + EPSILON), 'high', [
          evidenceOf(review, 'observed', 'reviews', src.reviews.indexOf(review)),
          evidenceOf(s, 'estimated', 'surface', src.surface.indexOf(s)),
        ], 'La revisión aprobó ' + review.materialClass + ' pero el tramo usa ' + materialOf(s)
          + ': la textura asignada podría no ser la revisada.');
        emitted = true;
        break;
      }
      void emitted;
    }
  }

  function ruleTransition(src, out) {
    const cfg = src.config;
    const arr = src.surface.filter(r => r && finite(dOf(r, 'd0')) && materialOf(r))
      .slice().sort((a, b) => dOf(a, 'd0') - dOf(b, 'd0'));
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i], d0 = dOf(a, 'd0'), d1 = dOf(b, 'd0'), dd = d1 - d0;
      if (materialOf(a) === materialOf(b) || dd <= 0 || dd >= cfg.minTransitionMeters) continue;
      out.emit('abrupt-material-transition', d0, d1, dd < cfg.minTransitionMeters / 2 ? 'high' : 'medium', [
        evidenceOf(a, 'estimated', 'surface', src.surface.indexOf(a)),
        evidenceOf(b, 'estimated', 'surface', src.surface.indexOf(b)),
      ], 'El material cambia de ' + materialOf(a) + ' a ' + materialOf(b) + ' en ' + fmt(dd)
        + ' m (umbral ' + fmt(cfg.minTransitionMeters) + ' m): puede notarse como transición brusca.');
    }
  }

  function detectIssues(project, route, opts) {
    const src = sourcesOf(project, opts);
    const out = emitter();
    ruleUniformSurface(src, out);
    ruleProfile(src, out);
    ruleVegetation(src, out);
    ruleSlopes(src, out);
    ruleTexture(src, out);
    ruleTransition(src, out);
    void route; // el recorrido se usa para acotar el alcance en applyFix; las reglas consumen datos inyectados
    return out.result();
  }

  // --- propuesta (nunca aplica, nunca muta project) ---

  function actionFor(issue, src, opts) {
    const refs = list(issue.evidence).map(e => e.ref);
    switch (issue.kind) {
      case 'surface-uniform': {
        const used = materialOf(findRecord(src, refs[0]));
        const suggested = opts.suggestedMaterialClass || (src.materials.length
          ? materialOf(src.materials.find(m => materialOf(m) && materialOf(m) !== used)) : null);
        if (!suggested || !used) throw new Error('planFix: se necesita suggestedMaterialClass o materials; no se inventa un material.');
        return { type: 'set-material', payload: { from: used, materialClass: suggested } };
      }
      case 'profile-inconsistent': {
        const a = findRecord(src, refs[0]), b = findRecord(src, refs[1]);
        if (!a || !b || !finite(elevationOf(a)) || !finite(elevationOf(b))) {
          throw new Error('planFix: faltan las muestras de elevación citadas en la evidencia.');
        }
        return { type: 'set-profile', payload: { mode: 'linear', from: elevationOf(a), to: elevationOf(b) } };
      }
      case 'vegetation-mismatch': {
        const rec = findInPool(src, 'reviews', refs[1]) || findInPool(src, 'osm', refs[1]);
        if (!rec || !rec.cover) throw new Error('planFix: falta la cobertura OSM/review citada en la evidencia.');
        return { type: 'set-vegetation', payload: {
          mode: findInPool(src, 'reviews', refs[1]) ? 'review' : 'osm',
          value: rec.cover,
          sourceRef: String(rec.ref || rec.id || ''),
        } };
      }
      case 'artificial-slope': {
        const rec = findRecord(src, refs[0]);
        const ratio = num(rec && (rec.ratio !== undefined ? rec.ratio : rec.slope));
        if (!rec || !finite(ratio)) throw new Error('planFix: falta el talud citado en la evidencia.');
        return { type: 'set-slope', payload: {
          ratio: round3(clamp(ratio, src.config.slopeMin, src.config.slopeMax)),
          side: rec.side || 'both',
        } };
      }
      case 'texture-mismatch': {
        const rec = findInPool(src, 'reviews', refs[0]);
        if (!rec || !rec.materialClass) throw new Error('planFix: falta la review aprobada citada en la evidencia.');
        return { type: 'set-surface', payload: {
          materialClass: rec.materialClass,
          reviewRef: String(rec.ref || rec.id || ''),
        } };
      }
      case 'abrupt-material-transition': {
        const a = findRecord(src, refs[0]), b = findRecord(src, refs[1]);
        if (!a || !b || !materialOf(a) || !materialOf(b)) throw new Error('planFix: faltan las muestras de material citadas.');
        return { type: 'blend-materials', payload: {
          from: materialOf(a), to: materialOf(b), rampMeters: src.config.minTransitionMeters,
        } };
      }
      default:
        throw new Error('planFix: no hay acción conocida para ' + issue.kind + '.');
    }
  }

  function proposalState(scope, action) {
    const edit = action ? Object.assign({}, clone(action.payload || {}), {
      kind: action.type, d0: scope.d0, d1: scope.d1,
    }) : null;
    return {
      scope: { d0: scope.d0, d1: scope.d1 },
      edits: edit ? [edit] : [],
      status: action ? 'propuesto (no aplicado)' : 'estado actual (no aplicado)',
    };
  }

  function confidenceOf(evidence) {
    const ev = list(evidence);
    if (!ev.length) return 0;
    const sum = ev.reduce((a, e) => a + (CONFIDENCE[e.type] !== undefined ? CONFIDENCE[e.type] : CONFIDENCE.estimated), 0);
    return Math.round(sum / ev.length * 100) / 100;
  }

  function planFix(project, issue, opts) {
    if (!issue || typeof issue.kind !== 'string') throw new Error('Issue inválido para planificar.');
    if (!finite(issue.d0) || !finite(issue.d1) || num(issue.d1) <= num(issue.d0)) {
      throw new Error('El issue no tiene un scope válido.');
    }
    const scope = { d0: round3(num(issue.d0)), d1: round3(num(issue.d1)) };
    const src = sourcesOf(project, opts);
    const action = actionFor(issue, src, opts || {});
    return {
      issueId: issue.id,
      kind: issue.kind,
      scope,
      action,
      reversible: true,
      before: proposalState(scope, null),
      after: proposalState(scope, action),
      evidenceBasis: list(issue.evidence).map(e => (e.type || 'estimated') + ':' + e.ref),
      confidence: confidenceOf(issue.evidence),
    };
  }

  // --- aplicación / deshacer ---

  function routeInfo(project, opts) {
    const o = opts || {};
    const r = o.route || (project && project.route);
    let length = finite(o.routeLength) ? num(o.routeLength) : (r && finite(r.lengthMeters) ? num(r.lengthMeters) : null);
    if (length === null) {
      const pts = Array.isArray(r) ? r : (r && Array.isArray(r.points) ? r.points : []);
      length = polylineLength(pts);
    }
    const pts = Array.isArray(r) ? r : (r && Array.isArray(r.points) ? r.points : []);
    return { length, points: pts };
  }

  function assertScopeInRoute(scope, info) {
    if (!scope || !finite(scope.d0) || !finite(scope.d1) || num(scope.d1) <= num(scope.d0)) {
      throw new Error('Scope inválido: se necesitan d0 < d1.');
    }
    if (!info || !finite(info.length) || info.length <= 0) {
      throw new Error('No se conoce la longitud de la ruta: no se puede validar el scope.');
    }
    if (num(scope.d0) < -EPSILON || num(scope.d1) > num(info.length) + EPSILON) {
      throw new Error('El scope queda fuera de la ruta (' + fmt(info.length) + ' m).');
    }
  }

  function applyFix(project, plan, engine, opts) {
    if (!plan || plan.reversible !== true) throw new Error('El plan no es reversible: no se aplica.');
    if (!engine || typeof engine.snapshot !== 'function' || typeof engine.applyLocal !== 'function'
      || typeof engine.restore !== 'function') {
      throw new Error('Engine inválido: se necesitan snapshot(), applyLocal() y restore().');
    }
    assertScopeInRoute(plan.scope, routeInfo(project, opts));
    const before = engine.snapshot();
    let after;
    try {
      engine.applyLocal({ d0: num(plan.scope.d0), d1: num(plan.scope.d1) }, clone(plan.action || {}));
      after = engine.snapshot();
    } catch (err) {
      try { engine.restore(before); } catch (_) { /* se propaga el error original */ }
      throw err;
    }
    const undoToken = 'undo-' + (++tokenSeq);
    tokens.set(undoToken, {
      engine,
      snapshot: clone(before),
      plan: clone(plan),
      scope: { d0: num(plan.scope.d0), d1: num(plan.scope.d1) },
      at: new Date().toISOString(),
    });
    return { applied: true, undoToken, before, after };
  }

  function recordUndo(project, change) {
    const recon = root.Reconstruction;
    if (recon && typeof recon.addChange === 'function') {
      recon.addChange(project, change);
      return;
    }
    // Evitamos depender del módulo en tiempo de carga: si no está el global,
    // se intenta require y, como último recurso, se escribe la forma mínima.
    try {
      const M = require('./model.js');
      if (M && typeof M.addChange === 'function') { M.addChange(project, change); return; }
    } catch (_) { /* entorno sin require */ }
    if (!project || !Array.isArray(project.changes)) throw new Error('No se puede registrar el desenuido: proyecto sin changes.');
    project.changes.push(Object.assign({ at: new Date().toISOString(), reversible: false }, clone(change)));
  }

  function undoFix(project, undoToken, engine, opts) {
    void opts;
    const rec = tokens.get(undoToken);
    if (!rec) throw new Error('Token de deshacer desconocido o ya usado.');
    if (engine && rec.engine !== engine) throw new Error('El token pertenece a otro engine.');
    const e = engine || rec.engine;
    if (!e || typeof e.restore !== 'function' || typeof e.snapshot !== 'function') throw new Error('Engine inválido para deshacer.');
    const before = e.snapshot();
    e.restore(rec.snapshot);
    tokens.delete(undoToken);
    recordUndo(project, {
      kind: 'fix-undo',
      action: 'undo',
      issueId: rec.plan.issueId,
      planKind: rec.plan.kind,
      scope: clone(rec.scope),
      reversible: false,
      detail: 'Se restauró el estado previo al fix ' + rec.plan.kind + ' en '
        + fmt(rec.scope.d0) + '–' + fmt(rec.scope.d1) + ' m.',
    });
    return { undone: true, before, after: e.snapshot(), scope: clone(rec.scope) };
  }

  // --- comparación legible ---

  function isRecord(r) { return !!r && typeof r === 'object' && (finite(r.d0) || finite(r.d)); }
  function bounds(r) {
    const a = finite(r.d0) ? num(r.d0) : num(r.d);
    const b = finite(r.d1) ? num(r.d1) : a;
    return [a, b];
  }
  function keyOf(r, i) {
    if (r.id !== undefined) return 'id:' + String(r.id);
    const ab = bounds(r);
    return 'at:' + fmt(ab[0]) + '-' + fmt(ab[1]) + '#' + i;
  }
  function labelOf(r) {
    const ab = bounds(r);
    return String(r.kind || r.type || 'edit') + ' @ ' + fmt(ab[0]) + '–' + fmt(ab[1]) + ' m';
  }
  function recordsOf(snap) {
    if (Array.isArray(snap)) return snap.filter(isRecord);
    if (!snap || typeof snap !== 'object') return [];
    const arr = snap.edits || snap.sections || snap.records || [];
    return Array.isArray(arr) ? arr.filter(isRecord) : [];
  }
  function within(r, scope) {
    const ab = bounds(r);
    return ab[0] >= num(scope.d0) - EPSILON && ab[1] <= num(scope.d1) + EPSILON;
  }

  function compareFix(before, after, scope) {
    if (!scope || !finite(scope.d0) || !finite(scope.d1) || num(scope.d1) <= num(scope.d0)) {
      throw new Error('compareFix: scope inválido.');
    }
    const s = { d0: num(scope.d0), d1: num(scope.d1) };
    const A = recordsOf(before), B = recordsOf(after);
    const changes = [], outside = [];

    if (!A.length && !B.length) {
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push('~ estado: ' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
        outside.push('estado');
      }
      return { scope: s, changes, outside, ok: outside.length === 0,
        text: changes.length ? changes.join('\n') : 'Sin cambios dentro del scope.' };
    }

    const beforeMap = new Map(), afterMap = new Map();
    A.forEach((r, i) => beforeMap.set(keyOf(r, i), r));
    B.forEach((r, i) => afterMap.set(keyOf(r, i), r));

    for (const [key, r] of beforeMap) {
      if (afterMap.has(key)) continue;
      changes.push('− ' + labelOf(r) + ' (eliminado)');
      if (!within(r, s)) outside.push(labelOf(r));
    }
    for (const [key, r] of afterMap) {
      if (!beforeMap.has(key)) {
        changes.push('+ ' + labelOf(r) + ' (agregado)');
        if (!within(r, s)) outside.push(labelOf(r));
        continue;
      }
      const prev = beforeMap.get(key);
      const keys = new Set(Object.keys(prev).concat(Object.keys(r)));
      keys.delete('id');
      let changedHere = false;
      for (const field of keys) {
        if (JSON.stringify(prev[field]) === JSON.stringify(r[field])) continue;
        changes.push('~ ' + labelOf(r) + '.' + field + ': '
          + JSON.stringify(prev[field]) + ' → ' + JSON.stringify(r[field]));
        changedHere = true;
      }
      if (changedHere && !within(r, s)) outside.push(labelOf(r));
    }
    return { scope: s, changes, outside, ok: outside.length === 0,
      text: changes.length ? changes.join('\n') : 'Sin cambios dentro del scope.' };
  }

  // Motor en memoria para tests: snapshot profundo, sin depender del DOM ni de la app.
  function memoryEngine(initial) {
    let state = initial === undefined ? { edits: [] } : clone(initial);
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = { edits: [] };
    if (!Array.isArray(state.edits)) state.edits = [];
    let seq = 0;
    return {
      snapshot() { return clone(state); },
      applyLocal(scope, action) {
        if (!scope || !action || typeof action.type !== 'string') throw new Error('applyLocal: scope/action inválidos.');
        if (!Array.isArray(state.edits)) state.edits = [];
        const edit = Object.assign({}, clone(action.payload || {}), {
          id: 'local-' + (++seq),
          kind: action.type,
          d0: num(scope.d0),
          d1: num(scope.d1),
        });
        state.edits.push(edit);
        return clone(edit);
      },
      restore(snap) {
        state = snap === undefined ? { edits: [] } : clone(snap);
        if (!state || typeof state !== 'object' || Array.isArray(state)) state = { edits: [] };
        if (!Array.isArray(state.edits)) state.edits = [];
        return this.snapshot();
      },
    };
  }

  const api = {
    EVIDENCE_TYPES, DEFAULT_CONFIG, detectIssues, planFix, applyFix, undoFix, compareFix, memoryEngine,
  };
  root.Reconstruction = Object.assign(root.Reconstruction || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
