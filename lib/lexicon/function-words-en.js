'use strict';
// Funktionswörter für die Wortschatz-Analyse englischer Bücher — ZUSÄTZLICH zur
// Basisliste lib/stopwords-en.js. Begründung wie in function-words.js: die
// lexikalische Dichte zählt jedes unbekannte Funktionswort als Inhaltswort, und
// die Lieblingswörter (ab 4 Zeichen) würden sonst von „that", „would", „there"
// angeführt — Grammatik, kein Stilbefund.
//
// Inhalt: Artikel, Pronomen (alle Kasus + Reflexiva), Determinative und
// Quantoren, Präpositionen, Konjunktionen, Hilfs- und Modalverben inkl.
// Kontraktionen und Partikeln/allgemeine Adverbien. Kleingeschrieben, Apostroph
// gerade — so liefert der Tokenizer die Token (lib/lexicon/tokenize.js).

const FUNCTION_WORDS_EN = [
  // Artikel + Pronomen
  'the', 'a', 'an',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'one',
  'me', 'him', 'her', 'us', 'them',
  'my', 'mine', 'your', 'yours', 'his', 'hers', 'its', 'our', 'ours', 'their', 'theirs',
  'myself', 'yourself', 'yourselves', 'himself', 'herself', 'itself', 'ourselves',
  'themselves', 'oneself',
  'this', 'that', 'these', 'those',
  'who', 'whom', 'whose', 'which', 'what', 'whoever', 'whatever', 'whichever', 'whomever',
  // Determinative + Quantoren
  'all', 'any', 'both', 'each', 'either', 'neither', 'every', 'some', 'such', 'no', 'none',
  'few', 'fewer', 'many', 'much', 'more', 'most', 'less', 'least', 'several', 'other',
  'others', 'another', 'own', 'same',
  'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything', 'everyone',
  'everybody', 'everything', 'nobody', 'nothing', 'noone',
  // Präpositionen
  'in', 'on', 'at', 'to', 'of', 'for', 'with', 'from', 'by', 'about', 'into', 'onto',
  'upon', 'over', 'under', 'above', 'below', 'before', 'after', 'behind', 'beside',
  'besides', 'between', 'among', 'amongst', 'through', 'throughout', 'against', 'around',
  'across', 'along', 'alongside', 'beyond', 'within', 'without', 'toward', 'towards',
  'until', 'till', 'since', 'during', 'despite', 'except', 'inside', 'outside', 'near',
  'off', 'out', 'up', 'down', 'via', 'per', 'like', 'unlike', 'beneath', 'underneath',
  'past', 'regarding', 'concerning',
  // Konjunktionen + Subjunktionen
  'and', 'or', 'but', 'nor', 'yet', 'so', 'because', 'although', 'though', 'while',
  'whilst', 'whereas', 'if', 'unless', 'whether', 'than', 'as', 'once', 'whenever',
  'wherever', 'when', 'where', 'why', 'how', 'however', 'therefore', 'thus', 'hence',
  // Hilfsverben
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'done', 'doing',
  // Modalverben
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'ought',
  // Kontraktionen
  "i'm", "i've", "i'd", "i'll", "you're", "you've", "you'd", "you'll",
  "he's", "he'd", "he'll", "she's", "she'd", "she'll", "it's", "it'd", "it'll",
  "we're", "we've", "we'd", "we'll", "they're", "they've", "they'd", "they'll",
  "that's", "that'd", "that'll", "there's", "there'd", "there'll", "here's",
  "what's", "who's", "where's", "when's", "why's", "how's", "let's",
  "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't",
  "don't", "doesn't", "didn't", "won't", "wouldn't", "shan't", "shouldn't",
  "can't", "cannot", "couldn't", "mightn't", "mustn't", "needn't", "oughtn't",
  // Partikeln + allgemeine Adverbien
  'not', 'also', 'still', 'only', 'just', 'already', 'even', 'very', 'too', 'quite',
  'rather', 'almost', 'nearly', 'hardly', 'barely', 'merely', 'simply', 'really',
  'perhaps', 'maybe', 'indeed', 'else', 'again', 'ever', 'never', 'always', 'often',
  'sometimes', 'usually', 'seldom', 'then', 'there', 'here', 'now', 'soon', 'later',
  'once', 'twice', 'away', 'back', 'yes', 'well', 'anyway', 'somehow', 'somewhere',
  'anywhere', 'everywhere', 'nowhere', 'thereby', 'therein', 'thereof', 'whereby',
  'instead', 'otherwise', 'meanwhile', 'moreover', 'furthermore', 'nevertheless',
  'nonetheless', 'besides', 'enough', 'about', 'own',
];

module.exports = { FUNCTION_WORDS_EN };
