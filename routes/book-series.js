'use strict';
// Buchreihen (docs/buchreihen.md): Reihe als Verbund, Daten bleiben je Buch.
// Alle Routen gehen vom aktuellen Buch (`:book_id`) aus. Rechte leiten sich aus den
// Bänden ab — die Reihe hat kein Besitzer-Konto:
// - Lesen: viewer auf dem aktuellen Buch.
// - Reihe anlegen/verlassen: owner des aktuellen Buchs.
// - Beitreten, Umbenennen, Umordnen: owner des aktuellen Buchs UND jedes Bands der
//   Reihe — die Reihe bestimmt Titel und Bandnummer im EPUB jedes Bands.
// - Aus Vorband übernehmen: editor auf dem aktuellen Buch, viewer auf dem Vorband.
const express = require('express');
const { aclParamGuard, guardBook, sessionEmail } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const { listBookIdsForUser } = require('../db/book-access');
const series = require('../db/book-series');
const { listCarryoverCandidates, copyFromPrequel } = require('../db/series-carryover');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const router = express.Router();
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json();

function sendSeriesError(res, e) {
  if (!(e instanceof series.SeriesError)) throw e;
  return res.status(e.status).json({ error_code: e.code });
}

// owner auf jedem Band der Reihe. guardBook antwortet selbst beim ersten Fehlschlag.
function _guardAllMembers(req, res, seriesId) {
  for (const m of series.listSeriesMembers(seriesId)) {
    if (!guardBook(req, res, m.book_id, 'owner')) return false;
  }
  setContext({ book: req.bookId });
  return true;
}

function _state(req) {
  const own = listBookIdsForUser(sessionEmail(req)).filter(r => r.role === 'owner').map(r => r.book_id);
  const current = series.getSeriesForBook(req.bookId);
  return {
    series: current,
    // Reihen eigener Bücher, denen dieses Buch beitreten kann.
    joinable: current ? [] : series.listSeriesForBooks(own),
    prequels: series.listPrequels(req.bookId),
  };
}

router.get('/:book_id', (req, res) => {
  res.json(_state(req));
});

// Neue Reihe mit diesem Buch als Band 1. Body: { name }
router.post('/:book_id', jsonBody, (req, res) => {
  if (!guardBook(req, res, req.bookId, 'owner')) return;
  try {
    series.createSeriesWithBook(req.bookId, req.body?.name);
    res.json(_state(req));
  } catch (e) { sendSeriesError(res, e); }
});

// Bestehender Reihe als letzter Band beitreten. Body: { series_id }
router.post('/:book_id/join', jsonBody, (req, res) => {
  const seriesId = parseInt(req.body?.series_id, 10);
  if (!seriesId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, req.bookId, 'owner')) return;
  if (!_guardAllMembers(req, res, seriesId)) return;
  try {
    series.joinSeries(req.bookId, seriesId);
    res.json(_state(req));
  } catch (e) { sendSeriesError(res, e); }
});

router.post('/:book_id/leave', (req, res) => {
  if (!guardBook(req, res, req.bookId, 'owner')) return;
  series.leaveSeries(req.bookId);
  res.json(_state(req));
});

// Reihe umbenennen. Body: { name }
router.patch('/:book_id', jsonBody, (req, res) => {
  const seriesId = series.seriesIdOfBook(req.bookId);
  if (seriesId == null) return res.status(404).json({ error_code: 'NOT_IN_SERIES' });
  if (!_guardAllMembers(req, res, seriesId)) return;
  try {
    series.renameSeries(seriesId, req.body?.name);
    res.json(_state(req));
  } catch (e) { sendSeriesError(res, e); }
});

// Bände umordnen. Body: { book_ids: [...] } — genau die Bände der Reihe.
router.put('/:book_id/order', jsonBody, (req, res) => {
  const seriesId = series.seriesIdOfBook(req.bookId);
  if (seriesId == null) return res.status(404).json({ error_code: 'NOT_IN_SERIES' });
  if (!_guardAllMembers(req, res, seriesId)) return;
  try {
    series.reorderSeries(seriesId, req.body?.book_ids);
    res.json(_state(req));
  } catch (e) { sendSeriesError(res, e); }
});

// Vorband als Quelle prüfen: gleiche Reihe, kleinere Bandnummer, viewer-Recht.
function _guardPrequel(req, res, raw) {
  const sourceId = parseInt(raw, 10);
  if (!sourceId) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  if (!series.listPrequels(req.bookId).some(m => m.book_id === sourceId)) {
    res.status(404).json({ error_code: 'NOT_A_PREQUEL' });
    return null;
  }
  if (!guardBook(req, res, sourceId, 'viewer')) return null;
  setContext({ book: req.bookId });
  return sourceId;
}

// Übernehmbare Figuren, Orte und Welt-Fakten eines Vorbands (eigener Katalog).
router.get('/:book_id/carryover/:source_id', (req, res) => {
  if (!guardBook(req, res, req.bookId, 'editor')) return;
  const sourceId = _guardPrequel(req, res, req.params.source_id);
  if (sourceId == null) return;
  res.json(listCarryoverCandidates(sourceId, req.bookId, sessionEmail(req)));
});

// Übernehmen. Body: { source_book_id, figuren: [id], orte: [id], fakten: [id] }
router.post('/:book_id/carryover', jsonBody, (req, res) => {
  if (!guardBook(req, res, req.bookId, 'editor')) return;
  const sourceId = _guardPrequel(req, res, req.body?.source_book_id);
  if (sourceId == null) return;
  const r = copyFromPrequel(sourceId, req.bookId, sessionEmail(req), req.body || {});
  for (const id of r.figureIds) searchIndex.upsertFigure(id);
  for (const id of r.locationIds) searchIndex.upsertLocation(id);
  try { require('./jobs/embed-index').enqueueEmbedIndexJob(req.bookId); }
  catch (e) { logger.warn(`Vorband-Übernahme: Embedding-Index nicht angestossen (Buch ${req.bookId}): ${e.message}`); }
  logger.info(`Vorband-Übernahme aus Buch ${sourceId}: ${r.figuren} Figuren, ${r.orte} Orte, ${r.fakten} Fakten, ${r.beziehungen} Beziehungen.`);
  res.json({ ok: true, figuren: r.figuren, orte: r.orte, fakten: r.fakten, beziehungen: r.beziehungen });
});

module.exports = router;
