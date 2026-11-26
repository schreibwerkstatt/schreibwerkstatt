'use strict';
// Live-Meldung für buchbezogene Daten ausserhalb des Manuskripts.
//
// Eine Middleware für alle Router: endet ein Schreib-Request (POST/PUT/PATCH/
// DELETE) erfolgreich (< 400) und trägt der Request-Kontext ein Buch
// (`setContext({ book })` — Pflicht für jede buchbezogene Route, siehe
// CLAUDE.md „Logging-Context"; `guardBook` und `router.param('book_id', …)`
// setzen ihn), feuert sie `emitBookMeta(book, kind)`. Der Buch-Kanal des
// Event-Streams reicht das als `book { meta: [kind] }` an offene Browser weiter;
// die laden Zähler und offene Karten des Bereichs nach (app-collab-stream.js).
//
// `kind` kommt aus dem Pfad (LIVE_KINDS). Nicht hier: das Manuskript selbst
// (/content — eigener `changed`-Anstoss aus der Content-Store-Facade) und die
// Share-Link-Kommentare (`comments`, explizit in routes/share/*, weil Leser im
// Share-Reader keinen Buch-Kontext über Guard/Param setzen). Ein neuer
// Bereich, dessen Daten live in anderen Tabs/Geräten erscheinen sollen,
// bekommt hier eine Zeile und client-seitig eine in KIND_CARDS.
//
// Echo: der Header X-Tab-Id (Browser, app/boot/fetch-guard.js) landet im
// Kontext; der auslösende Tab bekommt seine eigene Meldung nicht.

const { getContext, setContext } = require('./log-context');
const { emitBookMeta } = require('./book-events');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Pfad-Präfix → Bereich. Reihenfolge zählt: der erste Treffer gewinnt.
const LIVE_KINDS = [
  { re: /^\/share\/api\/(links\/[^/]+\/comments|comments)\b/, kind: null }, // explizit: 'comments'
  { re: /^\/share\/api\/links\b/, kind: 'shareLinks' },
  { re: /^\/ideen\b/, kind: 'ideen' },
  { re: /^\/redaktion\b/, kind: 'redaktion' },
  { re: /^\/research\b/, kind: 'recherche' },
  { re: /^\/plot\b/, kind: 'plot' },
  { re: /^\/chat\b/, kind: 'chat' },
  { re: /^\/(figures|draft-figures)\b/, kind: 'figuren' },
  { re: /^\/locations\b/, kind: 'orte' },
  { re: /^\/motifs\b/, kind: 'motiv' },
  { re: /^\/songs\b/, kind: 'songs' },
  { re: /^\/world-facts\b/, kind: 'weltfakten' },
  { re: /^\/sources\b/, kind: 'quellen' },
  { re: /^\/snapshots\b/, kind: 'fassungen' },
];

function kindForPath(path) {
  const p = String(path || '').split('?')[0];
  for (const { re, kind } of LIVE_KINDS) if (re.test(p)) return kind;
  return null;
}

const TAB_ID_RE = /^[0-9a-f]{12}$/;
function validTabId(v) {
  const s = String(v || '');
  return TAB_ID_RE.test(s) ? s : null;
}

function liveWrites(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  const kind = kindForPath(req.originalUrl || req.url);
  const tabId = validTabId(req.get?.('x-tab-id'));
  if (tabId) setContext({ tabId });
  if (!kind) return next();
  // `res.end` läuft im Async-Kontext des Handlers — dort steht `book` im
  // ALS-Store (ein `finish`-Listener sähe ihn nicht zuverlässig).
  const origEnd = res.end;
  let done = false;
  res.end = function (...args) {
    if (!done) {
      done = true;
      try {
        const book = getContext().book;
        if (book && res.statusCode < 400) emitBookMeta(book, kind);
      } catch { /* Live-Meldung ist Komfort, nie Fehlerquelle */ }
    }
    return origEnd.apply(this, args);
  };
  next();
}

module.exports = { liveWrites, kindForPath, validTabId, LIVE_KINDS };
