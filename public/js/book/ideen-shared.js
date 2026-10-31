// Geteilte Konstanten der Ideen — von der Ideen-Karte (Seite/Kapitel) UND dem
// Ideen-Board benutzt, damit die beiden Oberflaechen nicht zwei Vorstellungen
// derselben Achse pflegen.
//
// Spiegel der Server-SSoT lib/ideen-status.js. Der Vertrag (gleiche Keys,
// gleiche Reihenfolge) ist durch tests/unit/ideen-status.test.mjs gegated. Ein
// Status-Key ist eine Persistenz-Konstante (Spaltenwert + CHECK + i18n-Key
// `ideen.status.<key>`): ergaenzen ja, umbenennen nein.

export const IDEE_STATUSES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

// Hoechstlaenge des Ideentexts — Spiegel von MAX_LEN in routes/ideen.js. Vorab
// geprueft, damit die Karte „zu lang" sagt statt eines allgemeinen Speicherfehlers.
export const IDEE_MAX_LEN = 4000;

// Die Stufen, die eine Pendenz noch OFFEN halten. Sie entscheiden ueber die
// Sidebar-Plakette und die Zaehler — `verworfen` gehoert nicht dazu.
export const IDEE_OPEN_STATUSES = ['offen', 'in_arbeit'];

// Pro Buch schaltbare Stufen (`book_settings.ideen_stages`): `offen` und
// `erledigt` sind immer da, die uebrigen schaltet das Buch zu.
export const IDEE_FIXED_STATUSES = ['offen', 'erledigt'];
export const IDEE_OPTIONAL_STATUSES = IDEE_STATUSES.filter(s => !IDEE_FIXED_STATUSES.includes(s));

// Aktive Stufen in kanonischer Reihenfolge — Spiegel von
// lib/ideen-status.js#normalizeIdeeStages. NULL = nie eingestellt = alle.
export function normalizeIdeeStages(v) {
  if (v == null) return [...IDEE_STATUSES];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const wanted = new Set(list.map(s => String(s).trim()));
  return IDEE_STATUSES.filter(s => IDEE_FIXED_STATUSES.includes(s) || wanted.has(s));
}

// Verknuepfungs-Ziele einer Idee (`idea_links.target_kind`), Reihenfolge =
// Anzeige in Picker und Chips.
export const IDEA_LINK_KINDS = ['research', 'beat', 'thread', 'motif', 'draft'];

// Unbekannter/leerer Wert zaehlt als erste Stufe — dieselbe Regel wie
// `itemStatus` im Recherche-Board: eine Idee faellt nie aus dem Board, nur weil
// ihr Status nicht in der Liste steht.
export function ideeStatus(idee) {
  const s = idee?.status;
  return IDEE_STATUSES.includes(s) ? s : IDEE_STATUSES[0];
}

export function isOpenIdee(idee) {
  return IDEE_OPEN_STATUSES.includes(ideeStatus(idee));
}

// Ab so vielen offenen Ideen mit Ort (Abschnitt oder Kapitel) lohnt der
// Erledigt-Check des Ideen-Chats — Schwelle für den Feature-Tipp im Board und
// den Vorschlag in der Übersicht («Nächste Schritte»).
export const IDEEN_CHECK_MIN = 5;

export function openAnchoredIdeenCount(ideen) {
  let n = 0;
  for (const i of ideen || []) if (isOpenIdee(i) && (i.page_id != null || i.chapter_id != null)) n++;
  return n;
}

// Bahn der Ideen ohne Anker: sie gehoeren nur dem Buch, bis der Autor sie
// einer Seite oder einem Kapitel zuordnet.
export const LANE_BOOK = 'book:0';

// Der Anker einer Idee als Bahn-Schluessel. Hoechstens EIN Anker ist gesetzt
// (CHECK im Schema); keiner heisst Buch-Idee.
export function ideeLaneKey(idee) {
  if (!idee) return '';
  if (idee.page_id != null) return `page:${idee.page_id}`;
  if (idee.chapter_id != null) return `chapter:${idee.chapter_id}`;
  return LANE_BOOK;
}

/**
 * Einabschnitts-Kapitel aus dem Navigationsbaum (`$store.nav.tree`): Kapitel
 * mit genau einem Abschnitt und ohne Unterkapitel. Kapitel und Abschnitt sind
 * dort EIN Ort, kanonischer Anker ist der Abschnitt (docs/ideen-board.md
 * „Einabschnitts-Kapitel"; Server-Pendant lib/idee-anchor.js#canonicalIdeeAnchor).
 * Liefert Map chapterId → pageId.
 */
export function soleChapterPages(tree) {
  const hasChildren = new Set();
  for (const node of (tree || [])) if (node.parent_id != null) hasChildren.add(node.parent_id);
  const out = new Map();
  for (const node of (tree || [])) {
    if (node.solo || hasChildren.has(node.id) || (node.pages || []).length !== 1) continue;
    out.set(node.id, node.pages[0].id);
  }
  return out;
}

/**
 * Ort einer Ideen-Karte: { pageId, chapterId } — beide gesetzt, wenn Abschnitt
 * und Kapitel derselbe Ort sind (Einabschnitts-Kapitel), sonst nur der eine.
 * `scope` = { kind: 'page'|'chapter', id }.
 */
export function ideenPlace(tree, scope) {
  if (!scope?.id) return null;
  const sole = soleChapterPages(tree);
  if (scope.kind === 'chapter') {
    const pageId = sole.get(scope.id);
    return { pageId: pageId ?? null, chapterId: scope.id };
  }
  for (const [chapterId, pageId] of sole) if (pageId === scope.id) return { pageId, chapterId };
  return { pageId: scope.id, chapterId: null };
}

export function isBookIdee(idee) {
  return !!idee && idee.page_id == null && idee.chapter_id == null;
}

/**
 * Manuelle Reihenfolge: `sort_order` aufsteigend, bei Gleichstand die neueste
 * oben. 0 heisst „nie einsortiert" — eine neue Idee steht damit oben in ihrer
 * Zelle; ein Drag im Board schreibt die Zelle als 1..n
 * (db/ideen.js#reorderIdeen). Geteilt, weil die Ideen-Karte neben dem Editor
 * dieselbe Ordnung zeigt wie das Board.
 */
export function compareIdeeManual(a, b) {
  const so = (a.sort_order || 0) - (b.sort_order || 0);
  if (so) return so;
  const ca = a.created_at || '';
  const cb = b.created_at || '';
  if (ca !== cb) return ca < cb ? 1 : -1;
  return (b.id || 0) - (a.id || 0);
}
