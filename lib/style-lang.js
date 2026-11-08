'use strict';
// Sprachabhängige Teile der Stil-Metriken (lib/page-index.js#computeStyleStats,
// #computePronounsAndDialog): Füllwörter, Adverb-Heuristik, Passiv-Erkennung,
// Silbenzählung + Flesch-Formel und Pronomen-Gruppen. Je Buchsprache ein Profil;
// `styleProfile(language)` wählt es ('en' → Englisch, alles andere → Deutsch).
//
// Die Gruppen-SCHLÜSSEL der Pronomen sind sprachunabhängig (ich, du, er, sie_sg,
// wir, ihr_pl, man): Ich-Anteil (lib/stil-heatmap.js) und Pronomen-Werkzeug der
// agentischen Chats (routes/jobs/chat-tools/tools-figures.js) lesen dieselben
// Schlüssel, egal in welcher Sprache das Buch geschrieben ist.
//
// Änderung an einer Liste oder Regel ⇒ METRICS_VERSION in lib/page-index.js erhöhen.

// ── Deutsch ──────────────────────────────────────────────────────────────────

// Pronomen-Gruppen: jede Gruppe ist eine Liste regulärer Wortformen.
// Der Index speichert pro Schlüssel (Gruppe) getrennt `narr` und `dlg`.
const PRONOUN_GROUPS_DE = {
  ich:     ['ich', 'mich', 'mir', 'mein', 'meine', 'meiner', 'meines', 'meinem', 'meinen'],
  du:      ['du', 'dich', 'dir', 'dein', 'deine', 'deiner', 'deines', 'deinem', 'deinen'],
  er:      ['er', 'ihn', 'ihm', 'sein', 'seine', 'seiner', 'seines', 'seinem', 'seinen'],
  sie_sg:  ['sie', 'ihr', 'ihre', 'ihrer', 'ihres', 'ihrem', 'ihren'],
  wir:     ['wir', 'uns', 'unser', 'unsere', 'unserer', 'unseres', 'unserem', 'unseren'],
  ihr_pl:  ['ihr', 'euch', 'euer', 'eure', 'eurer', 'eures', 'eurem', 'euren'],
  man:     ['man'],
};

// Kuratierte Füllwörter-Liste DE. Heuristisch: viele sind im Dialog legitim,
// im erzählenden Text aber oft tilgbar. Die Metrik zählt Vorkommen absolut;
// UI zeigt Dichte pro 1000 Wörter und macht sie vergleichbar (nicht absolut «schlecht»).
const FILLER_WORDS_DE = new Set([
  'eigentlich', 'halt', 'einfach', 'irgendwie', 'irgendwo', 'irgendwas', 'irgendwer',
  'quasi', 'sozusagen', 'praktisch', 'buchstäblich', 'regelrecht', 'schlichtweg',
  'gewissermaßen', 'gewissermassen', 'schließlich', 'schliesslich', 'letztendlich',
  'wirklich', 'sehr', 'total', 'ganz', 'ziemlich', 'eher', 'wohl', 'etwa',
  'vielleicht', 'bestimmt', 'natürlich', 'offensichtlich', 'offenbar', 'eventuell',
  'tatsächlich', 'durchaus', 'ohnehin', 'sowieso', 'anscheinend', 'vermutlich',
]);

// Adverbien – häufige feste Formen + Suffix-Heuristik in _isAdverbDe.
const ADVERB_WORDS_DE = new Set([
  'sehr', 'gern', 'gerne', 'oft', 'manchmal', 'immer', 'nie', 'niemals', 'selten',
  'hier', 'dort', 'dorthin', 'dahin', 'da', 'drüben', 'drinnen', 'draussen', 'draußen',
  'heute', 'gestern', 'morgen', 'jetzt', 'bald', 'gleich', 'soeben', 'damals', 'einst',
  'wirklich', 'tatsächlich', 'kaum', 'fast', 'beinahe', 'ungefähr', 'etwa',
  'plötzlich', 'langsam', 'schnell', 'sofort', 'allmählich', 'nachher', 'vorher',
  'ziemlich', 'durchaus', 'völlig', 'gänzlich', 'nahezu', 'überwiegend', 'vorwiegend',
]);

function _isAdverbDe(word) {
  const w = word.toLowerCase();
  if (ADVERB_WORDS_DE.has(w)) return true;
  // Typische Adverbial-Suffixe. Mindestlänge 5 verhindert Überzählen von kurzen Wörtern.
  if (w.length < 5) return false;
  if (w.endsWith('weise')) return true;
  if (w.endsWith('erweise')) return true;
  if (w.endsWith('mals')) return true;
  if (w.endsWith('wärts')) return true;
  if (w.endsWith('halber')) return true;
  return false;
}

// Deutsches Vollverb-Passiv: Form von "werden" + Partizip II.
// Heuristik: Form von "werden" (ohne Wortgrenze nach Hilfsverb-Kontext zu prüfen).
// Passiv-Form: "wurde/wurden/wird/werden/worden". "werden" als Infinitiv/Futur wird mitgezählt – bewusst,
// um die Kennzahl robust zu halten; im UI wird sie als "werden-Konstruktionen" gelabelt, nicht als harter Passiv-Anteil.
const _PASSIVE_RE_DE = /(?<![A-Za-zÄÖÜäöüß])(wurde|wurden|wird|werden|worden|ward)(?![A-Za-zÄÖÜäöüß])/gi;

/** Passiv-Treffer als [{ index, token }] in Textreihenfolge. */
function _findPassivesDe(text) {
  const out = [];
  _PASSIVE_RE_DE.lastIndex = 0;
  let pm;
  while ((pm = _PASSIVE_RE_DE.exec(text)) !== null) out.push({ index: pm.index, token: pm[1] });
  return out;
}

// Endungs-Silben die oft falsch gezählt werden — stumme -e am Wortende bei einigen Mustern.
// Pragmatisch ignoriert; Amstad-Flesch reagiert vor allem auf langer Wörter/langer Sätze.
function _countSyllablesDe(word) {
  const w = word.toLowerCase().replace(/[^a-zäöüß]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 2) return 1;
  const groups = w.match(/[aeiouäöüy]+/g);
  return groups ? groups.length : 1;
}

// Flesch (Amstad, deutsche Adaption): 180 - ASL - 58.5·ASW.
// ASL = Wörter/Sätze, ASW = Silben/Wörter. Höher = leichter.
function _fleschDe(asl, asw) {
  return 180 - asl - (58.5 * asw);
}

// ── Englisch ─────────────────────────────────────────────────────────────────

// Dieselben Gruppen-Schlüssel wie Deutsch. `they` steht wie das deutsche „sie"
// (Plural) in `sie_sg`: die 3. Person umfasst in beiden Sprachen Singular und
// Plural, so wie die 1. Person `ich` + `wir` umfasst. `you` ist Singular und
// Plural zugleich und zählt als `du`; nur `yourselves` ist eindeutig `ihr_pl`.
// „one" ist fast immer das Zahlwort, darum nur `oneself` in `man`.
const PRONOUN_GROUPS_EN = {
  ich:     ['i', 'me', 'my', 'mine', 'myself'],
  du:      ['you', 'your', 'yours', 'yourself'],
  er:      ['he', 'him', 'his', 'himself'],
  sie_sg:  ['she', 'her', 'hers', 'herself', 'they', 'them', 'their', 'theirs', 'themselves', 'themself'],
  wir:     ['we', 'us', 'our', 'ours', 'ourselves'],
  ihr_pl:  ['yourselves'],
  man:     ['oneself'],
};

// Füllwörter EN, gleicher Zuschnitt wie DE: Abtönung, Verstärker, Relativierer,
// Einschätzungs-Adverbien. Mehrwortfügungen („kind of", „sort of") zählt der
// Wort-Scan nicht.
const FILLER_WORDS_EN = new Set([
  'just', 'really', 'very', 'actually', 'basically', 'somehow', 'quite', 'rather',
  'simply', 'literally', 'totally', 'completely', 'absolutely', 'definitely',
  'certainly', 'probably', 'perhaps', 'maybe', 'apparently', 'obviously', 'seemingly',
  'essentially', 'practically', 'virtually', 'truly', 'utterly', 'somewhat', 'fairly',
  'merely', 'indeed', 'anyway', 'anyhow', 'naturally', 'presumably', 'possibly',
  'ultimately', 'downright', 'honestly', 'seriously',
]);

// Adverbien ohne -ly (Gegenstück zu ADVERB_WORDS_DE: Zeit, Ort, Häufigkeit, Grad).
// `there`/`then` fehlen bewusst: „there is" und „and then" sind Gerüst, kein Stil.
const ADVERB_WORDS_EN = new Set([
  'very', 'often', 'sometimes', 'always', 'never', 'seldom', 'here', 'now', 'today',
  'yesterday', 'tomorrow', 'soon', 'already', 'almost', 'quite', 'rather', 'somewhat',
  'perhaps', 'maybe', 'meanwhile', 'afterwards', 'afterward', 'beforehand',
  'everywhere', 'somewhere', 'nowhere', 'anywhere', 'abroad', 'upstairs', 'downstairs',
  'indoors', 'outdoors', 'backwards', 'forwards', 'upwards', 'downwards', 'onwards',
  'outwards', 'inwards', 'homewards', 'sideways', 'altogether', 'anyway',
]);

// Wörter auf -ly, die keine Adverbien sind (Adjektive, Nomen, Verben, Namen) —
// oder als Adjektiv häufiger als als Adverb (early, daily, likely).
const EN_LY_NON_ADVERBS = new Set([
  'only', 'early', 'daily', 'weekly', 'monthly', 'yearly', 'hourly', 'nightly', 'likely',
  'unlikely', 'family', 'reply', 'apply', 'supply', 'comply', 'imply', 'multiply', 'rely',
  'ally', 'belly', 'bully', 'gully', 'jelly', 'rally', 'tally', 'dally', 'sully', 'folly',
  'holly', 'jolly', 'lolly', 'dolly', 'golly', 'assembly', 'anomaly', 'monopoly', 'homily',
  'melancholy', 'butterfly', 'dragonfly', 'firefly', 'housefly', 'holy', 'ugly', 'lonely',
  'lovely', 'lively', 'friendly', 'unfriendly', 'silly', 'chilly', 'hilly', 'curly',
  'burly', 'surly', 'elderly', 'costly', 'deadly', 'manly', 'womanly', 'motherly',
  'fatherly', 'brotherly', 'sisterly', 'cowardly', 'scholarly', 'orderly', 'disorderly',
  'worldly', 'heavenly', 'ghostly', 'ghastly', 'beastly', 'priestly', 'stately', 'comely',
  'homely', 'unseemly', 'unruly', 'lowly', 'timely', 'untimely', 'leisurely', 'shapely',
  'sickly', 'prickly', 'wrinkly', 'bubbly', 'wobbly', 'cuddly', 'gnarly', 'pearly',
  'grizzly', 'measly', 'steely', 'woolly', 'wooly', 'frilly', 'kindly', 'gangly',
  'portly', 'courtly', 'saintly', 'princely', 'queenly', 'kingly', 'godly', 'ungodly',
  'italy', 'july', 'emily', 'lily', 'kelly', 'sally', 'molly', 'polly', 'billy', 'shelly',
  'beverly', 'wally',
]);

function _isAdverbEn(word) {
  const w = word.toLowerCase();
  if (ADVERB_WORDS_EN.has(w)) return true;
  // -ly ist das produktive Adverb-Suffix; Mindestlänge 5 lässt „fly", „only" & Co. aus.
  if (w.length < 5) return false;
  if (w.endsWith('ly')) return !EN_LY_NON_ADVERBS.has(w);
  // Gegenstück zu DE -weise: otherwise, likewise, clockwise (nicht „wise", „unwise").
  if (w.length >= 7 && w.endsWith('wise')) return true;
  return false;
}

// Englisches Passiv: Form von „be" oder „get" + Partizip II, dazwischen höchstens
// zwei Gradwörter oder -ly-Adverbien („was never told", „were quickly taken").
// Partizip = regelmässig auf -ed oder aus der Liste unregelmässiger Formen.
// Präziser als die DE-Heuristik (die jede werden-Form zählt): Zustandsadjektive
// auf -ed („was tired", „is interested") und -ed-Wörter, die kein Partizip sind
// („was naked"), zählen nicht.
const _EN_AUX = 'am|is|are|was|were|be|been|being|get|gets|got|gotten|getting';
const _EN_MID = '(?:not|never|also|already|just|still|often|always|all|both|then|soon|even|only|ever|later|first|again|once|well|\\p{L}+ly)';
const _PASSIVE_RE_EN = new RegExp(
  `(?<!\\p{L})(${_EN_AUX})(?:n['’]t)?(?:\\s+${_EN_MID}){0,2}\\s+(\\p{L}+)(?!\\p{L})`,
  'giu'
);

const EN_IRREGULAR_PARTICIPLES = new Set([
  'told', 'given', 'taken', 'seen', 'known', 'shown', 'made', 'done', 'found', 'left',
  'held', 'kept', 'brought', 'bought', 'caught', 'taught', 'thought', 'sought', 'built',
  'sent', 'spent', 'lent', 'meant', 'felt', 'heard', 'said', 'paid', 'laid', 'led', 'fed',
  'bred', 'met', 'won', 'lost', 'sold', 'written', 'driven', 'ridden', 'hidden', 'bitten',
  'beaten', 'eaten', 'forgotten', 'forgiven', 'frozen', 'chosen', 'broken', 'spoken',
  'stolen', 'woken', 'worn', 'torn', 'born', 'borne', 'sworn', 'drawn', 'grown', 'thrown',
  'blown', 'flown', 'sewn', 'sown', 'shaken', 'begun', 'sung', 'rung', 'sunk', 'struck',
  'stricken', 'hung', 'spun', 'shot', 'cut', 'hit', 'hurt', 'put', 'set', 'shut', 'let',
  'cast', 'bound', 'ground', 'wound', 'fought', 'understood', 'overheard', 'overtaken',
  'undertaken', 'withdrawn', 'forbidden', 'overcome', 'overthrown', 'slain', 'bent', 'lit',
  'dealt', 'burnt', 'swept', 'dug', 'split', 'spread', 'upheld', 'withheld', 'misled',
  'misunderstood', 'rebuilt', 'rewritten', 'undone', 'proven', 'woven', 'trodden',
  'forsaken', 'strewn', 'shorn', 'stung', 'flung', 'wrung', 'mown', 'hewn',
]);

// -ed-Wörter, die nach „be/get" Zustandsadjektiv oder gar kein Partizip sind.
const EN_ED_NON_PASSIVE = new Set([
  // Zustandsadjektive (Gefühl, Lage) — „I was tired" ist kein Vorgang.
  'tired', 'excited', 'interested', 'bored', 'scared', 'worried', 'surprised', 'pleased',
  'married', 'supposed', 'used', 'concerned', 'involved', 'ashamed', 'amazed', 'annoyed',
  'confused', 'convinced', 'determined', 'disappointed', 'embarrassed', 'exhausted',
  'frightened', 'terrified', 'satisfied', 'relieved', 'delighted', 'thrilled', 'shocked',
  'stunned', 'puzzled', 'horrified', 'alarmed', 'astonished', 'depressed', 'devastated',
  'disgusted', 'irritated', 'overwhelmed', 'startled', 'bewildered', 'fascinated',
  'intrigued', 'tempted', 'inclined', 'entitled', 'agitated', 'acquainted', 'related',
  'experienced', 'qualified', 'talented', 'gifted', 'renowned', 'reserved', 'tangled',
  // Kein Partizip, endet nur auf -ed.
  'naked', 'wicked', 'sacred', 'beloved', 'crooked', 'rugged', 'jagged', 'ragged',
  'wretched', 'hundred', 'kindred', 'indeed', 'speed', 'steed', 'greed', 'breed', 'bleed',
  'creed', 'tweed', 'need', 'feed', 'seed', 'weed', 'deed', 'heed', 'reed', 'shed', 'sled',
  'bed', 'red', 'wed', 'sped', 'fled',
]);

function _isParticipleEn(word) {
  const w = word.toLowerCase();
  if (EN_IRREGULAR_PARTICIPLES.has(w)) return true;
  if (EN_ED_NON_PASSIVE.has(w)) return false;
  return w.length >= 4 && w.endsWith('ed');
}

/** Passiv-Treffer als [{ index, token }] — Token = Hilfsverb + Partizip
 *  („was taken"), damit der Drilldown gleiche Konstruktionen gruppiert. */
function _findPassivesEn(text) {
  const out = [];
  _PASSIVE_RE_EN.lastIndex = 0;
  let m;
  while ((m = _PASSIVE_RE_EN.exec(text)) !== null) {
    if (_isParticipleEn(m[2])) {
      out.push({ index: m.index, token: `${m[1]} ${m[2]}` });
    } else {
      // Kein Partizip: hinter dem Hilfsverb weitersuchen, sonst ginge
      // „was being told" verloren (being wäre als Partizip-Kandidat verbraucht).
      _PASSIVE_RE_EN.lastIndex = m.index + m[1].length;
    }
  }
  return out;
}

// Silbenzählung EN: Vokalgruppen, vorher stumme Endungen ab — -e (make, aber
// nicht -le: table), -es (makes, aber nicht boxes/horses), -ed (walked, aber nicht
// wanted/ended). Führendes y ist Konsonant (yellow).
function _countSyllablesEn(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  w = w
    .replace(/([^aeiouyslxzcgh])es$/, '$1')
    .replace(/([^aeioutd])ed$/, '$1')
    .replace(/([^laeiouy])e$/, '$1')
    .replace(/^y/, '');
  const groups = w.match(/[aeiouy]+/g);
  return groups ? groups.length : 1;
}

// Flesch Reading Ease (Flesch 1948): 206.835 − 1.015·ASL − 84.6·ASW. Höher = leichter.
function _fleschEn(asl, asw) {
  return 206.835 - (1.015 * asl) - (84.6 * asw);
}

// ── Profile ──────────────────────────────────────────────────────────────────

// Flache Liste aller Wortformen → Gruppe, zur schnellen Zuordnung beim Scan.
function _wordToGroup(groups) {
  const m = new Map();
  for (const [grp, words] of Object.entries(groups)) {
    for (const w of words) {
      // sie/ihr sind mehrdeutig (sie_sg/sie_pl, ihr_sg/ihr_pl). Wir klassifizieren
      // sie bewusst als `sie_sg` bzw. `ihr_pl` — Disambiguierung pro Kontext wäre
      // unzuverlässig. Die Fragen „Ich-Erzähler", „Du-Erzähler" sind robust,
      // Er-/Sie-Fragen muss der Agent mit dem Hinweis auf diese Mehrdeutigkeit beantworten.
      if (!m.has(w)) m.set(w, grp);
    }
  }
  return m;
}

const PROFILE_DE = Object.freeze({
  language: 'de',
  pronounGroups: PRONOUN_GROUPS_DE,
  wordToGroup: _wordToGroup(PRONOUN_GROUPS_DE),
  fillerWords: FILLER_WORDS_DE,
  isAdverb: _isAdverbDe,
  findPassives: _findPassivesDe,
  countSyllables: _countSyllablesDe,
  flesch: _fleschDe,
});

const PROFILE_EN = Object.freeze({
  language: 'en',
  pronounGroups: PRONOUN_GROUPS_EN,
  wordToGroup: _wordToGroup(PRONOUN_GROUPS_EN),
  fillerWords: FILLER_WORDS_EN,
  isAdverb: _isAdverbEn,
  findPassives: _findPassivesEn,
  countSyllables: _countSyllablesEn,
  flesch: _fleschEn,
});

/** Profil der Buchsprache; unbekannt/leer → Deutsch. */
function styleProfile(language) {
  return language === 'en' ? PROFILE_EN : PROFILE_DE;
}

module.exports = {
  styleProfile,
  PRONOUN_GROUPS_DE,
  PRONOUN_GROUPS_EN,
  // Für Tests der Einzelregeln.
  _countSyllablesEn,
  _isAdverbEn,
  _isParticipleEn,
};
