'use strict';
// list_redundancies — letzter Lauf des Redundanz-Radars (docs/redundanz.md):
// bedeutungsgleiche Passagen-Paare und Figuren-Dubletten. Liest nur das
// gespeicherte Ergebnis (redundancy_runs), rechnet nichts neu — der Scan ist ein
// eigener Job der Buchlandkarte. Namen zur Lesezeit wie die Karte: Paare mit
// einer Seite, die nicht mehr im Buch steht, oder einer seither neu angelegten
// Figur fallen weg; nach dem Lauf ignorierte Paare ebenso.

const contentStore = require('../../../lib/content-store');
const redundancyDb = require('../../../db/redundancy');
const embed = require('../../../lib/embed');
const { isRunStale } = require('../../../lib/redundancy-staleness');
const { listFigureNamesForUser } = require('../../../db/book-chat/figures');
const { _truncateResult, resultCapFor, offeredList } = require('./shared');

const DEFAULT_LIMIT = 20;
const DEFAULT_TEXT_CHARS = 300;

function _clip(text, max) {
  const t = String(text || '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

async function tool_list_redundancies(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const run = userEmail ? redundancyDb.getLastRun(ctx.bookId, userEmail) : null;
  if (!run) {
    return {
      page_pairs: [], figure_pairs: [],
      hint: 'Kein Lauf des Redundanz-Radars vorhanden (Buchlandkarte → Tab «Doppelungen»). Fehlende Paare heissen hier NICHT, dass es keine Doppelungen gibt.',
    };
  }

  const kind = input?.kind === 'page' || input?.kind === 'figure' ? input.kind : 'all';
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const limit = Math.min(60, Math.max(1, Number.isInteger(input?.limit) ? input.limit : DEFAULT_LIMIT));
  const textChars = Math.min(1500, Math.max(80, Number.isInteger(input?.text_chars) ? input.text_chars : DEFAULT_TEXT_CHARS));
  const dismissed = redundancyDb.dismissalSets(ctx.bookId, userEmail);

  const [outline, pageRows] = await Promise.all([
    contentStore.bookOutline(ctx.bookId),
    contentStore.listPages(ctx.bookId),
  ]);
  const pageById = new Map(outline.filter(n => n.type === 'page').map(n => [n.id, n]));
  const runAt = Date.parse(run.createdAt || '');
  const changedSinceRun = new Set(Number.isFinite(runAt)
    ? pageRows.filter(p => Date.parse(p.updated_at || '') > runAt).map(p => p.id)
    : []);

  const pageSide = (id, ix, text) => {
    const n = pageById.get(id);
    return {
      page_id: id, page_name: n.name,
      ...(n.path.length ? { chapter_path: contentStore.formatChapterPath(n.path) } : {}),
      chunk_ix: ix, text: _clip(text, textChars),
      ...(changedSinceRun.has(id) ? { changed_since_run: true } : {}),
    };
  };
  const pagePairs = [];
  let pageMatched = 0;
  if (kind !== 'figure') {
    for (const p of run.pairs || []) {
      const a = pageById.get(p.a_id), b = pageById.get(p.b_id);
      if (!a || !b) continue;
      if (dismissed.page.has(Math.min(p.a_id, p.b_id) + ':' + Math.max(p.a_id, p.b_id))) continue;
      if (chapterFilter != null && !a.chapter_ids.includes(chapterFilter) && !b.chapter_ids.includes(chapterFilter)) continue;
      pageMatched++;
      if (pagePairs.length < limit) {
        pagePairs.push({ score: p.score, a: pageSide(p.a_id, p.a_ix, p.a_text), b: pageSide(p.b_id, p.b_ix, p.b_text) });
      }
    }
  }

  const figureById = new Map(listFigureNamesForUser(ctx.bookId, userEmail).map(f => [f.id, f]));
  const figSide = (id) => {
    const f = figureById.get(id);
    return { fig_id: f.fig_id, name: f.name || f.kurzname || f.fig_id };
  };
  const figurePairs = [];
  if (kind !== 'page' && chapterFilter == null) {
    for (const p of run.figures?.pairs || []) {
      if (!figureById.has(p.a_id) || !figureById.has(p.b_id)) continue;
      if (dismissed.figure.has(Math.min(p.a_id, p.b_id) + ':' + Math.max(p.a_id, p.b_id))) continue;
      if (figurePairs.length >= limit) break;
      figurePairs.push({ score: p.score, art: p.dupeKind, a: figSide(p.a_id), b: figSide(p.b_id) });
    }
  }

  const stale = await isRunStale(ctx.bookId, userEmail, run, embed.isEnabled() ? embed.getConfig().model : null);
  const hints = [];
  if (run.truncated) hints.push(`Der Lauf hat ${run.totalFound} Passagen-Paare gefunden, gespeichert sind nur die ähnlichsten.`);
  if (run.truncatedChunks) hints.push(`${run.truncatedChunks} Chunks am Buchende wurden nicht verglichen.`);
  if (stale) {
    const check = offeredList(ctx, ['quote_passage', 'get_pages'], ' oder ');
    hints.push(`Text oder Figuren haben sich seit diesem Lauf geändert — Ergebnis kann veraltet sein; ${check ? `mit ${check} prüfen` : 'am Text prüfen'}, bevor du eine Doppelung behauptest.`);
  }
  if (changedSinceRun.size) hints.push('`changed_since_run`: der Abschnitt wurde nach dem Lauf bearbeitet, die Doppelung ist evtl. schon behoben.');
  if (pageMatched > pagePairs.length) hints.push(`Gekürzt auf ${pagePairs.length} von ${pageMatched} Passagen-Paaren — mit chapter_id/limit eingrenzen.`);

  return _truncateResult({
    run_at: run.createdAt || null,
    threshold: run.threshold,
    skip_adjacent: !!run.skipAdjacent,
    total_page_pairs: pageMatched,
    total_figure_pairs: figurePairs.length,
    ...(hints.length ? { hint: hints.join(' ') } : {}),
    page_pairs: pagePairs,
    figure_pairs: figurePairs,
  }, resultCapFor(ctx));
}

module.exports = { tool_list_redundancies };
