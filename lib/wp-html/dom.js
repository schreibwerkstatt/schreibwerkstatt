'use strict';
// Geteilte Bausteine von lib/wp-html.js (Facade) und seinen Teilmodulen
// (autop.js, lossy.js): Parser-Wurzel, Gutenberg-Kommentar-Muster, die Liste
// der verworfenen Einbettungen und der Klassenfilter. EINE Definition fuer Pull,
// Push und Push-Sperre — sonst ist der Round-Trip nicht geschlossen.

const { parseHTML } = require('linkedom');

const WP_COMMENT_RE = /<!--\s*\/?\s*wp:[^>]*-->/g;

// Nicht round-trip-faehige Einbettungen: werden bei Import wie Export verworfen.
// Bilder (`img`/`figure`) sind bewusst NICHT hier — die bleiben erhalten.
const DROP_EMBEDS = 'video, audio, iframe, embed, object, picture, source';

function parseRoot(html) {
  const wrapped = `<!DOCTYPE html><html><body><div id="r">${html}</div></body></html>`;
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

/** Traegt eine Klasse auf der App-Seite Bedeutung?
 *
 *  `wp-image-<n>` ja: sie traegt die Attachment-ID fuer einen sauberen
 *  Push-Round-Trip. Die Utility-Klassen von WordPress und Theme nein: `wp-*`,
 *  `has-*` (Farben, Ausrichtung), `is-*` (`is-style-*`, `is-resized`,
 *  `is-layout-*`), `size-*` (Bildgroesse), `align*` (Bildausrichtung),
 *  `columns-*` (Galerie). Keine App-Klasse beginnt so.
 *
 *  Was der Filter verwirft und sichtbar war, sperrt den Push
 *  (lossy.js#formatLosses) — die beiden Listen gehoeren zusammen. */
const WP_UTILITY_CLASS_RE = /^(?:wp-|has-|is-|size-|align|columns-)/;
function isAppClass(c) {
  return !!c && (/^wp-image-\d+$/.test(c) || !WP_UTILITY_CLASS_RE.test(c));
}

/** Hat der Post Gutenberg-Block-Kommentare? Ohne sie ist er ein Classic-Post
 *  (Absaetze entstehen erst beim Rendern, siehe autop.js). */
function hasBlockComments(raw) {
  return /<!--\s*\/?\s*wp:/.test(String(raw || ''));
}

module.exports = { WP_COMMENT_RE, DROP_EMBEDS, parseRoot, isAppClass, hasBlockComments };
