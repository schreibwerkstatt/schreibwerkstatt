'use strict';
// Nachbarseiten-Kontext: letzter Absatz der Vorseite + erster Absatz der
// Folgeseite. Reiner Lesekontext für Übergänge (Tempus/Perspektive/Anschluss)
// und die Stil-/Szenenbewertung — geprüft wird ausschliesslich die Seite selbst
// (Prompt-Pflicht + dropNeighbourFindings als Code-Backstop).
const NEIGHBOUR_EXCERPT_CHARS = 600;

function _paragraphs(text) {
  return (text || '').trim().split(/\n{2,}|(?<=[.!?…])\s{2,}/).map(p => p.trim()).filter(Boolean);
}

// Letzten Absatz eines Texts extrahieren (max. maxChars Zeichen), vorne an
// einem Satzanfang abgeschnitten.
function lastParagraph(text, maxChars = NEIGHBOUR_EXCERPT_CHARS) {
  const clean = (text || '').trim();
  if (!clean) return null;
  const paragraphs = _paragraphs(clean);
  const last = paragraphs.length ? paragraphs[paragraphs.length - 1] : clean;
  if (last.length <= maxChars) return last;
  const tail = last.slice(-maxChars);
  const firstSentenceStart = tail.search(/[A-ZÄÖÜ]/);
  return firstSentenceStart > 0 ? tail.slice(firstSentenceStart) : tail;
}

// Ersten Absatz eines Texts extrahieren (max. maxChars Zeichen), hinten am
// letzten Satzende innerhalb des Limits abgeschnitten. Findet sich im ersten
// Drittel kein Satzende, bleibt der harte Schnitt.
function firstParagraph(text, maxChars = NEIGHBOUR_EXCERPT_CHARS) {
  const clean = (text || '').trim();
  if (!clean) return null;
  const first = _paragraphs(clean)[0] || clean;
  if (first.length <= maxChars) return first;
  const head = first.slice(0, maxChars);
  let cut = -1;
  for (const m of head.matchAll(/[.!?…][»«"'“”‘’]?(?=\s|$)/g)) cut = m.index + m[0].length;
  return cut > maxChars / 3 ? head.slice(0, cut) : head;
}

// Seiten in Leserichtung neben `currentPageId`: `offset` -1 = davor, +1 = danach,
// nächste zuerst, höchstens `max` Stück. `pages` MUSS in Buchreihenfolge kommen
// (loadOrderedBookContents) — `pages.position` ist kapitel-lokal und taugt nicht
// über Kapitelgrenzen hinweg.
//
// Kapitelgrenzen werden überschritten. Why: wer nur einen Abschnitt pro Kapitel
// schreibt, bekam sonst NIE einen Nachbarn zu sehen, und der Abschnittsanfang
// stand ohne jeden Anschluss da. Ob ein Nachbar aus einem anderen Kapitel stammt,
// sagt `isChapterChange`; der Prompt kennzeichnet ihn als Kapitelwechsel.
// Mehrere Kandidaten, weil leere Abschnitte (angelegt, noch ungeschrieben) keinen
// Text liefern und übersprungen werden.
function neighbourPages(pages, currentPageId, offset, max = 1) {
  if (!Array.isArray(pages) || !pages.length) return [];
  const idx = pages.findIndex(p => String(p.id) === String(currentPageId));
  if (idx === -1) return [];
  const out = [];
  for (let i = idx + offset; i >= 0 && i < pages.length && out.length < max; i += offset) out.push(pages[i]);
  return out;
}
const findPreviousPage = (pages, id) => neighbourPages(pages, id, -1)[0] || null;
const findNextPage     = (pages, id) => neighbourPages(pages, id, +1)[0] || null;

function isChapterChange(page, neighbour) {
  if (!page || !neighbour) return false;
  return String(page.chapter_id || '') !== String(neighbour.chapter_id || '');
}

// Findings verwerfen, deren «original» nicht auf der geprüften Seite steht,
// wohl aber in einem Nachbarseiten-Auszug: das Modell hat den Lesekontext
// trotz Verbot mitgeprüft. Vergleich whitespace-kollabiert wie der Frontend-
// Matcher (public/js/utils/html-find.js#findInHtml). Findings, die in keinem
// der Texte stehen, bleiben unangetastet — die fängt wie bisher die
// Positionierung im Frontend ab.
function dropNeighbourFindings(fehler, pageText, excerpts) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ctx = (excerpts || []).map(norm).filter(Boolean);
  if (!Array.isArray(fehler) || !ctx.length) return fehler;
  const page = norm(pageText);
  return fehler.filter(f => {
    const o = norm(f?.original);
    if (!o || page.includes(o)) return true;
    return !ctx.some(c => c.includes(o));
  });
}

module.exports = {
  NEIGHBOUR_EXCERPT_CHARS, lastParagraph, firstParagraph,
  neighbourPages, findPreviousPage, findNextPage, isChapterChange, dropNeighbourFindings,
};
