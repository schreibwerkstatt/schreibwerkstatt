'use strict';
// Server-Pfade der Figuren: Kapitel-Figuren (Jahr/Alter, stale), Alters-Index
// pro User, Lebensereignisse ausgemusterter Figuren, Namens-Lookup im Buch-Chat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('figures-server-fixes');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const {
  getChapterFigures, getChapterFigureRelations, rebuildFigureAppearances, updateFigurenEvents,
} = require('../../db/figures');
const { replaceFigureAges, listFigureAges } = require('../../db/figure-ages');
const { findFigureByName } = require('../../db/book-chat/figures');
const { listFigureEventsForTimeline } = require('../../db/zeitstrahl');

const BOOK = 7101;
const A = 'a@x.ch';
const B = 'b@x.ch';
const now = new Date().toISOString();

function addFig(figId, name, user, { stale = 0, geburtstag = null, kurzname = null } = {}) {
  return Number(db.prepare(
    'INSERT INTO figures (book_id, fig_id, name, kurzname, user_email, stale, geburtstag, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(BOOK, figId, name, kurzname, user, stale, geburtstag, now).lastInsertRowid);
}

let anna, bert, alt, bAnna;
test.before(() => {
  for (const u of [A, B]) db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(u, u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, A);
  db.prepare('INSERT INTO book_settings (book_id, zeitlinie_real, updated_at) VALUES (?, 1, ?)').run(BOOK, now);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (1, ?, ?, 0, ?)')
    .run(BOOK, 'K1', now);
  anna = addFig('fig_1', 'Anna Weber', A, { geburtstag: '1900' });
  bert = addFig('fig_2', 'Bert Ähnlich', A, { kurzname: 'Bert' });
  alt  = addFig('orphan_9', 'Alter Mann', A, { stale: 1 });
  bAnna = addFig('fig_1', 'Anna Weber', B);
  for (const id of [anna, bert, alt]) {
    db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, 1, 3)').run(id);
  }
  db.prepare('INSERT INTO figure_relations (book_id, user_email, from_fig_id, to_fig_id, typ) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, A, anna, alt, 'freund');
  db.prepare('INSERT INTO figure_relations (book_id, user_email, from_fig_id, to_fig_id, typ) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, A, anna, bert, 'freund');
  // Datiertes Ereignis → Jahr im Roman 1930 für Anna.
  db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, datum_year, datum_unsicher, sort_order) VALUES (?, ?, ?, 1930, 0, 0)')
    .run(anna, '1930', 'Hochzeit');
});

test('getChapterFigures: Jahr/Alter landen an der fig_id-Zeile, stale fällt weg', () => {
  const figs = getChapterFigures(BOOK, 1, A, { withYears: true });
  assert.deepEqual(figs.map(f => f.id).sort(), ['fig_1', 'fig_2']);
  const a = figs.find(f => f.id === 'fig_1');
  assert.equal(a.jahr_im_roman, 1930);
  assert.equal(a.geburtsjahr, 1900);
  assert.equal(a.alter_im_roman, 30);
  assert.equal('_row_id' in a, false);
});

test('getChapterFigureRelations: keine Kante zu einer stale Figur', () => {
  const rels = getChapterFigureRelations(BOOK, 1, A);
  assert.deepEqual(rels.map(r => r.zu ?? r.to ?? r.zu_name).length, 1);
});

test('rebuildFigureAppearances: kapitel als blosse Namensliste', () => {
  rebuildFigureAppearances(BOOK, A, [{ id: 'fig_2', kapitel: ['K1'] }], { chNameToId: { K1: 1 } });
  const row = db.prepare('SELECT haeufigkeit FROM figure_appearances WHERE figure_id = ? AND chapter_id = 1').get(bert);
  assert.ok(row, 'String-Kapitel wird zugeordnet');
});

test('replaceFigureAges: ein Lauf von A lässt die Alterszeilen von B stehen', () => {
  replaceFigureAges(BOOK, B, { rows: [{ figure_id: bAnna, alter_von: 40, konfidenz: 1, belege: [{ art: 'alter', wert: 40, zitat: 'vierzig' }] }] });
  replaceFigureAges(BOOK, A, { rows: [{ figure_id: anna, alter_von: 30, konfidenz: 1, belege: [] }] });
  const bRows = listFigureAges(BOOK, B);
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0].belege.length, 1);
  assert.equal(listFigureAges(BOOK, A).length, 1);
  // A darf keine Figur von B in seinen Index schreiben.
  replaceFigureAges(BOOK, A, { rows: [{ figure_id: bAnna, alter_von: 1, konfidenz: 1 }] });
  assert.equal(listFigureAges(BOOK, B)[0].alter_von, 40);
});

test('updateFigurenEvents: Ereignisse einer stale Figur bleiben erhalten', () => {
  db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, datum_unsicher, sort_order) VALUES (?, ?, ?, 1, 0)').run(alt, '', 'Früher');
  updateFigurenEvents(BOOK, [{ fig_id: 'fig_2', lebensereignisse: [] }], A, { chNameToId: {} });
  const n = db.prepare('SELECT COUNT(*) AS n FROM figure_events WHERE figure_id = ?').get(alt).n;
  assert.equal(n, 1);
});

test('findFigureByName: Umlaut-Gross/Klein, Platzhalter, aktive vor stale', () => {
  assert.equal(findFigureByName(BOOK, A, 'bert ähnlich')?.fig_id, 'fig_2');
  assert.equal(findFigureByName(BOOK, A, 'BERT ÄHNLICH')?.fig_id, 'fig_2');
  assert.equal(findFigureByName(BOOK, A, '%'), undefined);
  assert.equal(findFigureByName(BOOK, A, 'a_na'), undefined);
  // Wortanfang schlägt Teilstring: „Al" → „Alter Mann" (Wortanfang), nicht über id.
  assert.equal(findFigureByName(BOOK, A, 'weber')?.fig_id, 'fig_1');
  assert.equal('stale' in findFigureByName(BOOK, A, 'anna'), false);
});

test('listFigureEventsForTimeline: Ereignisse einer stale Figur fehlen im Zeitstrahl', () => {
  db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, datum_unsicher, sort_order) VALUES (?, ?, ?, 1, 0)').run(bert, '', 'Umzug');
  const rows = listFigureEventsForTimeline(BOOK, A);
  assert.ok(rows.some(r => r.fig_id === 'fig_2'));
  assert.equal(rows.some(r => r.fig_id === 'orphan_9'), false);
});
