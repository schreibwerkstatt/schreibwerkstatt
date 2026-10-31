'use strict';
// Leseweg der Alters-Analyse: GET /figures/:book_id/alter.
//
// EIGENER ROUTER neben routes/figures.js, nicht darin: der Alters-Index ist ein
// abgeleitetes Ergebnis, das die Karte erst beim Oeffnen ihres Reiters braucht.
// Im heissen Pfad GET /figures/:book_id (Katalog, bei jedem Buchwechsel) haetten
// die Belege pro Figur nichts zu suchen.
//
// Die Zeilen sind nach `figures.fig_id` geschluesselt — dieselbe Kennung, die der
// Katalog als `id` nach vorne gibt. Nur daran kann das Frontend die Tabelle an
// die schon geladenen Figuren haengen, ohne einen zweiten Namensvergleich.

const express = require('express');
const { listFigureAges, getFigureAgeScan, latestFigureUpdate } = require('../db/figure-ages');
const contentStore = require('../lib/content-store');
const { AGE_ANALYSIS_VERSION } = require('../lib/figure-age');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');

const router = express.Router();

// Warum der gespeicherte Lauf nicht mehr zum Buch passt — leer, wenn er passt.
// Der Index wird nur auf Knopfdruck neu gebaut (nicht von der Komplettanalyse,
// nicht im Nacht-Cron); ohne diesen Hinweis liest sich ein alter Lauf wie ein
// aktueller. Grob statt der exakten content_sig des Jobs: die braeuchte den
// Volltext aller Seiten, und der Leseweg laedt bei jedem Reiter-Wechsel.
//   version  → Muster/Verdichtung/Prompt haben sich seither geaendert
//   text     → mindestens ein Abschnitt wurde nach dem Lauf gespeichert
//   figuren  → Figurenstamm nach dem Lauf geaendert (z.B. Komplettanalyse)
function staleReasons(bookId, userEmail, scan) {
  const out = [];
  if (Number(scan.age_version) !== AGE_ANALYSIS_VERSION) out.push('version');
  const since = scan.scanned_at;
  if (since && contentStore.pagesChangedSince(bookId, { since, sinceId: Number.MAX_SAFE_INTEGER }, 1).length) out.push('text');
  const fig = latestFigureUpdate(bookId, userEmail);
  if (since && fig && fig > since) out.push('figuren');
  return out;
}

// Lesen ab `viewer`: die Frage „wie alt ist die Figur hier" stellt sich beim
// Lektorieren genauso wie beim Schreiben. Der Scan selbst verlangt `editor`
// (routes/jobs/figur-alter.js) — er schreibt einen Index ans Buch.
router.param('book_id', aclParamGuard('viewer'));
router.param('book_id', bookParamHandler);

router.get('/:book_id/alter', (req, res) => {
  const bookId = req.bookId; // aclParamGuard hat Login + Buch-ID schon geprueft
  const userEmail = sessionEmail(req);
  const scan = getFigureAgeScan(bookId, userEmail);
  res.json({
    figuren: listFigureAges(bookId, userEmail),
    scan: scan ? {
      scanned_at: scan.scanned_at,
      figuren_total: scan.figuren_total,
      mit_alter: scan.mit_alter,
      belege_total: scan.belege_total,
      embed_used: !!scan.embed_used,
      model: scan.model,
      veraltet: staleReasons(bookId, userEmail, scan),
    } : null,
  });
});

module.exports = router;
module.exports.staleReasons = staleReasons; // Test-Zugang (tests/integration/figur-alter.test.js)
