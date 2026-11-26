'use strict';
// Review ueber den Share-Link (docs/share-link.md → „Review-Modus").
//
// Public (Reviewer, ohne Konto, Identitaet = reader_token des Browsers):
//   GET  /share/:token/review?rt=…        Reviewer-Liste + eigener Anspruch
//   POST /share/:token/review/claim       { reader_token, reviewer_id } | { reader_token, name }
//   POST /share/:token/review/done        { reader_token, done, note? }
// Owner (Session):
//   PUT   /share/api/links/:token/reviewers  { names: [] }
//   GET   /share/api/links/:token/review     Stand (Reviewer, offene Threads/Vorschlaege)
//   PATCH /share/api/comments/:id/suggestion { state: 'accepted'|'rejected'|'open' }
//
// Den Text uebernimmt NICHT der Server: die Owner-Leiste ersetzt die Stelle im
// Browser (public/js/editor/comment-suggestion.js) und speichert den Abschnitt
// ueber den normalen Save-Pfad mit Versionspruefung; diese Route haelt nur den
// Entscheid fest. Grund: die tolerante Textsuche (utils/html-find.js) braucht den
// Browser-Parser fuer Entities, und der Notebook-Editor bzw. Bucheditor muessen
// den neuen Stand ohnehin selbst nachziehen.

const shareLinks = require('../../db/share-links');
const shareReview = require('../../db/share-review');
const rateLimit = require('../../lib/share-ratelimit');
const { setContext } = require('../../lib/log-context');
const { emitBookMeta } = require('../../lib/book-events');
const { sessionEmail } = require('../../lib/acl');
const { recordUsageEvent } = require('../../lib/usage-events');
const logger = require('../../logger');
const H = require('../../lib/share-helpers');
const { requireSession, ownLink, guardComment } = require('./api');

const { commentBody, jsonBody, READER_TOKEN_RE, TOKEN_RE, isExpired } = H;

// Review-Link dieses Tokens oder Antwort (404/410/400) + null.
function reviewLink(req, res) {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  const link = shareLinks.getShareLinkByToken(token);
  if (!link) { res.status(404).json({ error_code: 'NOT_FOUND' }); return null; }
  setContext({ book: link.book_id });
  if (isExpired(link)) { res.status(410).json({ error_code: 'GONE' }); return null; }
  if (link.mode !== 'review') { res.status(400).json({ error_code: 'NOT_REVIEW_LINK' }); return null; }
  return link;
}

function readerTokenOf(v) {
  const s = String(v || '').trim();
  return READER_TOKEN_RE.test(s) ? s : null;
}

// Schreibende Public-Routen teilen das Ratenlimit der Kommentare (pro Token + IP).
function rateLimited(req, res, token) {
  const ipHash = rateLimit.hashIp(req.ip || req.connection?.remoteAddress || '');
  const rl = rateLimit.check(token, ipHash);
  if (rl.allowed) return false;
  res.setHeader('Retry-After', String(rl.retryAfterSec));
  res.status(429).json({ error_code: 'RATE_LIMITED', retry_after: rl.retryAfterSec });
  return true;
}

function register(router) {
  // ── Public ──────────────────────────────────────────────────────────────────
  router.get('/:token/review', (req, res) => {
    const link = reviewLink(req, res);
    if (!link) return;
    const rt = readerTokenOf(req.query?.rt);
    res.set('Cache-Control', 'no-store');
    const reviewers = shareReview.listReviewers(link.token, { readerToken: rt });
    res.json({ reviewers, me: reviewers.find(r => r.mine) || null });
  });

  router.post('/:token/review/claim', commentBody, (req, res) => {
    const link = reviewLink(req, res);
    if (!link) return;
    const rt = readerTokenOf(req.body?.reader_token);
    if (!rt) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
    // Entweder einen Namen der Liste waehlen (reviewer_id) oder sich mit freiem
    // Namen eintragen (name) — der Link wird oft ohne Namensliste geteilt.
    const byName = req.body?.reviewer_id == null && typeof req.body?.name === 'string';
    const reviewerId = parseInt(req.body?.reviewer_id, 10);
    if (byName) {
      const name = req.body.name.trim();
      if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
      if (name.length > shareReview.REVIEWER_NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
    } else if (!Number.isInteger(reviewerId) || reviewerId <= 0) {
      return res.status(400).json({ error_code: 'INVALID_ID' });
    }
    if (rateLimited(req, res, link.token)) return;
    try {
      const row = byName
        ? shareReview.claimReviewerByName(link.token, req.body.name, rt)
        : shareReview.claimReviewer(link.token, reviewerId, rt);
      if (row?.full) return res.status(409).json({ error_code: 'REVIEWERS_FULL' });
      if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
      shareReview.renameReaderComments(link.token, rt, row.name);
      logger.info(`[share/review] claim token=${link.token.slice(0, 8)} reviewer=${row.id}${byName ? ' (selbst eingetragen)' : ''}`);
      res.json({ ok: true, me: { id: row.id, name: row.name, done: !!row.done_at } });
    } catch (e) {
      logger.error('[share/review claim] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.post('/:token/review/done', commentBody, (req, res) => {
    const link = reviewLink(req, res);
    if (!link) return;
    const rt = readerTokenOf(req.body?.reader_token);
    if (!rt) return res.status(400).json({ error_code: 'INVALID_TOKEN' });
    const note = req.body?.note == null ? null : String(req.body.note);
    if (note && note.length > shareReview.DONE_NOTE_MAX) return res.status(400).json({ error_code: 'BODY_TOO_LONG' });
    if (rateLimited(req, res, link.token)) return;
    const done = req.body?.done !== false;
    try {
      if (!shareReview.reviewerForReader(link.token, rt)) return res.status(409).json({ error_code: 'REVIEWER_NOT_CLAIMED' });
      shareReview.setReviewerDone(link.token, rt, done, note);
      logger.info(`[share/review] ${done ? 'done' : 'reopen'} token=${link.token.slice(0, 8)}`);
      res.json({ ok: true, done });
    } catch (e) {
      logger.error('[share/review done] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // ── Owner ───────────────────────────────────────────────────────────────────
  router.put('/api/links/:token/reviewers', requireSession, jsonBody, (req, res) => {
    const link = ownLink(req, res, shareLinks.SHARE_CREATE_MIN_ROLE);
    if (!link) return;
    if (link.mode !== 'review') return res.status(400).json({ error_code: 'NOT_REVIEW_LINK' });
    const names = Array.isArray(req.body?.names) ? req.body.names : null;
    if (!names) return res.status(400).json({ error_code: 'NAMES_REQUIRED' });
    try {
      shareReview.replaceReviewers(link.token, names);
      res.json(shareReview.reviewState(link.token));
    } catch (e) {
      logger.error('[share/api/reviewers PUT] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.get('/api/links/:token/review', requireSession, (req, res) => {
    const link = ownLink(req, res, 'viewer');
    if (!link) return;
    res.set('Cache-Control', 'no-store');
    res.json(shareReview.reviewState(link.token));
  });

  router.patch('/api/comments/:id/suggestion', requireSession, jsonBody, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const state = String(req.body?.state || '');
    if (!shareReview.SUGGESTION_STATES.includes(state)) return res.status(400).json({ error_code: 'INVALID_STATE' });
    const bookId = guardComment(req, res, id);
    if (!bookId) return;
    const ownerEmail = sessionEmail(req);
    try {
      const ok = shareReview.setSuggestionState(id, ownerEmail, state);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      logger.info(`[share/comment] Vorschlag ${state} id=${id}`);
      emitBookMeta(bookId, 'comments');
      if (state !== 'open') {
        recordUsageEvent({ userEmail: ownerEmail, event: 'comment.action', bookId, meta: { action: state === 'accepted' ? 'accept' : 'reject' } });
      }
      res.json({ ok: true, comment: shareLinks.getCommentById(id) });
    } catch (e) {
      logger.error('[share/api/comments suggestion PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });
}

module.exports = { register };
