'use strict';
const express = require('express');
const { listWorldFacts, worldFactsScanState, getBookSettings, listFactSuppressions } = require('../db/schema');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const {
  WorldFactEditError, createWorldFact, updateWorldFact, deleteWorldFact, restoreSuppressedFact,
} = require('../db/world-facts-edit');
const logger = require('../logger');
const { factCheckCategories } = require('../lib/factcheck-gate');

const router = express.Router();
// Param-Guard: prüft Buch-ID, Login und Rolle, setzt req.bookId und den `book`-Log-Slot.
router.param('book_id', aclParamGuard('editor'));
const jsonBody = express.json();

function sendEditError(res, e) {
  if (!(e instanceof WorldFactEditError)) throw e;
  return res.status(e.status).json({ error_code: e.code });
}

// Embedding-Index (Kind `fact`) nachziehen; Delta-Lauf, non-fatal.
function _reindex(bookId) {
  try { require('./jobs/embed-index').enqueueEmbedIndexJob(bookId); }
  catch (e) { logger.warn(`Welt-Fakt-Pflege: Embedding-Index nicht angestossen (Buch ${bookId}): ${e.message}`); }
}

// Welt-Fakten eines Buchs laden. Schreibpfade: die Komplettanalyse (Full-Replace) und
// die Pflege unten (setzt manually_edited — die Analyse lässt solche Fakten stehen).
// `scanned` unterscheidet „nie analysiert" von „analysiert, nichts gefunden" — ohne
// das fordert die leere Karte eine Komplettanalyse, die langst gelaufen ist.
// `widerlegt` je Fakt + `factcheck.bookOptIn` tragen die Faktencheck-Sektion der Karte.
router.get('/:book_id', (req, res) => {
  const bookId = req.bookId;
  const userEmail = sessionEmail(req);

  const fakten = listWorldFacts(bookId, userEmail, { withRefuted: true, withChapterIds: true, withManual: true, withVerdicts: true });
  const { scanned } = worldFactsScanState(bookId, userEmail);
  const updated_at = fakten.reduce((max, f) => (f.updated_at > max ? f.updated_at : max), '');
  const settings = getBookSettings(bookId, userEmail) || {};

  res.json({
    fakten: fakten.map(({ updated_at: _u, ...f }) => f),
    // Verworfene Analyse-Aussagen (gelöscht oder ersetzt) — wiederherstellbar.
    ausgeblendet: listFactSuppressions(bookId, userEmail),
    scanned,
    updated_at: updated_at || null,
    // kategorien: welche Fakten der Faktencheck prüft («neu prüfen» nur dort).
    factcheck: { bookOptIn: !!settings.weltfakten_real_pruefen, kategorien: factCheckCategories(settings) },
  });
});

// Fakt anlegen. Body: { fakt, subjekt?, kategorie?, chapter_ids? }
router.post('/:book_id', jsonBody, (req, res) => {
  try {
    const id = createWorldFact(req.bookId, sessionEmail(req), req.body || {});
    _reindex(req.bookId);
    res.json({ ok: true, id });
  } catch (e) { sendEditError(res, e); }
});

// Fakt ändern. Body: Teilmenge von { fakt, subjekt, kategorie, chapter_ids }
router.patch('/:book_id/:id', jsonBody, (req, res) => {
  try {
    updateWorldFact(req.bookId, sessionEmail(req), req.params.id, req.body || {});
    _reindex(req.bookId);
    res.json({ ok: true });
  } catch (e) { sendEditError(res, e); }
});

// Verworfene Analyse-Aussage wieder zulassen (die nächste Analyse darf sie anlegen).
router.delete('/:book_id/suppressions/:id', (req, res) => {
  try {
    restoreSuppressedFact(req.bookId, sessionEmail(req), req.params.id);
    res.json({ ok: true });
  } catch (e) { sendEditError(res, e); }
});

router.delete('/:book_id/:id', (req, res) => {
  try {
    deleteWorldFact(req.bookId, sessionEmail(req), req.params.id);
    _reindex(req.bookId);
    res.json({ ok: true });
  } catch (e) { sendEditError(res, e); }
});

module.exports = router;
