// Werkzeug-Verlauf des Buch-Chats: Fehlertexte der Werkzeuge sind deutsch (fürs
// Modell); mit errorKey wird für die Anzeige übersetzt, ohne Key bleibt der Rohtext.
import test from 'node:test';
import assert from 'node:assert/strict';

const { toolRows } = await import('../../public/js/chat/book-chat.js');

test('toolRows: errorKey wird übersetzt, final_answer fällt weg', () => {
  const t = (k, p) => `${k}|${JSON.stringify(p)}`;
  const rows = toolRows([
    { name: 'get_pages', ok: false, error: 'page_id fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'page_id' } },
    { name: 'lookup', ok: false, error: 'Unbekanntes Werkzeug: lookup' },
    { name: 'final_answer', ok: true },
  ], t);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].error, 'chat.toolError.missingParam|{"param":"page_id"}');
  assert.equal(rows[1].error, 'Unbekanntes Werkzeug: lookup');
  assert.equal(rows[0].failed, true);
});
