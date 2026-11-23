'use strict';
// Jede Struktur-Änderung über die echten Content-Router hinterlässt eine
// info-Logzeile: Abschnitt/Kapitel anlegen, umbenennen, verschieben, löschen,
// Reihenfolge (mit Diff), Buch umbenennen/löschen, Revision wiederherstellen/
// anheften und jedes Speichern (PAGE_SAVE, auch Routine-Autosave).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

const ME = 'logspur@test.dev';
let ctx, server, baseUrl, logger, contentStore;
const lines = [];

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

// Logzeilen seit dem letzten Aufruf.
function take() { return lines.splice(0); }
function hasLine(got, re) {
  assert.ok(got.some(l => re.test(l)), `erwartet ${re}, bekommen:\n${got.join('\n')}`);
}

test.before(async () => {
  ctx = bootstrap();
  const { db } = require('../../db/schema');
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(ME);
  logger = require('../../logger');
  contentStore = require('../../lib/content-store');
  for (const lvl of ['info', 'warn']) {
    const orig = logger[lvl].bind(logger);
    logger[lvl] = (msg, ...a) => { lines.push(`${lvl}: ${msg}`); return orig(msg, ...a); };
  }
  await new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
    app.use('/content', require('../../routes/content'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    server.on('error', reject);
  });
});
test.after(() => { server?.close(); ctx.cleanup(); });

test('Content-Mutationen: je eine Logzeile mit Ids, Namen und Änderung', async () => {
  const book = await contentStore.createBook({ name: 'Logbuch' }, { session: { user: { email: ME } } });
  const B = book.id;
  require('../../db/book-access').grantAccess(B, ME, 'owner', ME);
  take();

  const c1 = (await api('POST', '/content/chapters', { book_id: B, name: 'Eins' })).json;
  hasLine(take(), new RegExp(`^info: Kapitel angelegt: Kapitel ${c1.id} «Eins» \\(oberste Ebene\\)\\.$`));
  const c2 = (await api('POST', '/content/chapters', { book_id: B, name: 'Zwei' })).json;
  take();

  const r = await api('PUT', `/content/chapters/${c1.id}`, { name: 'Erstes' });
  assert.equal(r.status, 200);
  hasLine(take(), new RegExp(`^info: Kapitel geändert: Kapitel ${c1.id}: Name «Eins»→«Erstes»\\.$`));

  const p = (await api('POST', '/content/pages', { book_id: B, chapter_id: c1.id, name: 'Szene', html: '<p>Hallo</p>' })).json;
  hasLine(take(), new RegExp(`^info: Abschnitt angelegt: Seite ${p.id} «Szene» in Kapitel ${c1.id} \\(\\d+ Zeichen HTML\\)\\.$`));

  // Routine-Autosave steht auf info.
  const s = await api('PUT', `/content/pages/${p.id}`, { html: '<p>Hallo Welt</p>', save_reason: 'autosave' });
  assert.equal(s.status, 200);
  hasLine(take(), new RegExp(`^info: PAGE_SAVE Seite ${p.id}: .* Weg autosave `));

  // Reihenfolge: Abschnitt von Kapitel 1 nach Kapitel 2.
  const o = await api('PUT', `/content/books/${B}/order`, {
    order_json: [{ type: 'chapter', id: c1.id, children: [] },
      { type: 'chapter', id: c2.id, children: [{ type: 'page', id: p.id }] }],
  });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  hasLine(take(), new RegExp(`^info: Reihenfolge gespeichert: 2 Kapitel, 1 Abschnitte; umgehängt: Abschnitt ${p.id} \\(Kapitel ${c1.id}→Kapitel ${c2.id}\\)\\.$`));

  // Revision anheften + wiederherstellen.
  const { db } = require('../../db/schema');
  const rev = db.prepare('SELECT id FROM page_revisions WHERE page_id = ? ORDER BY id LIMIT 1').get(p.id);
  assert.ok(rev, 'Revision vorhanden');
  assert.equal((await api('PATCH', `/content/pages/${p.id}/revisions/${rev.id}`, { pinned: true, label: 'Erstfassung' })).status, 200);
  hasLine(take(), new RegExp(`^info: Revision angeheftet: Seite ${p.id} Revision #${rev.id} «Erstfassung»\\.$`));
  assert.equal((await api('POST', `/content/pages/${p.id}/revisions/${rev.id}/restore`, {})).status, 200);
  hasLine(take(), new RegExp(`^info: Revision wiederhergestellt: Seite ${p.id} aus Revision #${rev.id} vom .+, neu .+\\.$`));

  assert.equal((await api('DELETE', `/content/pages/${p.id}`)).status, 200);
  hasLine(take(), new RegExp(`^info: Abschnitt gelöscht: Seite ${p.id} «Szene» → Papierkorb \\(Geraet -\\)\\.$`));

  assert.equal((await api('DELETE', `/content/chapters/${c2.id}`)).status, 200);
  hasLine(take(), new RegExp(`^info: Kapitel gelöscht: Kapitel ${c2.id} «Zwei» `));

  assert.equal((await api('PUT', `/content/books/${B}`, { name: 'Logbuch 2' })).status, 200);
  hasLine(take(), /^info: Buch geändert: Name «Logbuch»→«Logbuch 2»\.$/);

  assert.equal((await api('DELETE', `/content/books/${B}`)).status, 200);
  hasLine(take(), new RegExp(`^warn: Buch gelöscht: Buch ${B} «Logbuch 2» durch ${ME}\\.$`));
});
