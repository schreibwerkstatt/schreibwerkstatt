'use strict';
// Benutzerbezogener Filter ueber LanguageTool-Treffer. Laeuft im Proxy beim
// Ausliefern — NACH dem Absatz-Cache, der ungefilterte Treffer haelt. Drei
// Quellen:
//
//   dict   Woerterbuch des Users ({ words, nouns }, db/user-dictionary.js#getCheckDict);
//          grossgeschriebene Eintraege decken den Genitiv mit (lib/dictionary-forms.js)
//   names  Eigennamen des Buchs (Figuren + Orte), Einzelwoerter lower-cased;
//          deckt zusaetzlich den Genitiv ab („Annas", „Hans'"). Nur gegen
//          Rechtschreib-Treffer — ein Grammatikbefund am Namen bleibt stehen.
//   rules  abgeschaltete LT-Regel-IDs (db/languagetool-rules.js)
//
// Das beanstandete Wort kommt aus `context` (offset/length zeigen ins
// Kontext-Fenster), nicht aus dem Eingabetext — der Filter braucht so keinen
// Zugriff auf den geprueften Text.

const { dictionaryHas, genitiveStems } = require('./dictionary-forms');

const NAME_SPLIT = /[\s/,;:()«»„“”"]+/;

/** Eigennamen in Einzelwoerter zerlegen: „Anna-Lena Müller" → anna-lena, müller. */
function buildNameSet(names) {
  const set = new Set();
  for (const raw of names || []) {
    const full = String(raw || '').trim();
    if (!full) continue;
    for (const tok of full.split(NAME_SPLIT)) {
      const t = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (t.length >= 2) set.add(t.toLowerCase());
    }
  }
  return set;
}

function matchedWord(m) {
  const ctx = m?.context;
  if (!ctx || typeof ctx.text !== 'string') return '';
  return ctx.text.substr(ctx.offset || 0, ctx.length || 0).trim();
}

function _isSpelling(m) {
  return (m?.rule?.id || '').includes('SPELL') || m?.rule?.category?.id === 'TYPOS';
}

function _isName(lower, names) {
  // Genitiv: „Annas", „Hans'", „Hans’"
  return names.has(lower) || genitiveStems(lower).some(s => names.has(s));
}

/**
 * @param {object[]} matches
 * @param {{dict?: {words: Set<string>, nouns: Set<string>}, names?: Set<string>, rules?: Set<string>}} f
 */
function filterMatches(matches, { dict, names, rules } = {}) {
  if (!Array.isArray(matches)) return [];
  const hasWords = dict && dict.words.size;
  const hasNames = names && names.size;
  const hasRules = rules && rules.size;
  if (!hasWords && !hasNames && !hasRules) return matches;
  return matches.filter((m) => {
    if (hasRules && rules.has(m?.rule?.id)) return false;
    if (!hasWords && !hasNames) return true;
    const word = matchedWord(m);
    if (!word) return true;
    const lower = word.toLowerCase();
    if (hasWords && dictionaryHas(dict, lower)) return false;
    if (hasNames && _isSpelling(m) && _isName(lower, names)) return false;
    return true;
  });
}

module.exports = { filterMatches, buildNameSet, matchedWord };
