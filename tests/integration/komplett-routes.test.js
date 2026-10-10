'use strict';
// Route-Tests des Komplett-Routers (routes/jobs/komplett/index.js):
//   - Triage-Routen /kontinuitaet/issue/:id/{resolved,dismissed}: Buch-Rolle editor+ UND
//     das Issue gehört zum Check des anfragenden Users (fremdes Issue → 404 wie unbekannt);
//     ohne Leserecht am Buch ebenfalls 404 (kein Existenz-Leak), Viewer → 403.
//   - Standalone-Kontinuität/-Erzählprofil starten nicht parallel zu einer laufenden
//     Komplettanalyse: enthält deren Umfang den Schritt → deren Job-ID (existing+komplett),
//     sonst 409 KOMPLETT_ANALYSIS_RUNNING. Gegenrichtung: die Komplettanalyse startet
//     nicht, solange ein Standalone-Job eines enthaltenen Schritts läuft (409
//     KOMPLETT_STEP_JOB_RUNNING).
//   - DELETE /chapter-cache/:book_id verlangt editor+.
// Fährt den echten Router unter Express hoch; die Fake-Session liefert den User.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser;

const ME = 'autor@test.dev';
const COLLEAGUE = 'kollegin@test.dev';
const BOOK = 9301;
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = sessionUser ? { user: { email: sessionUser } } : {};
      next();
    });
    const jobs = express.Router();
    jobs.use(require('../../routes/jobs/komplett').komplettRouter);
    app.use('/jobs', jobs);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

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

function issueFor(email) {
  const checkId = db.prepare('INSERT INTO continuity_checks (book_id, user_email, checked_at, summary, model) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, email, NOW, 's', 'm').lastInsertRowid;
  return db.prepare(`INSERT INTO continuity_issues (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung)
                     VALUES (?, ?, ?, 'mittel', 'figur', 'b', 'a', 'b', 'e')`).run(checkId, BOOK, email).lastInsertRowid;
}

function clearJobs() {
  const { jobs, runningJobs } = require('../../routes/jobs/shared/state');
  jobs.clear();
  runningJobs.clear();
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  clearJobs();
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = ME;
  clearJobs();
  const { grantAccess } = require('../../db/book-access');
  for (const t of ['continuity_issues', 'continuity_checks', 'book_access', 'komplett_scope']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_) { /* Tabelle optional */ }
  }
  db.prepare('DELETE FROM books WHERE book_id = ?').run(BOOK);
  for (const e of [ME, COLLEAGUE]) db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(e, e);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Buch', NOW, NOW);
  grantAccess(BOOK, ME, 'editor', ME);
  grantAccess(BOOK, COLLEAGUE, 'editor', ME);
});

test('Triage: eigenes Issue → 200, Flag gesetzt', async () => {
  const id = issueFor(ME);
  const r = await api('POST', `/jobs/kontinuitaet/issue/${id}/dismissed`, { dismissed: true });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT dismissed FROM continuity_issues WHERE id = ?').get(id).dismissed, 1);
  const r2 = await api('POST', `/jobs/kontinuitaet/issue/${id}/resolved`, { resolved: true });
  assert.equal(r2.status, 200);
  assert.equal(db.prepare('SELECT resolved FROM continuity_issues WHERE id = ?').get(id).resolved, 1);
});

test('Triage: Issue aus dem Check eines anderen Editors → 404, nichts geändert', async () => {
  const id = issueFor(COLLEAGUE);
  for (const [route, body] of [['dismissed', { dismissed: true }], ['resolved', { resolved: true }]]) {
    const r = await api('POST', `/jobs/kontinuitaet/issue/${id}/${route}`, body);
    assert.equal(r.status, 404, route);
    assert.equal(r.json.error_code, 'ISSUE_NOT_FOUND');
  }
  const row = db.prepare('SELECT resolved, dismissed FROM continuity_issues WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { resolved: 0, dismissed: 0 });
});

test('Triage: ohne Buchzugriff → 404 wie unbekanntes Issue; Viewer → 403', async () => {
  const id = issueFor(ME);
  db.prepare('DELETE FROM book_access WHERE user_email = ?').run(ME);
  const r = await api('POST', `/jobs/kontinuitaet/issue/${id}/resolved`, { resolved: true });
  assert.equal(r.status, 404);
  assert.equal(r.json.error_code, 'ISSUE_NOT_FOUND');
  const u = await api('POST', '/jobs/kontinuitaet/issue/999999/resolved', { resolved: true });
  assert.equal(u.status, 404);
  assert.equal(u.json.error_code, 'ISSUE_NOT_FOUND');
  require('../../db/book-access').grantAccess(BOOK, ME, 'viewer', COLLEAGUE);
  const v = await api('POST', `/jobs/kontinuitaet/issue/${id}/resolved`, { resolved: true });
  assert.equal(v.status, 403);
  assert.equal(db.prepare('SELECT resolved FROM continuity_issues WHERE id = ?').get(id).resolved, 0);
});

test('Komplettanalyse: laufender Standalone-Kontinuitäts-/Erzählprofil-Job → 409 KOMPLETT_STEP_JOB_RUNNING', async () => {
  const shared = require('../../routes/jobs/shared');
  const { getKomplettScope, saveKomplettScope } = require('../../db/schema');
  saveKomplettScope(BOOK, ME, { songs: false });
  for (const [type, step] of [['kontinuitaet', 'kontinuitaet'], ['erzaehlprofil', 'erzaehlprofil']]) {
    clearJobs();
    const stepId = shared.createJob(type, BOOK, ME, 'job.label.' + type);
    const r = await api('POST', '/jobs/komplett-analyse', { book_id: BOOK });
    assert.equal(r.status, 409, type);
    assert.equal(r.json.error_code, 'KOMPLETT_STEP_JOB_RUNNING');
    assert.equal(r.json.jobId, stepId);
    assert.equal(r.json.step, step);
    assert.equal(shared.findActiveJobId('komplett-analyse', BOOK, ME), null, 'keine Komplettanalyse eingereiht');
  }
  assert.equal(getKomplettScope(BOOK, ME).songs, false, 'abgewiesener Start verschiebt die Vorbelegung nicht');
});

test('activeStepJob: jeder laufende Prüf-Job blockiert (auch der Faktencheck), ein fremder User nicht', () => {
  // Die Prüf-Jobs lesen den Katalog, den die Analyse neu schreibt — unabhängig davon,
  // ob der Schritt in ihrem Umfang steht.
  const shared = require('../../routes/jobs/shared');
  const { activeStepJob } = require('../../routes/jobs/komplett/scope');
  clearJobs();
  const id = shared.createJob('kontinuitaet', BOOK, ME, 'job.label.kontinuitaet');
  assert.deepEqual(activeStepJob(BOOK, ME), { jobId: id, step: 'kontinuitaet' });
  assert.equal(activeStepJob(BOOK, COLLEAGUE), null);
  clearJobs();
  const fc = shared.createJob('faktencheck', BOOK, ME, 'job.label.faktencheck');
  assert.deepEqual(activeStepJob(BOOK, ME), { jobId: fc, step: 'faktencheck' });
});

test('DELETE /chapter-cache/:book_id: Viewer → 403, Editor → 200', async () => {
  require('../../db/book-access').grantAccess(BOOK, ME, 'viewer', COLLEAGUE);
  const v = await api('DELETE', `/jobs/chapter-cache/${BOOK}`);
  assert.equal(v.status, 403);
  require('../../db/book-access').grantAccess(BOOK, ME, 'editor', COLLEAGUE);
  const e = await api('DELETE', `/jobs/chapter-cache/${BOOK}`);
  assert.equal(e.status, 200);
  assert.equal(e.json.ok, true);
});

test('Kontinuität/Erzählprofil: laufende Komplettanalyse (auch MIT dem Schritt) → 409, keine Prüfung parallel', async () => {
  // Die Analyse schreibt den Katalog gerade neu; steht der Schritt in ihrem Umfang,
  // reiht sie die Prüfung danach selbst ein (pruef-jobs.js).
  const shared = require('../../routes/jobs/shared');
  const komplettId = shared.createJob('komplett-analyse', BOOK, ME, 'job.label.komplett');
  for (const path of ['/jobs/kontinuitaet', '/jobs/erzaehlprofil']) {
    const r = await api('POST', path, { book_id: BOOK });
    assert.equal(r.status, 409, path);
    assert.equal(r.json.error_code, 'KOMPLETT_ANALYSIS_RUNNING', path);
    assert.equal(r.json.jobId, komplettId, path);
  }
  assert.equal(shared.findActiveJobId('kontinuitaet', BOOK, ME), null, 'kein P8-Job parallel');
  assert.equal(shared.findActiveJobId('erzaehlprofil', BOOK, ME), null, 'kein Erzählprofil-Job parallel');
});

test('Kontinuität: laufende Komplettanalyse OHNE den Schritt → 409 KOMPLETT_ANALYSIS_RUNNING', async () => {
  const shared = require('../../routes/jobs/shared');
  const { saveKomplettScope } = require('../../db/schema');
  saveKomplettScope(BOOK, ME, { kontinuitaet: false });
  const komplettId = shared.createJob('komplett-analyse', BOOK, ME, 'job.label.komplett');
  const r = await api('POST', '/jobs/kontinuitaet', { book_id: BOOK });
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'KOMPLETT_ANALYSIS_RUNNING');
  assert.equal(r.json.jobId, komplettId);
  assert.equal(shared.findActiveJobId('kontinuitaet', BOOK, ME), null);
});
