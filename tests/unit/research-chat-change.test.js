'use strict';
// propose_research_item MIT item_id (routes/jobs/research-chat-change.js):
// Änderungen an bestehenden Fundstücken vorschlagen — validiert, gesammelt in
// ctx.changeProposals, nie geschrieben.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('rcc');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/schema');
const { executeResearchTool } = require('../../routes/jobs/research-chat-tools');
const { sessionProposalMemory } = require('../../routes/jobs/research-chat-helpers');

const USER = 'tester@example.com';
const BOOK = 70101;
const OTHER_BOOK = 70102;
const NOW = '2026-01-01T00:00:00.000Z';

db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'B', ?, ?)").run(BOOK, NOW, NOW);
db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'C', ?, ?)").run(OTHER_BOOK, NOW, NOW);
const PAGE = db.prepare("INSERT INTO pages (book_id, page_name, body_html, updated_at) VALUES (?, 'Ankunft', ?, ?)")
  .run(BOOK, '<p>Der Zug fuhr um <b>7 Uhr</b> in Olten ein, pünktlich wie immer.</p>', NOW).lastInsertRowid;
const FOREIGN_PAGE = db.prepare("INSERT INTO pages (book_id, page_name, body_html, updated_at) VALUES (?, 'X', ?, ?)")
  .run(OTHER_BOOK, '<p>Der Zug fuhr um 7 Uhr in Olten ein.</p>', NOW).lastInsertRowid;

function item(fields = {}) {
  const f = { kind: 'note', title: 'Fahrplan', body: 'Erster Zug 7 Uhr', archived: 0, book: BOOK, ...fields };
  const id = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, body, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(f.book, USER, f.kind, f.title, f.body, f.archived, NOW, NOW).lastInsertRowid;
  for (const [i, u] of (f.urls || []).entries()) {
    db.prepare('INSERT INTO research_item_urls (item_id, url, position, created_at) VALUES (?, ?, ?, ?)').run(id, u, i, NOW);
  }
  for (const t of f.tags || []) db.prepare('INSERT INTO research_item_tags (item_id, tag) VALUES (?, ?)').run(id, t);
  return id;
}

const ctx = () => ({ bookId: BOOK, userEmail: USER, proposals: [], logger: { warn() {}, info() {} } });
const propose = (input, c = ctx()) => executeResearchTool('propose_research_item', input, c).then(r => ({ r, c }));

test('ergänzen: nur Neues landet im Vorschlag, before hält den Stand', async () => {
  const id = item({ urls: ['https://example.org/a'], tags: ['Bahn'] });
  const { r, c } = await propose({
    item_id: id, append: 'Ab 1902 elektrisch.',
    urls: [{ url: 'https://www.example.org/a' }, { url: 'https://example.org/b', label: 'B' }],
    tags: ['bahn', 'Olten'],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(c.proposals.length, 0, 'neue Fundstücke bleiben leer');
  const p = c.changeProposals[0];
  assert.equal(p.type, 'research_update');
  assert.equal(p.fields.append, 'Ab 1902 elektrisch.');
  assert.deepEqual(p.fields.tags, ['Olten'], 'vorhandener Tag (ohne Gross/Klein) fällt weg');
  assert.deepEqual(p.urls.map(u => u.url), ['https://example.org/b'], 'vorhandene URL (normalisiert) fällt weg');
  assert.equal(p.before.body, 'Erster Zug 7 Uhr');
  assert.equal(p.labels.item, 'Fahrplan');
});

test('kein No-Op, nicht body und append zugleich, fremder/archivierter Eintrag abgelehnt', async () => {
  const id = item();
  assert.equal((await propose({ item_id: id, title: 'Fahrplan' })).r.ok, false);
  assert.equal((await propose({ item_id: id, body: 'neu', append: 'mehr' })).r.ok, false);
  assert.equal((await propose({ item_id: item({ book: OTHER_BOOK }), append: 'x' })).r.ok, false);
  assert.equal((await propose({ item_id: item({ archived: 1 }), append: 'x' })).r.ok, false);
  const r = (await propose({ item_id: 999999, append: 'x' })).r;
  assert.equal(r.errorKey, 'chat.toolError.proposalRejected');
});

test('Felder des Änderungsmodus ohne item_id → abgelehnt statt still neues Fundstück', async () => {
  const { r, c } = await propose({ kind: 'note', title: 'Neu', status: 'eingearbeitet' });
  assert.equal(r.ok, false);
  assert.equal(c.proposals.length, 0);
});

test('eingearbeitet nur mit geprüftem Beleg aus einem Abschnitt dieses Buchs', async () => {
  const id = item();
  assert.equal((await propose({ item_id: id, status: 'eingearbeitet' })).r.ok, false, 'ohne Beleg');
  assert.equal((await propose({ item_id: id, status: 'eingearbeitet', beleg: { text: 'um 9 Uhr in Olten', page_id: PAGE } })).r.ok, false, 'Zitat steht nicht da');
  assert.equal((await propose({ item_id: id, status: 'eingearbeitet', beleg: { text: 'um 7 Uhr in Olten', page_id: FOREIGN_PAGE } })).r.ok, false, 'fremdes Buch');
  // Wortlaut-Suche liefert Text ohne Leerzeichen-Eigenheiten der Inline-Tags.
  const { r, c } = await propose({ item_id: id, status: 'eingearbeitet', beleg: { text: 'fuhr um 7 Uhr in Olten ein', page_id: PAGE } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = c.changeProposals[0];
  assert.equal(p.fields.status, 'eingearbeitet');
  assert.deepEqual(p.beleg, { text: 'fuhr um 7 Uhr in Olten ein', page_id: PAGE });
  assert.equal(p.labels.beleg_page, 'Ankunft');
  // Stufe ohne Beleg-Pflicht geht ohne.
  assert.equal((await propose({ item_id: item(), status: 'verworfen' })).r.ok, true);
});

test('archivieren steht allein', async () => {
  const id = item();
  assert.equal((await propose({ item_id: id, archive: true, append: 'x' })).r.ok, false);
  const { r, c } = await propose({ item_id: id, archive: true });
  assert.equal(r.ok, true);
  assert.equal(c.changeProposals[0].type, 'research_archive');
});

test('zusammenführen: nur Text-Fundstücke gehen auf, nicht sich selbst, ein Vorschlag je Eintrag', async () => {
  const a = item({ title: 'A' });
  const b = item({ title: 'B', body: 'Mehr zum Fahrplan' });
  assert.equal((await propose({ item_id: a, merge_item_id: a })).r.ok, false);
  assert.equal((await propose({ item_id: a, merge_item_id: item({ kind: 'image', title: 'Bild' }) })).r.ok, false);
  assert.equal((await propose({ item_id: a, merge_item_id: b, tags: ['x'] })).r.ok, false, 'nur title/body');
  const c = ctx();
  const { r } = await propose({ item_id: a, merge_item_id: b, body: 'Zusammen' }, c);
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = c.changeProposals[0];
  assert.equal(p.type, 'research_merge');
  assert.equal(p.merge_item_id, b);
  assert.equal(p.labels.merge_item, 'B');
  assert.equal(p.merge_preview.body, 'Mehr zum Fahrplan');
  // Dieselbe Antwort fasst B nicht ein zweites Mal an.
  assert.equal((await propose({ item_id: b, append: 'x' }, c)).r.ok, false);
});

test('Gedächtnis: Änderungen erscheinen mit Stand', () => {
  const sid = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'research', ?, ?, ?)"
  ).run(BOOK, USER, NOW, NOW).lastInsertRowid;
  db.prepare("INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'a', ?, ?)").run(sid, JSON.stringify({
    proposals: [
      { type: 'research_update', item_id: 5, fields: { status: 'in_arbeit', append: 'x' }, labels: { item: 'Fahrplan' }, applied_at: NOW },
      { type: 'research_archive', item_id: 6, labels: { item: 'Alt' }, status: 'discarded' },
    ],
  }), NOW);
  const mem = sessionProposalMemory(sid);
  assert.deepEqual(mem.map(m => [m.kind, m.item_id, m.change_state]), [['change', 5, 'applied'], ['change', 6, 'discarded']]);
  assert.match(mem[0].what, /Status → in_arbeit/);
});
