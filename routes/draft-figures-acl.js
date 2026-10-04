'use strict';
// Zugriffs-Vorspann der Figuren-Werkstatt. Ein Draft gehoert EINEM User
// (`draft_figures.user_email`) — anders als das Recherche-Board, das buchweit
// geteilt ist (routes/research-acl.js). Zwei Achsen, beide Pflicht:
//   - Buch-ACL ueber `guardBook` (Default `viewer`): ein Draft lebt in einem
//     Buch und seine Lesewege tragen Buchinhalt (Fundstellen-Snippets, Seiten-
//     und Kapitelnamen, Quell-Figur). Wem das Buch entzogen wurde, der liest
//     darueber nichts mehr. KI-Laeufe verlangen `editor` (Kosten auf dem Buch).
//   - Besitz-Achse (`user_email`): fremde Drafts desselben Buchs bleiben zu.
//
// Eigenes Modul, weil zwei Router denselben Vorspann brauchen (CRUD + Jobs).
//
// Beide Helfer ANTWORTEN SELBST und liefern dann `null`; der Aufrufer prueft nur
// auf null und kehrt zurueck (Muster `scopedItem` in routes/research-acl.js).
//
// Login prueft ausschliesslich `guardBook` (401 NOT_LOGGED_IN) — kein eigener
// 401 daneben, sonst gaebe es zwei error_codes fuer dieselbe Lage. Ein
// unbekanntes Objekt antwortet 404 vor der Login-Pruefung; anonyme Requests
// faengt ohnehin der globale Auth-Guard (lib/auth-guard.js) vorher ab.

const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { getDraftFigure, getWerkstattRun } = require('../db/draft-figures');

/** Werkstatt-Draft samt Buch-ACL + Besitz-Pruefung. `rawId` kommt aus Param
 *  ODER Body. Liefert den Draft oder null. */
function scopedDraft(req, res, rawId, { minBookRole = 'viewer' } = {}) {
  const id = toIntId(rawId);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const draft = getDraftFigure(id);
  if (!draft) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  if (!guardBook(req, res, draft.book_id, minBookRole)) return null;
  if (draft.user_email !== sessionEmail(req)) { res.status(403).json({ error_code: 'FORBIDDEN' }); return null; }
  return draft;
}

/** Einzelner KI-Lauf aus `:run_id` samt Buch-ACL + Besitz-Pruefung. Liefert den
 *  Lauf oder null. Trennt bewusst 404 von 403: ein owner-skopiertes DELETE
 *  alleine kann „gibt es nicht" und „gehoert dir nicht" nicht unterscheiden. */
function scopedRun(req, res, rawId, { minBookRole = 'viewer' } = {}) {
  const id = toIntId(rawId);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const run = getWerkstattRun(id);
  if (!run) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  if (!guardBook(req, res, run.book_id, minBookRole)) return null;
  if (run.user_email !== sessionEmail(req)) { res.status(403).json({ error_code: 'FORBIDDEN' }); return null; }
  return run;
}

module.exports = { scopedDraft, scopedRun };
