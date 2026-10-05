'use strict';
// Unit (Temp-DB): Kontinuitäts-Persistenz und deterministische Kandidaten.
//  - saveContinuityCheck übernimmt „kein Fehler" (nie „erledigt") auf wiedererkannte
//    Befunde eines neuen Laufs und speichert die Seiten-Anker; ein aufgehobenes „kein
//    Fehler" bleibt über Folgeläufe aufgehoben; Befunde ohne auflösbares Kapitel erben.
//  - saveFaktencheckIssues verliert beim Ersetzen der faktenfehler-Zeilen deren Triage nicht.
//  - buildAttributeContradictions: „Auftritt nach dem Tod", keine Hochzeit als
//    Einmal-Ereignis, Welt-Fakten nur bei gleicher Kategorie und ähnlicher Aussage.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('continuity-triage');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const continuity = require('../../db/continuity');
const { buildAttributeContradictions } = require('../../routes/jobs/komplett/job-shared');

const USER = 'triage@example.com';
const NOW = '2026-10-04T10:00:00.000Z';
let seq = 0;

function newBook() {
  const bookId = 8000 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'T');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  return bookId;
}
function addChapter(bookId, name, pos) {
  const id = 91000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, bookId, name, pos, NOW);
  return id;
}
function addPage(bookId, chapterId, name) {
  const id = 61000 + (++seq);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, bookId, chapterId, name, '<p>x</p>', NOW);
  return id;
}
function addFigur(bookId, figId, name) {
  db.prepare('INSERT INTO figures (book_id, fig_id, name, updated_at, user_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, figId, name, NOW, USER);
  return db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ?').get(bookId, figId).id;
}

function issue(stelle_a, stelle_b, extra = {}) {
  return {
    schwere: 'kritisch', typ: 'figur', beschreibung: 'Marek stirbt und lebt wieder.',
    stelle_a, stelle_b, empfehlung: 'Tod abschwächen.', figuren: ['Marek'], kapitel: ['Kap 3', 'Kap 5'], ...extra,
  };
}

test('neuer Lauf übernimmt „kein Fehler", aber nicht „erledigt"', () => {
  const bookId = newBook();
  const c3 = addChapter(bookId, 'Kap 3', 1);
  const c5 = addChapter(bookId, 'Kap 5', 2);
  const pageId = addPage(bookId, c3, 'Angriff');
  const chMap = { 'Kap 3': c3, 'Kap 5': c5 };
  const figMap = { Marek: 'fig_1' };
  addFigur(bookId, 'fig_1', 'Marek');

  const first = continuity.saveContinuityCheck(bookId, USER, 's', 'm', [
    issue('Kap 3: «Marek lag reglos unter den Trümmern»', 'Kap 5: «Marek öffnete die Tür und lachte»', { page_a_id: pageId }),
    issue('Kap 3: «Er trug den blauen Mantel»', 'Kap 5: «Der Mantel war grün»', { typ: 'objekt' }),
  ], figMap, chMap);
  const latest1 = continuity.getLatestContinuityCheck(bookId, USER);
  assert.equal(latest1.issues[0].page_a_id, pageId, 'Seiten-Anker gespeichert');
  assert.equal(first.normalizedIssues[0].dismissed, false);
  continuity.setContinuityIssueDismissed(latest1.issues[0].id, true);
  continuity.setContinuityIssueResolved(latest1.issues[1].id, true);

  continuity.saveContinuityCheck(bookId, USER, 's2', 'm', [
    issue('Kap 3: «Marek lag reglos unter den Trümmern des Hauses»', 'Kap 5: «Marek öffnete lachend die Tür»'),
    issue('Kap 3: «Er trug den blauen Mantel seines Vaters»', 'Kap 5: «Der Mantel war plötzlich grün»', { typ: 'objekt' }),
    issue('Kap 3: «Lena hatte keine Schwester»', 'Kap 5: «Lenas Schwester rief an»', { figuren: ['Lena'] }),
  ], figMap, chMap);
  const latest2 = continuity.getLatestContinuityCheck(bookId, USER);
  assert.notEqual(latest2.id, latest1.id);
  assert.deepEqual(latest2.issues.map(i => [i.dismissed, i.resolved]), [[true, false], [false, false], [false, false]],
    'wiedergefundener „erledigt"-Befund ist nicht behoben → offen');
});

const MAREK_A = 'Kap 3: «Marek lag reglos unter den Trümmern»';
const MAREK_B = 'Kap 5: «Marek öffnete die Tür und lachte»';

test('dismiss → Lauf 2 erbt → aufheben → Lauf 3 bleibt offen', () => {
  const bookId = newBook();
  const chMap = { 'Kap 3': addChapter(bookId, 'Kap 3', 1), 'Kap 5': addChapter(bookId, 'Kap 5', 2) };
  const figMap = { Marek: 'fig_1' };
  addFigur(bookId, 'fig_1', 'Marek');
  const run = () => {
    continuity.saveContinuityCheck(bookId, USER, 's', 'm', [issue(MAREK_A, MAREK_B)], figMap, chMap);
    return continuity.getLatestContinuityCheck(bookId, USER).issues[0];
  };
  continuity.setContinuityIssueDismissed(run().id, true);
  const second = run();
  assert.equal(second.dismissed, true, 'Lauf 2 erbt „kein Fehler"');
  continuity.setContinuityIssueDismissed(second.id, false);
  assert.equal(run().dismissed, false, 'Lauf 3 bleibt offen — die ältere verworfene Kopie zählt nicht');
  assert.equal(run().dismissed, false, 'auch Lauf 4');
});

test('zwei ähnliche neue Befunde erben nicht beide von einem alten', () => {
  const bookId = newBook();
  const chMap = { 'Kap 3': addChapter(bookId, 'Kap 3', 1), 'Kap 5': addChapter(bookId, 'Kap 5', 2) };
  const figMap = { Marek: 'fig_1' };
  addFigur(bookId, 'fig_1', 'Marek');
  continuity.saveContinuityCheck(bookId, USER, 's', 'm', [issue(MAREK_A, MAREK_B)], figMap, chMap);
  continuity.setContinuityIssueDismissed(continuity.getLatestContinuityCheck(bookId, USER).issues[0].id, true);
  const { normalizedIssues } = continuity.saveContinuityCheck(bookId, USER, 's', 'm', [
    issue(MAREK_A, 'Kap 5: «Marek öffnete die Tür und lachte laut über den Witz des Wirts»'),
    issue(MAREK_A, MAREK_B),
  ], figMap, chMap);
  assert.deepEqual(normalizedIssues.map(i => i.dismissed), [false, true], 'nur der beste Überlapp erbt');
});

test('Befund ohne auflösbares Kapitel («Gesamtbuch») erbt „kein Fehler"', () => {
  const bookId = newBook();
  const chMap = { 'Kap 3': addChapter(bookId, 'Kap 3', 1) };
  const figMap = { Marek: 'fig_1' };
  addFigur(bookId, 'fig_1', 'Marek');
  const it = issue(MAREK_A, MAREK_B, { kapitel: ['Gesamtbuch'] });
  continuity.saveContinuityCheck(bookId, USER, 's', 'm', [it], figMap, chMap);
  const first = continuity.getLatestContinuityCheck(bookId, USER).issues[0];
  assert.deepEqual(first.chapter_ids, [], 'kein Kapitel aufgelöst');
  continuity.setContinuityIssueDismissed(first.id, true);
  continuity.saveContinuityCheck(bookId, USER, 's', 'm', [it], figMap, chMap);
  assert.equal(continuity.getLatestContinuityCheck(bookId, USER).issues[0].dismissed, true);
  // gemischt: ein aufgelöstes + ein unaufgelöstes Kapitel
  const mixed = issue(MAREK_A, MAREK_B, { kapitel: ['Kap 3', 'Gesamtbuch'] });
  continuity.saveContinuityCheck(bookId, USER, 's', 'm', [mixed], figMap, chMap);
  continuity.setContinuityIssueDismissed(continuity.getLatestContinuityCheck(bookId, USER).issues[0].id, true);
  continuity.saveContinuityCheck(bookId, USER, 's', 'm', [mixed], figMap, chMap);
  assert.equal(continuity.getLatestContinuityCheck(bookId, USER).issues[0].dismissed, true);
});

test('Faktencheck-Ersetzung behält die Triage ihrer Befunde', () => {
  const bookId = newBook();
  const fakt = { schwere: 'mittel', typ: 'faktenfehler', beschreibung: 'Die Mauer fiel 1989.', stelle_a: 'Berliner Mauer: fiel 1987', stelle_b: '', quelle: 'https://example.org', figuren: [], kapitel: [] };
  continuity.saveFaktencheckIssues(bookId, USER, 'm', [fakt], {}, {});
  const id = continuity.getLatestContinuityCheck(bookId, USER).issues[0].id;
  continuity.setContinuityIssueDismissed(id, true);
  continuity.saveFaktencheckIssues(bookId, USER, 'm', [fakt], {}, {});
  const issues = continuity.getLatestContinuityCheck(bookId, USER).issues;
  assert.equal(issues.length, 1, 'alte faktenfehler-Zeile ersetzt');
  assert.equal(issues[0].dismissed, true);
});

test('buildAttributeContradictions: Auftritt nach dem Tod, keine Hochzeit, nur vergleichbare Welt-Fakten', () => {
  const bookId = newBook();
  const k1 = addChapter(bookId, 'Eins', 1);
  const k2 = addChapter(bookId, 'Zwei', 2);
  const k3 = addChapter(bookId, 'Drei', 3);
  const marek = addFigur(bookId, 'fig_m', 'Marek');
  const lena = addFigur(bookId, 'fig_l', 'Lena');
  const ev = db.prepare(`INSERT INTO figure_events (figure_id, datum, datum_year, ereignis, subtyp, chapter_id, datum_unsicher)
                         VALUES (?, ?, ?, ?, ?, ?, 0)`);
  ev.run(marek, '1944', 1944, 'stirbt im Bombenangriff', 'tod', k2);
  ev.run(lena, '1950', 1950, 'heiratet Paul', 'hochzeit', k1);
  ev.run(lena, '1960', 1960, 'heiratet Karl', 'hochzeit', k3);
  const scene = (titel, chapterId) => {
    const { lastInsertRowid } = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(bookId, USER, titel, chapterId, NOW);
    db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(lastInsertRowid, marek);
  };
  scene('Marek im Keller', k1);
  scene('Marek kehrt heim', k3);
  const fact = (kategorie, subjekt, text, chapterId) => {
    const { lastInsertRowid } = db.prepare('INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, user_email) VALUES (?, ?, ?, ?, ?)')
      .run(bookId, kategorie, subjekt, text, USER);
    db.prepare('INSERT INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)').run(lastInsertRowid, chapterId);
  };
  fact('ort', 'Die Fabrik', 'liegt am südlichen Stadtrand', k1);
  fact('ort', 'Die Fabrik', 'liegt am nördlichen Stadtrand', k3);
  fact('organisation', 'Die Fabrik', 'beschäftigt 200 Arbeiter', k2);

  const cands = buildAttributeContradictions(bookId, USER, { chapterOrder: [k1, k2, k3] });
  const tod = cands.find(c => c.attribut === 'Lebendig/tot');
  assert.ok(tod, 'Tod-Kandidat vorhanden');
  assert.equal(tod.wertB.kapitel, 'Drei', 'nur die Szene NACH dem Tod');
  assert.ok(tod.hinweis);
  assert.equal(cands[0], tod, 'Tod-Kandidat zuerst');
  assert.equal(cands.some(c => /Hochzeit/.test(c.attribut)), false, 'Hochzeit ist wiederholbar');
  const fabrik = cands.filter(c => c.entity === 'Die Fabrik');
  assert.equal(fabrik.length, 1);
  assert.equal(fabrik[0].typ, 'ort');
  assert.match(fabrik[0].wertA.wert + fabrik[0].wertB.wert, /südlichen.*nördlichen|nördlichen.*südlichen/);

  assert.equal(buildAttributeContradictions(bookId, USER).some(c => c.attribut === 'Lebendig/tot'), false,
    'ohne Kapitelreihenfolge kein Tod-Kandidat');
});
