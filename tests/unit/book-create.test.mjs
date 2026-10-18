// Unit-Tests fuer bookCreateMethods (public/js/book/book-create.js):
//   - open/cancel-Reset (inkl. Kategorie-Pool-Load)
//   - leerer Name → errorEmpty, kein createBook
//   - fehlender Buchtyp → buchtypRequired, kein createBook
//   - Kategorie-Pflicht nur bei nicht-leerem Pool
//   - Vorbelegung: Buchtyp aus dem Profil, sonst Roman; Sprache/Region aus dem
//     Profil, Region passend zur Sprache
//   - Erfolg: contentRepo.createBook (POST /content/books), Buchtyp/Kategorie
//     am Buch persistiert, loadBooks aufgerufen, Hash aufs neue Buch (Übersicht,
//     keine Settings-Karte), Modal geschlossen
//   - Fehler (server detail): bookCreateError gesetzt mit Detail-Text
//   - bookCreateBusy verhindert doppeltes submit/cancel
//
// Modal-Status wird via <dialog>-Stub getrackt (open-Flag + showModal/close-
// Spies). Methoden rufen this.$refs.bookCreateDialog{,Input} statt eines
// Boolean-State. Buecher werden ueber contentRepo angelegt → der Fetch-Mock
// muss /content/books bedienen (nicht /books), plus /booksettings/:id und
// /books/:id/category fuer die Persistenz und /local/categories fuer den Pool.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bookCreateMethods } = await import('../../public/js/book/book-create.js');

function makeDialogStub() {
  return {
    open: false,
    showModalCalls: 0,
    closeCalls: 0,
    showModal() { this.open = true; this.showModalCalls++; },
    close() { this.open = false; this.closeCalls++; },
  };
}

function makeCtx(overrides = {}) {
  const dlg = makeDialogStub();
  const input = { focus() { this.focused = true; }, focused: false };
  // Nav-State lebt in Alpine.store('nav') (kein Root-Proxy mehr): nav unter
  // $store.nav + Aliasse fuer direkte c.selectedBookId-Zugriffe.
  const nav = { selectedBookId: '', books: [], pages: [], tree: [] };
  const ctx = {
    get selectedBookId() { return nav.selectedBookId; },
    set selectedBookId(v) { nav.selectedBookId = v; },
    get books() { return nav.books; },
    set books(v) { nav.books = v; },
    get pages() { return nav.pages; },
    set pages(v) { nav.pages = v; },
    get tree() { return nav.tree; },
    set tree(v) { nav.tree = v; },
    // Shell-State (App-Meta) lebt in Alpine.store('shell'): book-create.js liest
    // this.$store.shell.uiLocale (Region) + .promptConfig (Buchtyp-Liste).
    $store: { nav, shell: { uiLocale: 'de', defaultBuchtyp: '', defaultBookLanguage: '', defaultRegion: '', promptConfig: { buchtypen: { de: {} } } } },
    bookCreateName: '',
    bookCreateBuchtyp: '',
    bookCreateCategoryId: '',
    bookCreateCategoryPool: [],
    bookCreateBusy: false,
    bookCreateError: '',
    uiLocale: 'de',
    showBookSettingsCard: false,
    _toggleCalls: 0,
    _loadBooksCalls: 0,
    $refs: { bookCreateDialog: dlg, bookCreateInput: input },
    t(key, params) {
      if (key === 'book.create.errorEmpty') return 'Bitte Titel eingeben.';
      if (key === 'book.settings.buchtypRequired') return 'Bitte einen Buchtyp wählen.';
      if (key === 'book.category.required') return 'Bitte eine Kategorie wählen.';
      if (key === 'book.create.errorGeneric') return `Erstellen fehlgeschlagen: ${params?.msg || ''}`;
      return key;
    },
    $nextTick(fn) { fn?.(); },
    async loadBooks() { this._loadBooksCalls++; },
    toggleBookSettingsCard() {
      this._toggleCalls++;
      this.showBookSettingsCard = !this.showBookSettingsCard;
    },
    ...overrides,
    openCreateBook: bookCreateMethods.openCreateBook,
    cancelCreateBook: bookCreateMethods.cancelCreateBook,
    submitCreateBook: bookCreateMethods.submitCreateBook,
    _loadBookCreateCategories: bookCreateMethods._loadBookCreateCategories,
    bookCreateBuchtypOptions: bookCreateMethods.bookCreateBuchtypOptions,
    _defaultBuchtyp: bookCreateMethods._defaultBuchtyp,
    _newBookLangRegion: bookCreateMethods._newBookLangRegion,
  };
  // submitCreateBook liest Root-Methoden (t/loadBooks/toggleBookSettingsCard/
  // showBookSettingsCard) ueber window.__app — in der Karte ist das der Root, im
  // Test faellt Root + Karte auf denselben ctx zusammen.
  globalThis.window = globalThis.window || {};
  globalThis.window.__app = ctx;
  globalThis.window.location = { hash: '' };
  return ctx;
}

// JSON-Response-Stub mit ok-Flag passend zum HTTP-Status (contentRepo._write
// und fetchJson lesen beides).
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
    clone() { return jsonResponse(body, status); },
  };
}

// Router-artiger Fetch-Mock: matched pro Pfad-Substring. `calls` sammelt alle
// Requests zur Assertion.
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    for (const [match, handler] of Object.entries(routes)) {
      if (url.includes(match)) return handler(url, opts);
    }
    throw new Error(`unerwarteter Fetch: ${url}`);
  };
  return calls;
}

test('openCreateBook setzt Defaults und oeffnet Modal', () => {
  const ctx = makeCtx({ bookCreateName: 'old', bookCreateError: 'err', bookCreateBuchtyp: 'krimi' });
  mockFetch({ '/local/categories': async () => jsonResponse({ categories: [] }) });
  ctx.openCreateBook();
  assert.equal(ctx.$refs.bookCreateDialog.open, true);
  assert.equal(ctx.$refs.bookCreateDialog.showModalCalls, 1);
  assert.equal(ctx.bookCreateName, '');
  assert.equal(ctx.bookCreateBuchtyp, '');
  assert.equal(ctx.bookCreateCategoryId, '');
  assert.equal(ctx.bookCreateError, '');
  assert.equal(ctx.bookCreateBusy, false);
});

const TYPEN = { roman: { label: 'Roman' }, krimi: { label: 'Krimi' }, sachbuch: { label: 'Sachbuch' } };

test('openCreateBook belegt den Buchtyp vor: Profil-Standard, sonst Roman', () => {
  mockFetch({ '/local/categories': async () => jsonResponse({ categories: [] }) });
  const ctx = makeCtx();
  ctx.$store.shell.promptConfig = { buchtypen: { de: TYPEN } };
  ctx.openCreateBook();
  assert.equal(ctx.bookCreateBuchtyp, 'roman');

  const pref = makeCtx();
  pref.$store.shell.promptConfig = { buchtypen: { de: TYPEN } };
  pref.$store.shell.defaultBuchtyp = 'sachbuch';
  pref.openCreateBook();
  assert.equal(pref.bookCreateBuchtyp, 'sachbuch');

  const unknown = makeCtx();
  unknown.$store.shell.promptConfig = { buchtypen: { de: TYPEN } };
  unknown.$store.shell.defaultBuchtyp = 'gibtsnicht';
  unknown.openCreateBook();
  assert.equal(unknown.bookCreateBuchtyp, 'roman', 'unbekannter Profil-Typ fällt auf Roman zurück');
});

test('_newBookLangRegion: Profil-Sprache + passende Region, sonst UI-Sprache', () => {
  const ctx = makeCtx();
  assert.deepEqual(ctx._newBookLangRegion(), { lang: 'de', region: 'CH' });
  ctx.$store.shell.defaultRegion = 'DE';
  assert.deepEqual(ctx._newBookLangRegion(), { lang: 'de', region: 'DE' });
  ctx.$store.shell.defaultBookLanguage = 'en';
  assert.deepEqual(ctx._newBookLangRegion(), { lang: 'en', region: 'US' }, 'DE passt nicht zu en');
  ctx.$store.shell.defaultRegion = 'GB';
  assert.deepEqual(ctx._newBookLangRegion(), { lang: 'en', region: 'GB' });
});

test('cancelCreateBook schliesst und setzt zurueck — nur wenn nicht busy', () => {
  const ctx = makeCtx({ bookCreateName: 'X', bookCreateError: 'E' });
  ctx.$refs.bookCreateDialog.open = true;
  ctx.cancelCreateBook();
  assert.equal(ctx.$refs.bookCreateDialog.open, false);
  assert.equal(ctx.bookCreateName, '');
  assert.equal(ctx.bookCreateError, '');

  const busy = makeCtx({ bookCreateBusy: true, bookCreateName: 'X' });
  busy.$refs.bookCreateDialog.open = true;
  busy.cancelCreateBook();
  assert.equal(busy.$refs.bookCreateDialog.open, true, 'cancel im busy-State ist no-op');
  assert.equal(busy.bookCreateName, 'X');
});

test('submitCreateBook ohne Name → errorEmpty, kein Fetch', async () => {
  const ctx = makeCtx({ bookCreateName: '   ', bookCreateBuchtyp: 'krimi' });
  const calls = mockFetch({ '': () => { throw new Error('soll nicht aufgerufen werden'); } });
  await ctx.submitCreateBook();
  assert.equal(ctx.bookCreateError, 'Bitte Titel eingeben.');
  assert.equal(ctx.bookCreateBusy, false);
  assert.equal(calls.length, 0);
});

test('submitCreateBook ohne Buchtyp → buchtypRequired, kein createBook', async () => {
  const ctx = makeCtx({ bookCreateName: 'Mein Roman' });
  const calls = mockFetch({ '': () => { throw new Error('soll nicht aufgerufen werden'); } });
  await ctx.submitCreateBook();
  assert.equal(ctx.bookCreateError, 'Bitte einen Buchtyp wählen.');
  assert.equal(ctx.bookCreateBusy, false);
  assert.equal(calls.length, 0);
});

test('submitCreateBook bei nicht-leerem Pool ohne Kategorie → required, kein createBook', async () => {
  const ctx = makeCtx({
    bookCreateName: 'Mein Roman',
    bookCreateBuchtyp: 'krimi',
    bookCreateCategoryPool: [{ id: 1, name: 'Belletristik' }],
  });
  const calls = mockFetch({ '': () => { throw new Error('soll nicht aufgerufen werden'); } });
  await ctx.submitCreateBook();
  assert.equal(ctx.bookCreateError, 'Bitte eine Kategorie wählen.');
  assert.equal(calls.length, 0);
});

test('submitCreateBook erfolgreich → createBook, Persistenz, loadBooks, Hash aufs neue Buch, close', async () => {
  const ctx = makeCtx({ bookCreateName: 'Mein Roman', bookCreateBuchtyp: 'krimi' });
  ctx.$refs.bookCreateDialog.open = true;
  const calls = mockFetch({
    '/content/books': async () => jsonResponse({ id: 42, name: 'Mein Roman' }),
    '/booksettings/42': async () => jsonResponse({ ok: true }),
    '/books/42/category': async () => jsonResponse({ ok: true }),
  });
  await ctx.submitCreateBook();
  assert.ok(calls.some(c => c.url.includes('/content/books') && c.opts.method === 'POST'), 'createBook POST');
  assert.ok(calls.some(c => c.url.includes('/booksettings/42') && c.opts.method === 'PUT'), 'Buchtyp persistiert');
  assert.equal(ctx._loadBooksCalls, 1);
  assert.equal(globalThis.window.location.hash, '#book/42', 'ins neue Buch (Übersicht)');
  assert.equal(ctx._toggleCalls, 0, 'keine Settings-Karte vor der ersten Zeile');
  assert.equal(ctx.$refs.bookCreateDialog.open, false);
  assert.equal(ctx.bookCreateError, '');
  assert.equal(ctx.bookCreateBusy, false);
});

test('submitCreateBook persistiert Sprache/Region aus dem Profil', async () => {
  const ctx = makeCtx({ bookCreateName: 'X', bookCreateBuchtyp: 'krimi' });
  ctx.$store.shell.defaultBookLanguage = 'en';
  ctx.$store.shell.defaultRegion = 'GB';
  ctx.$refs.bookCreateDialog.open = true;
  const calls = mockFetch({
    '/content/books': async () => jsonResponse({ id: 7 }),
    '/booksettings/7': async () => jsonResponse({ ok: true }),
  });
  await ctx.submitCreateBook();
  const put = calls.find(c => c.url.includes('/booksettings/7'));
  assert.deepEqual(JSON.parse(put.opts.body), { language: 'en', region: 'GB', buchtyp: 'krimi' });
});

test('submitCreateBook Server-Fehler → errorGeneric mit detail', async () => {
  const ctx = makeCtx({ bookCreateName: 'Bad', bookCreateBuchtyp: 'krimi' });
  ctx.$refs.bookCreateDialog.open = true;
  mockFetch({
    '/content/books': async () => jsonResponse({ error_code: 'CREATE_FAILED', detail: 'Anlegen abgelehnt' }, 500),
  });
  await ctx.submitCreateBook();
  assert.match(ctx.bookCreateError, /Anlegen abgelehnt/);
  assert.equal(ctx.$refs.bookCreateDialog.open, true, 'Modal bleibt offen bei Fehler');
  assert.equal(ctx.bookCreateBusy, false);
});

test('submitCreateBook bei laufendem Submit → no-op', async () => {
  const ctx = makeCtx({ bookCreateName: 'X', bookCreateBuchtyp: 'krimi', bookCreateBusy: true });
  ctx.$refs.bookCreateDialog.open = true;
  const calls = mockFetch({ '': () => { throw new Error('soll nicht aufgerufen werden'); } });
  await ctx.submitCreateBook();
  assert.equal(calls.length, 0);
});
