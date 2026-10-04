// Ideen-Board: die pure Gruppierung (Bahnen-Reihenfolge aus dem Baum, Zuordnung
// der Ideen in Bahn × Stufe, Filter).
//
// Gegenstand sind die Aussagen, die man der Anzeige nicht ansieht: dass keine
// Idee still verschwindet, dass der Kapitel-Filter auch Seiten-Ideen erfasst und
// dass die Zahl der ausgeblendeten stimmt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals, LANE_UNKNOWN } =
  await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-board', 'model.js'));
const { LANE_BOOK, ideeLaneKey } = await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-shared.js'));

// Baum wie ihn tree/build.js liefert: flach, depth-annotiert, Solo-Seiten als
// Pseudo-Kapitel.
const TREE = [
  { type: 'chapter', id: 'solo-90', solo: true, depth: 1, name: 'Vorwort', pages: [{ id: 90, name: 'Vorwort' }] },
  { type: 'chapter', id: 1, solo: false, depth: 1, name: 'Kapitel 1', pages: [{ id: 10, name: 'Seite A' }, { id: 11, name: 'Seite B' }] },
  { type: 'chapter', id: 2, solo: false, depth: 2, name: 'Kapitel 2', pages: [{ id: 20, name: 'Seite C' }] },
];

const idee = (id, over = {}) => ({
  id, content: `Idee ${id}`, status: 'offen',
  page_id: null, chapter_id: null, lane_chapter_id: null, links: [], ...over,
});

test('Bahnen: Reihenfolge kommt aus dem Baum, Kapitel vor seinen Seiten', () => {
  assert.deepEqual(buildLaneOrder(TREE).map(l => l.key), [
    LANE_BOOK,          // Ideen ohne Anker stehen vor allen Stellen im Buch
    'page:90',          // Solo-Seite: nur die Seiten-Bahn, kein Pseudo-Kapitel
    'chapter:1', 'page:10', 'page:11',
    'chapter:2', 'page:20',
  ]);
});

test('Bahnen: Solo-Seite bekommt KEINE Kapitel-Bahn', () => {
  const lanes = buildLaneOrder(TREE);
  assert.equal(lanes.some(l => l.key === 'chapter:solo-90'), false);
  assert.equal(lanes.find(l => l.key === 'page:90').chapterId, null);
});

test('Board: Ideen landen in ihrer Bahn und ihrer Stufen-Spalte', () => {
  const laneOrder = buildLaneOrder(TREE);
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'in_arbeit' }),
    idee(3, { page_id: 10, lane_chapter_id: 1, status: 'erledigt' }),
  ];
  const { lanes, total, visible } = buildBoard({ ideen, laneOrder });
  assert.equal(total, 3);
  assert.equal(visible, 3);
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1', 'page:10']);
  assert.deepEqual(lanes[0].columns.offen.map(i => i.id), [1]);
  assert.deepEqual(lanes[1].columns.in_arbeit.map(i => i.id), [2]);
  assert.deepEqual(lanes[1].columns.erledigt.map(i => i.id), [3]);
  assert.equal(lanes[1].count, 2);
});

test('Board: leere Seiten-Bahnen erscheinen nicht', () => {
  const { lanes } = buildBoard({
    ideen: [idee(1, { page_id: 20, lane_chapter_id: 2 })],
    laneOrder: buildLaneOrder(TREE),
  });
  // Die Kapitel-Bahn steht ohne eigene Ideen mit: sie ist die Ueberschrift und
  // der Griff, an dem das Kapitel zuklappt. Die uebrigen leeren Bahnen (Kapitel 1
  // samt Seiten, Vorwort) fehlen.
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:2', 'page:20']);
  assert.equal(lanes[0].count, 0);
  assert.equal(lanes[0].childLanes, 1);
});

test('Board: ein Kapitel ohne Ideen irgendwo darunter erscheint nicht', () => {
  const { lanes } = buildBoard({
    ideen: [idee(1, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1']);
});

test('Board: eine Idee, deren Bahn der Baum nicht kennt, faellt in die Sammelbahn', () => {
  // Der Fall ist real: Seite gerade angelegt, Baum noch nicht nachgezogen. Das
  // Board ist eine Pendenzenliste — still verschwinden darf dort nichts.
  const { lanes, visible } = buildBoard({
    ideen: [idee(7, { page_id: 999, lane_chapter_id: null })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.equal(visible, 1);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].lane.key, LANE_UNKNOWN);
  assert.equal(lanes[0].lane.kind, 'unknown');
});

test('Board: die Sammelbahn steht zuletzt', () => {
  const { lanes } = buildBoard({
    ideen: [idee(7, { page_id: 999 }), idee(8, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1', LANE_UNKNOWN]);
});

test('Filter: Kapitel-Filter erfasst auch die Ideen der SEITEN dieses Kapitels', () => {
  // Das ist der Grund fuer `lane_chapter_id`: nach `chapter_id` gefiltert faende
  // „Kapitel 1" nur die Ideen, die direkt am Kapitel haengen.
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1 }),
    idee(2, { page_id: 10, lane_chapter_id: 1 }),
    idee(3, { page_id: 20, lane_chapter_id: 2 }),
  ];
  const board = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), filterChapterId: '1' });
  assert.equal(board.visible, 2);
  assert.equal(board.hiddenByFilter, 1);
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:1', 'page:10']);
});

test('Filter: verworfene ausblenden zaehlt sie als ausgeblendet, nicht als weg', () => {
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'verworfen' }),
  ];
  const off = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), showVerworfen: false });
  assert.equal(off.total, 2);
  assert.equal(off.visible, 1);
  assert.equal(off.hiddenByFilter, 1);

  const on = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), showVerworfen: true });
  assert.equal(on.visible, 2);
  assert.equal(on.hiddenByFilter, 0);
});

test('Filter: erledigte ausblenden laesst den Spalten-Zaehler unberuehrt', () => {
  // Zwei unabhaengige Haken (erledigt / verworfen): die abgeschlossenen Stufen
  // sind getrennt ausblendbar, weil sie Verschiedenes beantworten — „fertig"
  // und „dagegen entschieden".
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'erledigt' }),
    idee(3, { page_id: 10, lane_chapter_id: 1, status: 'verworfen' }),
  ];
  const off = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), showErledigt: false, showVerworfen: true });
  assert.equal(off.total, 3);
  assert.equal(off.visible, 2);
  assert.equal(off.hiddenByFilter, 1);
  // Die Spalte misst den Gesamtbestand, nicht die gefilterte Sicht.
  assert.equal(statusTotals(ideen).erledigt, 1);

  const on = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), showErledigt: true, showVerworfen: true });
  assert.equal(on.visible, 3);
  assert.equal(on.hiddenByFilter, 0);
});

test('Filter: Volltext trifft den Ideentext, ohne Gross-/Kleinschreibung', () => {
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, content: 'Beleg für die Zahl nachtragen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, content: 'Szene kürzen' }),
  ];
  const board = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), query: '  BELEG ' });
  assert.equal(board.visible, 1);
  assert.equal(board.hiddenByFilter, 1);
});

test('Filter: unbekannter Status faellt nicht aus dem Board', () => {
  const board = buildBoard({
    ideen: [idee(1, { page_id: 10, lane_chapter_id: 1, status: 'quatsch' })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.equal(board.visible, 1);
  const page = board.lanes.find(l => l.lane.key === 'page:10');
  assert.deepEqual(page.columns.offen.map(i => i.id), [1]);
});

test('Kapitel-Optionen: nur Kapitel mit Ideen, unabhaengig vom Status-Filter', () => {
  // Unabhaengig, weil die eigene Auswahl sonst unter der Hand verschwaende,
  // sobald man `verworfen` ausblendet.
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1, status: 'verworfen' }),
    idee(2, { page_id: 20, lane_chapter_id: 2, status: 'offen' }),
  ];
  assert.deepEqual(chapterFilterOptions(ideen, buildLaneOrder(TREE)),
    [{ value: '1', label: 'Kapitel 1' }, { value: '2', label: 'Kapitel 2' }]);
});

test('Spalten-Zaehler messen den GESAMTEN Bestand, nicht die gefilterte Sicht', () => {
  // Sonst zeigte die Spalte „verworfen" beim Ausblenden eine 0 — das Gegenteil
  // der Wahrheit.
  const ideen = [
    idee(1, { page_id: 10, status: 'offen' }),
    idee(2, { page_id: 10, status: 'verworfen' }),
    idee(3, { page_id: 10, status: 'verworfen' }),
  ];
  assert.deepEqual(statusTotals(ideen), { offen: 1, in_arbeit: 0, erledigt: 0, verworfen: 2 });
});

test('Board: leerer Baum ergibt nur die Sammelbahn, keine Ausnahme', () => {
  const board = buildBoard({ ideen: [idee(1, { page_id: 10 })], laneOrder: [] });
  assert.equal(board.lanes.length, 1);
  assert.equal(board.lanes[0].lane.key, LANE_UNKNOWN);
});

// ── Klappen ────────────────────────────────────────────────────────────────
// Klappen ist Ansicht, kein Filter: es darf weder die Filterzahlen bewegen noch
// eine Pendenz spurlos schlucken. Genau das steht hier.

test('Klappen: ein zugeklapptes Kapitel faltet seine Seiten-Bahnen in die Kapitelzeile', () => {
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'in_arbeit' }),
    idee(3, { page_id: 11, lane_chapter_id: 1, status: 'in_arbeit' }),
  ];
  const board = buildBoard({
    ideen, laneOrder: buildLaneOrder(TREE), collapsedChapters: ['chapter:1'],
  });
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:1']);
  const row = board.lanes[0];
  assert.equal(row.childCollapsed, true);
  assert.equal(row.childLanes, 2);
  assert.equal(row.foldedCount, 2);
  assert.equal(row.folded.in_arbeit, 2);
  // Die eigenen Karten des Kapitels bleiben sichtbar — gefaltet sind die Seiten.
  assert.deepEqual(row.columns.offen.map(i => i.id), [1]);
  assert.equal(row.hidden.in_arbeit, 2);
  assert.equal(row.hidden.offen, 0);
});

test('Klappen: eine zugeklappte Bahn behaelt ihre Zeile und nennt die Zahl', () => {
  const ideen = [
    idee(1, { page_id: 10, lane_chapter_id: 1, status: 'offen' }),
    idee(2, { page_id: 10, lane_chapter_id: 1, status: 'erledigt' }),
  ];
  const board = buildBoard({
    ideen, laneOrder: buildLaneOrder(TREE), collapsedLanes: ['page:10'],
  });
  const row = board.lanes.find(l => l.lane.key === 'page:10');
  assert.equal(row.collapsed, true);
  assert.equal(row.count, 2);
  assert.equal(row.hidden.offen, 1);
  assert.equal(row.hidden.erledigt, 1);
  // Die Karten bleiben im Modell — die Anzeige entscheidet, ob sie rendert.
  assert.deepEqual(row.columns.offen.map(i => i.id), [1]);
});

test('Klappen: bewegt die Filterzahlen NICHT', () => {
  // Eingeklappt ist nicht ausgefiltert. Liefe das zusammen, behauptete die
  // Filterleiste, sie verstecke etwas, das sie nicht meint.
  const ideen = [
    idee(1, { chapter_id: 1, lane_chapter_id: 1 }),
    idee(2, { page_id: 10, lane_chapter_id: 1 }),
  ];
  const laneOrder = buildLaneOrder(TREE);
  const open = buildBoard({ ideen, laneOrder });
  const folded = buildBoard({ ideen, laneOrder, collapsedChapters: ['chapter:1'], collapsedLanes: ['chapter:1'] });
  assert.deepEqual(
    [folded.total, folded.visible, folded.hiddenByFilter],
    [open.total, open.visible, open.hiddenByFilter],
  );
});

test('Klappen: ein Kapitel ohne eigene Ideen bleibt als Griff stehen, wenn es gefaltet ist', () => {
  // Sonst waere das Kapitel nach dem Zuklappen weg — samt der Moeglichkeit, es
  // wieder aufzuklappen.
  const board = buildBoard({
    ideen: [idee(1, { page_id: 20, lane_chapter_id: 2 })],
    laneOrder: buildLaneOrder(TREE),
    collapsedChapters: ['chapter:2'],
  });
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:2']);
  assert.equal(board.lanes[0].foldedCount, 1);
  assert.equal(board.lanes[0].hidden.offen, 1);
});

test('Klappen: die Sammelbahn laesst sich einklappen', () => {
  const board = buildBoard({
    ideen: [idee(7, { page_id: 999 })],
    laneOrder: buildLaneOrder(TREE),
    collapsedLanes: [LANE_UNKNOWN],
  });
  assert.equal(board.lanes[0].collapsed, true);
  assert.equal(board.lanes[0].hidden.offen, 1);
});

// ── Buch-Ideen (kein Anker) ────────────────────────────────────────────────

test('Buch-Idee: ohne Seite und Kapitel landet sie in der Buch-Bahn, nicht in der Sammelbahn', () => {
  assert.equal(ideeLaneKey(idee(1)), LANE_BOOK);
  const { lanes, visible } = buildBoard({
    ideen: [idee(1), idee(2, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.equal(visible, 2);
  assert.deepEqual(lanes.map(l => l.lane.key), [LANE_BOOK, 'chapter:1']);
  assert.equal(lanes[0].lane.kind, 'book');
});

test('Buch-Idee: die Buch-Bahn erscheint nur, wenn sie belegt ist', () => {
  const { lanes } = buildBoard({
    ideen: [idee(2, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
  });
  assert.equal(lanes.some(l => l.lane.key === LANE_BOOK), false);
});

test('Buch-Idee: ein Kapitel-Filter blendet sie aus und zaehlt sie als ausgeblendet', () => {
  const { lanes, hiddenByFilter } = buildBoard({
    ideen: [idee(1), idee(2, { chapter_id: 1, lane_chapter_id: 1 })],
    laneOrder: buildLaneOrder(TREE),
    filterChapterId: '1',
  });
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:1']);
  assert.equal(hiddenByFilter, 1);
});

const { compareIdeen, cellOrderAfterDrop, columnSortOf, nextColumnSort } =
  await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-board', 'model.js'));

test('Sortierung: Default ist die urspruengliche Position — sort_order, nie einsortierte (0) oben, neueste zuerst', () => {
  const ideen = [
    idee(1, { sort_order: 2, created_at: '2026-10-01T10:00:00Z' }),
    idee(2, { sort_order: 1, created_at: '2026-10-02T10:00:00Z' }),
    idee(3, { sort_order: 0, created_at: '2026-10-03T10:00:00Z' }),
    idee(4, { sort_order: 0, created_at: '2026-10-04T10:00:00Z' }),
  ];
  const { lanes } = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE) });
  assert.deepEqual(lanes[0].columns.offen.map(i => i.id), [4, 3, 2, 1]);
  assert.equal(compareIdeen('manual', 'asc'), compareIdeen('manual', 'desc'));
});

test('Sortierung pro Spalte: jede Stufe nach ihrem eigenen Kriterium', () => {
  const ideen = [
    idee(1, { status: 'offen', content: 'beta', created_at: '2026-10-01T10:00:00Z', sort_order: 1 }),
    idee(2, { status: 'offen', content: 'Alpha', created_at: '2026-10-02T10:00:00Z', sort_order: 2 }),
    idee(3, { status: 'erledigt', content: 'zeta', created_at: '2026-10-01T10:00:00Z', sort_order: 2 }),
    idee(4, { status: 'erledigt', content: 'eta', created_at: '2026-10-03T10:00:00Z', sort_order: 1 }),
  ];
  const { lanes } = buildBoard({
    ideen, laneOrder: buildLaneOrder(TREE),
    columnSort: { offen: { by: 'title', dir: 'asc' }, erledigt: { by: 'created', dir: 'desc' } },
  });
  assert.deepEqual(lanes[0].columns.offen.map(i => i.id), [2, 1]);
  assert.deepEqual(lanes[0].columns.erledigt.map(i => i.id), [4, 3]);
  // Ohne Eintrag: manuelle Position.
  const plain = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), columnSort: { offen: { by: 'title' } } });
  assert.deepEqual(plain.lanes[0].columns.erledigt.map(i => i.id), [4, 3]);
  assert.deepEqual(plain.lanes[0].columns.offen.map(i => i.id), [2, 1]);
});

test('Sortierung: nach Titel, Gross/Klein egal, Gleichstand nach id', () => {
  const ideen = [
    idee(1, { content: 'beta' }),
    idee(2, { content: 'Alpha' }),
    idee(3, { content: 'alpha' }),
  ];
  const { lanes } = buildBoard({ ideen, laneOrder: buildLaneOrder(TREE), columnSort: { offen: { by: 'title', dir: 'asc' } } });
  assert.deepEqual(lanes[0].columns.offen.map(i => i.id), [2, 3, 1]);
});

test('nextColumnSort: Kriterium waehlen, Richtung umkehren, Reset entfernt den Eintrag', () => {
  const start = {};
  const a = nextColumnSort(start, 'offen', 'created');
  assert.deepEqual(a, { offen: { by: 'created', dir: 'asc' } });
  assert.deepEqual(start, {}, 'immer neue Map, nie mutieren');
  const b = nextColumnSort(a, 'offen', 'created');
  assert.deepEqual(b.offen, { by: 'created', dir: 'desc' });
  const c = nextColumnSort(b, 'offen', 'title');
  assert.deepEqual(c.offen, { by: 'title', dir: 'asc' });
  const d = nextColumnSort({ ...c, erledigt: { by: 'title', dir: 'asc' } }, 'offen', null);
  assert.deepEqual(d, { erledigt: { by: 'title', dir: 'asc' } });
  assert.deepEqual(columnSortOf(d, 'offen'), { by: 'manual', dir: 'asc' });
});

test('columnSortOf: kaputter localStorage-Wert faellt auf die manuelle Position', () => {
  assert.equal(columnSortOf({ offen: { by: 'bogus' } }, 'offen').by, 'manual');
  assert.equal(columnSortOf(null, 'offen').by, 'manual');
  assert.equal(columnSortOf({ offen: { by: 'title', dir: 'x' } }, 'offen').dir, 'asc');
});

test('cellOrderAfterDrop: verschieben in der Zelle', () => {
  assert.deepEqual(cellOrderAfterDrop([1, 2, 3, 4], [3, 1, 2, 4], 3), [3, 1, 2, 4]);
  assert.deepEqual(cellOrderAfterDrop([1, 2, 3, 4], [2, 3, 4, 1], 1), [2, 3, 4, 1]);
});

test('cellOrderAfterDrop: ausgeblendete Ideen behalten ihren Platz', () => {
  // 2 und 4 blendet der Textfilter aus; 3 wird vor 1 gezogen.
  assert.deepEqual(cellOrderAfterDrop([1, 2, 3, 4, 5], [3, 1, 5], 3), [3, 1, 2, 4, 5]);
  // 1 ans Ende hinter 5 gezogen: landet hinter dem sichtbaren Vorgaenger.
  assert.deepEqual(cellOrderAfterDrop([1, 2, 3, 4, 5], [3, 5, 1], 1), [2, 3, 4, 5, 1]);
});

test('cellOrderAfterDrop: Zug aus einer anderen Spalte fuegt an der Drop-Stelle ein', () => {
  assert.deepEqual(cellOrderAfterDrop([1, 2], [1, 9, 2], 9), [1, 9, 2]);
  assert.deepEqual(cellOrderAfterDrop([], [9], 9), [9]);
});

// ── Hierarchie ─────────────────────────────────────────────────────────────
// Der Baum ist flach und depth-first; die Gliederung haelt `parent_id`. Das
// Board muss sie ueber jede Tiefe tragen: Ueberschrift, Faltung, Filter.

const NESTED = [
  { type: 'chapter', id: 5, solo: false, depth: 1, parent_id: null, name: 'Teil I', pages: [{ id: 50, name: 'Auftakt' }] },
  { type: 'chapter', id: 6, solo: false, depth: 2, parent_id: 5, name: 'Kapitel 1', pages: [{ id: 60, name: 'Szene A' }, { id: 61, name: 'Szene B' }] },
  { type: 'chapter', id: 7, solo: false, depth: 3, parent_id: 6, name: 'Unterkapitel', pages: [{ id: 70, name: 'Szene C' }] },
];

test('Hierarchie: ein Oberkapitel ohne eigene Ideen ordnet die Ideen seiner Unterkapitel', () => {
  const { lanes } = buildBoard({
    ideen: [idee(1, { page_id: 70, lane_chapter_id: 7 })],
    laneOrder: buildLaneOrder(NESTED),
  });
  assert.deepEqual(lanes.map(l => l.lane.key), ['chapter:5', 'chapter:6', 'chapter:7', 'page:70']);
  // Die Abschnittszahl misst den ganzen Teilbaum.
  assert.deepEqual(lanes.map(l => l.childLanes), [1, 1, 1, 0]);
  assert.deepEqual(lanes.map(l => l.lane.depth), [1, 2, 3, 4]);
});

test('Hierarchie: Falten eines Oberkapitels faltet den ganzen Teilbaum in seine Zeile', () => {
  const ideen = [
    idee(1, { page_id: 60, lane_chapter_id: 6, status: 'offen' }),
    idee(2, { chapter_id: 7, lane_chapter_id: 7, status: 'in_arbeit' }),
    idee(3, { page_id: 70, lane_chapter_id: 7, status: 'offen' }),
  ];
  const board = buildBoard({ ideen, laneOrder: buildLaneOrder(NESTED), collapsedChapters: ['chapter:5'] });
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:5']);
  assert.equal(board.lanes[0].foldedCount, 3);
  assert.equal(board.lanes[0].hidden.offen, 2);
  assert.equal(board.lanes[0].hidden.in_arbeit, 1);
  assert.equal(board.visible, 3);
});

test('Hierarchie: ein gefaltetes Unterkapitel faltet nur seinen Teilbaum', () => {
  const ideen = [
    idee(1, { page_id: 60, lane_chapter_id: 6 }),
    idee(2, { page_id: 70, lane_chapter_id: 7 }),
  ];
  const board = buildBoard({ ideen, laneOrder: buildLaneOrder(NESTED), collapsedChapters: ['chapter:7'] });
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:5', 'chapter:6', 'page:60', 'chapter:7']);
  assert.equal(board.lanes[3].foldedCount, 1);
});

test('Hierarchie: der Kapitel-Filter erfasst Unterkapitel samt Abschnitten', () => {
  const ideen = [
    idee(1, { page_id: 50, lane_chapter_id: 5 }),
    idee(2, { page_id: 60, lane_chapter_id: 6 }),
    idee(3, { page_id: 70, lane_chapter_id: 7 }),
  ];
  const laneOrder = buildLaneOrder(NESTED);
  const board = buildBoard({ ideen, laneOrder, filterChapterId: '6' });
  assert.equal(board.visible, 2);
  assert.equal(board.hiddenByFilter, 1);
  assert.deepEqual(board.lanes.map(l => l.lane.key), ['chapter:5', 'chapter:6', 'page:60', 'chapter:7', 'page:70']);
  // Das Oberkapitel ist waehlbar, obwohl nur sein Teilbaum Ideen traegt.
  assert.deepEqual(
    chapterFilterOptions([idee(9, { page_id: 70, lane_chapter_id: 7 })], laneOrder).map(o => o.value),
    ['5', '6', '7'],
  );
});
