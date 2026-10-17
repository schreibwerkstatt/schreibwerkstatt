'use strict';
// LIKE-Muster aus freiem Text (User-Eingabe, KI-gelieferte Namen). `%`, `_` und
// das Escape-Zeichen `\` selbst werden maskiert; das Statement MUSS dazu
// `LIKE ? ESCAPE '\'` tragen. Ohne das Mit-Escapen des `\` wuerde ein Name auf
// `\` das angehaengte `%` maskieren, und `%`/`_` im Namen matchten beliebig.

/** Teilstring-Muster `%needle%` mit maskierten Metazeichen. */
function likeContains(needle) {
  return `%${escapeLike(needle)}%`;
}

function escapeLike(s) {
  return String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = { likeContains, escapeLike };
