'use strict';
// Kapitel-Band der Wortschatz-Analyse: dieselben Diversitätsmasse pro Kapitel und
// Burrows's Delta gegen den Buchschnitt („welches Kapitel liest sich nicht wie der
// Rest"). Pure — Eingabe sind die Token-Sequenzen je Kapitel in Leserichtung.
//
// Warum ein eigener Pass und kein Aggregat über `page_stats`: MATTR/MTLD sind
// Fenstermasse über die Token-Sequenz (siehe docs/wortschatz.md). Ein Kapitel ist
// eine eigene Sequenz; seine Seiten werden in Leserichtung aneinandergehängt.
//
// Burrows's Delta (Burrows 2002), hier gegen den Mittelpunkt aller Kapitel:
//   1. Merkmale = die MFW häufigsten Wortformen des ganzen Buchs, BEWUSST inklusive
//      Funktionswörtern — gerade „und", „sie", „hatte" tragen die Stilsignatur, und
//      sie sind thematisch neutral.
//   2. Pro Kapitel die relative Häufigkeit jedes Merkmals, über die Kapitel
//      z-standardisiert (Mittel/Streuung je Wort über die Kapitel).
//   3. Delta = Mittel der |z| eines Kapitels. Der Mittelpunkt hat z = 0, Delta ist
//      also der Abstand zum „durchschnittlichen Kapitel dieses Buchs".
// Ein Wert um 0,8 ist unauffällig; was zählt, ist der Vergleich der Kapitel
// untereinander, nicht die absolute Zahl.

const measures = require('./measures');
const { frequencies } = require('./tokenize');
const { round } = require('./round');

// Merkmalszahl (most frequent words). 150 ist der übliche Bereich für Prosa
// (Burrows: 100–150); mehr Wörter bringen vor allem seltene, verrauschte Merkmale.
const DELTA_MFW = 150;
// Unter dieser Länge sind relative Häufigkeiten zu verrauscht — ein Kapitel mit
// 300 Wörtern hätte für die meisten Merkmale 0 oder 1 Vorkommen. Solche Kapitel
// bekommen ihre Diversitätswerte, aber kein Delta und gehen nicht in Mittel/Streuung
// ein.
const DELTA_MIN_TOKENS = 1500;
// Delta über einen Mittelpunkt braucht eine Verteilung: mit zwei Kapiteln ist jedes
// genau gleich weit von der Mitte entfernt.
const DELTA_MIN_CHAPTERS = 3;
// Wie viele Merkmale je Kapitel als Begründung mitgehen („auffällig oft: sagte").
const DELTA_TOP = 6;

function _chapterMeasures(tokens, isContentWord) {
  const freq = frequencies(tokens);
  const hx = measures.hapaxStats(freq);
  const m = measures.mattr(tokens);
  return {
    tokens: tokens.length,
    types: hx.types,
    hapax_ratio: hx.hapax_ratio,
    mattr: m.value,
    mattr_window: m.window,
    mtld: measures.mtld(tokens),
    yule_k: measures.yuleK(freq, tokens.length),
    lex_density: measures.lexicalDensity(tokens, isContentWord),
    _freq: freq,
  };
}

// chapterTokens: Map<chapter_id, string[]> in Buchreihenfolge.
// bookFreq: Map<term,count> des ganzen Buchs (für die MFW-Auswahl).
// Rückgabe: [{ chapter_id, tokens, types, …, delta, delta_top }] in derselben
// Reihenfolge wie `chapterTokens`.
function analyzeChapters(chapterTokens, bookFreq, { isContentWord } = {}) {
  const rows = [];
  for (const [chapterId, toks] of chapterTokens) {
    if (!toks.length) continue;
    rows.push({ chapter_id: chapterId, ..._chapterMeasures(toks, isContentWord || (() => true)) });
  }

  const mfw = [...bookFreq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, DELTA_MFW)
    .map(([t]) => t);
  const eligible = rows.filter(r => r.tokens >= DELTA_MIN_TOKENS);

  if (eligible.length >= DELTA_MIN_CHAPTERS && mfw.length) {
    const rel = eligible.map(r => mfw.map(t => (r._freq.get(t) || 0) / r.tokens));
    const n = eligible.length;
    const mean = mfw.map((_, j) => rel.reduce((s, v) => s + v[j], 0) / n);
    const sd = mfw.map((_, j) => Math.sqrt(rel.reduce((s, v) => s + (v[j] - mean[j]) ** 2, 0) / n));
    eligible.forEach((r, i) => {
      let sum = 0, used = 0;
      const contrib = [];
      for (let j = 0; j < mfw.length; j++) {
        if (!(sd[j] > 0)) continue; // Wort in allen Kapiteln gleich häufig: kein Merkmal
        const z = (rel[i][j] - mean[j]) / sd[j];
        sum += Math.abs(z);
        used++;
        contrib.push({ term: mfw[j], z });
      }
      r.delta = used ? round(sum / used, 3) : null;
      contrib.sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.term < b.term ? -1 : 1));
      r.delta_top = contrib.slice(0, DELTA_TOP).map(c => ({ term: c.term, z: round(c.z, 2) }));
    });
  }

  for (const r of rows) {
    delete r._freq;
    if (r.delta === undefined) { r.delta = null; r.delta_top = null; }
  }
  return rows;
}

module.exports = {
  DELTA_MFW, DELTA_MIN_TOKENS, DELTA_MIN_CHAPTERS, DELTA_TOP,
  analyzeChapters,
};
