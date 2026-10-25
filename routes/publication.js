'use strict';
// Buch-weite Publikations-Metadaten (book_publication): Titelei + Cover +
// Autorfoto. Von PDF- und EPUB-Export gelesen, im BookSettings-Publikation-Tab
// gepflegt. ACL buch-scoped (viewer lesen, editor schreiben) via aclParamGuard.

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const { prepareCover, MAX_INPUT_BYTES } = require('../lib/cover-prepare');
const bp = require('../db/book-publication');
const searchIndex = require('../lib/search');

const router = express.Router();
const jsonBody = express.json();
const rawCoverBody = express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_INPUT_BYTES + 1 });

router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  res.json(bp.getMeta(req.bookId));
});

router.put('/:book_id', aclParamGuard('editor'), jsonBody, (req, res) => {
  const meta = bp.upsertMeta(req.bookId, req.body || {});
  // Der Klappentext (description) ist Teil des Buch-Suchtreffers.
  searchIndex.upsertBookMeta(req.bookId);
  res.json(meta);
});

// ── Cover ──────────────────────────────────────────────────────────────────
router.post('/:book_id/cover', aclParamGuard('editor'), rawCoverBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'COVER_EMPTY' });
  }
  let prepared;
  try { prepared = await prepareCover(req.body); }
  catch (e) { return res.status(400).json({ error_code: 'COVER_INVALID', params: { reason: e.message } }); }
  bp.setCover(req.bookId, prepared.buffer, prepared.mime);
  res.json({ ok: true, mime: prepared.mime, width: prepared.width, height: prepared.height, bytes: prepared.buffer.length });
});

router.delete('/:book_id/cover', aclParamGuard('editor'), (req, res) => {
  bp.clearCover(req.bookId);
  res.json({ ok: true });
});

router.get('/:book_id/cover', aclParamGuard('viewer'), (req, res) => {
  const cover = bp.getCover(req.bookId);
  if (!cover) return res.status(404).json({ error_code: 'NO_COVER' });
  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(cover.image);
});

// ── Autorfoto ────────────────────────────────────────────────────────────────
// Identische sharp-Härtung wie Cover (prepareCover: Magic-Bytes, sRGB-JPEG).
router.post('/:book_id/author-image', aclParamGuard('editor'), rawCoverBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'IMAGE_EMPTY' });
  }
  let prepared;
  try { prepared = await prepareCover(req.body); }
  catch (e) { return res.status(400).json({ error_code: 'IMAGE_INVALID', params: { reason: e.message } }); }
  bp.setAuthorImage(req.bookId, prepared.buffer, prepared.mime);
  res.json({ ok: true, mime: prepared.mime, width: prepared.width, height: prepared.height, bytes: prepared.buffer.length });
});

router.delete('/:book_id/author-image', aclParamGuard('editor'), (req, res) => {
  bp.clearAuthorImage(req.bookId);
  res.json({ ok: true });
});

router.get('/:book_id/author-image', aclParamGuard('viewer'), (req, res) => {
  const img = bp.getAuthorImage(req.bookId);
  if (!img) return res.status(404).json({ error_code: 'NO_IMAGE' });
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(img.image);
});

module.exports = router;
