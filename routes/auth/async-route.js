'use strict';
// Wrapper fuer asynchrone Auth-Handler.
//
// Express 5 reicht die Rejection eines `async`-Handlers an die allgemeine
// Fehlerkette, die mit `500 INTERNAL` und einem Log ohne Routenbezug antwortet.
// Auf den Anmeldepfaden soll der Fehler stattdessen mit dem Label der Route im
// Log stehen und mit dem Code, den die Anmelde-Clients erwarten.
//
// Darum laeuft jeder async-Handler unter routes/auth/ durch diesen Wrapper.
// Er antwortet mit 500 und einem `error_code`, damit die Client-Seite dem
// Vertrag aus docs/clients.md folgt.

const logger = require('../../logger');

function asyncRoute(label, handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      logger.error(`${label}: ${err && err.stack ? err.stack : err}`);
      if (res.headersSent) return;
      res.status(500).json({ error_code: 'INTERNAL_ERROR' });
    });
  };
}

module.exports = { asyncRoute };
