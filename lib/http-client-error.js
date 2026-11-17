'use strict';
// Protokolliert Verbindungsfehler, die Node vor jedem Route-Handler abfängt
// (`clientError`: kaputter Request, Parser-Fehler, Header-/Request-Timeout,
// Reset der Gegenseite). Ohne Listener schliesst Node solche Sockets still —
// der Reverse-Proxy meldet dann `upstream prematurely closed` bzw. `Connection
// reset by peer` und liefert 502, während im App-Log nichts steht.
//
// Ein Listener schaltet Nodes Standardverhalten ab; die Antwort unten bildet es
// nach (431 bei Header-Überlauf, 408 bei Request-Timeout, sonst 400; bei Reset
// oder nicht mehr beschreibbarem Socket nur schliessen).

const logger = require('../logger');

const CLIENT_ABORT_CODES = new Set(['ECONNRESET', 'EPIPE']);

function _statusFor(code) {
  if (code === 'HPE_HEADER_OVERFLOW') return '431 Request Header Fields Too Large';
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') return '408 Request Timeout';
  return '400 Bad Request';
}

function install(server) {
  server.on('clientError', (err, socket) => {
    const code = err?.code || '-';
    const remote = socket?.remoteAddress || '-';
    const raw = err?.rawPacket ? ` raw=${err.rawPacket.length}B` : '';
    // Reset/Broken Pipe = Client hat die Verbindung selbst abgebrochen (Reload,
    // Tab zu, Navigation während einer laufenden Antwort) — kein Serverfehler.
    if (CLIENT_ABORT_CODES.has(code)) {
      logger.info(`HTTP Client hat Verbindung abgebrochen (${code}, remote=${remote}${raw})`);
    } else {
      logger.warn(`HTTP clientError ${code}: ${err?.message || err} (remote=${remote}${raw})`);
    }
    if (code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(`HTTP/1.1 ${_statusFor(code)}\r\nConnection: close\r\n\r\n`);
  });
}

module.exports = { install };
