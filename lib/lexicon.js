'use strict';
// Facade der Wortschatz-Analyse (quantitative Stilistik pro Buch). Einziger
// Einstieg für Konsumenten (Job, Leseroute, Tests) — die Submodule unter
// lib/lexicon/ sind interne Aufteilung.
//
//   tokenize.js  Token-Sequenz + Segmente (SSoT „was ist ein Token")
//   measures.js  MATTR, MTLD, Yule's K, Heaps β, Hapax, lexikalische Dichte
//   ngrams.js    n-Gramm-Zählung (Apriori) + log-Dice
//   keyness.js   Log-Likelihood gegen ein Referenzkorpus
//   chapters.js  Kapitel-Band: Masse pro Kapitel + Burrows's Delta
//   idiolect.js  Figuren-Idiolekt: Wortschatz der wörtlichen Rede je Figur
//   names.js     Eigennamen als Zusatz-Stoppwörter (inkl. Genitiv)
//   analyze.js   Orchestrator über die Seiten eines Buchs
//
// Alles darunter ist pure: keine DB, kein Netz, kein Zustand. Persistenz liegt in
// db/lexicon.js, das Einreihen in routes/jobs/lexicon-scan.js.

const tokenize = require('./lexicon/tokenize');
const measures = require('./lexicon/measures');
const ngrams = require('./lexicon/ngrams');
const keyness = require('./lexicon/keyness');
const chapters = require('./lexicon/chapters');
const idiolect = require('./lexicon/idiolect');
const names = require('./lexicon/names');
const analyze = require('./lexicon/analyze');

module.exports = {
  ...tokenize,
  ...measures,
  ...ngrams,
  ...keyness,
  ...chapters,
  ...idiolect,
  ...names,
  ...analyze,
};
