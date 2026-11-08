// Motiv-Werkstatt: DB-Layer (Themen/Motive-CRUD, Beziehungen, Soll-Brücken,
// Ist-Index + Graph-Payload) gegen eine Wegwerf-DB. Eigene DB pro Lauf (DB_PATH
// gesetzt, bevor db/* geladen wird), damit der Statement-Cache nicht mit
// parallelen Suites kollidiert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('motifs-db');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const motifs = require('../../db/motifs');
const plot = require('../../db/plot');
const { db } = require('../../db/connection');

const USER = 'motiv@x.test';
const BOOK = 880001;

function seedFigur(bookId, userEmail, figId, name) {
  return db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(bookId, userEmail, figId, name, name).lastInsertRowid;
}
function seedChapter(bookId, name) {
  return db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(bookId, name).lastInsertRowid;
}
function seedPage(bookId, chapterId, name) {
  return db.prepare(
    `INSERT INTO pages (book_id, chapter_id, page_name, body_html, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(bookId, chapterId, name, '<p>x</p>').lastInsertRowid;
}

test('setup', () => {
  appUsers.createUser({ email: USER, displayName: 'Motiv Tester' });
  schema.upsertBookByName(BOOK, 'Motiv-Testbuch');
});

test('Themen-CRUD + Positionsvergabe', () => {
  const t1 = motifs.createTheme(BOOK, USER, { name: 'Schuld & Vergebung' });
  const t2 = motifs.createTheme(BOOK, USER, { name: 'Preis der Freiheit', beschreibung: 'Kernthema' });
  assert.equal(t1.position, 0);
  assert.equal(t2.position, 1);
  assert.deepEqual(motifs.listThemes(BOOK, USER).map(t => t.name), ['Schuld & Vergebung', 'Preis der Freiheit']);

  const upd = motifs.updateTheme(t1.id, { name: 'Schuld', beschreibung: 'x', farbe: '#abc' });
  assert.equal(upd.name, 'Schuld');
  assert.equal(upd.farbe, '#abc');

  motifs.reorderThemes(BOOK, USER, [t2.id, t1.id]);
  assert.deepEqual(motifs.listThemes(BOOK, USER).map(t => t.id), [t2.id, t1.id]);
});

test('Motiv-CRUD + trigger_terms als Array + theme SET NULL beim Löschen', () => {
  const theme = motifs.createTheme(BOOK, USER, { name: 'Wasser-Thema' });
  const m = motifs.createMotif(BOOK, USER, {
    themeId: theme.id, name: 'Wasser', beschreibung: 'Ertrinken, Reinigung',
    triggerTerms: ['Regen', 'Fluss', '', '  ertrinken '],
  });
  assert.equal(m.theme_id, theme.id);
  // trigger_terms wird als getrimmtes Array ohne Leerstrings hydriert.
  assert.deepEqual(m.trigger_terms, ['Regen', 'Fluss', 'ertrinken']);

  const got = motifs.getMotif(m.id);
  assert.deepEqual(got.trigger_terms, ['Regen', 'Fluss', 'ertrinken']);

  const upd = motifs.updateMotif(m.id, { themeId: theme.id, name: 'Wasser/Meer', triggerTerms: ['See'] });
  assert.equal(upd.name, 'Wasser/Meer');
  assert.deepEqual(upd.trigger_terms, ['See']);

  // Thema löschen → theme_id des Motivs wird NULL (SET NULL), Motiv bleibt.
  motifs.deleteTheme(theme.id);
  assert.equal(motifs.getMotif(m.id).theme_id, null);
});

test('Motiv-Beziehungen: create ist idempotent (UNIQUE), delete', () => {
  const a = motifs.createMotif(BOOK, USER, { name: 'Spiegel' });
  const b = motifs.createMotif(BOOK, USER, { name: 'Identität' });
  const id1 = motifs.createRelation(a.id, b.id, 'spiegelt');
  const id2 = motifs.createRelation(a.id, b.id, 'spiegelt'); // Duplikat → IGNORE
  assert.ok(id1);
  assert.equal(id2, null);
  const rels = motifs.listRelations(BOOK, USER).filter(r => r.from_motif_id === a.id);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].typ, 'spiegelt');

  motifs.deleteRelation(id1);
  assert.equal(motifs.listRelations(BOOK, USER).filter(r => r.from_motif_id === a.id).length, 0);
});

test('Motiv-Beziehungen: Typ ändern, Kollision mit bestehendem Typ meldet false', () => {
  const a = motifs.createMotif(BOOK, USER, { name: 'Brücke' });
  const b = motifs.createMotif(BOOK, USER, { name: 'Abgrund' });
  const r1 = motifs.createRelation(a.id, b.id, 'kontrastiert');
  const r2 = motifs.createRelation(a.id, b.id, 'bricht');
  assert.equal(motifs.updateRelationTyp(r1, 'verdraengt'), true);
  const typOf = (id) => motifs.listRelations(BOOK, USER).find(r => r.id === id)?.typ;
  assert.equal(typOf(r1), 'verdraengt');
  // r2 auf den Typ von r1 → UNIQUE(from,to,typ) → unverändert, false
  assert.equal(motifs.updateRelationTyp(r2, 'verdraengt'), false);
  assert.equal(typOf(r2), 'bricht');
});

test('Soll-Brücken + Scoping-Validatoren + Graph-Payload', () => {
  const figId = seedFigur(BOOK, USER, 'F-WATER', 'Nixe');
  const figIntId = db.prepare('SELECT id FROM figures WHERE fig_id = ?').get('F-WATER').id;
  const chId = seedChapter(BOOK, 'Kapitel 1');
  const pgId = seedPage(BOOK, chId, 'Seite 1');
  const act = plot.createAct(BOOK, USER, { name: 'Akt' });
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'Beat', status: 'geplant' });

  const m = motifs.createMotif(BOOK, USER, { name: 'Flut' });

  // Validatoren: fig_id (TEXT) → INTEGER; Fremd-IDs werden verworfen.
  assert.deepEqual(motifs.resolveFigureIds(BOOK, USER, ['F-WATER', 'F-NOPE']), [figIntId]);
  assert.deepEqual(motifs.validBeatIds(BOOK, USER, [beat.id, 999999]), [beat.id]);
  assert.deepEqual(motifs.validChapterIds(BOOK, [chId, 999999]), [chId]);
  assert.deepEqual(motifs.validPageIds(BOOK, [pgId, 999999]), [pgId]);

  motifs.setMotifFigures(m.id, motifs.resolveFigureIds(BOOK, USER, ['F-WATER']));
  motifs.setMotifBeats(m.id, [beat.id]);
  motifs.setMotifChapters(m.id, [chId]);
  motifs.setMotifPages(m.id, [pgId]);

  const graph = motifs.getGraph(BOOK, USER);
  const gm = graph.motifs.find(x => x.id === m.id);
  assert.deepEqual(gm.figures, [{ figId: 'F-WATER', name: 'Nixe' }]); // Graph exponiert fig_id + Name
  assert.deepEqual(gm.beats, [{ id: beat.id, titel: 'Beat' }]);
  assert.deepEqual(gm.chapters, [{ id: chId, name: 'Kapitel 1' }]);
  assert.deepEqual(gm.pages, [{ id: pgId, name: 'Seite 1' }]);
  assert.equal(gm.occurrenceCount, 0);

  // Full-Replace: setzt man nur noch [], sind die Links weg.
  motifs.setMotifFigures(m.id, []);
  assert.deepEqual(motifs.getGraph(BOOK, USER).motifs.find(x => x.id === m.id).figures, []);
});

test('Ist-Index: replaceOccurrences (Full-Replace) + Count + Detail + CHECK', () => {
  const chId = seedChapter(BOOK, 'Kap Occ');
  const pgId = seedPage(BOOK, chId, 'Occ-Seite');
  const m = motifs.createMotif(BOOK, USER, { name: 'Occ-Motiv' });

  motifs.replaceOccurrences(m.id, BOOK, [
    { kind: 'page', pageId: pgId, score: 0.9, snippet: 'Es regnete.', source: 'semantic' },
    { kind: 'page', pageId: pgId, score: 0.5, snippet: 'Fluss', source: 'trigger' },
  ]);
  assert.equal(motifs.getGraph(BOOK, USER).motifs.find(x => x.id === m.id).occurrenceCount, 2);

  const det = motifs.listOccurrences(m.id);
  assert.equal(det.length, 2);
  assert.equal(det[0].page_name, 'Occ-Seite');
  assert.equal(det[0].chapter_name, 'Kap Occ');
  assert.equal(det[0].source, 'semantic'); // nach score DESC sortiert

  // Full-Replace: neuer Scan mit einer Fundstelle ersetzt die alten.
  motifs.replaceOccurrences(m.id, BOOK, [
    { kind: 'page', pageId: pgId, score: 0.7, snippet: 'nur eine', source: 'semantic' },
  ]);
  assert.equal(motifs.listOccurrences(m.id).length, 1);

  // CHECK-Constraint: page-Fund darf kein scene_id haben (und umgekehrt) — hier
  // prüfen wir, dass ein widersprüchlicher Direkt-Insert scheitert.
  assert.throws(() => {
    db.prepare(`INSERT INTO motif_occurrences (motif_id, book_id, kind, page_id, scene_id, source)
                VALUES (?, ?, 'page', NULL, NULL, 'semantic')`).run(m.id, BOOK);
  }, /CHECK|constraint/i);
});

test('Ist-Index: Score-Floor filtert schwache semantische Treffer, wörtliche bleiben', () => {
  const chId = seedChapter(BOOK, 'Kap Floor');
  const p1 = seedPage(BOOK, chId, 'Floor-A');
  const p2 = seedPage(BOOK, chId, 'Floor-B');
  const p3 = seedPage(BOOK, chId, 'Floor-C');
  const m = motifs.createMotif(BOOK, USER, { name: 'Floor-Motiv' });

  motifs.replaceOccurrences(m.id, BOOK, [
    { kind: 'page', pageId: p1, score: 0.8, snippet: 'stark', source: 'semantic' },
    { kind: 'page', pageId: p2, score: 0.3, snippet: 'schwach', source: 'semantic' },
    { kind: 'page', pageId: p3, score: null, snippet: 'wörtlich', source: 'trigger' },
  ]);

  // Ohne Floor: alle drei.
  assert.equal(motifs.listOccurrences(m.id, 0).length, 3);
  assert.equal(motifs.getGraph(BOOK, USER, 0).motifs.find(x => x.id === m.id).occurrenceCount, 3);

  // Floor 0.5: schwacher semantischer Treffer (0.3) fällt raus, wörtlicher (null) bleibt.
  const filtered = motifs.listOccurrences(m.id, 0.5);
  assert.equal(filtered.length, 2);
  assert.ok(!filtered.some(o => o.score === 0.3));
  assert.ok(filtered.some(o => o.score == null)); // Exakt-Match nie vom Floor betroffen

  // Ist-Dichte im Graph respektiert den Floor identisch (Knotengrösse + Geist-Erkennung).
  assert.equal(motifs.getGraph(BOOK, USER, 0.5).motifs.find(x => x.id === m.id).occurrenceCount, 2);
});

test('deleteMotif kaskadiert Beziehungen/Brücken/Occurrences', () => {
  const a = motifs.createMotif(BOOK, USER, { name: 'Casc-A' });
  const b = motifs.createMotif(BOOK, USER, { name: 'Casc-B' });
  const chId = seedChapter(BOOK, 'Casc-Kap');
  const pgId = seedPage(BOOK, chId, 'Casc-Seite');
  motifs.createRelation(a.id, b.id, 'verstärkt');
  motifs.setMotifPages(a.id, [pgId]);
  motifs.replaceOccurrences(a.id, BOOK, [{ kind: 'page', pageId: pgId, score: 1, snippet: 'x', source: 'semantic' }]);

  motifs.deleteMotif(a.id);
  assert.equal(motifs.getMotif(a.id), null);
  assert.equal(motifs.listRelations(BOOK, USER).filter(r => r.from_motif_id === a.id).length, 0);
  assert.equal(motifs.listOccurrences(a.id).length, 0);
});

test('Brainstorm-Lauf-Historie: insert/list/get/delete + User-Scope', () => {
  const result = { vorschlaege: [
    { typ: 'motiv', name: 'Spiegel', beschreibung: 'Selbstbild', trigger_terms: ['Spiegel'] },
    { typ: 'thema', name: 'Identität', beschreibung: '', trigger_terms: [] },
  ] };
  const id = motifs.insertBrainstormRun({ bookId: BOOK, userEmail: USER, vorschlagCount: 2, result, model: 'test-model' });
  assert.ok(id > 0);

  // Liste kommt ohne result_json (Spaltensparsamkeit), aber mit denormalisiertem Count.
  const list = motifs.listBrainstormRuns(BOOK, USER);
  assert.equal(list.length, 1);
  assert.equal(list[0].vorschlag_count, 2);
  assert.equal(list[0].model, 'test-model');
  assert.equal(list[0].result_json, undefined);
  assert.equal(list[0].result, undefined);

  // Detail liefert die geparsten Vorschläge.
  const detail = motifs.getBrainstormRun(id);
  assert.equal(detail.result.vorschlaege.length, 2);
  assert.equal(detail.result.vorschlaege[0].name, 'Spiegel');
  assert.equal(detail.user_email, USER);

  // Fremd-User darf nicht löschen (user_email-Guard im DELETE).
  assert.equal(motifs.deleteBrainstormRun(id, 'fremd@x.test'), 0);
  assert.equal(motifs.listBrainstormRuns(BOOK, USER).length, 1);

  // Eigener Delete greift.
  assert.equal(motifs.deleteBrainstormRun(id, USER), 1);
  assert.equal(motifs.listBrainstormRuns(BOOK, USER).length, 0);
  assert.equal(motifs.getBrainstormRun(id), null);
});
