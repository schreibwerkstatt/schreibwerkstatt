'use strict';
// Funktionswörter für die Wortschatz-Analyse — ZUSÄTZLICH zur kanonischen
// Stoppwortliste (lib/stopwords-de.js). Die Basisliste ist bewusst knapp, weil sie
// auch die seitenlokale Wiederholungs-Metrik und den Figuren-Alias-Filter speist;
// eine Erweiterung dort verschöbe deren Befunde.
//
// Hier braucht es die VOLLE Liste, aus zwei Gründen:
//   - Lexikalische Dichte (Ure/Halliday) = Inhaltswörter / alle Token. Jedes
//     Funktionswort, das die Liste nicht kennt, zählt als Inhaltswort und hebt
//     die Dichte systematisch an.
//   - Lieblingswörter: ab 4 Zeichen ohne Stoppwörter. Fehlen „sich", „diese",
//     „wieder", „konnte", führen genau diese Wörter die Liste an — kein
//     Stilbefund, sondern Grammatik.
//
// Inhalt: alle flektierten Formen von Artikeln, Pronomen und Determinativen,
// Präpositionen, Konjunktionen, Hilfs- und Modalverben (inkl. Konjunktiv),
// Partikeln und allgemeine Adverbien. Bereits ß→ss gefaltet und kleingeschrieben,
// wie der Tokenizer die Token liefert (lib/lexicon/tokenize.js).

const { foldSharpS } = require('./tokenize');

const FUNCTION_WORDS_DE = [
  // Artikel + Pronomen (alle Kasus)
  'der', 'die', 'das', 'den', 'dem', 'des', 'dessen', 'deren', 'denen', 'derer',
  'ein', 'eine', 'einer', 'einen', 'einem', 'eines',
  'kein', 'keine', 'keiner', 'keinen', 'keinem', 'keines',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man',
  'mich', 'dich', 'sich', 'uns', 'euch', 'ihn', 'ihm', 'ihnen', 'mir', 'dir',
  'mein', 'meine', 'meiner', 'meinen', 'meinem', 'meines',
  'dein', 'deine', 'deiner', 'deinen', 'deinem', 'deines',
  'sein', 'seine', 'seiner', 'seinen', 'seinem', 'seines',
  'ihre', 'ihrer', 'ihren', 'ihrem', 'ihres',
  'unser', 'unsere', 'unserer', 'unseren', 'unserem', 'unseres', 'unsren', 'unsrem',
  'euer', 'eure', 'eurer', 'euren', 'eurem', 'eures',
  'dies', 'diese', 'dieser', 'diesen', 'diesem', 'dieses',
  'jene', 'jener', 'jenen', 'jenem', 'jenes',
  'jede', 'jeder', 'jeden', 'jedem', 'jedes',
  'alle', 'aller', 'allen', 'allem', 'alles',
  'manche', 'mancher', 'manchen', 'manchem', 'manches',
  'solche', 'solcher', 'solchen', 'solchem', 'solches',
  'welche', 'welcher', 'welchen', 'welchem', 'welches',
  'derselbe', 'dieselbe', 'dasselbe', 'denselben', 'demselben', 'desselben', 'derselben',
  'selbst', 'selber', 'einander', 'etwas', 'nichts', 'jemand', 'jemanden', 'jemandem',
  'niemand', 'niemanden', 'niemandem', 'irgendwas', 'irgendwer', 'irgendein', 'irgendeine',
  'irgendeinen', 'irgendeinem', 'irgendeiner', 'irgendetwas', 'beide', 'beiden', 'beider',
  'einige', 'einiger', 'einigen', 'einigem', 'einiges', 'mehrere', 'mehreren',
  'viel', 'viele', 'vieler', 'vielen', 'vielem', 'vieles',
  'wenig', 'wenige', 'weniger', 'wenigen', 'wenigem', 'weniges',
  'mehr', 'meist', 'meisten',
  'wer', 'wen', 'wem', 'wessen', 'was',
  // Präpositionen (+ Verschmelzungen)
  'in', 'im', 'ins', 'an', 'am', 'ans', 'auf', 'aufs', 'zu', 'zum', 'zur', 'bei', 'beim',
  'mit', 'nach', 'von', 'vom', 'aus', 'über', 'überm', 'übers', 'unter', 'unterm', 'vor',
  'vorm', 'vors', 'hinter', 'hinterm', 'neben', 'zwischen', 'durch', 'durchs', 'für', 'fürs',
  'gegen', 'um', 'ums', 'ohne', 'bis', 'seit', 'während', 'wegen', 'trotz', 'statt',
  'anstatt', 'ausser', 'innerhalb', 'ausserhalb', 'oberhalb', 'unterhalb', 'entlang',
  'gegenüber', 'samt', 'nebst', 'laut', 'gemäss', 'mittels', 'dank', 'ab', 'per', 'pro',
  'via', 'binnen', 'jenseits', 'diesseits', 'zufolge', 'zwecks', 'bezüglich',
  // Konjunktionen + Subjunktionen
  'und', 'oder', 'aber', 'sondern', 'denn', 'doch', 'weil', 'dass', 'wenn', 'als', 'ob',
  'obwohl', 'obgleich', 'damit', 'sodass', 'falls', 'sofern', 'soweit', 'solange',
  'sobald', 'sowie', 'sowohl', 'weder', 'noch', 'entweder', 'nachdem', 'bevor', 'ehe',
  'indem', 'seitdem', 'wohingegen', 'wobei', 'weshalb', 'weswegen', 'wie', 'wo', 'wohin',
  'woher', 'warum', 'wann', 'wozu', 'womit', 'wovon', 'worauf', 'woran', 'worüber',
  'wodurch', 'wofür', 'wogegen', 'worin', 'woraus',
  // Hilfsverben (alle Formen inkl. Konjunktiv)
  'sein', 'bin', 'bist', 'ist', 'sind', 'seid', 'war', 'warst', 'waren', 'wart', 'gewesen',
  'wäre', 'wärst', 'wärest', 'wären', 'wäret', 'wärt', 'sei', 'seist', 'seiest', 'seien',
  'haben', 'habe', 'hast', 'hat', 'habt', 'hatte', 'hattest', 'hatten', 'hattet', 'gehabt',
  'hätte', 'hättest', 'hätten', 'hättet', 'habest', 'habet',
  'werden', 'werde', 'wirst', 'wird', 'werdet', 'wurde', 'wurdest', 'wurden', 'wurdet',
  'worden', 'geworden', 'würde', 'würdest', 'würden', 'würdet', 'werdest',
  // Modalverben (alle Formen inkl. Konjunktiv)
  'können', 'kann', 'kannst', 'könnt', 'konnte', 'konntest', 'konnten', 'konntet',
  'könnte', 'könntest', 'könnten', 'könntet', 'gekonnt',
  'müssen', 'muss', 'musst', 'müsst', 'musste', 'musstest', 'mussten', 'musstet',
  'müsste', 'müsstest', 'müssten', 'müsstet', 'gemusst',
  'dürfen', 'darf', 'darfst', 'dürft', 'durfte', 'durftest', 'durften', 'durftet',
  'dürfte', 'dürftest', 'dürften', 'dürftet', 'gedurft',
  'sollen', 'soll', 'sollst', 'sollt', 'sollte', 'solltest', 'sollten', 'solltet',
  'wollen', 'will', 'willst', 'wollt', 'wollte', 'wolltest', 'wollten', 'wolltet',
  'mögen', 'mag', 'magst', 'mögt', 'mochte', 'mochtest', 'mochten', 'mochtet',
  'möchte', 'möchtest', 'möchten', 'möchtet',
  // Partikeln + allgemeine Adverbien
  'nicht', 'auch', 'nur', 'schon', 'so', 'dann', 'dort', 'hier', 'da', 'nun', 'jetzt',
  'immer', 'nie', 'niemals', 'oft', 'manchmal', 'ja', 'nein', 'mal', 'halt', 'eben',
  'zwar', 'sehr', 'wieder', 'etwa', 'gar', 'ganz', 'eher', 'fast', 'kaum', 'bloss',
  'wohl', 'ebenso', 'ebenfalls', 'genau', 'gerade', 'sogar', 'selbst', 'überhaupt',
  'eigentlich', 'einfach', 'ziemlich', 'recht', 'zu', 'allein', 'allerdings', 'also',
  'dabei', 'dafür', 'dagegen', 'daher', 'dahin', 'damals', 'danach', 'daneben', 'daran',
  'darauf', 'daraus', 'darin', 'darüber', 'darum', 'darunter', 'davon', 'davor', 'dazu',
  'dazwischen', 'dennoch', 'deshalb', 'deswegen', 'trotzdem', 'jedoch', 'sonst', 'zudem',
  'ausserdem', 'hingegen', 'insofern', 'jedenfalls', 'zumindest', 'wenigstens', 'bereits',
  'erst', 'noch', 'stets', 'bald', 'gleich', 'sofort', 'inzwischen', 'mittlerweile',
  'zuerst', 'zuletzt', 'zunächst', 'schliesslich', 'endlich', 'irgendwie', 'irgendwo',
  'überall', 'nirgends', 'nirgendwo', 'heraus', 'herein', 'hinaus', 'hinein', 'herum',
  'hinauf', 'hinab', 'herauf', 'herab', 'hin', 'her', 'weg', 'fort', 'vorbei', 'zurück',
  'los', 'weiter', 'wenn', 'denn', 'nämlich', 'vielleicht', 'wirklich', 'natürlich',
  'freilich', 'ohnehin', 'sowieso', 'jemals', 'immerhin', 'beinahe', 'genug',
];

// Buchsprache → Stoppwort-Menge der Analyse (Basisliste + volle Funktionswortliste),
// gefaltet wie der Tokenizer. Unbekannte Sprache fällt auf Deutsch zurück — das ist
// auch der Default der Buch-Einstellungen. Memo, weil analyzeBook pro Scan fragt.
const _sets = new Map();
function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'de';
}
function stopwordsFor(language) {
  const lang = normalizeLanguage(language);
  let set = _sets.get(lang);
  if (!set) {
    const words = lang === 'en'
      ? [...require('../stopwords-en').STOPWORDS_EN_BASE, ...require('./function-words-en').FUNCTION_WORDS_EN]
      : [...require('../stopwords-de').STOPWORDS_DE_BASE, ...FUNCTION_WORDS_DE];
    set = new Set(words.map(w => foldSharpS(w.toLowerCase())));
    _sets.set(lang, set);
  }
  return set;
}

module.exports = { FUNCTION_WORDS_DE, normalizeLanguage, stopwordsFor };
