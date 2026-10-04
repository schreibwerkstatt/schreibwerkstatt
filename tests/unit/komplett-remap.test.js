'use strict';
// Unit: Phase-5-Remap der Komplettanalyse – mappt Phase-1-Klarnamen (Figuren/Orte)
// auf konsolidierte IDs. Nicht auflösbare Namen werden gedroppt; KI-Halluzinationen
// (Markdown-Präfix, Kapitelname als Seitentitel) werden geglättet; Events dedupliziert.

const test = require('node:test');
const assert = require('node:assert/strict');
const { remapSzenen, remapAssignments, _isSelfCancelled } = require('../../routes/jobs/komplett/remap');

const noopLog = { info() {}, warn() {} };

// ── remapSzenen ───────────────────────────────────────────────────────────────
const FIG = { Anna: 'fig_1', Bert: 'fig_2' };
const FIG_LOWER = { anna: 'fig_1', bert: 'fig_2' };
const ORT = { Wald: 'ort_1' };
const ORT_LOWER = { wald: 'ort_1' };
const CH = { 'Kapitel Eins': 1100 };

test('remapSzenen: Namen → IDs, unbekannte werden gedroppt', () => {
  const out = remapSzenen([
    { kapitel: 'Kapitel Eins', szenen: [{
      titel: 'Szene', kapitel: 'Kapitel Eins', seite: 'Seite Eins',
      figuren_namen: ['Anna', 'Geist'], orte_namen: ['Wald', 'Nirgendwo'],
    }] },
  ], FIG, FIG_LOWER, ORT, ORT_LOWER, CH, noopLog);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].fig_ids, ['fig_1']);
  assert.deepEqual(out[0].ort_ids, ['ort_1']);
  assert.equal(out[0].sort_order, 0);
});

test('remapSzenen: Case-insensitiver Fallback', () => {
  const out = remapSzenen([
    { kapitel: 'Kapitel Eins', szenen: [{ titel: 'S', figuren_namen: ['anna'], orte_namen: ['WALD'] }] },
  ], FIG, FIG_LOWER, ORT, ORT_LOWER, CH, noopLog);
  assert.deepEqual(out[0].fig_ids, ['fig_1']);
  assert.deepEqual(out[0].ort_ids, ['ort_1']);
});

test('remapSzenen: Markdown-Präfix gestrippt, Kapitelname-als-Seite → null', () => {
  const out = remapSzenen([
    { kapitel: 'Kapitel Eins', szenen: [
      { titel: 'A', seite: '### Seite Eins', figuren_namen: [], orte_namen: [] },
      { titel: 'B', seite: 'Kapitel Eins', figuren_namen: [], orte_namen: [] },        // == Kapitel → null
      { titel: 'C', seite: 'Sonstige Abschnitte', figuren_namen: [], orte_namen: [] },  // Fallback-Marker → null
      { titel: 'D', seite: 'Sonstige Seiten', figuren_namen: [], orte_namen: [] },      // früherer Marker → null
    ] },
  ], FIG, FIG_LOWER, ORT, ORT_LOWER, CH, noopLog);
  assert.equal(out[0].seite, 'Seite Eins');
  assert.equal(out[1].seite, null);
  assert.equal(out[2].seite, null);
  assert.equal(out[3].seite, null);
});

test('remapSzenen: Objekt-Refs werden auf Namen reduziert', () => {
  const out = remapSzenen([
    { kapitel: 'Kapitel Eins', szenen: [{ titel: 'S', figuren_namen: [{ name: 'Anna' }], orte_namen: [{ name: 'Wald' }] }] },
  ], FIG, FIG_LOWER, ORT, ORT_LOWER, CH, noopLog);
  assert.deepEqual(out[0].fig_ids, ['fig_1']);
  assert.deepEqual(out[0].ort_ids, ['ort_1']);
});

test('remapSzenen: unbekanntes s.kapitel fällt auf das äussere Kapitel zurück', () => {
  const out = remapSzenen([
    { kapitel: 'Kapitel Eins', szenen: [{ titel: 'S', kapitel: 'Nicht existent', figuren_namen: [], orte_namen: [] }] },
  ], FIG, FIG_LOWER, ORT, ORT_LOWER, CH, noopLog);
  assert.equal(out[0].kapitel, 'Kapitel Eins');
});

// ── remapAssignments ──────────────────────────────────────────────────────────
test('remapAssignments: Events pro Figur gesammelt + dedupliziert', () => {
  const out = remapAssignments([
    { kapitel: 'Kapitel Eins', assignments: [{ figur_name: 'Anna', lebensereignisse: [
      { datum_year: 1990, datum_month: 1, datum_day: 1, ereignis: 'Geboren' },
      { datum_year: 1990, datum_month: 1, datum_day: 1, ereignis: 'geboren' }, // Duplikat (case-insensitiv)
      { datum_year: 2010, ereignis: 'Umzug' },
    ] }] },
  ], FIG, FIG_LOWER, CH, noopLog, 'job1');
  assert.equal(out.length, 1);
  assert.equal(out[0].fig_id, 'fig_1');
  assert.equal(out[0].lebensereignisse.length, 2);
});

test('remapAssignments: Assignment ohne auflösbare Figuren-ID wird gedroppt', () => {
  let warned = 0;
  const log = { info() {}, warn() { warned++; } };
  const out = remapAssignments([
    { kapitel: 'Kapitel Eins', assignments: [
      { figur_name: 'Anna', lebensereignisse: [{ datum_year: 2000, ereignis: 'X' }] },
      { figur_name: 'Phantom', lebensereignisse: [{ datum_year: 2000, ereignis: 'Y' }] },
    ] },
  ], FIG, FIG_LOWER, CH, log, 'job1');
  assert.equal(out.length, 1);
  assert.equal(out[0].fig_id, 'fig_1');
  assert.ok(warned >= 1, 'Drop sollte geloggt werden');
});

test('remapAssignments: Event-Kapitel-Präfix gestrippt, unbekanntes Kapitel → Fallback', () => {
  const out = remapAssignments([
    { kapitel: 'Kapitel Eins', assignments: [{ figur_name: 'Anna', lebensereignisse: [
      { datum_year: 2000, ereignis: 'A', kapitel: '### Kapitel Eins', seite: '## Seite Eins' },
      { datum_year: 2001, ereignis: 'B', kapitel: 'Unbekannt' },
    ] }] },
  ], FIG, FIG_LOWER, CH, noopLog, 'job1');
  const evs = out[0].lebensereignisse;
  assert.equal(evs[0].kapitel, 'Kapitel Eins');
  assert.equal(evs[0].seite, 'Seite Eins');
  assert.equal(evs[1].kapitel, 'Kapitel Eins'); // Fallback auf äusseres Kapitel
});

// ── remapAssignments: figur_name als Objekt (KI-Drift) darf nicht crashen ──────
test('remapAssignments: figur_name als Objekt wird via _refToString aufgelöst (kein Crash)', () => {
  const out = remapAssignments([
    { kapitel: 'Kapitel Eins', assignments: [
      { figur_name: { name: 'Anna' }, lebensereignisse: [{ datum_year: 2000, ereignis: 'X' }] },
      { figur_name: { id: 'fig_99' }, lebensereignisse: [{ datum_year: 2001, ereignis: 'Y' }] }, // nicht auflösbar → gedroppt
    ] },
  ], FIG, FIG_LOWER, CH, noopLog, 'job1');
  assert.equal(out.length, 1, 'Objekt {name:"Anna"} → fig_1, der unauflösbare wird gedroppt');
  assert.equal(out[0].fig_id, 'fig_1');
});

// ── _isSelfCancelled: Selbst-Entwarnungs-Filter (synchron mit PROBLEME_RULES) ──
test('_isSelfCancelled: echte Entwarnungs-Phrasen werden erkannt', () => {
  assert.ok(_isSelfCancelled({ beschreibung: 'Hier liegt kein echter Widerspruch vor.' }));
  assert.ok(_isSelfCancelled({ beschreibung: 'Das passt zusammen.' }));
  assert.ok(_isSelfCancelled({ beschreibung: 'Das ist korrekt.' }));
  assert.ok(_isSelfCancelled({ empfehlung: 'Eintrag entfernen.' }));
  // «lässt sich erklären durch …» als Entwarnung in der beschreibung
  assert.ok(_isSelfCancelled({ beschreibung: 'Der scheinbare Bruch lässt sich erklären durch eine Rückblende.' }));
});

test('_isSelfCancelled: legitime Lösungs-Empfehlung mit «lässt sich erklären» bleibt erhalten (Rang 7)', () => {
  // KERN-REGRESSION: eine Empfehlung, die eine LÖSUNG vorschlägt, darf den Befund NICHT annullieren.
  assert.equal(_isSelfCancelled({
    beschreibung: 'Anna ist in Kapitel 2 tot, taucht aber in Kapitel 5 lebend auf.',
    empfehlung: 'Der Widerspruch lässt sich erklären, indem in Kapitel 3 ein Hinweis auf ihr Überleben ergänzt wird.',
  }), false);
  // «lässt sich erklären» OHNE «durch» in der beschreibung ist ebenfalls keine Annullierung mehr.
  assert.equal(_isSelfCancelled({
    beschreibung: 'Der Bruch lässt sich erklären, wenn man Kapitel 4 ergänzt.',
  }), false);
});
