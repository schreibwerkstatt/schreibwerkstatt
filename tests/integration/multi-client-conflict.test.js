'use strict';
// Ein Abschnitt, vier Clients, nacheinander — jeder mit einer veralteten Basis.
//
// Alle vier haben den Abschnitt auf demselben Stand T0 geladen (Browser-Tab mit
// Notebook-Editor und Bucheditor, Android- und Mac-Client mit ihrem Offline-
// Spiegel) und ändern ihn dann der Reihe nach:
//
//   1. Notebook-Editor (Browser, Schreiber `notebook`): Absatz 1 → 200, T1.
//   2. Bucheditor (gleicher Browser, Schreiber `book`): Absatz 2 auf Basis T0.
//      Pre-Check (`checkPageConflict`) sieht den fremden Stand, ein PUT ohne
//      Pre-Check liefe in 409. Block-Merge wie in cards/book-editor/conflict.js
//      (`planBlockMerge`: Basis = Block-Stand T0, lokal, Server T1) →
//      kollisionsfrei → gegen T1 speichern → 200, T2.
//   3. Android (Device-Token): Absatz 3 auf Basis T0 → 409 → 3-Wege-Block-Merge
//      (`mergeBlocks`, derselbe Code wie im OTA-Bundle) → kollisionsfrei →
//      gemergt gegen T2 pushen → 200, T3.
//   4. Mac (Device-Token): Absatz 2 (wie der Bucheditor!) + neuer Absatz am Ende
//      auf Basis T0 → 409 → Merge mit echter Block-Kollision → Konflikt-Ansicht.
//      Beide Auflösungen werden gerechnet («Meinen Stand behalten» → `merged`,
//      «Server-Stand übernehmen» → `mergedRemote`, wie `_merge3` der Mac-Bridge),
//      gepusht wird «Meinen Stand behalten» → 200, T4.
//
// Am Ende trägt der Abschnitt jede Änderung genau einmal; nichts ist still
// verloren, und jeder 409 nennt das eigene Zweitgerät als Urheber.
//
// Bucheditor und native Clients laufen nicht hier — ihr Push-/Merge-Pfad wird über den
// dokumentierten Vertrag nachgestellt (docs/clients.md → «Sync & Presence»,
// macOS: SyncEngine+Push.swift#resolveConflict, SyncEngine+Conflicts.swift).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let merge; // ESM: public/js/editor/shared/block-merge.js
let bookPlan; // ESM: public/js/cards/book-editor/conflict.js#planBlockMerge

const ME = 'autorin@test.dev';
const BOOK = 9401;
const CHAPTER = 9411;
const PAGE = 94011;
const T0 = '2026-01-01T00:00:00.000Z';

// Geräte: der Browser schreibt aus Notebook-Editor und Bucheditor mit derselben
// Geräte-ID (nur die Save-Kennung trennt die Schreiber), die nativen Clients
// melden sich per Device-Token mit eigenem Gerätenamen.
const BROWSER_DEVICE = crypto.randomUUID();
const ANDROID_DEVICE = crypto.randomUUID();
const MAC_DEVICE = crypto.randomUUID();
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
let tokenIds = {};

const ORIGINAL = '<p data-bid="b0000000000000a1">Absatz eins.</p>'
  + '<p data-bid="b0000000000000a2">Absatz zwei.</p>'
  + '<p data-bid="b0000000000000a3">Absatz drei.</p>'
  + '<p data-bid="b0000000000000a4">Absatz vier.</p>';

// Absatz `n` (1-basiert) in `html` durch `text` ersetzen, data-bid bleibt.
function editBlock(html, n, text) {
  const bid = `b0000000000000a${n}`;
  const re = new RegExp(`(<p data-bid="${bid}">)[^<]*(</p>)`);
  assert.match(html, re, `Absatz ${n} nicht gefunden`);
  return html.replace(re, `$1${text}$2`);
}

function blockText(html, n) {
  const m = html.match(new RegExp(`<p data-bid="b0000000000000a${n}">([^<]*)</p>`));
  return m ? m[1] : null;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    // Client-Identität je Request: Browser per Session, native Clients per
    // Device-Token (wie lib/auth-guard.js sie in req.session.user ablegt).
    app.use((req, _res, next) => {
      const client = req.get('x-test-client') || 'browser';
      const user = { email: ME };
      if (client !== 'browser') { user.via = 'device_token'; user.tokenId = tokenIds[client]; }
      req.session = { user };
      next();
    });
    app.use('/content', require('../../routes/content'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(client, method, path, body) {
  const headers = { 'x-test-client': client };
  if (client === 'browser') headers['User-Agent'] = BROWSER_UA;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const getPage = (client) => api(client, 'GET', `/content/pages/${PAGE}`);
const putPage = (client, body) => api(client, 'PUT', `/content/pages/${PAGE}`, body);

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  merge = await import('../../public/js/editor/shared/block-merge.js');
  // Browser-Modul: braucht beim Laden ein `window` (Event-Bus); nur für den
  // Import stubben, damit der Server-Code des Tests keins sieht.
  globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  try {
    ({ planBlockMerge: bookPlan } = await import('../../public/js/cards/book-editor/conflict.js'));
  } finally {
    delete globalThis.window;
  }
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  for (const t of ['page_revisions', 'book_access', 'book_order', 'device_tokens']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)').run(ME, T0);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', T0, T0);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(CHAPTER, BOOK, 'Kapitel 1', T0);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
              VALUES (?, ?, ?, ?, 0, ?, ?)`).run(PAGE, BOOK, 'Der Abschnitt', CHAPTER, T0, ORIGINAL);
  require('../../db/book-access').grantAccess(BOOK, ME, 'owner', ME);
  const tokens = require('../../db/device-tokens');
  tokenIds = {
    android: tokens.createDeviceToken({ userEmail: ME, deviceName: 'Pixel 9', platform: 'android' }).id,
    mac: tokens.createDeviceToken({ userEmail: ME, deviceName: 'MacBook Air', platform: 'macos' }).id,
  };
});

// Push eines nativen Clients nach dem Vertrag: PUT gegen die Spiegel-Basis;
// 409 → frischer GET, mergeBlocks(Basis, lokal, Server), kollisionsfrei →
// gemergt gegen den frischen Stempel erneut pushen. Liefert, was passiert ist.
async function nativePush(client, deviceId, { baseHtml, baseUpdatedAt, localHtml }) {
  const first = await putPage(client, { html: localHtml, expected_updated_at: baseUpdatedAt, device_id: deviceId });
  if (first.status !== 409) return { first };
  const fresh = await getPage(client);
  assert.equal(fresh.status, 200);
  const res = merge.mergeBlocks(baseHtml, localHtml, fresh.json.html);
  // Gegenstück `mergedRemote` der Mac-Bridge (_merge3): Kollision → Server.
  const decisions = Object.fromEntries(res.conflicts.map((c) => [c.bid, 'remote']));
  const outcome = {
    merged: merge.mergedToHtml(res.merged),
    mergedRemote: merge.buildResolvedHtml(res.merged, decisions),
    conflicts: res.conflicts,
  };
  if (res.conflicts.length) return { first, fresh, outcome };
  const second = await putPage(client, { html: outcome.merged, expected_updated_at: fresh.json.updated_at, device_id: deviceId });
  return { first, fresh, outcome, second };
}

test('Notebook → Bucheditor → Android → Mac auf demselben Abschnitt: jede Änderung landet genau einmal', async () => {
  // ── T0: alle vier laden denselben Stand ──────────────────────────────────
  const t0 = await getPage('browser');
  assert.equal(t0.status, 200);
  assert.equal(t0.json.updated_at, T0);
  const base = { html: t0.json.html, updatedAt: t0.json.updated_at };
  // Notebook und Bucheditor halten je eine Kopie; Android und Mac ihren Spiegel.
  let bookEditorHtml = base.html;
  const androidLocal = editBlock(base.html, 3, 'Absatz drei, unterwegs auf dem Handy umgeschrieben.');
  const macLocal = editBlock(base.html, 2, 'Absatz zwei, am Mac neu gefasst.')
    + '<p>Ein ganz neuer Schlussabsatz vom Mac.</p>';

  // ── 1. Notebook-Editor: Basis passt → 200 ───────────────────────────────
  const nbSaveId = crypto.randomUUID();
  const nb = await putPage('browser', {
    html: editBlock(base.html, 1, 'Absatz eins, im Notebook überarbeitet.'),
    expected_updated_at: base.updatedAt,
    device_id: BROWSER_DEVICE,
    save_id: nbSaveId,
    own_save_ids: [],
    client_tab: 'tabA',
    save_reason: 'save',
  });
  assert.equal(nb.status, 200, JSON.stringify(nb.json));
  const t1 = nb.json.updated_at;
  assert.notEqual(t1, T0);
  assert.equal(nb.json.last_save_id, nbSaveId);

  // ── 2. Bucheditor: Absatz 2 auf Basis T0 ───────────────────────────────
  bookEditorHtml = editBlock(bookEditorHtml, 2, 'Absatz zwei, im Bucheditor gestrafft.');
  // Pre-Check wie shared/page-conflict.js#checkPageConflict(…, { writer: 'book' }):
  // Stempel weicht ab, und der Server-Stand stammt nicht aus einem eigenen Save
  // des Bucheditors (die Kennung gehört dem Notebook-Schreiber desselben Tabs).
  const pre = await getPage('browser');
  assert.notEqual(pre.json.updated_at, base.updatedAt, 'Pre-Check muss den fremden Stand sehen');
  assert.equal(pre.json.last_save_id, nbSaveId);
  const bookOwnIds = []; // Schreiber `book` hat für diesen Abschnitt nichts unbestätigt offen
  assert.ok(!bookOwnIds.includes(pre.json.last_save_id), 'Notebook-Save darf nicht als eigener Bucheditor-Save gelten');

  // Ohne Pre-Check (Race) schützt der Server: 409, nichts geschrieben.
  const bookStale = await putPage('browser', {
    html: bookEditorHtml, expected_updated_at: base.updatedAt, device_id: BROWSER_DEVICE,
    save_id: crypto.randomUUID(), own_save_ids: bookOwnIds, client_tab: 'tabA', save_reason: 'book',
  });
  assert.equal(bookStale.status, 409);
  assert.equal(bookStale.json.error_code, 'PAGE_CONFLICT');
  assert.equal(bookStale.json.server_updated_at, t1);
  assert.equal(bookStale.json.server_is_self, true, 'eigenes Konto: Banner spricht vom eigenen Gerät, nicht von fremder Person');
  assert.equal(blockText((await getPage('browser')).json.html, 1), 'Absatz eins, im Notebook überarbeitet.',
    '409 darf die Notebook-Änderung nicht anfassen');

  // Bucheditor mergt still (book-editor/conflict.js#planBlockMerge): Absatz 1
  // kam vom Notebook, Absatz 2 vom Bucheditor — keine Überschneidung.
  const remote = await getPage('browser');
  const plan = bookPlan(base.html, bookEditorHtml, remote.json.html, { enabled: true });
  assert.equal(plan.kind, 'clean');
  bookEditorHtml = plan.html;
  const book = await putPage('browser', {
    html: bookEditorHtml, expected_updated_at: remote.json.updated_at, device_id: BROWSER_DEVICE,
    save_id: crypto.randomUUID(), own_save_ids: [], client_tab: 'tabA', save_reason: 'book',
  });
  assert.equal(book.status, 200, JSON.stringify(book.json));
  const t2 = book.json.updated_at;
  assert.equal(blockText(book.json.html, 1), 'Absatz eins, im Notebook überarbeitet.');
  assert.equal(blockText(book.json.html, 2), 'Absatz zwei, im Bucheditor gestrafft.');

  // ── 3. Android: Absatz 3 auf Basis T0 → 409 → kollisionsfreier Merge ────
  const android = await nativePush('android', ANDROID_DEVICE, {
    baseHtml: base.html, baseUpdatedAt: base.updatedAt, localHtml: androidLocal,
  });
  assert.equal(android.first.status, 409);
  assert.equal(android.first.json.server_updated_at, t2);
  assert.equal(android.first.json.server_is_self, true);
  assert.ok(android.first.json.server_editor_device, '409 nennt das Browser-Gerät als Urheber');
  assert.equal(android.outcome.conflicts.length, 0, 'Absatz 3 hat sonst niemand angefasst');
  assert.equal(android.second.status, 200, JSON.stringify(android.second.json));
  const t3 = android.second.json.updated_at;
  const afterAndroid = android.second.json.html;
  assert.equal(blockText(afterAndroid, 1), 'Absatz eins, im Notebook überarbeitet.');
  assert.equal(blockText(afterAndroid, 2), 'Absatz zwei, im Bucheditor gestrafft.');
  assert.equal(blockText(afterAndroid, 3), 'Absatz drei, unterwegs auf dem Handy umgeschrieben.');
  assert.equal(blockText(afterAndroid, 4), 'Absatz vier.');

  // ── 4. Mac: Absatz 2 + neuer Schluss auf Basis T0 → echte Kollision ─────
  const mac = await nativePush('mac', MAC_DEVICE, {
    baseHtml: base.html, baseUpdatedAt: base.updatedAt, localHtml: macLocal,
  });
  assert.equal(mac.first.status, 409);
  assert.equal(mac.first.json.server_updated_at, t3);
  assert.equal(mac.first.json.server_editor_device, 'Pixel 9', 'Konflikt-Ansicht nennt das Android-Gerät');
  assert.equal(mac.second, undefined, 'Kollision wird nie automatisch gepusht');
  assert.equal(mac.outcome.conflicts.length, 1);
  const [collision] = mac.outcome.conflicts;
  assert.equal(collision.bid, 'b0000000000000a2');
  assert.match(collision.local_html, /am Mac neu gefasst/);
  assert.match(collision.remote_html, /im Bucheditor gestrafft/);
  assert.match(collision.base_html, /Absatz zwei\./);
  assert.equal(blockText((await getPage('mac')).json.html, 2), 'Absatz zwei, im Bucheditor gestrafft.',
    'solange die Kollision offen ist, bleibt der Server-Stand unverändert');

  // Beide Auflösungen behalten alles ausser der Kollision selbst.
  for (const [label, html, expected2] of [
    ['Meinen Stand behalten', mac.outcome.merged, 'Absatz zwei, am Mac neu gefasst.'],
    ['Server-Stand übernehmen', mac.outcome.mergedRemote, 'Absatz zwei, im Bucheditor gestrafft.'],
  ]) {
    assert.equal(blockText(html, 1), 'Absatz eins, im Notebook überarbeitet.', label);
    assert.equal(blockText(html, 2), expected2, label);
    assert.equal(blockText(html, 3), 'Absatz drei, unterwegs auf dem Handy umgeschrieben.', label);
    assert.equal(blockText(html, 4), 'Absatz vier.', label);
    assert.match(html, /Ein ganz neuer Schlussabsatz vom Mac\./, `${label}: neuer Absatz ohne Kollision bleibt`);
  }

  // User wählt «Meinen Stand behalten»: Push gegen den frischen Stempel.
  const resolved = await putPage('mac', {
    html: mac.outcome.merged, expected_updated_at: mac.fresh.json.updated_at, device_id: MAC_DEVICE,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  const final = (await getPage('browser')).json;
  assert.equal(final.updated_at, resolved.json.updated_at);
  assert.equal(blockText(final.html, 1), 'Absatz eins, im Notebook überarbeitet.');
  assert.equal(blockText(final.html, 2), 'Absatz zwei, am Mac neu gefasst.');
  assert.equal(blockText(final.html, 3), 'Absatz drei, unterwegs auf dem Handy umgeschrieben.');
  assert.equal(blockText(final.html, 4), 'Absatz vier.');
  const tail = final.html.match(/<p data-bid="([0-9a-f]{16})">Ein ganz neuer Schlussabsatz vom Mac\.<\/p>$/);
  assert.ok(tail, `neuer Absatz steht am Ende und hat vom Server eine Block-ID bekommen: ${final.html}`);
  // Jeder Absatz genau einmal — kein Doppel aus dem Merge.
  assert.equal(merge.parseBlocks(final.html).length, 5);
  assert.equal(new Set(merge.parseBlocks(final.html).map((b) => b.bid)).size, 5);
  // Letzter Body-Autor ist der Mac (Gerät für «Zuletzt bearbeitet»).
  const row = db.prepare('SELECT last_editor_device_id, last_save_id FROM pages WHERE page_id = ?').get(PAGE);
  assert.equal(row.last_editor_device_id, MAC_DEVICE);
  assert.equal(row.last_save_id, null, 'nativer Push ohne save_id beendet die Eigen-Erkennung');
});

test('Mac «Server-Stand übernehmen» bei Kollision: Bucheditor-Fassung bleibt, neuer Mac-Absatz wird trotzdem gepusht', async () => {
  const base = (await getPage('browser')).json;
  // Bucheditor ändert Absatz 2 (Basis passt).
  const book = await putPage('browser', {
    html: editBlock(base.html, 2, 'Absatz zwei, im Bucheditor gestrafft.'),
    expected_updated_at: base.updated_at, device_id: BROWSER_DEVICE, save_id: crypto.randomUUID(), own_save_ids: [],
  });
  assert.equal(book.status, 200);
  // Mac auf Basis T0: dieselbe Stelle + neuer Absatz.
  const macLocal = editBlock(base.html, 2, 'Absatz zwei, am Mac neu gefasst.') + '<p>Neuer Mac-Absatz.</p>';
  const mac = await nativePush('mac', MAC_DEVICE, { baseHtml: base.html, baseUpdatedAt: base.updated_at, localHtml: macLocal });
  assert.equal(mac.outcome.conflicts.length, 1);
  // SyncEngine+Conflicts.swift: keepLocal=false und mergedRemote ≠ Server → pushen
  // (lokale Änderung ohne Kollision bleibt erhalten), sonst nur übernehmen.
  assert.notEqual(merge.parseBlocks(mac.outcome.mergedRemote).map((b) => b.html).join(''),
    merge.parseBlocks(mac.fresh.json.html).map((b) => b.html).join(''));
  const resolved = await putPage('mac', {
    html: mac.outcome.mergedRemote, expected_updated_at: mac.fresh.json.updated_at, device_id: MAC_DEVICE,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(blockText(resolved.json.html, 2), 'Absatz zwei, im Bucheditor gestrafft.');
  assert.match(resolved.json.html, /Neuer Mac-Absatz\./);
  assert.equal(merge.parseBlocks(resolved.json.html).length, 5);
});
