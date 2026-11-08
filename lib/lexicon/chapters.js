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
//
// Delta-Einheiten (`_deltaUnits`): ein Kapitel ab DELTA_MIN_TOKENS ist seine eigene
// Einheit. Kürzere Kapitel werden mit ihren direkten Nachbarn in Leserichtung zu
// einem Block ab DELTA_MIN_TOKENS gebündelt — sonst hätte eine Erzählsammlung oder
// ein Buch mit kurzen Kapiteln nie ein Delta. Mittel/Streuung und das Delta laufen
// über diese Einheiten; jedes Kapitel eines Blocks trägt das Delta seines Blocks.

const measures = require('./measures');
const { frequencies } = require('./tokenize');
const { round } = require('./round');

// Merkmalszahl (most frequent words). 150 ist der übliche Bereich für Prosa
// (Burrows: 100–150); mehr Wörter bringen vor allem seltene, verrauschte Merkmale.
const DELTA_MFW = 150;
// Unter dieser Länge sind relative Häufigkeiten zu verrauscht — ein Kapitel mit
// 300 Wörtern hätte für die meisten Merkmale 0 oder 1 Vorkommen. Solche Kapitel
// behalten ihre eigenen Diversitätswerte; ins Delta gehen sie nur als Teil eines
// Blocks mit ihren Nachbarn (`_deltaUnits`).
const DELTA_MIN_TOKENS = 1500;
// Delta über einen Mittelpunkt braucht eine Verteilung: mit zwei Einheiten (Kapitel
// oder Block) ist jede genau gleich weit von der Mitte entfernt.
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

// Delta-Einheiten aus den Kapitelzeilen (Leserichtung). Rückgabe: Liste von
// Index-Listen in `rows`; Kapitel, die in keine Einheit passen, fehlen darin.
//   - Kapitel ab DELTA_MIN_TOKENS: eigene Einheit, wie ohne Bündelung.
//   - Lauf kurzer Kapitel: gierig von vorne aufsummiert, ein Block schliesst, sobald
//     er DELTA_MIN_TOKENS erreicht. Ein langes Kapitel unterbricht den Lauf — Blöcke
//     sind zusammenhängend, ein Block über ein langes Kapitel hinweg wäre keine
//     Textstrecke mehr.
//   - Ein zu kurzer Rest am Laufende geht in den vorigen Block desselben Laufs, nie
//     in ein langes Kapitel (dessen Delta bliebe sonst nicht das eigene). Hat der
//     Lauf gar keinen vollen Block, bleiben seine Kapitel ohne Delta.
function _deltaUnits(rows) {
  const units = [];
  let run = [];      // fertige Blöcke des laufenden Kurz-Laufs
  let cur = [];      // offener Block
  let curTokens = 0;
  const flushRun = () => {
    if (cur.length && run.length) run[run.length - 1].push(...cur);
    units.push(...run);
    run = []; cur = []; curTokens = 0;
  };
  rows.forEach((r, i) => {
    if (r.tokens >= DELTA_MIN_TOKENS) {
      flushRun();
      units.push([i]);
      return;
    }
    cur.push(i);
    curTokens += r.tokens;
    if (curTokens >= DELTA_MIN_TOKENS) { run.push(cur); cur = []; curTokens = 0; }
  });
  flushRun();
  return units;
}

// chapterTokens: Map<chapter_id, string[]> in Buchreihenfolge.
// bookFreq: Map<term,count> des ganzen Buchs (für die MFW-Auswahl).
// Rückgabe: [{ chapter_id, tokens, types, …, delta, delta_top, delta_block }] in
// derselben Reihenfolge wie `chapterTokens`. `delta`/`delta_top` sind die Werte der
// Einheit; `delta_block` ist bei einem gebündelten Kapitel
// { first, last, chapters, tokens } (first/last = 1-basierte Position in dieser
// Liste, also die Kapitelnummer in Leserichtung), sonst null.
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
  const units = _deltaUnits(rows).map(idx => {
    let tokens = 0;
    const freq = new Map();
    for (const i of idx) {
      tokens += rows[i].tokens;
      for (const [t, c] of rows[i]._freq) freq.set(t, (freq.get(t) || 0) + c);
    }
    return { idx, tokens, freq };
  });

  if (units.length >= DELTA_MIN_CHAPTERS && mfw.length) {
    const rel = units.map(u => mfw.map(t => (u.freq.get(t) || 0) / u.tokens));
    const n = units.length;
    const mean = mfw.map((_, j) => rel.reduce((s, v) => s + v[j], 0) / n);
    const sd = mfw.map((_, j) => Math.sqrt(rel.reduce((s, v) => s + (v[j] - mean[j]) ** 2, 0) / n));
    units.forEach((u, i) => {
      let sum = 0, used = 0;
      const contrib = [];
      for (let j = 0; j < mfw.length; j++) {
        if (!(sd[j] > 0)) continue; // Wort in allen Einheiten gleich häufig: kein Merkmal
        const z = (rel[i][j] - mean[j]) / sd[j];
        sum += Math.abs(z);
        used++;
        contrib.push({ term: mfw[j], z });
      }
      const delta = used ? round(sum / used, 3) : null;
      contrib.sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.term < b.term ? -1 : 1));
      const top = contrib.slice(0, DELTA_TOP).map(c => ({ term: c.term, z: round(c.z, 2) }));
      const block = u.idx.length > 1
        ? { first: u.idx[0] + 1, last: u.idx[u.idx.length - 1] + 1, chapters: u.idx.length, tokens: u.tokens }
        : null;
      for (const k of u.idx) {
        rows[k].delta = delta;
        rows[k].delta_top = top;
        rows[k].delta_block = block;
      }
    });
  }

  for (const r of rows) {
    delete r._freq;
    if (r.delta === undefined) { r.delta = null; r.delta_top = null; }
    if (r.delta_block === undefined) r.delta_block = null;
  }
  return rows;
}

module.exports = {
  DELTA_MFW, DELTA_MIN_TOKENS, DELTA_MIN_CHAPTERS, DELTA_TOP,
  analyzeChapters, _deltaUnits,
};
