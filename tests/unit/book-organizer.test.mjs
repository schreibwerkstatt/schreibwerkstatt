// Buchorganizer: Snapshot-Rebuild, Mirror-Ordnung, Struktur-Helper, Length-Dist.
//
// Der Fokus liegt auf der Ordnungs-Invariante von nav.tree: flach, aber
// DEPTH-FIRST (Solo-Seiten zuerst, Sub-Kapitel direkt hinter ihrem Parent).
// Die Sidebar rendert in Array-Reihenfolge (app.js#filteredTree filtert nur) —
// ein globaler Sort nach `priority` (Position INNERHALB des Parents) reisst
// Sub-Kapitel aus ihrem Parent und war die Ursache scrambelnder Sidebars.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Alpine/window-Stubs vor dem Import der Slices — die Module lesen beides erst
// zur Aufrufzeit, ein globaler Stub genuegt.
const navStore = { tree: [], pages: [], books: [], selectedBookId: 7 };
const rootStub = {
  tokEsts: {},
  _chapterOrderMap: null,
  _pageOrderMap: null,
  _pageIdOrderMap: null,
  t: (k) => k,
  setStatus() {},
  _refreshChapterStats() {},
};
globalThis.Alpine = { store: (n) => (n === 'nav' ? navStore : { uiLocale: 'de' }) };
globalThis.window = { __app: rootStub, dispatchEvent() {} };

const { persistMethods } = await import('../../public/js/book-organizer/persist.js');
const { mirrorMethods } = await import('../../public/js/book-organizer/mirror.js');
const { dndMethods } = await import('../../public/js/book-organizer/dnd.js');
const { historyMethods } = await import('../../public/js/book-organizer/history.js');
const { crudMethods } = await import('../../public/js/book-organizer/crud.js');
const { contentRepo } = await import('../../public/js/repo/content.js');
const { treeBuildMethods } = await import('../../public/js/book/tree/build.js');
const { viewMethods, _computeChapterLengthDist } = await import('../../public/js/book-organizer/view.js');
const { MAX_CHAPTER_DEPTH } = await import('../../public/js/book-organizer/constants.js');
const { insertChapterItem } = await import('../../public/js/book/tree/load.js');

// Minimale Card-Instanz: die Slice-Methoden brauchen nur `this` + $nextTick.
function makeCard() {
  return Object.assign({
    workTree: [],
    soloPages: [],
    chapterOpen: {},
    organizerSearch: '',
    organizerSaving: false,
    _sortables: [],
    _memos: {},
    _undoStack: [],
    _redoStack: [],
    _inHistoryFlight: false,
    async $nextTick() {},
  }, persistMethods, mirrorMethods, dndMethods, viewMethods, historyMethods, crudMethods);
}

// nav.tree-Fixture: Kapitel 1 „Eins" mit Sub 11 „Eins.A", Kapitel 2 „Zwei".
// Plus eine kapitellose Seite. Reihenfolge = depth-first, wie tree/load.js baut.
function seedNav() {
  const pages = [
    { id: 900, name: 'Solo', chapter_id: 0, priority: 1, chapterName: null },
    { id: 901, name: 'S1', chapter_id: 1, priority: 1, chapterName: 'Eins' },
    { id: 902, name: 'S2', chapter_id: 1, priority: 2, chapterName: 'Eins' },
    { id: 911, name: 'Sub1', chapter_id: 11, priority: 1, chapterName: 'Eins.A' },
    { id: 920, name: 'Z1', chapter_id: 2, priority: 1, chapterName: 'Zwei' },
  ];
  const byChapter = (id) => pages.filter(p => p.chapter_id === id);
  navStore.pages = pages;
  navStore.tree = [
    { type: 'chapter', id: 'solo-900', name: 'Solo', priority: 1, depth: 1, parent_id: null, solo: true, pages: [pages[0]] },
    { type: 'chapter', id: 1, name: 'Eins', priority: 1, depth: 1, parent_id: null, solo: false, hasChildren: true, pages: byChapter(1) },
    { type: 'chapter', id: 11, name: 'Eins.A', priority: 1, depth: 2, parent_id: 1, solo: false, hasChildren: false, pages: byChapter(11) },
    { type: 'chapter', id: 2, name: 'Zwei', priority: 2, depth: 1, parent_id: null, solo: false, hasChildren: false, pages: byChapter(2) },
  ];
}

const treeIds = () => navStore.tree.map(it => it.id);

test('_snapshotFromNav rekonstruiert das Nesting aus dem flachen Store', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();

  assert.deepEqual(card.workTree.map(c => c.id), [1, 2]);
  assert.deepEqual(card.workTree[0].subchapters.map(c => c.id), [11]);
  assert.equal(card.workTree[0].depth, 1);
  assert.equal(card.workTree[0].subchapters[0].depth, 2);
  assert.equal(card.workTree[0].subchapters[0].parent_id, 1);
  assert.deepEqual(card.workTree[0].pages.map(p => p.id), [901, 902]);
  assert.deepEqual(card.workTree[0].subchapters[0].pages.map(p => p.id), [911]);
  assert.deepEqual(card.soloPages.map(p => p.id), [900]);
});

test('_snapshotFromNav ist unabhaengig von der Store-Reihenfolge des Parents', () => {
  seedNav();
  // Sub-Kapitel vor seinem Parent — darf trotzdem korrekt einhaengen.
  navStore.tree = [navStore.tree[0], navStore.tree[2], navStore.tree[1], navStore.tree[3]];
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card.workTree.map(c => c.id), [1, 2]);
  assert.deepEqual(card.workTree[0].subchapters.map(c => c.id), [11]);
});

test('_mirrorChapterOrderInRoot haelt nav.tree depth-first (Sub bleibt beim Parent)', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Top-Level-Reorder: „Zwei" vor „Eins" (wie ein DnD-Drop im Organizer).
  card.workTree.reverse();
  card._mirrorChapterOrderInRoot();

  // Solo zuerst, dann Zwei, dann Eins mit seinem Sub direkt dahinter.
  assert.deepEqual(treeIds(), ['solo-900', 2, 1, 11]);
  // priority ist die Position INNERHALB des Parents.
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.equal(byId.get(2).priority, 1);
  assert.equal(byId.get(1).priority, 2);
  assert.equal(byId.get(11).priority, 1);
});

test('_mirrorChapterOrderInRoot spiegelt Tiefe/Parent/hasChildren nach promote', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Sub-Kapitel 11 aus „Eins" herausziehen (promote).
  const sub = card.workTree[0].subchapters.pop();
  card._setSubtreeDepth(sub, 1, null);
  card.workTree.splice(1, 0, sub);
  card._mirrorChapterOrderInRoot();

  assert.deepEqual(treeIds(), ['solo-900', 1, 11, 2]);
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.equal(byId.get(11).depth, 1);
  assert.equal(byId.get(11).parent_id, null);
  assert.equal(byId.get(1).hasChildren, false, 'Parent hat sein letztes Kind verloren');
});

test('_mirrorPageMembershipInRoot spiegelt auch Seiten in Sub-Kapiteln', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Seite aus dem Sub-Kapitel nach vorn in Kapitel 1 ziehen.
  const moved = card.workTree[0].subchapters[0].pages.pop();
  moved.chapter_id = 1;
  card.workTree[0].pages.unshift(moved);
  card._mirrorPageMembershipInRoot([1, 11]);

  const p911 = navStore.pages.find(p => p.id === 911);
  assert.equal(p911.chapter_id, 1);
  assert.equal(p911.priority, 1);
  assert.equal(p911.chapterName, 'Eins');
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.deepEqual(byId.get(1).pages.map(p => p.id), [911, 901, 902]);
  assert.deepEqual(byId.get(11).pages.map(p => p.id), []);
});

test('_mirrorPageMembershipInRoot(null) deckt alle Kapitel ab (History-Replay)', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Reihenfolge innerhalb des Sub-Kapitels und in Kapitel 2 aendern.
  card.workTree[0].pages.reverse();
  card._mirrorPageMembershipInRoot(null);
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.deepEqual(byId.get(1).pages.map(p => p.id), [902, 901]);
  assert.equal(navStore.pages.find(p => p.id === 902).priority, 1);
});

test('_resortRootPages ordnet nav.pages nach Kapitel-Depth-First, Solo zuerst', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  card.workTree.reverse(); // Zwei vor Eins
  card._resortRootPages();
  assert.deepEqual(navStore.pages.map(p => p.id), [900, 920, 901, 902, 911]);
});

test('_rebuildSoloEntries + _reorderNavTree halten Solo-Items vor den Kapiteln', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Zweite Solo-Seite hinzufuegen (wie ein Move aus einem Kapitel heraus).
  const p = navStore.pages.find(x => x.id === 920);
  p.chapter_id = 0;
  card.soloPages.push({ id: 920, name: 'Z1', chapter_id: 0 });
  card.workTree[1].pages = [];
  card._rebuildSoloEntries();
  card._reorderNavTree();
  assert.deepEqual(treeIds(), ['solo-900', 'solo-920', 1, 11, 2]);
});

test('_buildTreeFromWorkstate serialisiert Solo-Seiten zuerst, dann nested', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card._buildTreeFromWorkstate(), [
    { type: 'page', id: 900 },
    { type: 'chapter', id: 1, children: [
      { type: 'chapter', id: 11, children: [{ type: 'page', id: 911 }] },
      { type: 'page', id: 901 },
      { type: 'page', id: 902 },
    ] },
    { type: 'chapter', id: 2, children: [{ type: 'page', id: 920 }] },
  ]);
});

test('_findChapter liefert Geschwister-Liste + Index auf jeder Tiefe', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  const top = card._findChapter(2);
  assert.equal(top.index, 1);
  assert.equal(top.parent, null);
  assert.equal(top.parentList, card.workTree);
  const sub = card._findChapter(11);
  assert.equal(sub.parent.id, 1);
  assert.equal(sub.parentList, card.workTree[0].subchapters);
  assert.equal(card._findChapter(4711), null);
});

test('promote/demote-Validierung respektiert MAX_CHAPTER_DEPTH', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.equal(card.canPromoteChapter(1), false, 'Top-Level hat keinen Parent');
  assert.equal(card.canPromoteChapter(11), true);
  assert.equal(card.canDemoteChapter(1), false, 'kein Vor-Geschwister');
  assert.equal(card.canDemoteChapter(2), true);

  // Kapitel 2 mit zwei Ebenen Subtree → demote wuerde Tiefe 4 erzeugen.
  card.workTree[1].subchapters = [
    { id: 21, name: 'a', depth: 2, parent_id: 2, pages: [], subchapters: [
      { id: 211, name: 'b', depth: 3, parent_id: 21, pages: [], subchapters: [] },
    ] },
  ];
  assert.equal(card._subtreeDepth(card.workTree[1]), MAX_CHAPTER_DEPTH);
  assert.equal(card.canDemoteChapter(2), false);
});

test('_setSubtreeDepth zieht Tiefe rekursiv nach, parent_id nur wenn angegeben', () => {
  const card = makeCard();
  const node = { id: 1, depth: 1, parent_id: null, subchapters: [
    { id: 2, depth: 2, parent_id: 1, subchapters: [{ id: 3, depth: 3, parent_id: 2, subchapters: [] }] },
  ] };
  card._setSubtreeDepth(node, 2, 9);
  assert.equal(node.depth, 2);
  assert.equal(node.parent_id, 9);
  assert.equal(node.subchapters[0].depth, 3);
  assert.equal(node.subchapters[0].parent_id, 1);
  assert.equal(node.subchapters[0].subchapters[0].depth, 4);

  const keep = { id: 1, depth: 5, parent_id: 42, subchapters: [] };
  card._setSubtreeDepth(keep, 1);
  assert.equal(keep.parent_id, 42, 'ohne parentId-Argument unberuehrt');
});

test('Suchfilter zeigt Kapitel bei Treffer in der Tiefe', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  card.organizerSearch = 'Sub1';
  const res = card.filteredWorkTree();
  assert.deepEqual(res.map(c => c.id), [1]);
  assert.deepEqual(res[0].pages, [], 'Parent-Seiten ohne Treffer ausgefiltert');
  assert.deepEqual(res[0].subchapters[0].pages.map(p => p.id), [911]);
  assert.deepEqual(card.filteredSoloPages(), []);

  card.organizerSearch = 'Eins';
  const byName = card.filteredWorkTree();
  assert.deepEqual(byName.map(c => c.id), [1]);
  assert.equal(byName[0].pages.length, 2, 'Name-Match zeigt alle Seiten des Kapitels');
});

test('_chapterOptions ruecken nach Tiefe ein, chapterMoveOptions schliesst self aus', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card.jumpChapterOptions(), [
    { value: 1, label: 'Eins' },
    { value: 11, label: '— Eins.A' },
    { value: 2, label: 'Zwei' },
  ]);
  const opts = card.chapterMoveOptions(11);
  assert.equal(opts[0].value, 0, 'Solo-Ziel zuerst');
  assert.deepEqual(opts.slice(1).map(o => o.value), [1, 2]);
  assert.deepEqual(card.chapterMoveOptions(0).map(o => o.value), [1, 11, 2],
    'kapitellose Seite braucht kein Solo-Ziel');
});

test('_recomputeInitialOpenState: Threshold beim ersten, User-State danach', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card.chapterOpen, { 1: true, 11: true, 2: true });

  card.chapterOpen = { 1: false, 11: true, 2: true };
  card._snapshotFromNav();
  assert.equal(card.chapterOpen[1], false, 'User-Zustand bleibt');

  // Verschwundene ID wird entfernt, neue kommt zu.
  card.chapterOpen = { 1: true, 11: true, 2: true, 99: true };
  card._recomputeInitialOpenState();
  assert.equal('99' in card.chapterOpen, false);
});

test('insertChapterItem haelt die Depth-First-Ordnung des flachen Trees', () => {
  seedNav();
  const item = { type: 'chapter', id: 3, name: 'Drei', priority: 2, depth: 1, parent_id: null, solo: false, pages: [] };

  // Hinter Kapitel 1 → hinter dessen kompletten Subtree, nicht direkt dahinter.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, { afterChapterId: 1 }).map(i => i.id),
    ['solo-900', 1, 11, 3, 2]);
  // Vor Kapitel 1 (Fallback ohne Vorgaenger) → hinter die Solo-Items.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, { beforeChapterId: 1 }).map(i => i.id),
    ['solo-900', 3, 1, 11, 2]);
  // Ohne Anker → ans Ende.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, {}).map(i => i.id),
    ['solo-900', 1, 11, 2, 3]);
  // Unbekannter Anker faellt auf „Ende" zurueck.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, { afterChapterId: 4711 }).map(i => i.id),
    ['solo-900', 1, 11, 2, 3]);
});

test('_computeChapterLengthDist: Median, Diverging-Bar, Min/Max-Flags', () => {
  const rows = _computeChapterLengthDist([
    { id: 1, name: 'A', stats: { chars: 1000, words: 150, count: 2, normseiten: 0.6 } },
    { id: 2, name: 'B', stats: { chars: 2000, words: 300, count: 3, normseiten: 1.2 } },
    { id: 3, name: 'C', stats: { chars: 3000, words: 450, count: 4, normseiten: 1.8 } },
    { id: 4, name: 'leer', stats: { chars: 0 } },
  ]);
  assert.deepEqual(rows.map(r => r.id), [1, 2, 3], 'Kapitel ohne Zeichen fallen raus');
  assert.equal(rows[0].median, 2000);
  assert.deepEqual(rows.map(r => r.deltaPct), [-50, 0, 50]);
  assert.equal(rows[0].isMin, true);
  assert.equal(rows[2].isMax, true);
  assert.equal(rows[1].isMin, false);
  // Negativer Delta waechst nach links, positiver nach rechts ab der Mitte.
  assert.equal(rows[0].barLeftPct, 2);
  assert.equal(rows[0].barWidthPct, 48);
  assert.equal(rows[1].barLeftPct, 50);
  assert.equal(rows[1].barWidthPct, 0);
  assert.equal(rows[2].barLeftPct, 50);
  assert.equal(rows[2].isPositive, true);

  assert.deepEqual(_computeChapterLengthDist([]), []);
  assert.deepEqual(_computeChapterLengthDist([{ id: 1, name: 'x', stats: { chars: 0 } }]), []);
});

test('_memo cached auf Array-Deps und invalidiert bei Aenderung', () => {
  const card = makeCard();
  let calls = 0;
  const compute = () => { calls++; return { n: calls }; };
  const a = card._memo('k', ['sig'], compute);
  const b = card._memo('k', ['sig'], compute);
  assert.equal(a, b);
  assert.equal(calls, 1);
  card._memo('k', ['other'], compute);
  assert.equal(calls, 2);
});

// ── Undo/Redo-Stacks ────────────────────────────────────────────────────────
// Regression: der Gegen-Stack darf erst NACH dem Flight beschrieben werden.
// `_pushUndo` verwirft Records, solange `_inHistoryFlight` steht (Schutz gegen
// Selbst-Aufzeichnung der Applier) — innerhalb des try-Blocks aufgezeichnet
// verschwand der Redo→Undo-Rückweg, nach einem Redo war nichts mehr undo-bar.
function makeSeededCard() {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  return card;
}

test('historyRedo legt den Record zurueck auf den Undo-Stack', async () => {
  const card = makeSeededCard();
  card._applyInverse = async () => true;
  card._applyForward = async () => true;
  card._pushUndo({ kind: 'rename-chapter', id: 1, oldName: 'A', newName: 'B' });

  await card.historyUndo();
  assert.equal(card._undoStack.length, 0);
  assert.equal(card._redoStack.length, 1);

  await card.historyRedo();
  assert.equal(card._undoStack.length, 1, 'nach Redo ist der Schritt wieder undo-bar');
  assert.equal(card._redoStack.length, 0);

  await card.historyUndo();
  assert.equal(card._undoStack.length, 0);
  assert.equal(card._redoStack.length, 1);
});

test('historyUndo eines create invalidiert den Redo-Stack', async () => {
  const card = makeSeededCard();
  card._applyInverse = async () => true;
  const snap = card._snapshotWorkstate();
  card._pushUndo({ kind: 'reorder', before: snap, after: snap });
  // Frisch angelegtes Kapitel ist leer — nur dann ist der Create-Undo erlaubt.
  card.workTree.push({ id: 3, name: 'Neu', depth: 1, parent_id: null, pages: [], subchapters: [] });
  card._pushUndo({ kind: 'create-chapter', id: 3, name: 'Neu' }, { clearRedo: false });

  await card.historyUndo();
  assert.equal(card._redoStack.length, 0, 'kein Redo nach create-Undo (neue ID beim Wiederanlegen)');
  assert.equal(card._undoStack.length, 1, 'aeltere Records bleiben undo-bar');
});

test('fehlgeschlagenes Undo/Redo laesst den Stack unveraendert', async () => {
  const card = makeSeededCard();
  card._applyInverse = async () => false;
  card._applyForward = async () => false;
  card._pushUndo({ kind: 'rename-page', id: 901, oldName: 'A', newName: 'B' });

  await card.historyUndo();
  assert.equal(card._undoStack.length, 1);
  assert.equal(card._redoStack.length, 0);

  const snap = card._snapshotWorkstate();
  card._redoStack = [{ kind: 'reorder', before: snap, after: snap }];
  await card.historyRedo();
  assert.equal(card._redoStack.length, 1);
  assert.equal(card._undoStack.length, 1);
});

test('waehrend eines Flights zeichnet _pushUndo nichts auf', () => {
  const card = makeCard();
  card._inHistoryFlight = true;
  card._pushUndo({ kind: 'reorder', before: {}, after: {} });
  assert.equal(card._undoStack.length, 0);
});

// Fremd-Änderungen (Sidebar, Collab) laufen nicht durch die History. Ein Record,
// der danach nicht mehr zum Bestand passt, darf nicht eingespielt werden —
// sonst geht ein Order-PUT mit fehlenden/toten IDs raus (Server: MISSING_*).
test('Reorder-Undo mit veraltetem Snapshot leert die History statt einzuspielen', async () => {
  const card = makeSeededCard();
  let applied = false;
  card._applyInverse = async () => { applied = true; return true; };
  const before = card._snapshotWorkstate();
  card._pushUndo({ kind: 'rename-chapter', id: 1, oldName: 'A', newName: 'Eins' });
  card._pushUndo({ kind: 'reorder', before, after: card._snapshotWorkstate() });
  // Remote-Anlage einer Seite → Workstate kennt eine ID mehr als der Snapshot.
  card.soloPages.push({ id: 999, name: 'Neu', chapter_id: 0 });

  await card.historyUndo();
  assert.equal(applied, false, 'Snapshot ohne Seite 999 wird nicht eingespielt');
  assert.equal(card._undoStack.length, 0);
  assert.equal(card._redoStack.length, 0);
});

test('Reorder-Undo mit gleichem Bestand, anderer Reihenfolge ist nicht stale', async () => {
  const card = makeSeededCard();
  let applied = false;
  card._applyInverse = async () => { applied = true; return true; };
  const before = card._snapshotWorkstate();
  card.workTree.reverse();
  card.workTree[0].pages.reverse();
  card._pushUndo({ kind: 'reorder', before, after: card._snapshotWorkstate() });

  await card.historyUndo();
  assert.equal(applied, true);
  assert.equal(card._redoStack.length, 1);
});

test('Rename-/Create-Record auf verschwundenes Ziel ist stale', () => {
  const card = makeSeededCard();
  assert.equal(card._staleReason({ kind: 'rename-page', id: 901 }, 'undo'), null);
  assert.equal(card._staleReason({ kind: 'rename-page', id: 4711 }, 'undo')?.key, 'bookOrganizer.historyStale');
  assert.equal(card._staleReason({ kind: 'rename-chapter', id: 11 }, 'redo'), null);
  assert.equal(card._staleReason({ kind: 'create-chapter', id: 4711 }, 'undo')?.key, 'bookOrganizer.historyStale');
});

// Der Verlauf ueberlebt das Schliessen der Karte. Ein Create-Undo Stunden
// spaeter darf keinen inzwischen geschriebenen Text loeschen.
test('Create-Undo verweigert, sobald die Seite Inhalt bzw. das Kapitel Seiten hat', async () => {
  const card = makeSeededCard();
  rootStub.tokEsts = { 902: { chars: 0 } };
  assert.equal(card._staleReason({ kind: 'create-page', id: 902 }, 'undo'), null, 'leere Seite: Undo erlaubt');
  rootStub.tokEsts = { 902: { chars: 1200 } };
  const r = card._staleReason({ kind: 'create-page', id: 902 }, 'undo');
  assert.equal(r?.key, 'bookOrganizer.historyHasContent');
  assert.deepEqual(r.params, { name: 'S2' });
  assert.equal(card._staleReason({ kind: 'create-chapter', id: 2 }, 'undo')?.key,
    'bookOrganizer.historyHasContent', 'Kapitel mit Seiten');
  assert.equal(card._staleReason({ kind: 'create-chapter', id: 1 }, 'undo')?.key,
    'bookOrganizer.historyHasContent', 'Kapitel mit Sub-Kapitel');

  let deleted = false;
  card._applyInverse = async () => { deleted = true; return true; };
  card._pushUndo({ kind: 'create-page', id: 902, chapterId: 1, name: 'S2' });
  await card.historyUndo();
  assert.equal(deleted, false, 'Seite mit Inhalt wird nicht geloescht');
  assert.equal(card._undoStack.length, 0);
  rootStub.tokEsts = {};
});

test('Delete-Record: Undo nur solange die Seite fehlt, Redo nur solange sie da ist', () => {
  const card = makeSeededCard();
  const rec = { kind: 'delete-page', pageId: 4711, name: 'Weg', chapterId: 1, index: 0 };
  assert.equal(card._staleReason(rec, 'undo'), null);
  assert.equal(card._staleReason(rec, 'redo')?.key, 'bookOrganizer.historyStale');
  const back = { ...rec, pageId: 901 };
  assert.equal(card._staleReason(back, 'undo')?.key, 'bookOrganizer.historyStale');
  assert.equal(card._staleReason(back, 'redo'), null);
});

// Snapshot traegt die Namen von damals. Eine Umbenennung anderswo darf ein
// Reorder-Undo weder in der Karte noch in nav.pages zuruecksetzen.
test('Reorder-Undo uebernimmt die aktuellen Namen statt der aus dem Snapshot', async () => {
  const card = makeSeededCard();
  const before = card._snapshotWorkstate();
  card.workTree[0].pages.reverse();
  // Umbenennung ausserhalb des Organizers (Sidebar/Editor) nach dem Reorder.
  card.workTree[0].pages.find(p => p.id === 901).name = 'S1 neu';
  card.workTree[0].name = 'Eins neu';
  navStore.pages.find(p => p.id === 901).name = 'S1 neu';
  card._reattachSortables = async () => {};
  card._persistOrder = async ({ mirror }) => { card._applyMirror(mirror); return true; };

  await card._applyReorderSnapshot(before);

  assert.deepEqual(card.workTree[0].pages.map(p => p.id), [901, 902], 'Reihenfolge aus dem Snapshot');
  assert.equal(card.workTree[0].pages[0].name, 'S1 neu', 'Seitenname aktuell');
  assert.equal(card.workTree[0].name, 'Eins neu', 'Kapitelname aktuell');
  assert.equal(navStore.pages.find(p => p.id === 901).name, 'S1 neu', 'Mirror schreibt keinen alten Namen');
});

test('Page-Membership-Mirror schreibt keine Namen nach nav.pages', () => {
  const card = makeSeededCard();
  card.workTree[0].pages[0].name = 'Veraltet';
  card._mirrorPageMembershipInRoot(null);
  assert.equal(navStore.pages.find(p => p.id === 901).name, 'S1');
});

test('_remapPageId zieht die neue ID durch Snapshots und Records', () => {
  const card = makeSeededCard();
  const snap = card._snapshotWorkstate();
  card._undoStack = [
    { kind: 'reorder', before: snap, after: card._snapshotWorkstate() },
    { kind: 'rename-page', id: 901, oldName: 'a', newName: 'b' },
  ];
  card._redoStack = [{ kind: 'delete-page', pageId: 901, name: 'S1', chapterId: 1, index: 0 }];
  const extra = { kind: 'delete-page', pageId: 901 };
  card._remapPageId(901, 5000, extra);
  assert.deepEqual(card._undoStack[0].before.workTree[0].pages.map(p => p.id), [5000, 902]);
  assert.deepEqual(card._undoStack[0].after.workTree[0].pages.map(p => p.id), [5000, 902]);
  assert.equal(card._undoStack[1].id, 5000);
  assert.equal(card._redoStack[0].pageId, 5000);
  assert.equal(extra.pageId, 5000);
});

test('Delete-Undo stellt aus dem Papierkorb wieder her, an die alte Stelle, mit neuer ID', async () => {
  const card = makeSeededCard();
  // Seite 901 (Index 0 in Kapitel 1) ist geloescht — Workstate ohne sie.
  card.workTree[0].pages.shift();
  const orig = { ...contentRepo };
  let savedTree = null;
  let reloaded = 0;
  contentRepo.listTrash = async () => ({ items: [{ id: 77, page_id: 901, name: 'S1' }] });
  contentRepo.restoreFromTrash = async (bookId, delId) => {
    assert.equal(delId, 77);
    return { ok: true, page: { id: 5001, name: 'S1', chapter_id: 1 } };
  };
  contentRepo.saveOrder = async (bookId, tree) => { savedTree = tree; };
  rootStub.loadPages = async () => { reloaded++; };
  try {
    const rec = { kind: 'delete-page', pageId: 901, name: 'S1', chapterId: 1, index: 0 };
    card._undoStack = [{ kind: 'rename-page', id: 901, oldName: 'x', newName: 'S1' }, rec];
    await card.historyUndo();
    assert.deepEqual(card.workTree[0].pages.map(p => p.id), [5001, 902], 'alte Position');
    const ch1 = savedTree.find(n => n.type === 'chapter' && n.id === 1);
    assert.deepEqual(ch1.children.filter(c => c.type === 'page').map(c => c.id), [5001, 902]);
    assert.equal(reloaded, 1, 'Store wird nach dem Restore neu geladen');
    assert.equal(card._undoStack[0].id, 5001, 'aelterer Record auf neue ID umgeschrieben');
    assert.equal(card._redoStack[0].pageId, 5001, 'Redo loescht die neue Seite');
  } finally {
    Object.assign(contentRepo, orig);
    delete rootStub.loadPages;
  }
});

// Klick auf „Rueckgaengig" blurt das Namensfeld → Rename startet asynchron.
// Undo muss warten, sonst nimmt es den VORHERIGEN Record und der spaeter
// gepushte Rename-Record leert den Redo-Stack.
test('historyUndo wartet auf laufende Umbenennungen', async () => {
  const card = makeSeededCard();
  const undone = [];
  card._applyInverse = async (rec) => { undone.push(rec.kind); return true; };
  const snap = card._snapshotWorkstate();
  card._pushUndo({ kind: 'reorder', before: snap, after: snap });
  let finish;
  card._trackRename(new Promise(res => { finish = res; }).then(() => {
    card._recordRenamePage(901, 'S1', 'S1b');
  }));
  const p = card.historyUndo();
  finish();
  await p;
  assert.deepEqual(undone, ['rename-page'], 'die Umbenennung ist der juengste Schritt');
  assert.equal(card._undoStack.length, 1, 'Reorder bleibt undo-bar');
});

test('Suche: Kapitel mit Namens-Treffer behaelt alle Sub-Kapitel', () => {
  const card = makeSeededCard();
  card.organizerSearch = 'eins';
  const f = card.filteredWorkTree();
  assert.deepEqual(f.map(c => c.id), [1]);
  assert.deepEqual(f[0].subchapters.map(c => c.id), [11]);
  card.organizerSearch = 'sub1';
  const g = card.filteredWorkTree();
  assert.deepEqual(g[0].pages, [], 'ohne Namens-Treffer nur passende Seiten');
  assert.deepEqual(g[0].subchapters[0].pages.map(p => p.id), [911]);
});

test('bookMoveOptions bietet nur schreibbare, nicht archivierte fremde Buecher an', () => {
  const card = makeCard();
  navStore.books = [
    { id: 7, name: 'Aktuell', role: 'owner' },
    { id: 8, name: 'Eigenes', role: 'owner' },
    { id: 9, name: 'Mitautor', role: 'editor' },
    { id: 10, name: 'Nur lesen', role: 'viewer' },
    { id: 11, name: 'Lektorat', role: 'lektor' },
    { id: 12, name: 'Archiv', role: 'owner', archived: true },
  ];
  assert.deepEqual(card.bookMoveOptions().map(o => o.value), [8, 9]);
  navStore.books = [];
});

test('_rebuildTreeOrderMaps: gleichnamige Kapitel zeigen auf das erste Vorkommen', () => {
  const ctx = {
    $store: { nav: {
      tree: [
        { type: 'chapter', id: 1, name: 'Teil A', solo: false },
        { type: 'chapter', id: 11, name: 'Szene 1', solo: false },
        { type: 'chapter', id: 2, name: 'Teil B', solo: false },
        { type: 'chapter', id: 21, name: 'Szene 1', solo: false },
      ],
      pages: [],
    } },
  };
  treeBuildMethods._rebuildTreeOrderMaps.call(ctx);
  assert.equal(ctx._chapterOrderMap.get('Szene 1'), 1);
  assert.equal(ctx._chapterOrderMap.get('Teil B'), 2, 'Index zaehlt weiter');
});

test('_fmtDec1 formatiert eine Nachkommastelle in der UI-Locale', () => {
  const card = makeCard();
  assert.equal(card._fmtDec1(2), '2.0');
  assert.equal(card._fmtDec1(12.345), '12.3');
});
