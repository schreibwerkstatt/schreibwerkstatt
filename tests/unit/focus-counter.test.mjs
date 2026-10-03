// Unit-Tests für Edit-Counter-Helpers (public/js/editor/shared/edit-counter.js,
// von Notebook + Focus konsumiert) und Focus-Snapshot-TTL
// (public/js/editor/focus/storage.js).
//   - `fmtSigned` — Vorzeichen-Format (Unicode-Minus, ±0).
//   - `dailyDelta` — Tages-Baseline-Delta inkl. Prune fremder Tage.
//   - Snapshot-TTL — Lesen ignoriert >1h alte Snapshots und räumt sie ab.
//
// localStorage/sessionStorage als In-Memory-Stub; Date.now für TTL gesteuert.

import test from 'node:test';
import assert from 'node:assert/strict';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}
globalThis.localStorage = memStorage();
globalThis.sessionStorage = memStorage();

const { fmtSigned, dailyDelta } = await import('../../public/js/editor/shared/edit-counter.js');
const { writeFocusSnapshot, readFocusSnapshot } = await import('../../public/js/editor/focus/storage.js');

// --- fmtSigned --------------------------------------------------------------

test('fmtSigned: positiv → +n', () => {
  assert.equal(fmtSigned(5), '+5');
});

test('fmtSigned: negativ → Unicode-Minus + Betrag', () => {
  assert.equal(fmtSigned(-7), '−7'); // U+2212, nicht ASCII-Hyphen
  assert.notEqual(fmtSigned(-7), '-7');
});

test('fmtSigned: null → ±0', () => {
  assert.equal(fmtSigned(0), '±0');
});

// --- dailyDelta -------------------------------------------------------------

test('dailyDelta: pageId null → Null-Delta', () => {
  assert.deepEqual(dailyDelta(null, 100, 500), { dw: 0, dc: 0 });
});

test('dailyDelta: erster Aufruf setzt Baseline → 0-Delta', () => {
  localStorage.clear();
  assert.deepEqual(dailyDelta(42, 100, 500), { dw: 0, dc: 0 });
});

test('dailyDelta: Folgeaufruf desselben Tages → Differenz zur Baseline', () => {
  localStorage.clear();
  dailyDelta(42, 100, 500);          // Baseline
  assert.deepEqual(dailyDelta(42, 130, 560), { dw: 30, dc: 60 });
});

test('dailyDelta: prunt Baseline-Einträge fremder Tage', () => {
  localStorage.clear();
  localStorage.setItem('focus.dailyBaseline', JSON.stringify({
    99: { date: '2000-01-01', words: 10, chars: 50 },
  }));
  dailyDelta(42, 100, 500);
  const stored = JSON.parse(localStorage.getItem('focus.dailyBaseline'));
  assert.equal(stored['99'], undefined, 'stale Tag muss entfernt sein');
  assert.ok(stored['42'], 'neuer Eintrag muss existieren');
});

// --- Focus-Snapshot-TTL -----------------------------------------------------

test('readFocusSnapshot: frischer Snapshot wird zurückgegeben', () => {
  sessionStorage.clear();
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    writeFocusSnapshot(7);
    const snap = readFocusSnapshot();
    assert.equal(snap?.pageId, 7);
  } finally { Date.now = realNow; }
});

test('readFocusSnapshot: >1h alter Snapshot → null + abgeräumt', () => {
  sessionStorage.clear();
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    writeFocusSnapshot(7);
    Date.now = () => 1_000_000 + 60 * 60 * 1000 + 1; // knapp über TTL
    assert.equal(readFocusSnapshot(), null);
    assert.equal(sessionStorage.getItem('focus.snapshot'), null, 'stale Snapshot muss gelöscht sein');
  } finally { Date.now = realNow; }
});

test('readFocusSnapshot: genau an der TTL-Grenze noch gültig', () => {
  sessionStorage.clear();
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    writeFocusSnapshot(7);
    Date.now = () => 1_000_000 + 60 * 60 * 1000; // exakt TTL → nicht abgelaufen
    assert.equal(readFocusSnapshot()?.pageId, 7);
  } finally { Date.now = realNow; }
});

// --- Snapshot-Refresh: Verdrahtung in der SPA-Karte -------------------------
// Quelltext-Guard: die TTL läuft ab der letzten Speicher-Aktivität. Das
// Verhalten von `refreshFocusSnapshot` selbst prüft focus-editor.spec.js.
test('editor-focus-card.js frischt den Snapshot bei beiden Save-Zeitstempeln auf', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../public/js/cards/editor-focus-card.js', import.meta.url), 'utf8');
  assert.match(src, /\$watch\(\(\) => window\.__app\?\.lastAutosaveAt, \(\) => this\.refreshFocusSnapshot\(\)\)/);
  assert.match(src, /\$watch\(\(\) => window\.__app\?\.lastDraftSavedAt, \(\) => this\.refreshFocusSnapshot\(\)\)/);
});
