'use strict';
// Integration: Routen der Motiv-Werkstatt (routes/motifs.js) über HTTP.
//
// Festgehalten wird, was die reinen Unit-Tests nicht sehen:
//   * Rollen der Lesungen: wer einen Lauf starten bzw. den Graph lesen darf,
//     darf auch das Detail dahinter öffnen (Lauf-Detail, Fundstellen).
//   * PUT /:id/links schreibt alle Brücken in einer Transaktion.
//   * /figure-usage nennt unter dem Score-Floor dieselben Zahlen wie der Graph und
//     verschweigt die Belegzahl, solange nie gescannt wurde.
//   * /consistency liest den ganzen Kapitelbaum: ein Soll auf dem Oberkapitel deckt
//     Fundstellen im Unterkapitel.
//   * Farben werden nur als Palette-Schlüssel gespeichert.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'mr-owner@test.dev';
const LEKTOR = 'mr-lektor@test.dev';
const BOOK = 7401;

let ctx; let server; let baseUrl; let motifsDb; let db;

test.before(async () => {
  ctx = bootstrap();
  ({ db } = require('../../db/schema'));
  const appUsers = require('../../db/app-users');
  const bookAccess = require('../../db/book-access');
  motifsDb = require('../../db/motifs');
  for (const email of [OWNER, LEKTOR]) if (!appUsers.getUser(email)) appUsers.createUser({ email });
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Motive' }],
    chapters: [
      { id: 74010, book_id: BOOK, name: 'Teil 1' },
      { id: 74011, book_id: BOOK, name: '1.1' },
      { id: 74020, book_id: BOOK, name: 'Teil 2' },
    ],
    pages: [
      { id: 74111, book_id: BOOK, name: 'P1', chapter_id: 74011 },
      { id: 74121, book_id: BOOK, name: 'P2', chapter_id: 74020 },
    ],
  });
  db.prepare('UPDATE chapters SET parent_chapter_id = 74010 WHERE chapter_id = 74011').run();
  db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?').run(OWNER, BOOK);
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
  bookAccess.grantAccess(BOOK, LEKTOR, 'lektor', OWNER);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/motifs', require('../../routes/motifs'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function call(method, path, user, body) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('Lektor öffnet eigenen Konsistenz-Lauf und eigene Fundstellen (keine editor-Pflicht beim Lesen)', async () => {
  const runId = motifsDb.insertConsistencyRun({ bookId: BOOK, userEmail: LEKTOR, result: { konflikte: [], fazit: 'ok' } });
  const run = await call('GET', `/motifs/consistency-runs/${runId}`, LEKTOR);
  assert.equal(run.status, 200);
  const m = motifsDb.createMotif(BOOK, LEKTOR, { name: 'Lektor-Motiv' });
  const occ = await call('GET', `/motifs/${m.id}/occurrences`, LEKTOR);
  assert.equal(occ.status, 200);
  // Schreiben bleibt editor.
  const del = await call('DELETE', `/motifs/consistency-runs/${runId}`, LEKTOR);
  assert.equal(del.status, 403);
});

test('PUT /:id/links setzt mehrere Brücken; fremde IDs fallen weg', async () => {
  const m = motifsDb.createMotif(BOOK, OWNER, { name: 'Brücke' });
  const r = await call('PUT', `/motifs/${m.id}/links`, OWNER, { chapters: [74010, 999999], pages: [74121] });
  assert.equal(r.status, 200);
  const g = motifsDb.getGraph(BOOK, OWNER, 0).motifs.find(x => x.id === m.id);
  assert.deepEqual(g.chapters.map(c => c.id), [74010]);
  assert.deepEqual(g.pages.map(p => p.id), [74121]);
});

test('Farbe: nur Palette-Schlüssel, alles andere wird null', async () => {
  const ok = await call('POST', '/motifs/themes', OWNER, { book_id: BOOK, name: 'T1', farbe: 'wine' });
  assert.equal(ok.json.farbe, 'wine');
  const bad = await call('POST', '/motifs/themes', OWNER, { book_id: BOOK, name: 'T2', farbe: 'red;background:url(x)' });
  assert.equal(bad.json.farbe, null);
});

test('figure-usage: ungescannt ohne Belegzahl, danach unter dem Score-Floor', async () => {
  const BOOK2 = 7402;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK2, name: 'Figuren' }],
    pages: [{ id: 74211, book_id: BOOK2, name: 'P' }],
  });
  require('../../db/book-access').grantAccess(BOOK2, OWNER, 'owner', OWNER);
  const { createDraftFigure } = require('../../db/draft-figures');
  const draft = createDraftFigure(BOOK2, OWNER, { name: 'Anna', mindmap: {} });
  const draftId = draft.id ?? draft;
  const m = motifsDb.createMotif(BOOK2, OWNER, { name: 'Spiegel' });
  motifsDb.setMotifDraftFigures(m.id, [draftId]);

  const before = await call('GET', `/motifs/figure-usage?book_id=${BOOK2}&draft_id=${draftId}`, OWNER);
  assert.equal(before.status, 200);
  assert.equal(before.json.motifCount, 1);
  assert.equal(before.json.scanned, false);
  assert.equal(before.json.belegteCount, null);
  assert.equal(before.json.motifs[0].occurrenceCount, undefined);

  // Ein schwacher semantischer Treffer unter dem Default-Floor (0.45) zählt nicht.
  motifsDb.replaceOccurrences(m.id, BOOK2, [
    { kind: 'page', pageId: 74211, score: 0.1, snippet: 'schwach', source: 'semantic' },
  ]);
  const after = await call('GET', `/motifs/figure-usage?book_id=${BOOK2}&draft_id=${draftId}`, OWNER);
  assert.equal(after.json.scanned, true);
  assert.equal(after.json.motifs[0].occurrenceCount, 0);
  assert.equal(after.json.belegteCount, 0);
});

test('/consistency: Soll auf Oberkapitel deckt Fundstelle im Unterkapitel', async () => {
  const m = motifsDb.createMotif(BOOK, OWNER, { name: 'Wasser' });
  motifsDb.setMotifChapters(m.id, [74010]);
  motifsDb.replaceOccurrences(m.id, BOOK, [
    { kind: 'page', pageId: 74111, score: null, snippet: 'Regen', source: 'trigger' },
  ]);
  const r = await call('GET', `/motifs/consistency?book_id=${BOOK}`, OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.json.scanned, true);
  const own = r.json.befunde.filter(f => f.motiv_id === m.id);
  assert.deepEqual(own.map(f => f.code), [], 'kein sollIstDivergenz — 1.1 liegt unter Teil 1');

  // Gegenprobe: Soll auf Teil 2, Fund in 1.1 → Divergenz.
  motifsDb.setMotifChapters(m.id, [74020]);
  const r2 = await call('GET', `/motifs/consistency?book_id=${BOOK}`, OWNER);
  assert.ok(r2.json.befunde.some(f => f.motiv_id === m.id && f.code === 'sollIstDivergenz'));
});

test('Lektorat-Kontext: Soll auf Oberkapitel gilt im Abschnitt des Unterkapitels', () => {
  const m = motifsDb.createMotif(BOOK, OWNER, { name: 'Glocke' });
  motifsDb.setMotifChapters(m.id, [74010]);
  const names = motifsDb.getPageMotifs(BOOK, 74011, 74111, OWNER).map(x => x.name);
  assert.ok(names.includes('Glocke'));
  // Fremder Ast (Teil 2) erbt nichts.
  assert.ok(!motifsDb.getPageMotifs(BOOK, 74020, 74121, OWNER).map(x => x.name).includes('Glocke'));
});
