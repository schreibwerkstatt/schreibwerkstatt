'use strict';
// Admin-Usage-Routen.
// Hinter requireAdmin (lib/admin-mw.js). Privacy-Boundary: Admin sieht
// Job-Typen, Modelle, Token-Counts, USD-Kosten und anonyme `book_id` —
// keine Prompt-Inhalte, keine Chat-Texte, keine Buchtitel.
//
// Jeder Read-Endpoint schreibt 'usage-viewed' ins user_sessions_audit
// (Subject = Admin selbst), damit die Privacy-Boundary nachvollziehbar ist.

const express = require('express');
const adminUsage = require('../db/admin-usage');
const billing = require('../lib/anthropic-billing');
const appUsers = require('../db/app-users');
const { requireAdmin } = require('../lib/admin-mw');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
router.use(requireAdmin);

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

function _auditView(req, kind, meta = {}) {
  try {
    appUsers.recordAuditEvent(sessionEmail(req), 'usage-viewed', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { kind, ...meta },
    });
  } catch (e) {
    logger.warn(`[admin-usage] audit log failed: ${e.message}`);
  }
}

function _range(req) {
  const from = (req.query.from || '').trim() || undefined;
  const to   = (req.query.to   || '').trim() || undefined;
  return { from, to };
}

// `?includeAdmins=1` schaltet die Calls der Admin-Konten in die Auswertung zu.
function _includeAdmins(req) {
  return req.query.includeAdmins === '1';
}

// GET /admin/usage/users?from=&to=
router.get('/users', (req, res) => {
  const range = _range(req);
  const rows = adminUsage.listUsersWithUsage({ ...range, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'users', { from: range.from, to: range.to });
  res.json({ users: rows, from: range.from || null, to: range.to || null });
});

// Normalisiert `?user=` (string | string[]) zu einem deduplizierten,
// lowercased Email-Array. Leeres Array = kein User-Filter.
function _emails(req) {
  const raw = req.query.user;
  const arr = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const seen = new Set();
  for (const v of arr) {
    const e = String(v).toLowerCase().trim();
    if (e) seen.add(e);
  }
  return [...seen];
}

// GET /admin/usage/jobs?user=&from=&to=&limit=&offset=  (user repeatable)
router.get('/jobs', (req, res) => {
  const emails = _emails(req);
  const range = _range(req);
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const result = adminUsage.getJobRuns({ emails, ...range, limit, offset, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'jobs', { target: emails.length ? emails.join(',') : '*all*', ...range });
  res.json(result);
});

// GET /admin/usage/chat?user=&from=&to=&limit=&offset=&feedback=  (user repeatable)
// `feedback=down|up`: nur Antworten mit Daumen runter/hoch — Metadaten, kein Text.
router.get('/chat', (req, res) => {
  const emails = _emails(req);
  const range = _range(req);
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  const feedback = ['down', 'up'].includes(req.query.feedback) ? req.query.feedback : null;
  const result = adminUsage.getChatMessages({ emails, ...range, limit, offset, feedback, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'chat', { target: emails.length ? emails.join(',') : '*all*', feedback, ...range });
  res.json(result);
});

// GET /admin/usage/chat-quality?from=&to=&includeAdmins=
// Je Chat-Art: Antworten, Fehlerquote, Feedback-Anteile, Wiederholungen, Kosten.
// Nur Zaehler — keine Chat-Texte (Privacy-Boundary oben).
router.get('/chat-quality', (req, res) => {
  const range = _range(req);
  const rows = adminUsage.chatQuality({ ...range, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'chat-quality', range);
  res.json({ rows, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/summary?from=&to=
router.get('/summary', (req, res) => {
  const range = _range(req);
  const summary = adminUsage.monthlyTotals({ ...range, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'summary', range);
  res.json(summary);
});

// GET /admin/usage/breakdown?from=&to=&includeAdmins=
// Kosten je User x Job-Typ (Chat je Session-Art) aus dem Ledger.
router.get('/breakdown', (req, res) => {
  const range = _range(req);
  const rows = adminUsage.userJobBreakdown({ ...range, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'breakdown', range);
  res.json({ rows, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/features?from=&to=
router.get('/features', (req, res) => {
  const range = _range(req);
  const opts = { ...range, includeAdmins: _includeAdmins(req) };
  const items   = adminUsage.listFeatureUsage(opts);
  const totals  = adminUsage.featureUsageTotals(opts);
  _auditView(req, 'features', range);
  res.json({ items, totals, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/time?from=&to=
router.get('/time', (req, res) => {
  const range = _range(req);
  const items = adminUsage.listTimeUsage({ ...range, includeAdmins: _includeAdmins(req) });
  _auditView(req, 'time', range);
  res.json({ items, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/time/:email/:bookId/series?from=&to=
router.get('/time/:email/:bookId/series', (req, res) => {
  const email = (req.params.email || '').toLowerCase();
  const bookId = parseInt(req.params.bookId, 10);
  if (!email || !Number.isFinite(bookId)) {
    return res.status(400).json({ error_code: 'PARAMS_INVALID' });
  }
  const range = _range(req);
  const series = adminUsage.dailyTimeSeries(email, bookId, range);
  _auditView(req, 'time-series', { target: email, bookId, ...range });
  res.json({ series, email, bookId, from: range.from || null, to: range.to || null });
});

// GET /admin/usage/billing?from=&to=
// Abgerechnete Anthropic-Kosten (Cost-Report-API, gespiegelt in
// anthropic_cost_daily) gegen das App-Ledger, je UTC-Tag und je Modell.
router.get('/billing', (req, res) => {
  const range = _range(req);
  const report = billing.buildReport(range);
  _auditView(req, 'billing', range);
  res.json(report);
});

// POST /admin/usage/billing/sync — Abruf von Hand (sonst taeglich per Cron).
// Holt einen Monat, damit auch ein nachtraeglich eingetragener Admin-Key
// sofort einen vollen Vergleich zeigt.
router.post('/billing/sync', async (req, res) => {
  if (!billing.isConfigured()) return res.status(400).json({ error_code: 'BILLING_NOT_CONFIGURED' });
  try {
    const result = await billing.syncBilling({ days: 31 });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error_code: e.code || 'BILLING_FETCH_FAILED', status: e.status || null });
  }
});

module.exports = router;
