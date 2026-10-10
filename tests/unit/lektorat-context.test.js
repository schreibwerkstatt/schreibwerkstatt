'use strict';
// Tests fuer den Nachbarseiten-Kontext des Lektorats (routes/jobs/lektorat-context.js):
// Absatz-Auszuege, Nachbar-Suche und der Backstop, der Findings aus den
// Kontext-Auszuegen verwirft.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lastParagraph, firstParagraph, findPreviousPage, findNextPage, neighbourPages, isChapterChange, dropNeighbourFindings,
} = require('../../routes/jobs/lektorat-context');

test('firstParagraph liefert den ersten Absatz', () => {
  assert.equal(firstParagraph('Erster Absatz.\n\nZweiter Absatz.'), 'Erster Absatz.');
  assert.equal(firstParagraph('   '), null);
});

test('firstParagraph schneidet ueberlange Absaetze am letzten Satzende', () => {
  const para = 'Ein Satz hier. '.repeat(60).trim();
  const out = firstParagraph(para, 100);
  assert.ok(out.length <= 100);
  assert.ok(out.endsWith('.'), out);
});

test('lastParagraph liefert den letzten Absatz', () => {
  assert.equal(lastParagraph('Erster Absatz.\n\nZweiter Absatz.'), 'Zweiter Absatz.');
});

test('Nachbarn folgen der Buchreihenfolge und überschreiten Kapitelgrenzen', () => {
  // Ein Abschnitt pro Kapitel: ohne Grenzübertritt gäbe es nie einen Nachbarn.
  const pages = [
    { id: 1, chapter_id: 10 },
    { id: 2, chapter_id: 20 },
    { id: 3, chapter_id: 30 },
  ];
  assert.equal(findPreviousPage(pages, 2).id, 1);
  assert.equal(findNextPage(pages, 2).id, 3);
  assert.equal(findPreviousPage(pages, 1), null);
  assert.equal(findNextPage(pages, 3), null);
  assert.equal(isChapterChange({ chapter_id: 20 }, pages[0]), true);
  assert.equal(isChapterChange({ chapter_id: 10 }, { chapter_id: 10 }), false);
  assert.equal(isChapterChange({ chapter_id: 10 }, null), false);
});

test('neighbourPages liefert die nächsten Kandidaten zuerst (leere werden übersprungen)', () => {
  const pages = [1, 2, 3, 4, 5].map(id => ({ id, chapter_id: id }));
  assert.deepEqual(neighbourPages(pages, 2, +1, 2).map(p => p.id), [3, 4]);
  assert.deepEqual(neighbourPages(pages, 4, -1, 5).map(p => p.id), [3, 2, 1]);
  assert.deepEqual(neighbourPages(pages, 99, +1, 2), []);
});

test('dropNeighbourFindings verwirft Findings, die nur im Auszug stehen', () => {
  const page = 'Sie ging zum Fluss.\n\nDas Wasser war kalt.';
  const fehler = [
    { typ: 'stil', original: 'Das Wasser  war kalt.', korrektur: 'Das Wasser biss.' },
    { typ: 'stil', original: 'Er ging hinaus', korrektur: 'Er trat hinaus' },
    { typ: 'grammatik', original: 'gar nirgends', korrektur: 'nirgends' },
  ];
  const out = dropNeighbourFindings(fehler, page, ['Dann ging Er ging hinaus.', null]);
  assert.deepEqual(out.map(f => f.original), ['Das Wasser  war kalt.', 'gar nirgends'],
    'Seiten-Finding (whitespace-tolerant) und unauffindbares bleiben, Auszug-Finding faellt');
});

test('dropNeighbourFindings behaelt Findings, die auch auf der Seite stehen', () => {
  const out = dropNeighbourFindings([{ original: 'Sie ging' }], 'Sie ging los.', ['Sie ging heim.']);
  assert.equal(out.length, 1);
});

test('dropNeighbourFindings ohne Auszuege ist ein No-op', () => {
  const fehler = [{ original: 'x' }];
  assert.equal(dropNeighbourFindings(fehler, 'y', [null, null]), fehler);
});
