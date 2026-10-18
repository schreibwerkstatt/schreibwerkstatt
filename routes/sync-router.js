'use strict';
// Gemeinsame HTTP-Routen beider Blog-Syncs (routes/blog.js, routes/hubspot.js):
//   GET    /:book_id/status                    — Verbindungs-Meta (kein Geheimnis)
//   DELETE /:book_id                           — Verbindung loeschen (CASCADE killt Links)
//   GET    /:book_id/links                     — Link-Status fuer Badges + Push
//   GET    /:book_id/pages/:page_id/remote     — Remote-Stand fuer den Konflikt-Diff
//   POST   /:book_id/pages/:page_id/resolve    — Konflikt loesen: 'app' | 'remote'
// Anbieter-Spezifisches (Test, Connect, Listen) bleibt im jeweiligen Router; die
// Unterschiede liefert der Adapter (lib/sync/providers/).
//
// Fehler des Remote antworten NIE mit 401: der globale fetch-Wrapper
// (public/js/app/boot/fetch-guard.js) deutet jede 401 als abgelaufene Sitzung
// und zeigt das Session-Banner — ein falsches Token drueben ist keine
// abgelaufene Sitzung hier. Darum 422 fuer abgewiesene Zugangsdaten.

const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { getBookSettings } = require('../db/schema');
const { isBlogBook, requireBlogTypeRoute } = require('../lib/buchtyp');
const contentStore = require('../lib/content-store');

const jsonBody = express.json();

/** HTTP-Status fuer einen Fehler des Remote-Clients. */
function remoteErrorStatus(code) {
  if (/_(AUTH_FAILED|FORBIDDEN|INSUFFICIENT_CAPABILITY)$/.test(code)) return 422;
  if (/_RATE_LIMIT$/.test(code)) return 429;
  return 502;
}

function sendRemoteError(res, e, prefix) {
  const code = e?.code || `${prefix}_FETCH_FAILED`;
  return res.status(remoteErrorStatus(code)).json({ error_code: code });
}

function _pageId(req, res) {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) {
    res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
    return null;
  }
  return pageId;
}

/**
 * Haengt die gemeinsamen Routen an `router`. `opts.linksMeta(conn, req)` darf
 * die /links-Antwort anreichern (HubSpot: portalId mit Self-Heal).
 */
function mountSyncRoutes(router, provider, opts = {}) {
  const P = provider.prefix;
  const requireType = (req, res) => requireBlogTypeRoute(req, res, `${P}_REQUIRES_BLOG_TYPE`);

  // Link + Verbindung zu einer Seite dieses Buchs, sonst Antwort und null.
  function linkFor(req, res, pageId) {
    const link = provider.db.getLinkByPage(pageId);
    if (!link) { res.status(404).json({ error_code: `${P}_LINK_MISSING` }); return null; }
    const conn = provider.db.getConnection(req.bookId);
    if (!conn || conn.id !== provider.linkConnId(link)) {
      res.status(404).json({ error_code: `${P}_NOT_CONNECTED` });
      return null;
    }
    return { link, conn };
  }

  router.get('/:book_id/status', aclParamGuard('viewer'), (req, res) => {
    const settings = getBookSettings(req.bookId, sessionEmail(req));
    const conn = provider.db.getConnectionPublic(req.bookId);
    res.json({ isBlogType: !!isBlogBook(settings), connected: !!conn, connection: conn });
  });

  router.delete('/:book_id', aclParamGuard('editor'), (req, res) => {
    res.json({ ok: provider.db.deleteConnection(req.bookId) });
  });

  router.get('/:book_id/links', aclParamGuard('viewer'), async (req, res) => {
    const conn = provider.db.getConnectionPublic(req.bookId);
    if (!conn) return res.json({ links: [], connected: false });
    const meta = opts.linksMeta ? await opts.linksMeta(conn, req) : await provider.linksMeta(conn);
    res.json({ ...meta, links: provider.db.listLinks(conn.id), connected: true });
  });

  router.get('/:book_id/pages/:page_id/remote', aclParamGuard('viewer'), async (req, res) => {
    if (!requireType(req, res)) return;
    const pageId = _pageId(req, res);
    if (!pageId) return;
    const found = linkFor(req, res, pageId);
    if (!found) return;
    try {
      const remote = await provider.fetchRemote(provider.client(found.conn), found.link, 'precheck');
      res.json({ remoteId: provider.remoteId(found.link), ...(await provider.remoteView(remote)) });
    } catch (e) {
      sendRemoteError(res, e, P);
    }
  });

  // Beide Seiten brauchen den aktuellen Remote-Stand: 'remote' uebernimmt ihn,
  // 'app' markiert ihn als gesehen (sonst meldeten Pull bzw. Vorab-Pruefung
  // denselben Edit sofort wieder). Der Push selbst bleibt ein eigener Schritt.
  router.post('/:book_id/pages/:page_id/resolve', aclParamGuard('editor'), jsonBody, async (req, res) => {
    if (!requireType(req, res)) return;
    const pageId = _pageId(req, res);
    if (!pageId) return;
    const raw = String(req.body?.resolve || '');
    // 'wp' ist der Wert aus der Zeit, als nur WordPress Konflikte kannte.
    const resolve = raw === 'wp' ? 'remote' : raw;
    if (resolve !== 'app' && resolve !== 'remote') {
      return res.status(400).json({ error_code: `${P}_RESOLVE_INVALID` });
    }
    const found = linkFor(req, res, pageId);
    if (!found) return;
    let renamedTo = null;
    try {
      const remote = await provider.fetchRemote(provider.client(found.conn), found.link, 'precheck');
      if (resolve === 'remote') {
        const pageRow = await contentStore.loadPage(pageId).catch(() => null);
        if (!pageRow || pageRow.book_id !== req.bookId) {
          return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
        }
        const applied = await provider.applyRemote({
          pageId, bookId: req.bookId, pageRow, remote, userEmail: sessionEmail(req),
        });
        renamedTo = applied?.name || null;
        // `syncedAt` (falls der Adapter ihn liefert): Stempel des eigenen Writes
        // statt „jetzt" — siehe db/blogs.js#markLinkPulled.
        provider.db.markLinkPulled(pageId, remote, applied?.syncedAt || null);
      } else {
        provider.db.markConflictResolvedApp(pageId, provider.remoteStamp(remote));
      }
    } catch (e) {
      return sendRemoteError(res, e, P);
    }
    res.json({ ok: true, resolve, ...(renamedTo ? { name: renamedTo } : {}) });
  });
}

module.exports = { mountSyncRoutes, sendRemoteError, remoteErrorStatus };
