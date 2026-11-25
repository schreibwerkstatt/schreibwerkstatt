// Übernehmen/Verwerfen der Chat-Vorschläge an einem Ort (public/js/chat/proposal-status.js):
//  - ein Prädikat «übernehmbar» für Knopf UND Code — eine Blockade sperrt nicht,
//    wenn das Board schon geschrieben ist und nur der Status fehlt (`_written`);
//  - die Beleg-Prüfung eines «erledigt» (Abschnitts- und Ideen-Chat) als eine
//    Funktion mit einheitlichem Fehlerverhalten;
//  - Erfassen einer Chat-Idee: scheitert nur der Status, eigener Hinweis;
// dazu die Chat-Abläufe «Neues Gespräch» im Buch-Chat (Cache-Wurf best effort),
// Erledigt-Check bei laufendem Lauf und die Zähl-Texte des Chat-Bereichs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const navStore = { selectedBookId: 7 };
globalThis.window = globalThis.window || {};
window.__app = {
  t: (k) => k,
  tn: (k, n) => `TN:${k}:${n}`,
  appConfirm: async () => false,
};
window.Alpine = { store: (name) => (name === 'nav' ? navStore : name === 'badges' ? {} : {}) };
window.dispatchEvent = () => {};
globalThis.Alpine = window.Alpine;

const ps = await import('../../public/js/chat/proposal-status.js');
const ideenMod = await import('../../public/js/chat/ideen-chat-proposals.js');
const { ideenChatMethods } = await import('../../public/js/chat/ideen-chat.js');
const { plotChatMethods } = await import('../../public/js/chat/plot-chat.js');
const { chatIdeeProposalMethods } = await import('../../public/js/chat/chat-idee-proposals.js');
const { bookChatMethods } = await import('../../public/js/chat/book-chat.js');

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    const res = await handler(String(url), opts || {}, calls.length);
    if (res instanceof Error) throw res;
    const { status = 200, body = {} } = res;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; window.__app.appConfirm = async () => false; });

// ── 1. «übernehmbar» an einem Ort ───────────────────────────────────────────

test('proposalCanApply: Blockade sperrt nur, solange das Board nicht geschrieben ist', () => {
  const blocked = { state: 'open', blocked: { key: 'x' } };
  assert.equal(ps.proposalCanApply(blocked, {}), false);
  assert.equal(ps.proposalCanApply(blocked, { _written: true }), true);
  assert.equal(ps.proposalCanApply({ state: 'open', blocked: null }, {}), true);
  assert.equal(ps.proposalCanApply({ state: 'applied', blocked: null }, { _written: true }), false);
});

test('Ideen-Chat: Knopf-Prädikat lässt «nur Status nachholen» trotz Blockade zu', () => {
  const msg = { id: 1, context_info: { proposals: [{ type: 'idee_update', idee_id: 404, fields: { status: 'erledigt' }, before: {} }] } };
  const card = { ...ideenChatMethods, ideen: [], stages: null, busy: false };
  assert.equal(card.ideenProposalCanApply(msg, 0), false, 'Idee weg, nichts geschrieben → gesperrt');
  msg.context_info.proposals[0]._written = true;
  assert.equal(card.ideenProposalCanApply(msg, 0), true, 'Board schon geschrieben → Status nachholbar');
  card.busy = true;
  assert.equal(card.ideenProposalCanApply(msg, 0), false, 'busy sperrt');
});

test('Plot-Chat: gleiches Prädikat', () => {
  const msg = { id: 1, context_info: { proposals: [{ type: 'beat_update', beat_id: 9, fields: { titel: 'x' }, before: {} }] } };
  const card = { ...plotChatMethods, beats: [], acts: [], threads: [], relations: [], busy: false };
  assert.equal(card.plotProposalCanApply(msg, 0), false);
  msg.context_info.proposals[0]._written = true;
  assert.equal(card.plotProposalCanApply(msg, 0), true);
});

test('Templates: Übernehmen-Knopf fragt das Prädikat, nicht die Blockade', () => {
  // Kopf der Karte (geteilt von Plot- und Ideen-Chat): der Knopf liest `pv.canApply`.
  const head = read('public/partials/chat-vorschlag-board-head.html');
  assert.match(head, /:disabled="!pv\.canApply"/);
  assert.doesNotMatch(head, /:disabled="[^"]*blocked/);
  // Beide Chats binden ihr Anzeige-Modell und den Kopf ein.
  for (const [file, view] of [['public/partials/ideen-chat.html', 'ideenProposalView'], ['public/partials/plot-chat.html', 'plotProposalView']]) {
    const src = read(file);
    assert.match(src, new RegExp(`return ${view}\\(msg, pi\\)`), file);
    assert.match(src, /<!-- @include chat-vorschlag-board-head -->/, file);
    assert.doesNotMatch(src, /:disabled="[^"]*ProposalStatus\(msg, pi\)\.blocked/, file);
  }
  // `pv.canApply` IST das Prädikat (nicht die Blockade): blockiert, aber schon geschrieben → klickbar.
  assert.match(read('public/js/chat/proposal-status.js'), /canApply: this\[n\.canApply\]\(msg, pi\)/);
});

test('Verwerfen/Übernehmen aus der Fabrik', () => {
  assert.equal(typeof ps.makeProposalApplyMethods, 'function');
  assert.equal(typeof ps.proposalBaseState, 'function');
  assert.equal(ps.proposalBaseState({ applied_at: 'x' }), 'applied');
  assert.equal(ps.proposalBaseState({ status: 'discarded' }), 'discarded');
  assert.equal(ps.proposalBaseState({}), 'open');
});

// ── 3. Beleg-Prüfung als eine Funktion ──────────────────────────────────────

test('confirmIdeeBeleg: Prüf-Fehler bricht mit Meldung ab, fehlender Beleg nur nach Rückfrage', async () => {
  const msg = { id: 3 };
  const p = { type: 'idee_update', fields: { status: 'erledigt' }, beleg: { text: 'Zitat' } };
  mockFetch(() => new TypeError('offline'));
  assert.equal(await ideenMod.confirmIdeeBeleg(msg, 0, p, (s) => s), false);
  assert.ok(p._error, 'Meldung gesetzt');

  delete p._error;
  mockFetch(() => ({ body: { checked: true, found: false } }));
  let asked = null;
  window.__app.appConfirm = async ({ message }) => { asked = message; return false; };
  assert.equal(await ideenMod.confirmIdeeBeleg(msg, 0, p, (s) => `L:${s}`), false);
  assert.equal(p._belegMissing, true);
  assert.equal(asked, 'ideenBoard.chat.belegGoneConfirm');

  window.__app.appConfirm = async () => true;
  assert.equal(await ideenMod.confirmIdeeBeleg(msg, 0, p, (s) => s), true);
  mockFetch(() => ({ body: { checked: true, found: true } }));
  assert.equal(await ideenMod.confirmIdeeBeleg(msg, 0, p, (s) => s), true);
  assert.equal(p._belegMissing, false);
  assert.equal(await ideenMod.confirmIdeeBeleg(msg, 0, { type: 'idee_update' }, (s) => s), true, 'ohne Beleg nichts zu prüfen');
});

test('Beleg-Prüf-Route steht an genau einer Stelle im Chat-Frontend', () => {
  const dir = join(ROOT, 'public/js/chat');
  const hits = readdirSync(dir).filter(f => f.endsWith('.js') && read(`public/js/chat/${f}`).includes('/ideen/chat-proposal/beleg-check'));
  assert.deepEqual(hits, ['ideen-chat-proposals.js']);
});

// ── 4. Chat-Idee erfassen: nur der Status scheitert ─────────────────────────

test('captureChatIdee: Idee angelegt, Status-PATCH scheitert → Status-Hinweis', async () => {
  const msg = { id: 9, role: 'assistant', context_info: { proposals: [{ type: 'idee_create', fields: { content: 'Neu', page_id: 3 } }] } };
  mockFetch((url, opts) => {
    if (url === '/ideen' && opts.method === 'POST') return { body: { id: 55, page_id: 3 } };
    const b = JSON.parse(opts.body || '{}');
    if (b.action === 'claim') return { body: { proposal: { type: 'idee_create', claimed_at: 'C' } } };
    return { status: 500, body: { error_code: 'INTERNAL' } };
  });
  const card = { ...chatIdeeProposalMethods, chatMessages: [msg] };
  await card.captureChatIdee(msg, 0);
  const p = msg.context_info.proposals[0];
  assert.equal(p._written, true);
  assert.equal(p._error, 'chat.ideeCaptureStatusError');
});

// ── 5. Buch-Chat: Cache-Wurf best effort ────────────────────────────────────

test('Buch-Chat «Neu»: scheitert der Cache-Wurf, wird die Session trotzdem angelegt', async () => {
  const calls = mockFetch((url, opts) => {
    if (url.startsWith('/jobs/book-chat-cache')) return new TypeError('offline');
    if (url === '/chat/session/book' && opts.method === 'POST') return { body: { id: 91 } };
    if (url.startsWith('/chat/sessions/book/')) return { body: [] };
    return { status: 404, body: {} };
  });
  const card = {
    ...bookChatMethods,
    bookChatSessions: [], bookChatMessages: [], bookChatSessionId: null, bookChatInput: '',
    bookChatLoading: false, bookChatRunningSessionId: null, bookChatStatus: '', bookChatProgress: 0,
    _bookChatPollTimer: null, _bookChatGen: 0, $nextTick: (fn) => fn(),
  };
  await card.startNewBookChatSession();
  assert.equal(card.bookChatSessionId, 91);
  assert.ok(calls.some(c => c.url.startsWith('/jobs/book-chat-cache')));
});

// ── 6. Zähl-Texte ───────────────────────────────────────────────────────────

test('Buch-Chat-Retrieval-Hinweis zählt über tn()', () => {
  const note = bookChatMethods._bookChatRetrievalNote({ context_info: { retrievalMode: 'keyword', freshPages: 1 } });
  assert.match(note, /TN:chat\.retrieval\.freshPages:1/);
});

test('Zähl-Keys des Chat-Bereichs haben Einzahl-Form in beiden Locales', () => {
  const de = JSON.parse(read('public/js/i18n/de.json'));
  const en = JSON.parse(read('public/js/i18n/en.json'));
  for (const k of ['chat.retrieval.freshPages', 'chat.historySearch.indexing', 'chat.toolFinalCitationsBad', 'recherche.chat.proposalSaveAll']) {
    for (const [loc, m] of [['de', de], ['en', en]]) {
      assert.ok(m[k], `${loc}: ${k}`);
      assert.ok(m[k + 'One'], `${loc}: ${k}One`);
    }
  }
  assert.doesNotMatch(read('public/js/chat/chat-history-search.js'), /\.t\('chat\.historySearch\.indexing'/);
  assert.doesNotMatch(read('public/js/chat/tool-log.js'), /t\('chat\.toolFinalCitationsBad'/);
  assert.doesNotMatch(read('public/partials/recherche-chat.html'), /\$app\.t\('recherche\.chat\.proposalSaveAll'/);
});

// ── 7. Erledigt-Check bei laufendem Lauf ────────────────────────────────────

test('Erledigt-Check während eines Laufs: Frage landet im Eingabefeld, nichts verpufft', async () => {
  const drafts = [];
  let sent = 0;
  const card = {
    ...ideenChatMethods,
    ideenChatOpen: true, ideenChatLoading: true,
    prepareIdeenChatDraft: async (text) => { drafts.push(text); },
    sendIdeenChatMessage: async () => { sent++; },
    startNewIdeenChatSession: async () => {},
  };
  await card.startIdeenErledigtCheck();
  assert.deepEqual(drafts, ['ideenBoard.chat.starter.erledigt']);
  assert.equal(sent, 0);
});
