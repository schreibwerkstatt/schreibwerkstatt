'use strict';
// Integration: Exposé-Job (routes/jobs/expose.js) + Routen (routes/expose.js).
// Single-Pass mit Volltext, Multi-Pass über Inhaltsangaben (Cache + Abräumen),
// keine Doppelzeile bei unveränderter Eingabe, Figuren-IDs nur aus dem Katalog,
// Pflichtfelder, Buchtyp-Gate, Eckdaten nur als Rahmen, Autorfassung.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx, expose, server, port;
const USER = 'tester@test.dev';
const VIEWER = 'mitarbeit@test.dev';
const NOW = '2026-10-25T10:00:00.000Z';

test.before(async () => {
  ctx = bootstrap();
  expose = require('../../routes/jobs/expose');
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-user'] || USER } }; next(); });
  app.use('/expose', require('../../routes/expose'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
});
test.after(() => { server?.close(); ctx.cleanup(); });
test.beforeEach(() => { ctx.mockAi.reset(); ctx.dbSeed.reset(); });

const db = () => ctx.dbSchema.db;
const isSynopsis = (e) => e.schemaKeys.length === 1 && e.schemaKeys[0] === 'inhalt';
const isExpose = (e) => e.schemaKeys.includes('logline') && e.schemaKeys.includes('klappentext');

function romanResponse(figs = [{ fig_id: 'fig_1', text: 'Anna sucht ihren Bruder.' }]) {
  return { logline: 'Anna sucht.', kurzinhalt: 'Kurz.', synopse: 'Lang, mit Ende.', figuren: figs, klappentext: 'Lies mich.' };
}

function seed(bookId, { body = '<p>' + 'Anna ging weiter. '.repeat(60) + '</p>', pages = 1 } = {}) {
  const chapterId = bookId * 100;
  ctx.dbSeed.setBook({
    chapters: [{ id: chapterId, book_id: bookId, name: 'Kap 1' }],
    pages: Array.from({ length: pages }, (_, i) => ({ id: chapterId + 1 + i, book_id: bookId, chapter_id: chapterId, name: `S ${i + 1}`, updated_at: NOW })),
    pageBodies: Object.fromEntries(Array.from({ length: pages }, (_, i) => [chapterId + 1 + i, body])),
  });
  db().prepare(`INSERT INTO book_access (book_id, user_email, role) VALUES (?, ?, 'owner')`).run(bookId, USER);
  db().prepare(`INSERT INTO book_access (book_id, user_email, role) VALUES (?, ?, 'viewer')`).run(bookId, VIEWER);
  db().prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, typ, rolle, updated_at) VALUES (?, ?, 'fig_1', 'Anna', 'hauptfigur', 'Suchende', ?)`).run(bookId, USER, NOW);
  db().prepare(`INSERT INTO book_publication (book_id, author_name, zielgruppe, vergleichstitel, created_at, updated_at) VALUES (?, 'Autorin X', 'Familiensaga-Leser', 'Titel A – Autor B', ?, ?)`).run(bookId, NOW, NOW);
}

async function run(bookId) {
  const jobId = ctx.shared.createJob('expose', bookId, USER, 'job.label.expose');
  ctx.shared.enqueueJob(jobId, () => expose.runExposeJob(jobId, bookId, USER));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
}

const rows = (bookId) => db().prepare('SELECT * FROM book_exposes WHERE book_id = ? ORDER BY id').all(bookId);

test('Single-Pass: Volltext + Eckdaten als Rahmen, Figuren nur aus dem Katalog', async () => {
  seed(301);
  let seen = null;
  ctx.mockAi.on(isExpose, ({ prompt }) => { seen = prompt; return romanResponse([{ fig_id: 'fig_1', text: 'Anna.' }, { fig_id: 'fig_99', text: 'Erfunden.' }]); });
  const job = await run(301);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.basis, 'single');
  assert.match(seen, /<manuskript>/);
  assert.match(seen, /Autor: Autorin X/);
  assert.match(seen, /Zielgruppe \(Angabe des Autors\): Familiensaga-Leser/);
  assert.match(seen, /\[id=fig_1\] Anna/);
  const [r] = rows(301);
  const result = JSON.parse(r.result_json);
  assert.deepEqual(result.figuren, [{ fig_id: 'fig_1', text: 'Anna.' }]);
  const warn = JSON.parse(r.warnungen_json).map(w => w.key);
  assert.ok(warn.includes('expose.warn.figurenDropped'));
  assert.ok(warn.includes('expose.warn.unfertig'), 'Buch nicht fertig → Hinweis');
  // Nichts aus dem Exposé landet in book_publication.
  assert.equal(db().prepare('SELECT description FROM book_publication WHERE book_id = 301').get().description, null);
});

test('Unveränderte Eingabe: kein zweiter KI-Call, keine zweite Zeile', async () => {
  seed(302);
  let calls = 0;
  ctx.mockAi.on(isExpose, () => { calls++; return romanResponse(); });
  assert.equal((await run(302)).status, 'done');
  const second = await run(302);
  assert.equal(second.status, 'done');
  assert.equal(second.result.unchanged, true);
  assert.equal(calls, 1);
  assert.equal(rows(302).length, 1);
});

test('Pflichtfeld leer → Fehler, keine Zeile', async () => {
  seed(303);
  ctx.mockAi.on(isExpose, () => ({ ...romanResponse(), synopse: '  ' }));
  const job = await run(303);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.exposeIncomplete');
  assert.equal(rows(303).length, 0);
});

test('Multi-Pass: Inhaltsangaben je Kapitel, Cache trifft beim zweiten Lauf', async () => {
  // 3 Seiten × ~40K Zeichen → über SINGLE_PASS_LIMIT des Test-Budgets.
  seed(304, { body: '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>', pages: 3 });
  let syn = 0, exp = 0, lastPrompt = '';
  ctx.mockAi.on(isSynopsis, () => { syn++; return { inhalt: `Teil ${syn}: Anna reist.` }; });
  ctx.mockAi.on(isExpose, ({ prompt }) => { exp++; lastPrompt = prompt; return romanResponse(); });
  const job = await run(304);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.basis, 'multi');
  assert.ok(syn >= 2, 'mehrere Inhaltsangaben');
  assert.match(lastPrompt, /<inhaltsangaben>/);
  const cached = db().prepare('SELECT COUNT(*) AS n FROM expose_synopsis_cache WHERE book_id = 304').get().n;
  assert.equal(cached, syn);
  const synBefore = syn;
  await run(304);
  assert.equal(syn, synBefore, 'zweiter Lauf: alle Inhaltsangaben aus dem Cache');
  assert.equal(exp, 1, 'unveränderte Eingabe → kein neuer Exposé-Call');
});

test('Buchtyp ohne Exposé (Lyrik) → Fehler', async () => {
  seed(305);
  db().prepare(`INSERT INTO book_settings (book_id, language, region, updated_at, buchtyp) VALUES (305, 'de', 'CH', ?, 'lyrik')`).run(NOW);
  const job = await run(305);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.exposeBuchtyp');
});

test('Routen: lesen, Autorfassung (nur Wortlaut), zurücksetzen, viewer 403, löschen', async () => {
  seed(306);
  ctx.mockAi.on(isExpose, () => romanResponse());
  await run(306);
  const req = async (method, path, body, user = USER) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const list = await req('GET', '/expose/306');
  assert.equal(list.status, 200);
  const id = list.json.latest.id;
  assert.equal(list.json.history.length, 1);

  assert.equal((await req('GET', '/expose/306', null, VIEWER)).status, 403);

  // Autorfassung: neue Figur-ID wird ignoriert, Wortlaut übernommen.
  const patched = await req('PATCH', `/expose/306/${id}`, { edited: {
    logline: 'Meine Logline', figuren: [{ fig_id: 'fig_1', text: 'Mein Text' }, { fig_id: 'fig_x', text: 'neu' }],
  } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.edited.logline, 'Meine Logline');
  assert.equal(patched.json.edited.synopse, 'Lang, mit Ende.', 'nicht gesendete Felder aus der KI-Fassung');
  assert.deepEqual(patched.json.edited.figuren, [{ fig_id: 'fig_1', text: 'Mein Text' }]);
  assert.equal(patched.json.result.logline, 'Anna sucht.', 'KI-Fassung bleibt erhalten');

  const reset = await req('PATCH', `/expose/306/${id}`, { edited: null });
  assert.equal(reset.json.edited, null);

  // Word: Eckdaten/Namen live, Download als .docx.
  const doc = await fetch(`http://127.0.0.1:${port}/expose/306/${id}/docx`, { headers: { 'x-user': USER } });
  assert.equal(doc.status, 200);
  assert.match(doc.headers.get('content-type'), /wordprocessingml/);
  assert.match(doc.headers.get('content-disposition'), /-expose\.docx"/);
  const buf = Buffer.from(await doc.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');

  assert.equal((await req('DELETE', `/expose/306/${id}`)).status, 200);
  assert.equal((await req('GET', `/expose/306/${id}`)).status, 404);
});

test('Word-HTML: Autorfassung vor KI-Fassung, Namen live, alles escaped, verwaiste Figur fällt weg', async () => {
  const { buildExposeHtml } = require('../../lib/expose-docx');
  const { escHtml } = await require('../../lib/esm-bridge').escapeUtil();
  const html = buildExposeHtml(escHtml, {
    run: { profil: 'narrativ', result: { logline: 'KI', synopse: 'A\n\nB', figuren: [] },
      edited: { logline: 'Autor <b>', kurzinhalt: 'K', synopse: 'A\n\nB', figuren: [{ fig_id: 'fig_1', text: 'T' }, { fig_id: 'fig_weg', text: 'X' }], klappentext: 'V' } },
    eckdaten: { autor: 'X & Y', normseiten: 12 },
    figurNamen: new Map([['fig_1', 'Anna Neu']]),
    kapitelNamen: new Map(),
    klappentext: 'Buch-Klappentext', vita: '', locale: 'de',
  });
  assert.match(html, /Autor &lt;b&gt;/);
  assert.doesNotMatch(html, />KI</);
  assert.match(html, /X &amp; Y/);
  assert.match(html, /ca\. 12 Normseiten/);
  assert.match(html, /<strong>Anna Neu:<\/strong> T/);
  assert.doesNotMatch(html, /fig_weg|>X</);
  assert.match(html, /<p>A<\/p>\n<p>B<\/p>/);
  assert.match(html, /Buch-Klappentext/, 'Klappentext des Buchs, nicht der Vorschlag');
  assert.doesNotMatch(html, />V</);
});
