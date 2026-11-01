'use strict';
// Normseite: 1500 Zeichen — derselbe Wert wie im Browser
// (public/js/utils/format.js#CHARS_PER_NORMSEITE, gegated durch
// tests/unit/normseite-single-value.test.mjs). Eine Quelle für die Metrik
// `sw_normseiten` und die Umfangsangabe des Exposés. Das Seitenlayout des
// Word-Exports „Normseite" (30 × 60) ist eine Satzvorgabe, keine Zählregel.
const NORMSEITE_CHARS = 1500;

function normseiten(chars) {
  return Math.round((Number(chars) || 0) / NORMSEITE_CHARS);
}

module.exports = { NORMSEITE_CHARS, normseiten };
