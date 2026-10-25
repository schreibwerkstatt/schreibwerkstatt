'use strict';
const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const redundancyDb = require('../db/redundancy');
const embed = require('../lib/embed');
const { isRunStale } = require('../lib/redundancy-staleness');

// Redundanz-Radar (docs/redundanz.md): letztes Ergebnis lesen + Paare
// ignorieren. Gerechnet wird ausschliesslich im Job (routes/jobs/redundancy.js);
// hier liegt nur der persistierte Stand des Users. Mindestrolle wie beim Job.
const router = express.Router();
router.param('book_id', aclParamGuard('lektor'));

// Letzter Lauf (oder null) + Zahl der ignorierten Paare.
// `changedSinceRun`: Text, Figuren oder Modell haben sich seit dem Lauf geändert
// → die Karte bittet um eine neue Prüfung (lib/redundancy-staleness.js).
router.get('/:book_id', async (req, res) => {
  const email = sessionEmail(req);
  const result = redundancyDb.getLastRun(req.bookId, email);
  const model = embed.isEnabled() ? embed.getConfig().model : null;
  res.json({
    result,
    changedSinceRun: await isRunStale(req.bookId, email, result, model),
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
