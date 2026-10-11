'use strict';
// Benutzer-Wörterbuch im Lektorat (db/user-dictionary.js, dasselbe, das den
// LanguageTool-Spellcheck filtert). Zwei Schichten, wie beim Nachbarkontext:
//  1. Prompt: die Wörterbuch-Wörter, die auf der Seite vorkommen, gehen als
//     „KEINE Rechtschreibfehler"-Liste an beide Pässe (prompts/blocks.js#_buildWoerterbuchBlock).
//  2. Backstop: `rechtschreibung`-Findings, deren «original» ein Wörterbuch-Wort
//     ist, fallen raus — Modelle halten sich nicht verlässlich an solche Listen.
// Nur Wörter der Seite statt des ganzen Wörterbuchs: hält den Prompt klein und
// die Cache-Signatur stabil (ein neues Wort invalidiert nur Seiten, die es tragen).
// Pure — testbar ohne DB.

// Obergrenze für den Prompt-Block; der Backstop prüft unabhängig davon alle.
const MAX_PROMPT_WORDS = 200;

const { genitiveSuffixSource } = require('../../lib/dictionary-forms');

const _escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Wörterbuch-Einträge ({ words, nouns } aus getCheckDict), die im Seitentext als
// ganzes Wort vorkommen — bei Nomen auch im Genitiv (lib/dictionary-forms.js).
// Rückgabe: jede vorkommende Form in der Schreibweise der Seite, sortiert. So
// stehen «Riggenbach» und «Riggenbachs» beide im Prompt und im Backstop.
function dictionaryWordsOnPage(dict, text) {
  if (!dict || !dict.words?.size || !text) return [];
  const found = new Map();
  for (const w of dict.words) {
    const suffix = dict.nouns.has(w) ? genitiveSuffixSource(w) : '';
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${_escRe(w)}${suffix}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of text.matchAll(re)) {
      const key = m[0].toLowerCase();
      if (!found.has(key)) found.set(key, m[0]);
    }
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b));
}

// Satzzeichen/Anführungszeichen am Rand abstreifen: das Modell kopiert gern
// «Chuchichäschtli,» samt Komma in «original».
const _bareWord = (s) => String(s || '').trim()
  .replace(/^[\s"'«»‹›„“”‚‘’()[\]]+|[\s"'«»‹›„“”‚‘’()[\].,;:!?…]+$/gu, '');

// Verwirft Rechtschreib-Findings auf Wörterbuch-Wörtern. Andere Typen bleiben:
// ein Grammatikfehler im Satz um ein Wörterbuch-Wort ist weiterhin einer.
function dropDictionaryFindings(fehler, dictWords) {
  if (!Array.isArray(fehler) || !dictWords?.length) return fehler;
  // Beide Seiten gleich abstreifen: «Niklaus'» steht so in der Seitenliste.
  const set = new Set(dictWords.map(w => _bareWord(w).toLowerCase()));
  return fehler.filter(f => f?.typ !== 'rechtschreibung' || !set.has(_bareWord(f.original).toLowerCase()));
}

module.exports = { MAX_PROMPT_WORDS, dictionaryWordsOnPage, dropDictionaryFindings };
