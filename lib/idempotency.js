'use strict';
// Idempotenz für Anlege-Requests, die der Client offline vormerkt und beim
// Wiederverbinden nachspielt (public/js/repo/structure-queue.js,
// public/js/repo/ideen-queue.js).
//
// WARUM: Reisst die Verbindung ab, nachdem der Server angelegt, aber bevor der
// Client die Antwort gelesen hat, sieht der Client denselben Netzfehler wie
// ohne Zustellung. Er spielt den Request später nach — ohne Schlüssel entstünde
// der Abschnitt bzw. die Idee doppelt. Mit `Idempotency-Key` liefert der Server
// für denselben Schlüssel (pro Konto und Route) die erste Antwort noch einmal,
// statt erneut anzulegen.
//
// LAUFENDER ERSTER REQUEST: Ein Client-Timeout gilt dem Client als „nicht
// zugestellt" (utils/net.js#isNetworkError) — der Nachspiel-Request kann also
// eintreffen, während der erste noch anlegt. Darum reserviert der erste den
// Schlüssel, und ein zweiter wartet auf dessen Ausgang: gelingt er, bekommt der
// zweite dieselbe Antwort; scheitert er (Antwort ohne `rememberIdempotent`,
// abgerissene Verbindung), gibt das Ende der Antwort die Reservierung frei und
// der wartende Request legt selbst an.
//
// Ablage im Speicher des Prozesses (ein Prozess je Instanz), 24 h, gedeckelt.
// Ein Neustart dazwischen verliert den Schutz für die betroffenen Schlüssel —
// das Zeitfenster ist der Augenblick zwischen Anlegen und verlorener Antwort,
// der Neustart müsste genau dort liegen.
//
// Der Header ist optional; ohne ihn ändert sich nichts.

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// `${user}|${scope}|${key}` → { status, body, at } (erledigt)
//                           | { pending: Promise, release, at } (läuft noch)
const _store = new Map();

function _slot(req, scope, email) {
  const key = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'];
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  return `${email || '-'}|${scope}|${key}`;
}

function _prune(now) {
  for (const [k, v] of _store) {
    if (now - v.at <= TTL_MS && _store.size <= MAX_ENTRIES) break;
    if (v.pending) continue; // ein laufender Request räumt selbst auf
    _store.delete(k);
  }
}

// Schlüssel für diesen Request belegen. Endet die Antwort, ohne dass
// rememberIdempotent sie eingetragen hat (Fehler, Abbruch), fällt die
// Reservierung und wartende Requests laufen selbst.
function _reserve(slot, res) {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const entry = { pending, release, at: Date.now() };
  _store.set(slot, entry);
  const done = () => {
    if (_store.get(slot) === entry) _store.delete(slot);
    release();
  };
  res.once?.('finish', done);
  res.once?.('close', done);
}

// Promise<true> = die frühere Antwort ist raus, der Handler endet hier.
// Promise<false> = selbst anlegen und danach rememberIdempotent rufen.
async function replayIdempotent(req, res, scope, email) {
  const slot = _slot(req, scope, email);
  if (!slot) return false;
  for (;;) {
    const hit = _store.get(slot);
    if (!hit || Date.now() - hit.at > TTL_MS) {
      _reserve(slot, res);
      return false;
    }
    if (hit.pending) {
      await hit.pending;
      // Hat der Client inzwischen aufgegeben, gibt es niemanden zu bedienen.
      if (res.destroyed || res.writableEnded) return true;
      continue;
    }
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(hit.status).json(hit.body);
    return true;
  }
}

function rememberIdempotent(req, scope, email, body, status = 200) {
  const slot = _slot(req, scope, email);
  if (!slot) return;
  const now = Date.now();
  const prev = _store.get(slot);
  _store.delete(slot);
  _store.set(slot, { status, body, at: now });
  prev?.release?.();
  _prune(now);
}

function _resetIdempotency() { _store.clear(); }

module.exports = { replayIdempotent, rememberIdempotent, _resetIdempotency, IDEMPOTENCY_TTL_MS: TTL_MS };
