'use strict';
const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const redundancyDb = require('../db/redundancy');

// Redundanz-Radar (docs/redundanz.md): letztes Ergebnis lesen + Paare
// ignorieren. Gerechnet wird ausschliesslich im Job (routes/jobs/redundancy.js);
// hier liegt nur der persistierte Stand des Users. Mindestrolle wie beim Job.
const router = express.Router();
router.param('book_id', aclParamGuard('lektor'));

// Letzter Lauf (oder null) + Zahl der ignorierten Paare.
router.get('/:book_id', (req, res) => {
  const email = sessionEmail(req);
  res.json({
    result: redundancyDb.getLastRun(req.bookId, email),
    dismissedCount: redundancyDb.countDismissals(req.bookId, email),
  });
});

// Paar ignorieren: { kind: 'page'|'figure', a_id, b_id }.
router.post('/:book_id/dismissals', express.json(), (req, res) => {
  const { kind, a_id, b_id } = req.body || {};
  const email = sessionEmail(req);
  if (!redundancyDb.addDismissal(req.bookId, email, kind, a_id, b_id)) {
    return res.status(400).json({ error_code: 'INVALID_PAIR' });
  }
  res.json({ ok: true, dismissedCount: redundancyDb.countDismissals(req.bookId, email) });
});

// Ein Paar wieder anzeigen.
router.delete('/:book_id/dismissals/:kind/:a_id/:b_id', (req, res) => {
  const email = sessionEmail(req);
  redundancyDb.removeDismissal(req.bookId, email, req.params.kind, req.params.a_id, req.params.b_id);
  res.json({ ok: true, dismissedCount: redundancyDb.countDismissals(req.bookId, email) });
});

// Alle ignorierten Paare des Buchs wieder anzeigen.
router.delete('/:book_id/dismissals', (req, res) => {
  const email = sessionEmail(req);
  redundancyDb.clearDismissals(req.bookId, email);
  res.json({ ok: true, dismissedCount: 0 });
});

module.exports = router;
