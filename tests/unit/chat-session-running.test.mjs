// Tests für chat-base.js (makeChatMethods) — geteilte Basis von Seiten-,
// Buch- und Recherche-Chat.
//
// Gegenstand ist die Trennung „Lauf gehört einer Session, nicht der Karte":
//   - Senden trägt das Gespräch sofort in die Historie ein (der Server hat die
//     User-Nachricht bereits persistiert; die Liste führt nur Sessions MIT
//     Nachrichten, ohne Refresh fehlt der laufende Chat also ganz).
//   - is<L>SessionRunning ist wahr für genau die Session des laufenden Jobs.
//   - Wechselt der User während des Laufs in ein früheres Gespräch, zeigt dort
//     nichts mehr „wird bearbeitet", und das Job-Ende zieht ihn nicht zurück.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChatMethods } from '../../public/js/chat/chat-base.js';

// ── Stubs ────────────────────────────────────────────────────────────────────
globalThis.window = globalThis.window || {};
globalThis.window.__app = { t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k) };

const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
};

// setInterval/clearInterval so ersetzen, dass der Test den Poll-Tick selbst
// auslöst — echte Timer wären hier nur Wartezeit.
let tick = null;
globalThis.setInterval = (fn) => { tick = fn; return 1; };
globalThis.clearInterval = () => { tick = null; };

let routes = new Map();
let calls = [];
globalThis.fetch = async (url, opts) => {
  const key = String(url);
  calls.push({ url: key, method: opts?.method || 'GET' });
  // Der Active-Job-Check läuft bei jedem Session-Load mit; ohne Stub wäre er
  // nur 404-Rauschen im Testlauf.
  // Methodenspezifische Route (`'DELETE /chat/session/55'`) vor der URL-Route;
  // `{ __status, __body }` simuliert eine Fehlerantwort, `{ __wait }` hält die
  // Antwort bis zum Auflösen des Promises zurück.
  const mkey = `${opts?.method || 'GET'} ${key}`;
  let body = routes.has(mkey) ? routes.get(mkey)
    : routes.has(key) ? routes.get(key)
    : key.startsWith('/jobs/active') ? { jobId: null }
    : null;
  if (body && body.__wait) { await body.__wait; body = body.__then; }
  if (body && body.__status) {
    const b = body.__body || {};
    return { ok: false, status: body.__status, clone: () => ({ json: async () => b }), json: async () => b };
  }
  if (body === null) return { ok: false, status: 404, clone: () => ({ json: async () => ({}) }), json: async () => ({}) };
  return { ok: true, status: 200, clone: () => ({ json: async () => body }), json: async () => body };
};

const SESSIONS_URL = '/chat/sessions/7';

function makeCard() {
  const methods = makeChatMethods({
    label: 'Chat',
    props: {
      sessions: 'chatSessions',
      messages: 'chatMessages',
      sessionId: 'chatSessionId',
      input: 'chatInput',
      loading: 'chatLoading',
      runningSessionId: 'chatRunningSessionId',
      status: 'chatStatus',
      progress: 'chatProgress',
      pollTimer: '_chatPollTimer',
    },
    scrollElId: 'chat-messages',
    activeJobType: 'chat',
    canOpen: () => true,
    sessionsUrl: () => SESSIONS_URL,
    newSessionUrl: '/chat/session',
    newSessionBody: () => ({}),
    sendUrl: '/jobs/chat',
  });
  return {
    chatSessions: [],
    chatMessages: [],
    chatSessionId: null,
    chatInput: '',
    chatLoading: false,
    chatRunningSessionId: null,
    chatStatus: '',
    chatProgress: 0,
    _chatPollTimer: null,
    $nextTick: (fn) => fn(),
    ...methods,
  };
}

function reset() {
  calls = [];
  routes = new Map();
  tick = null;
  lsStore.clear();
  globalThis.document = { getElementById: () => null };
}

// Einen Poll-Tick fahren und die dadurch ausgelösten Promises abarbeiten.
async function pollTick() {
  const fn = tick;
  assert.ok(fn, 'Poller läuft nicht');
  await fn();
  await new Promise((r) => setImmediate(r));
}

test('Senden trägt das laufende Gespräch sofort in die Historie ein', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatInput = 'Frage';
  routes.set('/jobs/chat', { jobId: 'job-1' });
  routes.set(SESSIONS_URL, [{ id: 100, preview: 'Frage', last_message_at: 'x' }]);

  await c.sendChatMessage();

  assert.equal(c.chatSessions.length, 1, 'Historie kennt das abgefeuerte Gespräch');
  assert.equal(c.chatSessions[0].id, 100);
  assert.ok(calls.some((x) => x.url === SESSIONS_URL), 'Sessions-Liste wurde neu geladen');
  assert.equal(c.chatRunningSessionId, 100);
  assert.equal(c.isChatSessionRunning(100), true);
  assert.equal(c.isChatSessionRunning(42), false);
});

test('isChatSessionRunning ist ohne Lauf für jede Session falsch', () => {
  reset();
  const c = makeCard();
  c.chatRunningSessionId = 100;
  c.chatLoading = false;
  assert.equal(c.isChatSessionRunning(100), false);
  c.chatLoading = true;
  assert.equal(c.isChatSessionRunning(100), true);
  assert.equal(c.isChatSessionRunning(null), false, 'null darf nie „läuft" heissen');
});

test('Wechsel in ein früheres Gespräch: keine Lauf-Anzeige, kein Zurückspringen', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatInput = 'Frage';
  routes.set('/jobs/chat', { jobId: 'job-1' });
  routes.set(SESSIONS_URL, [
    { id: 100, preview: 'Frage', last_message_at: 'b' },
    { id: 55, preview: 'Alt', last_message_at: 'a' },
  ]);
  routes.set('/chat/session/55', { id: 55, messages: [{ role: 'user', content: 'Alt' }] });
  await c.sendChatMessage();

  // In die historische Session wechseln, während der Job läuft.
  await c.loadChatSession(55);
  assert.equal(c.chatSessionId, 55);
  assert.equal(c.isChatSessionRunning(55), false, 'die geöffnete Session wird NICHT bearbeitet');
  assert.equal(c.isChatSessionRunning(100), true, 'der Lauf hängt weiter an seiner Session');
  assert.ok(!calls.some((x) => x.url.startsWith('/jobs/active')),
    'kein zweiter Poller für die geöffnete Session');

  // Poll-Tick mit laufendem Job: Statuszeile erklärt den fremden Lauf,
  // statt den Fortschritt der offenen Session zuzuschreiben.
  routes.set('/jobs/job-1', { id: 'job-1', status: 'running', progress: 40, tokensOut: 20 });
  await pollTick();
  assert.match(c.chatStatus, /chat\.runningElsewhere/);

  // Job fertig: Historie wird aufgefrischt, die Ansicht bleibt stehen.
  routes.set('/jobs/job-1', { id: 'job-1', status: 'done', result: {} });
  routes.set('/chat/session/100', { id: 100, messages: [{ role: 'user', content: 'Frage' }] });
  calls = [];
  await pollTick();
  assert.equal(c.chatSessionId, 55, 'User bleibt im geöffneten Gespräch');
  assert.equal(c.chatLoading, false);
  assert.equal(c.chatRunningSessionId, null);
  assert.equal(c.chatStatus, '');
  assert.ok(!calls.some((x) => x.url === '/chat/session/100'),
    'die fertige Session wird nicht in die Ansicht gezogen');
  assert.ok(calls.some((x) => x.url === SESSIONS_URL), 'Historie wurde aufgefrischt');
});

test('Job-Ende im selben Gespräch lädt den Server-Stand nach', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatInput = 'Frage';
  routes.set('/jobs/chat', { jobId: 'job-1' });
  routes.set(SESSIONS_URL, [{ id: 100, preview: 'Frage', last_message_at: 'b' }]);
  await c.sendChatMessage();

  routes.set('/jobs/job-1', { id: 'job-1', status: 'done', result: { sessionTitle: 'Titel' } });
  routes.set('/chat/session/100', {
    id: 100,
    messages: [{ role: 'user', content: 'Frage' }, { role: 'assistant', content: 'Antwort' }],
  });
  await pollTick();

  assert.equal(c.chatMessages.length, 2, 'Antwort ist da');
  assert.equal(c.chatSessions[0].title, 'Titel', 'KI-Titel landet in der Historie');
  assert.equal(c.isChatSessionRunning(100), false);
});

test('Abgebrochener Lauf: neutraler Hinweis statt Fehlerzeile, Eingabe frei', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatInput = 'Frage';
  routes.set('/jobs/chat', { jobId: 'job-1' });
  routes.set(SESSIONS_URL, [{ id: 100, preview: 'Frage', last_message_at: 'b' }]);
  await c.sendChatMessage();

  routes.set('/jobs/job-1', { id: 'job-1', status: 'cancelled', error: 'job.cancelled' });
  routes.set('/chat/session/100', { id: 100, messages: [{ role: 'user', content: 'Frage' }] });
  await pollTick();

  assert.match(c.chatStatus, /muted-msg/);
  assert.match(c.chatStatus, /job\.cancelled/);
  assert.doesNotMatch(c.chatStatus, /error-msg|common\.errorColon/);
  assert.equal(c.chatLoading, false);
  assert.equal(c.isChatSessionRunning(100), false);
});

// ── Löschen ──────────────────────────────────────────────────────────────────

async function startRun(c) {
  c.chatSessionId = 100;
  c.chatInput = 'Frage';
  routes.set('/jobs/chat', { jobId: 'job-1' });
  routes.set(SESSIONS_URL, [
    { id: 100, preview: 'Frage', last_message_at: 'b' },
    { id: 55, preview: 'Alt', last_message_at: 'a' },
  ]);
  routes.set('/chat/session/55', { id: 55, messages: [] });
  await c.sendChatMessage();
  assert.ok(tick, 'Poller läuft');
}

test('Löschen der laufenden Session räumt den Lauf-State (Eingabe frei)', async () => {
  reset();
  const c = makeCard();
  await startRun(c);
  routes.set('DELETE /chat/session/100', { ok: true });
  routes.set(SESSIONS_URL, [{ id: 55, preview: 'Alt', last_message_at: 'a' }]);
  await c.deleteChatSession(100);
  assert.equal(tick, null, 'Poller gestoppt');
  assert.equal(c.chatLoading, false);
  assert.equal(c.chatRunningSessionId, null);
  assert.equal(c.chatSessionId, 55, 'nächstes Gespräch geladen');
});

test('Löschen einer anderen Session lässt den laufenden Poller stehen', async () => {
  reset();
  const c = makeCard();
  await startRun(c);
  routes.set('DELETE /chat/session/55', { ok: true });
  await c.deleteChatSession(55);
  assert.ok(tick, 'Poller der laufenden Session läuft weiter');
  assert.equal(c.chatLoading, true);
  assert.equal(c.chatRunningSessionId, 100);
  assert.deepEqual(c.chatSessions.map(s => s.id), [100]);
});

test('Fehlgeschlagenes Löschen (403) nimmt die Session nicht aus der Liste', async () => {
  reset();
  const c = makeCard();
  c.chatSessions = [{ id: 55 }];
  c.chatSessionId = 55;
  routes.set('DELETE /chat/session/55', { __status: 403, __body: { error_code: 'FORBIDDEN' } });
  await c.deleteChatSession(55);
  assert.deepEqual(c.chatSessions.map(s => s.id), [55]);
  assert.equal(c.chatSessionId, 55);
  assert.match(c.chatStatus, /error-msg/);
});

// ── Reset während laufender Requests ─────────────────────────────────────────

test('Reset während loadSessions: späte Antwort wird verworfen', async () => {
  reset();
  const c = makeCard();
  let release;
  const wait = new Promise((r) => { release = r; });
  routes.set(SESSIONS_URL, { __wait: wait, __then: [{ id: 1 }] });
  const pending = c.loadChatSessions();
  c.resetChat();
  release();
  await pending;
  assert.deepEqual(c.chatSessions, []);
});

test('Reset während des Sende-POST: kein Poller, keine Lauf-Anzeige', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatInput = 'Frage';
  let release;
  const wait = new Promise((r) => { release = r; });
  routes.set('/jobs/chat', { __wait: wait, __then: { jobId: 'job-1' } });
  const pending = c.sendChatMessage();
  await new Promise((r) => setImmediate(r));
  c.resetChat();
  release();
  await pending;
  assert.equal(tick, null, 'kein Poller nach Reset');
  assert.equal(c.chatLoading, false);
  assert.equal(c.chatRunningSessionId, null);
});

test('Neu auf einem leeren offenen Gespräch legt kein zweites an', async () => {
  reset();
  const c = makeCard();
  routes.set('POST /chat/session', { id: 300 });
  routes.set(SESSIONS_URL, []);
  // Karte öffnen und gleich „Neu" klicken: beide teilen sich EIN Anlegen.
  await Promise.all([c._onVisibleChat(), c.startNewChatSession()]);
  assert.equal(calls.filter((x) => x.method === 'POST' && x.url === '/chat/session').length, 1);
  assert.equal(c.chatSessionId, 300);
  // Noch einmal „Neu", solange das Gespräch leer ist: es bleibt dasselbe.
  await c.startNewChatSession();
  assert.equal(calls.filter((x) => x.method === 'POST' && x.url === '/chat/session').length, 1);
  // Mit Nachrichten legt „Neu" wieder ein frisches an.
  c.chatMessages = [{ role: 'user', content: 'x' }];
  routes.set('POST /chat/session', { id: 301 });
  await c.startNewChatSession();
  assert.equal(c.chatSessionId, 301);
});
