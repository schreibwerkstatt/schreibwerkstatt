'use strict';
// Gebundene Content-Types fuer ausgelieferte BLOBs (Manuskript-Bilder,
// Recherche-Bild/-Dokument, Interview-Audio). Der gespeicherte MIME-Typ ist
// nicht vertrauenswuerdig: er kommt auch aus importierten .swbook-Bundles. Ein
// `text/html` bzw. `text/javascript` aus dem Bundle liefe sonst same-origin und
// umginge `script-src 'self'` der CSP.

const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SAFE_DOC_MIME = new Set(['application/pdf']);
const FALLBACK = 'application/octet-stream';

function _base(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** Erlaubter Bild-MIME oder null. */
function safeImageMime(mime) {
  const m = _base(mime);
  return SAFE_IMAGE_MIME.has(m) ? m : null;
}

/** Erlaubter Dokument-MIME oder null. */
function safeDocMime(mime) {
  const m = _base(mime);
  return SAFE_DOC_MIME.has(m) ? m : null;
}

/** Erlaubter Audio-MIME (dieselbe Liste wie der Interview-Upload) oder null. */
function safeAudioMime(mime) {
  const { extForMime } = require('./interview-transcribe');
  const m = _base(mime);
  return extForMime(m) ? m : null;
}

module.exports = { safeImageMime, safeDocMime, safeAudioMime, FALLBACK_MIME: FALLBACK };
