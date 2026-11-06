'use strict';
// Gebündelte Buch-Übersicht: GET /overview/:book_id liefert in EINER Antwort alle
// Tile-Daten, die public/js/book-overview/load.js sonst über ~15 Einzel-Requests
// holte. Kein eigener Rechenweg: jeder Teil ruft denselben Builder wie seine
// Einzel-Route, die für die Fachkarten bestehen bleibt — Antwortform je Teil ist
// darum identisch zur Einzel-Route.
//
// Rechte je Teil: der Router verlangt nur `viewer`; Teile mit höherer
// Mindestrolle (Katalog, Plot, Ideen: editor) prüft der Handler selbst und
// meldet `{ forbidden: true }` statt der Daten — wie das 403 der Einzel-Route,
// das die Übersicht als «Tile aus, kein Fehler» liest. Ein Fehler in einem Teil
// kippt nicht die ganze Antwort: `{ error: true }`, geloggt, die anderen Teile
// kommen durch.
//
// Antwort: `{ parts: { <key>: { data } | { forbidden: true } | { error: true } } }`.
// Nicht enthalten: Snapshot-Verlauf + Buch-Einstellungen (teilt die Übersicht mit
// dem Header-Donut, app-view/bookscope.js#loadDailyProgress) und die
// Rückblick-Coverage ausserhalb von Tagebüchern (dort ohne Tile).
//
// `?skip=figuren,orte,szenen`: Teile, deren Daten der Client schon im
// catalog-Store hat, werden nicht gebaut.
const express = require('express');
const { listFigurenWithDetails, listSongsForBook, listBookReviewHistory, getBookSettings } = require('../db/schema');
const { listLocationsForBook } = require('../db/locations-read');
const { listScenesForBook } = require('../db/scene-catalog');
const { lektoratCoverage } = require('../db/page-checks');
const { loadHeatmapRows } = require('../db/lektorat-heatmap');
const { buildFehlerHeatmap } = require('../lib/fehler-heatmap');
const timeTracking = require('../db/time-tracking');
const chatSessions = require('../db/chat-sessions');
const { hasMinRole } = require('../db/book-access');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { rueckblickCoverage } = require('./history/reviews');
const { listRecentPages } = require('./usage');
const { buildPlotBoard } = require('./plot');
const { buildMotifGraph } = require('./motifs');
const { buildLexiconSummary } = require('./lexicon');
const { buildIdeenBoard } = require('./ideen');
const logger = require('../logger');

const router = express.Router();
router.param('book_id', aclParamGuard('viewer'));
router.param('book_id', bookParamHandler);

// Recent-Kachel: mehr als angezeigt (RECENT_SHOW_LIMIT in book-overview/load.js) —
// gelöschte/verschobene Abschnitte fallen clientseitig heraus.
const RECENT_LIMIT = 8;

// Teile in Antwort-Reihenfolge. `minRole` = Mindestrolle der Einzel-Route;
// `when` blendet einen Teil für ein Buch aus (fehlt dann in `parts`).
const PARTS = [
  { key: 'coverage', minRole: 'viewer', load: ({ bookId }) => lektoratCoverage(bookId) },
  { key: 'heat', minRole: 'viewer', load: ({ bookId }) => buildFehlerHeatmap({ ...loadHeatmapRows(bookId), mode: 'open' }) },
  { key: 'review', minRole: 'viewer', load: ({ bookId, email }) => listBookReviewHistory(bookId, email) },
  { key: 'recent', minRole: 'viewer', load: ({ bookId, email }) => listRecentPages(email, bookId, RECENT_LIMIT) },
  { key: 'figuren', minRole: 'editor', load: ({ bookId, email }) => listFigurenWithDetails(bookId, email) },
  { key: 'szenen', minRole: 'editor', load: ({ bookId, email }) => listScenesForBook(bookId, email) },
  { key: 'orte', minRole: 'editor', load: ({ bookId, email }) => listLocationsForBook(bookId, email) },
  { key: 'songs', minRole: 'editor', load: ({ bookId, email }) => listSongsForBook(bookId, email) },
  { key: 'lektorat', minRole: 'viewer', load: ({ bookId, email }) => timeTracking.readSummary('lektorat', { userEmail: email, bookId }) },
  { key: 'plot', minRole: 'editor', load: ({ bookId, email }) => buildPlotBoard(bookId, email) },
  { key: 'motifs', minRole: 'viewer', load: ({ bookId, email }) => buildMotifGraph(bookId, email) },
  { key: 'lexicon', minRole: 'viewer', load: ({ bookId, role }) => buildLexiconSummary(bookId, role === 'owner') },
  { key: 'ideen', minRole: 'editor', load: ({ bookId, email }) => buildIdeenBoard(bookId, email) },
  // «Nächste Schritte» fragt nur, OB es Buch-Chat-Gespräche gibt.
  { key: 'bookChat', minRole: 'viewer', load: ({ bookId, email }) => ({ count: chatSessions.listBookSessions(bookId, 'book', email, 1).length }) },
  {
    key: 'rueckblick', minRole: 'viewer',
    when: ({ bookId }) => getBookSettings(bookId)?.buchtyp === 'tagebuch',
    load: ({ bookId, email }) => rueckblickCoverage(bookId, email),
  },
];

router.get('/:book_id', (req, res) => {
  const ctx = { bookId: req.bookId, email: sessionEmail(req), role: req.bookRole };
  const skip = new Set(String(req.query.skip || '').split(',').filter(Boolean));
  const parts = {};
  for (const part of PARTS) {
    if (skip.has(part.key)) continue;
    if (!hasMinRole(ctx.role, part.minRole)) { parts[part.key] = { forbidden: true }; continue; }
    try {
      if (part.when && !part.when(ctx)) continue;
      parts[part.key] = { data: part.load(ctx) };
    } catch (e) {
      logger.error(`[overview] Teil ${part.key} fehlgeschlagen: ${e.message}`);
      parts[part.key] = { error: true };
    }
  }
  res.json({ parts });
});

module.exports = router;
