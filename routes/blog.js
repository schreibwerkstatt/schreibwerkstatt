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

/** Passwort fuer Test/Connect: das mitgeschickte, sonst (`__keep__` oder leer)
 *  das gespeicherte DIESES Buchs — aber nur gegen dasselbe Ziel (URL + User).
 *  Sonst koennte jeder Editor das gespeicherte Passwort per `wp.me()` an einen
 *  eigenen Host schicken. Liefert `{ password }` oder `{ error_code }`. */
function _effectivePassword(bookId, url, username, password) {
  const given = password === '__keep__' ? '' : String(password || '');
  if (given) return { password: given };
  const existing = blogs.getConnection(bookId);
  if (!existing) return { error_code: 'BLOG_CREDENTIALS_REQUIRED' };
  if (existing.baseUrl !== url || existing.username !== username) {
    return { error_code: 'BLOG_PASSWORD_REQUIRED_TARGET_CHANGED' };
  }
  return { password: existing.password };
}

/** Remote-Fehler von Test/Connect. Eine weiterleitende Blog-URL bekommt die
 *  vermutlich richtige Adresse mit (`location`), damit der Hinweis sie nennen kann. */
function _sendConnectError(res, e) {
  if (e?.code === 'BLOG_REDIRECT') {
    return res.status(422).json({ error_code: 'BLOG_REDIRECT', location: e.location || null });
  }
  return sendRemoteError(res, e, 'BLOG');
}

router.post('/:book_id/test', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const { baseUrl, username, password } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  // Leeres Passwort bei gespeicherter Verbindung: das gespeicherte testen.
  const pw = _effectivePassword(req.bookId, url, username, password);
  if (pw.error_code) return res.status(400).json({ error_code: pw.error_code });
  try {
    const wp = createWpClient({ baseUrl: url, username, password: pw.password });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(422).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
    return res.json({ ok: true, userId: me.id, name: me.name || me.slug || username });
  } catch (e) {
    logger.warn(`Blog-Test fehlgeschlagen: ${e.code || e.message}`);
    return _sendConnectError(res, e);
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
  const pw = _effectivePassword(bookId, url, username, password);
  if (pw.error_code) return res.status(400).json({ error_code: pw.error_code });
  const effectivePw = pw.password;
  try {
    const wp = createWpClient({ baseUrl: url, username, password: effectivePw });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(422).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
  } catch (e) {
    return _sendConnectError(res, e);
  }
  const conn = blogs.upsertConnection({
    bookId, baseUrl: url, username, password: effectivePw, defaultStatus,
  });
  return res.json({ ok: true, connection: conn });
});

mountSyncRoutes(router, wordpress);

module.exports = router;
// Fuer Unit-Tests (tests/unit/wp-sync-fixes.test.js).
module.exports._effectivePassword = _effectivePassword;
