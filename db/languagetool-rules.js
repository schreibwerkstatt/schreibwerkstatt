'use strict';
// Abgeschaltete LanguageTool-Regeln pro User.
//
//   book_id = NULL -> in allen Buechern aus
//   book_id > 0    -> nur in diesem Buch aus (FK CASCADE bei Buchloeschung)
//
// Gefiltert wird im Proxy beim Ausliefern (lib/languagetool-filter.js), nicht
// per `disabledRules` an LanguageTool: der Absatz-Cache haelt ungefilterte
// Treffer und bleibt damit fuer alle User gueltig.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtList = db.prepare(
  `SELECT rule_id, rule_label, book_id, created_at FROM languagetool_disabled_rules
   WHERE user_email = ?
   ORDER BY created_at DESC`
);
const _stmtListForCheck = db.prepare(
  `SELECT rule_id FROM languagetool_disabled_rules
   WHERE user_email = ? AND (book_id IS NULL OR book_id = ?)`
);
const _stmtInsert = db.prepare(
  `INSERT OR IGNORE INTO languagetool_disabled_rules (user_email, book_id, rule_id, rule_label, created_at)
   VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _stmtDelete = db.prepare(
  `DELETE FROM languagetool_disabled_rules
   WHERE user_email = ? AND book_id IS ? AND rule_id = ?`
);

function listForUser(userEmail) {
  if (!userEmail) return [];
  return _stmtList.all(userEmail);
}

function getCheckSet(userEmail, bookId) {
  if (!userEmail) return new Set();
  return new Set(_stmtListForCheck.all(userEmail, bookId || null).map(r => r.rule_id));
}

function add(userEmail, { ruleId, bookId = 0, label = null }) {
  if (!userEmail || !ruleId) return false;
  _stmtInsert.run(userEmail, bookId || null, ruleId, label || null);
  return true;
}

function remove(userEmail, { ruleId, bookId = 0 }) {
  if (!userEmail || !ruleId) return 0;
  return _stmtDelete.run(userEmail, bookId || null, ruleId).changes;
}

module.exports = { listForUser, getCheckSet, add, remove };
