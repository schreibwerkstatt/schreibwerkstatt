// Kontinuitäts-Karte: verworfene Befunde (result.discarded) erscheinen nur im Filter
// «Verworfen» und zählen in keinem anderen Status-Filter oder Zähler als offen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const filters = { figurId: '', kapitel: '', schwere: '', status: '' };
const stores = { nav: { tree: [], selectedBookId: 1 }, catalog: { figuren: [] }, catalogUi: { kontinuitaetFilters: filters } };
globalThis.Alpine = { store: (k) => stores[k] };
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.Alpine = globalThis.Alpine;
globalThis.window.__app = { $store: stores, t: (k) => (k === 'kontinuitaet.discard.reason.verify' ? 'Verify sagt nein.' : k) };

const { kontinuitaetMethods, kontinuitaetSource, KONTINUITAET_STATUS_FILTERS } = await import('../../public/js/book/kontinuitaet.js');

function card(result) {
  const c = { ...kontinuitaetMethods, _memos: {}, kontinuitaetResult: result };
  return c;
}

const RESULT = {
  issues: [
    { id: 1, schwere: 'kritisch', resolved: false, dismissed: false },
    { id: 2, schwere: 'mittel', resolved: false, dismissed: true },
  ],
  discarded: [
    { id: 3, schwere: 'kritisch', resolved: false, dismissed: false, discarded: true, discard_reason: 'verify', discard_detail: 'Rückblende' },
  ],
};

test('Status-Filter «discarded» existiert und liest die eigene Liste', () => {
  assert.ok(KONTINUITAET_STATUS_FILTERS.includes('discarded'));
  assert.deepEqual(kontinuitaetSource(RESULT, 'discarded').map(i => i.id), [3]);
  assert.deepEqual(kontinuitaetSource(RESULT, '').map(i => i.id), [1, 2]);
});

test('Verworfene zählen nicht als offen und erscheinen nur unter «Verworfen»', () => {
  const c = card(RESULT);
  assert.equal(c.kontinuitaetOpenCount(), 1);
  assert.equal(c.kontinuitaetDiscardedCount(), 1);
  for (const st of ['', 'open', 'resolved', 'dismissed']) {
    filters.status = st;
    c._memos = {};
    assert.ok(!c.kontinuitaetIssuesSorted().some(i => i.discarded), `Status «${st}» zeigt keine Verworfenen`);
  }
  filters.status = 'discarded';
  c._memos = {};
  assert.deepEqual(c.kontinuitaetIssuesSorted().map(i => i.id), [3]);
  assert.equal(c.kontinuitaetSeverityCounts().kritisch, 1);
  assert.equal(c.kontinuitaetDiscardReasonText(RESULT.discarded[0]), 'Verify sagt nein.');
  filters.status = '';
});

test('«Nicht mehr gemeldet»: nur offene mit missing_since, zugleich offen', async () => {
  const { kontinuitaetRecheckMethods } = await import('../../public/js/book/kontinuitaet-recheck.js');
  const result = {
    issues: [
      { id: 1, schwere: 'mittel', resolved: false, dismissed: false },
      { id: 2, schwere: 'mittel', resolved: false, dismissed: false, missing_since: '2026-10-15T06:31:49.177Z' },
      { id: 3, schwere: 'mittel', resolved: true, dismissed: false, missing_since: '2026-10-15T06:31:49.177Z' },
      { id: 4, schwere: 'mittel', resolved: false, dismissed: true, missing_since: '2026-10-15T06:31:49.177Z' },
    ],
    discarded: [],
  };
  const c = { ...card(result), ...kontinuitaetRecheckMethods };
  assert.ok(KONTINUITAET_STATUS_FILTERS.includes('missing'));
  filters.status = 'missing';
  c._memos = {};
  assert.deepEqual(c.kontinuitaetIssuesSorted().map(i => i.id), [2]);
  assert.deepEqual(c.kontinuitaetMissingIssues().map(i => i.id), [2]);
  filters.status = 'open';
  c._memos = {};
  assert.deepEqual(c.kontinuitaetIssuesSorted().map(i => i.id).sort(), [1, 2]);
  filters.status = '';
});
