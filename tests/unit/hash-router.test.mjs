// Tests für app-hash-router: _computeHash + _hashCategory + _applyHash.
//   - State → URL: showXxxCard-Flags + selected*Id werden zu einem Permalink
//   - URL → State: _applyHash interpretiert Hash und ruft die Toggle-Methoden
//   - push vs. replace: gleiche Kategorie → replace, Kategoriewechsel → push
//   - Deep-Link (Reload): Sub-Karten werden via Toggle gemountet, kapitel-review
//     setzt chapterId direkt am Root-SSoT bevor toggle awaited wird
import test from 'node:test';
import assert from 'node:assert/strict';
import { appHashRouterMethods } from '../../public/js/app/app-hash-router.js';

// ── DOM-Stubs ────────────────────────────────────────────────────────────────
const events = [];
globalThis.window = globalThis.window || {};
globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

function makeLocation(hash = '') {
  const loc = { pathname: '/', search: '', hash };
  return loc;
}
function makeHistory() {
  const calls = [];
  return {
    calls,
    pushState: (_s, _t, url) => { calls.push({ kind: 'push', url }); },
    replaceState: (_s, _t, url) => { calls.push({ kind: 'replace', url }); },
  };
}

function makeCtx({ hash = '', books = [{ id: 42 }, { id: 99 }] } = {}) {
  globalThis.location = makeLocation(hash);
  globalThis.history = makeHistory();
  // Karten-Toggles als Spies, die das Flag flippen (mimicken app-view.js).
  function makeToggle(flag) {
    return async function () { this[flag] = true; };
  }
  // Nav-State lebt in Alpine.store('nav') (kein Root-Proxy mehr). Im Test
  // spiegelt ein internes nav-Objekt unter $store.nav; Getter/Setter-Aliasse
  // halten die bestehenden c.selectedBookId-Mutationen am Leben.
  const nav = { selectedBookId: null, books, pages: [], tree: [], werkstattDraftId: null, plotBeatId: null, rueckblickEntryId: null };
  // selectedXxxId leben in Alpine.store('catalogUi'). Getter/Setter-Aliasse
  // halten die bestehenden c.selectedFigurId-Mutationen am Leben.
  const catalogUi = { figurenTab: 'liste', selectedFigurId: null, selectedOrtId: null, selectedSongId: null, selectedSzeneId: null };
  return {
    get selectedBookId() { return nav.selectedBookId; },
    set selectedBookId(v) { nav.selectedBookId = v; },
    get books() { return nav.books; },
    set books(v) { nav.books = v; },
    get pages() { return nav.pages; },
    set pages(v) { nav.pages = v; },
    get tree() { return nav.tree; },
    set tree(v) { nav.tree = v; },
    get werkstattDraftId() { return nav.werkstattDraftId; },
    set werkstattDraftId(v) { nav.werkstattDraftId = v; },
    get plotBeatId() { return nav.plotBeatId; },
    set plotBeatId(v) { nav.plotBeatId = v; },
    get rueckblickEntryId() { return nav.rueckblickEntryId; },
    set rueckblickEntryId(v) { nav.rueckblickEntryId = v; },
    get selectedFigurId() { return catalogUi.selectedFigurId; },
    set selectedFigurId(v) { catalogUi.selectedFigurId = v; },
    get selectedOrtId() { return catalogUi.selectedOrtId; },
    set selectedOrtId(v) { catalogUi.selectedOrtId = v; },
    get selectedSongId() { return catalogUi.selectedSongId; },
    set selectedSongId(v) { catalogUi.selectedSongId = v; },
    get selectedSzeneId() { return catalogUi.selectedSzeneId; },
    set selectedSzeneId(v) { catalogUi.selectedSzeneId = v; },
    $store: { nav, catalogUi },
    currentPage: null,
    kapitelReviewChapterId: null,
    showEditorCard: false,
    showFiguresCard: false,
    showFigurWerkstattCard: false,
    showOrteCard: false,
    showSzenenCard: false,
    showEreignisseCard: false,
    showKontinuitaetCard: false,
    showBookReviewCard: false,
    showKapitelReviewCard: false,
    showBookChatCard: false,
    showBookStatsCard: false,
    showStilCard: false,
    showFehlerHeatmapCard: false,
    showBookSettingsCard: false,
    showUserSettingsCard: false,
    showFinetuneExportCard: false,
    _hashInitialized: false,
    _initialApplyDone: false,
    _resetBookScopedState() {},
    loadPages: async () => {},
    _closeOtherMainCards() {},
    selectPage: async function (p) { this.currentPage = p; this.showEditorCard = true; },
    openFigurById: async function (id) { this.selectedFigurId = id; this.showFiguresCard = true; },
    openOrtById: async function (id) { this.selectedOrtId = id; this.showOrteCard = true; },
    toggleFiguresCard: makeToggle('showFiguresCard'),
    toggleFigurWerkstattCard: makeToggle('showFigurWerkstattCard'),
    toggleOrteCard: makeToggle('showOrteCard'),
    toggleSzenenCard: makeToggle('showSzenenCard'),
    toggleEreignisseCard: makeToggle('showEreignisseCard'),
    toggleKontinuitaetCard: makeToggle('showKontinuitaetCard'),
    toggleBookReviewCard: makeToggle('showBookReviewCard'),
    toggleKapitelReviewCard: makeToggle('showKapitelReviewCard'),
    toggleBookChatCard: makeToggle('showBookChatCard'),
    toggleBookStatsCard: makeToggle('showBookStatsCard'),
    toggleStilCard: makeToggle('showStilCard'),
    toggleFehlerHeatmapCard: makeToggle('showFehlerHeatmapCard'),
    toggleBookSettingsCard: makeToggle('showBookSettingsCard'),
    toggleUserSettingsCard: makeToggle('showUserSettingsCard'),
    toggleFinetuneExportCard: makeToggle('showFinetuneExportCard'),
    ...appHashRouterMethods,
  };
}

// ── _computeHash ─────────────────────────────────────────────────────────────
test('_computeHash: kein selectedBookId → leerer Hash', () => {
  const c = makeCtx();
  assert.equal(c._computeHash(), '');
});

test('_computeHash: nur Profil-Card → #profil', () => {
  const c = makeCtx();
  c.showUserSettingsCard = true;
  assert.equal(c._computeHash(), '#profil');
});

test('_computeHash: Editor + Page → #book/X/page/Y', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showEditorCard = true;
  c.currentPage = { id: 7 };
  assert.equal(c._computeHash(), '#book/42/page/7');
});

test('_computeHash: Figuren-Liste → #book/X/figuren', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showFiguresCard = true;
  assert.equal(c._computeHash(), '#book/42/figuren');
});

test('_computeHash: einzelne Figur → #book/X/figur/Y', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showFiguresCard = true;
  c.selectedFigurId = 11;
  assert.equal(c._computeHash(), '#book/42/figur/11');
});

test('_computeHash: Figuren-Reiter → #book/X/figuren/<reiter>', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showFiguresCard = true;
  c.$store.catalogUi.figurenTab = 'soziogramm';
  assert.equal(c._computeHash(), '#book/42/figuren/soziogramm');
});

test('_computeHash: Figur gewählt, aber anderer Reiter → Reiter-Permalink', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showFiguresCard = true;
  c.selectedFigurId = 11;
  c.$store.catalogUi.figurenTab = 'alter';
  assert.equal(c._computeHash(), '#book/42/figuren/alter');
  c.$store.catalogUi.figurenTab = 'liste';
  assert.equal(c._computeHash(), '#book/42/figur/11');
});

test('_computeHash: kapitel-Review mit chapterId → #book/X/kapitel/Y', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showKapitelReviewCard = true;
  c.kapitelReviewChapterId = 99;
  assert.equal(c._computeHash(), '#book/42/kapitel/99');
});

test('_computeHash: Werkstatt-Liste → #book/X/werkstatt', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showFigurWerkstattCard = true;
  assert.equal(c._computeHash(), '#book/42/werkstatt');
});

test('_computeHash: einzelner Werkstatt-Draft → #book/X/werkstatt/Y', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showFigurWerkstattCard = true;
  c.werkstattDraftId = 7;
  assert.equal(c._computeHash(), '#book/42/werkstatt/7');
});

test('_computeHash: Buch-Chat → #book/X/chat', () => {
  const c = makeCtx();
  c.selectedBookId = 42;
  c.showBookChatCard = true;
  assert.equal(c._computeHash(), '#book/42/chat');
});

// ── _hashCategory ────────────────────────────────────────────────────────────
test('_hashCategory: figur und figuren teilen Kategorie (replace bei Wechsel)', () => {
  const c = makeCtx();
  assert.equal(c._hashCategory('#book/42/figuren'), '42:figuren');
  assert.equal(c._hashCategory('#book/42/figur/11'), '42:figuren');
});

test('_hashCategory: ort und orte teilen Kategorie', () => {
  const c = makeCtx();
  assert.equal(c._hashCategory('#book/42/orte'), '42:orte');
  assert.equal(c._hashCategory('#book/42/ort/3'), '42:orte');
});

test('_hashCategory: Werkstatt-Liste und einzelner Draft teilen Kategorie (replace)', () => {
  const c = makeCtx();
  assert.equal(c._hashCategory('#book/42/werkstatt'), '42:werkstatt');
  assert.equal(c._hashCategory('#book/42/werkstatt/7'), '42:werkstatt');
});

test('_hashCategory: anderes Buch → andere Kategorie (push)', () => {
  const c = makeCtx();
  assert.notEqual(c._hashCategory('#book/42/figuren'), c._hashCategory('#book/99/figuren'));
});

test('_hashCategory: jeder Rückblick-Eintrag ist eine eigene Kategorie (push)', () => {
  const c = makeCtx();
  // Übersicht, Eintrag 5 und Eintrag 8 unterscheiden sich alle → Browser-Zurück
  // navigiert schrittweise zwischen Einträgen und zur Kalender-Übersicht.
  assert.equal(c._hashCategory('#book/42/rueckblick'), '42:rueckblick');
  assert.equal(c._hashCategory('#book/42/rueckblick/5'), '42:rueckblick:5');
  assert.notEqual(c._hashCategory('#book/42/rueckblick/5'), c._hashCategory('#book/42/rueckblick/8'));
  assert.notEqual(c._hashCategory('#book/42/rueckblick/5'), c._hashCategory('#book/42/rueckblick'));
});

// ── _writeHash ───────────────────────────────────────────────────────────────
test('_writeHash: erster Write → replaceState (kein neuer History-Eintrag)', () => {
  const c = makeCtx();
  c._writeHash('#book/42/figuren');
  assert.equal(globalThis.history.calls.length, 1);
  assert.equal(globalThis.history.calls[0].kind, 'replace');
});

test('_writeHash: Kategorie-Wechsel → pushState', () => {
  const c = makeCtx({ hash: '#book/42/figuren' });
  c._hashInitialized = true; // simuliere bereits initialisiert
  c._writeHash('#book/42/orte');
  assert.equal(globalThis.history.calls.at(-1).kind, 'push');
});

test('_writeHash: gleiche Kategorie (Figur → andere Figur) → replaceState', () => {
  const c = makeCtx({ hash: '#book/42/figur/1' });
  c._hashInitialized = true;
  c._writeHash('#book/42/figur/2');
  assert.equal(globalThis.history.calls.at(-1).kind, 'replace');
});

test('_writeHash: leerer Hash → räumt URL via replaceState', () => {
  const c = makeCtx({ hash: '#book/42/figuren' });
  c._hashInitialized = true;
  c._writeHash('');
  const last = globalThis.history.calls.at(-1);
  assert.equal(last.kind, 'replace');
  assert.equal(last.url, '/');
});

test('_writeHash: identischer Hash → kein Call', () => {
  const c = makeCtx({ hash: '#book/42/figuren' });
  c._hashInitialized = true;
  c._writeHash('#book/42/figuren');
  assert.equal(globalThis.history.calls.length, 0);
});

// ── _applyHash (Deep-Link) ───────────────────────────────────────────────────
test('_applyHash: Deep-Link auf Profil → toggleUserSettingsCard', async () => {
  const c = makeCtx({ hash: '#profil' });
  await c._applyHash();
  assert.equal(c.showUserSettingsCard, true);
});

test('_applyHash: Deep-Link auf #book/42/figuren → setzt Buch + öffnet Figuren-Karte', async () => {
  const c = makeCtx({ hash: '#book/42/figuren' });
  await c._applyHash();
  assert.equal(String(c.selectedBookId), '42');
  assert.equal(c.showFiguresCard, true);
});

test('_applyHash: Deep-Link auf #book/42/figuren/lebenslauf → Reiter-Wunsch + Karte offen', async () => {
  events.length = 0;
  const c = makeCtx({ hash: '#book/42/figuren/lebenslauf' });
  await c._applyHash();
  assert.equal(c.showFiguresCard, true);
  const { takeCardRequest, CARD_REQUEST } = await import('../../public/js/cards/card-request.js');
  assert.equal(takeCardRequest(CARD_REQUEST.FIGUREN_TAB), 'lebenslauf');
});

test('_applyHash: unbekannter Figuren-Reiter fällt auf die Liste zurück', async () => {
  const c = makeCtx({ hash: '#book/42/figuren/quatsch' });
  await c._applyHash();
  const { takeCardRequest, CARD_REQUEST } = await import('../../public/js/cards/card-request.js');
  assert.equal(takeCardRequest(CARD_REQUEST.FIGUREN_TAB), 'liste');
});

test('_applyHash: Deep-Link auf #book/42/figur/7 → openFigurById', async () => {
  const c = makeCtx({ hash: '#book/42/figur/7' });
  await c._applyHash();
  assert.equal(String(c.selectedBookId), '42');
  assert.equal(c.selectedFigurId, '7');
  assert.equal(c.showFiguresCard, true);
});

test('_applyHash: Deep-Link auf #book/42/kapitel/123 → öffnet Kapitel-Review + setzt chapterId am Root', async () => {
  events.length = 0;
  const c = makeCtx({ hash: '#book/42/kapitel/123' });
  await c._applyHash();
  assert.equal(c.showKapitelReviewCard, true);
  // chapterId lebt am Root als SSoT — Hash-Router schreibt direkt, Sub liest
  // reaktiv via $app.kapitelReviewChapterId. Vor dem Partial-Load gibt es keinen
  // Listener für ein Event, daher kein Dispatch.
  assert.equal(c.kapitelReviewChapterId, '123');
});

test('_applyHash: Deep-Link auf #book/42/werkstatt/7 → öffnet Werkstatt + dispatcht select-Event', async () => {
  events.length = 0;
  const c = makeCtx({ hash: '#book/42/werkstatt/7' });
  await c._applyHash();
  assert.equal(c.showFigurWerkstattCard, true);
  const sel = events.find(e => e.type === 'figur-werkstatt:select');
  assert.ok(sel, 'figur-werkstatt:select Event fehlt – Sub könnte draftId nicht erhalten');
  assert.equal(sel.detail.draftId, 7);
});

test('_applyHash: Deep-Link auf #book/42/werkstatt → öffnet Werkstatt ohne select-Event', async () => {
  events.length = 0;
  const c = makeCtx({ hash: '#book/42/werkstatt' });
  c.werkstattDraftId = 99; // alter Stand → muss geräumt werden
  await c._applyHash();
  assert.equal(c.showFigurWerkstattCard, true);
  assert.equal(c.werkstattDraftId, null);
  assert.ok(!events.find(e => e.type === 'figur-werkstatt:select'));
});

test('_applyHash: Deep-Link auf #book/42/page/7 → selectPage', async () => {
  const c = makeCtx({ hash: '#book/42/page/7' });
  c.pages = [{ id: 7, name: 'Seite 7' }];
  await c._applyHash();
  assert.equal(c.currentPage?.id, 7);
  assert.equal(c.showEditorCard, true);
});

test('_applyHash: unbekannte Buch-ID → no-op (kein Crash)', async () => {
  const c = makeCtx({ hash: '#book/999/figuren' });
  await c._applyHash();
  assert.equal(c.showFiguresCard, false);
});

test('_applyHash: leerer Hash → no-op', async () => {
  const c = makeCtx({ hash: '' });
  await c._applyHash();
  assert.equal(c.showFiguresCard, false);
  assert.equal(c.selectedBookId, null);
});
