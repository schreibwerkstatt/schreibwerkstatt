'use strict';
const express = require('express');
const { listWorldFacts, worldFactsScanState, getBookSettings } = require('../db/schema');
const { aclParamGuard, sessionEmail } = require('../lib/acl');

const router = express.Router();
// Param-Guard: prüft Buch-ID, Login und Rolle, setzt req.bookId und den `book`-Log-Slot.
router.param('book_id', aclParamGuard('editor'));

// Welt-Fakten eines Buchs laden (read-only; Schreibpfad ist die Komplettanalyse).
// `scanned` unterscheidet „nie analysiert" von „analysiert, nichts gefunden" — ohne
// das fordert die leere Karte eine Komplettanalyse, die langst gelaufen ist.
// `widerlegt` je Fakt + `factcheck.bookOptIn` tragen die Faktencheck-Sektion der Karte.
router.get('/:book_id', (req, res) => {
  const bookId = req.bookId;
  const userEmail = sessionEmail(req);

  const fakten = listWorldFacts(bookId, userEmail, { withRefuted: true });
  const { scanned } = worldFactsScanState(bookId, userEmail);
  const updated_at = fakten.reduce((max, f) => (f.updated_at > max ? f.updated_at : max), '');
  const settings = getBookSettings(bookId, userEmail) || {};

  res.json({
    fakten: fakten.map(({ updated_at: _u, ...f }) => f),
    scanned,
    updated_at: updated_at || null,
    factcheck: { bookOptIn: !!settings.weltfakten_real_pruefen },
  });
});

module.exports = router;
