// Unit: onDone der Rückblick-Karte (cards/tagebuch-rueckblick-card.js
// #rueckblickOnDone) zeigt das Ergebnis unter dem Zeitraum DES LAUFS
// (job.result.zeitraum), nicht unter dem gerade gewählten. Fall: Karte nach dem
// Start geschlossen und wieder geöffnet (Default-Zeitraum) oder während des
// Laufs einen anderen Zeitraum gewählt.
import test from 'node:test';
import assert from 'node:assert/strict';

const navStore = { selectedBookId: 1, pages: [], books: [] };
const shellStore = { uiLocale: 'de' };
globalThis.Alpine = { store: (n) => (n === 'nav' ? navStore : n === 'shell' ? shellStore : {}) };
globalThis.window = { __app: { t: (k) => k, tn: (k, n) => `${k}:${n}` } };

const { rueckblickOnDone } = await import('../../public/js/cards/tagebuch-rueckblick-card.js');
const { tagebuchRueckblickMethods } = await import('../../public/js/book/tagebuch-rueckblick.js');

const HISTORY = [
  { id: 9, zeitraum: '2024-03', created_at: '2024-05-01T00:00:00Z' },
  { id: 8, zeitraum: '2024-05', created_at: '2024-06-01T00:00:00Z' },
];
const RESULT = { zusammenfassung: 'März.', themen: [], personen: [], orte: [], bemerkenswerteTage: [] };

function card(overrides = {}) {
  return Object.assign(Object.create(tagebuchRueckblickMethods), {
    _memos: {}, _rbResults: {}, rbFacetMore: {},
    rbBeleg: { key: null, label: '', belege: [] },
    rueckblickHistory: [], rbCoverage: null, rbMainView: 'period', rbVerlauf: {},
    rueckblickZeitraum: '', rueckblickResult: null, selectedRueckblickId: null,
    rueckblickEmpty: false, rueckblickStatus: '',
    $nextTick: () => Promise.resolve(),
    loadRueckblickHistory() { this.rueckblickHistory = HISTORY; return Promise.resolve(); },
    loadRueckblickCoverage() { return Promise.resolve(); },
    loadRueckblickVerlauf() { this.verlaufLoaded = true; },
    ...overrides,
  });
}

test('onDone: Ergebnis landet unter job.result.zeitraum, nicht unter dem gewählten Zeitraum', async () => {
  const c = card({ rueckblickZeitraum: '2024-05' }); // Default nach Reconnect / Wechsel während des Laufs
  await rueckblickOnDone.call(c, { result: { zeitraum: '2024-03', rueckblick: RESULT } });
  assert.equal(c.rueckblickZeitraum, '2024-03');
  assert.equal(c.selectedRueckblickId, 9, 'Permalink zeigt auf den Lauf des Jobs');
  assert.deepEqual(c.rueckblickResult, RESULT);
  assert.equal(c.rbVerlauf, null, 'Verlauf wird nach einem neuen Lauf neu geladen');
});

test('onDone: leerer Lauf setzt den Leerzustand am Zeitraum des Laufs', async () => {
  const applied = [];
  const c = card({ rueckblickZeitraum: '2024-05', _applyRueckblickZeitraum(z) { applied.push(z); this.rueckblickZeitraum = z; } });
  await rueckblickOnDone.call(c, { result: { zeitraum: '2024-04', empty: true } });
  assert.deepEqual(applied, ['2024-04']);
  assert.equal(c.rueckblickEmpty, true);
});

test('onDone: offener Verlauf → Hauptbereich zeigt das neue Ergebnis, Verlauf lädt beim nächsten Öffnen', async () => {
  const c = card({ rbMainView: 'verlauf' });
  await rueckblickOnDone.call(c, { result: { zeitraum: '2024-03', rueckblick: RESULT } });
  assert.equal(c.rbMainView, 'period');
  assert.deepEqual(c.rueckblickResult, RESULT);
  assert.equal(c.rbVerlauf, null, 'Verlauf verworfen — der rbMainView-Watcher lädt ihn beim Zurückschalten');
});
