'use strict';
// Geburt einer Figur aus den vorhandenen Daten — Steckbrief-Feld `geburtstag`,
// sicher datiertes Geburts-Ereignis (Zeitstrahl bzw. figure_events), Alters-Index
// (figure_ages.geburtsjahr). Kein KI-Call, keine Schätzung.
//
// EIGENES MODUL, weil zwei Konsumenten dieselbe Vorrangregel brauchen: das
// Buch-Chat-Werkzeug `get_figure_age` und der Figuren-Block der Chats
// (routes/jobs/shared/queries.js#getFiguren). Liefen sie auseinander, nennte der
// Abschnitts-Chat ein anderes Geburtsjahr als der Buch-Chat.

const { getBirthEvent } = require('../db/book-chat/timeline');
const { parseDatum } = require('./datum-parse');

/** Kandidaten in Vorrang-Reihenfolge: Steckbrief (gehört dem Autor) › Geburts-Ereignis
 *  › Alters-Index. `fig` = { id (figures.id), geburtstag }, `indexYear` = Geburtsjahr
 *  aus dem Alters-Index oder null. Je Kandidat { quelle, y, m, d[, label] }. */
function birthCandidates(bookId, userEmail, fig, indexYear = null) {
  const out = [];
  if (fig?.geburtstag) {
    const p = parseDatum(fig.geburtstag);
    if (Number.isInteger(p.year)) out.push({ quelle: 'steckbrief', y: p.year, m: p.month || null, d: p.day || null, label: fig.geburtstag });
  }
  const evt = fig?.id != null ? getBirthEvent(bookId, userEmail, fig.id) : null;
  if (evt?.y != null) out.push({ quelle: 'geburts_ereignis', y: evt.y, m: evt.m || null, d: evt.d || null });
  if (indexYear != null) out.push({ quelle: 'alters_index', y: indexYear, m: null, d: null });
  return out;
}

/** Erster Kandidat als massgebliche Geburt; `widerspruch` listet alle Quellen, sobald
 *  sie verschiedene Jahre nennen — ein Befund, kein Rauschen. */
function resolveBirth(candidates) {
  const birth = candidates[0] || null;
  const years = new Set(candidates.map(c => c.y));
  return {
    birth,
    widerspruch: years.size > 1 ? candidates.map(c => ({ quelle: c.quelle, jahr: c.y })) : null,
  };
}

module.exports = { birthCandidates, resolveBirth };
