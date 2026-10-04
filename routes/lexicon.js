'use strict';
// Lesepfad der Wortschatz-Analyse. Nur lesend — geschrieben wird ausschliesslich
// im Job (/jobs/lexicon-scan), und zwar als Full-Replace. Es gibt hier bewusst
// kein POST/PUT/DELETE: die Zahlen sind aus dem Buchtext abgeleitet, nicht
// kuratiert. Wer sie ändern will, ändert den Text.
//
// Zugriff ab `viewer`: ein Lektor, der das Buch lesen darf, darf auch seine
// Kennzahlen sehen — sie stehen ohnehin im Text, den er vor sich hat. Was aus den
// übrigen Büchern des Besitzers abgeleitet ist, bleibt dem Besitzer (`_forViewer`).

const express = require('express');
const lexiconDb = require('../db/lexicon');
const { getOwnerEmail } = require('../db/book-access');
const {
  LEXICON_VERSION, MATTR_WINDOW, MTLD_MIN_TOKENS, HEAPS_MIN_TOKENS, HAPAX_LIMIT,
  DELTA_MIN_TOKENS, DELTA_MIN_CHAPTERS, IDIOLECT_MIN_TOKENS,
} = require('../lib/lexicon');
const { aclParamGuard, sessionEmail } = require('../lib/acl');

const router = express.Router();
// Login, Buch-ID, Rolle und Log-Kontext in einem — setzt `req.bookId`/`req.bookRole`.
router.param('book_id', aclParamGuard('viewer'));

// Was aus den ÜBRIGEN Büchern des Besitzers stammt, sieht nur der Besitzer:
// die Vergleichs-Mediane (`peers`), die Keyness (sagt, ob ein Wort in seinen
// anderen, womöglich privaten Büchern vorkommt), die Zeilensorte `key` (über
// genau diese Keyness ausgewählt) und das Einmalwort-Merkmal `novel` („sonst nie
// benutzt"). Ein Lektor mit Leserecht auf DIESES Buch hat kein Recht auf
// Rückschlüsse über die anderen.
function _forViewer(rows, isOwner, { dropKey = false } = {}) {
  if (isOwner) return rows;
  const out = [];
  for (const r of rows) {
    if (dropKey && r.kind === 'key') continue;
    const { keyness, novel, ...rest } = r;
    out.push({ ...rest, keyness: null, ...(novel !== undefined ? { novel: null } : {}) });
  }
  return out;
}

// Die Analyse-Version wird MITGELIEFERT, nicht im Frontend gespiegelt — eine
// Frontend-Kopie driftet unbemerkt gegen den Server. `stale` sagt der Karte, dass
// die gespeicherte Analyse aus einer älteren Rechenregel stammt und ein Scan lohnt.
// Veraltet ist die Analyse auch, wenn die Buchsprache seit dem Scan umgestellt
// wurde: Funktionswörter, Referenz und Vergleich hängen an ihr.
function _isStale(stats, bookId) {
  return (stats.lexicon_version || 0) !== LEXICON_VERSION
    || stats.language !== lexiconDb.bookLanguage(bookId);
}

router.get('/:book_id', (req, res) => {
  const bookId = req.bookId;
  const isOwner = req.bookRole === 'owner';

  const stats = lexiconDb.getBookLexicon(bookId);
  const thresholds = {
    version: LEXICON_VERSION,
    mattrWindow: MATTR_WINDOW,
    mtldMinTokens: MTLD_MIN_TOKENS,
    heapsMinTokens: HEAPS_MIN_TOKENS,
    // Deckel der Einmalwort-Liste. Die Karte stellt ihn neben `stats.hapax_listed`,
    // sonst sieht ein Ausschnitt aus wie eine Vollständigkeit.
    hapaxLimit: HAPAX_LIMIT,
    deltaMinTokens: DELTA_MIN_TOKENS,
    deltaMinChapters: DELTA_MIN_CHAPTERS,
    idiolectMinTokens: IDIOLECT_MIN_TOKENS,
  };
  // `?summary=1`: nur Kennzahlen + Vergleich — für die Kachel der Buch-Übersicht,
  // die bei jedem Buchwechsel lädt und die Ranglisten (Hunderte Zeilen) nie zeigt.
  const summary = req.query.summary === '1';
  if (stats && summary) {
    return res.json({
      stats,
      peers: isOwner ? lexiconDb.loadPeerStats(bookId, LEXICON_VERSION, stats.language) : null,
      isOwner,
      stale: _isStale(stats, bookId),
      thresholds,
    });
  }
  if (!stats) {
    return res.json({
      stats: null, terms: [], hapax: [], ngrams: [], chapters: [], idiolect: [],
      peers: null, isOwner, stale: false, thresholds,
    });
  }

  return res.json({
    stats,
    terms: _forViewer(lexiconDb.listLexiconTerms(bookId), isOwner, { dropKey: true }),
    // Einmalwörter als eigene Liste, nicht in `terms` gemischt: eigene Auswahlregel,
    // eigener Reiter, und um ein Vielfaches länger als die Lieblingswörter.
    hapax: _forViewer(lexiconDb.listLexiconHapax(bookId), isOwner),
    ngrams: lexiconDb.listLexiconNgrams(bookId),
    chapters: lexiconDb.listChapterLexicon(bookId),
    idiolect: lexiconDb.listFigureIdiolect(bookId, sessionEmail(req), getOwnerEmail(bookId)),
    // Vergleichs-Mediane der übrigen Bücher desselben Besitzers — eine nackte
    // Kennzahl ist für den Autor nicht interpretierbar. Nur für den Besitzer.
    peers: isOwner ? lexiconDb.loadPeerStats(bookId, LEXICON_VERSION, stats.language) : null,
    isOwner,
    stale: _isStale(stats, bookId),
    thresholds,
  });
});

module.exports = router;
