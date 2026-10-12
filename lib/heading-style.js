'use strict';
// Gestaltung der Kapitel- und Abschnittsueberschriften — SSoT fuer PDF und EPUB.
// Das PDF-Profil fuehrt die Felder unter `config.chapter.*` (camelCase), das
// EPUB buchweit in `book_publication.epub_*` (Spaltenname in EPUB_COLUMNS).
// Beide Renderer arbeiten auf dem camelCase-Objekt aus `fromPdfChapter` bzw.
// `fromEpubMeta`; Bedeutung und Masse stehen nur hier, damit dieselbe Einstellung
// in beiden Formaten dasselbe Bild ergibt. Doku: docs/publikation-export.md.

// Linie bzw. Ornament. Die ersten vier sind Linien (Staerke + Breite wirken),
// die uebrigen Ornamente: Sternchen, Asterismus (⁂), Raute zwischen zwei
// Linienstuecken, drei Punkte.
const RULE_STYLES = ['single', 'double', 'dotted', 'dashed', 'stars', 'asterism', 'diamond', 'dots'];
const LINE_RULE_STYLES = ['single', 'double', 'dotted', 'dashed'];
// Strichstaerke in pt (CSS kennt pt, das EPUB uebernimmt die Zahl unveraendert).
const RULE_WEIGHT_PT = { hairline: 0.5, thin: 1, medium: 1.5, thick: 2.5 };
const RULE_WEIGHTS = Object.keys(RULE_WEIGHT_PT);
// 'auto': kurz unter einem zentrierten Titel, volle Breite unter einem
// linksbuendigen — eine satzbreite Linie unter zentriertem Titel kippt optisch.
const RULE_WIDTHS = ['auto', 'short', 'third', 'full'];
const RULE_POSITIONS = ['below', 'above', 'both'];
const NUMBER_PREFIXES = ['none', 'chapter', 'part', 'custom'];
const NUMBER_CASES = ['normal', 'uppercase', 'smallcaps'];
const ALIGNS = ['left', 'center'];
const NUMBER_SIZE_PCT = { min: 40, max: 100 };
const PREFIX_TEXT_MAX = 30;

// Kurze Linie = 2.4 × Fliesstextgroesse (im EPUB 2.4em auf Fliesstext-Ebene).
const SHORT_RULE_EM = 2.4;
// Kleinste Gesamtbreite des Rauten-Ornaments (in em), sonst verschwinden die
// Linienstuecke neben der Raute.
const DIAMOND_MIN_EM = 5;
// Trenner zwischen Kapitelnummer und Titel in der gestapelten Ueberschrift.
const NUMBER_DIVIDER = '———';
// Kapitaelchen ohne echte Kapitaelchen-Schnitte: Versalien in 80 % Groesse
// (Google-Fonts-TTF tragen kein `smcp`; dasselbe Verfahren in beiden Formaten).
const SMALLCAPS_SCALE = 0.8;
// Sperrung der Nummer in em.
const NUMBER_TRACKING_EM = 0.12;

const DEFAULTS = Object.freeze({
  ruleStyle: 'single',
  ruleWeight: 'thin',
  ruleWidth: 'auto',
  rulePosition: 'below',
  numberPrefix: 'none',
  numberPrefixText: '',
  numberCase: 'normal',
  numberTracking: true,
  numberSizePct: 62,
  numberDivider: true,
  subTitleAlign: 'left',
  subTitleRule: false,
  pageTitleAlign: 'left',
});

const EPUB_COLUMNS = Object.freeze({
  ruleStyle: 'epub_rule_style',
  ruleWeight: 'epub_rule_weight',
  ruleWidth: 'epub_rule_width',
  rulePosition: 'epub_rule_position',
  numberPrefix: 'epub_number_prefix',
  numberPrefixText: 'epub_number_prefix_text',
  numberCase: 'epub_number_case',
  numberTracking: 'epub_number_tracking',
  numberSizePct: 'epub_number_size_pct',
  numberDivider: 'epub_chapter_number_divider',
  subTitleAlign: 'epub_sub_title_align',
  subTitleRule: 'epub_sub_title_rule',
  pageTitleAlign: 'epub_page_title_align',
});

const ENUMS = Object.freeze({
  ruleStyle: RULE_STYLES,
  ruleWeight: RULE_WEIGHTS,
  ruleWidth: RULE_WIDTHS,
  rulePosition: RULE_POSITIONS,
  numberPrefix: NUMBER_PREFIXES,
  numberCase: NUMBER_CASES,
  subTitleAlign: ALIGNS,
  pageTitleAlign: ALIGNS,
});
const BOOLS = ['numberTracking', 'numberDivider', 'subTitleRule'];

function _bool(v, d) {
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  return d;
}

// Strikt: unbekannte Werte → Default. Nimmt camelCase-Keys.
function validateHeadingStyle(src) {
  const s = src && typeof src === 'object' ? src : {};
  const out = { ...DEFAULTS };
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(s[k])) out[k] = s[k];
  }
  for (const k of BOOLS) out[k] = _bool(s[k], DEFAULTS[k]);
  const n = Number(s.numberSizePct);
  if (s.numberSizePct != null && s.numberSizePct !== '' && Number.isFinite(n)) {
    out.numberSizePct = Math.round(Math.min(NUMBER_SIZE_PCT.max, Math.max(NUMBER_SIZE_PCT.min, n)));
  }
  if (s.numberPrefixText != null) out.numberPrefixText = String(s.numberPrefixText).trim().slice(0, PREFIX_TEXT_MAX);
  return out;
}

function fromPdfChapter(chapter) {
  return validateHeadingStyle(chapter);
}

function fromEpubMeta(meta) {
  const m = meta || {};
  const src = {};
  for (const [k, col] of Object.entries(EPUB_COLUMNS)) src[k] = m[col];
  return validateHeadingStyle(src);
}

const _PREFIX_WORDS = {
  de: { chapter: 'Kapitel', part: 'Teil' },
  en: { chapter: 'Chapter', part: 'Part' },
};

// Text der Kapitelnummer im Kopf: Praefix nur auf der obersten Ebene („Kapitel 3",
// aber „3.2" darunter). Das Verzeichnis traegt nur die Nummer.
function numberText(label, depth, style, lang) {
  if (!label) return null;
  if (depth !== 1) return label;
  let prefix = '';
  if (style.numberPrefix === 'custom') prefix = style.numberPrefixText;
  else if (style.numberPrefix !== 'none') {
    const words = _PREFIX_WORDS[String(lang || 'de').toLowerCase().startsWith('en') ? 'en' : 'de'];
    prefix = words[style.numberPrefix] || '';
  }
  return prefix ? `${prefix} ${label}` : label;
}

// Versalien/Kapitaelchen auf den Nummerntext anwenden; liefert den zu setzenden
// Text und den Groessenfaktor relativ zur Nummerngroesse.
function numberCaseApplied(text, style, lang) {
  if (style.numberCase === 'normal') return { text, scale: 1 };
  const up = String(text).toLocaleUpperCase(lang || 'de');
  return { text: up, scale: style.numberCase === 'smallcaps' ? SMALLCAPS_SCALE : 1 };
}

function isLineRule(ruleStyle) {
  return LINE_RULE_STYLES.includes(ruleStyle);
}

function resolveRuleWidth(ruleWidth, align) {
  if (ruleWidth !== 'auto') return ruleWidth;
  return align === 'center' ? 'short' : 'full';
}

// Linienlaenge in derselben Einheit wie `fullWidth`/`emSize`.
function ruleLength(style, align, fullWidth, emSize) {
  const w = resolveRuleWidth(style.ruleWidth, align);
  let len = w === 'full' ? fullWidth : w === 'third' ? fullWidth / 3 : emSize * SHORT_RULE_EM;
  if (style.ruleStyle === 'diamond') len = Math.max(len, emSize * DIAMOND_MIN_EM);
  return Math.min(len, fullWidth);
}

// Linie ueber und/oder unter der Ueberschrift.
function ruleSlots(position) {
  return { above: position === 'above' || position === 'both', below: position === 'below' || position === 'both' };
}

module.exports = {
  RULE_STYLES, LINE_RULE_STYLES, RULE_WEIGHT_PT, RULE_WEIGHTS, RULE_WIDTHS, RULE_POSITIONS,
  NUMBER_PREFIXES, NUMBER_CASES, ALIGNS, NUMBER_SIZE_PCT, PREFIX_TEXT_MAX,
  SHORT_RULE_EM, DIAMOND_MIN_EM, NUMBER_DIVIDER, SMALLCAPS_SCALE, NUMBER_TRACKING_EM,
  DEFAULTS, EPUB_COLUMNS, ENUMS,
  validateHeadingStyle, fromPdfChapter, fromEpubMeta,
  numberText, numberCaseApplied, isLineRule, resolveRuleWidth, ruleLength, ruleSlots,
};
