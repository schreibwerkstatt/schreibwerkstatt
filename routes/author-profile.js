'use strict';
// Autorenprofil des Users: die stilistischen Kennzahlen seiner eigenen Buecher
// nebeneinander, in Werk-Reihenfolge.
//
// Eigener Router statt weiterer Routen in routes/usersettings.js: die Datei ist
// bereits eine LOC-Altlast (Ratsche in tests/unit/loc-limits.test.mjs) und darf
// nicht wachsen — dieselbe Begruendung wie bei routes/mybooks.js.
// Mount-Punkt `/me/author-profile`, user-bound wie `/me/profile-stats`.
//
// Kein KI-Call und kein Job: Stufe 1 ist reine Messung auf bereits vorhandenen
// Indexen (`book_lexicon`, `page_stats`). Die deutende KI-Schicht kommt spaeter
// obendrauf und bekommt genau diese Zahlen als Vorbefund.

const express = require('express');
const { getAuthorProfile, saveAuthorProfileText, saveAuthorProfileRun } = require('../db/author-profile');
const { deleteProposal } = require('../db/ai-proposals');
const { sessionEmail } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '64kb' });

// DECKUNGSGLEICH mit STILPROFIL_MAX in routes/booksettings.js. Das ist kein
// Zufallswert: das Autorenprofil kann in das Stilprofil eines Buchs uebernommen
// werden, und ein groesserer Deckel hier erzeugte Texte, die dort nicht mehr
// hineinpassen — die Uebernahme muesste kuerzen oder scheitern.
const AUTHOR_PROFILE_MAX = 6000;

/**
 * GET /me/author-profile — Messung ueber die eigenen Buecher.
 *
 * Keine Buch-ACL: die Antwort ist ueber `books.owner_email` skopiert und
 * enthaelt ausschliesslich eigene Buecher. Sichtbarkeit endet beim Eigentum —
 * fremde Buecher, an denen man mitarbeitet, gehoeren nicht ins eigene Stilbild
 * (gleiche Definition wie der Keyness-Referenzkorpus in db/lexicon.js).
 *
 * Keine Buchnamen im Body (Content-Store-Regel) — das Frontend joint ueber
 * `book_id` aus `/content/books`.
 */
router.get('/', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  try {
    res.json(getAuthorProfile(email));
  } catch (e) {
    logger.error('[me/author-profile] DB-Fehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * PUT /me/author-profile — den Profiltext speichern. Zwei Formen:
 *
 * - `{ profil_text }`: Handarbeit. Setzt `edited = 1` — die Karte weist den
 *   Text danach als bearbeitet aus. Nur der Fliesstext: die Deutungs-Listen
 *   (`konstanten`/`entwicklung`) gehoeren zum Lauf und sind kein Formularfeld,
 *   eine von Hand editierte „Entwicklung" waere eine Behauptung ohne Messung.
 * - `{ run: { profil_text, konstanten, entwicklung, basis, basis_sig } }`: ein
 *   übernommener KI-Vorschlag (Job `autorenprofil` legt ihn nur als offenen
 *   Vorschlag in `ai_proposals` ab). Setzt `edited = 0`, legt die Basis des
 *   Laufs ab, gegen die der Text später als veraltet erkannt wird, und erledigt
 *   den offenen Vorschlag.
 */
router.put('/', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const run = req.body?.run;
  if (run && typeof run === 'object') return _saveRun(email, run, res);
  const text = req.body?.profil_text;
  if (typeof text !== 'string') {
    return res.status(400).json({ error_code: 'PROFIL_TEXT_REQUIRED' });
  }
  if (text.length > AUTHOR_PROFILE_MAX) {
    return res.status(400).json({ error_code: 'AUTHOR_PROFILE_TOO_LONG', max: AUTHOR_PROFILE_MAX });
  }
  try {
    saveAuthorProfileText(email, text);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[me/author-profile] Schreibfehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

function _saveRun(email, run, res) {
  const text = typeof run.profil_text === 'string' ? run.profil_text.trim() : '';
  if (!text) return res.status(400).json({ error_code: 'PROFIL_TEXT_REQUIRED' });
  if (text.length > AUTHOR_PROFILE_MAX) {
    return res.status(400).json({ error_code: 'AUTHOR_PROFILE_TOO_LONG', max: AUTHOR_PROFILE_MAX });
  }
  const list = (v) => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);
  try {
    saveAuthorProfileRun(email, {
      profilText: text,
      konstanten: list(run.konstanten),
      entwicklung: list(run.entwicklung),
      basis: list(run.basis),
      basisSig: typeof run.basis_sig === 'string' ? run.basis_sig : null,
    });
    deleteProposal('autorenprofil', email, null);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[me/author-profile] Schreibfehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
}

module.exports = router;
