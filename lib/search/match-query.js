'use strict';
// MATCH-Ausdruck fuer die FTS5-Volltextsuche aus Nutzereingabe bauen.
// Ausgelagert aus lib/search.js (Facade re-exportiert `buildMatchQuery`).

// Query-Parser. Akzeptiert:
//   "phrase"   - exakte Phrase
//   -word      - Ausschluss (auch -"phrase")
//   word*      - Prefix-Match (explizit)
//   ein zwei   - AND (FTS5-Default)
// Woerter ab _AUTO_PREFIX_MIN Zeichen matchen automatisch als Prefix («Anna»
// findet «Annas»), exakt nur in Anfuehrungszeichen. ß und ss sind gleichwertig
// (der unicode61-Tokenizer faltet ß nicht): jeder Term geht als ODER-Gruppe
// beider Schreibungen in den MATCH, der gespeicherte Text bleibt unveraendert
// (Snippets zeigen die Originalschreibung).
// Spezialzeichen ausserhalb von Buchstaben/Zahlen/-/_ werden gestrippt, damit
// User-Input nicht in MATCH-Syntax-Errors einbricht.

const _NON_WORD = /[^\p{L}\p{N}_-]/gu;
const _AUTO_PREFIX_MIN = 3;

// Füllwörter für den ODER-Modus (anyTerms). Sie träfen fast jede Seite und
// verwässerten die bm25-Rangliste; Groß-/Kleinschreibung egal.
const _STOPWORDS = new Set((
  'der die das den dem des ein eine einer eines einem einen und oder aber doch '
  + 'ist sind war waren wird werden wurde wurden hat haben hatte hatten sein seine '
  + 'ihr ihre ihren ihrem ihres sie er es wir ich du man mit von zu zum zur im in '
  + 'an am auf aus bei für über ueber unter nach vor als wie wo was wer wann '
  + 'warum welche welcher welches dass daß nicht kein keine noch auch nur schon so '
  + 'dann denn wenn ob sich mir mich dir dich uns euch the a and or of to on '
  + 'at with is are was were be been it this that what which who when where why how'
).split(' '));
// Höchstens so viele Wörter im ODER-Modus (die längsten — sie tragen meist die
// Bedeutung); eine Chat-Frage samt letzter Runde wäre sonst ein Riesen-MATCH.
const _ANY_MAX_TERMS = 16;

// Schreibvarianten eines Terms: ß ↔ ss (alle Vorkommen auf einmal).
function _ssVariants(text) {
  const out = new Set([text]);
  const lower = text.toLowerCase();
  if (lower.includes('ß')) out.add(lower.replace(/ß/g, 'ss'));
  if (lower.includes('ss')) out.add(lower.replace(/ss/g, 'ß'));
  return [...out];
}

// Ein Term (Wort oder Phrase) als MATCH-Ausdruck, Varianten als ODER-Gruppe.
function _matchTerm(text, prefix) {
  const parts = _ssVariants(text).map(v => '"' + v + '"' + (prefix ? '*' : ''));
  return parts.length === 1 ? parts[0] : '(' + parts.join(' OR ') + ')';
}

// Phrasen herausziehen. `-"…"` ist ein ausgeschlossener Phrasen-Term.
function _extractPhrases(raw) {
  const phrases = [];
  const rest = raw.replace(/(^|\s)(-?)"([^"]*)"/g, (_m, lead, neg, inner) => {
    const phrase = inner.replace(/"/g, '').trim();
    if (phrase) phrases.push({ text: phrase, neg: neg === '-' });
    return lead + ' ';
  });
  return { phrases, rest: rest.replace(/"/g, ' ') };
}

function buildMatchQuery(input, { anyTerms = false } = {}) {
  if (anyTerms) return _buildAnyQuery(input);
  const raw = (input || '').toString().trim();
  if (!raw) return '';
  const pos = [];
  const neg = [];
  const { phrases, rest } = _extractPhrases(raw);
  for (const p of phrases) (p.neg ? neg : pos).push(_matchTerm(p.text, false));
  for (let part of rest.split(/\s+/)) {
    if (!part) continue;
    let isNeg = false;
    if (part.startsWith('-')) { isNeg = true; part = part.slice(1); }
    if (!part) continue;
    let prefix = false;
    if (part.endsWith('*')) { prefix = true; part = part.slice(0, -1); }
    const sanitized = part.replace(_NON_WORD, '').replace(/^[-_]+|[-_]+$/g, '');
    if (sanitized.length < 2) continue;
    // Ausschluesse bleiben exakt: «-Anna» soll nicht auch «Annas» wegfiltern.
    if (!isNeg && sanitized.length >= _AUTO_PREFIX_MIN) prefix = true;
    (isNeg ? neg : pos).push(_matchTerm(sanitized, prefix));
  }
  // FTS5 kennt kein vorangestelltes Minus, nur das binaere NOT. Ohne positiven
  // Term gibt es nichts, wovon etwas ausgeschlossen werden koennte.
  if (!pos.length) return '';
  if (!neg.length) return pos.join(' ');
  return '(' + pos.join(' ') + ')' + neg.map(n => ' NOT ' + n).join('');
}

// ODER-Variante für natürlichsprachliche Anfragen (Hybrid-Stufe der semantischen
// Suche): Phrasen bleiben Phrasen, Negationen und Füllwörter fallen weg, die
// übrigen Wörter sind alternativ (exakt, kein Auto-Prefix — die Stufe soll
// Eigennamen zurueckholen, nicht jede Wortverlaengerung). Ein Treffer braucht nur
// eines davon; bm25 rankt Seiten mit mehr und selteneren Treffern höher.
function _buildAnyQuery(input) {
  const raw = (input || '').toString().trim();
  if (!raw) return '';
  const terms = new Set();
  const { phrases, rest } = _extractPhrases(raw);
  for (const p of phrases) if (!p.neg) terms.add(_matchTerm(p.text, false));
  const words = [];
  for (const part of rest.split(/\s+/)) {
    if (!part || part.startsWith('-')) continue;
    const w = part.replace(_NON_WORD, '').replace(/^[-_]+|[-_]+$/g, '');
    if (w.length < 2 || _STOPWORDS.has(w.toLowerCase())) continue;
    words.push(w);
  }
  const uniq = [...new Map(words.map(w => [w.toLowerCase(), w])).values()];
  uniq.sort((a, b) => b.length - a.length);
  for (const w of uniq.slice(0, _ANY_MAX_TERMS)) terms.add(_matchTerm(w, false));
  return [...terms].join(' OR ');
}

module.exports = { buildMatchQuery, NON_WORD: _NON_WORD };
