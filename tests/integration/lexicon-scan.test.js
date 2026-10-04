'use strict';
// Integration: Wortschatz-Scan (routes/jobs/lexicon-scan.js) über das Dummy-Buch
// und Lesepfad GET /lexicon/:book_id (routes/lexicon.js).
//
// Geprüft wird, was die Unit-Tests nicht sehen: dass der Job über den Content-Store
// liest und Kapitel-Band + Idiolekt + Verlauf wirklich schreibt; dass der Delta-Skip
// an der EINGANGS-Signatur hängt (eine neue Figur bzw. ein neues Referenzbuch löst
// einen Neu-Scan aus, obwohl keine Seite geändert wurde); und dass ein Lektor nichts
// sieht, was aus den übrigen Büchern des Besitzers abgeleitet ist.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap, waitForJob } = require('./_helpers/setup');
const dummy = require('./_helpers/dummy-book');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'lex-owner@test.dev';
const LEKTOR = 'lex-lektor@test.dev';
const BOOK = 103;
const OTHER_BOOK = 104;

let ctx; let db; let server; let baseUrl; let scan; let lexiconDb;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const appUsers = require('../../db/app-users');
  const bookAccess = require('../../db/book-access');
  for (const email of [OWNER, LEKTOR]) if (!appUsers.getUser(email)) appUsers.createUser({ email });
  dummy.seedDummyBook(ctx.dbSeed, BOOK);
  db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?').run(OWNER, BOOK);
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
  bookAccess.grantAccess(BOOK, LEKTOR, 'lektor', OWNER);
  scan = require('../../routes/jobs/lexicon-scan');
  lexiconDb = require('../../db/lexicon');

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/lexicon', require('../../routes/lexicon'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function runScan(bookId, force = false) {
  const jobId = ctx.shared.createJob('lexicon-scan', bookId, OWNER, 'job.label.lexiconScan');
  ctx.shared.enqueueJob(jobId, () => scan.runLexiconScanJob(jobId, bookId, OWNER, { force }));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(job.status, 'done', job.error || '');
  return job;
}

async function get(bookId, user) {
  const r = await fetch(`${baseUrl}/lexicon/${bookId}`, { headers: { 'x-test-user': user } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('Scan schreibt Kennzahlen, Kapitel-Band und stempelt den Tagesverlauf', async () => {
  const { localIsoDate } = require('../../lib/local-date');
  db.prepare('INSERT INTO book_stats_history (book_id, recorded_at, words) VALUES (?,?,?)').run(BOOK, localIsoDate(), 1);

  const job = await runScan(BOOK);
  assert.equal(job.result.skipped, false);
  const stats = lexiconDb.getBookLexicon(BOOK);
  assert.ok(stats.tokens > 1000);
  const sig = lexiconDb.getLexiconSignature(BOOK);
  assert.ok(sig.input_sig && sig.content_sig && sig.input_sig !== sig.content_sig);

  const chapters = lexiconDb.listChapterLexicon(BOOK);
  assert.equal(chapters.length, 4, 'vier Kapitel im Dummy-Buch');
  assert.ok(chapters.every(c => c.tokens > 0 && c.chapter_name));

  const hist = db.prepare('SELECT mtld, lex_density FROM book_stats_history WHERE book_id = ?').get(BOOK);
  assert.equal(hist.mtld, stats.mtld);
  assert.equal(hist.lex_density, stats.lex_density);
});

test('Delta-Skip: unverändert → übersprungen; neue Figur → neu gescannt', async () => {
  assert.equal((await runScan(BOOK)).result.skipped, true);

  db.prepare(`INSERT INTO figures (book_id, fig_id, name, updated_at, user_email)
              VALUES (?, 'fig_lea', 'Lea Brunner', '2026-01-01T00:00:00Z', ?)`).run(BOOK, OWNER);
  const job = await runScan(BOOK);
  assert.equal(job.result.skipped, false, 'die Namensliste gehört zur Eingangs-Signatur');
  const terms = lexiconDb.listLexiconTerms(BOOK).map(t => t.term);
  assert.equal(terms.includes('brunner'), false, 'neuer Figurenname fällt aus der Wortliste');
  assert.equal(terms.includes('brunners'), false, 'samt Genitiv');
});

test('Delta-Skip: neues Referenzbuch desselben Besitzers → neu gescannt, Keyness entsteht', async () => {
  dummy.seedDummyBook(ctx.dbSeed, OTHER_BOOK);
  db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?').run(OWNER, OTHER_BOOK);
  await runScan(OTHER_BOOK);

  const job = await runScan(BOOK);
  assert.equal(job.result.skipped, false, 'die Referenz gehört zur Eingangs-Signatur');
  assert.equal(job.result.hasReference, true);
  // Kein gegenseitiges Anstossen: der Fingerabdruck nimmt den TEXTstand der
  // anderen Bücher, und der hat sich durch den Neu-Scan von 103 nicht geändert.
  assert.equal((await runScan(BOOK)).result.skipped, true);
  assert.equal((await runScan(OTHER_BOOK)).result.skipped, true);
});

test('GET /lexicon: Besitzer sieht Vergleiche, Lektor nicht', async () => {
  const owner = await get(BOOK, OWNER);
  assert.equal(owner.status, 200);
  assert.equal(owner.json.isOwner, true);
  assert.ok(owner.json.peers && owner.json.peers.books === 1);
  assert.equal(owner.json.chapters.length, 4);

  const lektor = await get(BOOK, LEKTOR);
  assert.equal(lektor.status, 200);
  assert.equal(lektor.json.isOwner, false);
  assert.equal(lektor.json.peers, null);
  assert.ok(lektor.json.terms.every(t => t.keyness === null && t.kind !== 'key'));
  assert.ok(lektor.json.hapax.every(h => h.novel === null));
  assert.equal(lektor.json.stats.tokens, owner.json.stats.tokens, 'die Kennzahlen DIESES Buchs sieht er');
});

test('GET /lexicon: ohne Zugriff 403, ohne Login 401, ungültige ID 400', async () => {
  assert.equal((await get(BOOK, 'fremd@test.dev')).status, 403);
  assert.equal((await fetch(`${baseUrl}/lexicon/${BOOK}`)).status, 401);
  assert.equal((await get('abc', OWNER)).status, 400);
});

test('GET /lexicon?summary=1: nur Kennzahlen und Vergleich, keine Ranglisten', async () => {
  const r = await fetch(`${baseUrl}/lexicon/${BOOK}?summary=1`, { headers: { 'x-test-user': OWNER } });
  const json = await r.json();
  assert.equal(r.status, 200);
  assert.ok(json.stats && json.peers);
  assert.equal(json.terms, undefined);
  assert.equal(json.hapax, undefined);
  assert.equal(json.chapters, undefined);
});

test('Sprache: Umstellung auf Englisch → stale, Neu-Scan, eigene Sprach-Referenz', async () => {
  const { saveBookSettings } = require('../../db/book-settings');
  require('../../db/book-access').grantAccess(OTHER_BOOK, OWNER, 'owner', OWNER);
  assert.equal(lexiconDb.getBookLexicon(OTHER_BOOK).language, 'de');
  saveBookSettings(OTHER_BOOK, 'en', 'US', null, null);

  const before = await get(OTHER_BOOK, OWNER);
  assert.equal(before.json.stale, true, 'gespeicherter Scan hat die alte Sprache');

  const job = await runScan(OTHER_BOOK);
  assert.equal(job.result.skipped, false, 'die Sprache gehört zur Eingangs-Signatur');
  assert.equal(job.result.hasReference, false, 'kein anderes englisches Buch → keine Referenz');
  assert.equal(lexiconDb.getBookLexicon(OTHER_BOOK).language, 'en');

  const after = await get(OTHER_BOOK, OWNER);
  assert.equal(after.json.stale, false);
  assert.equal(after.json.peers, null, 'deutsches Buch taugt nicht als Vergleich');

  // Das deutsche Buch verliert seine einzige Referenz und rechnet neu.
  const de = await runScan(BOOK);
  assert.equal(de.result.skipped, false);
  assert.equal(de.result.hasReference, false);
  saveBookSettings(OTHER_BOOK, 'de', 'CH', null, null);
});
