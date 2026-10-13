// Unit: Tagebuch-Rückblick Frontend-Methoden — History-Filter, Aktualität,
// Nachbar-Zeiträume, sortierte Facetten, Belege + Zeitleiste, Entitäts-Auflösung
// (book/tagebuch-rueckblick.js). Pure genug für node:test mit minimalem window.
import test from 'node:test';
import assert from 'node:assert/strict';

let selected = null;
// Nav-State lebt in Alpine.store('nav') (kein Root-Proxy mehr) — Methoden lesen
// pages via Alpine.store('nav'). Minimal-Stub fuer node:test.
const navStore = { books: [], selectedBookId: 1, pages: [], tree: [] };
const shellStore = { uiLocale: 'de' };
globalThis.Alpine = { store: (name) => (name === 'nav' ? navStore : name === 'shell' ? shellStore : {}) };
globalThis.window = {
  __app: {
    uiLocale: 'de',
    selectPage: (p) => { selected = p; },
    t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k),
    figurenById: new Map([['fig_1', { id: 'fig_1', name: 'Anna Muster', kurzname: 'Anna' }]]),
    orteById: new Map([['loc_1', { id: 'loc_1', name: 'Zürich' }]]),
  },
  innerWidth: 1000,
};

const { tagebuchRueckblickMethods: M } = await import('../../public/js/book/tagebuch-rueckblick.js');

function ctx(overrides = {}) {
  return Object.assign(Object.create(M), {
    _memos: {},
    _rbResults: {},
    rueckblickHistory: [],
    rbHistorySearch: '',
    rbSearchIds: [],
    rbCoverage: null,
    rbCurrentModel: '',
    rueckblickZeitraum: '',
    rueckblickLoading: false,
    selectedRueckblickId: null,
    rueckblickResult: null,
    rbBeleg: { key: null, label: '', belege: [] },
    ...overrides,
  });
}

// Liste trägt nur Metadaten; der Inhalt wird serverseitig gesucht (rbSearchIds).
const HISTORY = [
  { id: 1, zeitraum: '2024-03', created_at: '2024-04-01T00:00:00Z', model: 'claude-opus-5-5', entry_count: 2 },
  { id: 2, zeitraum: '2023', created_at: '2024-01-01T00:00:00Z', model: 'claude-sonnet-4-6', entry_count: 1 },
];

const COVERAGE = {
  months: {
    '2023-12': { entries: 1, newest: Date.parse('2023-12-31T00:00:00Z'), rueckblick: null },
    '2024-03': { entries: 2, newest: Date.parse('2024-03-20T00:00:00Z'), rueckblick: { id: 1, created_at: '2024-04-01T00:00:00Z' } },
    '2024-05': { entries: 1, newest: Date.parse('2024-05-02T00:00:00Z'), rueckblick: null },
  },
  years: {
    '2023': { entries: 1, newest: Date.parse('2023-12-31T00:00:00Z'), rueckblick: { id: 2, created_at: '2024-01-01T00:00:00Z' } },
    '2024': { entries: 3, newest: Date.parse('2024-05-02T00:00:00Z'), rueckblick: null },
  },
  days: { '2023-12-31': 30, '2024-03-04': 31, '2024-03-20': 32, '2024-05-02': 33 },
  minYear: 2023, maxYear: 2024,
};

test('filteredRueckblickHistory: leere Suche → alle', () => {
  const c = ctx({ rueckblickHistory: HISTORY });
  assert.equal(c.filteredRueckblickHistory().length, 2);
});

test('filteredRueckblickHistory: Inhalt über Server-Treffer, Zeitraum lokal (roh + Label)', () => {
  const c = ctx({ rueckblickHistory: HISTORY });
  c.rbHistorySearch = 'wanderung';
  c.rbSearchIds = [1];
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [1]);
  c.rbHistorySearch = '2023';
  c.rbSearchIds = [];
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [2]);
  c.rbHistorySearch = 'märz';
  assert.deepEqual(c.filteredRueckblickHistory().map(e => e.id), [1]);
  c.rbHistorySearch = 'xyz-nope';
  assert.equal(c.filteredRueckblickHistory().length, 0);
});

test('availableZeitraeume/defaultZeitraum: aus der Coverage, Monate vor Jahren, neueste zuerst', () => {
  const c = ctx({ rbCoverage: COVERAGE });
  assert.deepEqual(c.availableZeitraeume().map(o => o.value), ['2024-05', '2024-03', '2023-12', '2024', '2023']);
  assert.equal(c.defaultZeitraum(), '2024-05');
  assert.deepEqual(ctx().availableZeitraeume(), []);
});

test('rbNeighbor: gleiche Körnung, Rand = null', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickZeitraum: '2024-03' });
  assert.equal(c.rbNeighbor(-1), '2023-12');
  assert.equal(c.rbNeighbor(1), '2024-05');
  c.rueckblickZeitraum = '2024-05';
  assert.equal(c.rbNeighbor(1), null);
  c.rueckblickZeitraum = '2024';
  assert.equal(c.rbNeighbor(-1), '2023');
  assert.equal(c.rbNeighbor(1), null);
  c.rueckblickZeitraum = '2024-04'; // ohne Einträge → nächster vorhandener
  assert.equal(c.rbNeighbor(-1), '2024-03');
  assert.equal(c.rbNeighbor(1), '2024-05');
});

test('rueckblickFreshness: none / current / changed / model / orphan', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickHistory: HISTORY, rbCurrentModel: 'claude-opus-5-5' });
  c.rueckblickZeitraum = '2024-05';
  assert.equal(c.rueckblickFreshness().state, 'none');
  c.rueckblickZeitraum = '2024-03';
  assert.equal(c.rueckblickFreshness().state, 'current');
  assert.equal(c.rueckblickUpToDate(), true);
  // Seite nach der Generierung bearbeitet
  c.rbCoverage = { ...COVERAGE, months: { ...COVERAGE.months, '2024-03': { ...COVERAGE.months['2024-03'], newest: Date.parse('2024-04-02T00:00:00Z') } } };
  assert.equal(c.rueckblickFreshness().state, 'changed');
  // Eintrag gelöscht (Anzahl ≠ Snapshot)
  c.rbCoverage = { ...COVERAGE, months: { ...COVERAGE.months, '2024-03': { ...COVERAGE.months['2024-03'], entries: 1 } } };
  assert.equal(c.rueckblickFreshness().state, 'changed');
  // älteres Modell
  c.rbCoverage = COVERAGE;
  c.rueckblickZeitraum = '2023';
  const f = c.rueckblickFreshness();
  assert.equal(f.state, 'model');
  assert.equal(f.model, 'claude-sonnet-4-6');
  // Einträge des Zeitraums verschwunden
  c.rueckblickHistory = [...HISTORY, { id: 3, zeitraum: '2020-06', created_at: '2021-01-01T00:00:00Z' }];
  c.rueckblickZeitraum = '2020-06';
  assert.equal(c.rueckblickFreshness().state, 'orphan');
});

test('canRunRueckblick: nie durch Aktualität gesperrt, nur durch Laden/fehlende Einträge', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickHistory: HISTORY, rbCurrentModel: 'claude-opus-5-5', rueckblickZeitraum: '2024-03' });
  assert.equal(c.rueckblickUpToDate(), true);
  assert.equal(c.canRunRueckblick(), true);
  c.rueckblickLoading = true;
  assert.equal(c.canRunRueckblick(), false);
  c.rueckblickLoading = false;
  c.rueckblickZeitraum = '2020-06';
  assert.equal(c.canRunRueckblick(), false);
  c.rbCoverage = null; // Coverage nicht geladen → nicht blockieren
  assert.equal(c.canRunRueckblick(), true);
});

test('gotoRueckblickTag: über coverage.days auf die Seiten-ID, sonst ISO-Name; canGotoTag', () => {
  navStore.pages = [{ id: 31, name: 'Montag, 4. März' }, { id: 40, name: '2024-03-21' }];
  const c = ctx({ rbCoverage: COVERAGE });
  selected = null;
  c.gotoRueckblickTag('2024-03-04');
  assert.deepEqual(selected, { id: 31, name: 'Montag, 4. März' });
  c.gotoRueckblickTag('2024-03-21');
  assert.equal(selected.id, 40);
  assert.equal(c.canGotoTag('2024-03-20'), false, 'Seite 32 nicht im Baum');
  assert.equal(c.canGotoTag('1999-01-01'), false);
});

test('rbTimeline: Eintragstage des Zeitraums mit Position, Belege markiert', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickZeitraum: '2024-03' });
  c.rbBeleg = { key: 'themen:x', label: 'x', belege: ['2024-03-20'] };
  const tl = c.rbTimeline();
  assert.deepEqual(tl.map(t => t.datum), ['2024-03-04', '2024-03-20']);
  assert.equal(tl[0].beleg, false);
  assert.equal(tl[1].beleg, true);
  assert.ok(tl[0].pos > 0 && tl[0].pos < tl[1].pos && tl[1].pos < 100);
  c.rueckblickZeitraum = '2024';
  assert.equal(c.rbTimeline().length, 3);
});

test('rbBelegRef: Person/Ort → Entitäts-Verweis bei Namens-/Kurznamen-Treffer', () => {
  const c = ctx();
  c.rbBeleg = { key: 'personen:anna', label: 'anna', belege: [] };
  assert.deepEqual(c.rbBelegRef(), { type: 'figur', id: 'fig_1' });
  c.rbBeleg = { key: 'orte:Zürich', label: 'Zürich', belege: [] };
  assert.deepEqual(c.rbBelegRef(), { type: 'ort', id: 'loc_1' });
  c.rbBeleg = { key: 'personen:Bernd', label: 'Bernd', belege: [] };
  assert.equal(c.rbBelegRef(), null);
  c.rbBeleg = { key: 'themen:Anna', label: 'Anna', belege: [] };
  assert.equal(c.rbBelegRef(), null, 'Themen sind keine Entitäten');
});

test('rbThemen/rbPersonen/rbOrte: nach Häufigkeit absteigend sortiert', () => {
  const c = ctx({ rueckblickResult: {
    themen: [{ label: 'A', haeufigkeit: 1 }, { label: 'B', haeufigkeit: 5 }, { label: 'C', haeufigkeit: 3 }],
    personen: [{ name: 'Anna', haeufigkeit: 2 }, { name: 'Bernd', haeufigkeit: 9 }],
    orte: [],
  } });
  assert.deepEqual(c.rbThemen().map(t => t.label), ['B', 'C', 'A']);
  assert.deepEqual(c.rbPersonen().map(p => p.name), ['Bernd', 'Anna']);
  assert.deepEqual(c.rbOrte(), []);
});

test('toggleBeleg: setzt aktiven Key + dedupte/sortierte Belegtage, erneuter Klick schliesst', () => {
  const c = ctx();
  c.toggleBeleg('personen:Anna', 'Anna', ['2024-03-12', '2024-03-04', '2024-03-12']);
  assert.equal(c.rbBeleg.key, 'personen:Anna');
  assert.equal(c.rbBeleg.label, 'Anna');
  assert.deepEqual(c.rbBeleg.belege, ['2024-03-04', '2024-03-12']);
  // Gleicher Key erneut → schliesst.
  c.toggleBeleg('personen:Anna', 'Anna', ['2024-03-12']);
  assert.equal(c.rbBeleg.key, null);
  // Anderer Key → wechselt.
  c.toggleBeleg('orte:Zürich', 'Zürich', ['2024-03-04']);
  assert.equal(c.rbBeleg.key, 'orte:Zürich');
});

test('gotoBelegTag: schliesst Belege-Leiste + navigiert', () => {
  selected = null;
  navStore.pages = [{ name: '2024-03-04', id: 7 }];
  const c = ctx({ rbBeleg: { key: 'orte:x', label: 'x', belege: ['2024-03-04'] } });
  c.gotoBelegTag('2024-03-04');
  assert.equal(c.rbBeleg.key, null);
  assert.deepEqual(selected, { name: '2024-03-04', id: 7 });
});

test('belegLabel: ISO-Datum → lokalisierter Tag, ungültig → roh', () => {
  const c = ctx();
  const label = c.belegLabel('2024-03-04');
  assert.match(label, /2024/);
  assert.match(label, /03|März|Mär/);
  assert.equal(c.belegLabel('foo'), 'foo');
});
