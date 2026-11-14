'use strict';
// Offene KI-Vorschläge lesen und verwerfen (db/ai-proposals.js). Mount `/ai-proposals`.
//
//   GET    /ai-proposals/autorenprofil                → { proposal: null | { payload, created_at } }
//   DELETE /ai-proposals/autorenprofil                → { ok: true }
//   GET    /ai-proposals/stilprofil?book_id=N         (Editor-Rolle im Buch)
//   DELETE /ai-proposals/stilprofil?book_id=N
//
// Geschrieben wird ein Vorschlag nur vom Job (autorenprofil, stilprofil); erledigt
// wird er durch «Übernehmen» (Autorenprofil: PUT /me/author-profile mit `run`
// löscht ihn selbst) oder «Verwerfen» (DELETE hier). Beim Stilprofil setzt
// «Übernehmen» nur den Feldwert im Formular — die Karte verwirft den Vorschlag
// dabei hier, gespeichert wird der Text über den normalen Speichern-Knopf.

const express = require('express');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const { getProposal, deleteProposal } = require('../db/ai-proposals');

const router = express.Router();

/** Kontext der Anfrage oder null (dann ist die Antwort schon raus). */
function _scope(req, res) {
  const kind = req.params.kind;
  if (kind === 'autorenprofil') {
    const email = sessionEmail(req);
    if (!email) { res.status(401).json({ error_code: 'NOT_LOGGED_IN' }); return null; }
    return { kind, email, bookId: null };
  }
  if (kind === 'stilprofil') {
    const bookId = toIntId(req.query.book_id);
    if (!bookId) { res.status(400).json({ error_code: 'BOOKID_REQ' }); return null; }
    setContext({ book: bookId });
    if (!guardBook(req, res, bookId, 'editor')) return null;
    return { kind, email: sessionEmail(req), bookId };
  }
  res.status(404).json({ error_code: 'NOT_FOUND' });
  return null;
}

router.get('/:kind', (req, res) => {
  const s = _scope(req, res);
  if (!s) return;
  res.json({ proposal: getProposal(s.kind, s.email, s.bookId) });
});

router.delete('/:kind', (req, res) => {
  const s = _scope(req, res);
  if (!s) return;
  deleteProposal(s.kind, s.email, s.bookId);
  res.json({ ok: true });
});

module.exports = router;
