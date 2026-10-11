'use strict';
// Bearbeitungsstand pro Abschnitt (docs/bearbeitungsstand.md). Zwei Ketten, eine
// je Buchart: journalistische Buecher durchlaufen die Redaktion (roh →
// gegengelesen → schlussredigiert → freigegeben), alle anderen die
// Ueberarbeitung (rohfassung → ueberarbeitet → redigiert → final).
//
// Der Status ist eine Aussage ueber den PROZESS („darf das raus?", „ist das
// fertig?"), nicht ueber den Text. Deshalb liegt er neben `pages` (eigene
// Tabelle) und nicht in den Fassungen (`book_snapshots`) — die bleiben das
// Textarchiv.
//
// DREI DINGE, DIE DIESE DATEI ZUR SSoT MACHEN:
//
// 1. Die Ketten sind die Reihenfolge der Stufen (CJS-Spiegel von
//    public/js/redaktion/status.js). Sie sind geordnet, nicht bloss Mengen. Neue
//    Stufe ⇒ dort und hier einsortieren, dazu den CHECK-Constraint der Tabelle
//    und die i18n-Keys `redaktion.status.<key>`. Gegated durch
//    tests/unit/redaktion-status.test.mjs.
//
// 2. `stale` — ob der Text seit dem Setzen des Status angefasst wurde. Die Frage
//    entscheidet sich am Vergleich `pages.updated_at > content_updated_at`, und
//    zwar an genau EINER Stelle (`_mapRow`). Eine Freigabe auf einem Text, der
//    sich seither geaendert hat, ist keine Freigabe mehr — wer das an zwei
//    Stellen berechnet, bekommt zwei Antworten.
//
// 3. Jeder Schreibweg protokolliert in `page_editorial_status_events` — die
//    Zeitreihe der Buchstatistik (`statusHistory`) rechnet nur daraus.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const { localIsoDate, currentTz } = require('../lib/local-date');

/** Ketten in Prozessreihenfolge. Deckungsgleich mit public/js/redaktion/status.js
 *  (CJS-Spiegel, weil die Schreibpfade synchron validieren muessen); der
 *  CHECK-Constraint von `page_editorial_status.status` kennt die Vereinigung. */
const REDAKTION_STATUS = ['roh', 'gegengelesen', 'schlussredigiert', 'freigegeben'];
const MANUSKRIPT_STATUS = ['rohfassung', 'ueberarbeitet', 'redigiert', 'final'];
const ALL_STATUS = [...REDAKTION_STATUS, ...MANUSKRIPT_STATUS];

/** Die Stufe, ab der ein Beitrag bzw. Abschnitt als fertig gilt. Einziger
 *  Konsument der Literale — Kennzahlen und Badges fragen hier. */
const REDAKTION_STATUS_DONE = 'freigegeben';
const MANUSKRIPT_STATUS_DONE = 'final';

/** Kette des Buchs: journalistisch → Redaktion, sonst → Manuskript. */
function statusChain(journalistic) {
  return journalistic ? REDAKTION_STATUS : MANUSKRIPT_STATUS;
}

/** Gehoert `v` zur Kette? Ohne Kette: zu irgendeiner. */
function isValidRedaktionStatus(v, chain = ALL_STATUS) {
  return typeof v === 'string' && chain.includes(v);
}

/** Position in ihrer Kette (0-basiert), -1 fuer unbekannt/ungesetzt. */
function statusRank(v) {
  const r = REDAKTION_STATUS.indexOf(v);
  return r >= 0 ? r : MANUSKRIPT_STATUS.indexOf(v);
}

const _stmtGet = db.prepare(`
  SELECT s.page_id, s.status, s.note, s.content_updated_at, s.updated_by, s.updated_at,
         p.updated_at AS page_updated_at
    FROM page_editorial_status s
    JOIN pages p ON p.page_id = s.page_id
   WHERE s.page_id = ?
`);

// Buch aus `pages`, nicht aus `s.book_id`: ein in ein anderes Buch verschobener
// Abschnitt nimmt seinen Stand mit, und die Zeile soll im neuen Buch erscheinen.
const _stmtListForBook = db.prepare(`
  SELECT s.page_id, s.status, s.note, s.content_updated_at, s.updated_by, s.updated_at,
         p.updated_at AS page_updated_at
    FROM page_editorial_status s
    JOIN pages p ON p.page_id = s.page_id
   WHERE p.book_id = ?
`);

// `note` bleibt stehen, wenn der Aufrufer keine mitgibt (`set_note` 0 = behalten,
// 1 = mit dem uebergebenen Wert ersetzen, auch durch NULL).
const _stmtSet = db.prepare(`
  INSERT INTO page_editorial_status
         (page_id, book_id, status, note, content_updated_at, updated_by, updated_at)
  VALUES (@page_id, @book_id, @status, @note, @anchor, @by, ${NOW_ISO_SQL})
  ON CONFLICT(page_id) DO UPDATE SET
    book_id            = excluded.book_id,
    status             = excluded.status,
    note               = CASE WHEN @set_note = 1 THEN excluded.note ELSE page_editorial_status.note END,
    content_updated_at = excluded.content_updated_at,
    updated_by         = excluded.updated_by,
    updated_at         = excluded.updated_at
`);

const _stmtClear = db.prepare('DELETE FROM page_editorial_status WHERE page_id = ?');

const _stmtPageUpdatedAt = db.prepare('SELECT updated_at FROM pages WHERE page_id = ?');

const _stmtCurrent = db.prepare('SELECT status FROM page_editorial_status WHERE page_id = ?');

const _stmtEvent = db.prepare(`
  INSERT INTO page_editorial_status_events (page_id, status, at) VALUES (?, ?, ${NOW_ISO_SQL})
`);

/**
 * Ist der Status ueberholt? Wahr, wenn die Seite nach dem Setzen des Status
 * gespeichert wurde. Zeitstempel sind ISO+Z (Harte Regel „DB-Timestamps"), damit
 * ist der lexikografische Vergleich chronologisch korrekt.
 *
 * Ohne Anker (`content_updated_at IS NULL`, z. B. Status aus einem Import) gilt
 * der Status als aktuell — lieber keine Warnung als eine falsche.
 */
function _isStale(row) {
  if (!row?.content_updated_at || !row?.page_updated_at) return false;
  return String(row.page_updated_at) > String(row.content_updated_at);
}

function _mapRow(r) {
  if (!r) return null;
  return {
    page_id: r.page_id,
    status: r.status,
    note: r.note || null,
    updated_by: r.updated_by || null,
    updated_at: r.updated_at,
    content_updated_at: r.content_updated_at || null,
    stale: _isStale(r),
  };
}

/** Status einer Seite oder null (= keine Stufe gesetzt). */
function getPageStatus(pageId) {
  return _mapRow(_stmtGet.get(parseInt(pageId)));
}

/** Alle Status eines Buchs als { [page_id]: {...} }. Map statt Liste, weil jeder
 *  Konsument (Organizer-Zeile, Baum, Kennzahl) per page_id nachschlaegt. */
function listBookStatus(bookId) {
  const out = {};
  for (const r of _stmtListForBook.all(parseInt(bookId))) {
    out[String(r.page_id)] = _mapRow(r);
  }
  return out;
}

function _invalid(status) {
  const err = new Error(`Ungueltiger Bearbeitungsstand: ${status}`);
  err.code = 'INVALID_STATUS';
  return err;
}

/**
 * Setzt (oder mit `status = null` entfernt) die Stufe einer Seite.
 *
 * Der Frische-Anker wird hier aus `pages.updated_at` gezogen und nicht vom
 * Aufrufer entgegengenommen: sonst koennte ein Client einen Status auf einen
 * Textstand stempeln, den es nie gab, und die Stale-Anzeige waere wertlos.
 *
 * `note: undefined` behaelt eine bestehende Notiz, `null`/'' leert sie.
 * `chain` beschraenkt die erlaubten Stufen auf die Kette des Buchs.
 * Ein Ereignis in `page_editorial_status_events` entsteht nur bei einem
 * WECHSEL — erneutes Setzen derselben Stufe frischt den Anker auf, ist fuer
 * die Zeitreihe aber kein Ereignis.
 */
const setPageStatus = db.transaction((pageId, bookId, {
  status, note = undefined, userEmail = null, chain = ALL_STATUS,
}) => {
  const pid = parseInt(pageId);
  const prev = _stmtCurrent.get(pid)?.status || null;
  if (status == null || status === '') {
    _stmtClear.run(pid);
    if (prev) _stmtEvent.run(pid, null);
    return null;
  }
  if (!isValidRedaktionStatus(status, chain)) throw _invalid(status);
  const anchor = _stmtPageUpdatedAt.get(pid)?.updated_at || null;
  const cleanNote = note == null ? null : String(note).trim().slice(0, 500) || null;
  _stmtSet.run({
    page_id: pid, book_id: parseInt(bookId), status, note: cleanNote, anchor,
    by: userEmail, set_note: note === undefined ? 0 : 1,
  });
  if (prev !== status) _stmtEvent.run(pid, status);
  return getPageStatus(pid);
});

/**
 * Dieselbe Stufe fuer mehrere Seiten eines Buchs in einer Transaktion (Kapitel
 * auf einen Schlag). Notizen bleiben stehen. Liefert die Map der neuen Eintraege
 * (null fuer entfernte).
 */
const setPagesStatus = db.transaction((pageIds, bookId, { status, userEmail = null, chain = ALL_STATUS }) => {
  if (status != null && status !== '' && !isValidRedaktionStatus(status, chain)) throw _invalid(status);
  const out = {};
  for (const id of pageIds) {
    out[String(id)] = setPageStatus(id, bookId, { status, userEmail, chain });
  }
  return out;
});

/**
 * Verteilung ueber die Stufen fuer ein Buch: { <stufe>: n, …, ohne: n }.
 * `ohne` sind die Seiten des Buchs ohne jede Stufe — ohne die Zahl liest sich
 * eine Verteilung als „alles erfasst", obwohl die Haelfte nie angefasst wurde.
 * Stufen ausserhalb der Kette (Buchtyp gewechselt) zaehlen als `ohne`.
 */
function statusCounts(bookId, chain = ALL_STATUS) {
  const bid = parseInt(bookId);
  const counts = Object.fromEntries(chain.map(s => [s, 0]));
  for (const r of db.prepare(`
    SELECT s.status, COUNT(*) AS n
      FROM page_editorial_status s JOIN pages p ON p.page_id = s.page_id
     WHERE p.book_id = ? GROUP BY s.status
  `).all(bid)) {
    if (r.status in counts) counts[r.status] = r.n;
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(bid)?.n || 0;
  const set = chain.reduce((a, s) => a + counts[s], 0);
  counts.ohne = Math.max(0, total - set);
  return counts;
}

/**
 * Abschnitte des Buchs auf der Fertig-Stufe der Kette, deren Text seit dem
 * Setzen unveraendert ist (`stale` false). Konsument: Serien-Lektorat, das
 * genau diese ueberspringt — ein seither bearbeiteter finaler Abschnitt wird
 * wieder geprueft.
 */
function doneUnchangedPageIds(bookId, chain) {
  const done = chain[chain.length - 1];
  const out = new Set();
  for (const e of Object.values(listBookStatus(bookId))) {
    if (e.status === done && !e.stale) out.add(e.page_id);
  }
  return out;
}

/**
 * Zeitreihe der Verteilung: je Kalendertag (App-Zeitzone) mit mindestens einem
 * Stufenwechsel die Verteilung NACH dem letzten Wechsel des Tages —
 * `[{ date, <stufe>: n, … }]`, aufsteigend. Nur Abschnitte, die heute im Buch
 * liegen (Buch aus `pages`, siehe `_stmtListForBook`); geloeschte fallen per
 * CASCADE samt Verlauf heraus. Stufen ausserhalb der Kette werden nicht gezaehlt.
 */
function statusHistory(bookId, chain = ALL_STATUS, tz = currentTz()) {
  const rows = db.prepare(`
    SELECT e.page_id, e.status, e.at
      FROM page_editorial_status_events e JOIN pages p ON p.page_id = e.page_id
     WHERE p.book_id = ?
     ORDER BY e.at ASC, e.id ASC
  `).all(parseInt(bookId));
  const state = new Map();
  const out = [];
  const snapshot = (date) => {
    const counts = Object.fromEntries(chain.map(s => [s, 0]));
    for (const st of state.values()) if (st in counts) counts[st]++;
    return { date, ...counts };
  };
  let day = null;
  for (const r of rows) {
    const d = localIsoDate(new Date(r.at), tz);
    if (day && d !== day) out.push(snapshot(day));
    day = d;
    if (r.status) state.set(r.page_id, r.status); else state.delete(r.page_id);
  }
  if (day) out.push(snapshot(day));
  return out;
}

module.exports = {
  REDAKTION_STATUS, MANUSKRIPT_STATUS, ALL_STATUS,
  REDAKTION_STATUS_DONE, MANUSKRIPT_STATUS_DONE,
  statusChain, isValidRedaktionStatus, statusRank,
  getPageStatus, listBookStatus, setPageStatus, setPagesStatus, statusCounts, statusHistory,
  doneUnchangedPageIds,
};
