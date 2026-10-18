'use strict';
// REST-Endpoints fuer die WordPress-Verbindung eines Buchs.
//   POST /blog/:book_id/test     — Zugangsdaten testen ohne zu speichern
//   POST /blog/:book_id/connect  — Zugangsdaten speichern (+ Test-Call)
// Status, Trennen, Links, Konflikt-Diff und -Aufloesung teilen sich beide
// Blog-Syncs: routes/sync-router.js (Adapter lib/sync/providers/wordpress.js).
//
// Pflicht: Buchtyp == 'blog' (gated via book_settings.buchtyp), aclParamGuard().
// Logging-Context book-Slot via router.param + bookParamHandler.

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { requireBlogTypeRoute } = require('../lib/buchtyp');
const blogs = require('../db/blogs');
const { createWpClient, validateBaseUrl } = require('../lib/wp-client');
const wordpress = require('../lib/sync/providers/wordpress');
const { mountSyncRoutes, sendRemoteError } = require('./sync-router');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

function _requireBlogType(req, res) {
  return requireBlogTypeRoute(req, res, 'BLOG_REQUIRES_BLOG_TYPE');
}

router.post('/:book_id/test', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const { baseUrl, username, password } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username || !password) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  try {
    const wp = createWpClient({ baseUrl: url, username, password });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(422).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
    return res.json({ ok: true, userId: me.id, name: me.name || me.slug || username });
  } catch (e) {
    logger.warn(`Blog-Test fehlgeschlagen: ${e.code || e.message}`);
    return sendRemoteError(res, e, 'BLOG');
  }
});

router.post('/:book_id/connect', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const bookId = req.bookId;
  const { baseUrl, username, password, defaultStatus = 'draft' } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  if (!['draft', 'publish', 'private'].includes(defaultStatus)) {
    return res.status(400).json({ error_code: 'BLOG_INVALID_STATUS' });
  }
  // Reuse stored password wenn Client `__keep__` schickt und Connection existiert —
  // aber nur gegen dasselbe Ziel (URL + User). Sonst koennte jeder Editor das
  // gespeicherte Passwort per `wp.me()` an einen eigenen Host schicken.
  let effectivePw = password === '__keep__' ? '' : password;
  if (!effectivePw) {
    const existing = blogs.getConnection(bookId);
    if (existing) {
      if (existing.baseUrl !== url || existing.username !== username) {
        return res.status(400).json({ error_code: 'BLOG_PASSWORD_REQUIRED_TARGET_CHANGED' });
      }
      effectivePw = existing.password;
    }
  }
  if (!effectivePw) return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  try {
    const wp = createWpClient({ baseUrl: url, username, password: effectivePw });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(422).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
  } catch (e) {
    return sendRemoteError(res, e, 'BLOG');
  }
  const conn = blogs.upsertConnection({
    bookId, baseUrl: url, username, password: effectivePw, defaultStatus,
  });
  return res.json({ ok: true, connection: conn });
});

mountSyncRoutes(router, wordpress);

module.exports = router;
