'use strict';
// Deterministische Erkennung von Alters- und Jahresangaben im Buchtext.
//
// ARBEITSTEILUNG mit dem Modell (dieselbe Trennung wie bei der Quellen-Erkennung,
// siehe routes/jobs/source-detect.js):
//   1. Dieses Modul waehlt KANDIDATENSAETZE aus — Saetze, in denen eine Figur
//      vorkommt UND eine Alters-/Jahresangabe steht. Es darf grosszuegig sein:
//      ein Fehlfund kostet ein paar Tokens im Prompt, ein verpasster Satz kostet
//      die Aussage.
//   2. Das Modell liest diese Saetze und sagt, WAS sie ueber die Figur behaupten
//      (Alter, Geburtsjahr, Bezugsjahr) — es sieht Kontext, den kein Muster sieht
//      ("drei Jahre spaeter", "an ihrem sechzehnten Geburtstag").
//   3. Die Zahlen dieses Moduls sind hinterher die PRUEFGROESSE: eine Zahl, die
//      das Modell nennt, die aber in seinem eigenen woertlichen Zitat gar nicht
//      vorkommt, ist erfunden und faellt heraus (lib/figure-age/consolidate.js).
//
// Rein rueckwaertsgewandt: liest Text, schreibt nie in ihn.

// ── Zahlwoerter ──────────────────────────────────────────────────────────────
// Ein Roman schreibt Alter meist aus ("die zwoelfjaehrige Anna"), Sachtexte
// ziffern es. Beides muss greifen.
const NUM_WORDS = {
  ein: 1, eine: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6,
  sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13,
  vierzehn: 14, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18,
  neunzehn: 19, zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50,
  sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100,
};
// Unregelmaessige Ordinalstaemme ("an ihrem dritten Geburtstag").
const ORDINAL_IRREGULAR = { erst: 1, dritt: 3, siebt: 7, acht: 8 };
const TENS = ['zwanzig', 'dreissig', 'vierzig', 'fuenfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
const ONES = ['ein', 'zwei', 'drei', 'vier', 'fuenf', 'sechs', 'sieben', 'acht', 'neun'];

/** Umlaute/ß auf die ASCII-Vergleichsform falten (dieselbe Schweizer Norm wie
 *  lib/lexicon/tokenize.js: ß → ss). Nur fuer den Wortlisten-Lookup, nie fuer
 *  die Anzeige. */
function foldWord(s) {
  return String(s ?? '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

/** Zahlwort → Zahl. Deckt "einundzwanzig"-Komposita mit ab. null, wenn das Wort
 *  keine Zahl ist. */
function germanNumberWord(word) {
  const w = foldWord(word);
  if (!w) return null;
  if (Object.prototype.hasOwnProperty.call(NUM_WORDS, w)) return NUM_WORDS[w];
  const m = /^(ein|zwei|drei|vier|fuenf|sechs|sieben|acht|neun)und(zwanzig|dreissig|vierzig|fuenfzig|sechzig|siebzig|achtzig|neunzig)$/.exec(w);
  if (m) return NUM_WORDS[m[1]] + NUM_WORDS[m[2]];
  return null;
}

/** Ordinalwort ("sechzehnten", "dritten", "achten") → Zahl.
 *  Mehrere Staemme probieren statt einer Abschneide-Regel: die deutschen
 *  Ordinalzahlen sind teils regelmaessig ("sechzehn|ten"), teils nicht
 *  ("dritt|en", "siebt|en") — eine einzige Suffix-Regel trifft immer nur eine
 *  der beiden Gruppen. */
function germanOrdinalWord(word) {
  const w = foldWord(word);
  if (!w) return null;
  const cands = [w];
  for (const suf of ['sten', 'ten', 'stem', 'tem', 'ster', 'ter', 'stes', 'tes', 'ste', 'te', 'en', 'em', 'er', 'es', 'e']) {
    if (w.endsWith(suf) && w.length > suf.length) cands.push(w.slice(0, -suf.length));
  }
  for (const c of cands) {
    if (Object.prototype.hasOwnProperty.call(ORDINAL_IRREGULAR, c)) return ORDINAL_IRREGULAR[c];
  }
  for (const c of cands) {
    const n = germanNumberWord(c);
    if (n != null) return n;
  }
  return null;
}

// Alternation aller Zahlwoerter in Original-Schreibweise (Umlaut-Varianten
// eingeschlossen), damit die Muster unten sie direkt greifen koennen.
const WORD_FORMS = (() => {
  const forms = new Set();
  const add = (s) => { forms.add(s); };
  for (const k of Object.keys(NUM_WORDS)) add(k);
  // Umlaut-Rueckformen: die Tabelle ist gefaltet gespeichert, der Text nicht.
  for (const [a, b] of [['fuenf', 'fünf'], ['zwoelf', 'zwölf'], ['dreissig', 'dreissig'], ['dreissig', 'dreißig']]) {
    if (forms.has(a)) add(b);
  }
  for (const t of TENS) for (const o of ONES) add(`${o}und${t}`);
  // Umlaut-Komposita ("fuenfundzwanzig" → "fünfundzwanzig", "…dreissig/dreißig")
  const extra = [];
  for (const f of forms) {
    if (f.includes('fuenf')) extra.push(f.replace(/fuenf/g, 'fünf'));
    if (f.includes('zwoelf')) extra.push(f.replace(/zwoelf/g, 'zwölf'));
    if (f.includes('dreissig')) extra.push(f.replace(/dreissig/g, 'dreißig'));
  }
  for (const e of extra) add(e);
  // Laengste zuerst — sonst greift "ein" in "einundzwanzig".
  return [...forms].sort((a, b) => b.length - a.length);
})();
const WORD_ALT = WORD_FORMS.join('|');
// Ohne die Artikel-Formen "ein"/"eine": im Kopula-Muster ("war ein …") meinen sie
// fast nie ein Alter, und das Muster griffe sonst in jedem zweiten Satz.
const WORD_ALT_NO_ART = WORD_FORMS.filter(w => w !== 'ein' && w !== 'eine').join('|');

// Englische Zahlwoerter (book_settings.language = en): "twelve years old",
// "she was twelve", "twenty-one".
const EN_NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const EN_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const EN_WORD_FORMS = (() => {
  const forms = new Set(Object.keys(EN_NUM_WORDS));
  for (const t of EN_TENS) for (const o of EN_ONES) { forms.add(`${t}-${o}`); forms.add(`${t} ${o}`); }
  return [...forms].sort((a, b) => b.length - a.length);
})();
const EN_WORD_ALT = EN_WORD_FORMS.join('|');
// "one" ist im Kopula-Muster fast immer Pronomen ("she was one of them").
const EN_WORD_ALT_NO_ONE = EN_WORD_FORMS.filter(w => w !== 'one').join('|');

/** Englisches Zahlwort ("twelve", "twenty-one") → Zahl, sonst null. */
function englishNumberWord(word) {
  const w = String(word ?? '').toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(EN_NUM_WORDS, w)) return EN_NUM_WORDS[w];
  const m = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)$/.exec(w);
  return m ? EN_NUM_WORDS[m[1]] + EN_NUM_WORDS[m[2]] : null;
}

// Was hinter einer nackten Zahl steht und sie als Mengenangabe ausweist, nicht als
// Alter ("war 12 Minuten zu spaet", "ist zwei Meter gross").
const UNIT_AFTER = '(?!\\s*(?:Uhr|Prozent|%|Euro|Franken|Dollar|Mark|Rappen|Cent|Minuten?|Stunden?|Sekunden?|Tagen?|Tage|Wochen?|Monaten?|Monate|Meter|Kilometer|Kilo|Kilogramm|Gramm|Liter|Mal|Stück|Grad|o\'clock|percent|minutes?|hours?|days?|weeks?|months?|feet|foot|inches|pounds|dollars|times))';
// Kopula + bis zu zwei Zeitadverbien: "war damals erst zwoelf", "wird morgen vierzig".
const COPULA_DE = '\\b(?:war|ist|wurde|wird|werde|wirst|bin|bist|wäre|waere|sind|waren|wurden|werden)\\s+(?:(?:damals|gerade|erst|schon|knapp|fast|beinahe|kaum|bald|morgen|heute|jetzt|nun|inzwischen|bereits|noch|gestern|übermorgen|damit|dann|ungefähr|etwa)\\s+){0,2}';
const COPULA_EN = '\\b(?:was|is|turned|turns|turning|becomes|became|am|are|were)\\s+(?:(?:just|only|already|nearly|almost|barely|about|then|now|soon)\\s+){0,2}';

const YEAR_RE_SRC = '(?:1[0-9]{3}|20[0-9]{2})';
// Lücke zwischen Stichwort und Jahreszahl: kein Satzende — ausser einem Punkt direkt
// hinter einer Ziffer (Datum "3. Mai").
const DATE_GAP = (n) => `(?:[^.;!?]|(?<=\\d)\\.){0,${n}}`;

// ── Muster ───────────────────────────────────────────────────────────────────
// `art`  — was die Angabe behauptet: 'alter' (Jahre), 'geburtsjahr', 'jahr'
//          (irgendeine Jahreszahl im Satz — schwaches Signal, aber der Bezugs-
//          punkt, an dem ein Alter haengt).
// `word` — true, wenn Gruppe 1 ein Zahlwort ist (statt einer Ziffernfolge).
// `weak` — true bei Mustern, die auch ohne Alterskontext greifen. Sie waehlen
//          den Satz aus, taugen aber nicht als Pruefgroesse allein.
const PATTERNS = [
  // "die 12-jährige", "12jährig", "zwölfjährige"
  { art: 'alter', re: /\b(\d{1,3})\s*[-–]?\s*j[äa]hrig/giu },
  { art: 'alter', re: new RegExp(`\\b(${WORD_ALT})j[äa]hrig`, 'giu'), word: true },
  // "12 Jahre alt", "zwölf Jahre alt", "erst zwölf Jahre jung"
  { art: 'alter', re: /\b(\d{1,3})\s+Jahre?\s+(?:alt|jung)\b/giu },
  { art: 'alter', re: new RegExp(`\\b(${WORD_ALT})\\s+Jahre?\\s+(?:alt|jung)\\b`, 'giu'), word: true },
  // "mit 40 Jahren", "im Alter von 40 (Jahren)"
  { art: 'alter', re: /\bmit\s+(\d{1,3})\s+Jahren\b/giu },
  { art: 'alter', re: new RegExp(`\\bmit\\s+(${WORD_ALT})\\s+Jahren\\b`, 'giu'), word: true },
  { art: 'alter', re: /\b(?:im\s+)?Alter\s+von\s+(\d{1,3})\b/giu },
  { art: 'alter', re: new RegExp(`\\b(?:im\\s+)?Alter\\s+von\\s+(${WORD_ALT})\\b`, 'giu'), word: true },
  // "an ihrem sechzehnten Geburtstag", "zum 40. Geburtstag"
  { art: 'alter', re: /\b(\d{1,3})\.\s*Geburtstag\b/giu },
  // Das GANZE Ordinalwort wird gegriffen und von germanOrdinalWord zerlegt — eine
  // Gruppe vor "(sten|ten)" schnitte "dritten" zu "drit" und "zwanzigsten" zu
  // "zwanzigs" und verfehlte damit genau die runden Geburtstage.
  { art: 'alter', re: /(?<![A-Za-zÄÖÜäöüß])([A-Za-zÄÖÜäöüß]{3,24}(?:sten|ten))\s+Geburtstag\b/giu, ordinal: true },
  // Englisch — Buecher in EN sind ein regulaerer Fall (book_settings.language).
  { art: 'alter', re: /\b(\d{1,3})[\s-]?year[s]?[\s-]old\b/giu },
  { art: 'alter', re: /\baged\s+(\d{1,3})\b/giu },
  { art: 'alter', re: new RegExp(`\\b(${EN_WORD_ALT})[\\s-]years?[\\s-]old\\b`, 'giu'), en: true },
  { art: 'alter', re: new RegExp(`\\baged\\s+(${EN_WORD_ALT})\\b`, 'giu'), en: true },
  // Geburtsjahr
  // DATE_GAP: bis zu 30 Zeichen ohne Satzende — ein Punkt direkt hinter einer Ziffer
  // ("am 3. Mai 1850") ist kein Satzende.
  { art: 'geburtsjahr', re: new RegExp(`\\bgeboren\\b${DATE_GAP(30)}?(${YEAR_RE_SRC})`, 'giu') },
  // Beide Leserichtungen: "geboren 1850" UND "1850 geboren" — im Deutschen steht
  // das Partizip regelmaessig hinter der Jahreszahl.
  { art: 'geburtsjahr', re: new RegExp(`(${YEAR_RE_SRC})[^.;!?]{0,30}?\\bgeboren\\b`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\bgeb\\.\\s*(?:am\\s+)?${DATE_GAP(15)}?(${YEAR_RE_SRC})`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\bJahrgang\\s+(${YEAR_RE_SRC})`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\bborn\\s+(?:in|on)?[^.;!?]{0,20}?(${YEAR_RE_SRC})`, 'giu') },
  { art: 'geburtsjahr', re: new RegExp(`\\*\\s*(${YEAR_RE_SRC})`, 'giu') },
  // "war damals zwölf" — ohne "Jahre"; nur mit Kopula, sonst greift es in jedem
  // Aufzaehlungssatz. Schwach: das Modell entscheidet, ob es ein Alter ist.
  { art: 'alter', weak: true, re: new RegExp(`${COPULA_DE}(${WORD_ALT_NO_ART})(?![A-Za-zÄÖÜäöüß])${UNIT_AFTER}`, 'giu'), word: true },
  // Dasselbe mit Ziffer ("Anna war 12.") — eine Jahreszahl ist hier keine.
  { art: 'alter', weak: true, re: new RegExp(`${COPULA_DE}(\\d{1,3})(?!\\d)(?![.,:]\\d)${UNIT_AFTER}`, 'giu') },
  { art: 'alter', weak: true, re: new RegExp(`${COPULA_EN}(${EN_WORD_ALT_NO_ONE}|\\d{1,3})(?![A-Za-z\\d])${UNIT_AFTER}`, 'giu'), en: true },
  // Blosse Jahreszahl: schwaches Signal, aber der Bezugspunkt jedes errechneten
  // Alters ("1912 kehrte sie zurueck").
  { art: 'jahr', weak: true, re: new RegExp(`\\b(${YEAR_RE_SRC})\\b`, 'giu') },
];

/** Alle Alters-/Jahressignale eines Satzes. Reihenfolge = Textreihenfolge.
 *  Doppelfunde derselben (art, wert) an derselben Position werden verworfen. */
function extractAgeSignals(sentence) {
  const text = String(sentence ?? '');
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      let wert = null;
      if (p.ordinal) wert = germanOrdinalWord(m[1]);
      else if (p.word) wert = germanNumberWord(m[1]);
      else if (p.en) wert = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : englishNumberWord(m[1]);
      else wert = parseInt(m[1], 10);
      if (wert == null || !Number.isFinite(wert)) continue;
      // Plausibilitaet: ein Alter ueber 130 ist keine Altersangabe mehr, ein
      // Geburtsjahr unter 1000 keine Jahreszahl.
      if (p.art === 'alter' && (wert < 0 || wert > 130)) continue;
      if (p.art !== 'alter' && (wert < 1000 || wert > 2999)) continue;
      // Position der ZAHL, nicht des Musteranfangs: "war damals zwoelf" und
      // "zwoelf Jahre alt" sind dieselbe Angabe, und scan.js#clipSatz schneidet
      // das Prompt-Fenster um genau diese Stelle.
      const rel = m[0].toLowerCase().lastIndexOf(m[1].toLowerCase());
      const offset = m.index + Math.max(0, rel);
      const key = `${p.art}:${wert}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ art: p.art, wert, offset, end: offset + m[1].length, weak: !!p.weak, treffer: m[0] });
      if (p.re.lastIndex === m.index) p.re.lastIndex++; // Null-Laengen-Schutz
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

const ARTICLE_RE = /^ein(?:e|en|em|er|es)?$/;

/** Alle Zahlen, die in einem Text vorkommen — als Ziffer, als Zahlwort UND als
 *  Kompositum ("neunzehnjaehrige"). Pruefgroesse fuer die Modellantwort: nennt
 *  das Modell ein Alter, das in seinem eigenen Zitat nirgends steht, ist es
 *  errechnet oder erfunden.
 *
 *  Die dritte Quelle ist bewusst `extractAgeSignals` selbst: ein Zahlwort steckt
 *  im Deutschen regelmaessig IN einem Wort ("zwoelfjaehrig", "sechzehnten
 *  Geburtstag"), und ein reiner Wort-fuer-Wort-Lookup findet es dort nicht — er
 *  wuerde genau die woertlich belegten Faelle als „erfunden" verwerfen. */
function numbersIn(text) {
  const out = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(/\d{1,4}/g)) out.add(parseInt(m[0], 10));
  for (const m of s.matchAll(/[A-Za-zÄÖÜäöüß]{3,24}/g)) {
    // Unbestimmter Artikel ("ein", "eine", "einen" …) ist keine Eins — sonst bestünde
    // jedes Zitat mit Artikel die Zahl-Prüfung für den Wert 1.
    if (ARTICLE_RE.test(foldWord(m[0]))) continue;
    const n = germanNumberWord(m[0]) ?? germanOrdinalWord(m[0]);
    if (n != null) out.add(n);
  }
  // Englisch: "one" ist meist Pronomen und kein Beleg fuer den Wert 1.
  for (const m of s.matchAll(new RegExp(`(?<![A-Za-z])(${EN_WORD_ALT})(?![A-Za-z])`, 'gi'))) {
    if (m[1].toLowerCase() === 'one') continue;
    const n = englishNumberWord(m[1]);
    if (n != null) out.add(n);
  }
  for (const sig of extractAgeSignals(s)) out.add(sig.wert);
  return out;
}

/** Satzgrenzen inkl. Start-Offset. Eigener, absichtlich einfacher Splitter:
 *  gebraucht wird hier der SATZ ALS FENSTER (Figur + Angabe im selben Atemzug),
 *  nicht die Satzzahl-Metrik von lib/page-index.js — die ist dort privat und auf
 *  ihre Kennzahl getrimmt. Absatzenden zaehlen als Grenze, damit eine Zeile ohne
 *  Schlusspunkt (Dialogzeile, Ueberschrift) nicht mit dem naechsten Absatz
 *  verklebt.
 *
 *  KEINE Grenze ist ein Punkt hinter einer ein- bis dreistelligen Zahl vor einem
 *  Wort ("am 3. Mai 1850", "zum 40. Geburtstag") und hinter einer Abkuerzung oder
 *  Initiale ("geb. 1850", "Dr. Berg", "J. Berg") — genau dort stehen Alters- und
 *  Geburtsangaben, und ein Schnitt trennte das Stichwort von seiner Zahl. Eine
 *  Jahreszahl am Satzende ("… 1912. Sie war zwoelf.") bleibt eine Grenze. */
const ABBREV = new Set([
  'geb', 'gest', 'dr', 'prof', 'hr', 'fr', 'frl', 'st', 'nr', 'ca', 'bzw', 'vgl',
  'usw', 'etc', 'sog', 'jh', 'jhd', 'mr', 'mrs', 'ms', 'jr', 'sr', 'evtl',
]);
function _isNonTerminalDot(s, i) {
  const before = /(\p{L}+|\d+)$/u.exec(s.slice(Math.max(0, i - 12), i));
  if (!before) return false;
  const tok = before[1];
  if (/^\d+$/.test(tok)) {
    return tok.length <= 3 && /^\s+\p{L}/u.test(s.slice(i + 1, i + 6));
  }
  if (ABBREV.has(tok.toLowerCase())) return true;
  return tok.length === 1 && /\p{Lu}/u.test(tok); // Initiale
}
function splitSentences(text) {
  const s = String(text ?? '');
  const out = [];
  let start = 0;
  const push = (end) => {
    const raw = s.slice(start, end);
    if (raw.trim()) out.push({ start, end, text: raw });
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') { push(i); start = i + 1; continue; }
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let j = i;
    while (j + 1 < s.length && (s[j + 1] === '.' || s[j + 1] === '!' || s[j + 1] === '?')) j++;
    if (ch === '.' && j === i && _isNonTerminalDot(s, i)) continue;
    push(j + 1);
    start = j + 1;
    i = j;
  }
  push(s.length);
  return out;
}

// Grobfilter vor den Mustern (scan.js): enthaelt der Satz ueberhaupt etwas, das
// eine Alters- oder Jahresangabe sein koennte? Spart auf einem 1-Mio-Zeichen-Buch
// den Grossteil der Regex-Laeufe. MUSS jede Form abdecken, an der ein Muster
// greift — auch das blosse Zahlwort ("Sie war damals zwoelf", "im Alter von
// vierzig"), sonst sind die Muster dafuer toter Code.
const COARSE_RE = new RegExp(
  '\\d|j[äa]hrig|Jahre|Jahren|geboren|geb\\.|Jahrgang|Geburtstag|Alter|year|aged|born'
  + `|(?<![A-Za-zÄÖÜäöüß])(?:${WORD_ALT_NO_ART}|${EN_WORD_ALT_NO_ONE})(?![A-Za-zÄÖÜäöüß])`,
  'iu',
);

module.exports = {
  germanNumberWord, germanOrdinalWord, englishNumberWord, extractAgeSignals, numbersIn,
  splitSentences, foldWord, COARSE_RE,
};
