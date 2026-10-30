'use strict';
// Tests für routes/jobs/research-chat-tools.js:
//  - propose_research_item: Validierung (URL-Schema, Pflichtfelder, Cap) + Sammeln in ctx.proposals
//  - list_research_items / read_research_item: lesen vorhandenes Material
//  - list_book_entities: liefert Kontext-Kategorien
//
// Persistiert NICHTS automatisch — propose_research_item füllt nur ctx.proposals.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('rct');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/schema');
const { executeResearchTool } = require('../../routes/jobs/research-chat-tools');

const USER = 'tester@example.com';
const BOOK_ID = 70001;
const NOW = '2026-01-01T00:00:00.000Z';

// Seed: Buch + ein Recherche-Item.
db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK_ID, NOW, NOW);
const itemRes = db.prepare(
  `INSERT INTO research_items (book_id, user_email, kind, title, body, source, created_at, updated_at)
   VALUES (?, ?, 'note', 'Bronzezeit', 'Notiz über Bronzezeit-Grabungen', 'Wikipedia', ?, ?)`
).run(BOOK_ID, USER, NOW, NOW);
const ITEM_ID = itemRes.lastInsertRowid;
db.prepare(
  `INSERT INTO research_item_urls (item_id, url, label, position, created_at) VALUES (?, ?, ?, 0, ?)`
).run(ITEM_ID, 'https://de.wikipedia.org/wiki/Bronzezeit', 'Bronzezeit – Wikipedia', NOW);

const mkCtx = () => ({ bookId: BOOK_ID, userEmail: USER, proposals: [], logger: { warn() {}, info() {} } });

test('list_research_items liefert vorhandene Einträge', async () => {
  const out = await executeResearchTool('list_research_items', {}, mkCtx());
  assert.ok(Array.isArray(out.items));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].title, 'Bronzezeit');
  assert.equal(out.items[0].kind, 'note');
});

test('read_research_item liefert Volltext inkl. URLs', async () => {
  const out = await executeResearchTool('read_research_item', { id: ITEM_ID }, mkCtx());
  assert.equal(out.id, ITEM_ID);
  assert.match(out.body, /Bronzezeit-Grabungen/);
  assert.equal(out.source, 'Wikipedia');
  assert.ok(Array.isArray(out.urls));
  assert.equal(out.urls.length, 1);
  assert.equal(out.urls[0].url, 'https://de.wikipedia.org/wiki/Bronzezeit');
  assert.equal(out.urls[0].label, 'Bronzezeit – Wikipedia');
});

test('read_research_item: unbekannte id → error', async () => {
  const out = await executeResearchTool('read_research_item', { id: 999999 }, mkCtx());
  assert.ok(out.error);
});

test('list_book_entities liefert Kontext-Kategorien', async () => {
  const out = await executeResearchTool('list_book_entities', {}, mkCtx());
  for (const k of ['figuren', 'schauplaetze', 'szenen', 'plot_abschnitte', 'handlungsstraenge']) {
    assert.ok(Array.isArray(out[k]), `${k} sollte ein Array sein`);
  }
});

test('propose_research_item: gültige Notiz wird in ctx.proposals gesammelt (NICHT persistiert)', async () => {
  const ctx = mkCtx();
  const before = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ?').get(BOOK_ID).n;
  const out = await executeResearchTool('propose_research_item',
    { kind: 'fact', title: 'Fundstück', body: 'Ein Fakt', source: 'https://example.org' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0].kind, 'fact');
  // Kein DB-Insert — der User bestätigt erst im Frontend.
  const after = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ?').get(BOOK_ID).n;
  assert.equal(after, before);
});

test('propose_research_item: mehrere URLs (mit Label) werden gesammelt', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item', {
    kind: 'link', title: 'Mehrere Quellen',
    urls: [
      { url: 'https://example.org/a', label: 'A' },
      { url: 'https://example.org/b' },
      'https://example.org/a', // Duplikat → verworfen
    ],
  }, ctx);
  assert.equal(out.ok, true);
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0].urls.length, 2);
  assert.equal(ctx.proposals[0].urls[0].url, 'https://example.org/a');
  assert.equal(ctx.proposals[0].urls[0].label, 'A');
  assert.equal(ctx.proposals[0].urls[1].label, '');
});

test('propose_research_item: nicht-http(s)-URL ohne gültige URL wird abgelehnt', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item',
    { kind: 'link', title: 'Böse', urls: [{ url: 'javascript:alert(1)' }] }, ctx);
  assert.equal(out.ok, false);
  assert.equal(ctx.proposals.length, 0);
});

test('propose_research_item: leerer Vorschlag wird abgelehnt', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item', { kind: 'note' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(ctx.proposals.length, 0);
});

test('unbekanntes Werkzeug wirft', async () => {
  await assert.rejects(() => executeResearchTool('nope', {}, mkCtx()), /Unbekanntes Werkzeug/);
});

// ── Abgleich mit dem Archiv (Dubletten) ─────────────────────────────────────

test('propose_research_item: URL schon im Archiv → exists_item_id + already_in_archive', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item', {
    kind: 'link', title: 'Bronzezeit nochmal',
    urls: [{ url: 'https://de.wikipedia.org/wiki/Bronzezeit/' }],
  }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.already_in_archive.id, ITEM_ID);
  assert.equal(out.already_in_archive.match, 'url');
  assert.equal(ctx.proposals[0].exists_item_id, ITEM_ID);
  assert.equal(ctx.proposals[0].exists_match, 'url');
});

test('propose_research_item: neuer Fund → kein exists_item_id', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item', {
    kind: 'fact', title: 'Eisenverhüttung im Jura', body: 'Rennöfen ab 600 v. Chr.',
  }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.already_in_archive, undefined);
  assert.equal(ctx.proposals[0].exists_item_id, undefined);
});

test('propose_research_item: gleicher Titel zweimal in einer Antwort → zweiter abgelehnt', async () => {
  const ctx = mkCtx();
  await executeResearchTool('propose_research_item', { kind: 'note', title: 'Schmiedetechnik', body: 'a' }, ctx);
  const out = await executeResearchTool('propose_research_item', { kind: 'note', title: ' schmiedetechnik ', body: 'b' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(ctx.proposals.length, 1);
});

// ── lookup_literature (Register-Suche) ──────────────────────────────────────
// Kein Netz: globalThis.fetch wird pro Test ersetzt. Geprueft wird die Form fuers
// Modell, das Merken der Treffer als zulaessige Belege und dass ein
// ausgefallenes Register als Ausfall gemeldet wird statt als „nichts gefunden".
test('lookup_literature: Crossref-Treffer mit doi.org-URL, OpenLibrary-Ausfall gemeldet, Treffer gemerkt', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.crossref.org/works?')) {
      return new Response(JSON.stringify({ message: { items: [{
        DOI: '10.1000/xyz', type: 'journal-article', title: ['Bronze Age Mining'],
        author: [{ given: 'Ada', family: 'Muster' }], issued: { 'date-parts': [[2019]] },
        'container-title': ['Journal of Archaeology'],
      }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('down', { status: 503 });
  };
  try {
    const ctx = mkCtx();
    const out = await executeResearchTool('lookup_literature', { q: 'bronze age mining' }, ctx);
    assert.equal(out.count, 1);
    assert.deepEqual(out.treffer[0], {
      titel: 'Bronze Age Mining', autoren: 'Ada Muster', jahr: '2019', typ: 'article',
      in: 'Journal of Archaeology', doi: '10.1000/xyz', url: 'https://doi.org/10.1000/xyz', register: 'crossref',
    });
    assert.deepEqual(out.register_ausgefallen, ['openlibrary']);
    assert.deepEqual(ctx.literatureHits, [{ url: 'https://doi.org/10.1000/xyz', title: 'Bronze Age Mining' }]);
  } finally {
    globalThis.fetch = orig;
  }
});

test('lookup_literature: ohne q/doi/isbn → Fehler, kein Request', async () => {
  const orig = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  try {
    const out = await executeResearchTool('lookup_literature', {}, mkCtx());
    assert.ok(out.error);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('propose_research_item: Fehler tragen errorKey', async () => {
  const ctx = mkCtx();
  assert.equal((await executeResearchTool('propose_research_item', { kind: 'note' }, ctx)).errorKey, 'chat.toolError.proposalEmpty');
  const bad = await executeResearchTool('propose_research_item', { kind: 'link', title: 'X', urls: [{ url: 'javascript:alert(1)' }] }, ctx);
  assert.equal(bad.errorKey, 'chat.toolError.invalidParam');
  assert.deepEqual(bad.errorParams, { param: 'urls' });
  await executeResearchTool('propose_research_item', { kind: 'note', title: 'Hafen Genua' }, ctx);
  assert.equal((await executeResearchTool('propose_research_item', { kind: 'note', title: 'hafen genua' }, ctx)).errorKey, 'chat.toolError.proposalDuplicate');
  const full = mkCtx();
  for (let i = 0; i < 12; i++) await executeResearchTool('propose_research_item', { kind: 'note', title: `Fund ${i}` }, full);
  const cap = await executeResearchTool('propose_research_item', { kind: 'note', title: 'Fund 99' }, full);
  assert.equal(cap.errorKey, 'chat.toolError.proposalCap');
  assert.deepEqual(cap.errorParams, { max: 12 });
});

test('propose_research_item: dieselbe URL (normalisiert) in einer Antwort nur einmal', async () => {
  const ctx = mkCtx();
  const a = await executeResearchTool('propose_research_item', { kind: 'link', title: 'Eins', urls: [{ url: 'https://www.ex.org/artikel?utm_source=x' }] }, ctx);
  assert.equal(a.ok, true);
  const b = await executeResearchTool('propose_research_item', { kind: 'fact', title: 'Ganz anderer Titel', urls: [{ url: 'http://ex.org/artikel/' }] }, ctx);
  assert.equal(b.ok, false);
  assert.equal(b.errorKey, 'chat.toolError.proposalDuplicate');
  assert.equal(ctx.proposals.length, 1);
});

test('mergeProposal: edits.urls nur als Teilmenge der eigenen URLs, nie neue', () => {
  const { mergeProposal } = require('../../routes/research-chat-proposals');
  const p = { kind: 'link', title: 'T', urls: [{ url: 'https://a.example/x', label: 'A', verified: true }, { url: 'https://b.example/y', label: 'B', verified: false }] };
  assert.deepEqual(mergeProposal(p, {}).urls.map(u => u.url), ['https://a.example/x', 'https://b.example/y'], 'ohne edits.urls: alle');
  assert.deepEqual(mergeProposal(p, { urls: ['https://a.example/x'] }).urls, [{ url: 'https://a.example/x', label: 'A' }], 'Label bleibt, verified fällt weg');
  assert.deepEqual(mergeProposal(p, { urls: [{ url: 'http://www.b.example/y/' }] }).urls.map(u => u.url), ['https://b.example/y'], 'normalisiert verglichen, gespeicherter String');
  assert.deepEqual(mergeProposal(p, { urls: ['https://evil.example/leak', 'https://a.example/x'] }).urls.map(u => u.url), ['https://a.example/x'], 'neue URL ignoriert');
  assert.deepEqual(mergeProposal(p, { urls: [] }).urls, [], 'alle weggelassen');
});
