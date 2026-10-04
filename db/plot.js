'use strict';
// CRUD für die Plot-Werkstatt (Beat-Board). Pro Buch + User skopiert; der
// Owner-/ACL-Check geschieht im Route-Handler.
//
// Datenmodell:
//   plot_acts        — Spalten des Boards (Akte/Phasen), geordnet via position.
//   plot_beats       — Karten (Handlungspunkte) in einem Akt, geordnet via sort_order.
//   plot_beat_figures — M:M Beat ↔ Figur (welche Figuren im Beat vorkommen).
//
// status eines Beats: 'geplant' | 'im_buch' — binäre Realisierungsachse („Idee vs.
// eingearbeitet"). verworfen (0/1) ist eine orthogonale Verwerfen-Achse (bleibt bei
// Status-Wechsel erhalten). chapter_id (SET NULL) verknüpft den Beat mit dem
// Kapitel, in dem er im Manuskript landet.
//
// archiviert (0/1) auf plot_acts ist die Akt-Ebene davon — und bewusst NICHT
// dasselbe wie verworfen: „verworfen" heisst ausgemustert (soll nicht ins Buch),
// „archiviert" heisst erledigt (ist im Buch, Akt abgeschlossen). Die Beats eines
// archivierten Akts bleiben darum in allen Kennzahlen; das Flag wirkt auf die
// Anzeige (Spalte hinter dem Archiv-Schalter) und auf den Konsistenz-Prompt (der
// Akt wird als abgeschlossen deklariert statt weiter beanstandet).
//
// Facade: die Umsetzung liegt in ./plot/ — structure (Akte, Stränge, Hybrid-Akte,
// Lückenlos-Nummerierung), beats (CRUD, Brücken, Reorder), figure-usage, relations,
// runs (KI-Lauf-Historien) und anchor (Ist-Index). Externe Konsumenten importieren
// nur diese Datei.

const structure = require('./plot/structure');
const beats = require('./plot/beats');
const { figurePlotUsage } = require('./plot/figure-usage');
const { plotEntityLinks } = require('./plot/entity-links');
const relations = require('./plot/relations');
const runs = require('./plot/runs');
const anchor = require('./plot/anchor');

module.exports = {
  listActs: structure.listActs, getAct: structure.getAct, createAct: structure.createAct,
  updateAct: structure.updateAct, deleteAct: structure.deleteAct, reorderActs: structure.reorderActs,
  threadHasOwnActs: structure.threadHasOwnActs, forkThreadActs: structure.forkThreadActs,
  unforkThreadActs: structure.unforkThreadActs,
  listThreads: structure.listThreads, getThread: structure.getThread, createThread: structure.createThread,
  updateThread: structure.updateThread, deleteThread: structure.deleteThread,
  reorderThreads: structure.reorderThreads, _validThreadId: structure._validThreadId,
  actFitsThread: structure.actFitsThread,
  listBeats: beats.listBeats, getBeat: beats.getBeat, getBeatMeta: beats.getBeatMeta,
  createBeat: beats.createBeat, updateBeat: beats.updateBeat, deleteBeat: beats.deleteBeat,
  reorderBeats: beats.reorderBeats, pageBeatCounts: beats.pageBeatCounts,
  chapterBeatCounts: beats.chapterBeatCounts, listFigureIdentities: beats.listFigureIdentities,
  resolveFigureIds: beats.resolveFigureIds, resolveDraftFigureIds: beats.resolveDraftFigureIds,
  resolveMotifIds: beats.resolveMotifIds, resolveLocationIds: beats.resolveLocationIds,
  listBeatRelations: relations.listBeatRelations, getBeatRelation: relations.getBeatRelation,
  createBeatRelation: relations.createBeatRelation, deleteBeatRelation: relations.deleteBeatRelation,
  figurePlotUsage, plotEntityLinks,
  insertPlotConsistencyRun: runs.insertPlotConsistencyRun, listPlotConsistencyRuns: runs.listPlotConsistencyRuns,
  getPlotConsistencyRun: runs.getPlotConsistencyRun, deletePlotConsistencyRun: runs.deletePlotConsistencyRun,
  insertPlotBrainstormRun: runs.insertPlotBrainstormRun, listPlotBrainstormRuns: runs.listPlotBrainstormRuns,
  getPlotBrainstormRun: runs.getPlotBrainstormRun, deletePlotBrainstormRun: runs.deletePlotBrainstormRun,
  listBeatsForAnchor: anchor.listBeatsForAnchor, replaceBeatOccurrences: anchor.replaceBeatOccurrences,
  beatOccurrenceMap: anchor.beatOccurrenceMap, beatOccurrenceEntry: anchor.beatOccurrenceEntry,
  beatAnchorStale: anchor.beatAnchorStale, beatAnchorLastRun: anchor.beatAnchorLastRun,
};
