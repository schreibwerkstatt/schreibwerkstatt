'use strict';
// Wortschatz-Analyse, DB-Seite (db/lexicon.js): Referenz-Schranke pro Buch,
// Versionsfilter von Referenz und Vergleichs-Medianen, Tagesverlauf, Full-Replace
// inklusive Kapitel-Band und Figuren-Idiolekt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('lexicon-db');

const { db } = require('../../db/connection');
require('../../db/migrations');
const appUsers = require('../../db/app-users');
const lexiconDb = require('../../db/lexicon');

const AUTOR = 'autor@lexicon.test';
const FREMD = 'fremd@lexicon.test';
appUsers.createUser({ email: AUTOR, displayName: 'Autor' });
appUsers.createUser({ email: FREMD, displayName: 'Fremd' });

function seedBook(bookId, owner) {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?,?,?,?,?)')
    .run(bookId, `Buch ${bookId}`, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', owner);
}
function seedLexicon(bookId, { freq, tokens = 10000, version = 3, sig = `s${bookId}`, mtld = 80 }) {
  lexiconDb.replaceBookLexicon(bookId, {
    stats: {
      version, content_sig: sig, tokens, types: 1, mtld, mattr: 0.7, mattr_window: 1000,
      lex_density: 0.55, hapax_ratio: 0.5, freq_json: JSON.stringify(freq),
    },
    terms: [], phrases: [],
  });
}

seedBook(1, AUTOR);
seedBook(2, AUTOR);
seedBook(3, AUTOR);
seedBook(4, AUTOR);
seedBook(9, FREMD);

test('loadReferenceCorpus: Schranke summiert pro Buch, in dem der Term fehlt', () => {
  // Drei Referenzbücher, Kappung bei 3: „sonderling" fehlt in allen dreien.
  seedLexicon(2, { freq: { haus: 10, baum: 3 } });
  seedLexicon(3, { freq: { haus: 7, baum: 4 } });
  seedLexicon(4, { freq: { haus: 3, wald: 5 } });
  const ref = lexiconDb.loadReferenceCorpus(1, 3);
  assert.equal(ref.books, 3);
  assert.equal(ref.total, 30000);
  // Fehlt überall: je Buch bis zu dessen Kappung (3 + 4 + 3), nicht max = 4.
  assert.equal(ref.upper('sonderling'), 10);
  // Vorhanden in 2 und 3 (3 + 4 = 7), fehlt in 4 (bis zu 3).
  assert.equal(ref.upper('baum'), 7 + 3);
  // Überall vorhanden: die Zählung selbst.
  assert.equal(ref.upper('haus'), 20);
});

test('loadReferenceCorpus: fremde Bücher und alte Analyse-Versionen zählen nicht', () => {
  seedLexicon(9, { freq: { haus: 1000 } });
  seedLexicon(4, { freq: { haus: 999 }, version: 2 });
  const ref = lexiconDb.loadReferenceCorpus(1, 3);
  assert.equal(ref.books, 2, 'Buch 4 hat eine alte Version, Buch 9 einen anderen Besitzer');
  assert.equal(ref.freq.get('haus'), 17);
  assert.equal(lexiconDb.referenceFingerprint(1, 3), '2:s2,3:s3');
  const peers = lexiconDb.loadPeerStats(1, 3);
  assert.equal(peers.books, 2);
});

test('loadReferenceCorpus: unlesbare Tabelle bläht den Nenner nicht auf', () => {
  db.prepare("UPDATE book_lexicon SET freq_json = '{kaputt' WHERE book_id = 3").run();
  const ref = lexiconDb.loadReferenceCorpus(1, 3);
  assert.equal(ref.books, 1);
  assert.equal(ref.total, 10000);
  seedLexicon(3, { freq: { haus: 7, baum: 4 } });
});

test('stampLexiconHistory: Tageszeile bekommt die Kennzahlen, MATTR nur mit vollem Fenster', () => {
  db.prepare('INSERT INTO book_stats_history (book_id, recorded_at, words) VALUES (?,?,?)').run(2, '2026-10-04', 100);
  assert.equal(lexiconDb.stampLexiconHistory(2, '2026-10-04', 1000), 1);
  let row = db.prepare('SELECT mattr, mtld, lex_density, hapax_ratio FROM book_stats_history WHERE book_id = 2').get();
  assert.deepEqual(row, { mattr: 0.7, mtld: 80, lex_density: 0.55, hapax_ratio: 0.5 });

  db.prepare('UPDATE book_lexicon SET mattr_window = 400 WHERE book_id = 2').run();
  lexiconDb.stampLexiconHistory(2, '2026-10-04', 1000);
  row = db.prepare('SELECT mattr FROM book_stats_history WHERE book_id = 2').get();
  assert.equal(row.mattr, null, 'einfache TTR gehört nicht in den Verlauf');

  // Ohne Tageszeile: nichts — die Zeile gehört dem Sync.
  assert.equal(lexiconDb.stampLexiconHistory(2, '2026-10-05', 1000), 0);
});

test('replaceBookLexicon: Kapitel-Band und Idiolekt, gelöschte Ziele fallen weg', () => {
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name) VALUES (?,?,?)').run(51, 1, 'Zwei');
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name) VALUES (?,?,?)').run(50, 1, 'Eins');
  const fig = db.prepare(`INSERT INTO figures (book_id, fig_id, name, updated_at, user_email)
                          VALUES (1, 'f1', 'Anna', '2026-01-01T00:00:00Z', ?)`).run(AUTOR).lastInsertRowid;
  const row = { tokens: 10, types: 5, utterances: 2, terms: [{ term: 'gewiss', count: 4, keyness: 9.1 }] };
  lexiconDb.replaceBookLexicon(1, {
    stats: { version: 3, tokens: 100, idiolect_coverage: 0.4 },
    terms: [], phrases: [],
    chapters: [
      { chapter_id: 51, tokens: 60, types: 30, delta: 1.2, delta_top: [{ term: 'und', z: -1.5 }] },
      { chapter_id: 999, tokens: 5, types: 5 }, // gibt es nicht (mehr)
      { chapter_id: 50, tokens: 40, types: 20, delta: null, delta_top: null },
    ],
    idiolect: [{ figure_id: fig, ...row }, { figure_id: 123456, ...row }],
  });
  const ch = lexiconDb.listChapterLexicon(1);
  assert.deepEqual(ch.map(c => c.chapter_name), ['Zwei', 'Eins'], 'Reihenfolge des Scans, nicht der IDs');
  assert.deepEqual(ch[0].delta_top, [{ term: 'und', z: -1.5 }]);
  assert.equal(ch[1].delta_top, null);

  // Betrachter ohne eigene Figuren sieht die des Besitzers.
  const idi = lexiconDb.listFigureIdiolect(1, 'lektor@lexicon.test', AUTOR);
  assert.equal(idi.length, 1);
  assert.equal(idi[0].name, 'Anna');
  assert.deepEqual(idi[0].terms, row.terms);
  assert.equal(lexiconDb.getBookLexicon(1).idiolect_coverage, 0.4);

  // Erneuter Scan ersetzt alles.
  lexiconDb.replaceBookLexicon(1, { stats: { version: 3 }, terms: [], phrases: [] });
  assert.deepEqual(lexiconDb.listChapterLexicon(1), []);
  assert.deepEqual(lexiconDb.listFigureIdiolect(1, AUTOR, AUTOR), []);
});

test('listLexiconHapax: Reihenfolge der Auswahl (sort_rank), nicht der Länge', () => {
  lexiconDb.replaceBookLexicon(1, {
    stats: { version: 3 },
    terms: [
      { term: 'kurz', kind: 'hapax', count: 1, novel: 1, sort_rank: 1 },
      { term: 'sehrlangeswort', kind: 'hapax', count: 1, novel: 0, sort_rank: 2 },
    ],
    phrases: [],
  });
  const rows = lexiconDb.listLexiconHapax(1);
  assert.deepEqual(rows.map(r => [r.term, r.novel]), [['kurz', 1], ['sehrlangeswort', 0]]);
});
