'use strict';
const { sessionEmail } = require('../../lib/acl');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { _validDeviceId } = require('../content/shared');
const { attachJobChannel } = require('../jobs/shared/stream');
const { attachBookChannel } = require('./book-channel');
const { trackStream } = require('../../lib/shutdown');

// GET /events/stream[?book_id=<id>&device_id=<uuid>] — ein SSE-Stream pro Tab.
//
// Kanäle:
//   Jobs  immer — Jobs des Session-Users (routes/jobs/shared/stream.js)
//   Buch  mit book_id + gültiger Rolle — Anstösse für Changes und Presence
//         (book-channel.js). Das Abo ist Teil der URL: beim Buchwechsel baut der
//         Client die Verbindung neu auf. device_id steht ebenfalls in der Query,
//         weil EventSource keine Header setzen kann.
//
// Ein Buch ohne Zugriff ist kein Fehler des Streams: der Job-Kanal läuft, der
// Buch-Kanal fehlt, und der erste `hello` sagt es dem Client (`book: null`).
const HEARTBEAT_MS = 25_000;

function handleEventStream(req, res) {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const bookId = toIntId(req.query?.book_id);
  const rawDevice = (req.query?.device_id || '').toString();
  const deviceId = _validDeviceId(rawDevice) ? rawDevice : null;
  if (bookId) setContext({ book: bookId });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // NGINX: kein Buffering
  res.flushHeaders();
  trackStream(res);

  let closed = false;
  const write = (event, data) => {
    if (closed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* peer weg */ }
  };

  // Reconnect-Pause für den Browser.
  res.write('retry: 5000\n\n');

  const book = bookId ? attachBookChannel(write, { email, bookId, deviceId }) : null;
  write('hello', { book: book ? bookId : null });
  const detachJobs = attachJobChannel(write, email);

  // Kommentar-Zeile hält Proxy und Browser warm, taucht in keinem Listener auf.
  // Derselbe Takt ist das Presence-Lebenszeichen des Buch-Kanals.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(':hb\n\n'); } catch { /* peer weg */ }
    book?.heartbeat();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    detachJobs();
    book?.detach();
  });
}

module.exports = { handleEventStream, HEARTBEAT_MS };
