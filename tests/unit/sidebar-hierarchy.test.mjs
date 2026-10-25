// Kapitel-Hierarchie in Sidebar und Nachbar-Karten: Kennzahlen am Kapitelkopf
// rechnen am echten Baum-Item ueber den ganzen Unterbaum (nie an der gefilterten
// Kopie der Suche), Labels kommen aus der Kapitel-Label-Map, und der
// Strukturstand zieht den Baum nur bei echter Abweichung nach.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { dispatchEvent() {}, addEventListener() {} };

const { treeEditStatusMethods } = await import('../../public/js/book/tree/edit-status.js');
const { treeStatsMethods, subtreeHitCounts } = await import('../../public/js/book/tree/stats.js');
const { shareChapterOptions, sharePageOptions } = await import('../../public/js/cards/share-target-options.js');
const { PROVIDERS, chapterLabel } = await import('../../public/js/cards/palette-providers.js');
const { kapitelReviewMethods } = await import('../../public/js/book/kapitel-review.js');
const { treeCatchUpMethods } = await import('../../public/js/book/tree/catchup.js');
const { buildKapitelLabels } = await import('../../public/js/chapter-filter.js');

// Teil (1) mit eigenem Abschnitt 10 und Unterkapitel 2 (Abschnitte 20, 21),
// darunter 3 (Abschnitt 30). Kapitel 4 ist leer, Unterkapitel 5 darin auch.
// Zwei gleichnamige Unterkapitel «Einleitung» (2 und 6).
function fixture() {
  const p = (id, chapter_id, name = 'S' + id) => ({ id, chapter_id, name });
  return [
    { type: 'chapter', id: 'solo-1', solo: true, name: 'Vorwort', depth: 1, parent_id: null, pages: [p(1, null, 'Vorwort')] },
    { type: 'chapter', id: 1, name: 'Teil I', depth: 1, parent_id: null, hasChildren: true, pages: [p(10, 1)] },
    { type: 'chapter', id: 2, name: 'Einleitung', depth: 2, parent_id: 1, hasChildren: true, pages: [p(20, 2), p(21, 2)] },
    { type: 'chapter', id: 3, name: 'Tief', depth: 3, parent_id: 2, hasChildren: false, pages: [p(30, 3)] },
    { type: 'chapter', id: 4, name: 'Teil II', depth: 1, parent_id: null, hasChildren: true, pages: [] },
    { type: 'chapter', id: 5, name: 'Leer', depth: 2, parent_id: 4, hasChildren: false, pages: [] },
    { type: 'chapter', id: 7, name: 'Teil III', depth: 1, parent_id: null, hasChildren: true, pages: [] },
    { type: 'chapter', id: 6, name: 'Einleitung', depth: 2, parent_id: 7, hasChildren: false, pages: [p(60, 6)] },
  ];
}

test('chapterEditStatus rechnet am echten Unterbaum, nicht an der Such-Kopie, und bleibt nicht kleben', () => {
  const tree = fixture();
  const editStatus = { 10: { status: 'rohfassung' }, 20: { status: 'final' }, 21: { status: 'final' }, 30: { status: 'redigiert' } };
  const ctx = {
    ...treeEditStatusMethods,
    _treeRev: 1,
    $store: { nav: { tree }, badges: { editStatus, editStatusChain: ['rohfassung', 'ueberarbeitet', 'redigiert', 'final'] } },
  };
  // Such-Kopie von Teil I ohne Treffer-Abschnitte (nur als Vorfahre im Ergebnis).
  const copy = { ...tree[1], pages: [] };
  // Der eigene Abschnitt 10 (rohfassung) fehlt in der Kopie — zaehlt trotzdem.
  assert.equal(ctx.chapterEditStatus(copy)?.status, 'rohfassung');
  assert.equal(ctx.chapterEditStatus(tree[1])?.status, 'rohfassung');
  // Kopie von Unterkapitel 2 mit nur einem Treffer: weiterhin der ganze Unterbaum.
  assert.equal(ctx.chapterEditStatus({ ...tree[2], pages: [tree[2].pages[0]] })?.status, 'redigiert');
  assert.equal(ctx.chapterEditStatus(tree[3])?.status, 'redigiert');
});

test('Kapitel-Tag: ohne Filter der ganze Unterbaum, bei Suche die Treffer im Unterbaum', () => {
  const tree = fixture();
  const ctx = { ...treeStatsMethods, pageSearch: '', _treeIsFiltered() { return !!this.pageSearch; }, filteredTree: [] };
  assert.equal(ctx._chapterPageCount({ ...tree[1], pageTotal: 4 }), 4);
  // Suche: Teil I nur als Vorfahre (leere pages), Treffer in 2 (einer) und 3 (einer).
  const filtered = [
    { ...tree[1], pages: [] },
    { ...tree[2], pages: [tree[2].pages[1]] },
    { ...tree[3], pages: tree[3].pages },
  ];
  ctx.pageSearch = 'x';
  ctx.filteredTree = filtered;
  assert.equal(ctx._chapterPageCount(filtered[0]), 2);
  assert.equal(ctx._chapterPageCount(filtered[1]), 2);
  assert.equal(ctx._chapterPageCount(filtered[2]), 1);
  assert.equal(subtreeHitCounts(filtered), subtreeHitCounts(filtered), 'gecacht auf die Kopie');
});

test('Share-Optionen: Pfad-Labels aus dem flachen Baum, leere Unterbaeume fehlen', () => {
  const tree = fixture();
  const labels = buildKapitelLabels(tree);
  const chapters = shareChapterOptions(tree, labels);
  assert.deepEqual(chapters.map(o => o.value), ['1', '2', '3', '7', '6']);
  assert.equal(chapters.find(o => o.value === '3').label, '— — Tief');
  assert.equal(chapters.find(o => o.value === '6').label, '— Teil III › Einleitung');
  const pages = sharePageOptions(tree);
  assert.equal(pages.find(o => o.value === '1').label, 'Vorwort');
  assert.equal(pages.find(o => o.value === '30').label, 'Teil I › Einleitung › Tief / S30');
});

test('Palette: Kapitel-Label disambiguiert, Abschnittszahl ueber den Unterbaum', () => {
  const tree = fixture();
  tree[1].pageTotal = 4;
  globalThis.Alpine = { store: () => ({ tree, pages: [] }) };
  const root = { _chapterLabelMap: buildKapitelLabels(tree) };
  const provider = PROVIDERS.find(p => p.key === 'chapters');
  const items = provider.search(root, 'einl', (k, p) => `${k}:${p?.n}`);
  assert.deepEqual(items.map(i => i.label).sort(), ['Teil I › Einleitung', 'Teil III › Einleitung']);
  const teil = provider.search(root, 'teil i', (k, p) => `${k}:${p?.n}`).find(i => i.key === 'chapter:1');
  assert.match(teil.sub, /:4$/);
  assert.equal(chapterLabel(root, 6), 'Teil III › Einleitung');
  assert.equal(chapterLabel(root, null), '');
});

test('Kapitelbewertung verlangt Text im Unterbaum und merkt hasChildren-Aenderungen', () => {
  const tree = fixture().filter(i => i.id === 4 || i.id === 5);
  const pages = [];
  const ctx = { ...kapitelReviewMethods, tokEsts: {}, _treeRev: 1, _chapterReviewEligibleMemo: null,
    $store: { nav: { tree, pages } } };
  assert.equal(ctx._bookQualifiesForChapterReview(), false, 'nur leere Kapitel');
  const page = { id: 50, chapter_id: 5, name: 'x' };
  tree[1].pages = [page];
  ctx._treeRev = 2;
  assert.equal(ctx._bookQualifiesForChapterReview(), true, 'Umfang unbekannt zaehlt als Text');
  ctx.tokEsts = { 50: { chars: 0, words: 0, tok: 0 } };
  assert.equal(ctx._bookQualifiesForChapterReview(), false, 'leerer Abschnitt zaehlt nicht');
});

test('Strukturstand: Nachzug nur bei Abweichung, je Stand hoechstens einmal', () => {
  const ctx = { ...treeCatchUpMethods, _treeStructureAt: 'A', _structureCatchUpFor: null, _structureOwnWrite: false,
    $store: { nav: { selectedBookId: '3' } } };
  assert.equal(ctx._structureDrifted(undefined), false, 'Server ohne Feld');
  assert.equal(ctx._structureDrifted('A'), false);
  assert.equal(ctx._structureDrifted('B'), true);
  assert.equal(ctx._structureDrifted('B'), false, 'keine Schleife');
  ctx._noteStructureVersion('B');
  assert.equal(ctx._treeStructureAt, 'B');
  ctx._onStructureWritten({ bookId: 9 });
  assert.equal(ctx._structureOwnWrite, false, 'fremdes Buch');
  ctx._onStructureWritten({ bookId: 3 });
  assert.equal(ctx._structureOwnWrite, true);
  ctx._treeStructureAt = undefined;
  assert.equal(ctx._structureDrifted('C'), false, 'unbekannter Baum-Stand vergleicht nicht');
});
