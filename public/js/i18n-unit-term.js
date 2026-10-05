// Gliederungseinheit je Buchtyp: die Locale-Dateien sagen «Abschnitt»/«section»;
// in einem Blog und im Journalismus heisst dieselbe Einheit «Beitrag»/«post»,
// im Tagebuch «Eintrag»/«entry». Statt jeden der Strings dreifach zu pflegen,
// tauscht tRaw das Wort beim Auflösen aus (i18n.js). Code/DB bleiben `page`.
//
// Das geht im Deutschen ohne Grammatik-Umbau, weil alle drei Wörter maskulin
// sind — Artikel und Adjektivendungen passen unverändert, nur der Plural
// bekommt den Umlaut (Beiträge/Einträge). Im Englischen braucht «entry» den
// Artikel «an».
//
// Keys unter UNIT_TERM_EXEMPT beschreiben die App allgemein (Landing, Admin,
// Datenschutz) und bleiben beim Grundbegriff, auch wenn gerade ein Blog offen ist.

export const UNIT_SECTION = 'section';
export const UNIT_POST = 'post';
export const UNIT_ENTRY = 'entry';

const BUCHTYP_UNIT = {
  blog: UNIT_POST,
  journalismus: UNIT_POST,
  tagebuch: UNIT_ENTRY,
};

const UNIT_TERM_EXEMPT = ['landing.', 'privacy.', 'admin.'];

/** Buchtyp → Einheit; unbekannter oder fehlender Typ → 'section'. */
export function unitTermFor(buchtyp) {
  return BUCHTYP_UNIT[buchtyp] || UNIT_SECTION;
}

// Deutsch: Singular-Stamm (Abschnitt, Abschnitts…) und Plural-Stamm (Abschnitte, Abschnitten).
const DE = {
  [UNIT_POST]:  { sg: 'Beitrag', pl: 'Beiträg', abbr: 'Beitr.' },
  [UNIT_ENTRY]: { sg: 'Eintrag', pl: 'Einträg', abbr: 'Eintr.' },
};
const EN = {
  [UNIT_POST]:  { sg: 'post',  pl: 'posts',   opt: 'post(s)' },
  [UNIT_ENTRY]: { sg: 'entry', pl: 'entries', opt: 'entry/entries' },
};

function _matchCase(src, word) {
  const head = src === src.toUpperCase() ? word[0].toUpperCase() : word[0].toLowerCase();
  return head + word.slice(1);
}

function _applyDe(msg, w) {
  return msg
    .replace(/([Aa])bschn\./g, (_, a) => _matchCase(a, w.abbr))
    .replace(/([Aa])bschnitt(en|es|e|s)?/g, (_, a, suf = '') => {
      const word = (suf === 'e' || suf === 'en') ? w.pl + suf : w.sg + suf;
      return _matchCase(a, word);
    });
}

function _applyEn(msg, w) {
  let out = msg
    .replace(/\b([Ss])ection\(s\)/g, (_, s) => _matchCase(s, w.opt))
    .replace(/\b([Ss])ection(s?)\b/g, (_, s, pl) => _matchCase(s, pl ? w.pl : w.sg));
  // «a section» → «an entry»; nur nötig, wenn der neue Begriff mit Vokal beginnt.
  if (/^[aeiou]/.test(w.sg)) {
    out = out.replace(new RegExp(`\\b([Aa]) (${w.sg}|${w.pl})\\b`, 'gi'), (m, a, word) => `${a}n ${word}`);
  }
  return out;
}

/** Tauscht die Gliederungseinheit in einem aufgelösten Message-String aus. */
export function applyUnitTerm(msg, { key, locale, unit }) {
  if (!unit || unit === UNIT_SECTION || typeof msg !== 'string') return msg;
  if (key && UNIT_TERM_EXEMPT.some(p => key.startsWith(p))) return msg;
  if (locale === 'en') return EN[unit] ? _applyEn(msg, EN[unit]) : msg;
  return DE[unit] ? _applyDe(msg, DE[unit]) : msg;
}
