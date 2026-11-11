'use strict';
// Push-Sperre: was in einem WordPress-Post steckt, das der Pull (wpToAppHtml)
// NICHT in die App uebernimmt — und ein Push folglich in WordPress loeschen
// wuerde, weil er den ganzen `content` ersetzt. Facade: lib/wp-html.js.
//
// Drei Arten von Verlust, je mit eigener Kennung (fuer den Tooltip am Badge):
//   - Bloecke ausserhalb der Allowlist           `wp:<name>`
//   - Einbettungen/Strukturen, die der Pull wirft `<tag>`, `figure`, `gallery`,
//                                                 `background`, `more`, `nextpage`
//   - Format-Attribute, die der Pull wirft        `format:<art>`
// Allowlist statt Blocklist: was niemand vorhergesehen hat, sperrt, statt still
// verloren zu gehen.

const { WP_COMMENT_RE, DROP_EMBEDS, parseRoot, isAppClass } = require('./dom');

// Gutenberg-Bloecke, die Pull und Push verlustfrei hin und zurueck tragen —
// genau die, die `_wrapBlock` (lib/wp-html.js) selbst erzeugt, plus `freeform`
// (Classic-Block: beliebiges HTML, derselbe Weg wie ein Classic-Editor-Post
// ohne Block-Kommentare). `group` steht drin, obwohl eine fremde Gruppe ihr
// Layout verliert (der Pull loest das `<div>` auf): der Inhalt bleibt, und Lead,
// Quellenverzeichnis, Gedicht und Nachrichtenverlauf sind selbst Gruppen.
// Neuer Block in `_wrapBlock` ⇒ hier eintragen, sonst sperrt der eigene Push sich selbst.
const ROUND_TRIP_BLOCKS = new Set([
  'paragraph', 'heading', 'list', 'list-item', 'quote', 'code', 'separator',
  'image', 'table', 'group', 'freeform',
]);

// ── Format-Attribute ────────────────────────────────────────────────────────
// Gemessen an den Ausgaben des Block-Editors (WP 6.x) und des Classic-Editors:
// verworfen, aber ohne sichtbare Folge im Blog — also KEIN Sperrgrund. Jede
// weitere Ausnahme muss diese Bedingung erfuellen (docs/blog-sync.md, „Push-Sperre").
const HARMLESS_DROPPED_CLASSES = [
  /^wp-/,                        // Block-Kennung (wp-block-*, wp-element-caption) — schreibt der Push selbst
  /^size-/,                      // Bildgroesse-Auswahl: die Datei-URL (`src`) bleibt dieselbe
  /^alignnone$/,                 // Classic-Vorgabe „keine Ausrichtung"
  /^is-layout-/,                 // Layout-Klassen, die WP beim Rendern ohnehin neu setzt
  /^is-style-default$/,
  /^has-fixed-layout$/,          // Tabellen-Vorgabe des Block-Editors
  /^has-alpha-channel-opacity$/, // Trenner-Vorgabe, schreibt der Push selbst
  /^has-text-align-left$/,       // Vorgabe bei Links-nach-rechts-Schrift
];

// Deklarationen im `style`-Attribut ohne sichtbare Wirkung (Kopierreste aus
// Google Docs/Word, die der Classic-Editor uebernimmt).
const HARMLESS_DECLARATIONS = [
  /^font-weight:(400|normal)$/,
  /^font-style:normal$/,
  /^text-decoration:none$/,
  /^vertical-align:baseline$/,
  /^white-space:pre-wrap$/,
  /^background-color:(transparent|rgba\(0,0,0,0\))$/,
];

function _classReason(cls, tag) {
  if (isAppClass(cls)) return null;                         // der Pull behaelt sie
  if (HARMLESS_DROPPED_CLASSES.some(re => re.test(cls))) return null;
  if (/^has-text-align-/.test(cls)) {
    // An Tabellenzellen hebt der Pull die Ausrichtung auf `data-align`.
    return (tag === 'td' || tag === 'th') ? null : 'format:text-align';
  }
  if (cls === 'has-drop-cap') return 'format:drop-cap';
  if (/font-size$/.test(cls)) return 'format:font-size';
  if (/font-family$/.test(cls)) return 'format:font-family';
  if (cls === 'has-inline-color' || cls === 'has-background' || /^has-.*(color|background|gradient)/.test(cls)) return 'format:color';
  if (/^align(left|right|center|wide|full)$/.test(cls)) return 'format:align';
  if (cls === 'is-resized') return 'format:image-size';
  if (/^is-style-/.test(cls)) return 'format:block-style';
  return `format:${cls}`;
}

function _declReason(prop, tag) {
  if (prop === 'text-align') return 'format:text-align';
  if (prop === 'color' || prop === 'background' || prop === 'background-color') return 'format:color';
  if (prop === 'font-size') return 'format:font-size';
  if (prop === 'font-family') return 'format:font-family';
  if (/^(width|height|max-width|aspect-ratio|object-fit)$/.test(prop) && (tag === 'img' || tag === 'figure')) return 'format:image-size';
  return `format:style-${prop}`;
}

/** Format-Attribute, die der Pull verwirft und die im Blog sichtbar sind. */
function formatLosses(root) {
  const found = new Set();
  for (const el of root.querySelectorAll('[class]')) {
    const tag = el.tagName.toLowerCase();
    for (const cls of String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean)) {
      const reason = _classReason(cls, tag);
      if (reason) found.add(reason);
    }
  }
  for (const el of root.querySelectorAll('[style]')) {
    const tag = el.tagName.toLowerCase();
    for (const decl of String(el.getAttribute('style') || '').split(';')) {
      const norm = decl.toLowerCase().replace(/\s+/g, '');
      if (!norm || !norm.includes(':')) continue;
      if (HARMLESS_DECLARATIONS.some(re => re.test(norm))) continue;
      const prop = norm.slice(0, norm.indexOf(':'));
      // Hintergrundbild hat seine eigene Kennung (siehe unten).
      if (/^background(-image)?$/.test(prop) && /url\(/.test(norm)) continue;
      found.add(_declReason(prop, tag));
    }
  }
  // Startnummer/Umkehrung einer nummerierten Liste schreibt der Push nicht.
  if (root.querySelector('ol[start], ol[reversed]')) found.add('format:list-start');
  return found;
}

/** Liefert eine sortierte Liste kurzer Kennungen (leer = round-trip-sicher).
 *  Der eigene Push erzeugt nur Bloecke und Klassen, die hier frei sind; ein
 *  unveraendert zurueckgespielter App-Stand loest die Sperre nicht aus
 *  (gegated in tests/unit/wp-html-blocks.test.mjs). */
function wpLossyBlocks(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const found = new Set();
  for (const m of raw.matchAll(/<!--\s*wp:([a-z0-9/-]+)/gi)) {
    const name = m[1].toLowerCase();
    if (!ROUND_TRIP_BLOCKS.has(name)) found.add(`wp:${name}`);
  }
  // Weiterlesen-/Seitenumbruch-Marke im Classic-Post (ohne Block-Kommentar):
  // der Push schreibt keine HTML-Kommentare, die Marke fiele still weg.
  for (const m of raw.matchAll(/<!--\s*(more|nextpage)\b/gi)) {
    const name = m[1].toLowerCase();
    if (!found.has(`wp:${name}`)) found.add(name);
  }
  const root = parseRoot(raw.replace(WP_COMMENT_RE, ''));
  if (root) {
    for (const el of root.querySelectorAll(DROP_EMBEDS)) found.add(el.tagName.toLowerCase());
    for (const fig of root.querySelectorAll('figure')) {
      const imgs = fig.querySelectorAll('img').length;
      if (!imgs && !fig.querySelector('table')) found.add('figure');
      if (imgs > 1) found.add('gallery');
    }
    for (const el of root.querySelectorAll('[style]')) {
      if (/background(-image)?\s*:[^;]*url\(/i.test(el.getAttribute('style') || '')) found.add('background');
    }
    for (const reason of formatLosses(root)) found.add(reason);
  }
  return [...found].sort();
}

module.exports = { wpLossyBlocks, formatLosses, ROUND_TRIP_BLOCKS };
