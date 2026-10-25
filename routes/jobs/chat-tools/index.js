'use strict';
// Handler des gemeinsamen Werkzeug-Katalogs der agentischen Chats (Buch-, Plot-,
// Ideen-, Recherche-Chat). Definitionen: public/js/prompts/chat-tools/, Zugriff
// je Chat: …/access.js, Auswahl pro Lauf: ./select.js. Regeln: ./CLAUDE.md.
// Jede Tool-Funktion nimmt (input, ctx) und gibt ein JSON-serialisierbares Objekt.
// ctx = { bookId, userEmail, sessionId?, jobSignal, logger, offeredTools, resultCapChars, inputBudgetChars }

const { _truncateResult, resultCapFor } = require('./shared');
const catalog = require('./tools-catalog');
const timeline = require('./tools-timeline');
const text = require('./tools-text');
const similar = require('./tools-similar');
const figures = require('./tools-figures');
const analysis = require('./tools-analysis');
const revisions = require('./tools-revisions');
const werkstatt = require('./tools-werkstatt');
const plot = require('./tools-plot');
const motif = require('./tools-motif');
const image = require('./tools-image');
const research = require('./tools-research');
const chatHistory = require('./tools-chat-history');
const editStatus = require('./tools-edit-status');
const redundancy = require('./tools-redundancy');
const { validateFinalAnswerCitations } = require('./citations');

const embed = require('../../../lib/embed');
const { imageGenEnabled } = require('../../../lib/image-gen');
const {
  listFiguresWithMentions, listLocationsWithFirstPage, listScenesWithPlaces, listSongsWithFirstPage, listIdeenWithPlaces,
} = require('../../../db/book-chat/catalog');
const { getLatestContinuityCheck, listTimelineEvents } = require('../../../db/book-chat/timeline');
const { getLatestBookReview, listLatestChapterReviews, listLektoratHotspotRows } = require('../../../db/book-chat/analysis');
const { countActiveResearchItems } = require('../../../db/book-chat/research');
const { listWorldFacts } = require('../../../db/world-facts');
const { listBookStatus } = require('../../../db/redaktion');
const redundancyDb = require('../../../db/redundancy');
const { listActs } = require('../../../db/plot');
const { listMotifs } = require('../../../db/motifs');
const { listDraftFigures } = require('../../../db/draft-figures');
const { hasSearchableHistory } = require('../../../db/chat-search');

const TOOLS = {
  list_chapters:            catalog.tool_list_chapters,
  search_passages:          text.tool_search_passages,
  search_similar:           similar.tool_search_similar,
  get_pages:                text.tool_get_pages,
  get_chapter_text:         text.tool_get_chapter_text,
  quote_passage:            text.tool_quote_passage,
  get_dialogue:             text.tool_get_dialogue,
  find_repetitions:         analysis.tool_find_repetitions,

  list_figures:             catalog.tool_list_figures,
  get_figure_profile:       figures.tool_get_figure_profile,
  get_figure_mentions:      figures.tool_get_figure_mentions,
  get_figure_relations:     figures.tool_get_figure_relations,
  get_figure_age:           timeline.tool_get_figure_age,
  get_timeline:             timeline.tool_get_timeline,
  list_scenes:              catalog.tool_list_scenes,
  list_locations:           catalog.tool_list_locations,
  get_location_profile:     catalog.tool_get_location_profile,
  list_world_facts:         catalog.tool_list_world_facts,
  list_songs:               catalog.tool_list_songs,
  list_continuity_issues:   timeline.tool_list_continuity_issues,

  get_reviews:              analysis.tool_get_reviews,
  get_lektorat:             analysis.tool_get_lektorat,
  get_stil_metrics:         analysis.tool_get_stil_metrics,
  get_edit_status:          editStatus.tool_get_edit_status,
  list_redundancies:        redundancy.tool_list_redundancies,
  list_revisions:           revisions.tool_list_revisions,
  get_book_settings:        catalog.tool_get_book_settings,
  search_chat_history:      chatHistory.tool_search_chat_history,

  get_plot_board:           plot.tool_get_plot_board,
  get_motifs:               motif.tool_get_motifs,
  list_werkstatt_drafts:    werkstatt.tool_list_werkstatt_drafts,
  list_ideen:               catalog.tool_list_ideen,
  list_research_items:      research.tool_list_research_items,
  read_research_item:       research.tool_read_research_item,
  search_research_passages: research.tool_search_research_passages,
  lookup_literature:        research.tool_lookup_literature,
  list_book_entities:       research.tool_list_book_entities,
  generate_image:           image.tool_generate_image,
};

// ── Verfügbarkeit ────────────────────────────────────────────────────────────
// Ein Werkzeug, dessen Endpunkt fehlt oder für dessen Daten das Buch nichts hat,
// wird gar nicht erst angeboten: es kostet Input-Tokens in jeder Runde und lockt
// das Modell in einen garantiert leeren Aufruf. Jede Prüfung nutzt dieselbe
// DB-Funktion wie der Handler (gleicher Scope, kein Drift). Fehlt ein Eintrag,
// ist das Werkzeug immer verfügbar. Daten-Prüfungen laufen nur einmal pro Lauf.
const _uid = (ctx) => ctx.userEmail || null;
const _any = (rows) => Array.isArray(rows) && rows.length > 0;
const _hasFigures = (ctx) => _any(listFiguresWithMentions(ctx.bookId, _uid(ctx)));
const _hasLocations = (ctx) => _any(listLocationsWithFirstPage(ctx.bookId, _uid(ctx), null));
const _hasResearch = (ctx) => countActiveResearchItems(ctx.bookId) > 0;

const AVAILABILITY = {
  search_similar:           () => embed.isEnabled(),
  generate_image:           () => imageGenEnabled(),

  list_figures:             _hasFigures,
  get_figure_profile:       _hasFigures,
  get_figure_mentions:      _hasFigures,
  get_figure_relations:     _hasFigures,
  get_figure_age:           _hasFigures,
  get_timeline:             (ctx) => _any(listTimelineEvents(ctx.bookId, _uid(ctx))),
  list_scenes:              (ctx) => _any(listScenesWithPlaces(ctx.bookId, _uid(ctx), {})),
  list_locations:           _hasLocations,
  get_location_profile:     _hasLocations,
  list_world_facts:         (ctx) => _any(listWorldFacts(ctx.bookId, _uid(ctx), { withRefuted: true })),
  list_songs:               (ctx) => _any(listSongsWithFirstPage(ctx.bookId, _uid(ctx), {})),
  // Ein gelaufener Check ohne Befund ist eine Aussage («keine Widersprüche»).
  list_continuity_issues:   (ctx) => !!getLatestContinuityCheck(ctx.bookId, _uid(ctx)),

  get_reviews:              (ctx) => !!getLatestBookReview(ctx.bookId, _uid(ctx)) || _any(listLatestChapterReviews(ctx.bookId, _uid(ctx), null)),
  get_lektorat:             (ctx) => _any(listLektoratHotspotRows(ctx.bookId, _uid(ctx), null)),
  get_edit_status:          (ctx) => Object.keys(listBookStatus(ctx.bookId)).length > 0,
  list_redundancies:        (ctx) => !!ctx.userEmail && !!redundancyDb.getLastRun(ctx.bookId, ctx.userEmail),
  search_chat_history:      (ctx) => !!ctx.userEmail && hasSearchableHistory({
    bookId: ctx.bookId, userEmail: ctx.userEmail, excludeSessionId: ctx.sessionId || null,
  }),

  // Beats hängen immer an einem Akt: ohne Akt kein Board.
  get_plot_board:           (ctx) => _any(listActs(ctx.bookId, _uid(ctx))),
  get_motifs:               (ctx) => _any(listMotifs(ctx.bookId, _uid(ctx))),
  list_werkstatt_drafts:    (ctx) => _any(listDraftFigures(ctx.bookId, _uid(ctx))),
  list_ideen:               (ctx) => _any(listIdeenWithPlaces(ctx.bookId, _uid(ctx), {})),
  list_research_items:      _hasResearch,
  read_research_item:       _hasResearch,
  search_research_passages: (ctx) => embed.isEnabled() && _hasResearch(ctx),
};

/**
 * Welche der `names` in diesem Lauf NICHT angeboten werden (Endpunkt fehlt, keine
 * Daten im Buch). Eine fehlschlagende Prüfung blendet nichts aus — lieber ein
 * leerer Aufruf als ein fehlendes Werkzeug.
 * @returns {Set<string>}
 */
function unavailableTools(names, ctx) {
  const out = new Set();
  for (const name of names) {
    const check = AVAILABILITY[name];
    if (!check) continue;
    try {
      if (!check(ctx)) out.add(name);
    } catch (e) {
      ctx?.logger?.warn?.(`Verfügbarkeit von ${name} nicht prüfbar (${e.message}) — wird angeboten.`);
    }
  }
  return out;
}

async function executeTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result, resultCapFor(ctx));
}

module.exports = { executeTool, unavailableTools, TOOLS, AVAILABILITY, validateFinalAnswerCitations };
