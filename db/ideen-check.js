'use strict';
// Datenschicht des automatischen Erledigt-Checks (routes/jobs/ideen-auto-check.js,
// docs/ideen-board.md «Erledigt-Check nach dem Speichern»).
//
//   idee_check_hints     — «diese Pendenz scheint eingelöst», mit geprüftem
//                          Zitat. Ein Hinweis je Idee; der User hakt ab oder
//                          verwirft ihn. Gelesen wird er über db/ideen.js
//                          (SELECT_ROW), damit jede Ausgabeform ihn trägt.
//   idee_check_baselines — Klartext je (Abschnitt, User) beim letzten Check —
//                          das Mass für «grössere Änderung».
//   app_users.ideen_auto_check — persönlicher Schalter.
//
// Ideen sind user-privat: jede Lesung trägt user_email (Regel aus db/ideen.js).

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { openStatusSql } = require('../lib/ideen-status');

/** Offene Ideen, die direkt an diesem Abschnitt hängen (Gegenstand des Checks). */
function listOpenPageIdeen(pageId, userEmail) {
  return db.prepare(`
    SELECT id, content, status FROM ideen
     WHERE page_id = ? AND user_email = ? AND ${openStatusSql()}
     ORDER BY created_at, id
  `).all(pageId, userEmail);
}

/** Gibt es überhaupt offene Abschnitts-Ideen? Billiger Vorab-Check beim Speichern. */
function hasOpenPageIdeen(pageId, userEmail) {
  return !!db.prepare(`SELECT 1 FROM ideen WHERE page_id = ? AND user_email = ? AND ${openStatusSql()} LIMIT 1`)
    .get(pageId, userEmail);
}

function getBaseline(pageId, userEmail) {
  return db.prepare('SELECT text FROM idee_check_baselines WHERE page_id = ? AND user_email = ?')
    .get(pageId, userEmail)?.text ?? null;
}

function setBaseline(pageId, userEmail, text) {
  db.prepare(`
    INSERT INTO idee_check_baselines (page_id, user_email, text, checked_at)
    VALUES (?, ?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(page_id, user_email) DO UPDATE SET text = excluded.text, checked_at = excluded.checked_at
  `).run(pageId, userEmail, String(text || ''));
}

/** Hinweis setzen (ersetzt einen älteren derselben Idee). Nur für eigene Ideen. */
function setHint(ideeId, userEmail, { pageId, beleg, begruendung = null }) {
  const own = db.prepare('SELECT 1 FROM ideen WHERE id = ? AND user_email = ?').get(ideeId, userEmail);
  if (!own) return false;
  db.prepare(`
    INSERT INTO idee_check_hints (idee_id, page_id, beleg, begruendung, created_at)
    VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(idee_id) DO UPDATE SET page_id = excluded.page_id, beleg = excluded.beleg,
      begruendung = excluded.begruendung, created_at = excluded.created_at
  `).run(ideeId, pageId, beleg, begruendung);
  return true;
}

/** Hinweis entfernen (verworfen, oder die Idee wurde abgeschlossen). */
function clearHint(ideeId, userEmail) {
  return db.prepare(`
    DELETE FROM idee_check_hints
     WHERE idee_id = ? AND idee_id IN (SELECT id FROM ideen WHERE user_email = ?)
  `).run(ideeId, userEmail).changes;
}

function isAutoCheckEnabled(userEmail) {
  if (!userEmail) return false;
  const row = db.prepare('SELECT ideen_auto_check FROM app_users WHERE email = ?').get(userEmail);
  return row ? row.ideen_auto_check !== 0 : false;
}

function setAutoCheck(userEmail, on) {
  return db.prepare('UPDATE app_users SET ideen_auto_check = ? WHERE email = ?').run(on ? 1 : 0, userEmail).changes;
}

module.exports = {
  listOpenPageIdeen, hasOpenPageIdeen, getBaseline, setBaseline,
  setHint, clearHint, isAutoCheckEnabled, setAutoCheck,
};
