'use strict';
// Nachrichtenverlauf: Seite der Absenderzeilen. Kopie von
// public/js/messages/msg-html.js#msgNameSides (CJS kann die SSoT nicht synchron
// laden) — gegated durch tests/unit/msg-thread-drift.test.mjs.
//
// Ein Absender steht auf der Seite der ersten Nachricht nach ihm, Hinweise
// dazwischen uebersprungen; folgt zuerst ein weiterer Absender oder nichts
// mehr, eingehend. Pro Zeile 'in'|'out' fuer Absender, null fuer alle anderen.

function msgNameSides(kinds) {
  return kinds.map((kind, i) => {
    if (kind !== 'name') return null;
    for (let j = i + 1; j < kinds.length; j++) {
      if (kinds[j] === 'in' || kinds[j] === 'out') return kinds[j];
      if (kinds[j] === 'name') break;
    }
    return 'in';
  });
}

module.exports = { msgNameSides };
