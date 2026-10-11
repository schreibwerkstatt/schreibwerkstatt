'use strict';
// User-Custom-Dictionary fuer LanguageTool-Spellcheck.
//
// Der LT-Proxy filtert beim Ausliefern (lib/languagetool-filter.js) — der
// Absatz-Cache haelt ungefilterte Treffer, darum braucht ein Add/Remove keine
// Cache-Invalidierung.
//
// Granularitaet:
//   - book_id = NULL  -> User-globaler Eintrag (alle Buecher)
//   - book_id > 0     -> nur fuer das jeweilige Buch (FK CASCADE bei Buchloeschung)
//   - lang = '*'      -> sprachuebergreifend
//   - lang = 'de-CH'  -> nur fuer diese Locale
//
// Case-insensitive Lookup: Speicherung in Original-Case — fuer Display und weil
// die Grossschreibung ein Nomen markiert (Genitiv, lib/dictionary-forms.js).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { buildDictionary } = require('../lib/dictionary-forms');

const _stmtList = db.prepare(
  `SELECT word, book_id, lang, created_at FROM user_dictionary
   WHERE user_email = ?
   ORDER BY created_at DESC`
);
const _stmtListForCheck = db.prepare(
  `SELECT word FROM user_dictionary
   WHERE user_email = ?
     AND (book_id IS NULL OR book_id = ?)
     AND (lang = '*' OR lang = ?)`
);
const _stmtInsert = db.prepare(
  `INSERT OR IGNORE INTO user_dictionary (user_email, book_id, word, lang, created_at)
   VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _stmtDelete = db.prepare(
  `DELETE FROM user_dictionary
   WHERE user_email = ? AND book_id IS ? AND word = ? AND lang = ?`
);

function listForUser(userEmail) {
  if (!userEmail) return [];
  return _stmtList.all(userEmail);
}

/** Abgleich-Struktur { words, nouns } (lib/dictionary-forms.js#buildDictionary). */
function getCheckDict(userEmail, bookId, lang) {
  if (!userEmail) return buildDictionary([]);
  const rows = _stmtListForCheck.all(userEmail, bookId || null, lang || 'auto');
  return buildDictionary(rows.map(r => r.word));
}

function add(userEmail, { word, bookId = 0, lang = '*' }) {
  if (!userEmail || !word || !word.trim()) return false;
  const w = word.trim();
  _stmtInsert.run(userEmail, bookId || null, w, lang || '*');
  return true;
}

function remove(userEmail, { word, bookId = 0, lang = '*' }) {
  if (!userEmail || !word) return 0;
  return _stmtDelete.run(userEmail, bookId || null, word, lang || '*').changes;
}

module.exports = { listForUser, getCheckDict, add, remove };
