'use strict';

// Prüfkriterien des Eval-Sets (docs/finetuning.md#5-qualitäts-check):
//   mustContain     — jeder Begriff muss vorkommen (Teilstring, ohne Gross-/Kleinschreibung);
//   mustContainAny  — Synonymgruppen: aus JEDER Gruppe mindestens ein Begriff
//                     (mit `minAny: k` aus mindestens k Gruppen);
//   mustNotContain  — keiner dieser Begriffe darf vorkommen;
//   maxOverlapWithProfile, style — siehe lib/eval/score.js;
//   judge           — Bewertungsanweisung für einen menschlichen oder LLM-Richter.
// Begriffe mit «…» sind Muster mit Lücke. Ausgewertet in lib/eval/score.js.
// Ein Kriterium wie «ich» oder «nicht» allein misst nichts (trifft jede
// Antwort) — `validateEvalItem` verlangt mindestens ein aussagekräftiges.

const TRIVIAL = new Set(['ich', 'nicht', 'i', 'not', 'ja', 'nein', 'yes', 'no']);

// Rollenwort → Synonyme (beide Sprachen). Eine Beziehungsantwort darf die
// Rolle aus beiden Blickrichtungen nennen.
const ROLE_SYNONYMS = {
  de: {
    Ehefrau: ['Ehefrau', 'Frau', 'verheiratet', 'Gattin'], Ehemann: ['Ehemann', 'Mann', 'verheiratet', 'Gatte'],
    Ehepartner: ['Ehepartner', 'verheiratet'], Vater: ['Vater', 'Papa'], Mutter: ['Mutter', 'Mama'], Elternteil: ['Elternteil', 'Vater', 'Mutter'],
    Sohn: ['Sohn'], Tochter: ['Tochter'], Kind: ['Kind', 'Sohn', 'Tochter'], Bruder: ['Bruder'], Schwester: ['Schwester'],
    Geschwister: ['Geschwister', 'Bruder', 'Schwester'], Freund: ['Freund'], Freundin: ['Freundin'],
    'früherer Partner': ['früher', 'Ex', 'geschieden'], 'frühere Partnerin': ['früher', 'Ex', 'geschieden'],
    Geliebter: ['Geliebte', 'Affäre', 'Liebe'], Geliebte: ['Geliebte', 'Affäre', 'Liebe'],
  },
  en: {
    wife: ['wife', 'married'], husband: ['husband', 'married'], spouse: ['spouse', 'married'], father: ['father', 'dad'], mother: ['mother', 'mum', 'mom'],
    parent: ['parent', 'father', 'mother'], son: ['son'], daughter: ['daughter'], child: ['child', 'son', 'daughter'],
    brother: ['brother'], sister: ['sister'], sibling: ['sibling', 'brother', 'sister'], friend: ['friend'],
  },
};
const synonymsOf = (noun, langIsEn) => ROLE_SYNONYMS[langIsEn ? 'en' : 'de'][noun] || [noun];

// Ablehnung erkennbar: eine dieser Wendungen, «…» = Lücke (lib/eval/score.js
// #hasTerm). Zentrale Liste für Eval-Set, Regelbewertung und Richter; sie
// deckt jede Ablehnungs-Vorlage des Trains (samples/reader/refusal-text.js,
// meta-text.js, grounding-text.js) — gegated durch
// tests/unit/finetune-eval-score.test.mjs. Ein Marker, der eine richtige
// Ablehnung verfehlt («gibt es in «X» nicht» gegen «gibt es nicht»), bewertet
// eine gute Antwort als falsch.
const REFUSAL_MARKERS = {
  de: ['kommt … nicht vor', 'gibt es … nicht', 'erzähle ich nirgends', 'suchst du … vergeblich', 'ausserhalb meiner Seiten',
    'nicht die richtige Adresse', 'steht nicht in meinen Seiten', 'nicht in meinen Seiten', 'nichts in meinen Seiten', 'kenne ich nicht', 'meine Seiten nicht',
    'weiss ich nichts', 'weiss ich nicht', 'muss ich passen', 'kann ich dir nicht', 'erzählen meine Seiten nichts', 'erzählt meine geschichte nichts',
    'davon erzähle ich nicht', 'nichts zu erzählen', 'nichts zu vergleichen', 'kümmere ich mich nicht', 'kenne ich … nicht', 'gibt es bei mir … nicht'],
  en: ['does not appear', 'is not part of my story', 'does not exist', 'not in my pages', 'outside my pages', 'not the right place',
    'do not know', "don't know", 'have to pass', 'cannot give you', 'do not name', 'know nothing', 'nobody … exists', 'there is no … in',
    'say nothing about', 'never tell of', 'nothing to tell', 'nothing to compare', 'do not deal with'],
};
// Porträt-Marker: so beginnt eine erfundene Figur.
const PORTRAIT_MARKERS = {
  de: ['Randfigur', 'Nebenfigur', 'Hauptfigur', 'tritt vor allem', 'arbeitet als', 'wurde geboren', 'im Kapitel'],
  en: ['minor character', 'supporting character', 'main character', 'appears above all', 'works as', 'was born', 'in the chapter'],
};
// Marker, dass ein buchfremder Auftrag doch erledigt wurde.
const TASK_MARKERS = {
  email: { de: ['Sehr geehrte', 'Betreff', 'Freundliche Grüsse', 'Liebe Grüsse'], en: ['Dear ', 'Subject:', 'Kind regards', 'Best regards'] },
  recipe: { de: ['Zutaten', 'Gramm', 'Backofen', 'Esslöffel'], en: ['Ingredients', 'grams', 'oven', 'tablespoon'] },
  code: { de: ['def ', 'function', 'import ', 'return '], en: ['def ', 'function', 'import ', 'return '] },
  fact: { de: ['Meter', 'Prozent', 'Partei'], en: ['metres', 'meters', 'percent', 'party'] },
  plan: { de: ['Schritt 1', 'Checkliste', 'Umzugsfirma'], en: ['Step 1', 'checklist', 'moving company'] },
};

const meaningful = (term) => String(term || '').trim().length >= 3 && !TRIVIAL.has(String(term).trim().toLowerCase());

// Prüft eine Eval-Zeile: Frage vorhanden, mindestens ein aussagekräftiges
// Kriterium. Kategorien, die nur ein Richter sinnvoll bewertet (Innenleben,
// Deutung, Stil), brauchen den `judge`-Text. → null oder Grund.
const JUDGE_ONLY = new Set(['psyche', 'why', 'sceneWhy', 'continuation', 'newChapter', 'persona']);
function validateEvalItem(item) {
  if (!item?.messages?.[1]?.content) return 'noPrompt';
  const terms = [
    ...(item.mustContain || []), ...(item.mustContainAny || []).flat(), ...(item.mustNotContain || []),
  ].map(t => String(t).replace(/…/g, ' ')).filter(meaningful);
  if (terms.length) return null;
  if (JUDGE_ONLY.has(item.category) && String(item.judge || '').length >= 20) return null;
  return 'noCriterion';
}

// Eine Referenz, die einen gemeldeten Beziehungskonflikt wiederholt
// (beide Figuren + ein Verwandtschaftswort), taugt nicht als Massstab.
const KIN = /\b(vater|mutter|sohn|tochter|bruder|schwester|ehemann|ehefrau|schwager|schwägerin|schwieger\w*|father|mother|son|daughter|brother|sister|husband|wife)\b/i;
function touchesConflict(item, conflictNamePairs) {
  const text = [item.expected, ...(item.mustContain || []), ...(item.mustContainAny || []).flat()].join(' ');
  if (!KIN.test(text)) return false;
  return conflictNamePairs.some(([a, b]) => text.includes(a) && text.includes(b));
}

module.exports = {
  synonymsOf, validateEvalItem, touchesConflict, meaningful,
  REFUSAL_MARKERS, PORTRAIT_MARKERS, TASK_MARKERS, ROLE_SYNONYMS,
};
