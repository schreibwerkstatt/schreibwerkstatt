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
  // Ein Kind im Beat ist kein Befund mehr (Alter steht an der Karte).
  assert.ok(!codes.some(c => c.startsWith('figurKindImBeat')), codes.join(','));
});

test('Zeitfenster im Payload + figurAnZweiOrten über die Route (Orts-Hierarchie buchweit)', async () => {
  const B = 9523;
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Ortsbuch', ?, ?)").run(B, NOW, NOW);
  require('../../db/book-access').grantAccess(B, OWNER, 'editor', OWNER);
  db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at) VALUES (?, ?, 'fig_jo', 'Jo', 'Jo', ?)`).run(B, OWNER, NOW);
  const zh = db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, 'zh', 'Zürich', ?, ?)`).run(B, OWNER, NOW).lastInsertRowid;
  db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, updated_at, parent_id) VALUES (?, 'alt', 'Altstadt', ?, ?, ?)`).run(B, OWNER, NOW, zh);
  db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, 'be', 'Berlin', ?, ?)`).run(B, OWNER, NOW);
  const act = (await call('POST', '/plot/acts', { book_id: B, name: 'Akt O' })).body;
  const mk = (titel, zeit, loc) => call('POST', '/plot/beats', {
    book_id: B, act_id: act.id, titel, zeit, figure_ids: ['fig_jo'], location_ids: [loc],
  });
  const first = (await mk('Zürich', '12.03.1987', 'zh')).body;
  assert.equal(first.zeit_key.precision, 'day');
  assert.equal(first.zeit_key.mode, 'abs');
  await mk('Altstadt', '12. März 1987', 'alt');   // liegt in Zürich → verträglich
  let r = await call('GET', `/plot/time-check?book_id=${B}`);
  assert.deepEqual(r.body.befunde.filter(f => f.code === 'figurAnZweiOrten'), []);
  await mk('Berlin', '12.03.1987', 'be');
  r = await call('GET', `/plot/time-check?book_id=${B}`);
  const orte = r.body.befunde.filter(f => f.code === 'figurAnZweiOrten').map(f => f.beat);
  assert.deepEqual(orte, ['Berlin', 'Berlin'], 'Berlin kollidiert mit Zürich und mit der Altstadt');
  const board = (await call('GET', `/plot/?book_id=${B}`)).body;
  assert.ok(board.beats.every(b => b.zeit_key && b.zeit_key.precision === 'day'));
});

test('GET /zeit-vorschlaege: aus dem Text der besten Fundstelle, nur Beats im Buch; Akt-Spanne im Board', async () => {
  const B = 9524;
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Vorschlagsbuch', ?, ?)").run(B, NOW, NOW);
  require('../../db/book-access').grantAccess(B, OWNER, 'editor', OWNER);
  db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, geburtstag, updated_at) VALUES (?, ?, 'fig_st', 'Stefan Meier', 'Stefan', '12. März 1968', ?)`).run(B, OWNER, NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (952401, ?, 'Das nächste Drama', ?)").run(B, NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (952402, ?, 'Der erste Kuss', ?)").run(B, NOW);
  const ev = (page, year, ereignis, extra = {}) => {
    const id = db.prepare(`INSERT INTO zeitstrahl_events (book_id, user_email, datum, datum_year, ereignis, typ, subtyp, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(B, OWNER, String(year), year, ereignis, extra.typ || 'persoenlich', extra.subtyp || 'sonstiges', extra.so || 0).lastInsertRowid;
    db.prepare('INSERT INTO zeitstrahl_event_pages (event_id, page_id, sort_order) VALUES (?, ?, 0)').run(id, page);
  };
  ev(952401, 1999, 'Renate ist schwanger', { so: 1 });
  ev(952401, 1968, 'Geburt von Stefan', { subtyp: 'geburt' });
  ev(952402, 1983, 'Der erste Kuss');
  const krise = (await call('POST', '/plot/acts', { book_id: B, name: 'Erwachsen (24-28)' })).body;
  const tSt = (await call('POST', '/plot/threads', { book_id: B, name: 'Stefan', figure_id: 'fig_st' })).body;
  const mk = (titel, extra = {}) => call('POST', '/plot/beats', { book_id: B, act_id: krise.id, thread_id: tSt.id, titel, status: 'im_buch', ...extra }).then(r => r.body);
  const ziel = await mk('Schwangerschaft');
  const geplant = await mk('Geplant', { status: 'geplant' });
  await mk('Mit Zeit', { zeit: '2001' });
  // Beste Fundstelle zählt (höchster Score), nicht die schwächere.
  plotDb.replaceBeatOccurrences(ziel.id, B, [
    { kind: 'page', pageId: 952402, score: 0.5, snippet: 'k', source: 'semantic' },
    { kind: 'page', pageId: 952401, score: 0.9, snippet: 'd', source: 'semantic' },
  ]);
  plotDb.replaceBeatOccurrences(geplant.id, B, [{ kind: 'page', pageId: 952401, score: 0.9, snippet: 'd', source: 'semantic' }]);

  const r = await call('GET', `/plot/zeit-vorschlaege?book_id=${B}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.vorschlaege, [{
    beat_id: ziel.id, zeit: '1999', page_id: 952401, page_name: 'Das nächste Drama', n: 1, spread: 0, eindeutig: true,
    belege: [{ datum: '1999', ereignis: 'Renate ist schwanger' }],
  }]);
  const board = (await call('GET', `/plot/?book_id=${B}`)).body;
  assert.deepEqual(board.geburtsjahre, { fig_st: 1968 });
  assert.deepEqual(board.acts.find(a => a.id === krise.id).alter, { von: 24, bis: 28 });

  // Übernommen meldet die Zeit-Messung den Widerspruch zum Akt: 1999 ist Stefan 31.
  await call('PATCH', `/plot/beats/${ziel.id}`, { zeit: '1999' });
  const tc = await call('GET', `/plot/time-check?book_id=${B}`);
  assert.deepEqual(tc.body.befunde.filter(f => f.code === 'alterAusserhalbAkt' && f.beat_id === ziel.id).map(f => f.params.alter), ['31']);

  const fremd = await call('GET', `/plot/zeit-vorschlaege?book_id=${B}`, null, OTHER);
  assert.equal(fremd.status, 403);
});

test('Geburtsjahr: Steckbrief, sonst Alters-Analyse — aber nie aus dem Zeitstrahl oder bei niedriger Konfidenz', async () => {
  const B = 9525;
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Altersbuch', ?, ?)").run(B, NOW, NOW);
  require('../../db/book-access').grantAccess(B, OWNER, 'editor', OWNER);
  const fig = (fid, name, geb) => db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, geburtstag, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(B, OWNER, fid, name, name, geb, NOW).lastInsertRowid;
  const age = (id, geb, quelle, konf) => db.prepare(`INSERT INTO figure_ages (figure_id, book_id, geburtsjahr, geburtsjahr_quelle, konfidenz) VALUES (?, ?, ?, ?, ?)`)
    .run(id, B, geb, quelle, konf);
  age(fig('fig_st', 'Stefan', '1968'), 1960, 'text', 0.9);   // Steckbrief gewinnt
  age(fig('fig_re', 'Renate', null), 1970, 'kuratiert', 0.7); // Steckbrief leer → Analyse
  age(fig('fig_ma', 'Manuel', null), 1988, 'text', 0.75);
  age(fig('fig_gi', 'Gisela', null), 1988, 'zeitstrahl', 0.75); // Zeitstrahl zählt nicht
  age(fig('fig_si', 'Silvia', null), 1975, 'text', 0.1);       // zu unsicher

  const board = (await call('GET', `/plot/?book_id=${B}`)).body;
  assert.deepEqual(board.geburtsjahre, { fig_st: 1968, fig_re: 1970, fig_ma: 1988 });
  assert.deepEqual([...board.geburtsjahrAusText].sort(), ['fig_ma', 'fig_re']);

  // Die Zeit-Messung rechnet mit demselben Jahr: Renate 1999 ist 29, kein Befund.
  const tRe = (await call('POST', '/plot/threads', { book_id: B, name: 'Renate', figure_id: 'fig_re' })).body;
  const akt = (await call('POST', '/plot/acts', { book_id: B, name: 'Akt' })).body;
  await call('POST', '/plot/beats', { book_id: B, act_id: akt.id, thread_id: tRe.id, titel: 'Vor Geburt', zeit: '1965' });
  const tc = await call('GET', `/plot/time-check?book_id=${B}`);
  assert.deepEqual(tc.body.befunde.filter(f => f.code === 'beatVorGeburt').map(f => f.params.geburtsjahr), [1970]);
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
