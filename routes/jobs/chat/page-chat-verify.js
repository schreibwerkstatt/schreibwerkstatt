'use strict';
// Abschnitts-Chat: Fundstellen-Prüfung der Vorschläge beim Erzeugen. Jedes
// `original` wird gegen den Abschnittstext gezählt, den das Modell gesehen hat —
// mit derselben Normalform wie der Apply-Guard im Browser (Whitespace
// kollabiert, Anführungszeichen gefaltet: public/js/utils/text-match.js, über
// lib/esm-bridge.js geteilt). Ergebnis als `match` am Vorschlag:
//   'not_found' — die Stelle stand nie im Text (Modell hat paraphrasiert oder
//                 aus dem Buch-Kontext zitiert). Die UI trennt das von
//                 „veraltet" (Stelle war da, der Text hat sich seither geändert).
//   'ambiguous' — kommt mehrfach vor; Übernehmen bricht ab, der User sieht es
//                 schon an der Karte.
// Fundstelle eindeutig → kein Feld. Der Apply-Guard prüft unabhängig davon
// gegen den aktuellen Stand; `match` ist die Aussage über den Stand beim
// Erzeugen und ändert sich nicht.

const { textMatch } = require('../../../lib/esm-bridge');

async function annotateVorschlagMatches(vorschlaege, pageText) {
  if (!Array.isArray(vorschlaege) || vorschlaege.length === 0) return vorschlaege;
  const { countInText } = await textMatch();
  for (const v of vorschlaege) {
    const n = countInText(pageText, v.original);
    if (n === 0) v.match = 'not_found';
    else if (n > 1) v.match = 'ambiguous';
    else delete v.match;
  }
  return vorschlaege;
}

module.exports = { annotateVorschlagMatches };
