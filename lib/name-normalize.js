'use strict';
// Figuren-Namens-Normalisierung — geteilte SSoT für Cross-Run-Matching
// (db/figures.js) und Intra-Run-Dedup (routes/jobs/komplett/figuren-merge.js).
//
// Liegt in lib/, weil beide Konsumenten (db/ und routes/) darauf zugreifen, ohne
// eine Layering-Inversion (db/ → routes/) einzuführen.

// Titel/Anrede-Präfixe (Dr., Prof., Herr, Frau, …), die für den Namensvergleich
// abgeschnitten werden.
const TITLE_PREFIX_RE = /^(?:dr\.?|doktor|prof\.?|professor|herrn?|hr\.?|frau|fr\.?|fräulein|frl\.?)\s+/;

// Namensbestandteile, die als Token kein Diskriminator sind (Adelspartikel/Artikel).
const NAME_STOPWORDS = new Set(['von', 'zu', 'van', 'der', 'die', 'das', 'den', 'dem', 'de', 'la']);

// Gemeinsame Grundform: Unicode-NFC (ein «é» aus dem Editor und eines aus der
// KI-Antwort sind sonst zwei verschiedene Zeichenfolgen — kombinierend vs.
// vorkomponiert), lowercased, ß→ss («Strauß» ≡ «Strauss», Schweizer Schreibung),
// getrimmt, Whitespace kollabiert. Kein gespeicherter Wert haengt an dieser Form —
// sie wird bei jedem Vergleich frisch gebildet, eine Aenderung braucht keine Migration.
function _baseForm(s) {
  return String(s || '').normalize('NFC').toLowerCase().replace(/ß/g, 'ss').trim().replace(/\s+/g, ' ');
}

// Grundform mit iterativ entfernten Titel-Präfixen.
function normName(s) {
  let r = _baseForm(s);
  while (TITLE_PREFIX_RE.test(r)) r = r.replace(TITLE_PREFIX_RE, '');
  return r;
}

// Anreden, die ein Geschlecht tragen. `normName` schneidet sie für den Namensvergleich
// ab («Herr Brunner» und «Frau Brunner» → `brunner`) — dieser Schlüssel allein darf
// deshalb nie zwei Figuren verschmelzen. `salutationGender` liest das Geschlecht der
// Anrede VOR dem Abschneiden; zwei verschiedene Anrede-Geschlechter sind ein
// Widerspruch (lib/entity-match.js#figureEvidence). Akademische Titel (Dr./Prof.)
// tragen kein Geschlecht: «Dr. Brunner» bleibt mit «Brunner» vergleichbar.
const _MALE_SALUTATION_RE = /^(?:herrn?|hr\.?)\s+/;
const _FEMALE_SALUTATION_RE = /^(?:frau|fr\.?|fräulein|frl\.?)\s+/;

// 'm' | 'f' | null — Geschlecht der (ersten) Anrede im Namen, Titel davor übersprungen
// («Dr. Frau Meier» → 'f').
function salutationGender(s) {
  let r = _baseForm(s);
  while (r) {
    if (_MALE_SALUTATION_RE.test(r)) return 'm';
    if (_FEMALE_SALUTATION_RE.test(r)) return 'f';
    if (!TITLE_PREFIX_RE.test(r)) return null;
    r = r.replace(TITLE_PREFIX_RE, '');
  }
  return null;
}

// Bedeutungstragende Namens-Token (>1 Zeichen, keine Stopwords) für Token-Matching.
function nameTokens(name) {
  return normName(name)
    .split(/[\s\-.]+/)
    .filter(t => t.length > 1 && !NAME_STOPWORDS.has(t));
}

module.exports = { TITLE_PREFIX_RE, NAME_STOPWORDS, normName, nameTokens, salutationGender };
