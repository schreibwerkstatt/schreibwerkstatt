// Notebook-Leseansicht, Lektorat: Auswahl, Übernehmen und History-Eintrag.
// Getestet werden die echten Methoden aus editor/lektorat.js und book/history.js
// (Browser-Globals gestubbt), nicht ein Mirror.
//
//   - Übernommene Befunde und Befunde ohne wirksamen Vorschlag sind nicht
//     auswählbar — weder per Checkbox/Markierung noch per «Alle». Ein zweites
//     Anwenden schriebe „sagte er,,".
//   - Mehrdeutige Fundstellen (`mehrdeutig`) sind nicht vorausgewählt.
//   - Ein Befund ohne Vorschlag ist beim Speichern übersprungen, nicht übernommen.
//   - Der History-PATCH geht an den Lauf, aus dem übernommen wurde — auch wenn
//     während des Speicherns die Seite wechselt.
//   - Ein History-Eintrag sperrt nur, was wirklich im Text gelandet ist
//     (`applied_errors_json`), nicht die ganze Auswahl.
//   - Ein History-Eintrag, dessen Details nach einem Seitenwechsel ankommen,
//     landet nicht auf der neuen Seite.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { dispatchEvent() {}, addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; }, location: {} };
globalThis.Alpine = { store: () => ({}) };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { lektoratMethods } = await import('../../public/js/editor/lektorat.js');
const { historyMethods } = await import('../../public/js/book/history.js');
const { skipReason } = await import('../../public/js/utils.js');
// Erst nach den Imports: loadHistoryEntry scrollt am Ende per getElementById.
globalThis.document = { getElementById: () => null };

const HTML = '<p>«Ja», sagte er und ging nach Hause.</p>';
const F = (typ, original, korrektur, extra = {}) => ({ typ, original, korrektur, erklaerung: '', ...extra });

function makeApp(over = {}) {
  const app = {
    ...lektoratMethods,
    ...historyMethods,
    t: (k) => k,
    formatDate: (d) => String(d),
    setStatus(msg) { this.statusLog.push(msg); },
    statusLog: [],
    updatePageView() {},
    refreshPageAges() {},
    markPageChecked() {},
    $store: { nav: { selectedBookId: null } },
    currentPage: { id: 1, name: 'S 1' },
    originalHtml: HTML,
    lektoratFindings: [],
    selectedFindings: [],
    appliedOriginals: [],
    appliedHistoricCorrections: [],
    pageHistory: [],
    saveApplying: null,
    lastCheckId: null,
    activeHistoryEntryId: null,
    ...over,
  };
  return app;
}

test('übernommene und vorschlagslose Befunde sind nicht auswählbar', () => {
  const app = makeApp({
    lektoratFindings: [
      F('grammatik', 'sagte er', 'sagte er,'),          // schon übernommen
      F('rechtschreibung', 'ging', ''),                  // kein Vorschlag
      F('stil', 'nach Hause', 'nach Hause'),             // Vorschlag = Original
      F('grammatik', 'und ging', 'und lief'),            // auswählbar
    ],
    selectedFindings: [false, false, false, false],
    appliedOriginals: ['sagte er'],
  });
  app.selectAllFindings(true);
  assert.deepEqual(app.selectedFindings, [false, false, false, true]);
  app.toggleFinding(0);
  assert.equal(app.selectedFindings[0], false, 'Markierungs-Klick wählt Übernommenes nicht an');
  app.toggleFinding(3);
  assert.equal(app.selectedFindings[3], false, 'Abwählen bleibt möglich');
});

test('mehrdeutige Fundstelle ist nicht vorausgewählt', () => {
  const app = makeApp();
  assert.equal(app.findingPreselected(F('grammatik', 'und ging', 'und lief')), true);
  assert.equal(app.findingPreselected(F('grammatik', 'und ging', 'und lief', { mehrdeutig: true })), false);
});

test('skipReason: wirkungsloser Vorschlag ist „unchanged", nicht „boundary"', () => {
  assert.equal(skipReason(HTML, '«Ja», sagte er', '"Ja", sagte er'), 'unchanged');
  assert.equal(skipReason(HTML, '«Ja», sagte er'), 'boundary', 'ohne Ersatz unverändert');
});

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => [] };
  };
  return calls;
}

test('Speichern: Befund ohne Vorschlag gilt als übersprungen, nicht als übernommen', async () => {
  const calls = stubFetch();
  const ok = F('grammatik', 'und ging', 'und lief');
  const leer = F('rechtschreibung', 'Hause', '');
  const app = makeApp({
    lektoratFindings: [ok, leer],
    selectedFindings: [true, true],
    lastCheckId: 42,
    async _loadApplyAndSave() { return { finalHtml: HTML, skipped: [], pageId: 1, stale: false }; },
  });
  await app.saveCorrections();
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'PATCH gesendet');
  assert.deepEqual(patch.body.applied_errors_json.map(f => f.original), ['und ging']);
  assert.match(app.statusLog.at(-1), /correctionsSavedWithSkips/);
});

test('Speichern: PATCH geht an den gepinnten Lauf, auch nach Seitenwechsel', async () => {
  const calls = stubFetch();
  const ok = F('grammatik', 'und ging', 'und lief');
  const app = makeApp({
    lektoratFindings: [ok],
    selectedFindings: [true],
    lastCheckId: 42,
    activeHistoryEntryId: 42,
    pageHistory: [{ id: 42, applied_errors_json: [F('stil', 'alt', 'neu')], selected_errors_json: null }],
  });
  app._loadApplyAndSave = async () => {
    // Während des Speicherns: anderer Abschnitt, anderer History-Eintrag offen.
    app.currentPage = { id: 2, name: 'S 2' };
    app.lastCheckId = 99;
    app.activeHistoryEntryId = 99;
    return { finalHtml: HTML, skipped: [], pageId: 1, stale: true };
  };
  await app.saveCorrections();
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'trotz Seitenwechsel verbucht');
  assert.equal(patch.url, '/history/check/42/saved');
  assert.deepEqual(patch.body.applied_errors_json.map(f => f.original), ['alt', 'und ging'], 'mit dem Eintrag gemergt');
  assert.equal(app.lastCheckId, 99, 'State der neuen Seite unangetastet');
});

test('History-Eintrag: gesperrt ist nur, was im Text gelandet ist', async () => {
  stubFetch();
  const app = makeApp();
  const entry = {
    id: 7, saved: true, stilanalyse: null, fazit: null,
    errors_json: [F('grammatik', 'und ging', 'und lief'), F('grammatik', 'sagte er', 'sagte er,')],
    applied_errors_json: [F('grammatik', 'sagte er', 'sagte er,')],
    // Auswahl enthielt auch den übersprungenen Befund.
    selected_errors_json: [F('grammatik', 'und ging', 'und lief'), F('grammatik', 'sagte er', 'sagte er,')],
    szenen_json: null,
  };
  await app.loadHistoryEntry(entry);
  assert.deepEqual(app.appliedOriginals, ['sagte er']);
  const idx = app.lektoratFindings.findIndex(f => f.original === 'und ging');
  assert.equal(app.selectedFindings[idx], true, 'übersprungener Befund wieder auswählbar und vorausgewählt');
});

test('History-Eintrag: Details nach Seitenwechsel landen nicht auf der neuen Seite', async () => {
  const app = makeApp();
  globalThis.fetch = async () => {
    app.currentPage = { id: 2, name: 'S 2' };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ errors_json: [F('grammatik', 'und ging', 'und lief')] }) };
  };
  await app.loadHistoryEntry({ id: 7, saved: false });
  assert.equal(app.checkDone, undefined);
  assert.equal(app.lastCheckId, null);
  assert.deepEqual(app.lektoratFindings, []);
});
