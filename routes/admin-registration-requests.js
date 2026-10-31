'use strict';
// Admin-Workflow fuer Zugangs-Anfragen. Alle Routen hinter requireAdmin.
//
// Endpoints:
//   GET    /admin/registration-requests              — Liste (status-Filter ueber ?status=)
//   POST   /admin/registration-requests/:id/approve  — Invite erzeugen + Approval-Mail
//   POST   /admin/registration-requests/:id/deny     — Status='denied' + optional Reason + Mail
//   POST   /admin/registration-requests/expire-stale — Manueller Trigger fuer Auto-Expire
//
// Bulk-Aktionen: Frontend ruft pro Request einzeln auf — kein Server-Bulk-
// Endpoint noetig, weil approve/deny atomar pro Row sind.

const express = require('express');
const logger = require('../logger');
const appUsers = require('../db/app-users');
const regRequests = require('../db/registration-requests');
const appSettings = require('../lib/app-settings');
const mailer = require('../lib/mailer');
const { buildInviteUrl } = require('../lib/invite-url');
const { requireAdmin } = require('../lib/admin-mw');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
router.use(requireAdmin);

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

router.get('/', (req, res) => {
  const status = String(req.query.status || 'pending').toLowerCase();
  const allowed = ['pending', 'approved', 'denied', 'expired', 'all'];
  if (!allowed.includes(status)) return res.status(400).json({ error_code: 'STATUS_INVALID' });
  const items = status === 'all' ? regRequests.listRecent(500) : regRequests.listByStatus(status);
  res.json({ items });
});

router.post('/:id/approve', express.json(), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error_code: 'ID_INVALID' });

  const reqRow = regRequests.getRequest(id);
  if (!reqRow) return res.status(404).json({ error_code: 'REQUEST_NOT_FOUND' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error_code: 'REQUEST_NOT_PENDING', status: reqRow.status });

  const { role = 'user' } = req.body || {};
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error_code: 'ROLE_INVALID' });

  const actor = sessionEmail(req);
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;

  let invite;
  try {
    invite = appUsers.createInvite({ email: reqRow.email, globalRole: role, invitedBy: actor });
  } catch (e) {
    logger.error(`registration-request approve: createInvite failed: ${e.message}`, { user: actor });
    return res.status(500).json({ error_code: 'INVITE_FAILED' });
  }

  const updated = regRequests.approveRequest(id, { reviewer: actor, inviteId: invite.id });
  if (!updated) {
    // Race: zwischen Lookup und Approve hat ein anderer Admin den Eintrag bewegt.
    return res.status(409).json({ error_code: 'REQUEST_RACE' });
  }

  appUsers.recordAuditEvent(reqRow.email, 'role-changed', {
    ip, userAgent,
    meta: { from: 'request', request_id: id, role, by: actor },
  });

  const inviteUrl = buildInviteUrl(invite.invite_token);
  let mailResult = { sent: false, reason: 'not-attempted' };
  try {
    // Approve-Mail synchron probieren, damit der Admin im UI sofort sieht,
    // ob Mail rausging oder Invite-URL inline kopiert werden muss.
    mailer.send({
      to: reqRow.email,
      template: 'registration-approved',
      locale: 'de',
      ctx: { inviteUrl, expiresAt: invite.expires_at },
    }).then(r => { mailResult = r; }).catch(e => { mailResult = { sent: false, reason: 'error', error: e.message }; });
  } catch (e) {
    mailResult = { sent: false, reason: 'error', error: e.message };
  }

  logger.info(`registration-request ${id} approved (${reqRow.email}, role=${role})`, { user: actor });
  res.json({ request: updated, invite, inviteUrl, mail: mailResult });
});

router.post('/:id/deny', express.json(), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error_code: 'ID_INVALID' });
  const reqRow = regRequests.getRequest(id);
  if (!reqRow) return res.status(404).json({ error_code: 'REQUEST_NOT_FOUND' });
  if (reqRow.status !== 'pending') return res.status(409).json({ error_code: 'REQUEST_NOT_PENDING', status: reqRow.status });

  const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
  const actor = sessionEmail(req);
  const updated = regRequests.denyRequest(id, { reviewer: actor, reason });
  if (!updated) return res.status(409).json({ error_code: 'REQUEST_RACE' });

  let mailResult = { sent: false, reason: 'not-attempted' };
  try {
    mailer.send({
      to: reqRow.email,
      template: 'registration-denied',
      locale: 'de',
      ctx: { reason: reason || '' },
    }).then(r => { mailResult = r; }).catch(e => { mailResult = { sent: false, reason: 'error', error: e.message }; });
  } catch (e) {
    mailResult = { sent: false, reason: 'error', error: e.message };
  }

  logger.info(`registration-request ${id} denied (${reqRow.email})`, { user: actor });
  res.json({ request: updated, mail: mailResult });
});

router.post('/expire-stale', (req, res) => {
  const days = Number(appSettings.get('auth.registration.expire_days')) || 30;
  const changed = regRequests.expireStale(days);
  logger.info(`registration-request: ${changed} pending->expired (cutoff=${days}d)`, { user: sessionEmail(req) });
  res.json({ expired: changed, days });
});

module.exports = router;
