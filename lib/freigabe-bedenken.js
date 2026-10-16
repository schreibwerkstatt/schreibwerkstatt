'use strict';
// Freigabe-Bedenken: was gegen die Stufe «freigegeben» eines Beitrags spricht.
//
// Zwei Messungen, die es ohnehin gibt, an der Stelle zusammengeführt, an der sie
// gebraucht werden — beim Freigeben:
//
//   1. das Struktur-Urteil (`page_structure_checks`): «verfehlt» oder
//      «lückenhaft» heisst, die Form der Textsorte trägt nicht.
//   2. belegte O-Töne ohne Autorisierung: der Beitrag zitiert eine Interview-
//      Quelle, deren `oton_auth` blockiert (ausstehend/abgelehnt).
//
// **Bedenken sind ein Hinweis, kein Gate.** Die Freigabe ist eine redaktionelle
// Entscheidung; der Server setzt die Stufe trotzdem und sagt nur, worüber
// entschieden wurde. Ein Verbot zwänge zu einem Workaround (Stufe überspringen,
// Quelle umetikettieren), der die Information vernichtet.
//
// Ein ungeprüfter Beitrag trägt KEIN Struktur-Bedenken: unbekannt ist nicht
// schlecht, und eine Warnung bei jedem ungeprüften Text wäre Rauschen, das die
// echte übertönt. Ebenso zählt ein Befund nur, wenn er zur JETZT geltenden
// Textsorte gehört — dieselbe Regel wie in der Struktur-Karte (ein Urteil gegen
// einen anderen Soll-Katalog sagt über den Beitrag nichts mehr).

const { listStructureChecks, getStructureCheck, effectiveTextsorte } = require('../db/textsorte');
const { getBookSettings } = require('../db/schema');
const { listBlockingOtonCitations } = require('../db/sources');
const { URTEIL_RANK } = require('./struktur-summary');

function _strukturBedenken(check) {
  const u = check?.gesamturteil;
  if (!u || URTEIL_RANK[u] == null || URTEIL_RANK[u] >= URTEIL_RANK.traegt) return null;
  return { urteil: u, geprueft_am: check.created_at || null };
}

function _merge(out, pageId, patch) {
  const k = String(pageId);
  out[k] = { struktur: null, otone: [], ...(out[k] || {}), ...patch };
}

/**
 * Bedenken je Abschnitt eines Buchs.
 * @param {number} bookId
 * @param {number[]|null} pageIds  nur diese Abschnitte (null = ganzes Buch)
 * @returns {Record<string, {struktur: {urteil, geprueft_am}|null,
 *           otone: Array<{source_id, title, oton_auth, count}>}>}
 *          nur Abschnitte mit mindestens einem Bedenken
 */
function bedenkenForPages(bookId, pageIds = null) {
  const only = pageIds ? new Set(pageIds.map(String)) : null;
  const out = {};

  const checks = only && only.size === 1
    ? [getStructureCheck([...only][0])].filter(Boolean)
    : listStructureChecks(bookId);
  const settings = checks.length ? getBookSettings(bookId, null) : null;
  for (const c of checks) {
    if (only && !only.has(String(c.page_id))) continue;
    if (c.textsorte !== effectiveTextsorte(c.page_id, settings)) continue;
    const s = _strukturBedenken(c);
    if (s) _merge(out, c.page_id, { struktur: s });
  }

  const cites = only && only.size === 1
    ? listBlockingOtonCitations(bookId, [...only][0])
    : listBlockingOtonCitations(bookId);
  for (const r of cites) {
    const k = String(r.page_id);
    if (only && !only.has(k)) continue;
    const cur = out[k]?.otone || [];
    _merge(out, k, {
      otone: [...cur, { source_id: r.source_id, title: r.title || '', oton_auth: r.oton_auth, count: r.count }],
    });
  }
  return out;
}

/** Bedenken eines einzelnen Abschnitts oder null. */
function bedenkenForPage(bookId, pageId) {
  return bedenkenForPages(bookId, [pageId])[String(pageId)] || null;
}

module.exports = { bedenkenForPages, bedenkenForPage };
