'use strict';
// Review ueber den Share-Link (docs/share-link.md → „Review-Modus"):
//   - Review-Link anlegen mit Reviewern; Leser-Link bleibt ohne Vorschlaege
//   - Reviewer beanspruchen ihren Namen; Kommentare tragen dann diesen Namen
//   - Aenderungsvorschlag nur verankert und nur im Review-Modus
//   - Owner entscheidet: accepted erledigt den Thread, rejected laesst ihn offen
//   - «Review abschliessen» + Stand (`complete`) fuer das Angebot «gegengelesen»
//   - Reviewer-Liste ersetzen behaelt Anspruch und Abschluss bestehender Namen
//
// Faehrt die echten Share-Router unter Express hoch; die Fake-Session liefert den User.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('../unit/_helpers/tmp-db');

useTmpDb('share-review');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const express = require('express');
const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const rateLimit = require('../../lib/share-ratelimit');

const OWNER = 'owner@review.test';
const BOOK = 8901;
const PAGE = 89011;
const NOW = '2026-01-01T00:00:00.000Z';
const RT_ANNA = 'rAnnaToken0001';
const RT_MARCO = 'rMarcoToken002';

let sessionUser = OWNER;
let server;
let baseUrl;

function startServer() {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionUser ? { user: { email: sessionUser } } : {};
    next();
  });
  app.use('/share', require('../../routes/share'));
  return new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
}

async function api(method, p, body, as = OWNER) {
  sessionUser = as;
  const res = await fetch(`${baseUrl}${p}`, {
    method, redirect: 'manual',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

test.before(async () => {
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Olga Owner' });
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Blog', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, ?, 0, ?, ?)`).run(PAGE, BOOK, 'Beitrag', NOW, '<p data-bid="aa11aa11aa11aa11">Der Hund bellt laut.</p>');
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
  await startServer();
});
test.after(() => { server?.close(); });

test.beforeEach(() => {
  sessionUser = OWNER;
  rateLimit._resetAll();
  for (const t of ['share_link_reviewers', 'share_feedback', 'share_comments', 'share_views', 'share_links']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

async function reviewLink(reviewers = ['Anna', 'Marco']) {
  const r = await api('POST', '/share/api/links', { kind: 'page', page_id: PAGE, mode: 'review', reviewers });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const anchored = (extra = {}) => ({
  anchor_bid: 'aa11aa11aa11aa11', anchor_quote: 'bellt laut', anchor_start: 9, anchor_end: 19, ...extra,
});

test('Review-Link: Reviewer anlegen, Stand in der Owner-Liste', async () => {
  const link = await reviewLink();
  assert.equal(link.mode, 'review');
  assert.deepEqual(link.review.reviewers.map(r => r.name), ['Anna', 'Marco']);
  assert.equal(link.review.complete, false);
  const list = await api('GET', `/share/api/links?book_id=${BOOK}`);
  assert.equal(list.json[0].review.total, 2);
});

test('Leser-Link: Vorschlag wird abgewiesen, Review-Routen antworten NOT_REVIEW_LINK', async () => {
  const r = await api('POST', '/share/api/links', { kind: 'page', page_id: PAGE });
  const token = r.json.token;
  assert.equal(r.json.mode, 'leser');
  const c = await api('POST', `/share/${token}/comment`, { body: '', suggestion: 'kläfft', reader_token: RT_ANNA, ...anchored() }, null);
  assert.equal(c.status, 400, 'ohne Begruendung und ohne Review-Modus ist der Beitrag leer');
  const g = await api('GET', `/share/${token}/review?rt=${RT_ANNA}`, null, null);
  assert.equal(g.status, 400);
  assert.equal(g.json.error_code, 'NOT_REVIEW_LINK');
});

test('Anspruch: Kommentare tragen den Reviewer-Namen; ein Browser = ein Reviewer', async () => {
  const link = await reviewLink();
  const [anna, marco] = link.review.reviewers;
  let r = await api('POST', `/share/${link.token}/comment`, { body: 'Vorher getippt', reader_name: 'irgendwer', reader_token: RT_ANNA }, null);
  assert.equal(r.status, 200);
  r = await api('POST', `/share/${link.token}/review/claim`, { reader_token: RT_ANNA, reviewer_id: anna.id }, null);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.me.name, 'Anna');
  // Frueherer Kommentar ist umbenannt, neuer kommt unter „Anna" trotz anderem Namen im Body.
  await api('POST', `/share/${link.token}/comment`, { body: 'Nachher', reader_name: 'Falsch', reader_token: RT_ANNA }, null);
  const names = db.prepare('SELECT reader_name FROM share_comments WHERE share_token = ?').all(link.token).map(x => x.reader_name);
  assert.deepEqual(names, ['Anna', 'Anna']);
  // Derselbe Browser wechselt auf Marco → Anna ist wieder frei.
  await api('POST', `/share/${link.token}/review/claim`, { reader_token: RT_ANNA, reviewer_id: marco.id }, null);
  const g = await api('GET', `/share/${link.token}/review?rt=${RT_ANNA}`, null, null);
  assert.equal(g.json.me.name, 'Marco');
  assert.equal(g.json.reviewers.find(x => x.name === 'Anna').claimed, false);
});

test('Vorschlag: nur verankert, nicht unveraendert; Owner entscheidet', async () => {
  const link = await reviewLink(['Anna']);
  const t = link.token;
  let r = await api('POST', `/share/${t}/comment`, { body: '', suggestion: 'kläfft', reader_token: RT_ANNA }, null);
  assert.equal(r.json.error_code, 'SUGGESTION_NEEDS_ANCHOR');
  r = await api('POST', `/share/${t}/comment`, { body: '', suggestion: 'bellt laut', reader_token: RT_ANNA, ...anchored() }, null);
  assert.equal(r.json.error_code, 'SUGGESTION_UNCHANGED');
  r = await api('POST', `/share/${t}/comment`, { body: '', suggestion: 'kläfft leise', reader_token: RT_ANNA, ...anchored() }, null);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.comment.suggestion, { text: 'kläfft leise', state: 'open' });
  const id = r.json.comment.id;

  let st = await api('GET', `/share/api/links/${t}/review`);
  assert.equal(st.json.openSuggestions, 1);

  // Fremde Session darf nicht entscheiden.
  const other = 'fremd@review.test';
  if (!appUsers.getUser(other)) appUsers.createUser({ email: other, displayName: 'Fremd' });
  r = await api('PATCH', `/share/api/comments/${id}/suggestion`, { state: 'accepted' }, other);
  assert.equal(r.status, 404);

  r = await api('PATCH', `/share/api/comments/${id}/suggestion`, { state: 'rejected' }, OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.json.comment.suggestion_state, 'rejected');
  assert.equal(r.json.comment.resolved_at, null, 'abgelehnt laesst den Thread offen');

  r = await api('PATCH', `/share/api/comments/${id}/suggestion`, { state: 'accepted' });
  assert.ok(r.json.comment.resolved_at, 'uebernommen erledigt den Thread');
  const threads = await api('GET', `/share/${t}/threads?rt=${RT_ANNA}`, null, null);
  assert.equal(threads.json.comments[0].suggestion.state, 'accepted');
  st = await api('GET', `/share/api/links/${t}/review`);
  assert.equal(st.json.openSuggestions, 0);
});

test('«Review abschliessen» → complete, sobald alle fertig und nichts offen ist', async () => {
  const link = await reviewLink(['Anna', 'Marco']);
  const t = link.token;
  const [anna, marco] = link.review.reviewers;
  let r = await api('POST', `/share/${t}/review/done`, { reader_token: RT_ANNA, done: true }, null);
  assert.equal(r.status, 409, 'ohne Anspruch kein Abschluss');
  await api('POST', `/share/${t}/review/claim`, { reader_token: RT_ANNA, reviewer_id: anna.id }, null);
  await api('POST', `/share/${t}/review/claim`, { reader_token: RT_MARCO, reviewer_id: marco.id }, null);
  const c = await api('POST', `/share/${t}/comment`, { body: 'Offene Frage', reader_token: RT_MARCO, ...anchored() }, null);
  await api('POST', `/share/${t}/review/done`, { reader_token: RT_ANNA, done: true, note: 'Passt.' }, null);
  await api('POST', `/share/${t}/review/done`, { reader_token: RT_MARCO, done: true }, null);
  let st = await api('GET', `/share/api/links/${t}/review`);
  assert.equal(st.json.done, 2);
  assert.equal(st.json.openThreads, 1);
  assert.equal(st.json.complete, false, 'offener Kommentar verhindert «complete»');
  assert.equal(st.json.reviewers.find(x => x.name === 'Anna').done_note, 'Passt.');
  await api('PATCH', `/share/api/comments/${c.json.comment.id}/resolve`, { resolved: true });
  st = await api('GET', `/share/api/links/${t}/review`);
  assert.equal(st.json.complete, true);
});

test('Reviewer-Liste ersetzen behaelt Anspruch und Abschluss bestehender Namen', async () => {
  const link = await reviewLink(['Anna', 'Marco']);
  const t = link.token;
  await api('POST', `/share/${t}/review/claim`, { reader_token: RT_ANNA, reviewer_id: link.review.reviewers[0].id }, null);
  await api('POST', `/share/${t}/review/done`, { reader_token: RT_ANNA, done: true }, null);
  const r = await api('PUT', `/share/api/links/${t}/reviewers`, { names: ['Lea', 'anna', ' Lea '] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.reviewers.map(x => x.name), ['Lea', 'anna']);
  const anna = r.json.reviewers.find(x => x.name === 'anna');
  assert.equal(anna.done, true);
  assert.equal(anna.claimed, true);
});

// Link im Slack geteilt, Namen vorher unbekannt: wer kommt, traegt sich selbst ein.
test('Selbst eintragen: freier Name legt einen Reviewer an, bekannter Name wird beansprucht', async () => {
  const link = await reviewLink([]);
  const t = link.token;
  let r = await api('POST', `/share/${t}/review/claim`, { reader_token: RT_ANNA, name: '  Lea  ' }, null);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.me.name, 'Lea');
  // Derselbe Name (andere Schreibweise) aus einem zweiten Browser: kein Duplikat.
  r = await api('POST', `/share/${t}/review/claim`, { reader_token: RT_MARCO, name: 'lea' }, null);
  assert.equal(r.status, 200, r.text);
  let st = await api('GET', `/share/api/links/${t}/review`);
  assert.deepEqual(st.json.reviewers.map(x => x.name), ['Lea']);
  r = await api('POST', `/share/${t}/review/claim`, { reader_token: RT_MARCO, name: 'Marco' }, null);
  st = await api('GET', `/share/api/links/${t}/review`);
  assert.deepEqual(st.json.reviewers.map(x => x.name), ['Lea', 'Marco']);
  r = await api('POST', `/share/${t}/review/claim`, { reader_token: RT_MARCO, name: '   ' }, null);
  assert.equal(r.status, 400);
  // Ein Kommentar laeuft nach dem Eintragen durch und traegt den Namen.
  r = await api('POST', `/share/${t}/comment`, { body: 'Gut', reader_token: RT_MARCO }, null);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.comment.name, 'Marco');
});

test('Selbst eintragen: Deckel gegen Fluten des oeffentlichen Links', async () => {
  const link = await reviewLink([]);
  const shareReview = require('../../db/share-review');
  for (let i = 0; i < shareReview.REVIEWERS_MAX; i++) {
    const r = await api('POST', `/share/${link.token}/review/claim`, { reader_token: `rFlood${String(i).padStart(8, '0')}`, name: `R${i}` }, null);
    assert.equal(r.status, 200, r.text);
    rateLimit._resetAll();
  }
  const r = await api('POST', `/share/${link.token}/review/claim`, { reader_token: 'rFloodLast0001', name: 'Zuviel' }, null);
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'REVIEWERS_FULL');
});

test('Offener Vorschlag: Leser kann ihn nicht selbst erledigen, nur der Autor entscheidet', async () => {
  const link = await reviewLink(['Anna']);
  const t = link.token;
  const c = await api('POST', `/share/${t}/comment`, { body: '', suggestion: 'kläfft', reader_token: RT_ANNA, ...anchored() }, null);
  const id = c.json.comment.id;
  let r = await api('PATCH', `/share/${t}/comment/${id}/resolve`, { reader_token: RT_ANNA, resolved: true }, null);
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'SUGGESTION_OPEN');
  // Nach dem Entscheid (abgelehnt) darf der Leser den Thread schliessen.
  await api('PATCH', `/share/api/comments/${id}/suggestion`, { state: 'rejected' });
  r = await api('PATCH', `/share/${t}/comment/${id}/resolve`, { reader_token: RT_ANNA, resolved: true }, null);
  assert.equal(r.status, 200, r.text);
});

test('Eigenen Vorschlag bearbeiten: Text aenderbar solange offen, Begruendung darf leer sein', async () => {
  const link = await reviewLink(['Anna']);
  const t = link.token;
  const c = await api('POST', `/share/${t}/comment`, { body: 'weil', suggestion: 'kläfft', reader_token: RT_ANNA, ...anchored() }, null);
  const id = c.json.comment.id;
  let r = await api('PATCH', `/share/${t}/comment/${id}`, { reader_token: RT_ANNA, body: '', suggestion: 'jault' }, null);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.comment.suggestion, { text: 'jault', state: 'open' });
  assert.equal(r.json.comment.body, '');
  r = await api('PATCH', `/share/${t}/comment/${id}`, { reader_token: RT_ANNA, body: '', suggestion: 'bellt laut' }, null);
  assert.equal(r.json.error_code, 'SUGGESTION_UNCHANGED');
  await api('PATCH', `/share/api/comments/${id}/suggestion`, { state: 'accepted' });
  r = await api('PATCH', `/share/${t}/comment/${id}`, { reader_token: RT_ANNA, body: 'x', suggestion: 'heult' }, null);
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'SUGGESTION_DECIDED');
});
