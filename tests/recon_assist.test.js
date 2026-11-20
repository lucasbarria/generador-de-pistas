// ---------------------------------------------------------------------------
// SYNTHETIC TEST DATA — todos los datos de este archivo son sintéticos.
// Es una prueba técnica del detector/planificador: NO son datos geográficos,
// NO representan Aguas Blancas ni ningún tramo real, y NO se usa la red.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../src/recon/assist.js');
const M = require('../src/recon/model.js');

function syntheticProject() {
  const p = M.blankProject({ name: 'SYNTHETIC TEST DATA · tramo ficticio' });
  // Coordenadas inventadas solo para dar forma al objeto de ruta.
  M.setRoute(p, [[-54.6000, -67.2000], [-54.6090, -67.2000]], {
    kind: 'synthetic-test-data',
    label: 'SYNTHETIC TEST DATA (no geographic)',
    provenance: M.PROVENANCE.ESTIMATED,
  });
  p.route.lengthMeters = 1000; // longitud sintética explícita, en metros
  return p;
}

function syntheticRoute(project) {
  return { points: project.route.points, lengthMeters: project.route.lengthMeters };
}

function syntheticOpts() {
  // Cada ref apunta a un registro real del arreglo inyectado; no se crea evidencia.
  return {
    surface: [
      { d: 0, materialClass: 'GRAVEL', provenance: 'measured', ref: 'SYNTH-surface-0' },
      { d: 400, materialClass: 'GRAVEL', provenance: 'measured', ref: 'SYNTH-surface-400' },
      { d: 410, materialClass: 'DIRT', provenance: 'estimated', ref: 'SYNTH-surface-410' },
      { d: 460, materialClass: 'GRAVEL', provenance: 'measured', ref: 'SYNTH-surface-460' },
    ],
    profile: [
      { d: 0, elevation: 100, provenance: 'measured', ref: 'SYNTH-profile-0' },
      { d: 8, elevation: 103.2, provenance: 'measured', ref: 'SYNTH-profile-8' },
      { d: 60, elevation: 104, provenance: 'measured', ref: 'SYNTH-profile-60' },
    ],
    vegetation: [
      { d0: 100, d1: 220, mode: 'procedural', value: 'grass', provenance: 'estimated', ref: 'SYNTH-veg-1' },
    ],
    osm: [
      { d0: 130, d1: 190, cover: 'forest', ref: 'SYNTH-osm-1' },
    ],
    slopes: [
      { d0: 300, d1: 380, ratio: 0.1, provenance: 'estimated', ref: 'SYNTH-slope-1' },
    ],
    reviews: [
      { d0: 400, d1: 460, materialClass: 'DIRT', status: 'approved', ref: 'SYNTH-review-1' },
    ],
    config: { uniformMeters: 300, minTransitionMeters: 25, slopeMin: 0.3, slopeMax: 4 },
  };
}

function detected() {
  const project = syntheticProject();
  const issues = A.detectIssues(project, syntheticRoute(project), syntheticOpts());
  return { project, issues };
}

test('detección determinista (SYNTHETIC TEST DATA): reglas, evidencia e inferencia separadas', () => {
  const project = syntheticProject();
  const route = syntheticRoute(project);
  const first = A.detectIssues(project, route, syntheticOpts());
  const second = A.detectIssues(project, route, syntheticOpts());
  assert.deepEqual(first, second, 'el detector no debe depender de azar, fecha ni red');

  const kinds = first.map(i => i.kind);
  for (const expected of [
    'surface-uniform', 'profile-inconsistent', 'vegetation-mismatch',
    'artificial-slope', 'texture-mismatch', 'abrupt-material-transition',
  ]) {
    assert.ok(kinds.includes(expected), 'faltó detectar ' + expected + ' · ' + kinds.join(', '));
  }

  for (const issue of first) {
    assert.deepEqual(Object.keys(issue).sort(), ['d0', 'd1', 'evidence', 'id', 'inference', 'kind', 'severity']);
    assert.ok(issue.id.length > 0);
    assert.ok(issue.d1 > issue.d0);
    assert.ok(['low', 'medium', 'high'].includes(issue.severity));
    assert.ok(issue.evidence.length >= 1);
    for (const ev of issue.evidence) {
      assert.deepEqual(Object.keys(ev).sort(), ['ref', 'type']);
      assert.ok(A.EVIDENCE_TYPES.includes(ev.type));
      assert.match(ev.ref, /^SYNTH-/, 'toda evidencia debe citar un dato inyectado');
    }
    assert.match(issue.inference, /^Inferencia/);
    assert.ok(!JSON.stringify(issue.evidence).includes('Inferencia'));
  }
});

test('detectIssues sin datos auxiliares no inventa problemas (SYNTHETIC TEST DATA)', () => {
  const project = syntheticProject();
  assert.deepEqual(A.detectIssues(project, syntheticRoute(project), {}), []);
});

test('planFix no muta el proyecto y propone una única acción dentro del scope', () => {
  const { project, issues } = detected();
  const before = JSON.stringify(project);
  const plans = issues.map(i => A.planFix(project, i, Object.assign(
    { suggestedMaterialClass: 'SAND' }, syntheticOpts())));
  assert.equal(JSON.stringify(project), before, 'planificar no debe tocar el proyecto');

  for (const plan of plans) {
    assert.deepEqual(Object.keys(plan).sort(), [
      'action', 'after', 'before', 'confidence', 'evidenceBasis', 'issueId', 'kind', 'reversible', 'scope',
    ]);
    assert.equal(plan.reversible, true);
    assert.ok(plan.confidence >= 0 && plan.confidence <= 1);
    assert.ok(plan.scope.d1 > plan.scope.d0);
    assert.deepEqual(plan.before.edits, []);
    assert.equal(plan.after.edits.length, 1);
    const edit = plan.after.edits[0];
    assert.equal(edit.d0, plan.scope.d0);
    assert.equal(edit.d1, plan.scope.d1);
    assert.equal(edit.kind, plan.action.type);
    assert.ok(plan.evidenceBasis.every(x => x.includes(':')));
    assert.match(plan.after.status, /no aplicado/);
  }
});

test('applyFix aplica solo dentro del scope y compareFix detecta cambios (SYNTHETIC TEST DATA)', () => {
  const { project, issues } = detected();
  const issue = issues.find(i => i.kind === 'artificial-slope');
  const plan = A.planFix(project, issue, syntheticOpts());
  const engine = A.memoryEngine({ edits: [
    { id: 'SYNTH-outside', kind: 'bank', d0: 0, d1: 100, value: 9 },
    { id: 'SYNTH-near', kind: 'section', d0: 300, d1: 380, talud: 1.5 },
  ] });
  const before = engine.snapshot();
  const projectBefore = JSON.stringify(project);

  const result = A.applyFix(project, plan, engine, { route: syntheticRoute(project) });
  assert.equal(result.applied, true);
  assert.equal(typeof result.undoToken, 'string');
  assert.deepEqual(result.before, before);
  assert.equal(result.after.edits.length, before.edits.length + 1);
  assert.deepEqual(result.after.edits.slice(0, 2), before.edits, 'lo previo fuera del scope queda intacto');
  const added = result.after.edits[result.after.edits.length - 1];
  assert.equal(added.d0, plan.scope.d0);
  assert.equal(added.d1, plan.scope.d1);
  assert.equal(added.kind, plan.action.type);
  assert.equal(JSON.stringify(project), projectBefore, 'applyFix no debe mutar el proyecto');

  const cmp = A.compareFix(before, result.after, plan.scope);
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.outside, []);
  assert.ok(cmp.changes.length > 0);
  assert.match(cmp.text, /set-slope/);

  const tampered = JSON.parse(JSON.stringify(result.after));
  tampered.edits[0].value = 999; // cambio artificial fuera del scope
  const bad = A.compareFix(before, tampered, plan.scope);
  assert.equal(bad.ok, false);
  assert.ok(bad.outside.length > 0);
});

test('undoFix restaura exactamente el snapshot previo y consume el token', () => {
  const { project, issues } = detected();
  const plan = A.planFix(project, issues.find(i => i.kind === 'profile-inconsistent'), syntheticOpts());
  const engine = A.memoryEngine({ edits: [{ id: 'SYNTH-base', kind: 'profile', d0: 0, d1: 500 }] });
  const before = engine.snapshot();
  const result = A.applyFix(project, plan, engine, { route: syntheticRoute(project) });
  assert.notDeepEqual(engine.snapshot(), before);

  const undone = A.undoFix(project, result.undoToken, engine, {});
  assert.equal(undone.undone, true);
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(JSON.stringify(engine.snapshot()), JSON.stringify(before));
  assert.throws(() => A.undoFix(project, result.undoToken, engine, {}), /Token de deshacer/);
});

test('applyFix rechaza planes no reversibles y scopes fuera de la ruta', () => {
  const { project, issues } = detected();
  const plan = A.planFix(project, issues[0], Object.assign({ suggestedMaterialClass: 'SAND' }, syntheticOpts()));
  const engine = A.memoryEngine();
  const route = syntheticRoute(project);

  assert.throws(() => A.applyFix(project, Object.assign({}, plan, { reversible: false }), engine, { route }),
    /no es reversible/i);
  assert.throws(() => A.applyFix(project, Object.assign({}, plan, {
    scope: { d0: 900, d1: 1200 },
  }), engine, { route }), /fuera de la ruta/i);
  assert.deepEqual(engine.snapshot(), { edits: [] }, 'un rechazo no debe aplicar nada');
});

test('undoFix persiste el desenuido con Recon.addChange y con fallback a model.js', () => {
  const { project, issues } = detected();
  const plan = A.planFix(project, issues.find(i => i.kind === 'texture-mismatch'), syntheticOpts());
  const engine = A.memoryEngine();
  const route = syntheticRoute(project);
  const savedGlobal = globalThis.Reconstruction;

  try {
    const first = A.applyFix(project, plan, engine, { route });
    const calls = [];
    globalThis.Reconstruction = {
      addChange: (proj, change) => {
        calls.push(change);
        proj.changes.push(Object.assign({ viaSpy: true }, change));
      },
    };
    A.undoFix(project, first.undoToken, engine, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'fix-undo');
    assert.equal(project.changes[project.changes.length - 1].viaSpy, true);
  } finally {
    globalThis.Reconstruction = savedGlobal;
  }

  const second = A.applyFix(project, plan, engine, { route });
  try {
    delete globalThis.Reconstruction; // fuerza el require('./model.js') de fallback
    A.undoFix(project, second.undoToken, engine, {});
  } finally {
    globalThis.Reconstruction = savedGlobal;
  }
  const last = project.changes[project.changes.length - 1];
  assert.equal(last.kind, 'fix-undo');
  assert.equal(last.reversible, false);
  assert.deepEqual(last.scope, plan.scope);
  assert.match(last.detail, /restauró el estado previo/);
});
