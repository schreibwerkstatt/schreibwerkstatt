'use strict';
// Kapitel-Nummerierung als Single-Source-of-Truth. TOC-Plan-Bau und Body-Loop
// lesen dieselbe vorab berechnete Label-Liste, damit die im Inhaltsverzeichnis
// gezeigte Nummer exakt der im Fliesstext gerenderten entspricht — zwei
// parallele Zählautomaten würden sonst auseinanderdriften.

const { _chapterLabelNested } = require('./layout');

// Berechnet pro Block (Output von _coalesceGroups) das Kapitel-Label. Counter
// pro Tiefe; bei Eintritt in Tiefe d wird counters[d-1]++ und alle tieferen auf
// 0. Nur nummerierte Kapitel zählen; Nicht-Kapitel und unnummerierte Blöcke →
// label = null. Rückgabe: Array aligned zu `blocks`, je Eintrag { label, depth }.
function computeChapterLabels(blocks, config, docLang, region = null) {
  const counters = [0, 0, 0];
  const numberingMode = config.chapter.numberingMode || 'nested';
  const out = new Array(blocks.length);
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const depth = Math.max(1, Math.min(3, b.depth || 1));
    let label = null;
    if (b.isChapter && !b.unnumbered) {
      counters[depth - 1] += 1;
      for (let d = depth; d < 3; d++) counters[d] = 0; // tiefere Counter zuruecksetzen
      label = _chapterLabelNested(config.chapter.numbering, counters, depth, numberingMode, docLang, region);
    }
    out[bi] = { label, depth };
  }
  return out;
}

module.exports = { computeChapterLabels };
