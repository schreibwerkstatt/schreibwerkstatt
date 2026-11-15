'use strict';
// Schlankes Access-Log: protokolliert nur auffällige HTTP-Antworten, nicht
// jeden Request. Ohne diese Zeilen sind Fehlerantworten, die ein Handler selbst
// setzt (`res.status(500)`, 502 aus einem Proxy-Handler), nur im Log des
// Reverse-Proxys sichtbar — im App-Log steht nichts.
//
//   status >= 500            → WARN  `GET /pfad → 500 (123ms) [reqId]`
//   status >= 400, ausser    → INFO  (401 = abgelaufene Session, 404 = Lookup —
//   401/404                           beides häufig und meist harmlos)
//   Dauer >= SLOW_MS         → WARN  `… langsam`
//
// Streams (`text/event-stream`) sind aussen vor: sie laufen bewusst lange.
// Geloggt wird nur der Pfad ohne Query — Suchtexte, Tokens und Ähnliches
// bleiben draussen. Die Zeile erbt user/book aus dem ALS-Context des Requests
// (der Handler kann `book` erst spät setzen; der Store wird darum als Objekt
// gemerkt und beim `finish` wieder aufgespannt).

const logger = require('../logger');
const { als, runWithContext } = require('./log-context');

const SLOW_MS = 5000;
const QUIET_4XX = new Set([401, 404]);

function _isStream(res) {
  return String(res.getHeader('Content-Type') || '').startsWith('text/event-stream');
}

function requestLog(req, res, next) {
  const t0 = process.hrtime.bigint();
  const store = als.getStore();
  res.on('finish', () => {
    if (_isStream(res)) return;
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    const status = res.statusCode;
    const slow = ms >= SLOW_MS;
    const error = status >= 500;
    const client = status >= 400 && status < 500 && !QUIET_4XX.has(status);
    if (!error && !client && !slow) return;
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const reqId = res.getHeader('X-Request-Id') || '-';
    const msg = `${req.method} ${path} → ${status} (${ms}ms)${slow ? ' langsam' : ''} [${reqId}]`;
    const write = () => (error || slow ? logger.warn(msg) : logger.info(msg));
    if (store) runWithContext(store, write); else write();
  });
  next();
}

module.exports = { requestLog, SLOW_MS };
