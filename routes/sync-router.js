'use strict';
// Gemeinsame HTTP-Routen beider Blog-Syncs (routes/blog.js, routes/hubspot.js):
//   GET    /:book_id/status                    — Verbindungs-Meta (kein Geheimnis)
//   DELETE /:book_id                           — Verbindung loeschen (CASCADE killt Links)
//   GET    /:book_id/links                     — Link-Status fuer Badges + Push
//   GET    /:book_id/pages/:page_id/remote     — Remote-Stand fuer den Konflikt-Diff
//   POST   /:book_id/pages/:page_id/resolve    — Konflikt loesen: 'app' | 'remote'
//   POST   /:book_id/pages/:page_id/refresh-status — Remote-Status eines Links
//                                                nachziehen (beim Oeffnen des Abschnitts)
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
const { refreshLink } = require('./jobs/sync/reconcile');
const logger = require('../logger');

const jsonBody = express.json();

// Statuspruefung beim Oeffnen: hoechstens einmal je Abschnitt in diesem
// Fenster, egal aus wie vielen Tabs (der Client drosselt zusaetzlich).
const REFRESH_MIN_INTERVAL_MS = 60_000;

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
    const ok = provider.db.deleteConnection(req.bookId);
    if (ok) logger.info(`Sync-Verbindung gelöscht (${P}).`);
    res.json({ ok });
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
      // Abschnittsstand mitgeben: HubSpot zeigt schon gespiegelte Bilder im
      // Diff mit ihrer lokalen Adresse (die CSP sperrt das CDN).
      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      const view = await provider.remoteView(remote, {
        pageHtml: pageRow?.html || pageRow?.body_html || '', bookId: req.bookId, hubId: provider.linkConnId(found.link),
      });
      res.json({ remoteId: provider.remoteId(found.link), ...view });
    } catch (e) {
      sendRemoteError(res, e, P);
    }
  });

  // Guenstiger Statusabgleich EINES Links beim Oeffnen des Abschnitts: ein
  // GET auf den Beitrag, Status/URL/Push-Sperre nachziehen (wie der Abgleich-
  // Job, routes/jobs/sync/reconcile.js#refreshLink). Ein drueben geloeschter
  // Beitrag wird hier nur gemeldet, nicht entknuepft — das bleibt dem Abgleich
  // (naechtlich oder von Hand), damit ein Seitenaufruf keinen Link verwirft.
  // `changed`: der Client laedt die Links nur dann neu.
  const lastRefresh = new Map();
  router.post('/:book_id/pages/:page_id/refresh-status', aclParamGuard('viewer'), async (req, res) => {
    if (!requireType(req, res)) return;
    const pageId = _pageId(req, res);
    if (!pageId) return;
    const found = linkFor(req, res, pageId);
    if (!found) return;
    const now = Date.now();
    if (now - (lastRefresh.get(pageId) || 0) < REFRESH_MIN_INTERVAL_MS) {
      return res.json({ ok: true, changed: false, throttled: true });
    }
    lastRefresh.set(pageId, now);
    if (lastRefresh.size > 5000) lastRefresh.clear();
    const before = JSON.stringify(found.link);
    try {
      const outcome = await refreshLink(provider, provider.client(found.conn), found.link, { removeGone: false });
      const after = JSON.stringify(provider.db.getLinkByPage(pageId));
      const changed = before !== after;
      if (changed) logger.info(`Sync-Status nachgezogen (${P}): page=${pageId} beim Öffnen.`);
      res.json({ ok: true, changed, gone: outcome === 'gone' });
    } catch (e) {
      logger.warn(`Sync-Statusabgleich (${P}) page=${pageId} fehlgeschlagen: ${e.code || e.message}`);
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
          pageId, bookId: req.bookId, pageRow, remote, userEmail: sessionEmail(req), logger,
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
    logger.info(`Sync-Konflikt gelöst (${P}): page=${pageId} zugunsten ${resolve === 'app' ? 'App' : 'Remote'}${renamedTo ? `, umbenannt (${renamedTo.length} Zeichen)` : ''}.`);
    res.json({ ok: true, resolve, ...(renamedTo ? { name: renamedTo } : {}) });
  });
}

module.exports = { mountSyncRoutes, sendRemoteError, remoteErrorStatus };
