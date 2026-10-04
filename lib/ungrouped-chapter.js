'use strict';
// Ersatz-Kapitelname für Abschnitte ohne Kapitel. Er geht als Kapitelname in
// die KI-Prompts (groupByChapter) und kommt in `kapitel`/`seite`-Feldern der
// Antworten zurück; dort ist er ein Marker, kein echter Abschnittstitel.
// Ältere Analyse-Daten tragen noch den früheren Namen «Sonstige Seiten» —
// `isUngroupedChapterName` erkennt beide.

const UNGROUPED_CHAPTER_NAME = 'Sonstige Abschnitte';
const LEGACY_UNGROUPED_NAMES = new Set([UNGROUPED_CHAPTER_NAME, 'Sonstige Seiten']);

function isUngroupedChapterName(name) {
  return LEGACY_UNGROUPED_NAMES.has(name);
}

module.exports = { UNGROUPED_CHAPTER_NAME, isUngroupedChapterName };
