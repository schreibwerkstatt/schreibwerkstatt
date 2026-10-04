'use strict';
// Integration: Plot-Werkstatt-Routen (routes/plot.js) — Validierung + Struktur-
// Integrität über HTTP:
//  - POST/PATCH /plot/beats: INVALID_INTENSITAET / INVALID_STATUS / INVALID_FLAG,
//    Antwort trägt occ_count + occ_top wie GET /plot
//  - PATCH /plot/acts: archiviert nur true/false/0/1
//  - POST /plot/acts mit thread_id: nur für geforkte Stränge (THREAD_NOT_FORKED)
//  - PUT /plot/beats/order + /plot/acts/order: 400 mit error_code, nichts geschrieben
//  - Strang-Figurenbindung exklusiv (THREAD_FIGURE_CONFLICT, gegenseitiges Leeren)
//  - GET /plot/time-check: Chronologie pro Lane, geerbte Strang-Hauptfigur
//  - GET /plot/links: Gegenrichtung je Achse, pro (Buch, User), Reader 403

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'autor@test.dev';
const OTHER = 'eindringling@test.dev';
const BOOK = 9521;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl; let plotDb;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  plotDb = require('../../db/plot');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Plotbuch', ?, ?)").run(BOOK, NOW, NOW);
  const access = require('../../db/book-access');
  access.grantAccess(BOOK, OWNER, 'editor', OWNER);
  access.grantAccess(BOOK, OTHER, 'editor', OWNER);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.get('x-user') || OWNER } }; next(); });
  app.use('/plot', require('../../routes/plot'));
  app.use((err, _req, res, _next) => { res.status(500).json({ error_code: 'INTERNAL', message: err.message }); });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function call(method, path, body, user = OWNER) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('GET /plot: beatAnchor.ranAt ist null, solange nie verankert wurde', async () => {
  const r = await call('GET', `/plot?book_id=${BOOK}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.beatAnchor.ranAt, null);
});

test('POST /beats: Validierung + Anker-Felder in der Antwort', async () => {
  const act = (await call('POST', '/plot/acts', { book_id: BOOK, name: 'Akt V' })).body;
  for (const [patch, code] of [
    [{ intensitaet: 7 }, 'INVALID_INTENSITAET'],
    [{ intensitaet: 'x' }, 'INVALID_INTENSITAET'],
    [{ intensitaet: 2.5 }, 'INVALID_INTENSITAET'],
    [{ status: 'fertig' }, 'INVALID_STATUS'],
    [{ verworfen: 'false' }, 'INVALID_FLAG'],
  ]) {
    const r = await call('POST', '/plot/beats', { book_id: BOOK, act_id: act.id, titel: 'X', ...patch });
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.body.error_code, code);
  }
  const ok = await call('POST', '/plot/beats', { book_id: BOOK, act_id: act.id, titel: 'Gut', intensitaet: '3', verworfen: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.intensitaet, 3);
  assert.equal(ok.body.occ_count, 0);
  assert.deepEqual(ok.body.occ_top, []);
});

test('PATCH /beats: Validierung, Antwort mit occ_count/occ_top aus dem Ist-Index', async () => {
  const act = (await call('POST', '/plot/acts', { book_id: BOOK, name: 'Akt P' })).body;
  const beat = (await call('POST', '/plot/beats', { book_id: BOOK, act_id: act.id, titel: 'P', status: 'im_buch' })).body;
  assert.equal((await call('PATCH', `/plot/beats/${beat.id}`, { intensitaet: 0 })).body.error_code, 'INVALID_INTENSITAET');
  assert.equal((await call('PATCH', `/plot/beats/${beat.id}`, { verworfen: 'ja' })).body.error_code, 'INVALID_FLAG');
  assert.equal((await call('PATCH', `/plot/beats/${beat.id}`, { status: 'x' })).body.error_code, 'INVALID_STATUS');
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (952101, ?, 'Seite P', ?)").run(BOOK, NOW);
  plotDb.replaceBeatOccurrences(beat.id, BOOK, [{ kind: 'page', pageId: 952101, score: 0.7, snippet: 'da', source: 'semantic' }]);
  const r = await call('PATCH', `/plot/beats/${beat.id}`, { intensitaet: null, verworfen: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.occ_count, 1);
  assert.equal(r.body.occ_top[0].page_id, 952101);
});

test('GET /plot: beatAnchor.ranAt nach einer Verankerung gesetzt', async () => {
  const r = await call('GET', `/plot?book_id=${BOOK}`);
  assert.match(String(r.body.beatAnchor.ranAt), /^\d{4}-\d{2}-\d{2}T/);
});

test('PATCH /acts: archiviert nur als Flag', async () => {
  const act = (await call('POST', '/plot/acts', { book_id: BOOK, name: 'Akt A' })).body;
  assert.equal((await call('PATCH', `/plot/acts/${act.id}`, { archiviert: 'true' })).body.error_code, 'INVALID_FLAG');
  const ok = await call('PATCH', `/plot/acts/${act.id}`, { archiviert: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.archiviert, 1);
});

test('POST /acts mit thread_id nur für geforkte Stränge; Reorder-Fehler als 400', async () => {
  const B = BOOK;
  const shared = (await call('POST', '/plot/acts', { book_id: B, name: 'Geteilt F' })).body;
  const thread = (await call('POST', '/plot/threads', { book_id: B, name: 'Strang F' })).body;
  const r1 = await call('POST', '/plot/acts', { book_id: B, name: 'Eigen', thread_id: thread.id });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error_code, 'THREAD_NOT_FORKED');
  const beat = (await call('POST', '/plot/beats', { book_id: B, act_id: shared.id, thread_id: thread.id, titel: 'F' })).body;
  assert.equal((await call('POST', `/plot/threads/${thread.id}/fork-acts`)).status, 200);
  const own = (await call('POST', '/plot/acts', { book_id: B, name: 'Eigen 2', thread_id: thread.id }));
  assert.equal(own.status, 200);
  assert.equal(own.body.thread_id, thread.id);

  // Strang-Beat auf geteilten Akt zurückziehen: Strang ist geforkt → verboten.
  const before = plotDb.getBeat(beat.id);
  const m = await call('PUT', '/plot/beats/order', { book_id: B, order: [{ actId: shared.id, threadId: thread.id, beatIds: [beat.id] }] });
  assert.equal(m.status, 400);
  assert.equal(m.body.error_code, 'ACT_THREAD_MISMATCH');
  assert.equal(plotDb.getBeat(beat.id).act_id, before.act_id);

  const foreignAct = (await call('POST', '/plot/acts', { book_id: B, name: 'Fremd' }, OTHER)).body;
  const f = await call('PUT', '/plot/beats/order', { book_id: B, order: [{ actId: foreignAct.id, beatIds: [beat.id] }] });
  assert.equal(f.body.error_code, 'ACT_MISMATCH');
  const g = await call('PUT', '/plot/beats/order', { book_id: B, order: ['quatsch'] });
  assert.equal(g.body.error_code, 'ORDER_INVALID');

  const mixed = await call('PUT', '/plot/acts/order', { book_id: B, order: [shared.id, own.body.id] });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.error_code, 'ACT_SCOPE_MIXED');
});

test('Strang-Figurenbindung exklusiv', async () => {
  db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at) VALUES (?, ?, 'fig_ex', 'Ex', 'Ex', ?)`).run(BOOK, OWNER, NOW);
  const draft = require('../../db/draft-figures').createDraftFigure(BOOK, OWNER, { name: 'Werk', mindmap: {} });
  const both = await call('POST', '/plot/threads', { book_id: BOOK, name: 'Beide', figure_id: 'fig_ex', draft_figure_id: draft.id });
  assert.equal(both.status, 400);
  assert.equal(both.body.error_code, 'THREAD_FIGURE_CONFLICT');
  const t = (await call('POST', '/plot/threads', { book_id: BOOK, name: 'Werkstatt', draft_figure_id: draft.id })).body;
  assert.equal(t.draft_figure_id, draft.id);
  const p = (await call('PATCH', `/plot/threads/${t.id}`, { figure_id: 'fig_ex' })).body;
  assert.equal(p.fig_id, 'fig_ex');
  assert.equal(p.draft_figure_id, null);
  const back = (await call('PATCH', `/plot/threads/${t.id}`, { draft_figure_id: draft.id })).body;
  assert.equal(back.draft_figure_id, draft.id);
  assert.equal(back.figure_id, null);
});

test('GET /time-check: Chronologie pro Lane + geerbte Strang-Hauptfigur', async () => {
  const B = 9522;
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Zeitbuch', ?, ?)").run(B, NOW, NOW);
  require('../../db/book-access').grantAccess(B, OWNER, 'editor', OWNER);
  require('../../db/book-settings').saveBookSettings(B, 'de', 'CH', null, null, null, null, 0, 0, null, 0, null, null, null, null, 1);
  db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, geburtstag, updated_at) VALUES (?, ?, 'fig_mara', 'Mara', 'Mara', '1979', ?)`).run(B, OWNER, NOW);
  const act = (await call('POST', '/plot/acts', { book_id: B, name: 'Akt Z' })).body;
  const tA = (await call('POST', '/plot/threads', { book_id: B, name: 'A', figure_id: 'fig_mara' })).body;
  const tB = (await call('POST', '/plot/threads', { book_id: B, name: 'B' })).body;
  // Lane A spielt 1987, Lane B 1950 → kein Bruch (parallel). Lane A: Mara erbt.
  await call('POST', '/plot/beats', { book_id: B, act_id: act.id, thread_id: tA.id, titel: 'A1', zeit: '1987' });
  await call('POST', '/plot/beats', { book_id: B, act_id: act.id, thread_id: tB.id, titel: 'B1', zeit: '1950' });
  await call('POST', '/plot/beats', { book_id: B, act_id: act.id, thread_id: tA.id, titel: 'A2', zeit: '1975' });
  const r = await call('GET', `/plot/time-check?book_id=${B}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.scanned, true);
  const codes = r.body.befunde.map(f => `${f.code}:${f.beat}`).sort();
  // A2 (1975) liegt vor A1 (1987) in derselben Lane → Bruch; B1 (1950) nicht.
  // A2 spielt vor Maras Geburt (1979) — Mara ist nur über den Strang beteiligt.
  assert.ok(codes.includes('chronologieBruch:A2'), codes.join(','));
  assert.ok(!codes.some(c => c.endsWith(':B1') && c.startsWith('chronologieBruch')), codes.join(','));
  assert.ok(codes.includes('beatVorGeburt:A2'), codes.join(','));
  assert.ok(codes.includes('figurKindImBeat:A1'), codes.join(','));
});

test('GET /links: Gegenrichtung je Achse, unbekannte Achse 400, Reader 403', async () => {
  const locId = db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, 'loc_links', 'Bahnhof', ?, ?)`)
    .run(BOOK, OWNER, NOW).lastInsertRowid;
  const act = plotDb.createAct(BOOK, OWNER, { name: 'Links-Akt' });
  plotDb.createBeat(BOOK, act.id, OWNER, { titel: 'Am Gleis', locationIds: [locId] });

  const r = await call('GET', `/plot/links?book_id=${BOOK}&kind=location`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.links.loc_links.map(b => b.titel), ['Am Gleis']);
  // Pro (Buch, User): ein anderer Editor sieht die Beats des Autors nicht.
  const fremd = await call('GET', `/plot/links?book_id=${BOOK}&kind=location`, null, OTHER);
  assert.deepEqual(fremd.body.links, {});

  assert.equal((await call('GET', `/plot/links?book_id=${BOOK}&kind=kapitel`)).body.error_code, 'KIND_INVALID');

  const READER = 'leser@test.dev'; // viewer: nur lesen — das Board ist Editor+
  require('../../db/app-users').createUser({ email: READER, displayName: 'Leser' });
  require('../../db/book-access').grantAccess(BOOK, READER, 'viewer', OWNER);
  assert.equal((await call('GET', `/plot/links?book_id=${BOOK}&kind=figure`, null, READER)).status, 403);
});
