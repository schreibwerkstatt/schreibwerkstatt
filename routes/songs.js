'use strict';
const express = require('express');
const { listSongsForBook } = require('../db/schema');
const { aclParamGuard, sessionEmail } = require('../lib/acl');

// Musikbibliothek (Buch-Soundtrack) — rein lesend. Geschrieben wird sie
// ausschliesslich von der Komplettanalyse (routes/jobs/komplett, Phase 3 Songs).
const router = express.Router();
router.param('book_id', aclParamGuard('editor'));

router.get('/:book_id', (req, res) => {
  res.json(listSongsForBook(req.bookId, sessionEmail(req)));
});

module.exports = router;
