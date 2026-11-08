// Kontinuitäts-Karte, Ansicht-Menü + Fokus (book/kontinuitaet-view.js):
//  - Grundansicht blendet Erledigte aus, «Kein Fehler» und Verworfene sind verborgen.
//  - Jeder Schalter holt genau seinen Triage-Stand zurück; Schwere-Zähler zählen
//    nur, was die Liste führt.
//  - Fokus «Nicht mehr gemeldet» zeigt nur offene mit missing_since, gleich welche Ansicht.
//  - Sortierung: offen vor erledigt vor «kein Fehler» vor verworfen, je Stand nach Schwere.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const filters = { figurId: '', kapitelId: '', schwere: '', fokus: '', suche: '' };
const view = { hideResolved: true, showDismissed: false, showDiscarded: false };
const stores = { nav: { tree: [], pages: [], selectedBookId: 1 }, catalog: { figuren: [] }, catalogUi: { kontinuitaetFilters: filters, kontinuitaetView: view } };
globalThis.Alpine = { store: (k) => stores[k] };
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.Alpine = globalThis.Alpine;
globalThis.window.__app = { $store: stores, t: (k) => (k === 'kontinuitaet.discard.reason.verify' ? 'Verify sagt nein.' : k) };

const { kontinuitaetMethods } = await import('../../public/js/book/kontinuitaet.js');
const { KONTINUITAET_VIEW_DEFAULTS, kontinuitaetVisible } = await import('../../public/js/book/kontinuitaet-view.js');
const { viewMenuChangeCount } = await import('../../public/js/view-menu.js');
const changes = (c) => viewMenuChangeCount(c.viewMenuSpec().items);

function setView(v) { Object.assign(view, KONTINUITAET_VIEW_DEFAULTS, v); }
function card(result) { return { ...kontinuitaetMethods, _memos: {}, kontinuitaetResult: result }; }
const ids = (c) => { c._memos = {}; return c.kontinuitaetIssuesSorted().map(i => i.id); };

const RESULT = {
  issues: [
    { id: 1, schwere: 'niedrig', resolved: false, dismissed: false },
    { id: 2, schwere: 'mittel', resolved: false, dismissed: true },
    { id: 4, schwere: 'kritisch', resolved: true, dismissed: false },
    { id: 5, schwere: 'kritisch', resolved: false, dismissed: false },
  ],
  discarded: [
    { id: 3, schwere: 'kritisch', resolved: false, dismissed: true, discarded: true, discard_reason: 'verify', discard_detail: 'Rückblende' },
  ],
};

test('Grundansicht: Erledigte aus, «Kein Fehler» und Verworfene verborgen', () => {
  assert.deepEqual({ ...KONTINUITAET_VIEW_DEFAULTS }, { hideResolved: true, showDismissed: false, showDiscarded: false });
  setView({});
  const c = card(RESULT);
  assert.deepEqual(ids(c), [5, 1]);
  assert.equal(c.kontinuitaetOpenCount(), 2);
  assert.deepEqual(c.kontinuitaetSeverityCounts(), { all: 2, kritisch: 1, mittel: 0, niedrig: 1 });
  assert.equal(c.kontinuitaetHiddenCount(), 2);
  assert.equal(changes(c), 0);
});

test('Schalter holen ihren Stand zurück, Sortierung nach Triage-Rang dann Schwere', () => {
  const c = card(RESULT);
  setView({ hideResolved: false });
  assert.deepEqual(ids(c), [5, 1, 4]);
  assert.equal(changes(c), 1);
  setView({ hideResolved: false, showDismissed: true, showDiscarded: true });
  assert.deepEqual(ids(c), [5, 1, 4, 2, 3]);
  assert.equal(changes(c), 3);
  assert.equal(c.kontinuitaetHiddenCount(), 0);
  assert.equal(c.kontinuitaetDiscardReasonText(RESULT.discarded[0]), 'Verify sagt nein.');
  setView({ showDiscarded: true });
  c._memos = {};
  assert.equal(c.kontinuitaetSeverityCounts().kritisch, 2, 'Verworfener zählt nur, wenn eingeblendet');
  setView({});
});

test('Einblend-Schalter ohne Befunde dahinter fehlen im Menü und zählen nicht', () => {
  const c = card({ issues: [{ id: 1, schwere: 'mittel' }], discarded: [] });
  setView({ showDismissed: true, showDiscarded: true });
  assert.deepEqual(c.viewMenuSpec().items.map(i => i.key), ['hideResolved']);
  assert.equal(changes(c), 0);
  setView({});
  assert.deepEqual(card(RESULT).viewMenuSpec().items.map(i => i.key), ['hideResolved', 'showDismissed', 'showDiscarded']);
});

test('Menü-Schalter schreiben die Ansicht in place', () => {
  setView({});
  const c = card(RESULT);
  c.viewMenuSpec().items.find(i => i.key === 'hideResolved').toggle();
  assert.equal(view.hideResolved, false);
  setView({});
});

test('kontinuitaetShowHidden blendet Erledigte und «Kein Fehler» ein', () => {
  setView({});
  const c = card(RESULT);
  c.kontinuitaetShowHidden();
  assert.equal(view.hideResolved, false);
  assert.equal(view.showDismissed, true);
  assert.equal(view.showDiscarded, false);
  setView({});
});

test('Filter zurücksetzen fasst die Ansicht nicht an', () => {
  setView({ hideResolved: false });
  filters.schwere = 'kritisch';
  card(RESULT).kontinuitaetResetFilters();
  assert.equal(filters.schwere, '');
  assert.equal(view.hideResolved, false);
  setView({});
});

test('Fokus «Nicht mehr gemeldet»: nur offene mit missing_since, übersteuert die Ansicht', async () => {
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
  setView({ hideResolved: false, showDismissed: true });
  c.kontinuitaetToggleFokusMissing();
  assert.equal(filters.fokus, 'missing');
  assert.deepEqual(ids(c), [2]);
  assert.deepEqual(c.kontinuitaetMissingIssues().map(i => i.id), [2]);
  c.kontinuitaetToggleFokusMissing();
  assert.equal(filters.fokus, '');
  setView({});
  assert.deepEqual(ids(c).sort(), [1, 2]);
  assert.equal(kontinuitaetVisible({ discarded: true, missing_since: 'x' }, view, 'missing'), false);
});
