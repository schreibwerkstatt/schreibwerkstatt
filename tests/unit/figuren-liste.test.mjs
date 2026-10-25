// Filter + Sortierung der Figurenliste (public/js/cards/figuren-card.js).
//
// Die beiden Funktionen sind ausdruecklich aus dem memoisierten Wrapper
// extrahiert, „damit sie ohne Alpine-Root testbar bleiben" — hatten aber keinen
// Test. Genau ihre Sortierung teilen sie sich seit figur-typen.js mit der
// Alterstabelle, der Praesenz-Heatmap und den Lebenslauf-Spalten; ohne
// Absicherung ist jede Aenderung an der Taxonomie ein Blindflug.
//
// KERNBEHAUPTUNG: die Liste folgt dem BUCH, nicht dem Alphabet — erste Achse ist
// das frueheste Kapitel, in dem die Figur auftritt. Erst danach zaehlt das
// Typ-Tier, erst zuletzt der Name.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeFilteredFiguren, computeFigurenSeiten } =
  await import('../../public/js/cards/figuren-card.js');

// Kapitel-ID → Lese-Reihenfolge (root._chapterIdOrderMap); Filter und Sortierung
// arbeiten auf der ID (chapter-filter.js), der Name ist nur Label.
const CID = { 'Erstes Kapitel': 1, 'Zweites Kapitel': 2, 'Drittes Kapitel': 3 };
const ORDER = new Map([[1, 0], [2, 1], [3, 2]]);
const KAPITEL = (id) => ORDER.get(id);

const fig = (id, name, typ, kapitel = [], seiten = []) => ({
  id, name, typ,
  kapitel: kapitel.map(k => (typeof k === 'string' ? { chapter_id: CID[k], name: k, haeufigkeit: 1 } : k)),
  seiten,
});

const BESETZUNG = [
  fig('f1', 'Zora',   'nebenfigur', ['Erstes Kapitel']),
  fig('f2', 'Anna',   'hauptfigur', ['Zweites Kapitel']),
  fig('f3', 'Bruno',  'hauptfigur', ['Erstes Kapitel', 'Drittes Kapitel']),
  fig('f4', 'Achill', 'hauptfigur', ['Erstes Kapitel']),
  fig('f5', 'Namenlos', 'randfigur', []),   // ohne Kapitelauftritt
];

test('sortiert nach fruehestem Kapitel, dann Typ-Tier, dann Name', () => {
  const out = computeFilteredFiguren(BESETZUNG, KAPITEL).map(f => f.name);
  assert.deepEqual(out, ['Achill', 'Bruno', 'Zora', 'Anna', 'Namenlos']);
});

test('eine Figur ohne Kapitelauftritt faellt ans Ende, nicht aus der Liste', () => {
  const out = computeFilteredFiguren(BESETZUNG, KAPITEL);
  assert.equal(out.length, BESETZUNG.length);
  assert.equal(out.at(-1).name, 'Namenlos');
});

test('mehrere Kapitel: das fruehste zaehlt, nicht das erste im Array', () => {
  const spaetZuerst = [
    fig('a', 'Spaet', 'hauptfigur', ['Drittes Kapitel']),
    fig('b', 'Frueh', 'hauptfigur', ['Drittes Kapitel', 'Erstes Kapitel']),
  ];
  assert.deepEqual(computeFilteredFiguren(spaetZuerst, KAPITEL).map(f => f.name),
    ['Frueh', 'Spaet']);
});

test('Suche trifft den Namen ohne Ruecksicht auf Gross-/Kleinschreibung', () => {
  const out = computeFilteredFiguren(BESETZUNG, KAPITEL, { suche: 'ANN' });
  assert.deepEqual(out.map(f => f.name), ['Anna']);
});

test('Kapitelfilter behaelt nur Figuren mit Auftritt in diesem Kapitel', () => {
  const out = computeFilteredFiguren(BESETZUNG, KAPITEL, { kapitelId: 3 });
  assert.deepEqual(out.map(f => f.name), ['Bruno']);
});

test('Seitenfilter greift nur innerhalb des gewaehlten Kapitels', () => {
  const mitSeiten = [
    fig('a', 'Aaron', 'hauptfigur', ['Erstes Kapitel'],
      [{ kapitel: 'Erstes Kapitel', seite: 'Szene 1', chapter_id: 1, page_id: 11 }]),
    // gleicher Seitenname, aber anderes Kapitel → darf nicht durchrutschen
    fig('b', 'Berta', 'hauptfigur', ['Zweites Kapitel'],
      [{ kapitel: 'Zweites Kapitel', seite: 'Szene 1', chapter_id: 2, page_id: 21 }]),
  ];
  const out = computeFilteredFiguren(mitSeiten, KAPITEL,
    { kapitelId: 1, seiteId: 11 });
  assert.deepEqual(out.map(f => f.name), ['Aaron']);
});

test('gibt eine Kopie zurueck, sortiert die Quelle nicht um', () => {
  const quelle = [...BESETZUNG];
  const out = computeFilteredFiguren(quelle, KAPITEL);
  assert.notEqual(out, quelle);
  assert.deepEqual(quelle.map(f => f.id), BESETZUNG.map(f => f.id));
});

test('vertraegt leere und fehlende Eingaben', () => {
  assert.deepEqual(computeFilteredFiguren(null, null), []);
  assert.deepEqual(computeFilteredFiguren([], KAPITEL), []);
  // Ohne Kapitel-Map bleiben alle gleichrangig → Typ und Name entscheiden.
  assert.deepEqual(computeFilteredFiguren(BESETZUNG, null).map(f => f.name),
    ['Achill', 'Anna', 'Bruno', 'Zora', 'Namenlos']);
});

test('computeFigurenSeiten sammelt die Abschnitts-IDs EINES Kapitels, dedupliziert', () => {
  const figuren = [
    fig('a', 'A', 'hauptfigur', [], [
      { chapter_id: 1, page_id: 11 }, { chapter_id: 2, page_id: 29 }]),
    fig('b', 'B', 'hauptfigur', [], [
      { chapter_id: 1, page_id: 11 }, { chapter_id: 1, page_id: 12 },
      { chapter_id: 1, page_id: null }]),   // Szene ohne Abschnitt zaehlt nicht
  ];
  const out = computeFigurenSeiten(figuren, 1);
  assert.ok(out instanceof Set);
  assert.deepEqual([...out].sort(), [11, 12]);
  assert.deepEqual([...computeFigurenSeiten(figuren, 3)], []);
  assert.deepEqual([...computeFigurenSeiten(null, 1)], []);
});

test('Kapitelfilter trennt gleichnamige Kapitel', () => {
  const dup = [
    fig('a', 'A', 'hauptfigur', [{ chapter_id: 7, name: 'Einleitung' }]),
    fig('b', 'B', 'hauptfigur', [{ chapter_id: 8, name: 'Einleitung' }]),
  ];
  assert.deepEqual(computeFilteredFiguren(dup, null, { kapitelId: 8 }).map(f => f.id), ['b']);
});
