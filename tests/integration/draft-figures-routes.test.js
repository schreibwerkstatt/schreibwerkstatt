'use strict';
// Integration: CRUD-Routen der Figuren-Werkstatt (routes/draft-figures.js) über
// HTTP — Zugriffs-Vorspann, Konfliktschutz, Validierung, Import-Dedupe, Bogen.
//  - Lesewege mit Buchinhalt verlangen die Buch-ACL (viewer): nach Entzug des
//    Buchs liefert Fundstellen/Lauf/Draft 403 NO_BOOK_ACCESS.
//  - Kein eigener 401 im Vorspann: ohne Session kommt der eine Code des Guards
//    (NOT_LOGGED_IN), nicht ein zweiter (LOGIN_REQ).
//  - PUT mit expectedUpdatedAt: veralteter Stand → 409 DRAFT_CONFLICT + current.
//  - _validateMindmap prüft den ganzen Baum (Topic-Typ, Tiefe, doppelte ids).
//  - Import: die gleichnamige Merge-Kollision einer importierten Figur ist
//    weder im Picker noch per POST ein zweites Mal importierbar.
//  - Bogen: ein seit der letzten Verankerung geänderter Draft meldet keine
//    Null-Befunde über ungesuchte Kerne; ein Lauf ohne Treffer gilt als verankert.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'autor@test.dev';
const COLLAB = 'mitarbeit@test.dev';
const BOOK = 9631;

let ctx; let db; let server; let baseUrl; let draftDb; let occDb; let access;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  draftDb = require('../../db/draft-figures');
  occDb = require('../../db/draft-figure-occurrences');
  access = require('../../db/book-access');
  const NOW = new Date().toISOString();
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Werkstattbuch', ?, ?)").run(BOOK, NOW, NOW);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, slug, position, updated_at) VALUES (?,?,?,?,?,?)')
    .run(96310, BOOK, 'Kapitel A', 'kap-a', 0, NOW);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, slug, position, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(963100, BOOK, 96310, 'Seite 1', 's1', 0, NOW);
  access.grantAccess(BOOK, OWNER, 'editor', OWNER);

  const app = express();
  // Session nur mit x-user — so laesst sich der anonyme Fall pruefen.
  app.use((req, _res, next) => {
    const u = req.get('x-user');
    req.session = u ? { user: { email: u } } : {};
    next();
  });
  app.use('/draft-figures', require('../../routes/draft-figures').router);
  app.use((err, _req, res, _next) => { res.status(500).json({ error_code: 'INTERNAL', message: err.message }); });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function call(method, path, body, user = OWNER) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['x-user'] = user;
  const res = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

function mm(name, children = []) {
  return { meta: {}, format: 'node_tree', data: { id: 'root', topic: name, children } };
}

function insertFigure(name, figId) {
  return db.prepare(`
    INSERT INTO figures (book_id, fig_id, name, typ, beschreibung, sort_order, user_email, updated_at)
    VALUES (?, ?, ?, 'Nebenfigur', ?, 0, ?, ?)
  `).run(BOOK, figId, name, `Beschreibung ${figId}`, OWNER, new Date().toISOString()).lastInsertRowid;
}

test('Ohne Session: der Guard antwortet 401 NOT_LOGGED_IN (kein LOGIN_REQ)', async () => {
  const d = draftDb.createDraftFigure(BOOK, OWNER, { name: 'Anon', mindmap: mm('Anon') });
  for (const [method, path] of [
    ['GET', `/draft-figures/by-id/${d.id}`],
    ['PUT', `/draft-figures/${d.id}`],
    ['DELETE', `/draft-figures/${d.id}`],
  ]) {
    const r = await call(method, path, method === 'PUT' ? { name: 'X' } : null, null);
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.body.error_code, 'NOT_LOGGED_IN');
  }
});

test('Buch entzogen: Lesewege mit Buchinhalt liefern 403, fremde Drafts bleiben 403', async () => {
  access.grantAccess(BOOK, COLLAB, 'editor', OWNER);
  const d = draftDb.createDraftFigure(BOOK, COLLAB, { name: 'Gast', mindmap: mm('Gast') });
  const runId = draftDb.insertWerkstattRun({
    draftId: d.id, bookId: BOOK, userEmail: COLLAB, kind: 'consistency',
    result: { konflikte: [], fazit: 'ok', textbelege: [{ page_id: 963100, snippet: 'Buchtext' }] },
  });
  occDb.replaceKernOccurrences(d.id, BOOK, 'want', [
    { kind: 'page', pageId: 963100, score: 0.9, snippet: 'Buchtext', source: 'semantic' },
  ]);

  // Mit Zugriff: lesbar.
  assert.equal((await call('GET', `/draft-figures/by-id/${d.id}/occurrences`, null, COLLAB)).status, 200);
  // Der Buch-Owner sieht den fremden Draft trotzdem nicht (Besitz-Achse).
  const foreign = await call('GET', `/draft-figures/by-id/${d.id}`, null, OWNER);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error_code, 'FORBIDDEN');

  access.revokeAccess(BOOK, COLLAB);
  for (const path of [
    `/draft-figures/by-id/${d.id}`,
    `/draft-figures/by-id/${d.id}/occurrences`,
    `/draft-figures/by-id/${d.id}/runs`,
    `/draft-figures/runs/${runId}`,
  ]) {
    const r = await call('GET', path, null, COLLAB);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error_code, 'NO_BOOK_ACCESS', path);
  }
});

test('PUT mit veraltetem expectedUpdatedAt → 409 DRAFT_CONFLICT, nichts geschrieben', async () => {
  const d = draftDb.createDraftFigure(BOOK, OWNER, { name: 'Konflikt', mindmap: mm('Konflikt') });
  const first = await call('PUT', `/draft-figures/${d.id}`, { notes: 'Tab A', expectedUpdatedAt: d.updated_at });
  assert.equal(first.status, 200);
  assert.equal(first.body.notes, 'Tab A');

  // Zweiter Tab editiert noch auf dem alten Stand.
  const stale = await call('PUT', `/draft-figures/${d.id}`, { notes: 'Tab B', expectedUpdatedAt: d.updated_at });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error_code, 'DRAFT_CONFLICT');
  assert.equal(stale.body.current.notes, 'Tab A');
  assert.equal(draftDb.getDraftFigure(d.id).notes, 'Tab A');

  // Ohne das Feld (Fremd-Client): Last-Write-Wins bleibt.
  const blind = await call('PUT', `/draft-figures/${d.id}`, { notes: 'Fremd' });
  assert.equal(blind.status, 200);
});

test('Mindmap-Validierung prüft den ganzen Baum', async () => {
  const d = draftDb.createDraftFigure(BOOK, OWNER, { name: 'Valid', mindmap: mm('Valid') });
  let deep = { id: 'leaf', topic: 'x' };
  for (let i = 0; i < 80; i++) deep = { id: `n${i}`, topic: 't', children: [deep] };
  const bad = [
    mm('Valid', [{ id: 'a', topic: 42 }]),                          // Zahl-Topic
    mm('Valid', [{ id: 'a', topic: 'A' }, { id: 'a', topic: 'B' }]), // doppelte id
    mm('Valid', [{ topic: 'ohne id' }]),                             // fehlende id
    mm('Valid', [{ id: 'a', topic: 'A', children: 'kein Array' }]),  // children kein Array
    mm('Valid', [deep]),                                             // zu tief
  ];
  for (const mindmap of bad) {
    const r = await call('PUT', `/draft-figures/${d.id}`, { mindmap });
    assert.equal(r.status, 400, JSON.stringify(mindmap).slice(0, 80));
    assert.equal(r.body.error_code, 'MINDMAP_INVALID');
  }
  const ok = await call('PUT', `/draft-figures/${d.id}`, { mindmap: mm('Valid', [{ id: 'a', topic: 'A', children: [] }]) });
  assert.equal(ok.status, 200);
});

test('Import: gleichnamige Merge-Kollision einer importierten Figur ist kein zweiter Draft', async () => {
  const rich = insertFigure('Lena', 'fig_lena');
  const twin = insertFigure('Lena', 'fig_lena__2');
  // Picker bietet genau eine Lena an.
  let picker = (await call('GET', `/draft-figures/${BOOK}/importable`)).body;
  assert.equal(picker.filter(f => f.name === 'Lena').length, 1);
  const offered = picker.find(f => f.name === 'Lena').id;

  const imp = await call('POST', `/draft-figures/${BOOK}/import`, { figureId: offered });
  assert.equal(imp.status, 200);

  // Danach rückt die Schwester NICHT nach …
  picker = (await call('GET', `/draft-figures/${BOOK}/importable`)).body;
  assert.equal(picker.filter(f => f.name === 'Lena').length, 0);
  // … und auch ein direkter POST auf sie landet beim bestehenden Draft.
  const other = offered === rich ? twin : rich;
  const dup = await call('POST', `/draft-figures/${BOOK}/import`, { figureId: other });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error_code, 'ALREADY_IMPORTED');
  assert.equal(dup.body.existingDraftId, imp.body.id);
  assert.equal(draftDb.listDraftFigures(BOOK, OWNER).filter(d => d.name === 'Lena').length, 1);
});

test('Bogen: geänderter Draft meldet keine Null-Befunde über ungesuchte Kerne', async () => {
  const B2 = 9632;
  const NOW = new Date().toISOString();
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Bogenbuch', ?, ?)").run(B2, NOW, NOW);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, slug, position, updated_at) VALUES (?,?,?,?,?,?)')
    .run(96320, B2, 'Kap', 'kap', 0, NOW);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, slug, position, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(963200, B2, 96320, 'S', 's', 0, NOW);
  access.grantAccess(B2, OWNER, 'editor', OWNER);
  const subtext = (kids) => mm('Mara', [{ id: 'subtext', topic: '__i18n:werkstatt.tree.subtext__', children: kids }]);
  const d = draftDb.createDraftFigure(B2, OWNER, {
    name: 'Mara',
    mindmap: subtext([{ id: 'want', topic: '__i18n:werkstatt.tree.want__', children: [{ id: 'w1', topic: 'will Anerkennung' }] }]),
  });

  // Nie verankert → ungeprüft.
  let arc = (await call('GET', `/draft-figures/${B2}/arc`)).body;
  assert.equal(arc.scanned, false);

  // Verankert: want hat eine Fundstelle.
  occDb.replaceKernOccurrences(d.id, B2, 'want', [
    { kind: 'page', pageId: 963200, score: 0.9, snippet: 's', source: 'semantic' },
  ]);
  // Danach plant die Autorin `lie` — der Lauf hat danach nie gesucht.
  await new Promise(r => setTimeout(r, 5));
  draftDb.updateDraftFigure(d.id, {
    name: 'Mara',
    mindmap: subtext([
      { id: 'want', topic: '__i18n:werkstatt.tree.want__', children: [{ id: 'w1', topic: 'will Anerkennung' }] },
      { id: 'lie', topic: '__i18n:werkstatt.tree.lie__', children: [{ id: 'l1', topic: 'nur Leistung zählt' }] },
    ]),
  });
  arc = (await call('GET', `/draft-figures/${B2}/arc`)).body;
  assert.equal(arc.scanned, true);
  const row = arc.drafts.find(x => x.id === d.id);
  assert.equal(row.geplant.lie, true);
  assert.equal(row.anchorStale, true);
  assert.equal(arc.befunde.filter(b => b.draft_id === d.id && b.code === 'kernOhneText').length, 0);
  assert.equal(arc.stale, true);
});

test('Anchor-Stand: erfolgreicher Lauf ohne Treffer zählt als verankert', () => {
  const B3 = 9633;
  const NOW = new Date().toISOString();
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Leerbuch', ?, ?)").run(B3, NOW, NOW);
  const d = draftDb.createDraftFigure(B3, OWNER, { name: 'Leer', mindmap: mm('Leer') });
  assert.equal(occDb.figurAnchorState(B3, OWNER).lastRunMs, null);
  assert.equal(occDb.draftAnchorStale(B3, OWNER), true);

  const later = new Date(Date.now() + 60_000).toISOString();
  db.prepare(`
    INSERT INTO job_runs (job_id, type, book_id, user_email, label, status, queued_at, started_at)
    VALUES (?, 'figur-anchor', ?, ?, 'job.label.figurAnchor', 'done', ?, ?)
  `).run('anchor-test-1', B3, OWNER, later, later);
  const st = occDb.figurAnchorState(B3, OWNER);
  assert.equal(st.hasOccurrences, false);
  assert.ok(st.lastJobRunMs != null);
  assert.equal(occDb.draftAnchorStale(B3, OWNER), false);
  assert.equal(occDb.draftChangedSinceAnchor(d, st.lastRunMs), false);
});
