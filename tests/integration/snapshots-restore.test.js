'use strict';
// Integration test: routes/snapshots.js — Fassung speichern, Restore an Ort und
// Stelle (ganzes Buch + einzelner Knoten), Drift danach, Lösch-Schutz.
// Fährt den echten Router unter Express hoch (Fake-Session liefert den User).
// Schwerpunkt sind die Invarianten aus docs/fassungen.md „Restore-Pipeline":
//   - bestehende Seiten/Kapitel behalten ihre ID → FK-Daten (Ideen, Share-Links) überleben
//   - Einstellungen ausserhalb der Fassung, Arbeits-/Status-Felder und die
//     ACL-Freigabe bleiben unangetastet
//   - die wiederhergestellte Fassung ist danach die Drift-Baseline, nicht die Auto-Sicherung
//   - neu angelegte Kapitel: Querverweise darauf werden umgeschrieben
//   - Interleaving, excluded-Flag und Buchname kommen zurück
//   - seit der Fassung hinzugekommene Seiten landen im Papierkorb

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let cs;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const OWNER = 'autor@test.dev';
const EDITOR = 'mit@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';
const reqCtx = () => ({ session: { user: { email: OWNER } } });

function startServer() {
  return new Promise((resolve, reject) => {
    const router = require('../../routes/snapshots');
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/snapshots', router);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  cs = require('../../lib/content-store');
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

let BOOK = 500;
// Buch: Vorwort (Top) · Kapitel A [Seite A1] · Kapitel B (excluded) [Seite B1] · Nachwort (Top).
// Seite A1 verweist auf Kapitel B.
async function seedBook() {
  const bookId = ++BOOK;
  const { grantAccess } = require('../../db/book-access');
  for (const e of [OWNER, EDITOR]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(e);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, 'Original', NOW, NOW);
  grantAccess(bookId, OWNER, 'owner', OWNER);
  grantAccess(bookId, EDITOR, 'editor', OWNER);

  const c = reqCtx();
  const chA = await cs.createChapter({ book_id: bookId, name: 'Kapitel A' }, c);
  const chB = await cs.createChapter({ book_id: bookId, name: 'Kapitel B' }, c);
  await cs.updateChapter(chB.id, { excluded: true }, c);
  const vorwort = await cs.createPage({ book_id: bookId, name: 'Vorwort', html: '<p>Vorwort Text</p>' }, c);
  const xref = `<span class="xref" data-xref="chapter" data-xref-id="${chB.id}">Kapitel B</span>`;
  const a1 = await cs.createPage({ book_id: bookId, chapter_id: chA.id, name: 'A1', html: `<p>Siehe ${xref} weiter.</p>` }, c);
  const b1 = await cs.createPage({ book_id: bookId, chapter_id: chB.id, name: 'B1', html: '<p>Notizen</p>' }, c);
  const nachwort = await cs.createPage({ book_id: bookId, name: 'Nachwort', html: '<p>Nachwort Text</p>' }, c);
  require('../../db/book-order').putOrder(bookId, [
    { type: 'page', id: vorwort.id },
    { type: 'chapter', id: chA.id, children: [{ type: 'page', id: a1.id }] },
    { type: 'chapter', id: chB.id, children: [{ type: 'page', id: b1.id }] },
    { type: 'page', id: nachwort.id },
  ], OWNER);

  const bs = require('../../db/book-settings');
  bs.saveBookSettings(bookId, 'de', 'CH', 'roman', null, null, null, 0, 0, null, 0, null, 50000, null, 'Stil alt', 0, 0, 0);
  bs.setBookCitationSettings(bookId, { citation_style: 'apa7' });
  return { bookId, chA, chB, vorwort, a1, b1, nachwort };
}

async function capture(bookId) {
  sessionUser = OWNER;
  const r = await api('POST', `/snapshots/${bookId}`, { label: 'Stand' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.snapshot;
}

function orderOf(bookId) {
  return require('../../db/book-order').getOrder(bookId).tree;
}

test('Restore schreibt an Ort und Stelle: IDs, FK-Daten, Settings, ACL bleiben', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);

  // Nach der Fassung: Text ändern, Seite neu, Idee + Share-Link an A1, Settings + ACL-Freigabe ändern.
  const c = reqCtx();
  await cs.savePage(s.a1.id, { html: '<p>Komplett umgeschrieben</p>', name: 'A1 neu' }, c);
  const neu = await cs.createPage({ book_id: s.bookId, chapter_id: s.chA.id, name: 'Neu', html: '<p>neu</p>' }, c);
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, status, created_at, updated_at)
              VALUES (?, ?, ?, 'Idee', 'offen', ?, ?)`).run(s.bookId, s.a1.id, OWNER, NOW, NOW);
  db.prepare(`INSERT INTO share_links (token, kind, page_id, book_id, owner_email, view_count, created_at, show_toc)
              VALUES ('tok-a1', 'page', ?, ?, ?, 0, ?, 0)`).run(s.a1.id, s.bookId, OWNER, NOW);
  const bs = require('../../db/book-settings');
  bs.saveBookSettings(s.bookId, 'de', 'CH', 'sachbuch', null, null, null, 0, 1, null, 0, null, 99, null, 'Stil neu', 1, 1, 1);
  await cs.updateBook(s.bookId, { name: 'Umbenannt' }, c);
  await cs.updateChapter(s.chB.id, { excluded: false }, c);

  sessionUser = EDITOR;
  const r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.failed, 0);
  assert.equal(r.json.pagesCreated, 0);
  assert.equal(r.json.pagesDeleted, 1);

  // Seite behält ihre ID, Inhalt + Name zurück, Historie trägt den Restore.
  const a1 = await cs.loadPage(s.a1.id, c);
  assert.equal(a1.name, 'A1');
  assert.match(a1.html, /Siehe/);
  // FK-Daten überleben.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ideen WHERE page_id = ?').get(s.a1.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM share_links WHERE token = 'tok-a1'").get().n, 1);
  // Seit der Fassung neue Seite → Papierkorb mit Inhalt.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE page_id = ?').get(neu.id).n, 0);
  const del = db.prepare('SELECT body_html FROM page_deletions WHERE page_id = ?').get(neu.id);
  assert.ok(del && /neu/.test(del.body_html || ''), 'gelöschte Seite liegt im Papierkorb');

  // Inhalts-Settings der Fassung zurück; Arbeits-/Status-Felder (Ziel,
  // Stilprofil, Statistik-Ausschluss) und ACL-Freigabe bleiben auf dem aktuellen Stand.
  const st = bs.getBookSettings(s.bookId);
  assert.equal(st.buchtyp, 'roman');
  assert.equal(st.zeitlinie_real, 0);
  assert.equal(st.weltfakten_real_pruefen, 0);
  assert.equal(st.citation_style, 'apa7');
  assert.equal(st.stilprofil, 'Stil neu');
  assert.equal(st.goal_target_chars, 99);
  assert.equal(st.exclude_from_stats, 1);
  assert.equal(st.allow_lektor_book_chat, 1);

  // Buchname, excluded-Flag und Reihenfolge zurück (kanonisch: kapitellose
  // Abschnitte vor den Kapiteln, in ihrer Reihenfolge untereinander).
  assert.equal((await cs.loadBook(s.bookId, c)).name, 'Original');
  assert.equal((await cs.loadChapter(s.chB.id, c)).excluded, true);
  assert.deepEqual(orderOf(s.bookId).map(e => `${e.type}:${e.id}`), [
    `page:${s.vorwort.id}`, `page:${s.nachwort.id}`, `chapter:${s.chA.id}`, `chapter:${s.chB.id}`,
  ]);

  // Auto-Sicherung angelegt (kind), Ziel-Fassung als wiederhergestellt markiert.
  const list = (await api('GET', `/snapshots/${s.bookId}`)).json.snapshots;
  assert.equal(list.length, 2);
  assert.equal(list.find(x => x.id !== snap.id).kind, 'auto_backup');
  assert.ok(list.find(x => x.id === snap.id).restored_at);
});

test('Drift-Baseline nach Restore ist die wiederhergestellte Fassung, nicht die Sicherung', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  await cs.savePage(s.a1.id, { html: '<p>ganz anderer Text ohne Bezug</p>' }, reqCtx());
  await capture(s.bookId); // juengere Fassung mit dem geaenderten Stand
  const r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const dr = (await api('GET', `/snapshots/${s.bookId}/drift`)).json;
  assert.equal(dr.baseline.id, snap.id);
  assert.equal(dr.drift.text.changePct, 0);
  assert.equal(dr.drift.worthwhile, false);
});

test('Restore legt keine Sicherung an, wenn der Stand schon als Fassung existiert', async () => {
  const s = await seedBook();
  const snap1 = await capture(s.bookId);
  await cs.savePage(s.a1.id, { html: '<p>Zweiter Stand</p>' }, reqCtx());
  const snap2 = await capture(s.bookId);
  // Aktueller Stand == Fassung 2 → keine Sicherung; danach == Fassung 1 → wieder keine.
  assert.equal((await api('POST', `/snapshots/${s.bookId}/${snap1.id}/restore`)).status, 200);
  assert.equal((await api('POST', `/snapshots/${s.bookId}/${snap2.id}/restore`)).status, 200);
  assert.equal((await api('POST', `/snapshots/${s.bookId}/${snap1.id}/restore`)).status, 200);
  const list = (await api('GET', `/snapshots/${s.bookId}`)).json.snapshots;
  assert.equal(list.length, 2, JSON.stringify(list.map(x => x.kind)));
});

test('Kapitel-Restore legt vorher eine Sicherung an', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  await cs.updateChapter(s.chA.id, { name: 'Umbenannt' }, reqCtx());
  const r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore-node`, { kind: 'chapter', srcId: s.chA.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await cs.loadChapter(s.chA.id, reqCtx())).name, 'Kapitel A');
  const list = (await api('GET', `/snapshots/${s.bookId}`)).json.snapshots;
  assert.deepEqual(list.map(x => x.kind).sort(), ['auto_backup', 'manual']);
});

test('Drift direkt nach einem Restore matcht weiter über srcId', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  await cs.savePage(s.a1.id, { html: '<p>Anders</p>' }, reqCtx());
  const r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Neue Fassung = Restore-Stand → Drift 0, keine Seite „entfernt/neu".
  await capture(s.bookId);
  const d = (await api('GET', `/snapshots/${s.bookId}/drift`)).json.drift;
  assert.equal(d.text.changePct, 0);
  assert.equal(d.text.addedPages, 0);
  assert.equal(d.text.removedPages, 0);
  assert.equal(d.worthwhile, false);
});

test('Restore legt gelöschtes Kapitel neu an und schreibt Querverweise darauf um', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  const c = reqCtx();
  await cs.deletePage(s.b1.id, c);
  await cs.deleteChapter(s.chB.id, c);

  const r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.chaptersCreated, 1);
  const newB = (await cs.listChapters(s.bookId, c)).find(ch => ch.name === 'Kapitel B');
  assert.ok(newB && newB.id !== s.chB.id);
  assert.equal(newB.excluded, true);
  const a1 = await cs.loadPage(s.a1.id, c);
  assert.match(a1.html, new RegExp(`data-xref-id="${newB.id}"`));
});

test('restore-node holt eine einzelne Seite zurück, ohne Rest anzufassen', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  const c = reqCtx();
  await cs.savePage(s.vorwort.id, { html: '<p>Vorwort neu</p>' }, c);
  await cs.savePage(s.nachwort.id, { html: '<p>Nachwort neu</p>' }, c);
  await cs.deletePage(s.b1.id, c);

  let r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore-node`, { kind: 'page', srcId: s.vorwort.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pageId, s.vorwort.id);
  assert.match((await cs.loadPage(s.vorwort.id, c)).html, /Vorwort Text/);
  assert.match((await cs.loadPage(s.nachwort.id, c)).html, /Nachwort neu/);

  // Gelöschte Seite entsteht neu im noch existierenden Kapitel.
  r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore-node`, { kind: 'page', srcId: s.b1.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pagesCreated, 1);
  const recreated = await cs.loadPage(r.json.pageId, c);
  assert.equal(recreated.chapter_id, s.chB.id);

  r = await api('POST', `/snapshots/${s.bookId}/${snap.id}/restore-node`, { kind: 'page', srcId: 999999 });
  assert.equal(r.status, 404);
});

test('Veröffentlichte Fassung: Löschen braucht force UND Owner', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  const first = await api('POST', `/snapshots/${s.bookId}/${snap.id}/publish`, { published: true });
  assert.equal(first.status, 200);
  // Erneutes Markieren behaelt das Auflagen-Datum.
  db.prepare('UPDATE book_snapshots SET published_at = ? WHERE id = ?').run(NOW, snap.id);
  const again = await api('POST', `/snapshots/${s.bookId}/${snap.id}/publish`, { published: true });
  assert.equal(again.json.published_at, NOW);

  sessionUser = EDITOR;
  assert.equal((await api('DELETE', `/snapshots/${s.bookId}/${snap.id}`)).status, 409);
  assert.equal((await api('DELETE', `/snapshots/${s.bookId}/${snap.id}?force=1`)).status, 403);
  sessionUser = OWNER;
  assert.equal((await api('DELETE', `/snapshots/${s.bookId}/${snap.id}?force=1`)).status, 200);
});

test('Auto-Capture-Dedup vergleicht den Inhalt, nicht nur Zähler', async () => {
  const s = await seedBook();
  await capture(s.bookId);
  const { captureSnapshot } = require('../../routes/snapshots');
  const c = reqCtx();
  assert.equal(await captureSnapshot(s.bookId, c, { dedup: true }), null);
  // Gleich lange Umformulierung: Zähler identisch, Inhalt nicht.
  await cs.savePage(s.vorwort.id, { html: '<p>Vorwort Tax1</p>' }, c);
  assert.ok(await captureSnapshot(s.bookId, c, { dedup: true }));
});

test('GET Fassung: defektes JSON → 422, Extras-Übersicht ohne Rohblob', async () => {
  const s = await seedBook();
  const snap = await capture(s.bookId);
  const r = await api('GET', `/snapshots/${s.bookId}/${snap.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.snapshot.kind, 'manual');
  assert.equal(r.json.snapshot.extras_json, undefined);
  db.prepare("UPDATE book_snapshots SET content_json = '{kaputt' WHERE id = ?").run(snap.id);
  assert.equal((await api('GET', `/snapshots/${s.bookId}/${snap.id}`)).status, 422);
});
