'use strict';
// Revisions-Diff zwischen zwei page_revisions-Eintraegen (Default: letzte zwei).

const { getPageWithChapter } = require('../../../db/book-chat/text');
const { htmlToPlainText } = require('../../../lib/html-text');
const { diffWordsWithSpace } = require('diff');
const pageRevisions = require('../../../db/page-revisions');
const { _truncateResult } = require('./shared');

const DIFF_MAX_BLOCKS   = 100;
const DIFF_MAX_TEXT_LEN = 600;

function _diffBlocks(oldText, newText) {
  const parts = diffWordsWithSpace(oldText, newText);
  const blocks = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.removed && parts[i + 1]?.added) {
      blocks.push({ kind: 'change', from: p.value, to: parts[i + 1].value });
      i += 2;
    } else if (p.added) {
      blocks.push({ kind: 'add', text: p.value });
      i += 1;
    } else if (p.removed) {
      blocks.push({ kind: 'del', text: p.value });
      i += 1;
    } else {
      i += 1;
    }
  }
  return blocks;
}

function _clampDiffPart(s) {
  if (s == null) return s;
  return s.length > DIFF_MAX_TEXT_LEN ? s.slice(0, DIFF_MAX_TEXT_LEN) + '…' : s;
}

function tool_diff_page_revisions(input, ctx) {
  const pageId = input?.page_id;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'page_id' } };

  const pageRow = getPageWithChapter(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Abschnitt nicht im aktuellen Buch.', errorKey: 'chat.toolError.pageNotInBook' };
  }

  let fromRev = null;
  let toRev   = null;
  if (Number.isInteger(input?.from_rev_id) && Number.isInteger(input?.to_rev_id)) {
    fromRev = pageRevisions.get(input.from_rev_id);
    toRev   = pageRevisions.get(input.to_rev_id);
    if (!fromRev || !toRev) return { error: 'Revision-ID nicht gefunden.', errorKey: 'chat.toolError.notFound' };
    if (fromRev.page_id !== pageId || toRev.page_id !== pageId) {
      return { error: 'Revision gehoert nicht zum Abschnitt.', errorKey: 'chat.toolError.notFound' };
    }
  } else {
    const recent = pageRevisions.listForPage(pageId, 2);
    if (recent.length < 2) {
      return { error: 'Weniger als 2 Revisionen vorhanden.', errorKey: 'chat.toolError.tooFewRevisions', total_revisions: recent.length };
    }
    toRev   = pageRevisions.get(recent[0].id);
    fromRev = pageRevisions.get(recent[1].id);
  }

  const oldText = htmlToPlainText(fromRev.body_html);
  const newText = htmlToPlainText(toRev.body_html);
  if (oldText === newText) {
    return {
      page_id: pageId,
      page_name: pageRow.page_name,
      from: { id: fromRev.id, created_at: fromRev.created_at, source: fromRev.source, chars: fromRev.chars },
      to:   { id: toRev.id,   created_at: toRev.created_at,   source: toRev.source,   chars: toRev.chars   },
      unchanged: true,
    };
  }

  const blocks = _diffBlocks(oldText, newText);
  const summary = { add: 0, del: 0, change: 0 };
  for (const b of blocks) summary[b.kind]++;

  const limited = blocks.slice(0, DIFF_MAX_BLOCKS).map(b => {
    if (b.kind === 'change') return { kind: 'change', from: _clampDiffPart(b.from), to: _clampDiffPart(b.to) };
    return { kind: b.kind, text: _clampDiffPart(b.text) };
  });

  return _truncateResult({
    page_id:   pageId,
    page_name: pageRow.page_name,
    chapter_name: pageRow.chapter_name || null,
    from: {
      id:         fromRev.id,
      created_at: fromRev.created_at,
      source:     fromRev.source,
      user_email: fromRev.user_email || null,
      chars:      fromRev.chars,
      words:      fromRev.words,
    },
    to: {
      id:         toRev.id,
      created_at: toRev.created_at,
      source:     toRev.source,
      user_email: toRev.user_email || null,
      chars:      toRev.chars,
      words:      toRev.words,
    },
    chars_delta: (toRev.chars || 0) - (fromRev.chars || 0),
    summary,
    blocks: limited,
    ...(blocks.length > limited.length ? { truncated: true, total_blocks: blocks.length } : {}),
  });
}

module.exports = {
  tool_diff_page_revisions,
};
