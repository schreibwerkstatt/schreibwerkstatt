'use strict';
// Server-SSoT der Ideen-Achse: Bearbeitungsstufen + Verknuepfungs-Ziele.
//
// Eine Idee ist in diesem Haus zweierlei: eine moegliche Fortsetzung UND eine
// Pendenz an einer Seite bzw. einem Kapitel („das muss ich hier noch machen").
// Fuer beides reicht ein Ja/Nein nicht: zwischen „noch nichts getan" und
// „fertig" liegt die Arbeit daran, und neben „fertig" steht das bewusst
// Fallengelassene.
//
// `verworfen` ist eine STUFE, kein Loeschen — genau wie bei `research_items`
// (lib/research-validate.js#RESEARCH_STATUSES). Eine geloeschte Idee verschweigt,
// dass man sie hatte und gegen sie entschieden hat; genau das will man beim
// naechsten Durchgang nicht noch einmal denken muessen. Darum blendet der
// Board-Filter sie aus, statt sie aus der Welt zu nehmen.
//
// Reihenfolge = Spaltenfolge im Ideen-Board. Ein Status-Key ist eine
// Persistenz-Konstante (Spaltenwert + CHECK + i18n-Key `ideen.status.<key>`):
// ergaenzen ja, umbenennen nein. Frontend-Spiegel: public/js/book/ideen-shared.js,
// Drift gegated in tests/unit/ideen-status.test.mjs.
const IDEE_STATUSES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

// Die Stufen, die eine Pendenz noch OFFEN halten. Sie und nicht `status !==
// 'erledigt'` beantworten jede Zaehlfrage im Haus: den Sidebar-Indikator, die
// `/ideen/counts`-Map und den Ideen-Block im Seiten-Chat. `verworfen` gehoert
// dort nicht hinein — eine fallengelassene Idee ist keine offene Aufgabe und
// darf weder eine Plakette setzen noch dem Modell als Absicht vorgelegt werden.
const IDEE_OPEN_STATUSES = ['offen', 'in_arbeit'];

// Pro Buch schaltbare Stufen (`book_settings.ideen_stages`). `offen` und
// `erledigt` sind IMMER da: ohne Anfang gibt es keine Pendenz, ohne Ende kein
// Abhaken — ein Board aus nur einer der beiden waere keine Pendenzenliste mehr.
// `in_arbeit` und `verworfen` sind Feinheiten, die nicht jedes Buch braucht.
// Abschalten heisst nur „nicht mehr anbieten": eine Idee, die schon in einer
// abgeschalteten Stufe steht, behaelt ihren Status und bleibt sichtbar
// (docs/ideen-board.md, „Stufen pro Buch").
const IDEE_FIXED_STATUSES = ['offen', 'erledigt'];
const IDEE_OPTIONAL_STATUSES = IDEE_STATUSES.filter(s => !IDEE_FIXED_STATUSES.includes(s));

// Verknuepfungs-Ziele einer Idee (`idea_links.target_kind`). Alle sind PLANENDE
// Kataloge desselben Buches — eine Pendenz haengt an einem Fundstueck, einem
// Handlungspunkt, einem Motiv, einer Werkstatt-Figur (`draft`) oder einem
// Handlungsstrang (`thread`), nicht an einer Textstelle (ihre Stelle im Buch IST
// ja schon ihr Anker). Reihenfolge = Anzeige in Picker und Chips.
const IDEA_LINK_KINDS = ['research', 'beat', 'thread', 'motif', 'draft'];

function isIdeeStatus(v) {
  return typeof v === 'string' && IDEE_STATUSES.includes(v);
}

// Unbekannter/leerer Wert zaehlt als erste Stufe — dieselbe Regel wie
// `itemStatus` im Recherche-Board: eine Idee darf nicht aus dem Board fallen,
// nur weil ihr Status nicht in der Liste steht.
function normalizeIdeeStatus(v) {
  return isIdeeStatus(v) ? v : IDEE_STATUSES[0];
}

function isOpenIdeeStatus(v) {
  return IDEE_OPEN_STATUSES.includes(normalizeIdeeStatus(v));
}

// Aktive Stufen eines Buches in kanonischer Reihenfolge. Nimmt eine Liste oder
// den gespeicherten Komma-Text; feste Stufen kommen immer dazu, Unbekanntes
// faellt weg. NULL/undefined = nie eingestellt = alle Stufen (Stand vor der
// Einstellung — ein bestehendes Buch sieht sein Board unveraendert).
function normalizeIdeeStages(v) {
  if (v == null) return [...IDEE_STATUSES];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const wanted = new Set(list.map(s => String(s).trim()));
  return IDEE_STATUSES.filter(s => IDEE_FIXED_STATUSES.includes(s) || wanted.has(s));
}

function serializeIdeeStages(v) {
  return normalizeIdeeStages(v).join(',');
}

function isIdeaLinkKind(v) {
  return typeof v === 'string' && IDEA_LINK_KINDS.includes(v);
}

// SQL-Fragment fuer „noch offen" — damit die Zaehlpfade nicht jeder fuer sich
// eine IN-Liste schreiben und beim naechsten Status auseinanderlaufen. `alias`
// ist das Tabellen-Praefix der jeweiligen Abfrage (leer = keins).
function openStatusSql(alias = '') {
  const col = alias ? `${alias}.status` : 'status';
  return `${col} IN (${IDEE_OPEN_STATUSES.map(s => `'${s}'`).join(',')})`;
}
const OPEN_STATUS_SQL = openStatusSql();

module.exports = {
  IDEE_STATUSES,
  IDEE_OPEN_STATUSES,
  IDEE_FIXED_STATUSES,
  IDEE_OPTIONAL_STATUSES,
  IDEA_LINK_KINDS,
  OPEN_STATUS_SQL,
  openStatusSql,
  isIdeeStatus,
  normalizeIdeeStatus,
  isOpenIdeeStatus,
  normalizeIdeeStages,
  serializeIdeeStages,
  isIdeaLinkKind,
};
