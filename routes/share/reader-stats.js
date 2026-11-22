'use strict';
// Share-Link Public-Reader: Lese-Statistik und Gesamt-Fazit — Beacons fuer
// Verweildauer (POST /share/:token/view-duration) und Lesetiefe (.../read-depth),
// Fazit abgeben (POST .../feedback) und eigenes Fazit lesen (GET .../feedback/mine).
// Ohne Session; jede Route respektiert isExpired. Leseansicht + Kommentare:
// routes/share/reader.js.

const express = require('express');
const shareLinks = require('../../db/share-links');
const rateLimit = require('../../lib/share-ratelimit');
const logger = require('../../logger');
const { setContext } = require('../../lib/log-context');
const { BODY_MAX, READER_NAME_MAX, READER_TOKEN_RE, TOKEN_RE, isExpired } = require('../../lib/share-helpers');

function register(router) {
  // ── Public: Verweildauer eines Aufrufs nachtragen (Beacon) ─────────────────
  // Der Reader schickt beim Verlassen der Seite (pagehide/visibilitychange) die
  // aktiv verbrachte Lesezeit via navigator.sendBeacon (MAX-Merge pro view_id),
  // geclampt auf einen sinnvollen Maximalwert (Bot-/Manipulationsschutz fuer die
  // Owner-Statistik). Antwortet immer 204 — Beacons ignorieren den Body.
  // Ein widerrufener/abgelaufener Link nimmt keine Beacons mehr an.
  const liveLink = (token) => {
    if (!TOKEN_RE.test(token)) return null;
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return null;
    setContext({ book: link.book_id });
    return link;
  };
  const MAX_DWELL_MS = 6 * 60 * 60 * 1000; // 6 h
  router.post('/:token/view-duration', express.json({ limit: '1kb' }), (req, res) => {
    const token = String(req.params.token || '');
    if (!liveLink(token)) return res.sendStatus(204);
    const viewId = parseInt(req.body?.viewId, 10);
    const durationMs = Math.round(Number(req.body?.durationMs));
    if (!Number.isInteger(viewId) || viewId <= 0) return res.sendStatus(204);
    if (!Number.isFinite(durationMs) || durationMs < 0) return res.sendStatus(204);
    const clamped = Math.min(durationMs, MAX_DWELL_MS);
    try { shareLinks.setViewDuration(viewId, token, clamped); } catch { /* non-fatal */ }
    res.sendStatus(204);
  });

  // ── Public: Lesetiefe eines Aufrufs nachtragen (Beacon) ────────────────────
  // Gesamt-Scrolltiefe (0-100 %) + optional pro Kapitel die erreichte Tiefe. Wie
  // die Verweildauer per sendBeacon beim Wechsel in den Hintergrund; MAX-Merge in
  // der DB, view_id token-gebunden. Antwortet immer 204.
  router.post('/:token/read-depth', express.json({ limit: '8kb' }), (req, res) => {
    const token = String(req.params.token || '');
    if (!liveLink(token)) return res.sendStatus(204);
    const viewId = parseInt(req.body?.viewId, 10);
    if (!Number.isInteger(viewId) || viewId <= 0) return res.sendStatus(204);

    const rawMax = Math.round(Number(req.body?.maxScrollPct));
    if (Number.isFinite(rawMax) && rawMax >= 0) {
      const pct = Math.min(100, rawMax);
      try { shareLinks.setViewMaxScroll(viewId, token, pct); } catch { /* non-fatal */ }
    }

    // Pro-Kapitel-Tiefe (max. 500 Eintraege defensiv). chapterId + pct clamped in DB.
    const chapters = Array.isArray(req.body?.chapters) ? req.body.chapters.slice(0, 500) : [];
    if (chapters.length) {
      const sections = chapters
        .map(c => ({ chapterId: parseInt(c?.chapterId, 10), pct: Number(c?.pct) }))
        .filter(c => Number.isInteger(c.chapterId) && c.chapterId > 0 && Number.isFinite(c.pct));
      if (sections.length) {
        try { shareLinks.recordSectionDepths(viewId, token, sections); } catch { /* non-fatal */ }
      }
    }
    res.sendStatus(204);
  });

  // ── Public: Gesamt-Fazit abgeben (Sternewertung + optionaler Freitext) ──────
  // Einmal pro Leser (reader_token, UPSERT). Erneutes Absenden aktualisiert das
  // eigene Fazit. reader_token ist Pflicht (sonst kein Upsert-Key → Spam-Schutz).
  router.post('/:token/feedback', express.json({ limit: '8kb' }), (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return res.status(404).json({ error_code: 'GONE' });
    setContext({ book: link.book_id });

    const readerToken = String(req.body?.reader_token || '');
    if (!READER_TOKEN_RE.test(readerToken)) return res.status(400).json({ error_code: 'NO_READER_TOKEN' });
    const rating = parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error_code: 'BAD_RATING' });

    let body = req.body?.body != null ? String(req.body.body).trim() : null;
    if (body && body.length > BODY_MAX) return res.status(400).json({ error_code: 'TOO_LONG' });
    if (!body) body = null;
    let readerName = req.body?.reader_name != null ? String(req.body.reader_name).trim().slice(0, READER_NAME_MAX) : null;
    if (!readerName) readerName = null;

    // reader_token waehlt der Client — ohne Drossel waere jeder neue Token ein
    // neuer UPSERT-Schluessel. Eigene Buckets (Praefix), Limit wie Kommentare.
    const ipHash = rateLimit.hashIp(req.ip || req.connection?.remoteAddress || '');
    const rl = rateLimit.check(`feedback:${token}`, ipHash);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      return res.status(429).json({ error_code: 'RATE_LIMITED', retry_after: rl.retryAfterSec });
    }
    try {
      shareLinks.upsertFeedback(token, { readerToken, readerName, rating, body, ipHash });
    } catch (e) {
      logger.warn(`[share/feedback] upsert fehlgeschlagen: ${e.message}`);
      return res.status(500).json({ error_code: 'ERR' });
    }
    res.json({ ok: true });
  });

  // ── Public: eigenes Fazit dieses Lesers (Prefill) ──────────────────────────
  router.get('/:token/feedback/mine', (req, res) => {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || isExpired(link)) return res.status(404).json({ error_code: 'GONE' });
    setContext({ book: link.book_id });
    const readerToken = String(req.query?.rt || '');
    if (!READER_TOKEN_RE.test(readerToken)) return res.set('Cache-Control', 'no-store').json({ feedback: null });
    let feedback = null;
    try { feedback = shareLinks.getFeedbackByReader(token, readerToken) || null; } catch { /* non-fatal */ }
    res.set('Cache-Control', 'no-store').json({ feedback });
  });
}

module.exports = { register };
