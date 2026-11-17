'use strict';
// User-Custom-Dictionary CRUD fuer LanguageTool-Spellcheck.
//
// GET    /dictionary           -> alle Eintraege des Users
// POST   /dictionary           -> { word, bookId?, lang? } anlegen
// DELETE /dictionary           -> { word, bookId?, lang? } loeschen
//
// Cache-Invalidierung beim Add/Remove ist im DB-Modul user-dictionary.js
// versteckt — Frontend bekommt frische LT-Resultate ab dem naechsten Check.

const express = require('express');
const logger = require('../logger');
const dict = require('../db/user-dictionary');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');

const router = express.Router();
const WORD_MAX = 80;

router.get('/', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  res.json({ entries: dict.listForUser(userEmail) });
});

router.post('/', express.json({ limit: '4kb' }), (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const body = req.body || {};
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  if (!word || word.length > WORD_MAX) {
    return res.status(400).json({ error_code: 'INVALID_WORD', params: { max: WORD_MAX } });
  }
  const bookId = toIntId(body.bookId) || 0;
  let lang = typeof body.lang === 'string' && body.lang.trim() ? body.lang.trim() : '*';
  if (lang === 'auto') lang = '*';
  if (bookId && !guardBook(req, res, bookId, 'viewer')) return;
  try {
    dict.add(userEmail, { word, bookId, lang });
    logger.child({ job: 'lt-dict', user: userEmail, book: bookId || '-' }).info(`add "${word}" lang=${lang}`);
    res.json({ ok: true });
  } catch (err) {
    logger.warn(`dictionary add failed: ${err.message}`);
    res.status(500).json({ error_code: 'ADD_FAILED' });
  }
});

router.delete('/', express.json({ limit: '4kb' }), (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const body = req.body || {};
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  if (!word) return res.status(400).json({ error_code: 'WORT_REQUIRED' });
  const bookId = toIntId(body.bookId) || 0;
  const lang = typeof body.lang === 'string' && body.lang.trim() ? body.lang.trim() : '*';
  if (bookId && !guardBook(req, res, bookId, 'viewer')) return;
  const changes = dict.remove(userEmail, { word, bookId, lang });
  logger.child({ job: 'lt-dict', user: userEmail, book: bookId || '-' }).info(`remove "${word}" lang=${lang} removed=${changes}`);
  res.json({ ok: true, removed: changes });
});

module.exports = router;
