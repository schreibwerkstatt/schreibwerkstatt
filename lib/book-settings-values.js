'use strict';
// Erlaubte Werte der Buch-Stammangaben (Sprache, Region, Buchtyp, Erzählperspektive,
// Erzählzeit) — EIN Ort für alle Validierungen: PUT /booksettings und die
// User-Defaults in PUT /me/settings prüfen gegen dieselben Listen. Zwei Kopien
// liefen auseinander, und ein im Profil gewählter Default-Buchtyp ergab 400.
//
// Die Buchtypen kommen aus ihrer SSoT prompt-config.json (`buchtypen.de`, siehe
// lib/buchtyp.js), POV/Tempus aus den Prompt-Labels (routes/jobs/narrative-labels.js):
// ein Key, den der Prompt nicht kennt, darf auch nicht gespeichert werden.

const { POV_LABELS, TEMPUS_LABELS } = require('../routes/jobs/narrative-labels');

const VALID_LANGUAGES = Object.freeze(['de', 'en']);
const VALID_REGIONS = Object.freeze(['CH', 'DE', 'US', 'GB']);
const VALID_POV = Object.freeze(Object.keys(POV_LABELS));
const VALID_TEMPUS = Object.freeze(Object.keys(TEMPUS_LABELS));

let _buchtypen = null;
/** Buchtyp-Keys in Config-Reihenfolge (lazy: prompt-config.json wird erst beim
 *  ersten Zugriff gelesen). */
function validBuchtypen() {
  if (!_buchtypen) {
    const typen = require('./prompts-loader').getPromptConfig().buchtypen?.de || {};
    _buchtypen = Object.freeze(Object.keys(typen));
  }
  return _buchtypen;
}

/** Default-Region einer Sprache (de → CH, en → US). */
function defaultRegionFor(language) {
  return language === 'en' ? 'US' : 'CH';
}

module.exports = {
  VALID_LANGUAGES, VALID_REGIONS, VALID_POV, VALID_TEMPUS,
  validBuchtypen, defaultRegionFor,
};
