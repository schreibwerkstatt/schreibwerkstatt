// Gate für die Offline-Reichweite neben den Entwürfen:
//   - das zuletzt geöffnete Buch liegt automatisch offline (app/app-offline-books.js),
//   - Server-pflichtige Requests scheitern ohne Verbindung sofort (app/boot/net-required.js),
//   - die Suche läuft ohne Verbindung über die abgelegten Abschnitte (shared/offline-search.js).
//
// DIE INVARIANTEN:
//   1. Gewünscht ist „angeheftet ∪ zuletzt geöffnet" (die letzten
//      AUTO_OFFLINE_MAX Bücher); die Automatik ist per Default an und
//      abschaltbar. Was der SW darüber hinaus hält, ist „stale".
//   2. Ein Buchwechsel synct das neue Buch und räumt das älteste über dem
//      Deckel — ausser es ist angeheftet. Vor Kenntnis von Konto UND
//      SW-Bestand wird nichts geräumt, ohne Verbindung nie.
//   2a. Zwei Tabs mit je einem Buch räumen sich gegenseitig nichts weg; die
//      Absicht wird vor dem Abgleich frisch aus localStorage gelesen.
//   3. Ohne Verbindung wirft der Riegel für Job-Start/Diktat/Vorlesen/LT/Suche,
//      meldet aber nur die ausdrücklichen Aktionen. Saves und Content-Reads
//      laufen nie hinein.
//   4. Offline-Treffer: alle Suchwörter (UND), akzent-/grossschreibungs-
//      unabhängig, Snippet escaped bevor <mark> dazukommt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

// Node ≥ 21 hat ein eigenes `navigator` (nur Getter) — für die Attrappe ersetzen.
const setNavigator = (v) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });

const books = await import('../../public/js/app/app-offline-books.js');
const net = await import('../../public/js/app/boot/net-required.js');
const search = await import('../../public/js/shared/offline-search.js');

test('desiredOfflineBooks: angeheftet ∪ zuletzt geöffnet, Automatik abschaltbar', () => {
  assert.deepEqual(books.desiredOfflineBooks(['1', 2], { enabled: true, bookIds: ['3', '4'] }).sort(), ['1', '2', '3', '4']);
  assert.deepEqual(books.desiredOfflineBooks(['1'], { enabled: true, bookIds: ['1'] }), ['1']);
  assert.deepEqual(books.desiredOfflineBooks(['1'], { enabled: false, bookIds: ['3'] }), ['1']);
  assert.deepEqual(books.desiredOfflineBooks([], { enabled: true, bookIds: [] }), []);
});

test('noteAutoBook: neuestes vorne, ohne Doppel, gedeckelt', () => {
  assert.equal(books.AUTO_OFFLINE_MAX, 2);
  assert.deepEqual(books.noteAutoBook(['1'], 2), ['2', '1']);
  assert.deepEqual(books.noteAutoBook(['2', '1'], '1'), ['1', '2']);
  assert.deepEqual(books.noteAutoBook(['2', '1'], '3'), ['3', '2']);
});

test('staleOfflineBooks: was der SW hält, aber niemand will', () => {
  assert.deepEqual(books.staleOfflineBooks({ 1: {}, 2: {}, 3: {} }, ['1', '3']), ['2']);
  assert.deepEqual(books.staleOfflineBooks({}, ['1']), []);
});

test('readOfflineAuto: Default an, pro Konto getrennt', () => {
  store.clear();
  assert.deepEqual(books.readOfflineAuto('a@x'), { enabled: true, bookIds: [] });
  books.writeOfflineAuto('a@x', { enabled: false, bookIds: [7] });
  assert.deepEqual(books.readOfflineAuto('a@x'), { enabled: false, bookIds: ['7'] });
  assert.deepEqual(books.readOfflineAuto('b@x'), { enabled: true, bookIds: [] });
  // Älterer Stand mit Einzel-Merker wird gelesen.
  localStorage.setItem(books.offlineAutoKey('c@x'), JSON.stringify({ enabled: true, bookId: 5 }));
  assert.deepEqual(books.readOfflineAuto('c@x'), { enabled: true, bookIds: ['5'] });
});

// Root-Methoden gegen eine Attrappe: Store + SW-Controller, der Nachrichten mitschreibt.
function fakeRoot({ pinned = [], auto = { enabled: true, bookIds: [] }, held = {} } = {}) {
  const posted = [];
  // Die Absicht liegt in localStorage — der Abgleich liest sie dort frisch.
  books.writePinned('a@x', pinned);
  books.writeOfflineAuto('a@x', auto);
  auto = books.readOfflineAuto('a@x');
  setNavigator({
    onLine: true,
    serviceWorker: { controller: { postMessage: (m) => posted.push(m) } },
    storage: { persisted: async () => false, persist: async () => true },
  });
  const root = {
    ...books.appOfflineBooksMethods,
    $store: {
      session: {
        currentUser: { email: 'a@x' }, offlinePinned: pinned, offlineAuto: auto,
        offlineBooks: held, offlineProgress: {}, storagePersisted: false,
      },
      nav: { selectedBookId: null },
    },
    _offlineUserReady: true,
    _offlineStatusKnown: true,
  };
  return { root, posted };
}

test('Buchwechsel: neues Buch wird abgelegt, das älteste über dem Deckel geräumt', () => {
  store.clear();
  const { root, posted } = fakeRoot({ auto: { enabled: true, bookIds: ['2', '1'] }, held: { 1: { at: 'x' }, 2: { at: 'x' } } });
  root._noteBookOpenedForOffline(3);
  assert.deepEqual(root.$store.session.offlineAuto.bookIds, ['3', '2']);
  assert.deepEqual(books.readOfflineAuto('a@x').bookIds, ['3', '2']);
  assert.deepEqual(posted.filter((m) => m.type === 'offline-book-remove').map((m) => m.bookId), ['1'], 'nur das älteste geräumt');
  assert.ok(posted.some((m) => m.type === 'offline-book-sync' && m.bookId === '3'), 'neues Buch gesynct');
});

test('Zwei Tabs mit je einem Buch räumen sich nichts weg', () => {
  store.clear();
  // Tab A hat Buch 1 offen, Tab B (gleiches Gerät, gleicher localStorage) Buch 2.
  const a = fakeRoot({ auto: { enabled: true, bookIds: ['1'] }, held: { 1: { at: 'x' } } });
  const tabA = a.root;
  const b = fakeRoot({ auto: { enabled: true, bookIds: ['1'] }, held: { 1: { at: 'x' } } });
  b.root._noteBookOpenedForOffline(2);
  // Tab A kennt in seinem Store noch den alten Stand; sein Abgleich liest frisch.
  tabA.$store.session.offlineBooks = { 1: { at: 'x' }, 2: { at: 'y' } };
  tabA._syncOfflineBooks();
  assert.ok(!b.posted.some((m) => m.type === 'offline-book-remove'), 'Tab B räumt Buch 1 nicht');
  assert.ok(!a.posted.some((m) => m.type === 'offline-book-remove'), 'Tab A räumt Buch 2 nicht');
});

test('Buchwechsel ohne Netz: voriges Buch bleibt bis zum nächsten Online-Sync', () => {
  store.clear();
  const { root, posted } = fakeRoot({ auto: { enabled: true, bookIds: ['2', '1'] }, held: { 1: { at: 'x' } } });
  navigator.onLine = false;
  root._noteBookOpenedForOffline(3);
  assert.deepEqual(root.$store.session.offlineAuto.bookIds, ['3', '2'], 'Absicht folgt dem Wechsel');
  assert.equal(posted.length, 0, 'offline weder geräumt noch gesynct');
  assert.ok(root.$store.session.offlineBooks['1'], 'Kopie des vorigen Buchs bleibt');
  navigator.onLine = true;
  root._syncOfflineBooks();
  assert.deepEqual(posted.map((m) => [m.type, m.bookId]),
    [['offline-book-remove', '1'], ['offline-book-sync', '3'], ['offline-book-sync', '2']]);
});

test('Buchwechsel: angeheftetes Vorgängerbuch bleibt', () => {
  store.clear();
  const { root, posted } = fakeRoot({ pinned: ['1'], auto: { enabled: true, bookIds: ['1'] }, held: { 1: { at: 'x' } } });
  root._noteBookOpenedForOffline(2);
  assert.ok(!posted.some((m) => m.type === 'offline-book-remove'));
});

test('Abgleich wartet auf Konto UND SW-Bestand', () => {
  store.clear();
  const { root, posted } = fakeRoot({ pinned: ['1'], held: { 1: {}, 9: {} } });
  root._offlineStatusKnown = false;
  root._reconcileOfflineBooks();
  assert.equal(posted.length, 0, 'ohne SW-Bestand wird nichts geräumt');
  root._offlineStatusKnown = true;
  root._reconcileOfflineBooks();
  assert.deepEqual(posted.map((m) => [m.type, m.bookId]), [['offline-book-remove', '9']]);
});

test('Automatik aus: das automatisch abgelegte Buch fällt', () => {
  store.clear();
  const { root, posted } = fakeRoot({ auto: { enabled: true, bookIds: ['5'] }, held: { 5: {} } });
  root.setOfflineAutoEnabled(false);
  assert.equal(books.readOfflineAuto('a@x').enabled, false);
  assert.deepEqual(posted.map((m) => [m.type, m.bookId]), [['offline-book-remove', '5']]);
});

test('Anheftung aufheben: zuletzt geöffnetes Buch bleibt über die Automatik liegen', () => {
  store.clear();
  const { root, posted } = fakeRoot({ pinned: ['5'], auto: { enabled: true, bookIds: ['5'] }, held: { 5: {} } });
  root._unpinOfflineBook('5');
  assert.deepEqual(root.$store.session.offlinePinned, []);
  assert.ok(!posted.some((m) => m.type === 'offline-book-remove'));
});

test('Nutzungs-Events: Anheften und Ausgang des Erst-Syncs, nur einmal', async () => {
  store.clear();
  const sent = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, ...JSON.parse(init.body) }); return {}; };
  try {
    const { root } = fakeRoot();
    await root.toggleBookOffline(7);
    root._onOfflineBookMessage({ type: 'offline-book-synced', bookId: 7, at: 'x', total: 66, failed: 2 });
    root._onOfflineBookMessage({ type: 'offline-book-synced', bookId: 7, at: 'y', total: 66, failed: 0 });
    await root.toggleBookOffline(7);
    assert.deepEqual(sent.map((e) => [e.event, e.book_id]),
      [['offline.pin', 7], ['offline.pin.result', 7], ['offline.pin', 7]], 'Nach-Sync meldet nichts');
    assert.equal(sent[0].meta.action, 'pin');
    assert.equal(sent[2].meta.action, 'unpin');
    assert.deepEqual({ ...sent[1].meta, durationSec: 0 },
      { result: 'partial', total: 66, failed: 2, durationSec: 0, persisted: 'yes' });
  } finally { globalThis.fetch = prevFetch; }
});

test('Nutzungs-Events: abgebrochener Erst-Sync meldet failed mit Status', async () => {
  store.clear();
  const sent = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return {}; };
  try {
    const { root } = fakeRoot();
    await root.toggleBookOffline(3);
    root._onOfflineBookMessage({ type: 'offline-book-failed', bookId: 3, status: 0 });
    assert.equal(sent[1].event, 'offline.pin.result');
    assert.equal(sent[1].meta.result, 'failed');
    assert.equal(sent[1].meta.status, 0);
  } finally { globalThis.fetch = prevFetch; }
});

test('netRequiredRule: Job-Start, Diktat, Vorlesen, LT, Suche — sonst nichts', () => {
  globalThis.location = { href: 'https://example.test/', origin: 'https://example.test' };
  const r = (url, method) => net.netRequiredRule(url, method ? { method } : undefined);
  assert.equal(r('/jobs/lektorat', 'POST')?.announce, true);
  assert.equal(r('/jobs/123'), null, 'Job-Polling nicht');
  assert.equal(r('/jobs/123', 'DELETE'), null, 'Abbrechen nicht');
  assert.equal(r('/stt/transcribe?x=1', 'POST')?.announce, true);
  assert.equal(r('/tts/speak')?.announce, true);
  assert.equal(r('/languagetool/check', 'POST')?.announce, false);
  assert.equal(r('/search?q=ab')?.announce, false);
  assert.equal(r('/search/semantic?q=ab')?.announce, false);
  assert.equal(r('/searchbar'), null);
  assert.equal(r('/content/pages/4', 'PUT'), null, 'Save läuft nie in den Riegel');
  assert.equal(r('/content/pages/4'), null);
  assert.equal(r('https://other.test/jobs/x', 'POST'), null, 'fremde Origin nicht');
});

test('guardNetRequired: wirft nur offline, meldet nur ausdrückliche Aktionen', () => {
  const events = [];
  globalThis.window = { dispatchEvent: (e) => events.push(e.type) };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  setNavigator({ onLine: true });
  assert.doesNotThrow(() => net.guardNetRequired('/jobs/x', { method: 'POST' }));
  setNavigator({ onLine: false });
  assert.throws(() => net.guardNetRequired('/jobs/x', { method: 'POST' }), (e) => e instanceof TypeError && net.isOfflineRejection(e));
  assert.throws(() => net.guardNetRequired('/languagetool/check', { method: 'POST' }), TypeError);
  assert.doesNotThrow(() => net.guardNetRequired('/content/pages/1', { method: 'PUT' }));
  assert.deepEqual(events, ['net:required'], 'LT-Abweisung bleibt stumm');
});

test('Offline-Suche: UND, akzent- und grossschreibungsunabhängig', () => {
  const pages = [
    { id: 1, name: 'Ankunft', chapter: 'Eins', text: 'Sie erreichte Zürich am Abend.' },
    { id: 2, name: 'Abfahrt', chapter: 'Eins', text: 'Der Zug nach zurich fuhr ab. Zurich!' },
    { id: 3, name: 'Zürich bei Nacht', chapter: 'Zwei', text: 'Nichts.' },
  ];
  const hits = search.searchOffline({ pages, chapters: [], bookId: 4 }, 'ZURICH', { kinds: ['page'] });
  assert.deepEqual(hits.map((h) => h.entity_id).sort(), [1, 2, 3]);
  assert.equal(hits[0].entity_id, 3, 'Titeltreffer zuerst');
  assert.equal(hits[0].book_id, 4);
  const both = search.searchOffline({ pages, bookId: 4 }, 'zürich abend', { kinds: ['page'] });
  assert.deepEqual(both.map((h) => h.entity_id), [1]);
});

test('Offline-Suche: Snippet escaped, dann markiert', () => {
  const pages = [{ id: 1, name: 'x', text: 'a <b>&</b> Käse <script>' }];
  const [hit] = search.searchOffline({ pages }, 'kase', { kinds: ['page'] });
  assert.match(hit.snippet, /<mark>Käse<\/mark>/);
  assert.ok(!hit.snippet.includes('<script>'));
  assert.ok(hit.snippet.includes('&lt;b&gt;'));
});

test('Offline-Suche: Kapitel nach Name, Kinds respektiert', () => {
  const chapters = [{ id: 9, name: 'Die Reise' }];
  assert.equal(search.searchOffline({ chapters }, 'reise', { kinds: ['chapter'] })[0].kind, 'chapter');
  assert.equal(search.searchOffline({ chapters }, 'reise', { kinds: ['page'] }).length, 0);
  assert.equal(search.searchOffline({ chapters }, 'r', { kinds: ['chapter'] }).length, 0, 'zu kurz');
});

test('flattenTree + htmlToSearchText: gleiche Abschnittsmenge wie sw-offline', () => {
  const tree = {
    topPages: [{ id: 1, name: 'Vorwort' }],
    chapters: [{ id: 10, name: 'K1', pages: [{ id: 2, name: 'A' }], subchapters: [{ id: 11, name: 'K1.1', pages: [{ id: 3, name: 'B' }] }] }],
  };
  const { pages, chapters } = search.flattenTree(tree);
  assert.deepEqual(pages.map((p) => [p.id, p.chapter]), [[1, null], [2, 'K1'], [3, 'K1.1']]);
  assert.deepEqual(chapters.map((c) => c.id), [10, 11]);
  assert.equal(search.htmlToSearchText('<p>Ein&nbsp;Satz</p><p>Zwei &amp; drei</p>'), 'Ein Satz Zwei & drei');
});

test('Offline-Suche: benannte und numerische Entities werden dekodiert', () => {
  assert.equal(search.htmlToSearchText('<p>Gr&uuml;&szlig;e &#8222;hallo&#8220; &laquo;x&raquo; &#x2014; ok</p>'), 'Grüße „hallo“ «x» — ok');
  assert.equal(search.htmlToSearchText('&unbekannt; &#0;'), '&unbekannt; &#0;');
});

test('Offline-Suche: lokaler Stand — neue Namen und offline angelegte Abschnitte', () => {
  const base = { pages: [{ id: 1, name: 'Alt', chapter: 'K' }], chapters: [{ id: 10, name: 'K' }] };
  const ops = [
    { op: 'rename', kind: 'page', id: 1, name: 'Neu', bookId: 5 },
    { op: 'rename', kind: 'chapter', id: 10, name: 'Kapitel neu', bookId: 5 },
    { op: 'createPage', tempId: -9, bookId: 5, body: { chapter_id: 10 }, page: { name: 'Offline', html: '<p>Zugfahrt</p>' } },
    { op: 'createPage', tempId: -8, bookId: 6, body: {}, page: { name: 'Anderes Buch', html: '' } },
  ];
  const r = search.overlayLocalStructure(base, ops, 5);
  assert.equal(r.pages[0].name, 'Neu');
  assert.equal(r.chapters[0].name, 'Kapitel neu');
  assert.deepEqual(r.created.map((c) => [c.id, c.chapter]), [[-9, 'Kapitel neu']]);
  assert.equal(base.pages[0].name, 'Alt', 'Eingabe unverändert');
});
