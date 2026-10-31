// Buch-Guard nach await (public/js/cards/book-guard.js) + sein wichtigster
// Konsument mit Schreibkette: _createDiaryEntry darf nach einem Buchwechsel
// mitten in der Anlage weder im neuen Buch anlegen noch dessen Tree mutieren.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const nav = { selectedBookId: '7', tree: [], pages: [] };
globalThis.window = globalThis.window || {};
globalThis.window.Alpine = { store: (n) => (n === 'nav' ? nav : {}) };

const { isSelectedBook, loadToken } = await import('../../public/js/cards/book-guard.js');
const { claimSaveOwner, ownsSave } = await import('../../public/js/editor/notebook/save-owner.js');
const { diaryCalendarMethods } = await import('../../public/js/book/diary-calendar.js');
const { contentRepo } = await import('../../public/js/repo/content.js');

test('isSelectedBook: String-/Number-tolerant, leer = false', () => {
  nav.selectedBookId = '7';
  assert.equal(isSelectedBook(7), true);
  assert.equal(isSelectedBook('7'), true);
  assert.equal(isSelectedBook('8'), false);
  assert.equal(isSelectedBook(''), false);
  assert.equal(isSelectedBook(null), false);
  nav.selectedBookId = '';
  assert.equal(isSelectedBook(''), false);
});

test('_createDiaryEntry: Buchwechsel nach Jahr-Kapitel bricht die Kette ab', async () => {
  nav.selectedBookId = '7';
  nav.tree = [];
  nav.pages = [];
  const calls = [];
  const origChapter = contentRepo.createChapter;
  const origPage = contentRepo.createPage;
  contentRepo.createChapter = async (body) => {
    calls.push(['chapter', body.book_id]);
    nav.selectedBookId = '8'; // User wechselt waehrend des Requests
    return { id: 100, name: body.name, position: body.position };
  };
  contentRepo.createPage = async (body) => { calls.push(['page', body.book_id]); return { id: 200 }; };
  const statuses = [];
  const ctx = {
    ...diaryCalendarMethods,
    $store: { nav },
    canEdit: () => true,
    diaryCalendarPagesMap: () => new Map(),
    selectPage: () => { throw new Error('darf nicht oeffnen'); },
    setStatus: (s) => statuses.push(s),
    t: (k) => k,
    _diaryCreatingDate: null,
  };
  try {
    await ctx._createDiaryEntry('2026-03-04');
  } finally {
    contentRepo.createChapter = origChapter;
    contentRepo.createPage = origPage;
  }
  assert.deepEqual(calls, [['chapter', 7]], 'nach dem Wechsel keine weitere Anlage');
  assert.deepEqual(nav.tree, [], 'Tree des neuen Buchs unberuehrt');
  assert.deepEqual(statuses, [], 'kein Fehler-Status fuer einen selbst ausgeloesten Wechsel');
  assert.equal(ctx._diaryCreatingDate, null);
});

test('loadToken: jüngerer Load überholt älteren, Buchwechsel macht stale', () => {
  nav.selectedBookId = '7';
  const ctx = {};
  const first = loadToken(ctx, '_seq', 7);
  assert.equal(first(), true);
  const second = loadToken(ctx, '_seq', 7);
  assert.equal(first(), false, 'älterer Load gilt nach jüngerem nicht mehr');
  assert.equal(first.latest(), false);
  assert.equal(second(), true);
  nav.selectedBookId = '8';
  assert.equal(second(), false, 'Buchwechsel → stale');
  assert.equal(second.latest(), true, 'latest() prüft nur die Sequenz');
});

test('loadToken: ohne bookId gilt das beim Aufruf gewählte Buch', () => {
  nav.selectedBookId = '9';
  const ctx = {};
  const tok = loadToken(ctx, '_seq');
  assert.equal(tok(), true);
  nav.selectedBookId = '10';
  assert.equal(tok(), false);
});

test('save-owner: nur der jüngste Besitzer räumt editSaving', () => {
  const a = claimSaveOwner();
  const b = claimSaveOwner(); // Save der neuen Seite übernimmt
  assert.equal(ownsSave(a), false, 'alter Save darf das Flag der neuen Seite nicht räumen');
  assert.equal(ownsSave(b), true);
  assert.equal(ownsSave(b), false, 'einmal geräumt ist geräumt');
});
