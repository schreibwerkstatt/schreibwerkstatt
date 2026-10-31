'use strict';
// Kanonischer Anker einer Idee. Ein Kapitel mit genau einem Abschnitt und ohne
// Unterkapitel ist EIN Ort — Kapitel und Abschnitt bezeichnen dieselbe Stelle.
// Damit die Ideen eines solchen Buchs nicht mal am Kapitel, mal am Abschnitt
// liegen, hängt jede Idee dort am Abschnitt: beim Anlegen und Umziehen
// (routes/ideen.js) und schon im Vorschlag (lib/chat-idee-proposals.js,
// routes/jobs/ideen-chat-tools.js). Frontend-Pendant für Board und Ideen-Karte:
// public/js/book/ideen-shared.js#soleChapterPages/ideenPlace.
// docs/ideen-board.md „Einabschnitts-Kapitel".

const { getSoleChapterPage } = require('../db/book-chat/text');

/**
 * Kapitel-Anker eines Einabschnitts-Kapitels → dessen Abschnitt; jeder andere
 * Anker bleibt. `anchor` = { kind: 'page'|'chapter', id, name? }; das Ergebnis
 * hat dieselbe Form.
 */
function canonicalIdeeAnchor(anchor) {
  if (!anchor || anchor.kind !== 'chapter') return anchor;
  const sole = getSoleChapterPage(anchor.id);
  return sole ? { kind: 'page', id: sole.page_id, name: sole.page_name } : anchor;
}

module.exports = { canonicalIdeeAnchor };
