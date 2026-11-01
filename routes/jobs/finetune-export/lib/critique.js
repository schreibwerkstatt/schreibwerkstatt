'use strict';

// Lektorats-Sprache in Antworten erkennen. Ein Leser-Modell, das auf «Was
// passiert in X?» mit «bleibt aber reines Telling, eine kurze Szene würde …»
// antwortet, hat den Werkstatt-Ton gelernt statt des Inhalts. Die Sampler
// nehmen Lektorats- und Bewertungsfelder (`figure_scenes.kommentar`,
// `chapter_reviews`) gar nicht erst als Inhalt; dieser Filter ist das
// Schutznetz dahinter (finalize.js, Zähler `critiqueDropped`).
//
// Bewusst eng: Muster, die über einen *Text* urteilen («die Szene wirkt …»,
// «würde … stärker»), nicht über eine Figur («Er wirkt wie ein Fremder» ist
// Inhalt). Konfigurierbar über `opts.critiquePatterns` (Liste von
// Regex-Quellen, case-insensitive), sonst gilt DEFAULT_CRITIQUE_PATTERNS.

const TEXT_NOUNS = '(?:Szene|Passage|Abschnitt|Kapitel|Dialog|Dialoge|Text|Beschreibung|Darstellung|Figurenzeichnung|Erzählung|Einstieg|Ende|Schluss|Absatz|scene|passage|section|chapter|dialogue|text|description|portrayal|opening|ending)';

const DEFAULT_CRITIQUE_PATTERNS = [
  // «würde … stärker/wirksamer/greifbarer»: der Verbesserungsvorschlag.
  '\\bwürden?\\b[^.!?]{0,80}\\b(?:stärker|wirksamer|greifbarer|eindringlicher|lebendiger|überzeugender|anschaulicher|plastischer|spannender|klarer|besser)\\b',
  // «bleibt aber» nur mit Urteil dahinter — «bleibt aber bei ihrer Familie» ist Inhalt.
  '\\bbleibt aber\\b[^.!?]{0,40}\\b(?:blass|vage|abstrakt|behauptet|oberflächlich|unklar|flach|schematisch|reines?|Telling|thesenhaft|distanziert|konturlos|ungenutzt|unterentwickelt|skizzenhaft)',
  `\\b(?:die|diese|der|das|dieser|dieses)\\s+${TEXT_NOUNS}\\b[^.!?]{0,60}\\bwirkt\\b`,
  `\\b${TEXT_NOUNS}\\s+wirkt\\s+wie\\b`,
  '\\breine[sn]?\\s+Telling\\b',
  '\\bshow(?:,)?\\s+(?:statt|vs\\.?|don\'?t)\\s+tell',
  '\\bFüllstoff\\b',
  '\\bthesenhaft\\b',
  '\\bSpannung\\s+(?:zu\\s+)?(?:erhöhen|steigern|aufbauen)\\b',
  '\\bVerbesserung(?:shinweis|svorschlag)?\\s*:',
  '\\bkönnte\\s+(?:man|der Autor|die Autorin)\\b',
  '\\b(?:Tempo|Spannungsbogen|Figurenentwicklung)\\b[^.!?]{0,40}\\b(?:fehlt|leidet|schwach|stockt|zu langsam)\\b',
  `\\b${TEXT_NOUNS}\\b[^.!?]{0,30}\\bstatisch\\b`,
  '\\b(?:Die|Diese)\\s+Szene\\s+(?:etabliert|dient|funktioniert|lebt|leidet|bleibt|trägt|überzeugt|krankt)\\b',
  '\\bnur\\s+zusammengefasst\\b',
  '\\bohne\\s+Bild\\s+erzählt\\b',
  '\\bkurze,?\\s+konkrete\\s+Szene\\b',
  // Englische Bücher
  '\\bwould\\s+(?:be\\s+)?(?:stronger|more effective|more vivid|more compelling|clearer)\\b',
  '\\b(?:pure|mere)\\s+telling\\b',
  '\\bfiller\\b',
  '\\bthe\\s+scene\\s+(?:establishes|serves|works|feels|suffers|drags)\\b',
  '\\bto\\s+(?:raise|increase|heighten)\\s+(?:the\\s+)?tension\\b',
];

function makeCritiqueRegex(patterns) {
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_CRITIQUE_PATTERNS;
  return new RegExp(list.map(p => `(?:${p})`).join('|'), 'iu');
}

const DEFAULT_RE = makeCritiqueRegex();

function isCritique(text, re = DEFAULT_RE) {
  return re.test(String(text || ''));
}

module.exports = { DEFAULT_CRITIQUE_PATTERNS, makeCritiqueRegex, isCritique };
