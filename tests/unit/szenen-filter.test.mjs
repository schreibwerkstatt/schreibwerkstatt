// Unit-Tests für die reinen Ableitungen der Szenen-Karte
// (public/js/book/szenen-stats.js): Filter, Buchreihenfolge, Verteilungen,
// Filter-Optionen, Kapitel-Labels.
//
// Kapitel/Seiten laufen über ihre ID: gleichnamige Kapitel sind zwei Kapitel.
// Stale-Szenen („nicht mehr im Text") zählen in keiner Verteilung.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  applySzenenFilters, sortSzenen, szenenGridRows, szenenNachKapitel, szenenNachSeite,
  szenenNachFigur, szenenWertungCounts, szenenKapitelOptionen, szenenSeitenOptionen,
  buildKapitelLabels, wertungOf,
} = await import('../../public/js/book/szenen-stats.js');

// Buchreihenfolge: Kapitel 10 vor 20 vor 30, Seiten nach ID-Rang.
const CH_ORDER = new Map([[10, 0], [20, 1], [30, 2]]);
const PG_ORDER = new Map([[100, 0], [101, 1], [200, 2], [300, 3]]);
const ORDER = {
  chapterIdx: (s) => CH_ORDER.get(s.chapter_id) ?? 9999,
  pageIdx: (s) => PG_ORDER.get(s.page_id) ?? 9999,
};
const LABEL = (id, name) => name;

const BOOK = [
  { id: 1, chapter_id: 10, kapitel: 'Kapitel 1', page_id: 101, seite: 'B', titel: 'Zebra',     wertung: 'stark',  kommentar: 'Trägt das Tempo.', fig_ids: [7], ort_ids: [] },
  { id: 2, chapter_id: 10, kapitel: 'Kapitel 1', page_id: 101, seite: 'B', titel: 'Ankunft',   wertung: 'mittel', kommentar: 'Dialog zu lang.',  fig_ids: [7], ort_ids: [] },
  { id: 3, chapter_id: 20, kapitel: 'Kapitel 1', page_id: 200, seite: 'C', titel: 'Heimkehr',  wertung: 'schwach', kommentar: '',               fig_ids: [8], ort_ids: ['L1'] },
  { id: 4, chapter_id: 10, kapitel: 'Kapitel 1', page_id: 100, seite: 'A', titel: 'Traum',     wertung: null,     kommentar: 'Ohne Konflikt.',   fig_ids: [],  ort_ids: [] },
  { id: 5, chapter_id: 30, kapitel: 'Kapitel 3', page_id: 300, seite: 'D', titel: 'Alt',       wertung: 'stark',  kommentar: '',                 fig_ids: [7], ort_ids: [], stale: true },
];

// ── applySzenenFilters ─────────────────────────────────────────────────────

test('applySzenenFilters: kein Filter → alle Szenen', () => {
  assert.equal(applySzenenFilters(BOOK, {}).length, 5);
});

test('applySzenenFilters: Kapitel-Filter über die ID trennt gleichnamige Kapitel', () => {
  const out = applySzenenFilters(BOOK, { kapitelId: 20 });
  assert.deepEqual(out.map(s => s.id), [3]);
});

test('applySzenenFilters: Seite nur unter Kapitelfilter wirksam', () => {
  assert.deepEqual(applySzenenFilters(BOOK, { kapitelId: 10, seiteId: 101 }).map(s => s.id), [1, 2]);
  assert.equal(applySzenenFilters(BOOK, { seiteId: 101 }).length, 5);
});

test('applySzenenFilters: Wertung ohne Wert zählt als «mittel» (wie die Tab-Zähler)', () => {
  assert.deepEqual(applySzenenFilters(BOOK, { wertung: 'mittel' }).map(s => s.id), [2, 4]);
});

test('applySzenenFilters: Suche matcht Titel und Kommentar, case-insensitive', () => {
  assert.deepEqual(applySzenenFilters(BOOK, { suche: 'TRAUM' }).map(s => s.id), [4]);
  assert.deepEqual(applySzenenFilters(BOOK, { suche: 'dialog' }).map(s => s.id), [2]);
});

test('applySzenenFilters: Figur- und Ort-Filter', () => {
  assert.deepEqual(applySzenenFilters(BOOK, { figurId: 8 }).map(s => s.id), [3]);
  assert.deepEqual(applySzenenFilters(BOOK, { ortId: 'L1' }).map(s => s.id), [3]);
});

// ── Reihenfolge ────────────────────────────────────────────────────────────

test('sortSzenen: Kapitel → Seite → Textreihenfolge (nicht Titel)', () => {
  const out = sortSzenen(BOOK, ORDER);
  // Seite A (4) vor Seite B; auf Seite B «Zebra» (1) vor «Ankunft» (2), weil
  // es im Text zuerst kommt.
  assert.deepEqual(out.map(s => s.id), [4, 1, 2, 3, 5]);
});

test('szenenGridRows: Kapitel/Seite als Buchposition, Wertung als Rang', () => {
  const rows = szenenGridRows(BOOK, ORDER);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.ok(byId[1].kapitel < byId[3].kapitel);
  assert.ok(byId[4].seite < byId[1].seite);
  assert.ok(byId[1].wertung < byId[2].wertung && byId[2].wertung < byId[3].wertung);
  assert.equal(byId[4].wertung, byId[2].wertung, 'fehlende Wertung = mittel');
  assert.equal(byId[1].s, BOOK[0]);
});

// ── Verteilungen (ohne stale) ──────────────────────────────────────────────

test('szenenNachKapitel: pro Kapitel-ID, Buchreihenfolge, ohne stale, mit Anteil', () => {
  const rows = szenenNachKapitel(BOOK, ORDER, LABEL);
  assert.deepEqual(rows.map(r => [r.chapterId, r.total, r.stark, r.mittel, r.schwach]),
    [[10, 3, 1, 2, 0], [20, 1, 0, 0, 1]]);
  assert.deepEqual(rows.map(r => r.share), [100, 33]);
});

test('szenenNachSeite: pro Seiten-ID, ohne stale', () => {
  const rows = szenenNachSeite(BOOK, ORDER, LABEL);
  assert.deepEqual(rows.map(r => [r.pageId, r.total]), [[100, 1], [101, 2], [200, 1]]);
});

test('szenenNachFigur: stale-Szenen zählen nicht', () => {
  const rows = szenenNachFigur(BOOK, [{ id: 7, name: 'Anna' }, { id: 8, name: 'Ben' }, { id: 9, name: 'Cleo' }]);
  assert.deepEqual(rows.map(r => [r.id, r.total, r.wenig]), [[7, 2, true], [8, 1, true]]);
});

test('szenenWertungCounts: ohne stale, fehlende Wertung = mittel', () => {
  assert.deepEqual(szenenWertungCounts(BOOK), { stark: 1, mittel: 2, schwach: 1 });
  assert.equal(wertungOf({ wertung: 'quatsch' }), 'mittel');
});

// ── Filter-Optionen + Labels ───────────────────────────────────────────────

test('szenenKapitelOptionen: je Kapitel-ID eine Option, Buchreihenfolge', () => {
  const opts = szenenKapitelOptionen(BOOK, ORDER, (id, n) => `${n}#${id}`);
  assert.deepEqual(opts, [
    { value: 10, label: 'Kapitel 1#10' },
    { value: 20, label: 'Kapitel 1#20' },
    { value: 30, label: 'Kapitel 3#30' },
  ]);
});

test('szenenSeitenOptionen: nur Seiten des gewählten Kapitels, leer ohne Kapitel', () => {
  assert.deepEqual(szenenSeitenOptionen(BOOK, 10, ORDER), [
    { value: 100, label: 'A' }, { value: 101, label: 'B' },
  ]);
  assert.deepEqual(szenenSeitenOptionen(BOOK, '', ORDER), []);
});

test('buildKapitelLabels: gleichnamige Kapitel bekommen das Elternkapitel davor', () => {
  const tree = [
    { type: 'chapter', id: 1, name: 'Teil I' },
    { type: 'chapter', id: 10, name: 'Kapitel 1', parent_id: 1 },
    { type: 'chapter', id: 2, name: 'Teil II' },
    { type: 'chapter', id: 20, name: 'Kapitel 1', parent_id: 2 },
    { type: 'chapter', id: 30, name: 'Kapitel 3', parent_id: 2 },
    { type: 'chapter', id: 99, name: 'Solo', solo: true },
  ];
  const labels = buildKapitelLabels(tree);
  assert.equal(labels.get(10), 'Teil I › Kapitel 1');
  assert.equal(labels.get(20), 'Teil II › Kapitel 1');
  assert.equal(labels.get(30), 'Kapitel 3');
  assert.equal(labels.has(99), false);
});
