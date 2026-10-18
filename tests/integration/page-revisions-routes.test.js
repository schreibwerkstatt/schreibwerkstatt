'use strict';
// Revisions-Routen + Schreibhook: Ausgangsstand vor dem ersten Save, Restore
// mit eigener Quelle, Anheften (Rechte, Validierung, Retention), Vorgaengerin
// und Ausliefer-Haertung im Detail, `older`/`pinned` in der Liste.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bootstrap } = require('./_helpers/setup');

const OWNER = 'autorin@test.dev';
const VIEWER = 'leser@test.dev';
const BOOK = 9501;
const PAGE = 95011;
const OLD = '2025-03-01T08:00:00.000Z';
const NOW = '2026-01-01T00:00:00.000Z';

let ctx, db, server, baseUrl;
let asUser = OWNER;

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

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: asUser } }; next(); });
  app.use('/content', require('../../routes/content'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  for (const e of [OWNER, VIEWER]) db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)').run(e, NOW);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', NOW, NOW);
  // Alt-Bestand: Inhalt ohne jede Revision.
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, 'Abschnitt', 0, ?, '<p>Ursprungstext</p>')`).run(PAGE, BOOK, OLD);
  const access = require('../../db/book-access');
  access.grantAccess(BOOK, OWNER, 'owner', OWNER);
  access.grantAccess(BOOK, VIEWER, 'viewer', OWNER);
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

const revRows = () => db.prepare(
  'SELECT id, body_html, source, summary, created_at, pinned, label FROM page_revisions WHERE page_id = ? ORDER BY created_at, id',
).all(PAGE);

test('erster Save sichert den Ausgangsstand, datiert auf dessen updated_at', async () => {
  assert.equal(revRows().length, 0);
  const r = await api('PUT', `/content/pages/${PAGE}`, { html: '<p>Neuer Text</p>', expected_updated_at: OLD });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const rows = revRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].summary, 'baseline');
  assert.equal(rows[0].created_at, OLD);
  assert.match(rows[0].body_html, /Ursprungstext/);
  assert.match(rows[1].body_html, /Neuer Text/);

  // Zweiter Save: kein weiterer Ausgangsstand.
  const cur = db.prepare('SELECT updated_at FROM pages WHERE page_id = ?').get(PAGE).updated_at;
  await api('PUT', `/content/pages/${PAGE}`, { html: '<p>Neuer <strong>Text</strong></p>', expected_updated_at: cur });
  const after = revRows();
  assert.equal(after.length, 3, 'Formatierungs-Aenderung braucht eine Revision');
  assert.equal(after.filter(x => x.summary === 'baseline').length, 1);
});

test('Restore schreibt Quelle restore + Summary mit Ursprung', async () => {
  const base = revRows()[0];
  const r = await api('POST', `/content/pages/${PAGE}/revisions/${base.id}/restore`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const last = revRows().at(-1);
  assert.equal(last.source, 'restore');
  assert.equal(last.summary, `restored from #${base.id}`);
});

test('PATCH anheften: editor-Recht, Validierung, Name', async () => {
  const target = revRows()[1];
  asUser = VIEWER;
  try {
    const denied = await api('PATCH', `/content/pages/${PAGE}/revisions/${target.id}`, { pinned: true });
    assert.equal(denied.status, 403);
  } finally { asUser = OWNER; }

  assert.equal((await api('PATCH', `/content/pages/${PAGE}/revisions/${target.id}`, {})).json.error_code, 'PINNED_REQUIRED');
  assert.equal((await api('PATCH', `/content/pages/${PAGE}/revisions/${target.id}`, { pinned: true, label: 5 })).json.error_code, 'INVALID_LABEL');
  assert.equal((await api('PATCH', `/content/pages/${PAGE}/revisions/999999`, { pinned: true })).status, 404);

  const ok = await api('PATCH', `/content/pages/${PAGE}/revisions/${target.id}`, { pinned: true, label: 'Meilenstein' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.revision.pinned, 1);
  assert.equal(ok.json.revision.label, 'Meilenstein');
  assert.equal(ok.json.revision.body_html, undefined);
});

test('Liste: pinned nur ohne Cursor, older am Fensterrand', async () => {
  const first = await api('GET', `/content/pages/${PAGE}/revisions?limit=1`);
  assert.equal(first.status, 200);
  assert.equal(first.json.has_more, true);
  assert.ok(first.json.older, 'older fehlt bei has_more');
  assert.deepEqual(first.json.pinned.map(r => r.label), ['Meilenstein']);

  const last = first.json.revisions[0];
  const next = await api('GET', `/content/pages/${PAGE}/revisions?before=${encodeURIComponent(last.created_at)}&before_id=${last.id}`);
  assert.equal(next.json.pinned, undefined);
  assert.equal(next.json.revisions[0].id, first.json.older.id, 'older = erste Zeile der Folgeseite');
});

test('Detail: prev + aktive Inhalte entfernt', async () => {
  const id = db.prepare(`INSERT INTO page_revisions (page_id, book_id, body_html, source, created_at)
                         VALUES (?, ?, ?, 'main', ?)`).run(PAGE, BOOK, '<p onclick="alert(1)">Alt<script>x()</script></p>', '2026-06-01T00:00:00.000Z').lastInsertRowid;
  const r = await api('GET', `/content/pages/${PAGE}/revisions/${id}`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.json.revision.body_html, /onclick|<script/);
  assert.match(r.json.revision.body_html, /Alt/);
  assert.ok(r.json.prev?.id, 'prev fehlt');
  assert.equal(r.json.prev.body_html, undefined);

  const oldest = revRows()[0];
  const o = await api('GET', `/content/pages/${PAGE}/revisions/${oldest.id}`);
  assert.equal(o.json.prev, null);
});

test('Retention: angeheftete Revision ueberlebt pruneTiered', () => {
  const pinned = revRows().find(r => r.pinned);
  db.prepare('UPDATE page_revisions SET created_at = ? WHERE id = ?').run('2024-01-02T00:00:00.000Z', pinned.id);
  require('../../db/page-revisions').pruneTiered({ floor: 1 });
  assert.ok(revRows().some(r => r.id === pinned.id));
});
