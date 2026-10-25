'use strict';
// Normseite: 1800 Zeichen (30 Zeilen à 60 Anschläge). Eine Quelle für die
// Metrik `sw_normseiten` und die Umfangsangabe des Exposés.
const NORMSEITE_CHARS = 1800;

function normseiten(chars) {
  return Math.round((Number(chars) || 0) / NORMSEITE_CHARS);
}

module.exports = { NORMSEITE_CHARS, normseiten };
