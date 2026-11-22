'use strict';
// In-Memory-Rate-Limit der oeffentlichen Share-Routen, je (Token, IP-Hash):
//   check     → POST /share/:token/comment (+ Fazit mit eigenem Schluessel)
//   checkTts  → POST /share/:token/tts
//   checkView → GET  /share/:token (Leseansicht)
// Beta-Leser hinterlassen viele verankerte Inline-Anmerkungen pro Sitzung — der
// Spam-Schutz muss das zulassen, ohne ein Bot-Schleudertor zu sein. Process-
// Restart resettet (akzeptabel: Self-Hosted-Pattern, kein Cluster-Setup). Das
// Kommentar-Limit ist live aus app_settings konfigurierbar
// (share.comment.rate_limit_max / .rate_limit_window_min).
//
// Jeder Bucket-Satz raeumt sich selbst auf: abgelaufene Schluessel fallen bei
// einem periodischen Durchlauf weg. Ohne das hielte die Map jedes je gesehene
// (Token, IP)-Paar bis zum Neustart.

const crypto = require('crypto');
const appSettings = require('./app-settings');

const SWEEP_EVERY = 500; // Aufrufe zwischen zwei Aufraeum-Durchlaeufen

// Gleitendes Fenster ueber Zeitstempel je Schluessel. `windowMs`/`max` sind
// Funktionen, damit live geaenderte Settings ohne Neustart greifen.
function makeLimiter({ windowMs, max }) {
  const buckets = new Map(); // key → number[] timestamps (aufsteigend)
  let calls = 0;

  function sweep(now, win) {
    const cutoff = now - win;
    for (const [key, arr] of buckets) {
      if (!arr.length || arr[arr.length - 1] <= cutoff) buckets.delete(key);
    }
  }

  function check(token, ipHash) {
    const key = `${token}:${ipHash}`;
    const now = Date.now();
    const win = windowMs();
    const limit = max();
    if (++calls % SWEEP_EVERY === 0) sweep(now, win);
    const arr = (buckets.get(key) || []).filter(t => t > now - win);
    if (arr.length >= limit) {
      buckets.set(key, arr);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + win - now) / 1000)) };
    }
    arr.push(now);
    buckets.set(key, arr);
    return { allowed: true, remaining: limit - arr.length };
  }

  return { check, reset: () => { buckets.clear(); calls = 0; }, size: () => buckets.size, sweep: () => sweep(Date.now(), windowMs()) };
}

let _salt = null;
function _getSalt() {
  if (_salt) return _salt;
  _salt = process.env.SHARE_IP_SALT || crypto.randomBytes(16).toString('hex');
  return _salt;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update((ip || '') + _getSalt()).digest('hex').slice(0, 16);
}

const _comments = makeLimiter({
  windowMs: () => (appSettings.get('share.comment.rate_limit_window_min') || 60) * 60 * 1000,
  max: () => appSettings.get('share.comment.rate_limit_max') || 30,
});

// Vorlesen: ein Satz alle paar Sekunden plus Vorausladen und Wiederholungen
// bleibt weit darunter; ein Skript, das den Speech-Server als Dienst nutzt, nicht.
const TTS_WINDOW_MS = 10 * 60 * 1000;
const TTS_MAX_PER_WINDOW = 400;
const _tts = makeLimiter({ windowMs: () => TTS_WINDOW_MS, max: () => TTS_MAX_PER_WINDOW });

// Leseansicht: jeder Aufruf rendert den ganzen geteilten Inhalt neu (bei einem
// Buch-Share das ganze Buch). Ein Leser, der mehrfach neu laedt, bleibt weit
// unter dem Deckel; eine Schleife, die den Server beschaeftigt, nicht.
const VIEW_WINDOW_MS = 60 * 1000;
const VIEW_MAX_PER_WINDOW = 120;
const _views = makeLimiter({ windowMs: () => VIEW_WINDOW_MS, max: () => VIEW_MAX_PER_WINDOW });

function _resetAll() {
  _comments.reset();
  _tts.reset();
  _views.reset();
}

module.exports = {
  hashIp,
  check: _comments.check,
  checkTts: _tts.check,
  checkView: _views.check,
  TTS_MAX_PER_WINDOW, VIEW_MAX_PER_WINDOW, SWEEP_EVERY,
  makeLimiter,
  _resetAll,
};
