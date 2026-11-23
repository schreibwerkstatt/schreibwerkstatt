'use strict';
// Integration test: das Beispielbuch des Demo-Zugangs kommt aus dem Fixture
// assets/demo/beispiel-verwandlung.swbook — mit fertiger Komplettanalyse,
// Recherche, Ideen und Chat-Verläufen, eingespielt über den Kern des
// Buch-Imports (routes/jobs/book-import.js#importSwbookBuffer).
//
// Geprüft wird, was ein Store-Prüfer nach dem Login sehen soll: das Buch mit
// Inhalt, gefüllte Werkstätten auf SEINEM Analyse-Scope, und dass ein zweiter
// Seed-Lauf (jeder Login, jeder Serverstart) kein Zweitbuch anlegt. Bricht ein
// Schema-Wechsel das Einspielen des Fixtures, wird dieser Test rot statt dass
// die Demo still auf das leere Buch zurückfällt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
const DEMO = 'demo-bundle@x.test';

test.before(() => {
  ctx = bootstrap();
  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(DEMO)) {
    appUsers.createUser({ email: DEMO, displayName: 'Demo', globalRole: 'user', status: 'active' });
  }
});

test.after(() => ctx.cleanup());

function count(sql, ...args) {
  const { db } = require('../../db/connection');
  return db.prepare(sql).get(...args).n;
}

test('Demo-Seed spielt das Fixture mit Analyse, Recherche, Ideen und Chats ein', async () => {
  const demoBook = require('../../lib/demo-book');
  const r = await demoBook.createDemoBookWithData(DEMO);
  assert.equal(r.bundle, true, 'Fixture wurde nicht eingespielt (Fallback auf das leere Buch)');
  assert.equal(r.deduplicated, false);
  const bookId = r.bookId;

  const contentStore = require('../../lib/content-store');
  const books = await contentStore.listBooks({ session: { user: { email: DEMO } } });
  const book = books.find(b => b.id === bookId);
  assert.equal(book?.name, demoBook.DEMO_BOOK_NAME);
  assert.equal(require('../../db/book-access').getBookRole(bookId, DEMO), 'owner');

  assert.equal(count('SELECT COUNT(*) n FROM pages WHERE book_id = ?', bookId), 5);
  // Analyse-Scope ist der Demo-User (sonst sähe er leere Karten).
  assert.ok(count('SELECT COUNT(*) n FROM figures WHERE book_id = ? AND user_email = ?', bookId, DEMO) >= 4, 'Figuren fehlen');
  assert.ok(count('SELECT COUNT(*) n FROM locations WHERE book_id = ? AND user_email = ?', bookId, DEMO) >= 1, 'Orte fehlen');
  assert.ok(count('SELECT COUNT(*) n FROM figure_scenes WHERE book_id = ? AND user_email = ?', bookId, DEMO) >= 1, 'Szenen fehlen');
  assert.ok(count('SELECT COUNT(*) n FROM research_items WHERE book_id = ?', bookId) >= 1, 'Recherche fehlt');
  assert.ok(count('SELECT COUNT(*) n FROM ideen WHERE book_id = ? AND user_email = ?', bookId, DEMO) >= 1, 'Ideen fehlen');
  assert.ok(count("SELECT COUNT(*) n FROM chat_sessions WHERE book_id = ? AND kind IN ('research','ideen')", bookId) >= 2, 'Chat-Verläufe fehlen');
  // Ideen hängen an Abschnitten dieses Buchs (ID-Remap griff).
  assert.equal(
    count(`SELECT COUNT(*) n FROM ideen i JOIN pages p ON p.page_id = i.page_id
           WHERE i.book_id = ? AND p.book_id != i.book_id`, bookId),
    0,
  );

  const again = await demoBook.createDemoBookWithData(DEMO);
  assert.equal(again.deduplicated, true);
  assert.equal(again.bookId, bookId);
});
