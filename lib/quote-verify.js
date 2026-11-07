'use strict';

// Belegzitat-Verifikation für Buch- und Kapitelbewertung.
//
// Die Review-Prompts verlangen zeichengenaue Zitate aus dem vorliegenden Text.
// Anders als beim Lektorat gibt es dafür keinen natürlichen Filter: ein Lektorats-
// Finding ohne Fundstelle fällt beim Positionieren heraus (`findInHtml`), ein
// Bewertungs-Zitat wird einfach angezeigt. Ein halluziniertes Zitat ist dort
// schädlicher als ein fehlendes — es ist nicht anklickbar, also fliegt es nie auf.
//
// Der Abgleich ist bewusst tolerant gegenüber allem, was der Ausgabeweg legitim
// verändert (Whitespace, Anführungs- und Strichformen, Gross-/Kleinschreibung am
// Satzanfang) und streng gegenüber allem anderen. Auslassungen («…») werden als
// Platzhalter behandelt: die Fragmente müssen einzeln und in dieser Reihenfolge
// vorkommen. Ein Zitat, das so nicht zu finden ist, wird still verworfen.

// Zeichenklassen, die derselben Bedeutung entsprechen und zwischen Editor,
// Prompt-Serialisierung und Modell-Ausgabe wandern. Apostroph-Varianten (´ ` ʼ ′ ‛)
// zählen zu den Anführungszeichen: «geht’s», «geht's» und «geht´s» sind derselbe Text.
const QUOTE_CHARS = /[«»„“”‟"‹›‚‘’'‛ʼ´`′″]/g;
const DASH_CHARS  = /[‐-―−⸺⸻﹘﹣－]/g;
const NBSP_CHARS  = /[\u00a0\u2007\u202f\u2009\u200a\u2002-\u2006]/g;
// Unsichtbare Zeichen, die Editor/Import in Wörter schreiben (weiches Trennzeichen,
// Zero-Width-Space/-Joiner/-Non-Joiner, Word-Joiner, BOM) — das Modell gibt sie nie
// zurück, ein Wort mit Soft-Hyphen wäre sonst nie zitierbar.
const INVISIBLE_CHARS = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g;
// Auslassungs-Markierungen in Klammern («[…]», «[...]», «(…)», «(...)») sind
// dieselbe Auslassung wie ein blankes «…».
const BRACKET_ELLIPSIS = /[[(]\s*(?:…|\.\s*\.\s*\.)\s*[\])]/g;

// Satzzeichen-tolerante Vergleichsform (Option `ignorePunctuation`): jedes Satzzeichen
// (Unicode-Kategorie P — Komma, Punkt, Gedankenstrich, Auslassung, Anführung …) zählt als
// Wortgrenze. Nur für Konsumenten, deren Zitat-Verwurf teurer ist als ein zu toleranter
// Treffer (Kontinuitäts-Belegprüfung: «Trümmern und niemand kam» gegen «Trümmern, und
// niemand kam» ist kein erfundenes Zitat). Default aus — Bewertung und Ideen-Chat bleiben
// beim strengen Abgleich.
const PUNCT_CHARS = /\p{P}+/gu;
function _stripPunct(norm) {
  return norm.replace(PUNCT_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Vergleichsform: Zeichenvarianten vereinheitlicht, Whitespace kollabiert.
 *  `{ ignorePunctuation: true }` entfernt zusätzlich alle Satzzeichen (siehe oben). */
function normalizeForQuoteMatch(s, { ignorePunctuation = false } = {}) {
  const norm = _normalizeStrict(s);
  return ignorePunctuation ? _stripPunct(norm) : norm;
}

function _normalizeStrict(s) {
  return String(s || '')
    .replace(INVISIBLE_CHARS, '')
    .replace(BRACKET_ELLIPSIS, '…')
    .replace(QUOTE_CHARS, '"')
    .replace(DASH_CHARS, '-')
    .replace(NBSP_CHARS, ' ')
    .replace(/-{2,}/g, '-')
    // Strich mit/ohne Leerraum («Wort – Wort» vs. «Wort—Wort») ist derselbe Text.
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    // Leerraum vor schliessenden Satzzeichen (und nach öffnenden Klammern) ist ein
    // Artefakt der Text-Extraktion: wird jedes Tag zu einem Leerzeichen
    // (lib/html-text#htmlToPlainText, Werkzeuge wie quote_passage), steht aus
    // «sagte <em>nein</em>.» ein «nein .» — derselbe Text wie «nein.».
    .replace(/ ([.,;:!?)\]])/g, '$1')
    .replace(/([([]) /g, '$1')
    .trim()
    .toLowerCase();
}

/** Zerlegt ein Zitat an Auslassungszeichen in die zu suchenden Fragmente. */
function splitEllipsis(norm) {
  return norm
    .split(/\s*(?:…|\.\.\.)\s*/)
    // Rand-Anführungszeichen gehören nicht zum Wortlaut (ein Zitat wird mal mit,
    // mal ohne «…» übergeben).
    .map(part => part.replace(/^[\s.,;:"]+|[\s.,;:"]+$/g, '').trim())
    .filter(Boolean);
}

/** Such-Fragmente eines Zitats: an Auslassungen getrennt, mit `ignorePunctuation`
 *  danach ohne Satzzeichen (die Auslassung muss VOR dem Strippen erkannt werden). */
function quoteParts(zitat, { ignorePunctuation = false } = {}) {
  const norm = _normalizeStrict(zitat);
  if (!norm) return [];
  const parts = splitEllipsis(norm);
  return ignorePunctuation ? parts.map(_stripPunct).filter(Boolean) : parts;
}

// Strenge Form (`strict`) für Belege, an denen eine Entscheidung hängt (Ideen-Chat
// «erledigt», Auto-Check): mit «…» und Kurzfragmenten liesse sich sonst fast jeder
// lange Abschnitt «belegen» — «Anna … Brief … verbrennt» findet sich in Reihenfolge
// irgendwo, auch wenn der Satz nicht existiert.
const STRICT_MIN_CHARS = 15;
const STRICT_MIN_WORDS = 3;
const STRICT_MAX_PARTS = 3;      // höchstens zwei Auslassungen
const STRICT_MAX_SPAN = 800;     // alle Teile innerhalb einer Stelle

function _strictPartOk(part) {
  return part.length >= STRICT_MIN_CHARS || part.split(' ').filter(Boolean).length >= STRICT_MIN_WORDS;
}

/**
 * Kommt das Zitat im (bereits normalisierten) Text vor?
 * @param {string} zitat     Rohes Zitat aus der Modell-Antwort
 * @param {string} hayNorm   Text in Vergleichsform (normalizeForQuoteMatch — mit
 *                           `ignorePunctuation` in derselben Option normalisiert)
 * @param {{ignorePunctuation?: boolean, strict?: boolean}} [opts]
 *   strict: jedes Teilstück mind. 15 Zeichen oder 3 Wörter, höchstens zwei
 *   Auslassungen, alle Teile innerhalb von 800 Zeichen (eine Stelle, nicht der
 *   ganze Abschnitt).
 */
function quoteFoundIn(zitat, hayNorm, opts = {}) {
  const parts = quoteParts(zitat, opts);
  if (!parts.length) return false;
  if (opts.strict && (parts.length > STRICT_MAX_PARTS || !parts.every(_strictPartOk))) return false;
  const matchFrom = (start) => {
    let from = start;
    let first = -1;
    for (const part of parts) {
      const at = hayNorm.indexOf(part, from);
      if (at < 0) return null;
      if (first < 0) first = at;
      from = at + part.length;
    }
    return { first, end: from };
  };
  if (!opts.strict) return !!matchFrom(0);
  // Jede Fundstelle des ersten Teils als Anfang probieren: die erste kann zu weit
  // vom Rest weg liegen, eine spätere nicht.
  for (let at = hayNorm.indexOf(parts[0]); at >= 0; at = hayNorm.indexOf(parts[0], at + 1)) {
    const m = matchFrom(at);
    if (!m) return false;
    if (m.end - m.first <= STRICT_MAX_SPAN) return true;
  }
  return false;
}

/**
 * Filtert eine Zitatliste auf die im Text tatsächlich auffindbaren Einträge.
 *
 * @param {Array<{zitat?:string}>|any} list  `beispielzitate` / `zitate` aus der AI-Antwort
 * @param {string} haystack                  Text, aus dem zitiert werden sollte
 * @returns {{ kept: Array, dropped: Array }}
 */
function verifyZitate(list, haystack) {
  if (!Array.isArray(list) || !list.length) return { kept: Array.isArray(list) ? list : [], dropped: [] };
  const hayNorm = normalizeForQuoteMatch(haystack);
  if (!hayNorm) return { kept: list, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const z of list) {
    if (z && typeof z === 'object' && quoteFoundIn(z.zitat, hayNorm)) kept.push(z);
    else dropped.push(z);
  }
  return { kept, dropped };
}

/**
 * Setzt die verifizierte Liste zurück ins Review-Objekt (in-place) und meldet,
 * wie viele Zitate verworfen wurden.
 *
 * @param {object} review    AI-Antwort mit `beispielzitate`
 * @param {string} haystack  Text, aus dem zitiert werden sollte
 * @param {string} feld      Feldname (Default `beispielzitate`)
 * @returns {number} Anzahl verworfener Zitate
 */
function applyQuoteVerification(review, haystack, feld = 'beispielzitate') {
  if (!review || !Array.isArray(review[feld])) return 0;
  const { kept, dropped } = verifyZitate(review[feld], haystack);
  review[feld] = kept;
  return dropped.length;
}

/**
 * Heuhaufen für die Multi-Pass-Synthese: dort gibt es keinen Volltext mehr, das
 * Modell darf nur aus den Belegzitaten der Teil-Analysen zitieren.
 */
function belegHaystack(analyses) {
  return (analyses || [])
    .flatMap(a => (a?.zitate || []).map(z => z?.zitat || ''))
    .join('\n');
}

module.exports = {
  normalizeForQuoteMatch,
  quoteFoundIn,
  quoteParts,
  splitEllipsis,
  verifyZitate,
  applyQuoteVerification,
  belegHaystack,
};
