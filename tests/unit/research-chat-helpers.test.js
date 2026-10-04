'use strict';
// Recherche-Chat: reine Hilfen + Verfügbarkeits-Gate.
//  - toolsForRound: Web-Such-Gesamtdeckel (max_uses schrumpft, Werkzeug fällt weg)
//  - validateAnswerSources: final_answer.quellen nur gegen echte Web-Treffer
//  - proposalsOnlyFallback: leere Antwort + Vorschläge ≠ „Iterationen erschöpft"
//  - sessionProposalMemory: frühere Vorschläge samt Gespeichert-Status
//  - researchChatGate: Kill-Switch / Claude-only / API-Key (vor dem Speichern der Frage)
//  - findDuplicateItem: URL-/Titel-Abgleich mit dem Archiv

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('rch');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/schema');
const {
  toolsForRound, validateAnswerSources, proposalsOnlyFallback, sessionProposalMemory,
} = require('../../routes/jobs/research-chat-helpers');
const { researchChatGate } = require('../../lib/research-chat-gate');
const appSettings = require('../../lib/app-settings');
const { findDuplicateItem, createItem } = require('../../db/research-items');

const NOW = '2026-01-01T00:00:00.000Z';
const USER = 'tester@example.com';

const WEB = { type: 'web_search_20250305', name: 'web_search', max_uses: 6 };
const LIST = { name: 'list_research_items' };
const FINAL = { name: 'final_answer' };
const BASE = [WEB, LIST, FINAL];

// ── Web-Such-Deckel ─────────────────────────────────────────────────────────

test('toolsForRound: Rest ≥ Rundenwert → identisches Objekt (Prompt-Cache bleibt)', () => {
  const out = toolsForRound(BASE, 2, 10);
  assert.equal(out[0], WEB, 'unverändertes web_search-Objekt');
  assert.equal(out.length, 3);
});

test('toolsForRound: Rest < Rundenwert → max_uses = Rest', () => {
  const out = toolsForRound(BASE, 7, 10);
  const ws = out.find(t => t.name === 'web_search');
  assert.equal(ws.max_uses, 3);
  assert.equal(WEB.max_uses, 6, 'Basisliste nicht mutiert');
});

test('toolsForRound: Deckel erreicht → web_search fällt weg, Rest bleibt', () => {
  const out = toolsForRound(BASE, 10, 10);
  assert.deepEqual(out.map(t => t.name), ['list_research_items', 'final_answer']);
  assert.deepEqual(toolsForRound(BASE, 12, 10).map(t => t.name), ['list_research_items', 'final_answer']);
});

test('toolsForRound: Deckel kleiner als Rundenwert greift schon in Runde 1', () => {
  const ws = toolsForRound(BASE, 0, 4).find(t => t.name === 'web_search');
  assert.equal(ws.max_uses, 4);
});

// ── Quellen-Validierung ─────────────────────────────────────────────────────

const RESULTS = [
  { url: 'https://example.org/a', title: 'A' },
  { url: 'https://example.org/b?utm_source=x', title: 'B' },
  { url: 'https://example.org/a', title: 'A (nochmal)' },
];

test('validateAnswerSources: nur URLs aus den Web-Treffern, normalisiert, mit doc_nums', () => {
  const out = validateAnswerSources([
    { url: 'https://www.example.org/a/', titel: 'Artikel A' },
    { url: 'https://erfunden.example/x', titel: 'Halluziniert' },
    { url: 'http://example.org/b' },
    { url: 'https://example.org/a' },          // Dublette → einmal
    'kein-url',
  ], RESULTS);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://example.org/a');
  assert.equal(out[0].title, 'Artikel A');
  assert.deepEqual(out[0].doc_nums, [1, 3]);
  assert.equal(out[1].title, 'B', 'ohne titel → Titel des Treffers');
  assert.deepEqual(out[1].doc_nums, [2]);
});

test('validateAnswerSources: ohne Treffer oder ohne Angabe → []', () => {
  assert.deepEqual(validateAnswerSources([{ url: 'https://example.org/a' }], []), []);
  assert.deepEqual(validateAnswerSources(null, RESULTS), []);
  assert.deepEqual(validateAnswerSources('x', RESULTS), []);
});

// ── Leere Antwort ───────────────────────────────────────────────────────────

test('proposalsOnlyFallback: leer/Abbruch-Marker + Vorschläge → eigener Hinweis', () => {
  const M = '__i18n:recherche.chat.proposalsOnly__';
  assert.equal(proposalsOnlyFallback('', 2), M);
  assert.equal(proposalsOnlyFallback('__i18n:chat.errors.maxIterReached__', 1), M);
  assert.equal(proposalsOnlyFallback('__i18n:chat.errors.emptyAnswer__', 1), M);
  assert.equal(proposalsOnlyFallback('', 0), '');
  assert.equal(proposalsOnlyFallback('Antwort', 3), 'Antwort');
});

// ── Gate ────────────────────────────────────────────────────────────────────

test('researchChatGate: Kill-Switch, Provider, API-Key', () => {
  appSettings.set('ai.provider', 'claude');
  appSettings.set('ai.claude.api_key', 'sk-test');
  appSettings.set('research_chat.enabled', true);
  assert.equal(researchChatGate(USER), null);

  appSettings.set('research_chat.enabled', false);
  assert.equal(researchChatGate(USER).error_code, 'RESEARCH_CHAT_DISABLED');
  assert.equal(researchChatGate(USER).status, 403);
  appSettings.set('research_chat.enabled', true);

  appSettings.set('ai.provider', 'ollama');
  const b = researchChatGate(USER);
  assert.equal(b.error_code, 'RESEARCH_CHAT_CLAUDE_ONLY');
  assert.equal(b.i18nKey, 'job.error.researchChatClaudeOnly');
  appSettings.set('ai.provider', 'claude');

  appSettings.set('ai.claude.api_key', '');
  assert.equal(researchChatGate(USER).error_code, 'RESEARCH_CHAT_DISABLED');
});

// ── Archiv-Abgleich + Session-Gedächtnis ────────────────────────────────────

const BOOK_ID = 71001;
db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK_ID, NOW, NOW);

test('findDuplicateItem: URL normalisiert, Titel case-insensitiv, archivierte ignoriert', () => {
  const id = createItem({
    bookId: BOOK_ID, userEmail: USER, kind: 'link', title: 'Die Bronzezeit in Europa',
    urls: [{ url: 'https://www.example.org/bronze/' }],
  });
  const byUrl = findDuplicateItem(BOOK_ID, { urls: ['http://example.org/bronze?utm_medium=x'] });
  assert.equal(byUrl.id, id);
  assert.equal(byUrl.match, 'url');
  const byTitle = findDuplicateItem(BOOK_ID, { title: '  «die bronzezeit  in europa» ' });
  assert.equal(byTitle.id, id);
  assert.equal(byTitle.match, 'title');
  assert.equal(findDuplicateItem(BOOK_ID, { title: 'Notiz' }), null, 'kurzer Titel matcht nie');
  assert.equal(findDuplicateItem(BOOK_ID + 1, { urls: ['https://example.org/bronze'] }), null, 'anderes Buch');
  db.prepare('UPDATE research_items SET archived = 1 WHERE id = ?').run(id);
  assert.equal(findDuplicateItem(BOOK_ID, { urls: ['https://example.org/bronze'] }), null, 'archiviert');
});

test('sessionProposalMemory: Vorschläge aller Antworten samt saved_item_id', () => {
  const sid = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'research', ?, ?, ?)"
  ).run(BOOK_ID, USER, NOW, NOW).lastInsertRowid;
  const ins = db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'x', ?, ?)"
  );
  ins.run(sid, JSON.stringify({ proposals: [{ kind: 'fact', title: 'Erster', saved_item_id: 5 }] }), '2026-01-01T00:00:01.000Z');
  ins.run(sid, JSON.stringify({ tool_calls: [] }), '2026-01-01T00:00:02.000Z');
  ins.run(sid, JSON.stringify({ proposals: [{ kind: 'link', urls: [{ url: 'https://e.org' }], exists_item_id: 9 }] }), '2026-01-01T00:00:03.000Z');
  const mem = sessionProposalMemory(sid);
  assert.deepEqual(mem, [
    { title: 'Erster', kind: 'fact', saved_item_id: 5, exists_item_id: null },
    { title: 'https://e.org', kind: 'link', saved_item_id: null, exists_item_id: 9 },
  ]);
});

test('validateAnswerSources: Register-Treffer (extra) sind zulässige Belege ohne doc_nums', () => {
  const web = [{ url: 'https://a.example/x', title: 'A' }];
  const extra = [{ url: 'https://doi.org/10.1000/xyz', title: 'Bronze Age Mining' }];
  const out = validateAnswerSources(
    [{ url: 'https://doi.org/10.1000/xyz' }, { url: 'https://a.example/x' }, { url: 'https://nie.gesehen/' }],
    web, { extra },
  );
  assert.deepEqual(out, [
    { url: 'https://doi.org/10.1000/xyz', title: 'Bronze Age Mining', doc_nums: [] },
    { url: 'https://a.example/x', title: 'A', doc_nums: [1] },
  ]);
  // Nur Register-Treffer, keine Web-Suche gelaufen.
  assert.equal(validateAnswerSources([{ url: 'https://doi.org/10.1000/xyz' }], [], { extra }).length, 1);
});

// ── Schreibkontext (Kontext-Chip) ───────────────────────────────────────────

test('researchMessageContext / loadResearchContext: nur Stellen des eigenen Buchs, Auszug + verknüpftes Material', async () => {
  const { researchMessageContext, loadResearchContext } = require('../../routes/jobs/research-chat-helpers');
  db.prepare("INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at) VALUES (81001, 'Kontext', ?, ?), (81002, 'Fremd', ?, ?)").run(NOW, NOW, NOW, NOW);
  db.prepare("INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (8101, 81001, 'Kap Eins', 1, ?)").run(NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, chapter_id, page_name, position, updated_at, body_html) VALUES (810101, 81001, 8101, 'Hafen', 1, ?, '<p>Im Hafen von Genua, 1492.</p>')").run(NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html) VALUES (810201, 81002, 'Fremdseite', 1, ?, '<p>x</p>')").run(NOW);
  const item = db.prepare("INSERT INTO research_items (book_id, user_email, kind, title) VALUES (81001, ?, 'fact', 'Genua 1492')").run(USER).lastInsertRowid;
  db.prepare("INSERT INTO research_item_links (item_id, target_kind, page_id) VALUES (?, 'page', 810101)").run(item);

  assert.deepEqual(researchMessageContext({ kind: 'page', id: 810101 }, 81001), { research_context: { kind: 'page', id: 810101 } });
  assert.equal(researchMessageContext({ kind: 'page', id: 810201 }, 81001), null, 'fremdes Buch');
  assert.equal(researchMessageContext({ kind: 'figure', id: 1 }, 81001), null);
  assert.equal(researchMessageContext(null, 81001), null);

  const page = await loadResearchContext({ kind: 'page', id: 810101 }, 81001);
  assert.equal(page.name, 'Hafen');
  assert.match(page.excerpt, /Genua, 1492/);
  assert.deepEqual(page.items.map(i => i.title), ['Genua 1492']);

  const chap = await loadResearchContext({ kind: 'chapter', id: 8101 }, 81001);
  assert.equal(chap.name, 'Kap Eins');
  assert.match(chap.excerpt, /Genua/);
  assert.deepEqual(chap.items.map(i => i.id), [item], 'Kapitel umfasst die Seiten-Verknüpfung');

  assert.equal(await loadResearchContext({ kind: 'page', id: 810201 }, 81001), null);
});

test('buildResearchWritingContextBlock: Stelle, Auszug mit Schreibverbot, verknüpftes Material', async () => {
  const { buildResearchWritingContextBlock } = await import('../../public/js/prompts/recherche.js');
  assert.equal(buildResearchWritingContextBlock(null), '');
  const out = buildResearchWritingContextBlock({
    kind: 'chapter', name: 'Kap Eins', excerpt: 'Im Hafen.', items: [{ id: 7, kind: 'fact', status: 'offen', title: 'Genua' }],
  });
  assert.match(out, /Kapitel «Kap Eins»/);
  assert.match(out, /NICHT umschreiben/);
  assert.match(out, /id=7 \[fact, offen\] Genua/);
});
