'use strict';
// Altersspanne eines Akts aus seinem Namen — PURE.
//
// Wer seinen Plot nach Lebensphasen plant, benennt die Akte danach: „Erste Krise
// (28-32)", „Erwachsen (24–28)". Zusammen mit dem Geburtsjahr der Strang-Figur
// ergibt das ein Zeitfenster für jeden Beat im Akt (lib/plot-zeit-vorschlag.js)
// und einen Prüfpunkt für die Zeit-Messung (lib/plot-time-consistency.js).
//
// Bewusst eine Heuristik auf dem Namen statt eigener Felder: sie verlangt keine
// zusätzliche Eingabe. Damit sie in Büchern mit anderer Benennung nicht falsch
// anschlägt („Teil 2 (1-3)" ist keine Altersangabe — oder doch, aber eine, die
// keinem Beat schadet), greift sie nur bei plausiblen Werten: Klammer mit
// genau zwei Zahlen, 0–120, aufsteigend, höchstens 30 Jahre breit. Und die
// Konsumenten nutzen sie nur, wenn der Strang eine Figur mit Geburtsjahr hat.

const MAX_AGE = 120;
const MAX_SPAN = 30;

/** @returns {{ von: number, bis: number } | null} */
function parseActAgeRange(name) {
  const m = String(name || '').match(/\(\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})\s*\)/);
  if (!m) return null;
  const von = parseInt(m[1], 10), bis = parseInt(m[2], 10);
  if (von > MAX_AGE || bis > MAX_AGE || bis < von || bis - von > MAX_SPAN) return null;
  return { von, bis };
}

module.exports = { parseActAgeRange };
