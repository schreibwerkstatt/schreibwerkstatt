'use strict';
// Kanonische EN-Stoppwortliste — Gegenstück zu lib/stopwords-de.js für Bücher
// mit `book_settings.language = 'en'`. Gleiche Rolle, gleiche Knappheit: sie
// speist die seitenlokale Wiederholungs-Metrik (lib/page-index.js) und ist die
// Basis der vollen Funktionswortliste der Wortschatz-Analyse
// (lib/lexicon/function-words-en.js). Kein Client-Spiegel: der Figur-Alias-Filter
// im Frontend arbeitet nur mit der DE-Liste.
//
// Kontraktionen stehen mit geradem Apostroph — der Tokenizer behält sie als ein
// Token und faltet ’ auf ' (lib/lexicon/tokenize.js).

const STOPWORDS_EN_BASE = [
  'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'because', 'that', 'if', 'than', 'whether',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'this', 'these', 'those',
  'in', 'on', 'at', 'to', 'of', 'for', 'with', 'from', 'by', 'about', 'into', 'onto',
  'over', 'under', 'before', 'after', 'behind', 'between', 'through', 'against', 'around',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'having',
  'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'nothing', 'also', 'still', 'only', 'just', 'already',
  'so', 'as', 'what', 'who', 'whom', 'where', 'why', 'when', 'how', 'which',
  'then', 'there', 'here', 'now', 'always', 'never', 'often', 'sometimes',
  'yes', 'well', 'even', 'very',
  "don't", "didn't", "doesn't", "can't", "couldn't", "won't", "wouldn't", "isn't", "wasn't",
  "aren't", "weren't", "it's", "i'm", "you're", "he's", "she's", "we're", "they're", "that's",
  "there's", "i've", "i'd", "i'll",
];

module.exports = { STOPWORDS_EN_BASE };
