'use strict';
// Gemeinsame Express-Bausteine: Body-Default + finaler JSON-Fehler-Handler.
//
// Express 5 reicht die Rejection eines async-Handlers (auch eines
// router.param-Callbacks) selbst per `next(err)` an die Fehlerkette; der
// Handler unten ist deren Ende. Nach bereits gesendeten Headern antwortet er
// nicht mehr, sondern loggt nur — sonst kappte der finalhandler mit
// `socket.destroy()` z.B. einen laufenden SSE-Stream.

const logger = require('../logger');

/** `req.body` ist immer ein Objekt (vor jedem Router registrieren).
 *  body-parser 2 laesst `req.body` bei einem Request ohne Body (POST ohne
 *  Content-Type, DELETE) `undefined`; die Handler destrukturieren `req.body`
 *  direkt. Ein Parser, der tatsaechlich einen Body liest, ueberschreibt den
 *  Default. */
function bodyDefault(req, res, next) {
  if (req.body === undefined) req.body = {};
  next();
}

/** Finaler Fehler-Handler (als letzte Middleware registrieren).
 *  Client-Fehler mit `status` 4xx (body-parser: zu gross, kaputtes JSON) behalten
 *  ihren Status; alles andere ist `500 { error_code: 'INTERNAL' }`. Keine
 *  Fehlerdetails an den Client — die stehen im Log. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    logger.error(`Fehler nach gesendeten Headern (${req.method} ${req.originalUrl}): ${err?.stack || err?.message || err}`);
    return;
  }
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    const code = err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE'
      : err.type === 'entity.parse.failed' ? 'INVALID_JSON'
        : 'BAD_REQUEST';
    return res.status(status).json({ error_code: code });
  }
  logger.error(`Unbehandelter Fehler (${req.method} ${req.originalUrl}): ${err?.stack || err?.message || err}`);
  return res.status(500).json({ error_code: 'INTERNAL' });
}

module.exports = { bodyDefault, errorHandler };
