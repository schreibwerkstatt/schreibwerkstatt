'use strict';

// Cache-oder-Rendern fuer Diagramme — die EINE Stelle, an der aus Quelltext ein
// Bild wird.
//
// Zwei Konsumenten mit verschiedenen Zielformaten, aber demselben Cache:
//   lib/diagram-export.js — PDF/DOCX (png), HTML/EPUB (svg)
//   routes/diagram.js     — Bildschirm-Leseansichten (svg)
// Genau darum liegt das hier und nicht in einem der beiden: der Cache ist
// inhaltsadressiert (Quelltext + Theme + Render-Version), also rendert dasselbe
// Diagramm einmal — egal ob es zuerst am Bildschirm oder zuerst im Export
// gebraucht wurde. Zwei Cache-Pfade daneben haetten diese Eigenschaft verloren.
//
// lib/mermaid-render.js bleibt DB-frei (reiner Playwright-Renderer); die
// Persistenz kommt erst hier dazu.

const { renderDiagram, renderKey } = require('./mermaid-render');
const { getCachedDiagram, putCachedDiagram } = require('../db/mermaid-cache');

/** Die beiden Theme-Schluessel der App: `default` = hell (auch der Export),
 *  `dark` = dunkel. Welche Farben sie tragen, sagt allein
 *  public/js/diagram/mermaid-theme.js. */
const THEMES = ['default', 'dark'];

function _theme(theme) {
  return theme === 'dark' ? 'dark' : 'default';
}

/** Ein Diagramm rendern, Cache zuerst.
 *
 *  Liefert `{ svg, png, width, height }` oder `null`. `null` ist ein regulaeres
 *  Ergebnis (Invariante B in lib/diagram-export.js): der Aufrufer laesst dann
 *  den Quelltext stehen. Ob „nicht renderbar" am Diagramm oder an der fehlenden
 *  Chromium-Installation liegt, beantwortet `rendererUnavailable()`. */
async function renderCachedDiagram(code, theme) {
  const src = String(code || '').trim();
  if (!src) return null;
  const t = _theme(theme);
  const key = renderKey(src, t);
  const hit = getCachedDiagram(key);
  if (hit) return hit;
  const fresh = await renderDiagram(src, { theme: t });
  if (!fresh) return null;
  putCachedDiagram(key, t, fresh);
  return fresh;
}

module.exports = { renderCachedDiagram, THEMES };
