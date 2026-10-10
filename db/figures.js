// Facade des Figuren-Datenzugriffs. Die Umsetzung liegt in ./figures/:
// refs (fig_id↔id-Übersetzung, Namens-/Beleg-Auflösung), save (Match-Planung +
// die drei Reconcile-Modi), patch (figur-granulare Katalog-Pflege), aliases
// (dauerhafte Namens-Aliasse aus dem Merge), active (SSoT «aktive Figur» der
// KI-Kontext-Loader), events (Lebensereignisse, Soziogramm, nachgetragene
// Beziehungen) und queries (Lesepfade + der
// abgeleitete Auftritts-Index). Externe Konsumenten importieren nur diese Datei.

const { RELATION_INVERSES, dedupRelations, figIdMaps } = require('./figures/refs');
const { planFigurenMatch, saveFigurenToDb } = require('./figures/save');
const { activeFigureSql, countActiveFigures } = require('./figures/active');
const { listFigureAliasesByFigure, addFigureAliases } = require('./figures/aliases');
const { PATCHABLE_FIELDS, validateFigurePatch, patchFigure } = require('./figures/patch');
const { updateFigurenEvents, updateFigurenSoziogramm, addFigurenBeziehungen } = require('./figures/events');
const {
  listFigurenWithDetails, getChapterFigures, rebuildFigureAppearances,
  getChapterFigureRelations, getFigureWithDetails,
} = require('./figures/queries');

module.exports = {
  planFigurenMatch,
  activeFigureSql,
  countActiveFigures,
  listFigureAliasesByFigure,
  addFigureAliases,
  PATCHABLE_FIELDS,
  validateFigurePatch,
  patchFigure,
  RELATION_INVERSES,
  dedupRelations,
  figIdMaps,
  saveFigurenToDb,
  updateFigurenEvents,
  updateFigurenSoziogramm,
  addFigurenBeziehungen,
  listFigurenWithDetails,
  getChapterFigures,
  getChapterFigureRelations,
  getFigureWithDetails,
  rebuildFigureAppearances,
};
