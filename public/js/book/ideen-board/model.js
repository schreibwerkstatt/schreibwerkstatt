// Pure Rechnung des Ideen-Boards: aus dem Baum die Bahnen-Reihenfolge, aus den
// Ideen die belegten Bahnen und ihre Status-Spalten.
//
// Ohne Alpine, ohne fetch, ohne `this` — damit die Gruppierung testbar ist
// (tests/unit/ideen-board.test.mjs) und die Karte nur noch State haelt.

import { IDEE_STATUSES, ideeStatus, ideeLaneKey, LANE_BOOK } from '../ideen-shared.js';

export const LANE_UNKNOWN = 'unknown:0';

/**
 * Bahnen-Reihenfolge aus `$store.nav.tree`.
 *
 * Die ORDNUNG der Bahnen kommt aus dem Baum und nicht aus der Ideen-Abfrage:
 * der Baum ist die SSoT der Buch-Reihenfolge (book_order-Overlay), eine
 * `ORDER BY position` im Ideen-SQL waere eine zweite, stillschweigend
 * abweichende Sortierung.
 *
 * Pro Kapitel entsteht zuerst die Kapitel-Bahn (Ideen, die am Kapitel als
 * Ganzem haengen), danach die Bahnen seiner Seiten. Der Baum ist flach und
 * depth-first, Unterkapitel folgen also hinter den Seiten ihres Elternkapitels;
 * `parentId` haelt die Kette fest, an der Sichtbarkeit, Faltung und
 * Kapitel-Filter den ganzen Teilbaum erfassen. Solo-Seiten (Seiten ohne
 * Kapitel) stehen im Baum als Pseudo-Kapitel und ergeben nur ihre Seiten-Bahn —
 * eine Kapitel-Bahn dafuer waere eine Bahn fuer ein Kapitel, das es nicht gibt.
 *
 * Ganz oben steht die Buch-Bahn: Ideen ohne Anker, die noch auf ihre Zuordnung
 * warten. Sie erscheint wie eine Seiten-Bahn nur, wenn sie belegt ist.
 */
export function buildLaneOrder(tree) {
  const lanes = [{ key: LANE_BOOK, kind: 'book', id: 0, label: '', chapterId: null, chapterLabel: '', depth: 1 }];
  for (const node of (tree || [])) {
    if (node.solo) {
      const p = (node.pages || [])[0];
      if (p) lanes.push({ key: `page:${p.id}`, kind: 'page', id: p.id, label: p.name || '', chapterId: null, chapterLabel: '', depth: 1 });
      continue;
    }
    lanes.push({
      key: `chapter:${node.id}`, kind: 'chapter', id: node.id, label: node.name || '',
      chapterId: node.id, chapterLabel: node.name || '', depth: node.depth || 1,
      parentId: node.parent_id ?? null,
    });
    for (const p of (node.pages || [])) {
      lanes.push({
        key: `page:${p.id}`, kind: 'page', id: p.id, label: p.name || '',
        chapterId: node.id, chapterLabel: node.name || '', depth: (node.depth || 1) + 1,
      });
    }
  }
  return lanes;
}

/**
 * Reihenfolge der Karten INNERHALB einer Zelle — gewaehlt PRO SPALTE
 * (`columnSort`, Map Stufe → `{ by, dir }`). Fehlt eine Stufe in der Map, gilt
 * die urspruengliche Position (`manual`: `sort_order`, compareIdeeManual) — der
 * Reset einer Spalte entfernt ihren Eintrag, statt `manual` hineinzuschreiben,
 * damit „nie umsortiert" und „zurueckgesetzt" derselbe Zustand sind.
 * `created` sortiert nach Erstellzeit, `title` nach dem Text (Ideen haben
 * keinen eigenen Titel), beide mit umkehrbarer Richtung; `manual` kennt keine.
 * Gleichstand faellt auf die id, damit die Reihenfolge stabil bleibt.
 */
export const IDEE_SORT_KEYS = ['created', 'title'];
export const IDEE_SORT_MANUAL = 'manual';

/** Sortierung einer Spalte; ohne gueltigen Eintrag die manuelle Position. */
export function columnSortOf(columnSort, status) {
  const e = columnSort?.[status];
  if (!e || !IDEE_SORT_KEYS.includes(e.by)) return { by: IDEE_SORT_MANUAL, dir: 'asc' };
  return { by: e.by, dir: e.dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * Klick auf ein Sortier-Kriterium einer Spalte: dasselbe Kriterium noch einmal
 * kehrt die Richtung um, ein anderes beginnt aufsteigend. `null` als Kriterium
 * setzt die Spalte auf ihre urspruengliche Position zurueck. Liefert immer eine
 * NEUE Map (der Board-Memo vergleicht per Identitaet, und die Scope-Defaults
 * sind ein geteiltes Objekt).
 */
export function nextColumnSort(columnSort, status, by) {
  const next = { ...(columnSort || {}) };
  if (!IDEE_SORT_KEYS.includes(by)) { delete next[status]; return next; }
  const cur = columnSortOf(columnSort, status);
  next[status] = { by, dir: cur.by === by && cur.dir === 'asc' ? 'desc' : 'asc' };
  return next;
}

/**
 * Manuelle Reihenfolge: `sort_order` aufsteigend, bei Gleichstand die neueste
 * oben. 0 heisst „nie einsortiert" — eine neue Idee steht damit oben in ihrer
 * Zelle; ein Drag schreibt die Zelle als 1..n (db/ideen.js#reorderIdeen).
 */
export function compareIdeeManual(a, b) {
  const so = (a.sort_order || 0) - (b.sort_order || 0);
  if (so) return so;
  const ca = a.created_at || '';
  const cb = b.created_at || '';
  if (ca !== cb) return ca < cb ? 1 : -1;
  return (b.id || 0) - (a.id || 0);
}

/**
 * Neue manuelle Reihenfolge einer Zelle nach einem Drop.
 *
 * `cellIds` ist der GANZE Zellbestand in manueller Reihenfolge — auch die Ideen,
 * die der Textfilter gerade ausblendet. `domIds` ist, was die Zelle nach dem
 * Drop zeigt. Ein Drag verschiebt genau eine Karte; die anderen behalten ihre
 * relative Lage. Darum wird die gezogene Idee nur vor ihren sichtbaren
 * Nachfolger gesetzt (ohne Nachfolger hinter ihren Vorgaenger, sonst ans Ende) —
 * eine ausgeblendete Idee wandert so nie mit und verliert ihren Platz nicht.
 */
export function cellOrderAfterDrop(cellIds, domIds, draggedId) {
  const rest = (cellIds || []).filter(id => id !== draggedId);
  const at = (domIds || []).indexOf(draggedId);
  if (at < 0) return rest;
  const next = domIds[at + 1];
  const prev = domIds[at - 1];
  let pos = next != null ? rest.indexOf(next) : -1;
  if (pos < 0) {
    const p = prev != null ? rest.indexOf(prev) : -1;
    pos = p >= 0 ? p + 1 : (next != null ? 0 : rest.length);
  }
  rest.splice(pos, 0, draggedId);
  return rest;
}

export function compareIdeen(sortBy = IDEE_SORT_MANUAL, sortDir = 'asc') {
  if (!IDEE_SORT_KEYS.includes(sortBy)) return compareIdeeManual;
  const dir = sortDir === 'desc' ? -1 : 1;
  const byId = (a, b) => (a.id || 0) - (b.id || 0);
  if (sortBy === 'title') {
    return (a, b) => dir * ((a.content || '').localeCompare(b.content || '', undefined, { sensitivity: 'base', numeric: true })
      || byId(a, b));
  }
  return (a, b) => {
    const ca = a.created_at || '';
    const cb = b.created_at || '';
    return dir * ((ca < cb ? -1 : ca > cb ? 1 : 0) || byId(a, b));
  };
}

/**
 * Kapitel-Bahnen ab `chapterId` nach aussen: das Kapitel selbst und seine
 * Vorfahren. Ein
 * Zyklus im Baum (darf nicht vorkommen) bricht am Deckel ab, statt zu haengen.
 */
function chapterChain(chapterId, chapterLanes) {
  const out = [];
  let id = chapterId;
  for (let guard = 0; id != null && guard < 64; guard++) {
    const l = chapterLanes.get(id);
    if (!l) break;
    out.push(l);
    id = l.parentId;
  }
  return out;
}

function matchesQuery(idee, q) {
  if (!q) return true;
  return (idee.content || '').toLowerCase().includes(q);
}

/**
 * Das ganze Board in einem Pass.
 *
 * `hiddenByFilter` ist kein Beiwerk: der Filter blendet aus, er loescht nicht —
 * und eine ausgeblendete Idee, die nirgends mehr gezaehlt wird, ist von einer
 * verlorenen nicht zu unterscheiden. Darum faellt die Zahl hier mit an.
 *
 * Eine Idee, deren Bahn der Baum (noch) nicht kennt — Seite gerade angelegt,
 * Baum noch nicht nachgezogen —, landet in der Sammelbahn LANE_UNKNOWN statt
 * aus dem Board zu fallen. Das Board ist eine Pendenzenliste; still verschwinden
 * darf dort nichts.
 *
 * KLAPPEN ist Ansicht, nicht Filter — darum zaehlt es weder in `hiddenByFilter`
 * noch aus `visible` heraus. Zwei Achsen, unabhaengig voneinander:
 *   `collapsedLanes`    — Bahn-Keys, deren KARTEN eingeklappt sind.
 *   `collapsedChapters` — Kapitel-Bahn-Keys, deren TEILBAUM (Unterkapitel samt
 *                         Abschnitts-Bahnen) in die Kapitelzeile gefaltet ist.
 * Was dabei verschwindet, steht je Zeile und Stufe in `hidden` — dieselbe
 * Ueberlegung wie bei `hiddenByFilter`: eine eingeklappte Pendenz ist sonst von
 * einer verlorenen nicht zu unterscheiden.
 */
export function buildBoard({
  ideen, laneOrder, filterChapterId = '', showErledigt = true, showVerworfen = true, query = '',
  collapsedLanes = [], collapsedChapters = [], columnSort = {},
}) {
  const q = (query || '').trim().toLowerCase();
  const chapterFilter = filterChapterId === '' || filterChapterId == null ? null : Number(filterChapterId);

  const laneByKey = new Map((laneOrder || []).map(l => [l.key, l]));
  const chapterLanes = new Map((laneOrder || []).filter(l => l.kind === 'chapter').map(l => [l.id, l]));
  // Der Kapitel-Filter erfasst den TEILBAUM: „Kapitel 3" zeigt auch die Ideen
  // seiner Unterkapitel und deren Abschnitte.
  const inFilter = (cid) => cid != null && chapterChain(cid, chapterLanes).some(l => l.id === chapterFilter);
  const buckets = new Map();   // laneKey → { lane, columns }
  let total = 0;
  let hiddenByFilter = 0;

  const ensure = (key, lane) => {
    if (!buckets.has(key)) {
      const columns = {};
      for (const s of IDEE_STATUSES) columns[s] = [];
      buckets.set(key, { lane, columns, count: 0 });
    }
    return buckets.get(key);
  };

  for (const idee of (ideen || [])) {
    total++;
    const status = ideeStatus(idee);
    // Kapitel-Filter misst die Bahn, nicht den Anker: eine Seiten-Idee gehoert
    // zum Kapitel IHRER Seite (`lane_chapter_id` vom Server), sonst faende der
    // Filter „Kapitel 3" nur die Ideen, die direkt am Kapitel haengen.
    const laneChapterId = idee.lane_chapter_id ?? idee.chapter_id ?? null;
    if (chapterFilter != null && laneChapterId !== chapterFilter && !inFilter(laneChapterId)) { hiddenByFilter++; continue; }
    if (!showErledigt && status === 'erledigt') { hiddenByFilter++; continue; }
    if (!showVerworfen && status === 'verworfen') { hiddenByFilter++; continue; }
    if (!matchesQuery(idee, q)) { hiddenByFilter++; continue; }

    const key = ideeLaneKey(idee);
    const lane = laneByKey.get(key) || {
      key: LANE_UNKNOWN, kind: 'unknown', id: 0, label: '',
      chapterId: laneChapterId, chapterLabel: idee.lane_chapter_name || '', depth: 1,
    };
    const bucket = ensure(lane.key, lane);
    bucket.columns[status].push(idee);
    bucket.count++;
  }

  // `visible` misst den FILTER, nicht die Klappung — es wird darum hier gezaehlt,
  // bevor gefaltet wird. Sonst zaehlte die Filterleiste das Einklappen als
  // Ausblenden und behauptete, der Filter verstecke etwas, das er nicht meint.
  let visible = 0;
  const cmps = {};
  for (const s of IDEE_STATUSES) {
    const { by, dir } = columnSortOf(columnSort, s);
    cmps[s] = compareIdeen(by, dir);
  }
  for (const b of buckets.values()) {
    visible += b.count;
    for (const s of IDEE_STATUSES) b.columns[s].sort(cmps[s]);
  }

  // Kapitel-Kette je Bahn, von aussen nach innen (Vorfahren zuerst).
  const chainOf = (lane) => chapterChain(lane.kind === 'chapter' ? lane.parentId : lane.chapterId, chapterLanes).map(l => l.key).reverse();

  // Erster Durchgang: welche Kapitel tragen irgendwo darunter Ideen, und wie
  // viele belegte Abschnitts-Bahnen haengen in ihrem Teilbaum? Eine Kapitelzeile
  // bleibt auch ohne eigene Ideen stehen, sobald ihr Teilbaum welche traegt: sie
  // ist die Gruppen-Ueberschrift und der Griff, an dem das Kapitel zuklappt.
  // Ohne sie waere genau das Kapitel nicht klappbar, dessen Pendenzen alle auf
  // Abschnitten haengen — also fast jedes. Das gilt ueber jede Tiefe: ein
  // Oberkapitel, dessen Ideen nur in Unterkapiteln stehen, ordnet diese trotzdem.
  const occupied = new Set();
  const childLanes = new Map();
  for (const lane of (laneOrder || [])) {
    const bucket = buckets.get(lane.key);
    if (!bucket) continue;
    const chain = chainOf(lane);
    for (const k of chain) occupied.add(k);
    if (lane.kind === 'chapter') occupied.add(lane.key);
    if (lane.kind === 'page') for (const k of chain) childLanes.set(k, (childLanes.get(k) || 0) + 1);
  }

  const rows = [];
  const rowByKey = new Map();
  const foldedLanes = new Set(collapsedLanes || []);
  const foldedChapters = new Set(collapsedChapters || []);

  // Zweiter Durchgang: Bahnen in Baum-Reihenfolge, die Sammelbahn zuletzt. Ist
  // ein Vorfahr gefaltet, zaehlt die Bahn in die Zeile des AEUSSERSTEN
  // gefalteten Vorfahren — der steht als einziger noch da.
  for (const lane of (laneOrder || [])) {
    const bucket = buckets.get(lane.key);
    // Nur belegte Bahnen erscheinen — ein Board mit einer leeren Zeile je
    // Abschnitt des Buches waere unlesbar.
    if (lane.kind === 'chapter' ? !occupied.has(lane.key) : !bucket) continue;
    const hostKey = chainOf(lane).find(k => foldedChapters.has(k));
    const host = hostKey ? rowByKey.get(hostKey) : null;
    if (host) {
      if (bucket) {
        for (const s of IDEE_STATUSES) host.folded[s] += bucket.columns[s].length;
        host.foldedCount += bucket.count;
      }
      continue;
    }
    const row = newRow(lane, bucket, foldedLanes.has(lane.key));
    if (lane.kind === 'chapter') {
      row.childCollapsed = foldedChapters.has(lane.key);
      row.childLanes = childLanes.get(lane.key) || 0;
      rowByKey.set(lane.key, row);
    }
    rows.push(row);
  }
  const unknown = buckets.get(LANE_UNKNOWN);
  if (unknown) rows.push(newRow(unknown.lane, unknown, foldedLanes.has(LANE_UNKNOWN)));

  for (const row of rows) {
    for (const s of IDEE_STATUSES) {
      row.hidden[s] = (row.collapsed ? row.columns[s].length : 0) + row.folded[s];
    }
  }

  return { lanes: rows, total, visible, hiddenByFilter };
}

// Eine Board-Zeile. `folded`/`hidden` sind immer gesetzt (auch als Nullen),
// damit das Template sie ohne Existenz-Pruefung lesen kann.
function newRow(lane, bucket, collapsed) {
  const columns = {};
  const folded = {};
  const hidden = {};
  for (const s of IDEE_STATUSES) { columns[s] = bucket ? bucket.columns[s] : []; folded[s] = 0; hidden[s] = 0; }
  return {
    lane,
    columns,
    count: bucket ? bucket.count : 0,
    collapsed: !!collapsed,   // eigene Karten eingeklappt
    childCollapsed: false,    // Teilbaum (Unterkapitel + Abschnitte) in diese Zeile gefaltet
    childLanes: 0,            // Zahl der belegten Abschnitts-Bahnen im Teilbaum
    folded,                   // gefaltete Ideen je Stufe
    foldedCount: 0,
    hidden,                   // je Stufe: gefaltet + eigene eingeklappte
  };
}

/**
 * Kapitel-Optionen der Filterleiste: nur Kapitel, deren Teilbaum Ideen traegt —
 * und zwar unabhaengig von Status- und Textfilter, sonst verschwaende die eigene
 * Auswahl unter der Hand, sobald man `verworfen` ausblendet.
 */
export function chapterFilterOptions(ideen, laneOrder) {
  // Ein Oberkapitel ist waehlbar, sobald sein Teilbaum Ideen traegt — der
  // Filter erfasst den Teilbaum (buildBoard).
  const chapterLanes = new Map((laneOrder || []).filter(l => l.kind === 'chapter').map(l => [l.id, l]));
  const withIdeen = new Set();
  for (const idee of (ideen || [])) {
    const cid = idee.lane_chapter_id ?? idee.chapter_id ?? null;
    if (cid == null) continue;
    withIdeen.add(cid);
    for (const l of chapterChain(cid, chapterLanes)) withIdeen.add(l.id);
  }
  const seen = new Set();
  const out = [];
  for (const lane of (laneOrder || [])) {
    if (lane.kind !== 'chapter') continue;
    if (!withIdeen.has(lane.id) || seen.has(lane.id)) continue;
    seen.add(lane.id);
    out.push({ value: String(lane.id), label: lane.label });
  }
  return out;
}

/** Zahl der Ideen je Status ueber den GESAMTEN Bestand (Spaltenkopf-Zaehler). */
export function statusTotals(ideen) {
  const out = {};
  for (const s of IDEE_STATUSES) out[s] = 0;
  for (const idee of (ideen || [])) out[ideeStatus(idee)]++;
  return out;
}

/**
 * Die Spalten des Boards: die aktiven Stufen des Buches (`stages`) — plus jede
 * ABGESCHALTETE Stufe, in der noch Ideen stehen. Abschalten heisst „nicht mehr
 * anbieten", nicht „ausblenden": eine Pendenz in `in_arbeit` verschwaende sonst
 * still, sobald das Buch die Stufe abschaltet. Die Spalte geht, wenn sie leer
 * ist. Reihenfolge immer die kanonische aus IDEE_STATUSES.
 *
 * Gezaehlt wird ueber den GESAMTEN Bestand, nicht ueber die gefilterte Sicht —
 * sonst verschwaende die Spalte samt ihren Karten, sobald der Filter sie leert.
 */
export function boardColumns(stages, ideen) {
  const active = new Set(stages || IDEE_STATUSES);
  const occupied = new Set((ideen || []).map(ideeStatus));
  return IDEE_STATUSES.filter(s => active.has(s) || occupied.has(s));
}
