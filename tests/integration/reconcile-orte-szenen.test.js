'use strict';
// Reconcile-Netz fuer Orte (saveOrteToDb matchBy:'name') und Szenen
// (saveSzenenAndEvents): locations.id / figure_scenes.id bleiben ueber Re-Analysen
// stabil, verschwundene Eintraege werden als stale=1 markiert statt geloescht — damit
// FK-Refs (hier: research_item_links.location_id/scene_id) NICHT per CASCADE wegbrechen.
// Spiegelt das figures.stale-Netz. Reine DB-Logik (kein AI-Mock noetig).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { bootstrap } = require('./_helpers/setup');

const BOOK = 9200;
const EMAIL = 'test@example.com';
let ctx, db, dbSchema, saveSzenenAndEvents;

before(() => {
  ctx = bootstrap();
  db = require('../../db/connection').db;
  dbSchema = ctx.dbSchema;
  ({ saveSzenenAndEvents } = require('../../routes/jobs/komplett/remap'));
  ctx.dbSeed.setBook({ books: [{ id: BOOK, name: 'Reconcile-Test' }] });
});
after(() => ctx.cleanup());

const log = { info() {}, warn() {} };

// Legt einen Recherche-Eintrag + Link auf ein Ziel an. Gibt die link-id zurueck.
function linkResearch(targetKind, idCol, targetId) {
  const { lastInsertRowid: itemId } = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title) VALUES (?, ?, 'note', 'ref')`
  ).run(BOOK, EMAIL);
  const { lastInsertRowid: linkId } = db.prepare(
    `INSERT INTO research_item_links (item_id, target_kind, ${idCol}) VALUES (?, ?, ?)`
  ).run(itemId, targetKind, targetId);
  return linkId;
}
const linkExists = (linkId) =>
  !!db.prepare('SELECT 1 FROM research_item_links WHERE id = ?').get(linkId);

// ── Orte ────────────────────────────────────────────────────────────────────

test('Ort: Re-Analyse mit neuer loc_id behaelt die DB-id und den Recherche-Link', () => {
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK);
  const opts = { matchBy: 'name', onMissing: 'stale' };

  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const id1 = db.prepare('SELECT id FROM locations WHERE book_id = ? AND loc_id = ?').get(BOOK, 'ort_1').id;
  const linkId = linkResearch('location', 'location_id', id1);

  // AI regeneriert die loc_id (ort_1 → ort_3), gleicher Name → Match per Name.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_3', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const row = db.prepare('SELECT id, loc_id, stale FROM locations WHERE book_id = ?').get(BOOK);
  assert.equal(row.id, id1, 'DB-id muss stabil bleiben');
  assert.equal(row.loc_id, 'ort_3', 'loc_id wird auf den frischen Lauf-Wert gebogen');
  assert.equal(row.stale, 0);
  assert.ok(linkExists(linkId), 'Recherche-Link ueberlebt die Re-Analyse');
});

test('Ort: verschwundener Ort wird stale=1 (nicht geloescht), Link bleibt; Wiederauftauchen revived', () => {
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK);
  const opts = { matchBy: 'name', onMissing: 'stale' };

  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const id1 = db.prepare('SELECT id FROM locations WHERE book_id = ?').get(BOOK).id;
  const linkId = linkResearch('location', 'location_id', id1);

  // Naechster Lauf findet den Ort nicht mehr → stale, nicht geloescht.
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Ganz anderer Ort' }], EMAIL, {}, {}, opts);
  const stale = db.prepare('SELECT id, loc_id, stale FROM locations WHERE id = ?').get(id1);
  assert.ok(stale, 'Ort darf NICHT geloescht werden');
  assert.equal(stale.stale, 1);
  assert.match(stale.loc_id, /^orphan_/, 'loc_id raeumt den ort_N-Namespace');
  assert.ok(linkExists(linkId), 'Link bleibt trotz stale erhalten');

  // Wiederauftauchen → revived (gleiche id, stale=0).
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_9', name: 'Burg Falkenstein' }], EMAIL, {}, {}, opts);
  const revived = db.prepare('SELECT id, stale FROM locations WHERE id = ?').get(id1);
  assert.equal(revived.stale, 0, 'wiederaufgetauchter Ort wird revived');
});

// ── Szenen ────────────────────────────────────────────────────────────────────

test('Szene: Re-Analyse behaelt die DB-id (Match per Kapitel+Titel) und den Recherche-Link', () => {
  db.prepare('DELETE FROM figure_scenes WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM chapters WHERE book_id = ?').run(BOOK);
  const { lastInsertRowid: chapId } = db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(BOOK, 'Kapitel Eins');
  const idMaps = { chNameToId: { 'Kapitel Eins': chapId }, pageNameToIdByChapter: {} };
  const mkScene = (titel, wertung) => ([{
    kapitel: 'Kapitel Eins', seite: null, titel, wertung, kommentar: null,
    fig_ids: [], ort_ids: [], sort_order: 0,
  }]);

  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Der Sturm', 'gut'), [], {}, idMaps, log, null);
  const id1 = db.prepare('SELECT id FROM figure_scenes WHERE book_id = ?').get(BOOK).id;
  const linkId = linkResearch('scene', 'scene_id', id1);

  // Gleicher Titel + Kapitel, geaenderte Wertung → Match, UPDATE in-place.
  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Der Sturm', 'mittel'), [], {}, idMaps, log, null);
  const row = db.prepare('SELECT id, wertung, stale FROM figure_scenes WHERE book_id = ?').get(BOOK);
  assert.equal(row.id, id1, 'Szenen-id muss stabil bleiben');
  assert.equal(row.wertung, 'mittel', 'Felder werden in-place aktualisiert');
  assert.equal(row.stale, 0);
  assert.ok(linkExists(linkId), 'Recherche-Link ueberlebt die Re-Analyse');

  // Szene verschwindet → stale=1, nicht geloescht, Link bleibt.
  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Eine voellig andere Szene', null), [], {}, idMaps, log, null);
  const stale = db.prepare('SELECT stale FROM figure_scenes WHERE id = ?').get(id1);
  assert.ok(stale, 'Szene darf NICHT geloescht werden');
  assert.equal(stale.stale, 1);
  assert.ok(linkExists(linkId), 'Link bleibt trotz stale erhalten');

  // Wiederauftauchen → revived.
  saveSzenenAndEvents(BOOK, EMAIL, mkScene('Der Sturm', 'gut'), [], {}, idMaps, log, null);
  const revived = db.prepare('SELECT stale FROM figure_scenes WHERE id = ?').get(id1);
  assert.equal(revived.stale, 0, 'wiederaufgetauchte Szene wird revived');
});

// ── Robustheit des Schreibpfads ─────────────────────────────────────────────

test('Ort: doppeltes Kapitel im kapitel-Array bricht die Transaktion nicht (hoehere Haeufigkeit gewinnt)', () => {
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM chapters WHERE book_id = ?').run(BOOK);
  const { lastInsertRowid: chapId } = db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(BOOK, 'Kapitel Eins');
  const orte = [{ id: 'ort_1', name: 'Burg Falkenstein',
    kapitel: ['Kapitel Eins', { name: 'Kapitel Eins', haeufigkeit: 3 }] }];
  assert.doesNotThrow(() => dbSchema.saveOrteToDb(BOOK, orte, EMAIL, { 'Kapitel Eins': chapId }, {},
    { matchBy: 'name', onMissing: 'stale' }));
  const rows = db.prepare(`SELECT lc.haeufigkeit FROM location_chapters lc
    JOIN locations l ON l.id = lc.location_id WHERE l.book_id = ?`).all(BOOK);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].haeufigkeit, 3);
});

test('Szene: Within-Run-Dedup behaelt die Ort-Links der aufgegangenen Szene', () => {
  db.prepare('DELETE FROM figure_scenes WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM chapters WHERE book_id = ?').run(BOOK);
  const { lastInsertRowid: chapId } = db.prepare(
    `INSERT INTO chapters (book_id, chapter_name, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(BOOK, 'Kapitel Eins');
  dbSchema.saveOrteToDb(BOOK, [{ id: 'ort_1', name: 'Bahnhof Olten' }, { id: 'ort_2', name: 'Buffet' }],
    EMAIL, {}, {}, { matchBy: 'name', onMissing: 'stale' });
  const locIdToDbId = Object.fromEntries(db.prepare('SELECT loc_id, id FROM locations WHERE book_id = ?')
    .all(BOOK).map(r => [r.loc_id, r.id]));
  const idMaps = { chNameToId: { 'Kapitel Eins': chapId }, pageNameToIdByChapter: {} };
  const szenen = [
    { kapitel: 'Kapitel Eins', seite: null, titel: 'Ankunft', wertung: null, kommentar: null,
      fig_ids: [], ort_ids: ['ort_1'], sort_order: 0 },
    { kapitel: 'Kapitel Eins', seite: null, titel: 'Ankunft', wertung: null, kommentar: 'zweiter Pass',
      fig_ids: [], ort_ids: ['ort_2'], sort_order: 1 },
  ];
  saveSzenenAndEvents(BOOK, EMAIL, szenen, [], locIdToDbId, idMaps, log, null);
  const scenes = db.prepare('SELECT id FROM figure_scenes WHERE book_id = ?').all(BOOK);
  assert.equal(scenes.length, 1, 'gleicher Titel im selben Kapitel ⇒ eine Szene');
  const locs = db.prepare('SELECT location_id FROM scene_locations WHERE scene_id = ?').all(scenes[0].id)
    .map(r => r.location_id).sort();
  assert.deepEqual(locs, [locIdToDbId.ort_1, locIdToDbId.ort_2].sort());
});

test('Kontinuitaet: Befunde des Attribut-Detektors (_source attr) sind von der Zitat-Belegpruefung ausgenommen', () => {
  const { saveKontinuitaetResult } = require('../../routes/jobs/komplett/remap');
  const pageContents = [{ id: 1, title: 'S1', chapter: 'Kapitel Eins', chapter_id: null,
    text: 'Anna wurde im Jahr 1952 geboren und zog nach Olten.' }];
  const probleme = [
    { schwere: 'mittel', typ: 'zeitlinie', beschreibung: 'Geburtsjahr widerspricht sich.',
      stelle_a: 'Geburtsjahr: «1952 laut Dossier» (Kapitel 1)', stelle_b: 'Geburtsjahr: «1955 laut Akte» (Kapitel 3)',
      empfehlung: 'Angleichen.', figuren: [], kapitel: [], _source: 'attr' },
    { schwere: 'mittel', typ: 'zeitlinie', beschreibung: 'Erfundenes Zitat.',
      stelle_a: '«Anna war nie in Olten gewesen»', stelle_b: '«Sie blieb in Bern»',
      empfehlung: 'Pruefen.', figuren: [], kapitel: [] },
  ];
  const out = saveKontinuitaetResult(BOOK, EMAIL, { zusammenfassung: 'x', probleme }, {}, {}, 'claude', log,
    { pageContents, requireQuoteEvidence: true });
  assert.equal(out.length, 1, 'erfundenes Buchzitat faellt, Attribut-Befund bleibt');
  assert.equal(out[0].beschreibung, 'Geburtsjahr widerspricht sich.');
});
