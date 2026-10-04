'use strict';
// Bearer-Token-Auth fuer externe Scraper (Prometheus/HA/Grafana).
// Middleware sucht `Authorization: Bearer sw_<hex>`-Header, validiert
// gegen api_tokens-Tabelle und setzt req.session.user, sodass der nachfolgende
// Global-Guard + requireAdmin-Middleware den Request durchwinken.

const logger = require('../logger');
const apiTokens = require('../db/api-tokens');

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function tokenHasScope(scopesStr, required) {
  if (!required) return true;
  if (!scopesStr) return false;
  const list = String(scopesStr).split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(required);
}

function requireBearer(requiredScope) {
  return (req, res, next) => {
    const plain = extractBearer(req);
    if (!plain) {
      res.set('WWW-Authenticate', 'Bearer realm="schreibwerkstatt", error="invalid_request"');
      return res.status(401).json({ error_code: 'BEARER_REQUIRED' });
    }
    const row = apiTokens.findActiveTokenByPlain(plain);
    if (!row) {
      res.set('WWW-Authenticate', 'Bearer realm="schreibwerkstatt", error="invalid_token"');
      return res.status(401).json({ error_code: 'INVALID_TOKEN' });
    }
    if (!tokenHasScope(row.scopes, requiredScope)) {
      return res.status(403).json({ error_code: 'INSUFFICIENT_SCOPE', required: requiredScope });
    }
    try {
      // Nur req.ip (via `trust proxy`-Hop); client-supplied X-Forwarded-For ist spoofbar.
      const ip = (req.ip || '').toString();
      apiTokens.touchTokenUsage(row.id, ip);
    } catch (e) {
      logger.warn(`api_tokens.touchTokenUsage: ${e.message}`);
    }
    req.session = req.session || {};
    req.session.user = { email: row.admin_email, role: 'admin', via: 'api_token' };
    req.apiToken = { id: row.id, scopes: row.scopes };
    next();
  };
}

module.exports = { requireBearer, extractBearer, tokenHasScope };
