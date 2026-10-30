'use strict';
// routes/jobs/review-context.js: was die Bewertungen als Buchwahrheit sehen.
//  - Kapitelbewertung: Figuren/Beziehungen nur aus den Auftritten im Kapitel —
//    ein Kapitel ohne Auftritte bekommt KEINE Buchfiguren als Ersatz.
//  - Kontinuitätsbefunde und Zeitstrahl werden per Kapitel-ID gescopt, nicht per
//    Name (zwei gleichnamige Kapitel teilen sich sonst ihre Befunde).
//  - Erledigte und als «kein Fehler» verworfene Befunde fallen raus, schwerste zuerst.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('review-context-scope');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { loadChapterReviewKomplettContext, loadReviewKomplettContext } = require('../../routes/jobs/review-context');

const BOOK = 7101;
const USER = 'autor@x.ch';
const now = new Date().toISOString();

function seed() {
  db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'Autor');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, USER);
  // Zwei gleichnamige Kapitel + ein Kapitel ohne Auftritte.
  for (const [cid, name, pos] of [[1, 'Prolog', 0], [2, 'Prolog', 1], [3, 'Neu', 2]]) {
    db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(cid, BOOK, name, pos, now);
  }
  const fig = db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const anna = fig.run(BOOK, 'fig_1', 'Anna', USER, now, 0).lastInsertRowid;
  const bert = fig.run(BOOK, 'fig_2', 'Bert', USER, now, 1).lastInsertRowid;
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(anna, 1, 3);
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(bert, 2, 2);
  db.prepare('INSERT INTO figure_relations (book_id, user_email, from_fig_id, to_fig_id, typ) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, USER, anna, bert, 'freund');

  const check = db.prepare('INSERT INTO continuity_checks (book_id, user_email, checked_at) VALUES (?, ?, ?)')
    .run(BOOK, USER, now).lastInsertRowid;
  const issue = db.prepare(`INSERT INTO continuity_issues
    (check_id, book_id, typ, schwere, beschreibung, resolved, dismissed, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const onCh = db.prepare('INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, 0)');
  for (const [beschreibung, schwere, resolved, dismissed, ch, ord] of [
    ['offen-mittel', 'mittel', 0, 0, 1, 0],
    ['verworfen', 'kritisch', 0, 1, 1, 1],
    ['erledigt', 'kritisch', 1, 0, 1, 2],
    ['offen-kritisch', 'kritisch', 0, 0, 1, 3],
    ['anderes-prolog', 'kritisch', 0, 0, 2, 4],
  ]) {
    const id = issue.run(check, BOOK, 'zeit', schwere, beschreibung, resolved, dismissed, ord).lastInsertRowid;
    onCh.run(id, ch);
  }

  const ev = db.prepare('INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis, sort_order) VALUES (?, ?, ?, ?, ?)');
  const evCh = db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, 0)');
  evCh.run(ev.run(BOOK, USER, '1990', 'im ersten Prolog', 0).lastInsertRowid, 1);
  evCh.run(ev.run(BOOK, USER, '1991', 'im zweiten Prolog', 1).lastInsertRowid, 2);
}
seed();

test('Kapitel ohne Auftritte: keine Buchfiguren als Ersatz', () => {
  const ctx = loadChapterReviewKomplettContext(BOOK, USER, { chapterIds: [3] });
  assert.deepEqual(ctx.figuren, []);
  assert.deepEqual(ctx.beziehungen, []);
});

test('Kapitel + Unterkapitel ohne eigene Auftritte: nur die Figuren der Kapitel mit Auftritt', () => {
  const ctx = loadChapterReviewKomplettContext(BOOK, USER, { chapterIds: [3, 1] });
  assert.deepEqual(ctx.figuren.map(f => f.name), ['Anna']);
});

test('Kontinuität: per ID gescopt, ohne erledigte/verworfene, schwerste zuerst', () => {
  const ctx = loadChapterReviewKomplettContext(BOOK, USER, { chapterIds: [1] });
  assert.deepEqual(ctx.continuityIssues.map(i => i.beschreibung), ['offen-kritisch', 'offen-mittel']);
});

test('Zeitstrahl: gleichnamiges Kapitel bekommt nicht die Ereignisse des anderen', () => {
  const ctx = loadChapterReviewKomplettContext(BOOK, USER, { chapterIds: [2] });
  assert.deepEqual(ctx.zeitstrahl.map(e => e.ereignis), ['im zweiten Prolog']);
  assert.equal(ctx.zeitstrahl[0].kapitel, 'Prolog');
});

test('Buchbewertung: nur offene Befunde, schwerste zuerst', () => {
  const ctx = loadReviewKomplettContext(BOOK, USER);
  assert.deepEqual(ctx.continuityIssues.map(i => i.beschreibung), ['offen-kritisch', 'anderes-prolog', 'offen-mittel']);
  assert.equal(ctx.zeitstrahl.length, 2);
});
