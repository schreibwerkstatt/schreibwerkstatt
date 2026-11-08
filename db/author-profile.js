'use strict';
// Gather-Schicht fuer das Autorenprofil (read-time). Sammelt die bereits
// persistierten Kennzahlen der Buecher EINES Besitzers und uebergibt sie an die
// pure Engine lib/author-profile.js. Kein KI-Call, kein Cache — jeder Aufruf
// rechnet frisch und zeigt damit sofort, was der letzte Nacht-Scan geaendert hat
// (gleiches Muster wie db/narrative-report.js).
//
// „Autor" ist hier `books.owner_email` — dieselbe Definition, die der
// Keyness-Referenzkorpus und die Peer-Mediane in db/lexicon.js schon benutzen.
// Ein Buch, an dem man nur als Lektor mitarbeitet, ist nicht das eigene Werk und
// darf das eigene Stilbild nicht verschieben.
//
// Die Buchnamen liefert dieses Modul bewusst NICHT (Content-Store-Regel) — das
// Frontend joint sie ueber `book_id` aus `/content/books`, gleiche Konvention wie
// /me/profile-stats und /me/books.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { computeAuthorProfile, authorProfileBasisSig } = require('../lib/author-profile');
// Prepared Statements sitzen auf migrierten Spalten — Migrationen zuerst.
require('./migrations');

// Buecher des Besitzers in Werk-Reihenfolge (aelteste zuerst). `created_at` ist
// das einzige verfuegbare Ordnungssignal; bei importierten Buechern ist es das
// Import- und nicht das Schreibdatum. Darum reist der Zeitstempel in der Antwort
// mit: die Karte zeigt ihn an, statt eine Chronologie zu behaupten, die der
// Server nicht kennt.
const _stmtBooks = db.prepare(`
  SELECT b.book_id,
         b.created_at,
         COALESCE(bs.exclude_from_stats, 0) AS excluded,
         bs.language
    FROM books b
    LEFT JOIN book_settings bs ON bs.book_id = b.book_id
   WHERE b.owner_email IS NOT NULL
     AND b.owner_email = ?
   ORDER BY b.created_at, b.book_id
`);

function _lexiconRows(ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT book_id, tokens, pages, scanned_at, content_sig,
           mattr, mattr_window, mtld, hapax_ratio, yule_k, heaps_beta, lex_density
      FROM book_lexicon
     WHERE book_id IN (${ph})
  `).all(...ids);
}

// Seiten-Summen je Buch. Summen statt Mittel der Seitenmittelwerte — die
// Begruendung steht in lib/author-profile.js#_bookMetrics.
//
// Die beiden Lesbarkeitsmasse sind pro Seite gerechnet und lassen sich nicht
// summieren; sie werden mit der Wortzahl gewichtet. Die Gewichtssumme zaehlt nur
// Seiten, die den Wert ueberhaupt haben — sonst zoege jede Seite ohne Messwert
// den Durchschnitt gegen null.
function _pageStatRows(ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT ps.book_id,
           COUNT(*)                  AS pages,
           SUM(ps.words)             AS words,
           SUM(ps.chars)             AS chars,
           SUM(ps.sentences)         AS sentences,
           SUM(ps.dialog_chars)      AS dialog_chars,
           SUM(ps.adverb_count)      AS adverb_count,
           SUM(ps.passive_count)     AS passive_count,
           SUM(ps.filler_count)      AS filler_count,
           SUM(ps.lix * ps.words)    AS lix_w,
           SUM(CASE WHEN ps.lix IS NOT NULL THEN COALESCE(ps.words, 0) ELSE 0 END)       AS lix_wsum,
           SUM(ps.flesch_de * ps.words) AS flesch_w,
           SUM(CASE WHEN ps.flesch_de IS NOT NULL THEN COALESCE(ps.words, 0) ELSE 0 END) AS flesch_wsum
      FROM page_stats ps
     WHERE ps.book_id IN (${ph})
     GROUP BY ps.book_id
  `).all(...ids);
}

/**
 * Autorenprofil-Messung eines Users. Immer ein Objekt — ein Konto ohne eigene
 * Buecher bekommt die leere Form mit `counts.total = 0`, keinen Fehler und kein
 * null: die Karte unterscheidet „noch nichts gemessen" von „Fehler beim Laden".
 */
function getAuthorProfile(userEmail) {
  const email = userEmail || null;
  if (!email) return computeAuthorProfile({ books: [], lexicon: [], pageStats: [] });
  const books = _stmtBooks.all(email);
  const ids = books.map(b => b.book_id);
  const measurement = computeAuthorProfile({
    books,
    lexicon: _lexiconRows(ids),
    pageStats: _pageStatRows(ids),
  });
  const profile = getAuthorProfileRow(email);
  const basisSig = authorProfileBasisSig(measurement);
  return {
    ...measurement,
    profile,
    basisSig,
    // „veraltet" heisst: der Text steht noch, aber die Buecher darunter haben
    // sich bewegt. Nicht ausblenden — der Autor soll den alten Text sehen UND
    // wissen, dass er von einem aelteren Stand spricht.
    profileStale: !!profile && !!profile.basis_sig && profile.basis_sig !== basisSig,
  };
}

const _stmtProfile = db.prepare('SELECT * FROM author_profile WHERE user_email = ?');

/** Gespeicherter Profiltext samt Deutung; null, wenn noch keiner existiert. */
function getAuthorProfileRow(userEmail) {
  const row = _stmtProfile.get(userEmail || null);
  if (!row) return null;
  const parse = (v) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };
  return {
    profil_text: row.profil_text || '',
    konstanten: parse(row.konstanten),
    entwicklung: parse(row.entwicklung),
    basis: parse(row.basis_json),
    basis_sig: row.basis_sig || null,
    edited: !!row.edited,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Ergebnis eines KI-Laufs ablegen. Setzt `edited` zurueck auf 0 — der Text
 * stammt jetzt wieder vom Modell. Ob ein von Hand geaenderter Text ueberschrieben
 * werden DARF, entscheidet der Aufrufer vor diesem Call, nicht diese Funktion.
 */
function saveAuthorProfileRun(userEmail, { profilText, konstanten, entwicklung, basis, basisSig }) {
  db.prepare(`
    INSERT INTO author_profile (user_email, profil_text, konstanten, entwicklung, basis_json, basis_sig, edited, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL})
    ON CONFLICT(user_email) DO UPDATE SET
      profil_text = excluded.profil_text,
      konstanten  = excluded.konstanten,
      entwicklung = excluded.entwicklung,
      basis_json  = excluded.basis_json,
      basis_sig   = excluded.basis_sig,
      edited      = 0,
      updated_at  = excluded.updated_at
  `).run(
    userEmail,
    String(profilText || ''),
    JSON.stringify(Array.isArray(konstanten) ? konstanten : []),
    JSON.stringify(Array.isArray(entwicklung) ? entwicklung : []),
    JSON.stringify(Array.isArray(basis) ? basis : []),
    basisSig || null,
  );
}

/**
 * Vom Autor editierter Text. Setzt `edited = 1` — ab hier ist der Text seiner,
 * und ein neuer Lauf fragt, bevor er ihn ersetzt. Die Deutungs-Listen bleiben
 * unberuehrt: sie gehoeren zum Lauf, nicht zum Fliesstext.
 */
function saveAuthorProfileText(userEmail, text) {
  db.prepare(`
    INSERT INTO author_profile (user_email, profil_text, edited, updated_at)
    VALUES (?, ?, 1, ${NOW_ISO_SQL})
    ON CONFLICT(user_email) DO UPDATE SET
      profil_text = excluded.profil_text,
      edited      = 1,
      updated_at  = excluded.updated_at
  `).run(userEmail, String(text || ''));
}

module.exports = { getAuthorProfile, getAuthorProfileRow, saveAuthorProfileRun, saveAuthorProfileText };
