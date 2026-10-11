'use strict';
// Wortformen fuer den Abgleich gegen Benutzer-Woerterbuch und Buchnamen —
// gemeinsam fuer den LanguageTool-Filter (lib/languagetool-filter.js) und das
// KI-Lektorat (routes/jobs/lektorat-dictionary.js).
//
// Genitiv nur fuer Nomen: ein Woerterbuch-Eintrag gilt als Nomen, wenn er
// grossgeschrieben gespeichert ist (im Deutschen tragen Nomen und Namen die
// Grossschreibung). «Riggenbach» deckt damit «Riggenbachs», «Säliwald» auch
// «Säliwaldes», «Niklaus» auch «Niklaus'». Kleingeschriebene Eintraege
// (Adjektive, Verben) gelten nur exakt — sonst ginge «schnachtes» als richtig
// durch. Ohne Wortarten-Tagger ist die Grossschreibung das einzige Signal.

const MIN_STEM = 2;

/** Moegliche Grundformen eines (lower-cased) Genitivs: -s, -es, ' / ’ nach s/x/z/ß. */
function genitiveStems(lower) {
  const out = [];
  if (/['’]$/u.test(lower)) {
    const s = lower.slice(0, -1);
    if (/[sxzß]$/u.test(s)) out.push(s);
  } else if (lower.endsWith('s')) {
    out.push(lower.slice(0, -1));
    if (lower.endsWith('es')) out.push(lower.slice(0, -2));
  }
  return out.filter(s => s.length >= MIN_STEM);
}

/**
 * Woerterbuch-Eintraege (Original-Schreibweise) → Abgleich-Struktur.
 * @param {Iterable<string>} entries
 * @returns {{ words: Set<string>, nouns: Set<string> }} beide lower-cased
 */
function buildDictionary(entries) {
  const words = new Set();
  const nouns = new Set();
  for (const raw of entries || []) {
    const w = String(raw || '').trim();
    if (!w) continue;
    const lower = w.toLowerCase();
    words.add(lower);
    if (/^\p{Lu}/u.test(w)) nouns.add(lower);
  }
  return { words, nouns };
}

/** Steht das Wort (beliebige Schreibung) im Woerterbuch — exakt oder als Genitiv eines Nomens? */
function dictionaryHas(dict, word) {
  if (!dict || !word) return false;
  const lower = String(word).toLowerCase();
  if (dict.words.has(lower)) return true;
  if (!dict.nouns.size) return false;
  return genitiveStems(lower).some(s => dict.nouns.has(s));
}

/** Regex-Quelle fuer die optionalen Genitiv-Endungen hinter einem Nomen. */
function genitiveSuffixSource(lower) {
  return /[sxzß]$/u.test(lower) ? "(?:es|s|['’])?" : '(?:es|s)?';
}

module.exports = { genitiveStems, buildDictionary, dictionaryHas, genitiveSuffixSource };
