'use strict';
// Überschriften sind einzeilig — in jedem Export. Ein `<br>` in `<h1>`–`<h6>`
// (Alt-Bestand, Import) wird zum Leerzeichen; am Rand fällt es weg. Der Editor
// setzt dort keinen weichen Umbruch mehr (shared/soft-break.js#softBreakNoop).
//
// Why: die Ausgabewege lasen den Umbruch verschieden — Markdown schob den Rest
// der Überschrift in einen Absatz, Word/Substack zeigten ein Leerzeichen, EPUB
// zwei Zeilen. Eine Überschrift ist Gliederung (Inhaltsverzeichnis, Navigation),
// kein gesetzter Vers.
//
// Aufgerufen vor jedem Walker: in export-builders/shared.js#prepareCitations
// (EPUB, HTML, Markdown, Text, Substack, Word) und in pdf-render/index.js (PDF).

const HEADING_RE = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const BR_RE = /<br\s*\/?>/gi;
const HAS_BR = /<br\b/i;

function flattenHeadingBreaks(html) {
  if (typeof html !== 'string' || !/<h[1-6]\b/i.test(html) || !HAS_BR.test(html)) return html;
  return html.replace(HEADING_RE, (all, tag, attrs, inner) => {
    if (!HAS_BR.test(inner)) return all;
    // Ohne Text bleibt das <br> der Caret-Slot einer leeren Überschrift.
    if (!inner.replace(BR_RE, '').replace(/<[^>]*>/g, '').trim()) return all;
    const flat = inner
      .replace(/^(\s*<br\s*\/?>\s*)+/i, '')
      .replace(/(\s*<br\s*\/?>\s*)+$/i, '')
      .replace(/\s*(<br\s*\/?>\s*)+/gi, ' ');
    return `<${tag}${attrs}>${flat}</${tag}>`;
  });
}

function flattenHeadingBreaksInGroups(groups) {
  if (!Array.isArray(groups)) return groups;
  return groups.map((g) => {
    const pages = (g.pages || []).map((x) => {
      const html = x?.pd?.html;
      const next = flattenHeadingBreaks(html);
      return next === html ? x : { ...x, pd: { ...x.pd, html: next } };
    });
    return { ...g, pages };
  });
}

module.exports = { flattenHeadingBreaks, flattenHeadingBreaksInGroups };
