// Gate fuer die zweite Haelfte von Stale-While-Revalidate: den leisen Nachzug
// des Seitenbaums.
//
// WARUM ALS UNIT-TEST: Der Service Worker ist auf localhost bewusst aus
// (boot/sw-register.js), und ein Hard-Refresh umgeht ihn komplett. Der Fehler,
// gegen den diese Datei steht, zeigt sich darum weder lokal noch im Smoke — er
// zeigt sich auf HTTPS als Aussage, die niemand als Cache-Problem liest ("beim
// Anmelden fehlen Seiten im Baum") und heilt beim ZWEITEN Reload von selbst.
//
// DIE INVARIANTEN:
//   1. Der SW meldet einen PFAD; was er bedeutet, entscheidet genau eine Stelle.
//   2. Eine Meldung fuer ein anderes Buch zieht nichts nach.
//   3. Der Cursor der Drift-Probe ist der Stand des BAUMS, nicht die Uhrzeit —
//      und ohne Baum gibt es keine Probe (ein geratenes `since` meldete jedes
//      Buch einmal als veraendert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContentPath } from '../../public/js/app/boot/content-updated.js';
import { treeCatchUpMethods, catchUpReadsFresh } from '../../public/js/book/tree/catchup.js';

// ── Pfad → Bedeutung ───────────────────────────────────────────────────────

test('parseContentPath erkennt die zwei Pfade mit Konsument', () => {
  assert.deepEqual(parseContentPath('/content/books'), { kind: 'books' });
  assert.deepEqual(parseContentPath('/content/books/12/tree'), { kind: 'tree', bookId: '12' });
});

test('parseContentPath verwirft alles andere still', () => {
  // Der SW meldet jeden abweichenden /content/*-GET. Ein unbekannter Pfad darf
  // keinen Nachzug ausloesen — sonst zieht eine Suchanfrage den Baum neu.
  for (const p of [
    '/content/books/12',            // Buch-Detail, kein Baum
    '/content/books/12/tree/extra',
    '/content/pages/77',            // Seiten-Body: der SW vergleicht ihn gar nicht erst
    '/content/pages/77/revisions',
    '/content/search?q=x',
    '/config',
    '',
    null,
  ]) {
    assert.equal(parseContentPath(p), null, `${p} darf nichts ausloesen.`);
  }
});

// ── Cursor der Drift-Probe ─────────────────────────────────────────────────

function ctxWithPages(pages) {
  return { ...treeCatchUpMethods, $store: { nav: { pages, selectedBookId: '3' } } };
}

test('_treeSince ist der juengste Seitenstand im gerenderten Baum', () => {
  const ctx = ctxWithPages([
    { id: 1, updated_at: '2026-09-01T08:00:00.000Z' },
    { id: 2, updated_at: '2026-09-03T12:30:00.000Z' },
    { id: 3, updated_at: '2026-09-02T09:00:00.000Z' },
  ]);
  assert.equal(ctx._treeSince(), '2026-09-03T12:30:00.000Z');
});

test('_treeSince ist null, solange kein Baum steht', () => {
  assert.equal(ctxWithPages([])._treeSince(), null);
  // Legacy-Zeilen ohne Zeitstempel duerfen keinen leeren Cursor erzeugen.
  assert.equal(ctxWithPages([{ id: 1, updated_at: null }])._treeSince(), null);
});

test('_checkTreeDrift fragt nicht ohne Cursor', async () => {
  let calls = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  try {
    await ctxWithPages([])._checkTreeDrift('3');
    assert.equal(calls, 0, 'Ohne Baum gibt es nichts, wogegen geprueft wuerde.');
  } finally { globalThis.fetch = prev; }
});

test('_checkTreeDrift fragt nicht fuer ein anderes Buch', async () => {
  let calls = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  try {
    const ctx = ctxWithPages([{ id: 1, updated_at: '2026-09-01T08:00:00.000Z' }]);
    await ctx._checkTreeDrift('99');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = prev; }
});

test('_checkTreeDrift zieht nur bei gemeldeten Aenderungen nach', async () => {
  const prev = globalThis.fetch;
  const run = async (changes) => {
    const scheduled = [];
    const ctx = {
      ...ctxWithPages([{ id: 1, updated_at: '2026-09-01T08:00:00.000Z' }]),
      _scheduleTreeCatchUp: (r) => scheduled.push(r),
    };
    globalThis.fetch = async (url) => {
      assert.match(String(url), /since=2026-09-01T08%3A00%3A00.000Z/,
        'Der Cursor ist der Stand des Baums.');
      assert.match(String(url), /device_id=/,
        'Ohne device_id meldet der Feed die eigenen Saves als fremde Aenderung.');
      return { ok: true, json: async () => ({ changes }) };
    };
    await ctx._checkTreeDrift('3');
    return scheduled;
  };
  try {
    assert.deepEqual(await run([]), [], 'Keine Aenderung → kein Nachzug.');
    assert.deepEqual(await run([{ page_id: 5 }]), ['drift']);
  } finally { globalThis.fetch = prev; }
});

test('_checkTreeDrift stellt dieselbe Frage nicht zweimal hintereinander', async () => {
  const urls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ changes: [] }) }; };
  try {
    const ctx = ctxWithPages([{ id: 1, updated_at: '2026-09-01T08:00:00.000Z' }]);
    await ctx._checkTreeDrift('3');
    await ctx._checkTreeDrift('3');
    assert.equal(urls.length, 1, 'Boot-Load + erster Geraete-Ping: gleicher Cursor, ein Read.');
    // Neuer Baum-Stand → neue Frage, auch innerhalb des Fensters.
    ctx.$store.nav.pages = [{ id: 1, updated_at: '2026-09-02T08:00:00.000Z' }];
    await ctx._checkTreeDrift('3');
    assert.equal(urls.length, 2);
    assert.match(urls[1], /since=2026-09-02/);
  } finally { globalThis.fetch = prev; }
});

// Die offene Seite ist die Ausnahme vom „nur Baum": der erste Save eines
// Geraets, das das Buch vorher nicht offen hatte, erreicht sonst nie den Editor.
test('_checkTreeDrift reicht eine neuere Aenderung der offenen Seite an den Collab-Pfad', async () => {
  const prev = globalThis.fetch;
  const run = async (changes, curStamp) => {
    const handled = [];
    const ctx = {
      ...ctxWithPages([{ id: 1, updated_at: '2026-09-01T08:00:00.000Z' }]),
      currentPage: { id: 7, updated_at: curStamp },
      _scheduleTreeCatchUp: () => {},
      _onCurrentPageRemoteEdit: (c) => handled.push(c),
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ changes }) });
    await ctx._checkTreeDrift('3', { force: true });
    return handled;
  };
  try {
    const newer = { page_id: 7, updated_at: '2026-09-05T10:00:00.000Z' };
    assert.deepEqual(await run([{ page_id: 5, updated_at: '2026-09-05T10:00:00.000Z' }, newer], '2026-09-04T10:00:00.000Z'), [newer]);
    // Schon verarbeitet (Stempel steht auf dem Remote-Stand) → nicht noch einmal.
    assert.deepEqual(await run([newer], '2026-09-05T10:00:00.000Z'), []);
    // Andere Seite → bleibt beim Baum-Nachzug.
    assert.deepEqual(await run([{ page_id: 5, updated_at: '2026-09-05T10:00:00.000Z' }], '2026-09-04T10:00:00.000Z'), []);
  } finally { globalThis.fetch = prev; }
});

// ── Meldung → Handlung ─────────────────────────────────────────────────────

function routingCtx(selectedBookId = '3') {
  const calls = [];
  const ctx = {
    ...treeCatchUpMethods,
    $store: { nav: { pages: [], selectedBookId } },
    _scheduleTreeCatchUp: (r) => calls.push(['tree', r]),
    _catchUpBooks: () => calls.push(['books']),
  };
  return { ctx, calls };
}

test('Eine Baum-Meldung fuer das offene Buch zieht den Baum nach', () => {
  const { ctx, calls } = routingCtx('3');
  ctx._onContentUpdated({ kind: 'tree', bookId: '3' });
  assert.deepEqual(calls, [['tree', 'sw-revalidate']]);
});

test('Eine Baum-Meldung fuer ein anderes Buch bleibt folgenlos', () => {
  // Der Cache haelt die Baeume mehrerer Buecher; revalidiert werden kann jeder.
  // Den offenen Baum daraufhin neu zu bauen waere schlicht falsch.
  const { ctx, calls } = routingCtx('3');
  ctx._onContentUpdated({ kind: 'tree', bookId: '9' });
  assert.deepEqual(calls, []);
});

test('Eine Buchlisten-Meldung zieht die Buchliste nach, nicht den Baum', () => {
  const { ctx, calls } = routingCtx('3');
  ctx._onContentUpdated({ kind: 'books' });
  assert.deepEqual(calls, [['books']]);
});

test('Eine unbekannte Meldung loest nichts aus', () => {
  const { ctx, calls } = routingCtx('3');
  ctx._onContentUpdated({ kind: 'page', pageId: '7' });
  ctx._onContentUpdated(null);
  assert.deepEqual(calls, []);
});

// ── Der Nachzug weicht aus, statt zu verwerfen ────────────────────────────
// Der haeufigste Fall ist der Boot: `loadPages` laeuft noch (Plaketten,
// Figuren, Reviews), waehrend die SW-Meldung schon eintrifft. Verwirft der
// Nachzug dort, bleibt genau die Abweichung stehen, um derentwillen er
// existiert — und der Boot-Load endet ja auf dem CACHE-Stand.

function catchUpCtx(overrides = {}) {
  const timers = [];
  return {
    ...treeCatchUpMethods,
    $store: { nav: { pages: [], selectedBookId: '3', books: [] } },
    treeLoading: false,
    _treeCatchUpTimer: null,
    _treeCatchUpInflight: false,
    _tokenEstGen: 0,
    _timers: timers,
    ...overrides,
  };
}

// Die Entprellung laeuft ueber setTimeout; im Test wird sie von Hand abgefeuert.
function withFakeTimers(fn) {
  const real = globalThis.setTimeout;
  const queue = [];
  globalThis.setTimeout = (cb) => { queue.push(cb); return queue.length; };
  try { return fn(queue); } finally { globalThis.setTimeout = real; }
}

test('Ein laufender Voll-Load verschiebt den Nachzug, statt ihn zu verwerfen', async () => {
  await withFakeTimers(async (queue) => {
    const ctx = catchUpCtx({ treeLoading: true });
    await ctx._catchUpTree('sw-revalidate');
    assert.equal(queue.length, 1, 'Es muss ein neuer Versuch eingeplant sein.');
  });
});

test('Der Ausweich-Versuch ist gedeckelt — ein haengender Load treibt keine Schleife', async () => {
  await withFakeTimers(async (queue) => {
    const ctx = catchUpCtx({ treeLoading: true });
    // Von der letzten erlaubten Runde aus: danach ist Schluss.
    await ctx._catchUpTree('sw-revalidate', 5);
    assert.equal(queue.length, 0);
  });
});

// ── Wie gelesen wird, haengt am Melder ────────────────────────────────────

test('Nach der SW-Meldung reicht ein normaler Read', () => {
  // Der SW legt die neue Antwort ab, BEVOR er meldet (cache.put vor
  // notifyContentUpdated). Ein `fresh`-Read kostete dort einen Roundtrip fuer
  // etwas, das schon im Cache liegt.
  assert.equal(catchUpReadsFresh('sw-revalidate'), false);
});

test('Die anderen Melder wissen nur DASS, nicht WAS — sie lesen frisch', () => {
  // Collab-Feed und Drift-Probe melden eine Aenderung; ihr Cache-Eintrag ist
  // noch der alte, ein normaler Read liefe genau dort hinein.
  assert.equal(catchUpReadsFresh('collab-new-page'), true);
  assert.equal(catchUpReadsFresh('drift'), true);
  assert.equal(catchUpReadsFresh(undefined), true, 'Unbekannter Melder → sicherer Weg.');
});
