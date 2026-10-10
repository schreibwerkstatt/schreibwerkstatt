'use strict';
// Figuren-Identitaet ueber Merge, Katalog-Pflege und Komplettanalyse:
//   * Merge (db/entity-merge.js): Alias-Uebernahme, inverse Beziehungs-Dubletten,
//     Werkstatt-Konflikt, Listen-Dubletten (Zeitstrahl/Kontinuitaet), ignorierte
//     Redundanz-Paare, Alters-Index/Idiolekt.
//   * Cross-Run-Abgleich: Alias und Kurzname als Namensquelle, ki_geschlecht/
//     ki_geburtstag statt Autorenkorrektur (Migration 321).
//   * Katalog-PUT mit idMaps (erste Erwaehnung + Beleg-IDs bleiben), PATCH.
//   * KI-Kontext nur aktive Figuren (getFiguren), Kollaps-Riegel der Phase 2.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('figuren-identitaet');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const {
  saveFigurenToDb, planFigurenMatch, listFigurenWithDetails, patchFigure, validateFigurePatch,
  listFigureAliasesByFigure,
} = require('../../db/figures');
const { mergeFigures } = require('../../db/entity-merge');
const { scoreFigurePair, SAME, UNSURE } = require('../../lib/entity-match');
const { normName } = require('../../lib/name-normalize');
const { getFiguren } = require('../../routes/jobs/shared/queries');
const { assertFigurenNichtKollabiert } = require('../../routes/jobs/komplett/phases/figuren');

const USER = 'autor@x.ch';
const NOW = new Date().toISOString();
let seq = 0;

function newBook() {
  const bookId = 8100 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  return bookId;
}
function addChapter(bookId, name) {
  const id = 81000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, bookId, name, NOW);
  return id;
}
function addPage(bookId, chapterId, name) {
  const id = 82000 + (++seq);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, bookId, chapterId, name, '<p>x</p>', NOW);
  return id;
}
function addFigur(bookId, figId, name, extra = {}) {
  const cols = { book_id: bookId, fig_id: figId, name, updated_at: NOW, user_email: USER, ...extra };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO figures (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => cols[k]));
  return db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ?').get(bookId, figId).id;
}
const addRel = (b, from, to, typ, origin = 'ki') => db.prepare(
  'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, user_email, origin) VALUES (?, ?, ?, ?, ?, ?)'
).run(b, from, to, typ, USER, origin);
const fkClean = () => db.pragma('foreign_key_check').length === 0;

// ── Merge ─────────────────────────────────────────────────────────────────────

test('Merge: Name + Kurzname + Aliasse der Quelle werden Aliasse des Ziels', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'Hansi', { kurzname: 'Der Kleine' });
  const tgt = addFigur(b, 'fig_2', 'Johann Brunner');
  db.prepare('INSERT INTO figure_aliases (figure_id, book_id, alias) VALUES (?, ?, ?)').run(src, b, 'Hänschen');

  const r = mergeFigures(b, USER, src, tgt);

  assert.deepEqual([...r.aliasesAdded].sort(), ['Der Kleine', 'Hansi', 'Hänschen'].sort());
  assert.deepEqual([...listFigureAliasesByFigure(b, USER).get(tgt)].sort(), ['Der Kleine', 'Hansi', 'Hänschen'].sort());
  assert.ok(fkClean());
});

test('Merge: Alias mit Normalform von Name/Kurzname des Ziels wird nicht doppelt angelegt', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'Herr  Johann Brunner');
  const tgt = addFigur(b, 'fig_2', 'Johann Brunner');
  const r = mergeFigures(b, USER, src, tgt);
  assert.deepEqual(r.aliasesAdded, []);
});

test('Merge: inverses Beziehungspaar (elternteil/kind) wird dedupliziert, Selbstbezug entfernt', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'A');
  const tgt = addFigur(b, 'fig_2', 'B');
  const x = addFigur(b, 'fig_3', 'X');
  addRel(b, x, src, 'elternteil');           // X ist Elternteil von A
  addRel(b, tgt, x, 'kind', 'manual');      // B ist Kind von X — dieselbe Aussage nach dem Merge
  addRel(b, src, tgt, 'freund');            // wird Selbstbezug

  mergeFigures(b, USER, src, tgt);

  const rels = db.prepare('SELECT from_fig_id, to_fig_id, typ, origin FROM figure_relations WHERE book_id = ?').all(b);
  assert.equal(rels.length, 1, 'eine Beziehung X↔B bleibt');
  assert.equal(rels[0].origin, 'manual', 'die vom Autor angelegte gewinnt');
  assert.ok(fkClean());
});

test('Merge: Werkstatt-Figur der Quelle wird gelöst, wenn das Ziel schon eine hat', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'A');
  const tgt = addFigur(b, 'fig_2', 'B');
  const ins = db.prepare('INSERT INTO draft_figures (book_id, user_email, name, mindmap_json, source_figure_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const dSrc = ins.run(b, USER, 'Entwurf A', '{}', src, NOW, NOW).lastInsertRowid;
  const dTgt = ins.run(b, USER, 'Entwurf B', '{}', tgt, NOW, NOW).lastInsertRowid;

  const r = mergeFigures(b, USER, src, tgt);

  assert.equal(db.prepare('SELECT source_figure_id x FROM draft_figures WHERE id = ?').get(dSrc).x, null);
  assert.equal(db.prepare('SELECT source_figure_id x FROM draft_figures WHERE id = ?').get(dTgt).x, tgt);
  assert.deepEqual(r.draftsUnlinked.map(d => d.name), ['Entwurf A']);
});

test('Merge: Zeitstrahl-/Kontinuitäts-Listen mit beiden Figuren behalten die Figur einmal', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'A');
  const tgt = addFigur(b, 'fig_2', 'B');
  const ev = db.prepare('INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis) VALUES (?, ?, ?, ?)')
    .run(b, USER, '1980', 'E').lastInsertRowid;
  const zIns = db.prepare('INSERT INTO zeitstrahl_event_figures (event_id, figure_id, figur_name) VALUES (?, ?, ?)');
  zIns.run(ev, src, 'A'); zIns.run(ev, tgt, 'B');
  const check = db.prepare('INSERT INTO continuity_checks (book_id, user_email, checked_at) VALUES (?, ?, ?)')
    .run(b, USER, NOW).lastInsertRowid;
  const issue = db.prepare('INSERT INTO continuity_issues (check_id, book_id, typ, schwere, beschreibung) VALUES (?, ?, ?, ?, ?)')
    .run(check, b, 'zeitlinie', 'mittel', 'x').lastInsertRowid;
  const cIns = db.prepare('INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name) VALUES (?, ?, ?)');
  cIns.run(issue, src, 'A'); cIns.run(issue, tgt, 'B');

  mergeFigures(b, USER, src, tgt);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM zeitstrahl_event_figures WHERE event_id = ?').get(ev).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM continuity_issue_figures WHERE issue_id = ?').get(issue).n, 1);
});

test('Merge: ignorierte Redundanz-Paare wandern aufs Ziel, das Paar Quelle↔Ziel fällt', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'A');
  const tgt = addFigur(b, 'fig_2', 'B');
  const x = addFigur(b, 'fig_3', 'X');
  const ins = db.prepare(`INSERT INTO redundancy_dismissals (book_id, user_email, kind, figure_a_id, figure_b_id)
    VALUES (?, ?, 'figure', ?, ?)`);
  ins.run(b, USER, Math.min(src, x), Math.max(src, x));
  ins.run(b, USER, Math.min(src, tgt), Math.max(src, tgt));

  mergeFigures(b, USER, src, tgt);

  const rows = db.prepare("SELECT figure_a_id a, figure_b_id b FROM redundancy_dismissals WHERE book_id = ? AND kind = 'figure'").all(b);
  assert.deepEqual(rows, [{ a: Math.min(tgt, x), b: Math.max(tgt, x) }]);
  assert.ok(fkClean());
});

test('Merge: Alters-Index und Idiolekt — Ziel hat Vorrang, sonst übernimmt es die der Quelle', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'A');
  const tgt = addFigur(b, 'fig_2', 'B');
  const other = addFigur(b, 'fig_3', 'C');
  db.prepare('INSERT INTO figure_ages (figure_id, book_id, geburtsjahr) VALUES (?, ?, ?)').run(src, b, 1950);
  db.prepare("INSERT INTO figure_age_belege (figure_id, book_id, art, wert, zitat) VALUES (?, ?, 'geburtsjahr', 1950, 'z')").run(src, b);
  db.prepare('INSERT INTO figure_idiolect (figure_id, book_id, utterances, tokens, types) VALUES (?, ?, 3, 30, 20)').run(src, b);

  mergeFigures(b, USER, src, tgt);
  assert.equal(db.prepare('SELECT geburtsjahr x FROM figure_ages WHERE figure_id = ?').get(tgt).x, 1950);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_age_belege WHERE figure_id = ?').get(tgt).n, 1);
  assert.equal(db.prepare('SELECT utterances x FROM figure_idiolect WHERE figure_id = ?').get(tgt).x, 3);

  // Ziel mit eigener Zeile behält sie.
  db.prepare('INSERT INTO figure_ages (figure_id, book_id, geburtsjahr) VALUES (?, ?, ?)').run(other, b, 1990);
  mergeFigures(b, USER, other, tgt);
  assert.equal(db.prepare('SELECT geburtsjahr x FROM figure_ages WHERE figure_id = ?').get(tgt).x, 1950);
  assert.ok(fkClean());
});

// ── Matching ──────────────────────────────────────────────────────────────────

test('normName: NFC und ß-Faltung', () => {
  assert.equal(normName('Strauß'), normName('STRAUSS'));
  assert.equal(normName('René'), normName('René'));
});

test('scoreFigurePair: Alias trifft wie ein Name, Kurzname zählt als Token', () => {
  assert.equal(scoreFigurePair({ name: 'Johann Brunner', aliases: ['Hansi'] }, { name: 'Hansi' }).verdict, SAME);
  const thin = scoreFigurePair({ name: 'Johann Brunner', kurzname: 'Hans' }, { name: 'Hans' });
  assert.equal(thin.verdict, UNSURE, 'Kurzname allein: Teilmenge mit schwachen Indizien');
  const strong = scoreFigurePair(
    { name: 'Johann Brunner', kurzname: 'Hans', beruf: 'Schmied', geburtstag: '1950' },
    { name: 'Hans', beruf: 'Schmied', geburtstag: '1950' });
  assert.equal(strong.verdict, SAME);
});

test('planFigurenMatch: weggemergte Figur kehrt über ihren Alias auf das Ziel zurück', () => {
  const b = newBook();
  const src = addFigur(b, 'fig_1', 'Der Alte', { ki_name: 'Der Alte' });
  const tgt = addFigur(b, 'fig_2', 'Gustav Weber', { ki_name: 'Gustav Weber' });
  mergeFigures(b, USER, src, tgt);
  const plan = planFigurenMatch(b, [{ id: 'fig_9', name: 'Der Alte' }], USER);
  assert.equal(plan.matchOf.get(0), tgt);
});

test('planFigurenMatch: gepflegte Figur wird gegen den letzten KI-Wert verglichen, nicht gegen die Korrektur', () => {
  const b = newBook();
  // Analyse-Lauf: «Kim Meier», männlich, 1960.
  saveFigurenToDb(b, [{ id: 'fig_1', name: 'Kim Meier', geschlecht: 'männlich', geburtstag: '1960' }], USER, null,
    { reconcile: true, onMissing: 'stale' });
  const fig = db.prepare('SELECT fig_id FROM figures WHERE book_id = ?').get(b);
  // Autor korrigiert Geschlecht und Geburtsjahr.
  patchFigure(b, USER, fig.fig_id, { geschlecht: 'weiblich', geburtstag: '1965' });
  // Nächster Lauf liefert wieder die (falschen) KI-Werte.
  const next = [{ id: 'fig_1', name: 'Kim Meier', geschlecht: 'männlich', geburtstag: '1960' }];
  const plan = planFigurenMatch(b, next, USER);
  assert.ok(plan.matchOf.has(0), 'kein Widerspruch zur eigenen Korrektur → dieselbe Figur');
  saveFigurenToDb(b, next, USER, null, { reconcile: true, onMissing: 'stale' });
  const rows = db.prepare('SELECT geschlecht, geburtstag, stale, ki_geschlecht FROM figures WHERE book_id = ?').all(b);
  assert.equal(rows.length, 1, 'keine Dublette');
  assert.equal(rows[0].geschlecht, 'weiblich', 'Korrektur bleibt');
  assert.equal(rows[0].geburtstag, '1965');
  assert.equal(rows[0].ki_geschlecht, 'männlich');
});

// ── Katalog-Pflege ────────────────────────────────────────────────────────────

test('Katalog-PUT mit idMaps: erste Erwähnung und Beleg-IDs überleben den Round-Trip', () => {
  const b = newBook();
  const ch = addChapter(b, 'Kapitel 1');
  const pg = addPage(b, ch, 'Anfang');
  const idMaps = {
    chNameToId: { 'Kapitel 1': ch }, pageNameToIdByChapter: { [ch]: { Anfang: pg } },
    validPageIds: new Set([pg]), validChapterIds: new Set([ch]),
  };
  saveFigurenToDb(b, [
    { id: 'fig_1', name: 'A', erste_erwaehnung: 'Anfang', kapitel: [{ name: 'Kapitel 1' }],
      beziehungen: [{ figur_id: 'fig_2', typ: 'freund', belege: [{ kapitel: 'Kapitel 1', seite: 'Anfang' }] }] },
    { id: 'fig_2', name: 'B' },
  ], USER, idMaps, { reconcile: true, onMissing: 'stale' });

  const round = listFigurenWithDetails(b, USER).figuren;
  assert.equal(round.find(f => f.id === 'fig_1').erste_erwaehnung_page_id, pg);
  saveFigurenToDb(b, round, USER, idMaps, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });

  const after = listFigurenWithDetails(b, USER).figuren.find(f => f.id === 'fig_1');
  assert.equal(after.erste_erwaehnung_page_id, pg);
  assert.deepEqual(after.beziehungen[0].belege[0], { kapitel: 'Kapitel 1', seite: 'Anfang', chapter_id: ch, page_id: pg });
});

test('Katalog-PUT: fremde page_id im Body wird nicht übernommen', () => {
  const b = newBook();
  const ch = addChapter(b, 'K');
  const pg = addPage(b, ch, 'S');
  const idMaps = { chNameToId: { K: ch }, pageNameToIdByChapter: {}, validPageIds: new Set([pg]), validChapterIds: new Set([ch]) };
  saveFigurenToDb(b, [{ id: 'fig_1', name: 'A', erste_erwaehnung: 'Unbekannt', erste_erwaehnung_page_id: 999999 }],
    USER, idMaps, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });
  assert.equal(db.prepare('SELECT erste_erwaehnung_page_id x FROM figures WHERE book_id = ?').get(b).x, null);
});

test('PATCH: nur übergebene Felder, manually_edited gesetzt, unveränderter Wert markiert nichts', () => {
  const b = newBook();
  addFigur(b, 'fig_1', 'Anna', { beruf: 'Ärztin', geschlecht: 'w', ki_name: 'Anna' });
  assert.deepEqual(patchFigure(b, USER, 'fig_1', { beruf: 'Ärztin' }).changed, []);
  assert.equal(db.prepare('SELECT manually_edited x FROM figures WHERE book_id = ?').get(b).x, 0);

  const r = patchFigure(b, USER, 'fig_1', { beruf: 'Chirurgin', name: 'Anna Berg' });
  assert.deepEqual(r.changed.sort(), ['beruf', 'name']);
  const row = db.prepare('SELECT * FROM figures WHERE book_id = ?').get(b);
  assert.equal(row.manually_edited, 1);
  assert.equal(row.name, 'Anna Berg');
  assert.equal(row.ki_name, 'Anna', 'Analyse-Name bleibt Match-Schlüssel');
  assert.equal(row.ki_geschlecht, 'w', 'ki_geschlecht aus dem bisherigen Stand gesichert');
  assert.equal(patchFigure(b, USER, 'fig_nope', { beruf: 'x' }), null);
});

test('PATCH-Validierung: unbekanntes Feld, leerer Name, Schlüsselform', () => {
  assert.equal(validateFigurePatch({ fields: { foo: 'x' } }).error.error_code, 'INVALID_VALUE');
  assert.equal(validateFigurePatch({ fields: { name: '  ' } }).error.error_code, 'NAME_REQUIRED');
  assert.equal(validateFigurePatch({ fields: { typ: 'Haupt figur' } }).error.error_code, 'INVALID_VALUE');
  assert.deepEqual(validateFigurePatch({ fields: { typ: 'hauptfigur', beruf: ' ' } }).fields, { typ: 'hauptfigur', beruf: null });
});

// ── KI-Kontext + Riegel ───────────────────────────────────────────────────────

test('getFiguren: ausgemusterte Figuren und ihre Beziehungen fehlen im KI-Kontext', () => {
  const b = newBook();
  const a = addFigur(b, 'fig_1', 'Aktiv');
  const s = addFigur(b, 'orphan_x', 'Ausgemustert', { stale: 1 });
  addRel(b, a, s, 'freund');
  const ctx = getFiguren(b, USER);
  assert.deepEqual(ctx.map(f => f.name), ['Aktiv']);
  assert.equal(ctx[0].beziehungen, undefined, 'Beziehung zur ausgemusterten Figur fehlt');
});

test('Kollaps-Riegel: wenige Figuren gegen grossen Katalog werfen, kleiner Katalog nicht', () => {
  assert.throws(() => assertFigurenNichtKollabiert(10, 0), /figurenKollaps/);
  assert.throws(() => assertFigurenNichtKollabiert(10, 2), /figurenKollaps/);
  assert.doesNotThrow(() => assertFigurenNichtKollabiert(10, 3));
  assert.doesNotThrow(() => assertFigurenNichtKollabiert(4, 0), 'unter dem Mindestbestand kein Riegel');
});
