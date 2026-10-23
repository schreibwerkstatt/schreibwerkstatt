'use strict';
// Pre-Auth-Freigabe statischer Assets (server.js, vor dem Auth-Guard).
//
// Die Freigabe-Listen (PUBLIC_ASSETS, PUBLIC_ASSET_PREFIXES) stehen in
// server.js; hier liegt nur die Prüfung, ob ein Request-Pfad darunter fällt.
//
// Geprüft wird der KANONISCHE Pfad, nicht der rohe: express.static dekodiert
// und normalisiert selbst, bevor es die Datei sucht. Ein roher Präfix-Vergleich
// liesse `/img/../index.html` oder `/css/%2e%2e/…` als «unter /css/» durch, und
// express.static lieferte danach eine beliebige Datei aus public/ ohne
// Anmeldung. Darum: einmal dekodieren (wie express.static), und nur ein Pfad,
// der dabei schon kanonisch ist (kein `.`/`..`-Segment, kein `//`, kein
// Backslash, kein NUL), kann öffentlich sein. Alles andere läuft in den
// Auth-Guard — angemeldet liefert das spätere express.static es weiterhin.

const path = require('path');

/** Dekodierter, kanonischer Pfad — oder null, wenn er nicht kanonisch ist. */
function canonicalAssetPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (path.posix.normalize(decoded) !== decoded) return null;
  if (decoded.split('/').some(seg => seg === '..' || seg === '.')) return null;
  return decoded;
}

/** True, wenn der Pfad exakt freigegeben ist oder unter einem Präfix liegt. */
function isPublicAssetPath(rawPath, { exact, prefixes }) {
  const p = canonicalAssetPath(rawPath);
  if (!p) return false;
  return exact.has(p) || prefixes.some(prefix => p.startsWith(prefix));
}

/** Middleware: freigegebene GETs direkt an `serve` (express.static), sonst weiter. */
function makePublicAssetGate({ exact, prefixes, serve }) {
  return (req, res, next) => {
    if (req.method === 'GET' && isPublicAssetPath(req.path, { exact, prefixes })) {
      return serve(req, res, next);
    }
    next();
  };
}

module.exports = { canonicalAssetPath, isPublicAssetPath, makePublicAssetGate };
