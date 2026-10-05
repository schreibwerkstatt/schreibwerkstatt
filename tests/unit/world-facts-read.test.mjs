// Unit: Lesepfad der Welt-Fakten — Kategorien-Filter, Kapitel-JOIN und die
// Unterscheidung „nie analysiert" vs. „analysiert, nichts gefunden".
//
// Letztere ist die eigentliche Invariante: ein leerer Index darf NICHT als
// „dieses Buch hat keine Welt" gelesen werden. Ohne sie meldet die Plot-Pruefung
// „verletzt keine Weltregel", die Bewertung liest 0 Fakten als weltarm und die
// Karte fordert eine Komplettanalyse, die langst gelaufen ist.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('wf-read');
const schema = require('../../db/schema');
const db = schema.db;

const BOOK = 710;
const USER = 'wfread@test.dev';

function setup() {
  // job_runs.user_email ist FK auf app_users(email) — der Testuser muss existieren.
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
  schema.upsertBookByName(BOOK, 'Welt-Buch');
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)')
    .run(7101, BOOK, 'Kapitel 1', 1);
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)')
    .run(7102, BOOK, 'Kapitel 2', 2);
  db.prepare('DELETE FROM job_runs WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM world_facts WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM world_facts_scan WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM world_fact_verdicts WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM continuity_checks WHERE book_id = ?').run(BOOK);
}

test('worldFactsScanState: leer + nie geschrieben → nicht gescannt', () => {
  setup();
  assert.deepEqual(schema.worldFactsScanState(BOOK, USER), { scanned: false, count: 0 });
});

test('worldFactsScanState: Lauf ohne Fund (leeres Speichern) → gescannt', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [], USER, {});
  assert.deepEqual(schema.worldFactsScanState(BOOK, USER), { scanned: true, count: 0 });
});

test('worldFactsScanState: Marker hängt nicht an job_runs (30-Tage-Prune)', () => {
  setup();
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at)
              VALUES (?, 'komplett-analyse', ?, ?, 'done', '2026-01-01T00:00:00.000Z')`)
    .run(`jr-done-${Date.now()}`, BOOK, USER);
  // Ein Job-Eintrag allein ist kein Scan — der Marker kommt vom Schreibpfad.
  assert.equal(schema.worldFactsScanState(BOOK, USER).scanned, false);
  schema.saveFaktenToDb(BOOK, [], USER, {});
  db.prepare('DELETE FROM job_runs WHERE book_id = ?').run(BOOK);
  assert.equal(schema.worldFactsScanState(BOOK, USER).scanned, true);
});

test('worldFactsScanState: vorhandene Fakten reichen (importiertes Buch ohne Job-Lauf)', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'regel', subjekt: 'Magie', fakt: 'Tote kehren nie zurueck.' },
  ] }], USER, { 'Kapitel 1': 7101 });
  assert.deepEqual(schema.worldFactsScanState(BOOK, USER), { scanned: true, count: 1 });
});

test('listWorldFacts: Kapitelnamen per JOIN, eine Zeile je Fakt', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [
    { kapitel: 'Kapitel 1', fakten: [{ kategorie: 'regel', subjekt: 'Magie', fakt: 'Zauber kostet Lebenszeit.', seite: 'S3' }] },
    { kapitel: 'Kapitel 2', fakten: [{ kategorie: 'kultur', fakt: 'Man grüsst mit der linken Hand.' }] },
  ], USER, { 'Kapitel 1': 7101, 'Kapitel 2': 7102 });

  const rows = schema.listWorldFacts(BOOK, USER);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].kapitel, ['Kapitel 1']);
  assert.equal(rows[0].subjekt, 'Magie');
  assert.equal(rows[0].seite, 'S3');
  assert.deepEqual(rows[1].kapitel, ['Kapitel 2']);
  assert.equal(rows[1].subjekt, null);
});

test('listWorldFacts: kategorien filtert; leere Liste heisst „nichts davon", nicht „alles"', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'regel', fakt: 'Weltgesetz A.' },
    { kategorie: 'technik', fakt: 'Weltgesetz B.' },
    { kategorie: 'kultur', fakt: 'Beiwerk C.' },
  ] }], USER, { 'Kapitel 1': 7101 });

  const gesetze = schema.listWorldFacts(BOOK, USER, { kategorien: ['regel', 'technik'] });
  assert.deepEqual(gesetze.map(f => f.fakt), ['Weltgesetz A.', 'Weltgesetz B.']);
  assert.deepEqual(schema.listWorldFacts(BOOK, USER, { kategorien: [] }), []);
  // Unbekannte Kategorie wird verworfen → wie leere Liste, nicht wie „ohne Filter".
  assert.deepEqual(schema.listWorldFacts(BOOK, USER, { kategorien: ['gibtsnicht'] }), []);
  assert.equal(schema.listWorldFacts(BOOK, USER).length, 3);
});

test('saveFaktenToDb: dieselbe Aussage aus zwei Kapiteln wird EINE Zeile mit zwei Kapiteln', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [
    { kapitel: 'Kapitel 1', fakten: [{ kategorie: 'regel', subjekt: 'Magie', fakt: 'Zauber kostet Lebenszeit.' }] },
    { kapitel: 'Kapitel 2', fakten: [{ kategorie: 'regel', subjekt: 'magie', fakt: '  Zauber kostet  Lebenszeit ' }] },
  ], USER, { 'Kapitel 1': 7101, 'Kapitel 2': 7102 });
  const rows = schema.listWorldFacts(BOOK, USER);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].kapitel, ['Kapitel 1', 'Kapitel 2']);
});

test('saveFaktenToDb: keepChapterIds behält die Fakten ausgefallener Kapitel', () => {
  setup();
  const map = { 'Kapitel 1': 7101, 'Kapitel 2': 7102 };
  schema.saveFaktenToDb(BOOK, [
    { kapitel: 'Kapitel 1', fakten: [{ kategorie: 'ort', fakt: 'Alt aus K1.' }] },
    { kapitel: 'Kapitel 2', fakten: [{ kategorie: 'ort', fakt: 'Alt aus K2.' }] },
  ], USER, map);
  // Zweiter Lauf: Kapitel 2 fiel aus (leer), Kapitel 1 hat Neues.
  schema.saveFaktenToDb(BOOK, [
    { kapitel: 'Kapitel 1', fakten: [{ kategorie: 'ort', fakt: 'Neu aus K1.' }] },
    { kapitel: 'Kapitel 2', fakten: [] },
  ], USER, map, { keepChapterIds: new Set([7102]) });
  assert.deepEqual(schema.listWorldFacts(BOOK, USER).map(f => f.fakt).sort(), ['Alt aus K2.', 'Neu aus K1.']);
});

test('listWorldFacts: subjekt-Filter faltet auch Umlaute', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'ort', subjekt: 'Ölmühle', fakt: 'Steht am Bach.' },
    { kategorie: 'ort', subjekt: 'Kirche', fakt: 'Steht am Platz.' },
  ] }], USER, { 'Kapitel 1': 7101 });
  assert.deepEqual(schema.listWorldFacts(BOOK, USER, { subjekt: 'ölm' }).map(f => f.subjekt), ['Ölmühle']);
  assert.deepEqual(schema.listWorldFacts(BOOK, USER, { subjekt: 'ÖLM' }).map(f => f.subjekt), ['Ölmühle']);
});

test('refutedFactKeys: «falsch» mit Quelle zählt, «kein Fehler» des Autors hebt auf', () => {
  setup();
  schema.saveFaktenToDb(BOOK, [{ kapitel: 'Kapitel 1', fakten: [
    { kategorie: 'historie', subjekt: 'Mauerfall', fakt: 'Die Mauer fiel 1988.' },
  ] }], USER, { 'Kapitel 1': 7101 });
  const key = schema.worldFactKey('Mauerfall', 'Die Mauer fiel 1988.');
  schema.saveFactVerdicts(BOOK, USER, [{ key, urteil: 'falsch', quelle: 'https://example.org/mauer' }]);
  assert.equal(schema.listWorldFacts(BOOK, USER, { withRefuted: true })[0].widerlegt, true);

  // Autor markiert den Befund als „kein Fehler" → nicht mehr widerlegt.
  schema.saveFaktencheckIssues(BOOK, USER, 'm', [{
    schwere: 'mittel', typ: 'faktenfehler', beschreibung: 'x', stelle_a: 'Mauerfall: Die Mauer fiel 1988.',
    stelle_b: '', empfehlung: '', quelle: 'https://example.org/mauer', figuren: [], kapitel: [],
  }], {}, {});
  db.prepare("UPDATE continuity_issues SET dismissed = 1 WHERE book_id = ? AND typ = 'faktenfehler'").run(BOOK);
  assert.equal(schema.refutedFactKeys(BOOK, USER).size, 0);
});

test('refutedFactKeys: «falsch» ohne http(s)-Quelle zählt nicht', () => {
  setup();
  schema.saveFactVerdicts(BOOK, USER, [{ key: 'x: y', urteil: 'falsch', quelle: 'Wikipedia' }]);
  assert.equal(schema.refutedFactKeys(BOOK, USER).size, 0);
});
