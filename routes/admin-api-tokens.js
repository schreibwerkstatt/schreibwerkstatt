'use strict';
// Admin-CRUD fuer api_tokens (Bearer-Tokens fuer Prometheus/HA/Grafana-Scraper).
// Plain-Token wird nur einmal bei POST /admin/api-tokens zurueckgegeben.
// Danach lebt in der DB nur der SHA-256-Hash; Re-Display unmoeglich.

const express = require('express');
const { requireAdmin } = require('../lib/admin-mw');
const apiTokens = require('../db/api-tokens');
const appUsers = require('../db/app-users');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const email = sessionEmail(req);
  const items = apiTokens.listApiTokens(email);
  res.json({ tokens: items });
});

router.post('/', express.json(), (req, res) => {
  const email = sessionEmail(req);
  const body = req.body || {};
  const name = (body.display_name || '').trim();
  if (!name) return res.status(400).json({ error_code: 'DISPLAY_NAME_REQUIRED' });
  if (name.length > 100) return res.status(400).json({ error_code: 'DISPLAY_NAME_TOO_LONG' });
  let expiresAt = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at);
    if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
    expiresAt = d.toISOString();
  }
  // `metrics:users` schaltet Kennzahlen je User frei (Schreibzeit, Kosten,
  // zuletzt gesehen). Ein Abruf alle paar Sekunden kann nicht jedes Mal ins
  // Audit schreiben wie die Usage-Ansicht — darum wird das Ausstellen auditiert,
  // als dasselbe Event `usage-viewed` (eigenes `kind`).
  const includeUsers = body.include_users === true;
  const scopes = includeUsers ? 'metrics:read,metrics:users' : 'metrics:read';
  try {
    const row = apiTokens.createApiToken({
      adminEmail: email,
      displayName: name,
      scopes,
      expiresAt,
    });
    logger.info(`api-tokens: created '${name}' (id=${row.id}, scopes=${scopes}) by ${email}`);
    if (includeUsers) {
      try {
        appUsers.recordAuditEvent(email, 'usage-viewed', {
          ip: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
          meta: { kind: 'metrics-users-token', tokenId: row.id, name },
        });
      } catch (e) {
        logger.warn(`api-tokens: audit failed: ${e.message}`);
      }
    }
    res.status(201).json({
      id: row.id,
      display_name: row.display_name,
      scopes: row.scopes,
      expires_at: row.expires_at,
      created_at: row.created_at,
      plain_token: row.plain_token,
    });
  } catch (e) {
    logger.error(`api-tokens create failed: ${e.message}`);
    res.status(500).json({ error_code: 'CREATE_FAILED', message: e.message });
  }
});

router.post('/:id/revoke', (req, res) => {
  const email = sessionEmail(req);
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const ok = apiTokens.revokeApiToken(id, email);
  if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND_OR_ALREADY_REVOKED' });
  logger.info(`api-tokens: revoked id=${id} by ${email}`);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const email = sessionEmail(req);
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const ok = apiTokens.deleteApiToken(id, email);
  if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
  logger.info(`api-tokens: deleted id=${id} by ${email}`);
  res.json({ ok: true });
});

module.exports = router;
