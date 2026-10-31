// Lauf-Umfang der Komplettanalyse. Der Schritt-Katalog steht ZWEIMAL — serverseitig
// in lib/komplett-scope.js (CJS, Normalisierung im Route-Handler + Gating im Job) und
// im Browser in public/js/komplett-scope.js (ESM, Rendering des Modals). Drei Dinge,
// die ohne Gate still auseinanderlaufen:
//
//   1. Ein Schritt nur auf einer Seite heisst: das Modal zeigt einen Schalter, den
//      der Job nie liest (die Abwahl bleibt wirkungslos) — oder der Job gated eine
//      Phase, die niemand einschalten kann.
//   2. Jeder Schritt braucht Label UND Hinweis in BEIDEN Locales; ein Kern-Schritt
//      wenigstens sein Label (er steht als Inventar-Zeile im Modal).
//   3. Fehlend muss AN bedeuten: ein Aufrufer ohne `scope` (Nacht-Cron) und eine
//      gespeicherte Zeile von vor einem neuen Schritt sollen vollstaendig laufen,
//      nicht still eine Phase auslassen.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as browser from '../../public/js/komplett-scope.js';

const require = createRequire(import.meta.url);
const server = require('../../lib/komplett-scope.js');

const root = new URL('../../', import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));

test('Schritt-Katalog: Server und Browser sind deckungsgleich', () => {
  assert.deepEqual(browser.KOMPLETT_STEPS, server.KOMPLETT_STEPS);
  assert.deepEqual(browser.KOMPLETT_CORE_STEPS, server.KOMPLETT_CORE_STEPS);
  assert.deepEqual(browser.KOMPLETT_STEP_KEYS, server.KOMPLETT_STEP_KEYS);
});

test('Jeder Schritt hat eine bekannte Gruppe und einen Cloud-Flag', () => {
  for (const step of server.KOMPLETT_STEPS) {
    assert.ok(['katalog', 'pruefung'].includes(step.group), `unbekannte Gruppe: ${step.group}`);
    assert.equal(typeof step.cloudOnly, 'boolean', `${step.key}: cloudOnly fehlt`);
  }
  // Kern und abwaehlbare Schritte duerfen sich nicht ueberschneiden — sonst stuende
  // derselbe Schritt als Schalter UND als „laeuft immer" im selben Dialog.
  for (const key of server.KOMPLETT_CORE_STEPS) {
    assert.ok(!server.KOMPLETT_STEP_KEYS.includes(key), `${key} ist Kern UND abwaehlbar`);
  }
});

test('normalizeKomplettScope: Fehlendes ist an, Unbekanntes faellt weg', () => {
  const full = server.normalizeKomplettScope(null);
  assert.deepEqual(Object.keys(full).sort(), [...server.KOMPLETT_STEP_KEYS].sort());
  assert.ok(Object.values(full).every(v => v === true), 'ohne Angabe laeuft alles');

  const partial = server.normalizeKomplettScope({ orte: false, quatsch: true });
  assert.equal(partial.orte, false);
  assert.equal(partial.szenen, true, 'ein nicht genannter Schritt laeuft');
  assert.ok(!('quatsch' in partial), 'unbekannte Schluessel fallen weg');

  // Nur exakt `false` waehlt ab — ein truthy-Schrott-Wert darf nicht abwaehlen.
  assert.equal(server.normalizeKomplettScope({ orte: 0 }).orte, true);
});

test('normalizeKomplettScope: Browser und Server entscheiden gleich', () => {
  for (const raw of [null, {}, { orte: false }, { orte: false, kontinuitaet: false }, { fremd: 1 }]) {
    assert.deepEqual(browser.normalizeKomplettScope(raw), server.normalizeKomplettScope(raw),
      `Abweichung bei ${JSON.stringify(raw)}`);
  }
});

test('isFullKomplettScope: nur der vollstaendige Umfang darf den Checkpoint schreiben', () => {
  assert.equal(server.isFullKomplettScope(null), true);
  assert.equal(server.isFullKomplettScope({ coverage: false }), false);
  assert.equal(browser.isFullKomplettScope({ coverage: false }), false);
  assert.deepEqual(server.skippedKomplettSteps({ coverage: false, orte: false }), ['orte', 'coverage']);
});

test('Jeder Schritt hat Label (+ Hinweis) in beiden Locales', () => {
  for (const loc of ['de', 'en']) {
    const i18n = readJson(`public/js/i18n/${loc}.json`);
    for (const key of server.KOMPLETT_STEP_KEYS) {
      assert.ok(i18n[`komplett.step.${key}`], `${loc}: komplett.step.${key} fehlt`);
      assert.ok(i18n[`komplett.stepHint.${key}`], `${loc}: komplett.stepHint.${key} fehlt`);
    }
    for (const key of server.KOMPLETT_CORE_STEPS) {
      assert.ok(i18n[`komplett.step.${key}`], `${loc}: komplett.step.${key} (Kern) fehlt`);
    }
  }
});

// Phasen-Grenzen: der Job meldet sie über PHASE_END, das Status-Panel hakt daran ab.
// Eine Grenze als Zahl-Literal im Job wäre wieder eine zweite Wahrheit — verschiebt
// sie jemand, hakt das Panel zu früh oder zu spät ab, ohne dass ein Test es merkt.
test('Phasen: Server und Browser deckungsgleich, aufsteigend, Umfang bekannt, Label vorhanden', () => {
  assert.deepEqual(browser.KOMPLETT_PHASES, server.KOMPLETT_PHASES);
  let prev = 0;
  for (const ph of server.KOMPLETT_PHASES) {
    assert.ok(ph.end > prev && ph.end < 100, `${ph.key}: end ${ph.end} nicht aufsteigend in (0,100)`);
    prev = ph.end;
    for (const k of ph.scope || []) assert.ok(server.KOMPLETT_STEP_KEYS.includes(k), `${ph.key}: unbekannter Schritt ${k}`);
  }
  for (const loc of ['de', 'en']) {
    const i18n = readJson(`public/js/i18n/${loc}.json`);
    for (const ph of server.KOMPLETT_PHASES) assert.ok(i18n[`phase.${ph.key}`], `${loc}: phase.${ph.key} fehlt`);
  }
});

test('Phasen: der Komplett-Job meldet Phasengrenzen nur über PHASE_END', () => {
  const ends = new Set(server.KOMPLETT_PHASES.map(p => p.end));
  const files = [
    'routes/jobs/komplett/job-komplett.js',
    'routes/jobs/komplett/phases/beziehungen-zeitstrahl.js',
    'routes/jobs/komplett/phases/extraktion.js',
    'routes/jobs/komplett/phases/extraktion/multi-pass.js',
    'routes/jobs/komplett/phases/figuren.js',
    'routes/jobs/komplett/phases/orte.js',
  ];
  for (const rel of files) {
    const src = readFileSync(new URL(rel, root), 'utf8');
    for (const m of src.matchAll(/progress:\s*([^,}\n]+)/g)) {
      for (const n of m[1].match(/\b\d+\b/g) || []) {
        assert.ok(!ends.has(Number(n)), `${rel}: Phasengrenze ${n} als Literal («progress: ${m[1].trim()}») — PHASE_END benutzen`);
      }
    }
  }
});
