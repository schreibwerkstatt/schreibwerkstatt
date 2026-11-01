'use strict';
// Graceful Shutdown (lib/shutdown.js): SIGTERM mit offener SSE-Verbindung und
// laufendem Job → Exit 0 deutlich vor dem Hard-Timeout; der Job ist danach
// abgeschlossen (fertig gelaufen) bzw. sauber abgebrochen — job_runs bleibt
// nicht auf 'running' stehen. Kurze Fristen per `timings` im Kindprozess.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');

const CHILD = path.join(__dirname, '_helpers', 'shutdown-child.js');

function startChild(mode) {
  const child = spawn(process.execPath, [CHILD, mode], {
    env: { ...process.env, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    const onData = () => {
      const line = out.split('\n').find(l => l.startsWith('{"port"'));
      if (line) { child.stdout.off('data', onData); resolve(JSON.parse(line)); }
    };
    child.stdout.on('data', onData);
    exited.then(code => reject(new Error(`Kind beendet (${code}) vor ready:\n${out}`)));
  });
  return { child, ready, exited, log: () => out };
}

function openSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/sse', agent: new http.Agent({ keepAlive: true }) }, res => {
      let ended = false;
      res.on('data', () => {});
      res.on('end', () => { ended = true; });
      res.once('data', () => resolve({ ended: () => ended }));
    });
    req.on('error', reject);
  });
}

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  return pred();
}

function jobRunStatus(dbFile, jobId) {
  const db = new Database(dbFile, { readonly: true });
  try { return db.prepare('SELECT status FROM job_runs WHERE job_id = ?').get(jobId)?.status; }
  finally { db.close(); }
}

function cleanupDb(dbFile) {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch {} }
}

for (const [mode, expected, maxMs] of [['finish', 'done', 4000], ['hang', 'cancelled', 5000]]) {
  test(`SIGTERM mit SSE + laufendem Job (${mode}) → Exit 0, Job ${expected}`, async () => {
    const c = startChild(mode);
    const { port, jobId, dbFile } = await c.ready;
    try {
      const sse = await openSse(port);
      // Der Job startet synchron in enqueueJob, also vor der ready-Zeile.
      assert.equal(jobRunStatus(dbFile, jobId), 'running');
      const t0 = Date.now();
      c.child.kill('SIGTERM');
      const code = await c.exited;
      const ms = Date.now() - t0;
      const log = c.log();
      assert.equal(code, 0, log);
      assert.ok(ms < maxMs, `Shutdown dauerte ${ms} ms\n${log}`);
      assert.match(log, /SIGTERM empfangen – Graceful Shutdown \(max 30 s Drain\)…/);
      assert.match(log, /Graceful Shutdown abgeschlossen/);
      assert.doesNotMatch(log, /erzwinge Exit/);
      assert.ok(sse.ended(), 'SSE-Antwort wurde nicht aktiv beendet');
      assert.equal(jobRunStatus(dbFile, jobId), expected);
      // WAL-Checkpoint(TRUNCATE) beim Close: kein Rest im WAL.
      const wal = `${dbFile}-wal`;
      assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL nicht zurückgeschrieben');
    } finally {
      if (c.child.exitCode === null) c.child.kill('SIGKILL');
      cleanupDb(dbFile);
    }
  });
}

test('während des Drains: keine neue Arbeit (Verbindung abgelehnt oder 503 SHUTTING_DOWN)', async () => {
  const c = startChild('hang');
  const { port, dbFile } = await c.ready;
  try {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/ping', agent }, res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body, conn: res.headers.connection }));
      }).on('error', reject);
    });
    assert.equal((await get()).status, 200);
    // Der laufende Job hält den Drain auf; in dieser Zeit darf nichts Neues
    // mehr bearbeitet werden.
    const sse = await openSse(port);
    c.child.kill('SIGTERM');
    await waitFor(() => /SIGTERM empfangen/.test(c.log()));
    await waitFor(() => sse.ended());
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ping', method: 'GET', agent: false }, r => {
        let body = ''; r.on('data', d => { body += d; }); r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      req.on('error', e => resolve({ error: e.code }));
      req.end();
    });
    // Neue Verbindungen nimmt der Server nicht mehr an (server.close).
    assert.ok(res.error === 'ECONNREFUSED' || res.status === 503, JSON.stringify(res));
    assert.equal(await c.exited, 0, c.log());
  } finally {
    if (c.child.exitCode === null) c.child.kill('SIGKILL');
    cleanupDb(dbFile);
  }
});
