'use strict';
// Admin-Logs-Routen.
// Hinter requireAdmin (lib/admin-mw.js). Liest schreibwerkstatt.log + rotierte
// Files. Server-seitiger Parser konvertiert das winston-Tag-Format
// `[scope|user|book|jobId] msg` in JSON. Keine Privacy-Boundary — Admin sieht
// alles, was Server in die Logs schreibt. Audit-Log auf Download.

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const appUsers = require('../db/app-users');
const logger = require('../logger');
const { parseLines } = require('../lib/log-parser');
const { readLinesReverse, listRotatedFiles } = require('../lib/log-reverse-read');
const { sessionEmail } = require('../lib/acl');

const { LOG_FILE } = require('../lib/log-file');
const MAX_FILES = 4;

const router = express.Router();
router.use(requireAdmin);
router.use((req, _res, next) => {
  setContext({ book: null });
  next();
});

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

function _filterMatch(entry, f) {
  if (f.level && entry.level !== f.level) return false;
  if (f.scope && entry.scope !== f.scope) return false;
  if (f.user && (entry.user || '').toLowerCase() !== f.user.toLowerCase()) return false;
  if (f.book && String(entry.book || '') !== String(f.book)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = (entry.msg + ' ' + (entry.stack || []).join(' ')).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function _filterFromQuery(q) {
  return {
    level: (q.level || '').trim().toLowerCase() || null,
    scope: (q.scope || '').trim() || null,
    user:  (q.user  || '').trim() || null,
    book:  (q.book  || '').trim() || null,
    q:     (q.q     || '').trim() || null,
  };
}

// ── GET /admin/logs/tail?lines=500 ───────────────────────────────────────────
// Letzte N Zeilen aus dem aktuellen File. Streaming, kein Full-File-Read im
// Heap. Max lines=2000.
router.get('/tail', async (req, res) => {
  const lines = Math.min(2000, Math.max(1, parseInt(req.query.lines, 10) || 500));
  if (!fs.existsSync(LOG_FILE)) return res.json({ entries: [] });
  // Reverse-Read bis genug Zeilen, dann re-parsen in chronologischer Reihenfolge.
  const buffer = [];
  for await (const line of readLinesReverse(LOG_FILE)) {
    buffer.push(line);
    if (buffer.length >= lines + 50) break; // Puffer fuer Stack-Trace-Append
  }
  buffer.reverse();
  const entries = [...parseLines(buffer)];
  res.json({ entries: entries.slice(-lines) });
});

// ── GET /admin/logs/search ───────────────────────────────────────────────────
// Cursor-Pagination rueckwaerts. `before` = Timestamp des aeltesten schon
// geladenen Eintrags, `skip` = wie viele passende Eintraege mit genau diesem
// Timestamp der Client schon hat. Der Timestamp hat Sekunden-Aufloesung; ohne
// `skip` fielen die restlichen Zeilen derselben Sekunde beim Nachladen weg.
// Liefert bis `limit` matches (default 200, max 500), liest rueckwaerts durch
// current + rotated bis erschoepft.
router.get('/search', async (req, res) => {
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const before = (req.query.before || '').trim();
  let skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
  const filter = _filterFromQuery(req.query);
  const files = listRotatedFiles(LOG_FILE, MAX_FILES);
  const matched = [];
  let exhausted = true;
  let buffer = [];

  function flushBuffer() {
    if (!buffer.length) return false;
    const chrono = buffer.slice().reverse();
    buffer = [];
    const entries = [...parseLines(chrono)];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (before && e.ts > before) continue;
      if (!_filterMatch(e, filter)) continue;
      if (before && e.ts === before && skip > 0) { skip--; continue; }
      matched.push(e);
      if (matched.length >= limit) return true;
    }
    return false;
  }

  outer: for (const file of files) {
    for await (const line of readLinesReverse(file)) {
      buffer.push(line);
      if (buffer.length >= 1000) {
        if (flushBuffer()) { exhausted = false; break outer; }
      }
    }
    if (flushBuffer()) { exhausted = false; break; }
  }

  // Aelteste matches zuerst — Client appendet unten.
  res.json({ entries: matched, hasMore: !exhausted });
});

// ── GET /admin/logs/files ────────────────────────────────────────────────────
// Liste mit current + rotated, jeweils size + mtime.
router.get('/files', (req, res) => {
  const files = listRotatedFiles(LOG_FILE, MAX_FILES);
  const out = files.map((f, idx) => {
    try {
      const stat = fs.statSync(f);
      return {
        key: idx === 0 ? 'current' : String(idx),
        path: path.basename(f),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
  res.json({ files: out });
});

// ── GET /admin/logs/download?file=current|1|2|3 ──────────────────────────────
// Streamt das ausgewaehlte File als text/plain mit Content-Disposition.
// Schreibt Audit-Event 'admin.logs.download'.
router.get('/download', (req, res) => {
  const key = (req.query.file || 'current').trim();
  const files = listRotatedFiles(LOG_FILE, MAX_FILES);
  const idx = key === 'current' ? 0 : parseInt(key, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) {
    return res.status(404).json({ error_code: 'FILE_NOT_FOUND' });
  }
  const file = files[idx];
  try {
    appUsers.recordAuditEvent(sessionEmail(req), 'admin.logs.download', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { file: path.basename(file) },
    });
  } catch (e) {
    logger.warn(`[admin-logs] audit log failed: ${e.message}`);
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  fs.createReadStream(file).pipe(res);
});

// ── GET /admin/logs/stream ───────────────────────────────────────────────────
// SSE-Endpoint. Polled via fs.watch + stat — schickt neu angehaengte Zeilen.
// Heartbeat alle 15s. Bei Rotation (size < lastOffset) sendet 'rotated'-Event
// und re-baselined auf aktuelles File-Ende.
router.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // NGINX: kein Buffering
  res.flushHeaders();

  let offset = 0;
  try {
    const stat = await fs.promises.stat(LOG_FILE);
    offset = stat.size;
  } catch {
    res.write('event: error\ndata: {"error":"LOG_FILE_MISSING"}\n\n');
    res.end();
    return;
  }

  let closed = false;
  let pending = false; // Re-entry-Guard fuer paralleles _drain

  const send = (event, data) => {
    if (closed) return;
    try {
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch { /* peer gone */ }
  };

  // Heartbeat als SSE-Kommentar — haelt Proxy + Browser warm, taucht nicht
  // im onmessage-Handler auf.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(':hb\n\n'); } catch {}
  }, 15_000);
  heartbeat.unref?.();

  let partial = '';

  async function _drain() {
    if (pending || closed) return;
    pending = true;
    try {
      let stat;
      try { stat = await fs.promises.stat(LOG_FILE); }
      catch { return; }
      if (stat.size < offset) {
        // Rotation: File geschrumpft (rename + new) — auf 0 baselined.
        send('rotated', { at: new Date().toISOString() });
        offset = 0;
        partial = '';
      }
      if (stat.size === offset) return;
      const stream = fs.createReadStream(LOG_FILE, { start: offset, end: stat.size - 1 });
      offset = stat.size;
      let chunk = partial;
      for await (const buf of stream) chunk += buf.toString('utf8');
      const lines = chunk.split('\n');
      partial = lines.pop() || '';
      const entries = [...parseLines(lines)];
      for (const entry of entries) send(null, entry);
    } finally {
      pending = false;
    }
  }

  // fs.watch ist event-driven (rename/change). Drain manuell.
  let watcher;
  try {
    watcher = fs.watch(LOG_FILE, { persistent: false }, () => { _drain(); });
  } catch { /* watch nicht verfuegbar — Fallback unten */ }
  // Safety-Net-Poll alle 2s — fs.watch verpasst Events bei file-replace
  // (Inode-Wechsel via rename in winston-rotation).
  const poll = setInterval(_drain, 2000);
  poll.unref?.();

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    clearInterval(poll);
    try { watcher?.close(); } catch {}
    try { res.end(); } catch {}
  });

  // Initial-Sync: falls in der kurzen Zeit zw. stat() und fs.watch() bereits
  // neue Bytes da sind.
  _drain();
});

module.exports = router;
