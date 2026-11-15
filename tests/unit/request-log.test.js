'use strict';
// lib/request-log.js: nur auffällige Antworten landen im Log, mit Context.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const logger = require('../../logger');
const { runWithContext, setContext, getContext } = require('../../lib/log-context');
const { requestLog, SLOW_MS } = require('../../lib/request-log');

function capture() {
  const lines = [];
  const orig = { info: logger.info, warn: logger.warn };
  logger.info = (m) => { lines.push({ level: 'info', m, ctx: { ...getContext() } }); };
  logger.warn = (m) => { lines.push({ level: 'warn', m, ctx: { ...getContext() } }); };
  return { lines, restore: () => Object.assign(logger, orig) };
}

async function withApp(setup, fn) {
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', 'abc12345');
    runWithContext({ job: 'http', user: 'u@x' }, () => next());
  });
  app.use(requestLog);
  setup(app);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const tick = () => new Promise(r => setImmediate(r));

test('5xx → WARN mit Pfad ohne Query, Request-ID und spät gesetztem book', async () => {
  const cap = capture();
  try {
    await withApp(app => {
      app.get('/boom', (req, res) => { setContext({ book: 42 }); res.status(502).json({}); });
    }, async (base) => {
      await fetch(`${base}/boom?q=geheim`);
      await tick();
    });
  } finally { cap.restore(); }
  assert.strictEqual(cap.lines.length, 1);
  const [l] = cap.lines;
  assert.strictEqual(l.level, 'warn');
  assert.match(l.m, /^GET \/boom → 502 \(\d+ms\) \[abc12345\]$/);
  assert.doesNotMatch(l.m, /geheim/);
  assert.strictEqual(l.ctx.book, 42);
  assert.strictEqual(l.ctx.user, 'u@x');
});

test('2xx, 401 und 404 bleiben still; übrige 4xx → INFO', async () => {
  const cap = capture();
  try {
    await withApp(app => {
      app.get('/ok', (req, res) => res.json({}));
      app.get('/auth', (req, res) => res.status(401).json({}));
      app.get('/conflict', (req, res) => res.status(409).json({}));
    }, async (base) => {
      for (const p of ['/ok', '/auth', '/nirgends', '/conflict']) await fetch(base + p);
      await tick();
    });
  } finally { cap.restore(); }
  assert.deepStrictEqual(cap.lines.map(l => [l.level, l.m.split(' (')[0]]), [['info', 'GET /conflict → 409']]);
});

test('Event-Streams werden nie geloggt, auch nicht bei Fehlerstatus', async () => {
  const cap = capture();
  try {
    await withApp(app => {
      app.get('/stream', (req, res) => { res.status(500).setHeader('Content-Type', 'text/event-stream'); res.end(); });
    }, async (base) => {
      await fetch(`${base}/stream`);
      await tick();
    });
  } finally { cap.restore(); }
  assert.strictEqual(cap.lines.length, 0);
});

test('Schwelle für langsame Requests liegt bei 5 s', () => {
  assert.strictEqual(SLOW_MS, 5000);
});
