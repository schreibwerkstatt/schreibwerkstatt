// Unit: Tagebuch-Rückblick Frontend-Methoden — History-Filter, Aktualität,
// Nachbar-Zeiträume, sortierte Facetten, Belege + Zeitleiste, Entitäts-Auflösung
// (book/tagebuch-rueckblick.js), Kalender + Zustand des Hauptbereichs
// (book/rueckblick-calendar.js). Pure genug für node:test mit minimalem window.
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
    tn: (k, n) => `${k}:${n}`,
    figurenById: new Map([['fig_1', { id: 'fig_1', name: 'Anna Muster', kurzname: 'Anna' }]]),
    orteById: new Map([['loc_1', { id: 'loc_1', name: 'Zürich' }]]),
  },
  innerWidth: 1000,
};

const { tagebuchRueckblickMethods } = await import('../../public/js/book/tagebuch-rueckblick.js');
const { rueckblickCalendarMethods } = await import('../../public/js/book/rueckblick-calendar.js');
const M = { ...tagebuchRueckblickMethods, ...rueckblickCalendarMethods };

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
    rueckblickEmpty: false,
    rbHistoryLoaded: true,
    rbMainView: 'period',
    rbBeleg: { key: null, label: '', belege: [] },
    rbFacetMore: {},
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
    '2024-03': { entries: 2, newest: Date.parse('2024-03-20T00:00:00Z'), rueckblick: { id: 1, created_at: '2024-04-01T00:00:00Z', stale: false } },
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

test('availableZeitraeume/defaultZeitraum: aus der Coverage, nur die Körnung des Zeitraums, neueste zuerst', () => {
  const c = ctx({ rbCoverage: COVERAGE });
  assert.equal(c.rbGrain(), 'month');
  assert.deepEqual(c.availableZeitraeume().map(o => o.value), ['2024-05', '2024-03', '2023-12']);
  assert.equal(c.defaultZeitraum(), '2024-05');
  c.rueckblickZeitraum = '2024';
  assert.equal(c.rbGrain(), 'year');
  assert.deepEqual(c.availableZeitraeume().map(o => o.value), ['2024', '2023']);
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
  // Server meldet den Rückblick als veraltet (rueckblickStale)
  c.rbCoverage = { ...COVERAGE, months: { ...COVERAGE.months, '2024-03': { ...COVERAGE.months['2024-03'], rueckblick: { id: 1, created_at: '2024-04-01T00:00:00Z', stale: true } } } };
  assert.equal(c.rueckblickFreshness().state, 'changed');
  // älteres Modell
  c.rbCoverage = COVERAGE;
  c.rueckblickZeitraum = '2023';
  const f = c.rueckblickFreshness();
  assert.equal(f.state, 'model');
  assert.equal(f.model, 'claude-sonnet-4-6');
  // Modellwechsel nur als Tooltip an der Meta-Zeile, kein eigener Hinweis.
  assert.equal(c.rbFreshnessHint(), '');
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

test('rbFacet: Personen/Orte mit nur einem Beleg hinter «weitere», Themen vollständig', () => {
  const c = ctx({ rueckblickResult: {
    themen: [{ label: 'A', haeufigkeit: 1 }, { label: 'B', haeufigkeit: 1 }],
    personen: [{ name: 'Anna', haeufigkeit: 4 }, { name: 'Bernd', haeufigkeit: 1 }, { name: 'Cora', haeufigkeit: 1 }],
    orte: [{ name: 'Olten', haeufigkeit: 1 }],
  } });
  assert.equal(c.rbFacet('themen').main.length, 2);
  assert.deepEqual(c.rbFacet('personen').main.map(p => p.name), ['Anna']);
  assert.deepEqual(c.rbFacet('personen').rest.map(p => p.name), ['Bernd', 'Cora']);
  assert.deepEqual(c.rbFacet('orte').main.map(o => o.name), ['Olten'], 'nur Einzelnennungen → nichts einklappen');
  assert.deepEqual(c.rbFacetVisible('personen').map(p => p.name), ['Anna']);
  c.toggleRbFacetMore('personen');
  assert.deepEqual(c.rbFacetVisible('personen').map(p => p.name), ['Anna', 'Bernd', 'Cora']);
  assert.equal(c.rbFacetMoreLabel('personen'), 'rueckblick.facetMore:2');
});

test('groupedRueckblickHistory: je Zeitraum der jüngste Lauf, ältere darunter', () => {
  const c = ctx({ rueckblickHistory: [
    { id: 5, zeitraum: '2024-03', created_at: '2024-05-01T00:00:00Z' },
    { id: 4, zeitraum: '2023', created_at: '2024-04-02T00:00:00Z' },
    { id: 1, zeitraum: '2024-03', created_at: '2024-04-01T00:00:00Z' },
  ] });
  const g = c.groupedRueckblickHistory();
  assert.deepEqual(g.map(x => [x.zeitraum, x.latest.id, x.older.map(o => o.id)]), [['2024-03', 5, [1]], ['2023', 4, []]]);
});

test('rbBelegRef/rbBelegAliase: Aliase und alter Klammer-Zusatz lösen die Figur auf', () => {
  const c = ctx();
  c.toggleBeleg('personen:Annie', 'Annie', [], ['Anna']);
  assert.deepEqual(c.rbBelegRef(), { type: 'figur', id: 'fig_1' }, 'über den Alias');
  assert.match(c.rbBelegAliase(), /rueckblick.aliase/);
  c.toggleBeleg('personen:Anna (Schwester)', 'Anna (Schwester)', []);
  assert.deepEqual(c.rbBelegRef(), { type: 'figur', id: 'fig_1' }, 'Altergebnis mit Klammer');
  assert.equal(c.rbBelegAliase(), '');
});

test('rbTimelineHits/Ticks: Belegtage getrennt von den übrigen Eintragstagen', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickZeitraum: '2024-03' });
  c.rbBeleg = { key: 'themen:x', label: 'x', belege: ['2024-03-20'] };
  assert.deepEqual(c.rbTimelineHits().map(t => t.datum), ['2024-03-20']);
  assert.deepEqual(c.rbTimelineTicks().map(t => t.datum), ['2024-03-04']);
});

test('belegLabelShort: ohne Jahr (Monat: Wochentag + Tag, Jahr: Tag + Monat)', () => {
  const c = ctx({ rueckblickZeitraum: '2024-03' });
  assert.doesNotMatch(c.belegLabelShort('2024-03-04'), /2024/);
  assert.match(c.belegLabelShort('2024-03-04'), /4/);
  c.rueckblickZeitraum = '2024';
  assert.match(c.belegLabelShort('2024-03-04'), /Mär|Mar/);
  assert.equal(c.belegLabelShort('foo'), 'foo');
});

test('openCalendarCell: während eines Laufs gesperrt', () => {
  const applied = [];
  const c = ctx({ rueckblickLoading: true });
  c._applyRueckblickZeitraum = (z) => applied.push(z);
  c.openCalendarCell({ key: '2024-03', hasEntries: true });
  assert.deepEqual(applied, []);
  c.rueckblickLoading = false;
  c.openCalendarCell({ key: '2024-03', hasEntries: true });
  assert.deepEqual(applied, ['2024-03']);
});

test('openCalendarCell: Jahres-Zelle wählt das Jahr, leere Zelle nichts', () => {
  const applied = [];
  const c = ctx();
  c._applyRueckblickZeitraum = (z) => applied.push(z);
  c.openCalendarCell({ key: '2023', isYear: true, hasRueckblick: true, hasEntries: true });
  c.openCalendarCell({ key: '2022-01', hasEntries: false, hasRueckblick: false });
  assert.deepEqual(applied, ['2023']);
});

test('rbPeriodState: Rückblick, erstellen, vorhanden-geschlossen, leer, ohne Datierung', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickHistory: HISTORY });
  // Monat mit Einträgen, ohne Rückblick → Erstellen-Aufruf im Hauptbereich
  c.rueckblickZeitraum = '2024-05';
  assert.equal(c.rbPeriodState(), 'create');
  // Rückblick vorhanden, aber nicht geöffnet (Permalink-Zurück)
  c.rueckblickZeitraum = '2024-03';
  assert.equal(c.rbPeriodState(), 'hidden');
  // … wird gerade geladen → nichts (kein Aufblitzen des Leerzustands)
  c.selectedRueckblickId = 1;
  assert.equal(c.rbPeriodState(), '');
  c.rueckblickResult = { zusammenfassung: 'Text.' };
  assert.equal(c.rbPeriodState(), 'result');
  // Zeitraum ohne Einträge
  c.rueckblickResult = null;
  c.selectedRueckblickId = null;
  c.rueckblickZeitraum = '2022-07';
  assert.equal(c.rbPeriodState(), 'empty');
  // Lauf aktiv → Hauptbereich zeigt nur Fortschritt
  c.rueckblickZeitraum = '2024-05';
  c.rueckblickLoading = true;
  assert.equal(c.rbPeriodState(), '');
  c.rueckblickLoading = false;
  // History noch nicht geladen → kein «erstellen», das gleich wieder kippt
  c.rbHistoryLoaded = false;
  assert.equal(c.rbPeriodState(), '');
  c.rbHistoryLoaded = true;
  // Buch ohne datierte Einträge
  c.rbCoverage = { months: {}, years: {}, days: {}, minYear: null, maxYear: null };
  assert.equal(c.rbPeriodState(), 'noDated');
  assert.equal(c.rbHasCalendar(), false);
});

test('rbCalSummary + rbCalCellClass: Zählung über die Monate, Auswahl-Ring am Zeitraum', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickZeitraum: '2023' });
  assert.equal(c.rbCalSummary(), 'rueckblick.cal.summary {"done":1,"total":3}');
  const row23 = c.rueckblickCalendar().years.find(r => r.year === 2023);
  assert.match(c.rbCalCellClass(row23.yearCell), /ymheat-cell--year ymheat-cell--has ymheat-cell--active/);
  assert.doesNotMatch(c.rbCalCellClass(row23.months[11]), /--active/);
});

test('_applyRueckblickZeitraum / openRueckblickHistory: Hauptbereich zurück auf den Zeitraum', () => {
  const c = ctx({ rbCoverage: COVERAGE, rueckblickHistory: HISTORY, rbMainView: 'verlauf' });
  c.clearBeleg = () => {};
  c._applyRueckblickZeitraum('2024-05');
  assert.equal(c.rbMainView, 'period');
  c.rbMainView = 'verlauf';
  c._rbResults[1] = { zusammenfassung: 'x' };
  c.openRueckblickHistory(HISTORY[0]);
  assert.equal(c.rbMainView, 'period');
});

test('computeVerlaufRows: Filter über Name + Aliase, Stufe nach Anteil am Monat, Zeilendeckel', async () => {
  const { computeVerlaufRows } = await import('../../public/js/book/rueckblick-verlauf.js');
  const verlauf = {
    months: [{ zeitraum: '2024-01', entries: 10 }, { zeitraum: '2024-02', entries: 2 }],
    personen: [
      { name: 'Olivia', aliase: ['Oli'], perMonth: { '2024-01': 5, '2024-02': 1 }, total: 6, months: 2 },
      { name: 'Bernd', aliase: [], perMonth: { '2024-02': 2 }, total: 2, months: 1 },
    ],
  };
  const all = computeVerlaufRows(verlauf, 'personen');
  assert.equal(all.rows.length, 2);
  assert.deepEqual(all.rows[0].cells.map(c => c.n), [5, 1]);
  assert.equal(all.rows[1].cells[0].level, 0, 'keine Nennung → Stufe 0');
  assert.ok(all.rows[1].cells[1].level >= all.rows[0].cells[1].level, 'Bernd: 2 von 2 Einträgen wiegt mehr als 1 von 2');
  assert.deepEqual(computeVerlaufRows(verlauf, 'personen', 'oli').rows.map(r => r.name), ['Olivia'], 'Alias trifft');
  const capped = computeVerlaufRows(verlauf, 'personen', '', 1);
  assert.equal(capped.rows.length, 1);
  assert.equal(capped.more, 1);
  assert.deepEqual(computeVerlaufRows(null, 'personen').rows, []);
});
