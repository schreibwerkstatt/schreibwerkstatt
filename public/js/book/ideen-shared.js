// Geteilte Konstanten der Ideen — von der Ideen-Karte (Seite/Kapitel) UND dem
// Ideen-Board benutzt, damit die beiden Oberflaechen nicht zwei Vorstellungen
// derselben Achse pflegen.
//
// Spiegel der Server-SSoT lib/ideen-status.js. Der Vertrag (gleiche Keys,
// gleiche Reihenfolge) ist durch tests/unit/ideen-status.test.mjs gegated. Ein
// Status-Key ist eine Persistenz-Konstante (Spaltenwert + CHECK + i18n-Key
// `ideen.status.<key>`): ergaenzen ja, umbenennen nein.

export const IDEE_STATUSES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

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

export function isBookIdee(idee) {
  return !!idee && idee.page_id == null && idee.chapter_id == null;
}
