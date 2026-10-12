'use strict';
// Default + strikter Validator fuer buch-weite Publikations-Metadaten
// (book_publication). Von PDF- und EPUB-Export sowie der Publikation-Karte
// konsumiert. Strict: unbekannte Keys verworfen, Strings laengen-geclamped,
// Enums whitelisted. ISBN-Pruefziffer wird geprueft, aber NICHT erzwungen
// (non-blocking, Warnung Sache des UI).

// epub_css_style steuert die Schriftfamilie. Ohne Font-Embedding referenzieren
// wir generische + verbreitete Familien (Reader nutzt sie, wenn vorhanden, sonst
// Fallback der Stack-Definition in epub.js). 'serif'/'sans' bleiben Default-tauglich.
const headingStyle = require('./heading-style');

const CSS_STYLES = ['serif', 'sans', 'georgia', 'palatino', 'garamond', 'times', 'baskerville', 'helvetica', 'verdana'];

// Enum-Whitelists fuer die erweiterten EPUB-Reflow-Optionen. Default = erstes
// Element ist NICHT garantiert; Defaults stehen in defaultMeta().
const _ENUMS = {
  epub_font_size: ['small', 'normal', 'large'],
  epub_line_height: ['tight', 'normal', 'relaxed'],
  epub_paragraph_style: ['indent', 'spaced'],
  epub_indent_size: ['small', 'medium', 'large'],
  epub_scene_separator: ['line', 'asterism', 'stars', 'blank', 'fleuron'],
  epub_titlepage_mode: ['generated', 'cover', 'none'],
  epub_chapter_numbering: ['none', 'arabic', 'roman', 'word'],
  epub_chapter_numbering_mode: ['flat', 'nested'],
  // Pendants zu PDF-Profil-Optionen (pdf_export_profile.config).
  epub_imprint_position: ['front', 'back'],            // extras.imprintPosition
  epub_chapter_title_style: ['centered-large', 'left-rule', 'minimal'], // chapter.titleStyle
  epub_heading_font: ['match', ...CSS_STYLES],          // font.heading.family; 'match' = wie Fliesstext
  epub_heading_scale: ['small', 'normal', 'large'],     // font.heading.sizes (coarse)
  epub_cover_fit: ['contain', 'cover'],                 // cover.fit
  epub_numerals: ['default', 'lining', 'oldstyle'],     // font.body.numerals
  epub_msg_style: ['plain', 'bubbles'],                 // messages.style (Nachrichtenverlauf)
};
// Ueberschriften-Gestaltung (Linie/Ornament, Kapitelnummer, Ausrichtung): Werte,
// Defaults und Spaltennamen sind SSoT in lib/heading-style.js (geteilt mit dem
// PDF-Profil `chapter.*`). Die Bools davon laufen ueber _BOOLS, Zahl und Praefix-
// Text eigens in validateMeta.
for (const [key, allowed] of Object.entries(headingStyle.ENUMS)) {
  _ENUMS[headingStyle.EPUB_COLUMNS[key]] = allowed;
}

// Ganzzahl-Enums (INTEGER in der DB). epub_toc_depth: max Outline-Tiefe (1 = nur
// Top-Kapitel, 2 = inkl. Sub-Kapitel/Seiten). Pendant zu toc.depth (PDF), aber auf
// 2 begrenzt — die EPUB-NavMap kann nur zwei Ebenen.
const _INT_ENUMS = {
  epub_toc_depth: { allowed: [1, 2], def: 2 },
};

// Bool-Felder (0/1 in der DB, true/false im Meta-Objekt) mit Default.
const _BOOLS = {
  epub_justify: true,
  epub_hyphenation: false,
  epub_chapter_pagebreak: true,
  epub_drop_caps: false,
  epub_nest_pages_in_toc: true,
  // Pendants zu PDF-Profil-Optionen.
  epub_subchapter_pagebreak: false, // chapter.breakBeforeSubchapter
  epub_chapter_rule: false,         // chapter.titleRule (dekorativer Strich unter Kapiteltitel)
  epub_page_rule: false,            // chapter.pageTitleRule (Strich unter Seitentitel)
  epub_toc_enabled: true,           // toc.enabled (Inhaltsverzeichnis-Seite in der Lesereihenfolge)
  epub_chapter_number_divider: true, // Strich-Trenner ——— zwischen Kapitelnummer und Titel (nur bei aktiver Numerierung)
  epub_number_tracking: headingStyle.DEFAULTS.numberTracking,
  epub_sub_title_rule: headingStyle.DEFAULTS.subTitleRule,
};

const _LIMITS = {
  author_name: 200,
  author_file_as: 200,
  isbn: 20,
  subtitle: 300,
  year: 10,
  dedication: 2000,
  imprint: 8000,
  copyright: 500,
  frontmatter: 8000,
  author_bio: 4000,
  epub_toc_title: 100,
  description: 4000,
  publisher: 200,
  series: 200,
  series_index: 10,
  keywords: 500,
  epub_rights: 500,
  epub_pubdate: 10,
  epub_translator: 200,
  epub_illustrator: 200,
  epub_editor_name: 200,
  epub_uuid: 100,
};

function defaultMeta() {
  return {
    author_name: '',
    author_file_as: '',
    // Co-Autoren (Schreib-Duos): [{ name, file_as }]. Zusaetzliche dc:creator im OPF.
    co_authors: [],
    // Freie Vor-/Nachsatz-Seiten: [{ placement, title, body, link_url, link_label, toc }].
    extra_sections: [],
    isbn: '',
    subtitle: '',
    year: '',
    dedication: '',
    imprint: '',
    copyright: '',
    frontmatter: '',
    author_bio: '',
    epub_css_style: 'serif',
    epub_toc_title: '',
    description: '',
    publisher: '',
    series: '',
    series_index: '',
    keywords: '',
    // Erweiterte EPUB-Optionen.
    epub_font_size: 'normal',
    epub_line_height: 'normal',
    epub_paragraph_style: 'indent',
    epub_indent_size: 'medium',
    epub_scene_separator: 'line',
    epub_titlepage_mode: 'generated',
    epub_chapter_numbering: 'none',
    epub_chapter_numbering_mode: 'nested',
    // Kapitel-IDs ohne Nummer im EPUB (Pendant zur PDF-Option). Cascade: ein
    // markiertes Top-Kapitel zieht im Builder alle Sub-Kapitel mit.
    epub_unnumbered_chapter_ids: [],
    epub_rights: '',
    epub_pubdate: '',
    epub_translator: '',
    epub_illustrator: '',
    epub_editor_name: '',
    epub_uuid: '',
    // Pendants zu PDF-Profil-Optionen (Defaults aus _ENUMS/_INT_ENUMS/_BOOLS).
    epub_imprint_position: 'front',
    epub_chapter_title_style: 'centered-large',
    epub_heading_font: 'match',
    epub_heading_scale: 'normal',
    epub_cover_fit: 'contain',
    epub_numerals: 'default',
    epub_msg_style: 'plain',
    epub_toc_depth: 2,
    // Bools (Defaults aus _BOOLS).
    epub_justify: true,
    epub_hyphenation: false,
    epub_chapter_pagebreak: true,
    epub_drop_caps: false,
    epub_nest_pages_in_toc: true,
    epub_subchapter_pagebreak: false,
    epub_chapter_rule: false,
    epub_page_rule: false,
    epub_toc_enabled: true,
    epub_chapter_number_divider: true,
    // Ueberschriften-Gestaltung (Defaults aus lib/heading-style.js).
    ...Object.fromEntries(Object.entries(headingStyle.EPUB_COLUMNS).map(([k, col]) => [col, headingStyle.DEFAULTS[k]])),
  };
}

function _str(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

// ISBN-13-Pruefziffer (EAN-13-Modulo-10). Akzeptiert Bindestriche/Spaces.
// Liefert true/false/null (null = kein 13-stelliger Kandidat → nicht pruefbar).
function isValidIsbn13(raw) {
  const digits = String(raw || '').replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[12]);
}

function _bool(v) {
  return v === true || v === 1 || v === '1';
}

// Normalisiert eine Kapitel-ID-Liste. Akzeptiert ein Array (Frontend) ODER einen
// JSON-String (DB-Spalte) und liefert deduplizierte, positive Integer (max 500).
// Ungueltige/leere Eingabe → []. Pendant zu _validateIdList im PDF-Export.
function _idList(v) {
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const n = parseInt(x, 10);
    if (Number.isFinite(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.slice(0, 500);
}

// Parst eine Array-Spalte: akzeptiert ein Array (Frontend) ODER einen JSON-String
// (DB-Spalte). Liefert [] bei ungueltiger Eingabe. Pendant zu _idList.
function _parseArray(v) {
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

// Co-Autoren: [{ name, file_as }]. Eintraege ohne name verworfen, Strings geclamped,
// Anzahl gedeckelt (10 reicht fuer reale Schreib-Kollektive, schuetzt das OPF).
function _coAuthors(v) {
  const out = [];
  for (const c of _parseArray(v)) {
    if (!c || typeof c !== 'object') continue;
    const name = _str(c.name, 200).trim();
    if (!name) continue;
    out.push({ name, file_as: _str(c.file_as, 200).trim() });
    if (out.length >= 10) break;
  }
  return out;
}

// Freie Vor-/Nachsatz-Seiten: [{ placement, title, body, link_url, link_label, toc }].
// Eintraege ohne jeglichen Inhalt (kein title/body/link) verworfen. placement-Enum
// (default 'back'), toc default true. Anzahl gedeckelt.
function _extraSections(v) {
  const out = [];
  for (const s of _parseArray(v)) {
    if (!s || typeof s !== 'object') continue;
    const title = _str(s.title, 200).trim();
    const body = _str(s.body, 8000);
    const link_url = _str(s.link_url, 500).trim();
    const link_label = _str(s.link_label, 200).trim();
    if (!title && !body.trim() && !link_url) continue;
    out.push({
      placement: s.placement === 'front' ? 'front' : 'back',
      title,
      body,
      link_url,
      link_label,
      toc: !(s.toc === false || s.toc === 0 || s.toc === '0'),
    });
    if (out.length >= 30) break;
  }
  return out;
}

function validateMeta(src) {
  const out = defaultMeta();
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(_LIMITS)) {
    if (src[key] != null) out[key] = _str(src[key], _LIMITS[key]);
  }
  if (CSS_STYLES.includes(src.epub_css_style)) out.epub_css_style = src.epub_css_style;
  for (const [key, allowed] of Object.entries(_ENUMS)) {
    if (allowed.includes(src[key])) out[key] = src[key];
  }
  for (const [key, spec] of Object.entries(_INT_ENUMS)) {
    if (src[key] != null) {
      const n = parseInt(src[key], 10);
      if (spec.allowed.includes(n)) out[key] = n;
    }
  }
  for (const key of Object.keys(_BOOLS)) {
    if (src[key] != null) out[key] = _bool(src[key]);
  }
  if (src.epub_number_size_pct != null || src.epub_number_prefix_text != null) {
    const hs = headingStyle.validateHeadingStyle({
      numberSizePct: src.epub_number_size_pct, numberPrefixText: src.epub_number_prefix_text,
    });
    out.epub_number_size_pct = hs.numberSizePct;
    out.epub_number_prefix_text = hs.numberPrefixText;
  }
  if (src.epub_unnumbered_chapter_ids != null) {
    out.epub_unnumbered_chapter_ids = _idList(src.epub_unnumbered_chapter_ids);
  }
  if (src.co_authors != null) out.co_authors = _coAuthors(src.co_authors);
  if (src.extra_sections != null) out.extra_sections = _extraSections(src.extra_sections);
  return out;
}

module.exports = { defaultMeta, validateMeta, isValidIsbn13, CSS_STYLES };
