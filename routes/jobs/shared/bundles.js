'use strict';
// Blöcke (eine Figur samt ihren Stellen o. ä.) zu Bündeln für je einen KI-Call
// zusammenfassen (pure, ohne DB-/KI-Abhängigkeit).
//
// Zwei Deckel je Bündel: die Eingabe (`chars`, Zeichen im Prompt) und die
// geschätzte Antwort (`outEst`, Tokens). Ohne den zweiten passt ein ganzes Buch in
// ein Bündel, die Antwort reisst am Output-Cap, und der Job zahlt den abgebrochenen
// Call, bevor er halbiert neu fragt. Das Halbieren am Cap bleibt im Job als Netz für
// eine zu niedrige Schätzung.
//
// Ein einzelner Block über einem Deckel bildet sein eigenes Bündel — nie ein leeres.

/**
 * @param {Array<{ chars: number, outEst?: number }>} blocks
 * @param {{ charBudget: number, outBudget?: number }} limits
 * @returns {Array<Array<object>>}
 */
function bundleBlocks(blocks, { charBudget, outBudget = Infinity }) {
  const bundles = [];
  let cur = [], curChars = 0, curOut = 0;
  for (const b of blocks) {
    const out = b.outEst || 0;
    if (cur.length && (curChars + b.chars > charBudget || curOut + out > outBudget)) {
      bundles.push(cur); cur = []; curChars = 0; curOut = 0;
    }
    cur.push(b); curChars += b.chars; curOut += out;
  }
  if (cur.length) bundles.push(cur);
  return bundles;
}

module.exports = { bundleBlocks };
