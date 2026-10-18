'use strict';
// Die Fälle des Client-Vertragstests, in fester Reihenfolge (jeder Fall darf
// auf dem Stand der vorigen aufbauen — `st` trägt Ids/Stempel weiter).
//
// Jeder Fall nennt die Operation (`op`, Schlüssel in contract/openapi.json) und
// den erwarteten Status. Der Test prüft Status + Antwort gegen das Schema und
// legt die Antwort, aufs Schema projiziert und normalisiert, als Fixture unter
// contract/fixtures/<name>.json ab. Abgedeckt wird, was macOS und Android
// tatsächlich aufrufen — nicht die ganze API.

const C = require('./contract-app');

const SAVE_1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const SAVE_2 = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const SAVE_3 = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const DEVICE = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';

const p = (id) => `/content/pages/${id}`;
const edit = (html, from, to) => html.replace(from, to);

const CASES = [
  // ── Konfiguration + Bestand ────────────────────────────────────────────────
  { name: 'config', op: 'GET /config', path: '/config', status: 200 },
  { name: 'books', op: 'GET /content/books', path: '/content/books', status: 200 },
  { name: 'book-tree', op: 'GET /content/books/{book_id}/tree', path: `/content/books/${C.BOOK}/tree`, status: 200 },
  { name: 'sync-full', op: 'GET /content/books/{book_id}/sync', path: `/content/books/${C.BOOK}/sync?limit=200`, status: 200,
    after: (b, st) => { st.syncNow = b.now; } },
  { name: 'page', op: 'GET /content/pages/{page_id}', path: p(C.PAGE_MAIN), status: 200 },
  { name: 'page-not-found', op: 'GET /content/pages/{page_id}', path: p(79999), status: 404 },

  // ── Push ───────────────────────────────────────────────────────────────────
  { name: 'push', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 200,
    body: () => ({ html: edit(C.MAIN_HTML, 'Erster Absatz.', 'Erster Absatz, am Mac.'), expected_updated_at: C.T0,
      source: 'macapp', device_id: DEVICE, save_id: SAVE_1, own_save_ids: [] }),
    after: (b, st) => { st.t1 = b.updated_at; st.html1 = b.html; } },
  { name: 'push-replay', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 200,
    body: () => ({ html: edit(C.MAIN_HTML, 'Erster Absatz.', 'Erster Absatz, am Mac.'), expected_updated_at: C.T0,
      source: 'macapp', device_id: DEVICE, save_id: SAVE_1, own_save_ids: [] }) },
  { name: 'push-conflict', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 409,
    body: () => ({ html: edit(C.MAIN_HTML, 'Dritter Absatz.', 'Dritter Absatz, offline.'), expected_updated_at: C.T0,
      source: 'macapp', device_id: DEVICE }) },
  { name: 'push-merged', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 200,
    body: () => ({ html: edit(C.MAIN_HTML, 'Dritter Absatz.', 'Dritter Absatz, offline.'), base_html: C.MAIN_HTML,
      expected_updated_at: C.T0, source: 'macapp', device_id: DEVICE, save_id: SAVE_2, own_save_ids: [] }),
    after: (b, st) => { st.t2 = b.updated_at; } },
  { name: 'push-merge-conflict', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 409,
    body: () => ({ html: edit(C.MAIN_HTML, 'Erster Absatz.', 'Erster Absatz, anders.'), base_html: C.MAIN_HTML,
      expected_updated_at: C.T0, source: 'macapp', device_id: DEVICE, save_id: SAVE_3 }) },
  { name: 'push-empty', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 400, body: () => ({}) },
  { name: 'push-locked', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_LOCKED), status: 423,
    body: () => ({ html: '<p>Trotzdem.</p>', expected_updated_at: C.T0 }) },
  { name: 'rename', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_SUB), status: 200,
    body: () => ({ name: 'Mitte, umbenannt' }) },

  // ── Fassungen ──────────────────────────────────────────────────────────────
  { name: 'revisions', op: 'GET /content/pages/{page_id}/revisions', path: `${p(C.PAGE_MAIN)}/revisions?limit=100`, status: 200,
    // Aeltester eigener Save, nicht der Ausgangsstand (`baseline`), den der
    // Server vor dem ersten Save der Seed-Seite ablegt.
    after: (b, st) => { st.revId = b.revisions.filter(r => r.summary !== 'baseline').at(-1).id; } },
  { name: 'revision', op: 'GET /content/pages/{page_id}/revisions/{rev_id}', path: (st) => `${p(C.PAGE_MAIN)}/revisions/${st.revId}`, status: 200 },
  { name: 'revision-restore', op: 'POST /content/pages/{page_id}/revisions/{rev_id}/restore', method: 'POST',
    path: (st) => `${p(C.PAGE_MAIN)}/revisions/${st.revId}/restore`, status: 200, body: () => ({}) },

  // ── Struktur ───────────────────────────────────────────────────────────────
  { name: 'page-create', op: 'POST /content/pages', method: 'POST', path: '/content/pages', status: 200,
    body: () => ({ book_id: C.BOOK, chapter_id: C.CH_SUB, name: '2026-10-18', html: '<p>Tagebuch.</p>' }) },
  { name: 'chapter-create', op: 'POST /content/chapters', method: 'POST', path: '/content/chapters', status: 200,
    body: () => ({ book_id: C.BOOK, name: 'Oktober', position: 10, parent_chapter_id: C.CH_PART }) },
  { name: 'page-delete', op: 'DELETE /content/pages/{page_id}', method: 'DELETE', path: p(C.PAGE_GONE), status: 200 },
  { name: 'sync-delta', op: 'GET /content/books/{book_id}/sync', path: (st) => `/content/books/${C.BOOK}/sync?since=${encodeURIComponent(st.syncNow)}&since_id=0&limit=200`, status: 200 },
  { name: 'device-ping', op: 'POST /content/books/{book_id}/device-ping', method: 'POST', path: `/content/books/${C.BOOK}/device-ping`, status: 200,
    body: () => ({ device_id: DEVICE, page_id: C.PAGE_MAIN }) },

  // ── Nebenwege ──────────────────────────────────────────────────────────────
  { name: 'research-create', op: 'POST /research', method: 'POST', path: '/research', status: 200,
    body: () => ({ book_id: C.BOOK, kind: 'link', title: 'Geteilter Link', body: 'Aus der Android-App geteilt.',
      urls: [{ url: 'https://example.org/artikel', label: '' }], tags: [] }) },
  { name: 'research-list', op: 'GET /research', path: `/research?book_id=${C.BOOK}&sort=updated`, status: 200 },
  { name: 'dictionary-add', op: 'POST /dictionary', method: 'POST', path: '/dictionary', status: 200,
    body: () => ({ word: 'Schreibwerkstatt', bookId: 0, lang: '*' }) },
  { name: 'writing-time', op: 'POST /history/writing-time', method: 'POST', path: '/history/writing-time', status: 200,
    body: () => ({ book_id: C.BOOK, seconds: 30 }) },
  { name: 'book-settings', op: 'GET /booksettings/{book_id}', path: `/booksettings/${C.BOOK}`, status: 200 },
  { name: 'export-md', op: 'GET /export/book/{book_id}/md', path: `/export/book/${C.BOOK}/md`, status: 200, raw: 'text' },

  // ── Jobs ───────────────────────────────────────────────────────────────────
  { name: 'job-check-create', op: 'POST /jobs/check', method: 'POST', path: '/jobs/check', status: 200,
    body: () => ({ page_id: C.PAGE_MAIN, book_id: C.BOOK, page_name: 'Anfang' }),
    after: (b, st) => { st.checkJob = b.jobId; }, volatile: (st) => [st.checkJob] },
  { name: 'job-check-done', op: 'GET /jobs/{job_id}', path: (st) => `/jobs/${st.checkJob}`, status: 200,
    waitDone: true, volatile: (st) => [st.checkJob] },
  { name: 'job-synonym-create', op: 'POST /jobs/synonym', method: 'POST', path: '/jobs/synonym', status: 200,
    body: () => ({ wort: 'Absatz', satz: 'Erster Absatz, am Mac.', book_id: C.BOOK, page_id: String(C.PAGE_MAIN) }),
    after: (b, st) => { st.synJob = b.jobId; }, volatile: (st) => [st.synJob] },
  { name: 'job-synonym-done', op: 'GET /jobs/{job_id}', path: (st) => `/jobs/${st.synJob}`, status: 200,
    waitDone: true, volatile: (st) => [st.synJob] },

  // ── Konto ──────────────────────────────────────────────────────────────────
  { name: 'device-tokens', op: 'GET /me/device-tokens', path: '/me/device-tokens', status: 200 },
  { name: 'account-delete-unconfirmed', op: 'DELETE /me/account', method: 'DELETE', path: '/me/account', status: 400,
    body: () => ({ confirm: 'delete' }) },

  // ── OTA ────────────────────────────────────────────────────────────────────
  { name: 'editor-bundle', op: 'GET /content/editor-bundle.zip', path: '/content/editor-bundle.zip', status: 200,
    headers: { 'X-Editor-Api': '1' }, raw: 'zip', after: (_b, st, res) => { st.bundleEtag = res.headers.get('etag'); } },
  { name: 'editor-bundle-unchanged', op: 'GET /content/editor-bundle.zip', path: '/content/editor-bundle.zip', status: 304,
    headers: (st) => ({ 'X-Editor-Api': '1', 'If-None-Match': st.bundleEtag }), raw: 'empty' },
  { name: 'editor-bundle-unsupported', op: 'GET /content/editor-bundle.zip', path: '/content/editor-bundle.zip', status: 409,
    headers: { 'X-Editor-Api': '99' } },

  // ── Auth ───────────────────────────────────────────────────────────────────
  { name: 'auth-invalid-token', op: 'GET /content/books', path: '/content/books', status: 401, token: 'invalid' },
  { name: 'scope-forbidden', op: 'PUT /content/pages/{page_id}', method: 'PUT', path: p(C.PAGE_MAIN), status: 403, token: 'capture',
    body: () => ({ html: '<p>Aus fremdem Tab.</p>' }) },
];

module.exports = { CASES, DEVICE };
