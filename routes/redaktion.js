'use strict';
// Bearbeitungsstand pro Abschnitt (docs/bearbeitungsstand.md). Journalistische
// Buecher fuehren die Redaktions-Kette (roh → … → freigegeben), alle anderen die
// Manuskript-Kette (rohfassung → … → final); welche gilt, sagt der Buchtyp.
//
// Lesen ab `viewer`: wer den Text sehen darf, soll erkennen, ob er fertig ist —
// gerade ein Gegenleser braucht das. Setzen ab `editor`: eine Stufe
// weiterzuschalten ist eine Entscheidung, keine Ansicht.

const express = require('express');
const { aclParamGuard, guardBook, sessionEmail } = require('../lib/acl');
const {
  listBookStatus, setPageStatus, setPagesStatus, statusCounts, statusHistory,
  statusChain, isValidRedaktionStatus,
} = require('../db/redaktion');
const { pageBookGuard } = require('../lib/page-guard');
const { getBookSettings } = require('../db/schema');
const { isJournalisticBook } = require('../lib/buchtyp');
const { resolveChapterBookId } = require('../lib/content-ownership');
const { toIntId } = require('../lib/validate');
const contentStore = require('../lib/content-store');
const { bookParamHandler } = require('../lib/log-context');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

function _journalistic(req, bookId, settings) {
  return isJournalisticBook(settings || getBookSettings(bookId, sessionEmail(req)));
}

/** Stufe aus dem Body: null (entfernen), gueltige Stufe der Kette, oder undefined
 *  (= ungueltig, Antwort 400 ist raus). */
function _readStatus(req, res, chain) {
  const raw = req.body?.status;
  const status = raw == null || raw === '' ? null : String(raw);
  if (status !== null && !isValidRedaktionStatus(status, chain)) {
    res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'status' } });
    return undefined;
  }
  return status;
}

/** Kette des Buchs + alle gesetzten Stufen + Verteilung. `enabled` bleibt fuer
 *  die Organizer-Zeile im Vertrag — der Stand gilt fuer jeden Buchtyp. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const journalistic = _journalistic(req, bookId);
  const chain = statusChain(journalistic);
  res.json({
    enabled: true,
    journalistic,
    stufen: chain,
    pages: listBookStatus(bookId),
    counts: statusCounts(bookId, chain),
  });
});

/** Verteilung je Tag mit Stufenwechsel (Zeitreihe der Buchstatistik). */
router.get('/:book_id/history', aclParamGuard('viewer'), (req, res) => {
  const chain = statusChain(_journalistic(req, req.bookId));
  res.json({ stufen: chain, daily: statusHistory(req.bookId, chain) });
});

/** Stufe einer Seite setzen (`status: null` entfernt sie). `note` nur, wenn
 *  mitgeschickt — sonst bleibt die bestehende Notiz stehen. */
router.put('/page/:page_id', jsonBody, (req, res) => {
  const g = pageBookGuard(req, res, { minRole: 'editor' });
  if (!g) return;
  const { pageId, bookId, settings } = g;
  const chain = statusChain(_journalistic(req, bookId, settings));
  const status = _readStatus(req, res, chain);
  if (status === undefined) return;
  const row = setPageStatus(pageId, bookId, {
    status,
    note: req.body?.note,
    userEmail: sessionEmail(req),
    chain,
  });
  res.json({ ok: true, page_id: pageId, entry: row, counts: statusCounts(bookId, chain) });
});

/** Dieselbe Stufe fuer alle Abschnitte eines Kapitels, inkl. Unterkapitel. Das
 *  Buch kommt aus dem Kapitel, nie vom Client. */
router.put('/chapter/:chapter_id', jsonBody, async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = resolveChapterBookId(chapterId);
  if (!bookId) return res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const chain = statusChain(_journalistic(req, bookId));
  const status = _readStatus(req, res, chain);
  if (status === undefined) return;
  const outline = await contentStore.bookOutline(bookId);
  const pageIds = contentStore.chapterPages(outline, chapterId).map(n => n.id);
  const entries = setPagesStatus(pageIds, bookId, { status, userEmail: sessionEmail(req), chain });
  res.json({ ok: true, chapter_id: chapterId, entries, counts: statusCounts(bookId, chain) });
});

module.exports = router;
