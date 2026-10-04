'use strict';

function splitParagraphs(text) {
  return text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
}

// Abkürzungen, die mit einem Punkt enden, aber KEIN Satzende markieren. Ohne
// diese Liste schneidet der Splitter „z. B.", „Dr.", „S. 12", „d. h." mitten
// im Satz — und Prompt endet auf „z." während die Completion mit „B. …"
// beginnt. Single-Letter-Fall (Initialen, gesplittete Abk. wie „z. B.") wird
// generisch behandelt, Mehrbuchstaben-Abk. über das Set.
const ABBREVIATIONS = new Set([
  // Deutsch
  'dr', 'prof', 'nr', 'hr', 'fr', 'frl', 'hrsg', 'ggf', 'evtl', 'bzw', 'usw',
  'etc', 'ca', 'vgl', 'abb', 'kap', 'bd', 'aufl', 'sog', 'inkl', 'exkl', 'max',
  'min', 'mio', 'mrd', 'tel', 'str', 'geb', 'gest', 'jh', 'jhdt', 'jt', 'pos',
  'art', 'abs', 'zit', 'ebd', 'ders', 'dies', 'bspw', 'tsd', 'urspr', 'eigtl',
  // Englisch
  'mr', 'mrs', 'ms', 'sr', 'jr', 'st', 'vs', 'inc', 'ltd', 'co', 'corp',
  'dept', 'fig', 'vol', 'pp', 'ed', 'eds', 'al', 'approx', 'esp',
]);

// True, wenn der Punkt an `dotIdx` zu einer Abkürzung gehört (kein Satzende).
function isAbbreviationBefore(text, dotIdx) {
  let i = dotIdx - 1;
  let word = '';
  while (i >= 0 && /[A-Za-zÄÖÜäöüß]/.test(text[i])) { word = text[i] + word; i--; }
  if (!word) return false;
  if (word.length === 1) return true; // Initial / gesplittete Abk. („z. B.")
  return ABBREVIATIONS.has(word.toLowerCase());
}

// Zerlegt Fliesstext in Sätze. Heuristik: Satzende = [.!?…], optional gefolgt
// von schliessender Anführungszeichen, dann Whitespace oder EOT. Hängt den
// Schlussrest (ohne Satzzeichen-Ende) als eigenen Satz an. Für deutsche und
// englische Prosa ausreichend zuverlässig; einfacher Punkt nach einer
// Abkürzung (siehe `isAbbreviationBefore`) gilt nicht als Satzende.
function splitSentences(text) {
  const out = [];
  const re = /([.!?…]+["”«»„‹›']?)(\s+|$)/g;
  let lastEnd = 0, m;
  while ((m = re.exec(text)) !== null) {
    const dotCore = m[1].replace(/["”«»„‹›']$/, '');
    if (dotCore === '.' && isAbbreviationBefore(text, m.index)) continue;
    const sentence = text.slice(lastEnd, m.index + m[1].length).trim();
    if (sentence) out.push(sentence);
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) out.push(tail);
  return out;
}

// Liefert die Start-Indizes aller Sätze nach einer Satzgrenze (= Index des
// ersten Zeichens des Folgesatzes). Überspringt Abkürzungs-Punkte und verlangt
// — wie die alte Heuristik — dass der Folgesatz mit Grossbuchstabe, Ziffer oder
// öffnendem Anführungszeichen beginnt.
function sentenceBoundaryIndices(text) {
  const re = /([.!?…]+["”«»„‹›']?)(\s+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const dotCore = m[1].replace(/["”«»„‹›']$/, '');
    if (dotCore === '.' && isAbbreviationBefore(text, m.index)) continue;
    const nextIdx = m.index + m[0].length;
    const nextChar = text[nextIdx];
    if (nextChar && !/[A-ZÄÖÜ"„«»0-9]/.test(nextChar)) continue;
    out.push(nextIdx);
  }
  return out;
}

// Splittet `text` an einer Satzgrenze nahe `ratio` (0–1). Bevorzugt die letzte
// Grenze bei/vor dem Zielindex (kein Überschiessen — wichtig fürs
// Verbatim-Chunking), sonst die erste danach. Gibt exakte Substrings zurück
// (nur an den Enden getrimmt) — der Verbatim-Sampler verlangt wörtliche Wiedergabe.
function splitAtSentence(text, ratio) {
  const target = Math.max(1, Math.min(text.length - 1, Math.floor(text.length * ratio)));
  const bounds = sentenceBoundaryIndices(text); // aufsteigend
  if (bounds.length) {
    let pick = -1;
    for (const b of bounds) { if (b <= target) pick = b; else break; }
    if (pick === -1) pick = bounds[0]; // alle Grenzen liegen hinter dem Ziel
    return [text.slice(0, pick).trim(), text.slice(pick).trim()];
  }
  return [text.slice(0, target).trim(), text.slice(target).trim()];
}

const splitHalfAtSentence = (text) => splitAtSentence(text, 0.5);

// Dialog-Zitate (DE + EN-Typografie + ASCII). Bewusst konservativ — matched nur
// Zitate innerhalb eines Absatzes (keine Zeilenumbrüche), damit keine
// mehrseitigen False-Positives entstehen.
//
// Anführungszeichen als \u-Escapes, nicht als Literal: typografische Zeichen
// gehen beim Kopieren/Formatieren leicht als ASCII-`"` verloren, und dann
// matcht die Erkennung still kein einziges deutsches Zitat mehr.
//   „…“ / „…”  U+201E … U+201C/U+201D   (deutsch)
//   “…”        U+201C … U+201D          (englisch)
//   »…«        U+00BB … U+00AB          (deutsche Guillemets)
//   «…»        U+00AB … U+00BB          (Schweizer Guillemets)
//   "…"        ASCII
const DIALOG_PATTERNS = [
  /\u201E([^\u201C\u201D\u201E\n]{10,400})[\u201C\u201D]/g,
  /\u201C([^\u201C\u201D\u201E\n]{10,400})\u201D/g,
  /\u00BB\s?([^\u00AB\u00BB\n]{10,400}?)\s?\u00AB/g,
  /\u00AB\s?([^\u00AB\u00BB\n]{10,400}?)\s?\u00BB/g,
  /"([^"\n]{10,400})"/g,
];

// Zwei Schreibweisen können dieselbe Stelle unterschiedlich lesen: das
// Schlusszeichen von »A« ist zugleich das Öffnungszeichen eines falschen «…»
// bis zum nächsten Zitat. Deshalb gewinnt pro Textstelle der früheste Treffer,
// überlappende spätere fallen weg.
function extractDialogs(text) {
  const found = [];
  for (const re of DIALOG_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      found.push({ quote: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const results = [];
  let lastEnd = -1;
  for (const d of found) {
    if (d.start < lastEnd) continue;
    results.push(d);
    lastEnd = d.end;
  }
  return results;
}

module.exports = {
  splitParagraphs,
  splitSentences,
  splitAtSentence,
  splitHalfAtSentence,
  extractDialogs,
};
