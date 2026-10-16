'use strict';
// Gemeinsame Grundlage der Quellen-Module: Feld-Inventar, Normalisierung, die
// SQL-Fragmente der Kennzahlen und die Umrechnung DB-Zeile ↔ API-Form.
//
// Warum hier und nicht je Modul: TEXT_FIELDS speist INSERT, UPDATE, Spaltenliste
// UND Normalisierung — laufen die auseinander, verliert ein Schreibpfad still
// ein Feld. Dasselbe gilt fuer die beiden Kennzahl-Fragmente: Buch-Sicht und
// Pool-Sicht muessen dieselben vier Zahlen liefern, nur anders skopiert.

const { MAX_TEXT_CHARS } = require('../../lib/pdf-extract');
const { parseIssuedDate } = require('../../lib/issued-date');

// `newspaper` = Zeitungs-/Magazinartikel (CSL `article-newspaper`): ein eigener
// Typ, weil die Stile dort das volle Datum setzen, beim Fachaufsatz nur das Jahr.
const CSL_TYPES = [
  'book', 'chapter', 'article', 'newspaper', 'website', 'thesis',
  'report', 'legal', 'interview', 'film', 'dataset', 'other',
];

// Freitext-Felder der Quelle in stabiler Reihenfolge — geteilt von INSERT,
// UPDATE und der Normalisierung, damit die drei nicht auseinanderlaufen.
const TEXT_FIELDS = [
  'citekey', 'title', 'container_title', 'publisher', 'place', 'year',
  // Genaues Erscheinungsdatum, ISO-partiell (lib/issued-date.js). `year` bleibt
  // daneben stehen — Sortierung, Kurzbeleg und Jahres-Buchstaben laufen darueber.
  'issued_date',
  'edition', 'volume', 'issue', 'pages', 'doi', 'isbn', 'issn', 'url',
  'accessed_at', 'note',
  // O-Ton: vier Angaben, die eine Publikation nicht hat, eine Aussage aus einem
  // Gespraech aber braucht. Sie haengen am CSL-Typ `interview` — Rolle/Funktion
  // der sprechenden Person, Kanal des Gespraechs, Datum und der
  // Autorisierungsstand des Zitats. Letzterer ist der Grund fuer die Felder:
  // ein nicht freigegebenes Zitat darf nicht in den Druck.
  'oton_role', 'oton_channel', 'oton_date', 'oton_auth',
];

// Kanal des Gespraechs und Autorisierungsstand sind Enums, keine Freitexte —
// sonst kann die Karte nicht filtern und kein Badge zuverlaessig warnen.
// Deckungsgleich mit OTON_CHANNELS/OTON_AUTH in public/js/sources/fields.js.
const OTON_CHANNELS = ['persoenlich', 'telefon', 'video', 'mail', 'medienkonferenz', 'andere'];
const OTON_AUTH = ['keine', 'ausstehend', 'freigegeben', 'abgelehnt'];
// Stufen, die einen O-Ton im Text blockieren — Spiegel von OTON_AUTH_BLOCKING
// (`otonBlocking`) in public/js/sources/fields.js. `keine` und null blockieren
// nicht: ohne Angabe ist nichts freigegeben, aber auch nichts abgelehnt.
const OTON_AUTH_BLOCKING = ['ausstehend', 'abgelehnt'];

const MAX_FIELD_LEN = 500;
const MAX_NOTE_LEN = 4000;
const MAX_PERSONS = 50;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

function _str(v, max = MAX_FIELD_LEN) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// Ein Personen-Array in CSL-Form bringen. Akzeptiert {family,given}, {literal}
// und blosse Strings ("Hans Müller" → literal, weil eine Heuristik auf
// Namensteile bei Doppelnamen und Adelspraefixen zu oft falsch raet).
function normalizePersons(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v.slice(0, MAX_PERSONS)) {
    if (typeof raw === 'string') {
      const literal = _str(raw, 200);
      if (literal) out.push({ literal });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const family = _str(raw.family, 200);
    const given = _str(raw.given, 200);
    if (family) {
      out.push(given ? { family, given } : { family });
      continue;
    }
    const literal = _str(raw.literal, 200);
    if (literal) out.push({ literal });
  }
  return out;
}

// Schlagworte in eine Form bringen: getrimmt, Innen-Whitespace auf ein Leer-
// zeichen, gedeckelt, ohne Dubletten (Gross-/Kleinschreibung zaehlt nicht —
// dieselbe Regel wie COLLATE NOCASE im Primaerschluessel von source_tags).
// Die erste Schreibweise gewinnt. Kein Array → leere Liste.
function normalizeTags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function _tags(json) {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(t => typeof t === 'string')
      .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  } catch { return []; }
}

function _persons(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Zitier-Kennzahlen kommen mit der Liste (wie oft / auf wie vielen Seiten
// belegt). Ohne sie muesste die Karte pro Zeile nachfragen, und das Badge
// „nicht zitiert" ist der Hauptgrund, warum der Fund-Index existiert.
//
// Sie sind BUCH-skopiert: dieselbe Pool-Quelle ist in Arbeit A zwanzigmal und in
// Arbeit B gar nicht belegt. Eine globale Zahl waere in der Buchansicht falsch —
// die globale Sicht liefert getSourceTotals fuer die Loesch-Warnung.
const _BOOK_COUNT_SQL = `
  (SELECT COALESCE(SUM(sc.count), 0) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS cite_count,
  (SELECT COUNT(*) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS cite_pages,
  (SELECT COALESCE(SUM(sc.quote_chars), 0) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS quote_chars,
  (SELECT COALESCE(SUM(sc.paraphrase_count), 0) FROM source_citations sc
     JOIN pages p ON p.page_id = sc.page_id
    WHERE sc.source_id = s.id AND p.book_id = @book) AS paraphrase_count
`;

// Pool-Sicht: ueber alle Buecher summiert, plus in wie vielen Buechern die
// Quelle liegt (die Zahl entscheidet, ob Loeschen woanders weh tut).
const _POOL_COUNT_SQL = `
  (SELECT COALESCE(SUM(sc.count), 0)            FROM source_citations sc WHERE sc.source_id = s.id) AS cite_count,
  (SELECT COUNT(*)                              FROM source_citations sc WHERE sc.source_id = s.id) AS cite_pages,
  (SELECT COALESCE(SUM(sc.quote_chars), 0)      FROM source_citations sc WHERE sc.source_id = s.id) AS quote_chars,
  (SELECT COALESCE(SUM(sc.paraphrase_count), 0) FROM source_citations sc WHERE sc.source_id = s.id) AS paraphrase_count,
  (SELECT COUNT(*) FROM book_source_links l WHERE l.source_id = s.id)                               AS book_count
`;

// Spaltenliste statt `s.*`: `doc` (bis 25 MB) und `doc_text` (bis 200k Zeichen)
// duerfen NIE in einer Listenabfrage mitkommen — eine Bibliothek mit 40
// angehaengten PDFs zoege sonst hunderte MB durch den Prozess, nur um pro Zeile
// ein Boolean und eine Seitenzahl anzuzeigen. Das Vorhandensein des BLOBs kommt
// als Flag aus SQLite, der Volltext gar nicht.
const _SOURCE_COLS = `
  s.id, s.owner_email, s.csl_type, s.authors, s.editors, s.archived,
  s.created_at, s.updated_at,
  ${TEXT_FIELDS.map(f => `s.${f}`).join(', ')},
  s.doc_mime, s.doc_name, s.doc_pages, s.doc_chars, s.doc_indexed_at, s.doc_content_hash,
  (s.doc IS NOT NULL) AS has_doc,
  (SELECT json_group_array(t.tag) FROM source_tags t WHERE t.source_id = s.id) AS tags_json
`;


function _row(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    owner_email: r.owner_email,
    csl_type: r.csl_type,
    authors: _persons(r.authors),
    editors: _persons(r.editors),
    tags: _tags(r.tags_json),
    archived: r.archived ? 1 : 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
    cite_count: r.cite_count || 0,
    cite_pages: r.cite_pages || 0,
    // Kennzahl-Seite: woertlich uebernommene Zeichen und wie viele der Nachweise
    // Paraphrasen sind. Beides im selben Scope wie cite_count (Buch bzw. Pool).
    quote_chars: r.quote_chars || 0,
    paraphrase_count: r.paraphrase_count || 0,
  };
  if (r.book_count !== undefined) out.book_count = r.book_count || 0;
  for (const f of TEXT_FIELDS) out[f] = r[f] || null;
  // PDF-Anhang: nur Metadaten. Weder BLOB noch Volltext verlassen die Tabelle
  // auf diesem Weg (s. _SOURCE_COLS) — das Original holt der Download-Endpunkt.
  // `doc_truncated` sagt, dass der Extraktor gedeckelt hat und der Index damit
  // nur den Anfang des Werks kennt.
  out.has_doc = !!r.has_doc;
  out.doc_name = r.doc_name || null;
  out.doc_pages = r.doc_pages ?? null;
  out.doc_chars = r.doc_chars ?? null;
  out.doc_indexed_at = r.doc_indexed_at || null;
  out.doc_truncated = (r.doc_chars ?? 0) >= MAX_TEXT_CHARS;
  return out;
}

// Ein Eingabe-Objekt auf die Spaltenwerte abbilden. `base` liefert die Vorwerte
// bei PATCH-artigem Update (nur uebergebene Felder aendern sich).
function _values(src, base = null) {
  const pick = (key, fallback) => (src[key] !== undefined ? src[key] : fallback);
  const cslType = _str(pick('csl_type', base?.csl_type)) || 'book';
  return {
    csl_type: CSL_TYPES.includes(cslType) ? cslType : 'book',
    authors: JSON.stringify(normalizePersons(pick('authors', base?.authors) || [])),
    editors: JSON.stringify(normalizePersons(pick('editors', base?.editors) || [])),
    archived: pick('archived', base?.archived) ? 1 : 0,
    text: TEXT_FIELDS.map(f => {
      const v = _str(pick(f, base?.[f]), f === 'note' ? MAX_NOTE_LEN : MAX_FIELD_LEN);
      // Datum fuehrt, Jahr folgt: sonst stuende im Kurzbeleg ein anderes Jahr
      // als im Verzeichniseintrag. Unlesbares Datum → weg (die Route lehnt es
      // vorher mit 400 ab; der Import soll daran nicht scheitern).
      if (f === 'issued_date') return parseIssuedDate(v);
      if (f === 'year') {
        const iso = parseIssuedDate(_str(pick('issued_date', base?.issued_date)));
        return iso ? iso.slice(0, 4) : v;
      }
      // Enum-Felder auf die Allowlist klemmen statt den Request abzulehnen: ein
      // unbekannter Wert soll den Import einer Quelle nicht scheitern lassen,
      // aber auch nicht als Freitext im Badge landen.
      if (f === 'oton_channel') return OTON_CHANNELS.includes(v) ? v : null;
      if (f === 'oton_auth')    return OTON_AUTH.includes(v) ? v : null;
      return v;
    }),
  };
}

module.exports = {
  CSL_TYPES, TEXT_FIELDS, OTON_CHANNELS, OTON_AUTH, OTON_AUTH_BLOCKING,
  MAX_FIELD_LEN, MAX_NOTE_LEN, MAX_PERSONS, MAX_TAGS, MAX_TAG_LEN,
  str: _str, normalizePersons, normalizeTags,
  BOOK_COUNT_SQL: _BOOK_COUNT_SQL,
  POOL_COUNT_SQL: _POOL_COUNT_SQL,
  SOURCE_COLS: _SOURCE_COLS,
  rowToSource: _row,
  toColumnValues: _values,
};
