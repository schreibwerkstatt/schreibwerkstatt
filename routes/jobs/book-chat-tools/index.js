'use strict';
// Facade fuer Buch-Chat-Tools. Buendelt Submodule zu einem TOOLS-Dispatcher.
// Jede Tool-Funktion nimmt (input, ctx) und gibt ein JSON-serialisierbares Objekt zurueck.
// ctx = { bookId, userEmail, jobSignal, logger }
// Uebersicht aller Tools + Vertrag: docs/buchchat-tools.md

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
const { validateFinalAnswerCitations } = require('./citations');

const TOOLS = {
  list_chapters:          catalog.tool_list_chapters,
  list_figures:           catalog.tool_list_figures,
  list_revisions:         catalog.tool_list_revisions,
  list_ideen:             catalog.tool_list_ideen,
  list_locations:         catalog.tool_list_locations,
  get_location_profile:   catalog.tool_get_location_profile,
  list_scenes:            catalog.tool_list_scenes,
  list_songs:             catalog.tool_list_songs,
  list_world_facts:       catalog.tool_list_world_facts,
  get_book_settings:      catalog.tool_get_book_settings,

  list_continuity_issues: timeline.tool_list_continuity_issues,
  get_timeline:           timeline.tool_get_timeline,
  get_figure_age:         timeline.tool_get_figure_age,

  count_pronouns:         figures.tool_count_pronouns,
  get_figure_mentions:    figures.tool_get_figure_mentions,
  get_figure_relations:   figures.tool_get_figure_relations,
  get_figure_profile:     figures.tool_get_figure_profile,

  search_passages:        text.tool_search_passages,
  search_similar:         similar.tool_search_similar,
  get_pages:              text.tool_get_pages,
  get_chapter_text:       text.tool_get_chapter_text,
  quote_passage:          text.tool_quote_passage,
  quote_match:            text.tool_quote_match,
  get_dialogue:           text.tool_get_dialogue,
  find_first_last_mention: figures.tool_find_first_last_mention,

  get_reviews:            analysis.tool_get_reviews,
  get_lektorat_hotspots:  analysis.tool_get_lektorat_hotspots,
  get_lektorat_findings:  analysis.tool_get_lektorat_findings,
  get_stil_metrics:       analysis.tool_get_stil_metrics,
  find_repetitions:       analysis.tool_find_repetitions,

  diff_page_revisions:    revisions.tool_diff_page_revisions,

  list_werkstatt_drafts:  werkstatt.tool_list_werkstatt_drafts,
  get_werkstatt_draft:    werkstatt.tool_get_werkstatt_draft,

  get_plot_board:         plot.tool_get_plot_board,

  get_motifs:             motif.tool_get_motifs,
  get_motif_occurrences:  motif.tool_get_motif_occurrences,

  list_research_items:    research.tool_list_research_items,
  read_research_item:     research.tool_read_research_item,

  generate_image:         image.tool_generate_image,
};

async function executeTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result, resultCapFor(ctx));
}

module.exports = { executeTool, TOOLS, validateFinalAnswerCitations };
