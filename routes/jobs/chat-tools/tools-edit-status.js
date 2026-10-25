'use strict';
// get_edit_status — Bearbeitungsstand des Buchs (docs/bearbeitungsstand.md):
// Verteilung, Kapitelstand (schwaechste Stufe darunter, inkl. Unterkapitel) und
// die Abschnitte mit ihrer Stufe, optional gefiltert. Read-only — der Buch-Chat
// setzt keinen Stand; das ist eine Entscheidung des Autors.

const { getBookSettings } = require('../../../db/book-settings');
const { isJournalisticBook } = require('../../../lib/buchtyp');
const { listBookStatus, statusChain, statusRank } = require('../../../db/redaktion');
const contentStore = require('../../../lib/content-store');
const { _truncateResult, resultCapFor } = require('./shared');

const DEFAULT_LIMIT = 300;
const PAGE_FORMAT = '[page_id, page_name, chapter_id, status|null, stale (1 = seit dem Setzen geändert)]';

// Schwaechste Stufe einer Menge; null, sobald ein Abschnitt keine hat.
function _weakest(entries) {
  let min = Infinity, status = null, stale = false;
  for (const e of entries) {
    const r = statusRank(e?.status);
    if (r < 0) return { status: null, stale: stale || !!e?.stale };
    if (e.stale) stale = true;
    if (r < min) { min = r; status = e.status; }
  }
  return { status, stale };
}

async function tool_get_edit_status(input, ctx) {
  const chain = statusChain(isJournalisticBook(getBookSettings(ctx.bookId, ctx.userEmail || null)));
  const done = chain[chain.length - 1];
  const byPage = listBookStatus(ctx.bookId);
  const outline = await contentStore.bookOutline(ctx.bookId);

  const statusFilter = input?.status === 'ohne' || chain.includes(input?.status) ? input.status : null;
  const staleOnly = input?.stale_only === true;
  const notDone = input?.not_done === true;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const limit = Math.min(1000, Math.max(1, Number.isInteger(input?.limit) ? input.limit : DEFAULT_LIMIT));

  const counts = Object.fromEntries(chain.map(s => [s, 0]));
  counts.ohne = 0;
  counts.stale = 0;
  const pageNodes = outline.filter(n => n.type === 'page');
  for (const n of pageNodes) {
    const e = byPage[String(n.id)];
    if (e && e.status in counts) { counts[e.status]++; if (e.stale) counts.stale++; } else counts.ohne++;
  }

  const chapters = outline.filter(n => n.type === 'chapter').map(c => {
    const own = pageNodes.filter(p => p.chapter_ids.includes(c.id));
    const w = own.length ? _weakest(own.map(p => byPage[String(p.id)])) : { status: null, stale: false };
    return {
      chapter_id: c.id, chapter_name: c.name, depth: c.depth,
      status: w.status, ...(w.stale ? { stale: true } : {}), pages: own.length,
    };
  }).filter(c => c.pages > 0);

  const pages = [];
  let matched = 0;
  for (const n of pageNodes) {
    if (chapterFilter != null && !n.chapter_ids.includes(chapterFilter)) continue;
    const e = byPage[String(n.id)];
    const st = e && chain.includes(e.status) ? e.status : null;
    if (statusFilter === 'ohne' ? st !== null : (statusFilter && st !== statusFilter)) continue;
    if (staleOnly && !e?.stale) continue;
    if (notDone && st === done) continue;
    matched++;
    if (pages.length < limit) pages.push([n.id, n.name, n.chapter_id, st, e?.stale ? 1 : 0]);
  }

  return _truncateResult({
    chain,
    done_stage: done,
    total_pages: pageNodes.length,
    counts,
    chapters,
    page_format: PAGE_FORMAT,
    matched_pages: matched,
    pages,
    ...(matched > pages.length ? { hint: `Gekürzt auf ${pages.length} — mit status/chapter_id/not_done eingrenzen.` } : {}),
  }, resultCapFor(ctx));
}

module.exports = { tool_get_edit_status };
