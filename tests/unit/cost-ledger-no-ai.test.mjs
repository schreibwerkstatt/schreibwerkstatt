// Kosten-Ledger (db/cost-ledger.js#recordJobLedger): ein Job-Lauf ohne KI-Call
// (Wortschatz-Scan, Anker, Redundanz) trägt in job_runs das Instanz-Modell, im
// Ledger aber weder Provider noch Modell — sonst zählte die Kostenstatistik je
// Modell lauter Null-Läufe. Die Zeile selbst bleibt: lastDoneJobRun liest sie
// jenseits der job_runs-Aufbewahrung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('cost-ledger-no-ai');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { recordJobLedger } = require('../../db/cost-ledger');

function insertRun(jobId, type, tokensIn, tokensOut) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at,
                          tokens_in, tokens_out, provider, model, cache_read_in, cache_creation_in)
    VALUES (?, ?, NULL, NULL, 'done', ?, ?, ?, ?, ?, 'claude', 'claude-opus-5-5', 0, 0)
  `).run(jobId, type, now, now, now, tokensIn, tokensOut);
  recordJobLedger(jobId);
  return db.prepare('SELECT provider, model, usd FROM ai_cost_ledger WHERE source_ref = ?').get(`job:${jobId}`);
}

test('Lauf ohne Token: Ledger-Zeile ohne Provider/Modell', () => {
  const row = insertRun('j-noai', 'lexicon-scan', 0, 0);
  assert.ok(row, 'Zeile bleibt für lastDoneJobRun');
  assert.equal(row.provider, null);
  assert.equal(row.model, null);
  assert.equal(row.usd, 0);
});

test('Lauf mit Token: Provider/Modell bleiben', () => {
  const row = insertRun('j-ai', 'check', 1000, 200);
  assert.equal(row.provider, 'claude');
  assert.equal(row.model, 'claude-opus-5-5');
  assert.ok(row.usd > 0);
});
