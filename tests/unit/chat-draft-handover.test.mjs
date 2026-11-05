// Tests für das Übergabe-Muster der Chats (chat-base.js#prepare<L>Draft):
// Eine vorformulierte Frage aus einer anderen Oberfläche (Lektorat → Abschnitts-Chat,
// Übersicht → Buch-Chat, Buch-Chat → Recherche-Chat) landet in einer NEUEN Session
// des Ziel-Chats, im Eingabefeld — und wird NICHT gesendet (ein Lauf kostet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChatMethods } from '../../public/js/chat/chat-base.js';

// ── Stubs ────────────────────────────────────────────────────────────────────
globalThis.window = globalThis.window || {};
globalThis.window.__app = { t: (k) => k };

let routes = new Map();
let calls = [];
globalThis.fetch = async (url, opts) => {
  const key = String(url);
  const mkey = `${opts?.method || 'GET'} ${key}`;
  calls.push({ url: key, method: opts?.method || 'GET' });
  const body = routes.has(mkey) ? routes.get(mkey) : routes.has(key) ? routes.get(key) : null;
  if (body === null) {
    return { ok: false, status: 404, clone: () => ({ json: async () => ({}) }), json: async () => ({}) };
  }
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
  const inputEl = {
    value: '',
    focused: false,
    focus() { this.focused = true; },
    setSelectionRange(a, b) { this.range = [a, b]; },
  };
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
    $root: { querySelector: (sel) => (sel === '.chat-input' ? inputEl : null) },
    _inputEl: inputEl,
    ...methods,
  };
}

function reset() {
  calls = [];
  routes = new Map();
  globalThis.document = { getElementById: () => null };
}

const posts = (url) => calls.filter((x) => x.method === 'POST' && x.url === url);

test('Übergabe legt eine neue Session an und belegt das Eingabefeld', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatMessages = [{ role: 'user', content: 'Alte Frage' }];
  routes.set('POST /chat/session', { id: 300 });
  routes.set(SESSIONS_URL, [{ id: 100, preview: 'Alte Frage' }, { id: 300, preview: '' }]);

  await c.prepareChatDraft('Neue Frage');

  assert.equal(c.chatSessionId, 300, 'die Frage beginnt ein eigenes Gespräch');
  assert.deepEqual(c.chatMessages, [], 'die alte Unterhaltung steht nicht im Weg');
  assert.equal(c.chatInput, 'Neue Frage', 'Frage steht im Eingabefeld');
  assert.equal(posts('/chat/session').length, 1, 'genau eine neue Session');
  assert.equal(posts('/jobs/chat').length, 0, 'die Frage wird NICHT gesendet');
});

test('Ein offenes, leeres Gespräch wird weiterbenutzt (keine zweite leere Session)', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatMessages = [];
  routes.set('POST /chat/session', { id: 300 });
  routes.set(SESSIONS_URL, [{ id: 100, preview: '' }]);

  await c.prepareChatDraft('Frage');

  assert.equal(c.chatSessionId, 100, 'das leere Gespräch bleibt');
  assert.equal(posts('/chat/session').length, 0, 'keine zweite leere Session');
  assert.equal(c.chatInput, 'Frage');
});

test('Leere Frage: keine Session, kein Eingabefeld', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatMessages = [{ role: 'user', content: 'Alt' }];
  routes.set('POST /chat/session', { id: 300 });
  routes.set(SESSIONS_URL, [{ id: 100 }]);

  await c.prepareChatDraft('   ');

  assert.equal(c.chatSessionId, 100, 'kein Wechsel');
  assert.equal(c.chatInput, '');
  assert.equal(posts('/chat/session').length, 0);
});

test('Der Fokus landet im Eingabefeld, der Cursor am Ende', async () => {
  reset();
  const c = makeCard();
  c.chatSessionId = 100;
  c.chatMessages = [];
  routes.set(SESSIONS_URL, [{ id: 100 }]);

  await c.prepareChatDraft('Frage');

  assert.equal(c._inputEl.focused, true);
});
