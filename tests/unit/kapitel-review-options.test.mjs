// kapitelReviewChapterOptions: Parent-Kapitel ohne direkte Pages, aber mit
// Sub-Kapiteln, MÜSSEN in der Eligibility-Liste auftauchen. Der Job lädt bei
// include_subchapters=true alle Descendant-Pages, also ist das Kapitel
// klickbar — sonst wäre es im Tree stumm.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { kapitelReviewMethods } = await import('../../public/js/book/kapitel-review.js');

function ctx(tree) {
  // Nav-Tree lebt in Alpine.store('nav') (kein Root-Proxy mehr) — Methode liest
  // this.$store.nav.tree; Alias haelt den bestehenden tree-Zugriff am Leben.
  const nav = { selectedBookId: 1, books: [], pages: [], tree };
  return {
    get tree() { return nav.tree; },
    set tree(v) { nav.tree = v; },
    $store: { nav },
    _bookQualifiesForChapterReview: kapitelReviewMethods._bookQualifiesForChapterReview,
    kapitelReviewChapterOptions: kapitelReviewMethods.kapitelReviewChapterOptions,
  };
}

test('Parent-only Kapitel (keine direkten Pages, hat Sub-Kapitel mit Pages) ist eligible', () => {
  const tree = [
    { id: 'parent', type: 'chapter', solo: false, parent_id: null, pages: [] },
    { id: 'sub1',   type: 'chapter', solo: false, parent_id: 'parent', pages: [{ id: 'p1' }, { id: 'p2' }] },
    { id: 'sub2',   type: 'chapter', solo: false, parent_id: 'parent', pages: [{ id: 'p3' }] },
  ];
  const c = ctx(tree);
  const opts = c.kapitelReviewChapterOptions();
  assert.ok(opts.some(o => String(o.id) === 'parent'), 'parent in options');
  assert.ok(opts.some(o => String(o.id) === 'sub1'));
});

test('Parent ohne Pages und ohne Subs bleibt aussen vor', () => {
  const tree = [
    { id: 'a',  type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p1' }, { id: 'p2' }] },
    { id: 'b',  type: 'chapter', solo: false, parent_id: null, pages: [] },
    { id: 'c',  type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p3' }, { id: 'p4' }] },
  ];
  const c = ctx(tree);
  const opts = c.kapitelReviewChapterOptions();
  assert.equal(opts.length, 2);
  assert.ok(!opts.some(o => String(o.id) === 'b'));
});

test('Einzelnes Kapitel mit mehreren Seiten qualifiziert (Kapiteleinheit bewertbar)', () => {
  const tree = [
    { id: 'a', type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p1' }, { id: 'p2' }] },
  ];
  const c = ctx(tree);
  const opts = c.kapitelReviewChapterOptions();
  assert.equal(opts.length, 1);
  assert.ok(opts.some(o => String(o.id) === 'a'));
});

test('Buch aus lauter Ein-Abschnitt-Kapiteln qualifiziert — jedes Kapitel ist bewertbar', () => {
  const tree = [
    { id: 'a', type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p1' }] },
    { id: 'b', type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p2' }] },
  ];
  const c = ctx(tree);
  assert.deepEqual(c.kapitelReviewChapterOptions().map(o => o.id), ['a', 'b']);
});

test('Buch aus reinen Solo-Abschnitten bzw. leeren Kapiteln qualifiziert nicht → leer', () => {
  const tree = [
    { id: 'solo-1', type: 'chapter', solo: true, parent_id: null, pages: [{ id: 'sp' }] },
    { id: 'b', type: 'chapter', solo: false, parent_id: null, pages: [] },
  ];
  const c = ctx(tree);
  assert.deepEqual(c.kapitelReviewChapterOptions(), []);
});

test('Solo-Items werden ignoriert', () => {
  const tree = [
    { id: 'solo-1', type: 'chapter', solo: true, parent_id: null, pages: [{ id: 'sp' }] },
    { id: 'a', type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p1' }, { id: 'p2' }] },
    { id: 'b', type: 'chapter', solo: false, parent_id: null, pages: [{ id: 'p3' }] },
  ];
  const c = ctx(tree);
  const opts = c.kapitelReviewChapterOptions();
  assert.ok(!opts.some(o => String(o.id).startsWith('solo')));
});
