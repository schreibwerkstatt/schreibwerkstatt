'use strict';
// Suche im Chat-Verlauf (docs/chats.md#suche-im-verlauf): FTS-Trigger, Scope
// (Buch, User, Chat-Art, Abschnitt), Runden-Fusion von Wortlaut + Bedeutung,
// Index-Job `chat-embed-index`, Escaping der Ausschnitte und das Buch-Chat-
// Werkzeug `search_chat_history`. Embedding-Endpunkt gestubbt (kein Netz).

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('chat-search');

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const chatSearchDb = require('../../db/chat-search');
const embed = require('../../lib/embed');
const { searchChatHistory } = require('../../lib/chat-search');

const A = 'cs-a@example.com';
const B = 'cs-b@example.com';
const BOOK = 84001;
const OTHER_BOOK = 84002;
const P1 = 840011;
const P2 = 840012;
const MODEL = 'test-embed';
const DIM = 3;

appUsers.createUser({ email: A });
appUsers.createUser({ email: B });
for (const b of [BOOK, OTHER_BOOK]) {
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'CS', ?, ?)`).run(b, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
}
for (const p of [P1, P2]) db.prepare('INSERT INTO pages (page_id, book_id, page_name) VALUES (?, ?, ?)').run(p, BOOK, `Abschnitt ${p}`);

const ISO = '2026-10-05T10:00:00.000Z';
function session(kind, { book = BOOK, user = A, page = null } = {}) {
  return db.prepare(`INSERT INTO chat_sessions (book_id, page_id, kind, user_email, created_at, last_message_at)
                     VALUES (?, ?, ?, ?, ?, ?)`).run(book, page, kind, user, ISO, ISO).lastInsertRowid;
}
function msg(sid, role, content) {
  return db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(sid, role, content, ISO).lastInsertRowid;
}

// Bedeutungs-Stub: Wörter derselben Gruppe landen auf demselben Vektor.
const GROUPS = [['abschied', 'lebewohl', 'trennung'], ['wetter', 'regen', 'gewitter']];
function vec(text) {
  const t = String(text).toLowerCase();
  const v = new Float32Array(DIM);
  GROUPS.forEach((g, i) => { if (g.some(w => t.includes(w))) v[i] = 1; });
  if (!v.some(Boolean)) v[DIM - 1] = 1;
  return v;
}
function withEmbed(fn) {
  const orig = { isEnabled: embed.isEnabled, getConfig: embed.getConfig, embedBatch: embed.embedBatch, embedQuery: embed.embedQuery };
  let batched = 0;
  embed.isEnabled = () => true;
  embed.getConfig = () => ({ model: MODEL, dim: DIM, passagePrefix: '', queryPrefix: '' });
  embed.embedBatch = async (texts) => { batched += texts.length; return texts.map(vec); };
  embed.embedQuery = async (text) => vec(text);
  return Promise.resolve(fn(() => batched)).finally(() => Object.assign(embed, orig));
}
async function runIndex(bookId) {
  const shared = require('../../routes/jobs/shared');
  const { runChatEmbedIndexJob } = require('../../routes/jobs/chat-embed-index');
  const jobId = shared.createJob('chat-embed-index', bookId, null, 'job.label.chatEmbedIndex', null, bookId);
  await runChatEmbedIndexJob(jobId, bookId);
  const job = shared.jobs.get(jobId);
  assert.equal(job.status, 'done', job.error);
  return job.result;
}

// Fixture: A hat Abschnitts-Chats auf P1 + P2 und einen Buch-Chat; B einen Buch-Chat
// im selben Buch; A einen Buch-Chat in einem anderen Buch.
const sP1 = session('page', { page: P1 });
const uP1 = msg(sP1, 'user', 'Ist Lenas Augenfarbe konsistent?');
const aP1 = msg(sP1, 'assistant', 'Hier grün, in Kapitel 2 blau — das widerspricht sich.');
const sP2 = session('page', { page: P2 });
msg(sP2, 'user', 'Wie wirkt der Abschied am Bahnhof?');
const aP2 = msg(sP2, 'assistant', 'Der Abschied von Lena ist leise und trägt die Szene.');
const sBook = session('book');
msg(sBook, 'user', 'Wo regnet es im Buch?');
const aBook = msg(sBook, 'assistant', 'Das Gewitter in Kapitel 4 spiegelt Lenas Stimmung. <script>x</script>');
const sB = session('book', { user: B });
msg(sB, 'user', 'Lena und der Abschied?');
msg(sB, 'assistant', 'Lena verabschiedet sich.');
const sOther = session('book', { book: OTHER_BOOK });
msg(sOther, 'user', 'Lena im anderen Buch');
msg(sOther, 'assistant', 'Fremdes Buch.');
// Marker-Antwort: kein Gesprächsinhalt, wird nie vektorisiert.
msg(sBook, 'user', 'Noch eine Frage');
msg(sBook, 'assistant', '__i18n:chat.fallbackAnswer__');

test('Wortlaut: Scope Buch + User + Chat-Art + Abschnitt', async () => {
  const onP1 = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Lena', kinds: ['page'], pageId: P1 });
  assert.deepEqual(onP1.hits.map(h => h.session_id), [sP1]);
  assert.equal(onP1.semantic, false);

  const pages = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Lena', kinds: ['page'] });
  assert.deepEqual(new Set(pages.hits.map(h => h.session_id)), new Set([sP1, sP2]));
  assert.ok(pages.hits.every(h => h.kind === 'page' && h.page_name));

  const book = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Lena', kinds: ['book'] });
  assert.deepEqual(book.hits.map(h => h.session_id), [sBook], 'weder B noch das andere Buch');
});

test('Runde: Treffer in der Frage zählt zur Runde der Antwort, springt zur Frage', async () => {
  const r = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Augenfarbe', kinds: ['page'] });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].message_id, uP1);
  assert.equal(r.hits[0].round_id, aP1);
  assert.equal(r.hits[0].match, 'text');
  assert.match(r.hits[0].snippet, /<mark>Augenfarbe<\/mark>/);
});

test('Ausschnitt ist escaped — nur <mark> ist Markup', async () => {
  const r = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Gewitter', kinds: ['book'] });
  assert.equal(r.hits[0].message_id, aBook);
  assert.ok(!r.hits[0].snippet.includes('<script>'));
  assert.match(r.hits[0].snippet, /&lt;script&gt;/);
});

test('Index-Job: vektorisiert offene Runden aller User, Marker nie, zweiter Lauf nichts', async () => {
  await withEmbed(async (batched) => {
    assert.equal(chatSearchDb.countUnindexedRounds(BOOK, MODEL), 4);
    const res = await runIndex(BOOK);
    assert.equal(res.rounds, 4);
    assert.equal(chatSearchDb.countUnindexedRounds(BOOK, MODEL), 0);
    assert.equal(chatSearchDb.countUnindexedRounds(OTHER_BOOK, MODEL), 1, 'anderes Buch bleibt offen');
    const before = batched();
    await runIndex(BOOK);
    assert.equal(batched(), before, 'nichts neu embeddet');
    const text = db.prepare('SELECT text FROM chat_semantic_chunks WHERE message_id = ?').get(aP1).text;
    assert.match(text, /Augenfarbe/, 'Frage gehört in den Runden-Text');
    assert.match(text, /Kapitel 2 blau/);
  });
});

test('Bedeutung: findet die Runde ohne gemeinsames Wort, fusioniert mit Wortlaut', async () => {
  await withEmbed(async () => {
    const meaning = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Lebewohl', kinds: ['page'] });
    assert.equal(meaning.semantic, true);
    assert.equal(meaning.hits[0].round_id, aP2);
    assert.equal(meaning.hits[0].message_id, aP2, 'reiner Bedeutungs-Treffer springt zur Antwort');
    assert.equal(meaning.hits[0].match, 'meaning');

    const both = await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Abschied', kinds: ['page'] });
    assert.equal(both.hits[0].round_id, aP2);
    assert.equal(both.hits[0].match, 'both');
    assert.equal(both.hits.filter(h => h.round_id === aP2).length, 1, 'Frage + Antwort = ein Treffer');

    const otherUser = await searchChatHistory({ bookId: BOOK, userEmail: B, query: 'Lebewohl', kinds: ['page'] });
    assert.equal(otherUser.hits.length, 0, 'Vektoren anderer User bleiben unsichtbar');
  });
});

test('Session gelöscht → FTS-Einträge und Vektoren per Trigger/CASCADE weg', async () => {
  const s = session('book');
  msg(s, 'user', 'Zebrastreifen');
  const a = msg(s, 'assistant', 'Der Zebrastreifen steht in Kapitel 9.');
  await withEmbed(() => runIndex(BOOK));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_semantic_chunks WHERE message_id = ?').get(a).n > 0, true);
  assert.equal((await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Zebrastreifen', kinds: ['book'] })).hits.length, 1);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(s);
  assert.equal((await searchChatHistory({ bookId: BOOK, userEmail: A, query: 'Zebrastreifen', kinds: ['book'] })).hits.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_semantic_chunks WHERE message_id = ?').get(a).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM chat_messages_fts WHERE chat_messages_fts MATCH '"Zebrastreifen"'`).get().n, 0);
});

test('Werkzeug search_chat_history: laufendes Gespräch ausgenommen, Scope-Filter', async () => {
  const { executeTool } = require('../../routes/jobs/book-chat-tools');
  const ctx = { bookId: BOOK, userEmail: A, sessionId: sBook };
  const all = await executeTool('search_chat_history', { query: 'Lena' }, ctx);
  assert.deepEqual(new Set(all.results.map(r => r.session_id)), new Set([sP1, sP2]), 'laufender Buch-Chat fehlt');
  assert.ok(all.results.every(r => !r.snippet.includes('<mark>')), 'Klartext fürs Modell');
  const book = await executeTool('search_chat_history', { query: 'Gewitter', scope: 'book' }, { ...ctx, sessionId: null });
  assert.deepEqual(book.results.map(r => r.session_id), [sBook]);
  const missing = await executeTool('search_chat_history', {}, ctx);
  assert.equal(missing.errorKey, 'chat.toolError.missingParam');
});
