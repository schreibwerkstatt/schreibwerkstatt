'use strict';
// Kindprozess für graceful-shutdown.test.js: echter http-Server mit Gate, einer
// SSE-Route und einem laufenden Job der echten Queue; lib/shutdown.js wie in
// server.js installiert (echtes process.exit). Modus per argv:
//   finish — Job endet nach 1 s von selbst
//   hang   — Job wartet nur auf sein AbortSignal
const express = require('express');
const { bootstrap } = require('./setup');

const mode = process.argv[2];
const ctx = bootstrap();
const { db } = require('../../../db/connection');
const shared = require('../../../routes/jobs/shared');
const { jobAbortControllers } = require('../../../routes/jobs/shared/state');
const shutdown = require('../../../lib/shutdown');

const NOW = '2026-01-01T00:00:00.000Z';
db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run('x@test.dev');
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Buch', NOW, NOW);

const app = express();
app.use(shutdown.gate);
app.get('/sse', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  shutdown.trackStream(res);
  res.write('event: hello\ndata: {}\n\n');
});
app.get('/ping', (_req, res) => res.json({ ok: true }));

const server = app.listen(0, '127.0.0.1', () => {
  shutdown.install({
    server, db,
    timings: { JOB_GRACE_MS: 1500, ABORT_SETTLE_MS: 1000, CONN_DEADLINE_MS: 4000, HARD_TIMEOUT_MS: 6000 },
  });
  const jobId = shared.createJob('synonym', 1, 'x@test.dev', 'job.label.synonym');
  shared.enqueueJob(jobId, async () => {
    const signal = jobAbortControllers.get(jobId).signal;
    try {
      await new Promise((resolve, reject) => {
        if (mode === 'finish') setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      shared.completeJob(jobId, { ok: true });
    } catch (e) {
      shared.failJob(jobId, e);
    }
  });
  process.stdout.write(JSON.stringify({ port: server.address().port, jobId, dbFile: ctx.dbFile }) + '\n');
});
