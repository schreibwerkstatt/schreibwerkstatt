'use strict';
// Kosten ueber den eigenen KI-Zugang (Mig 365, ai_cost_ledger.billed_to):
// job_runs haelt beim Start fest, wer zahlt, das Ledger uebernimmt es; Budget-
// Gate, Anthropic-Abgleich, /metrics und die Admin-Summen zaehlen nur die
// Instanz; die Profil-Uebersicht (GET /me/ai-access/usage) zeigt die eigenen.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('own-ai-access-billing');
process.env.SSRF_SKIP_DNS_CHECK = '1';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const aiProfiles = require('../../db/ai-profiles');
const appSettings = require('../../lib/app-settings');
const jobRuns = require('../../db/job-runs');
const costLedger = require('../../db/cost-ledger');
const adminUsage = require('../../db/admin-usage');
const { runWithContext } = require('../../lib/log-context');

const express = require('express');
const app = express();
app.use((req, _res, next) => {
  const email = req.headers['x-test-user-email'];
  req.session = email ? { user: { email, name: email, role: 'user' } } : {};
  next();
});
app.use('/me/ai-access', require('../../routes/me-ai-access'));
const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

const U = 'payer@example.com';
appUsers.createUser({ email: U, displayName: 'Payer' });
appSettings.set('ai.user_api.enabled', true);

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { 'x-test-user-email': U } }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    }).on('error', reject);
  });
}

// Ein Claude-Job mit 1M Input-Tokens (Sonnet: ein paar USD) im Kontext des Users.
let _n = 0;
function runJob(type = 'lektorat', provider = 'claude', model = 'claude-sonnet-5-5') {
  const id = `job-billing-${++_n}`;
  jobRuns.insertJobRun({ id, type, userEmail: U, provider, model });
  runWithContext({ user: U, jobId: id }, () => jobRuns.startJobRun(id));
  jobRuns.endJobRun(id, 'done', 1_000_000, 10_000, 0, 0, 0, null, null);
  return db.prepare('SELECT billed_to, usd FROM ai_cost_ledger WHERE source_ref = ?').get(`job:${id}`);
}

const since = '2000-01-01T00:00:00.000Z';

test('ohne eigenen Zugang: Job bucht auf die Instanz und zaehlt fuers Budget', () => {
  const row = runJob();
  assert.equal(row.billed_to, 'instance');
  assert.ok(row.usd > 0);
  assert.ok(Math.abs(costLedger.sumUsdSince(U, since) - row.usd) < 1e-9);
});

test('eigener Claude-Zugang: Job bucht als own, Budget und Anthropic-Abgleich ignorieren ihn', () => {
  const before = costLedger.sumUsdSince(U, since);
  const day = new Date().toISOString().slice(0, 10);
  const billedBefore = costLedger.claudeByDayModel(day, '2999-01-01').reduce((a, r) => a + r.usd, 0);
  aiProfiles.saveOwnProfile(U, { provider: 'claude', api_key: 'sk-ant-own' });

  const row = runJob();
  assert.equal(row.billed_to, 'own');
  assert.ok(row.usd > 0, 'Kosten werden trotzdem geschaetzt');
  assert.equal(costLedger.sumUsdSince(U, since), before);
  const billedAfter = costLedger.claudeByDayModel(day, '2999-01-01').reduce((a, r) => a + r.usd, 0);
  assert.equal(billedAfter, billedBefore);
});

test('Embedding-Lauf bei eigenem Zugang bleibt Instanz (Dienst des Betreibers)', () => {
  const row = runJob('embed-index', 'embed', 'bge-m3');
  assert.equal(row.billed_to, 'instance');
});

test('Zugang beim Start zaehlt, nicht beim Buchen', () => {
  const id = `job-billing-${++_n}`;
  jobRuns.insertJobRun({ id, type: 'lektorat', userEmail: U, provider: 'claude', model: 'claude-sonnet-5-5' });
  runWithContext({ user: U, jobId: id }, () => jobRuns.startJobRun(id));
  aiProfiles.deleteOwnProfile(U);
  jobRuns.endJobRun(id, 'done', 1000, 10, 0, 0, 0, null, null);
  assert.equal(db.prepare('SELECT billed_to FROM ai_cost_ledger WHERE source_ref = ?').get(`job:${id}`).billed_to, 'own');
  aiProfiles.saveOwnProfile(U, { provider: 'claude', api_key: 'sk-ant-own' });
});

test('Chat-Verbrauch bucht beim Buchen nach dem aktiven Zugang', () => {
  costLedger.recordChatLedgerEntry({
    jobId: 'chat-own-1', userEmail: U, kind: 'book', provider: 'claude', model: 'claude-sonnet-5-5',
    tokensIn: 50_000, tokensOut: 1_000,
  });
  assert.equal(db.prepare("SELECT billed_to FROM ai_cost_ledger WHERE source_ref = 'chatjob:chat-own-1'").get().billed_to, 'own');
});

test('Admin-Auswertung: usd = Instanz, ownUsd daneben; Breakdown nur Instanz', () => {
  const users = adminUsage.listUsersWithUsage({ from: since, to: '2999-01-01T00:00:00.000Z', includeAdmins: true });
  const u = users.find(x => x.email === U);
  const inst = db.prepare("SELECT SUM(usd) AS s FROM ai_cost_ledger WHERE user_email = ? AND billed_to = 'instance'").get(U).s;
  const own = db.prepare("SELECT SUM(usd) AS s FROM ai_cost_ledger WHERE user_email = ? AND billed_to = 'own'").get(U).s;
  assert.ok(Math.abs(u.usd - inst) < 1e-9);
  assert.ok(Math.abs(u.ownUsd - own) < 1e-9);

  const sum = adminUsage.monthlyTotals({ from: since, to: '2999-01-01T00:00:00.000Z', includeAdmins: true });
  assert.ok(Math.abs(sum.totals.usd - inst) < 1e-9);
  assert.ok(Math.abs(sum.totals.ownUsd - own) < 1e-9);

  const br = adminUsage.userJobBreakdown({ from: since, to: '2999-01-01T00:00:00.000Z', includeAdmins: true })
    .filter(r => r.email === U);
  assert.ok(Math.abs(br.reduce((a, r) => a + r.usd, 0) - inst) < 1e-9);
});

test('GET /me/ai-access/usage: eigene Kosten des laufenden Monats je Funktion', async () => {
  const r = await get('/me/ai-access/usage');
  assert.equal(r.status, 200);
  assert.equal(r.body.months.length, 2);
  const [cur] = r.body.months;
  const own = db.prepare("SELECT SUM(usd) AS s, COUNT(*) AS n FROM ai_cost_ledger WHERE user_email = ? AND billed_to = 'own'").get(U);
  assert.ok(Math.abs(cur.usd - own.s) < 1e-9);
  assert.equal(cur.calls, own.n);
  assert.ok(cur.rows.some(x => x.source === 'job' && x.type === 'lektorat'));
  assert.ok(cur.rows.some(x => x.source === 'chat' && x.type === 'book'));
  assert.ok(cur.rows.every(x => x.type !== 'embed-index'), 'Instanz-Calls erscheinen nicht');
});
