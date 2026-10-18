'use strict';
// REST-Endpoints fuer die HubSpot-Verbindung eines Buchs (Buchtyp 'blog').
//   POST /hubspot/:book_id/test     — Token pruefen (/account-info/v3/details)
//   POST /hubspot/:book_id/blogs    — Combobox-Quelle Blogs
//   POST /hubspot/:book_id/authors  — Combobox-Quelle Autoren
//   POST /hubspot/:book_id/connect  — Token + Blog + Autor speichern
// Status, Trennen, Links, Konflikt-Diff und -Aufloesung teilen sich beide
// Blog-Syncs: routes/sync-router.js (Adapter lib/sync/providers/hubspot.js).
//
// Das Token kommt immer im Body (bzw. `__keep__` = gespeichertes Token), nie in
// der URL — eine Query landet in Browser-Verlauf und Proxy-Logs.
//
// Pflicht: Buchtyp == 'blog' (gated via book_settings.buchtyp), aclParamGuard().
// Logging-Context book-Slot via router.param + bookParamHandler.

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { requireBlogTypeRoute } = require('../lib/buchtyp');
const hubspot = require('../db/hubspot');
const { createHubspotClient } = require('../lib/hubspot-client');
const hubspotProvider = require('../lib/sync/providers/hubspot');
const { mountSyncRoutes, sendRemoteError } = require('./sync-router');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

const KEEP_TOKEN = '__keep__';
// Self-Heal der portalId (Verbindungen vor Migration 150): hoechstens ein
// Versuch pro Verbindung in diesem Abstand — /links laeuft bei jedem Laden des
// Seitenbaums, ein kaputtes Token soll dort nicht jedes Mal HubSpot anfragen.
const PORTAL_HEAL_RETRY_MS = 10 * 60 * 1000;
const _portalHealTried = new Map(); // connId → Zeitpunkt

function _requireBlogType(req, res) {
  return requireBlogTypeRoute(req, res, 'HUBSPOT_REQUIRES_BLOG_TYPE');
}

function _resolveToken(req, bookId) {
  const raw = (req.body && req.body.token) || '';
  if (raw && raw !== KEEP_TOKEN) return String(raw);
  const existing = hubspot.getConnection(bookId);
  return existing ? existing.token : '';
}

router.post('/:book_id/test', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const token = _resolveToken(req, req.bookId);
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  try {
    const me = await createHubspotClient({ token }).me();
    return res.json({ ok: true, portalId: me?.portalId ?? null });
  } catch (e) {
    logger.warn(`HubSpot-Test fehlgeschlagen: ${e.code || e.message}`);
    return sendRemoteError(res, e, 'HUBSPOT');
  }
});

router.post('/:book_id/blogs', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const token = _resolveToken(req, req.bookId);
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  try {
    const items = await createHubspotClient({ token }).listBlogs();
    res.json({
      blogs: items.map(b => ({
        id: String(b.id || ''),
        name: b.name || b.htmlTitle || b.slug || String(b.id || ''),
      })).filter(b => b.id),
    });
  } catch (e) {
    return sendRemoteError(res, e, 'HUBSPOT');
  }
});

router.post('/:book_id/authors', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const token = _resolveToken(req, req.bookId);
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  try {
    const items = await createHubspotClient({ token }).listAuthors();
    res.json({
      authors: items.map(a => ({
        id: String(a.id || ''),
        name: (a.fullName || a.displayName || a.name || a.email || String(a.id || '')).trim(),
        email: a.email || null,
      })).filter(a => a.id),
    });
  } catch (e) {
    return sendRemoteError(res, e, 'HUBSPOT');
  }
});

router.post('/:book_id/connect', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const bookId = req.bookId;
  const { blogId, authorId } = req.body || {};
  if (!blogId) return res.status(400).json({ error_code: 'HUBSPOT_BLOG_REQUIRED' });
  if (!authorId) return res.status(400).json({ error_code: 'HUBSPOT_AUTHOR_REQUIRED' });
  const token = _resolveToken(req, bookId);
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  let portalId = null;
  try {
    const me = await createHubspotClient({ token }).me();
    if (me && me.portalId != null) portalId = String(me.portalId);
  } catch (e) {
    return sendRemoteError(res, e, 'HUBSPOT');
  }
  // `targetChanged`: anderer Blog oder anderes Portal → Links und Import-Stand
  // wurden verworfen (db/hubspot.js#upsertConnection).
  const conn = hubspot.upsertConnection({
    bookId, token, blogId: String(blogId), authorId: String(authorId), portalId,
  });
  return res.json({ ok: true, connection: conn, targetChanged: !!conn.targetChanged });
});

async function _linksMeta(conn) {
  let portalId = conn.portalId || null;
  const last = _portalHealTried.get(conn.id) || 0;
  if (!portalId && Date.now() - last > PORTAL_HEAL_RETRY_MS) {
    _portalHealTried.set(conn.id, Date.now());
    try {
      const full = hubspot.getConnection(conn.bookId);
      if (full && full.token) {
        const me = await createHubspotClient({ token: full.token }).me();
        if (me && me.portalId != null) {
          portalId = String(me.portalId);
          hubspot.setPortalId(conn.id, portalId);
        }
      }
    } catch (e) {
      logger.warn(`HubSpot-portalId-Backfill fehlgeschlagen: ${e.code || e.message}`);
    }
  }
  return { ...(await hubspotProvider.linksMeta(conn)), portalId };
}

mountSyncRoutes(router, hubspotProvider, { linksMeta: _linksMeta });

module.exports = router;
