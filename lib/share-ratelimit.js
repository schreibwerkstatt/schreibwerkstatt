'use strict';
// In-Memory-Rate-Limit für POST /share/:token/comment (check) und
// POST /share/:token/tts (checkTts, eigene Buckets).
// max Kommentare pro (Token, IP-Hash) pro Zeitfenster. Beta-Leser hinterlassen
// viele verankerte Inline-Anmerkungen pro Sitzung — der Spam-Schutz muss das
// zulassen, ohne ein Bot-Schleudertor zu sein. Process-Restart resettet
// (akzeptabel: Self-Hosted-Pattern, kein Cluster-Setup). Limit + Fenster sind
// live aus app_settings konfigurierbar
// (share.comment.rate_limit_max / .rate_limit_window_min).

const crypto = require('crypto');
const appSettings = require('./app-settings');

const _buckets = new Map(); // `${token}:${ipHash}` → number[] timestamps

function _windowMs() {
  return (appSettings.get('share.comment.rate_limit_window_min') || 60) * 60 * 1000;
}
function _maxPerWindow() {
  return appSettings.get('share.comment.rate_limit_max') || 30;
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

function check(token, ipHash) {
  const key = `${token}:${ipHash}`;
  const now = Date.now();
  const windowMs = _windowMs();
  const maxPerWindow = _maxPerWindow();
  const cutoff = now - windowMs;
  let arr = _buckets.get(key) || [];
  arr = arr.filter(t => t > cutoff);
  if (arr.length >= maxPerWindow) {
    _buckets.set(key, arr);
    return { allowed: false, retryAfterSec: Math.ceil((arr[0] + windowMs - now) / 1000) };
  }
  arr.push(now);
  _buckets.set(key, arr);
  return { allowed: true, remaining: maxPerWindow - arr.length };
}

// Vorlesen (POST /share/:token/tts): eigene Buckets, eigenes Fenster. Ein Satz
// alle paar Sekunden plus Vorausladen und Wiederholungen bleibt weit darunter;
// ein Skript, das den Speech-Server als Dienst nutzt, nicht.
const TTS_WINDOW_MS = 10 * 60 * 1000;
const TTS_MAX_PER_WINDOW = 400;
const _ttsBuckets = new Map();

function checkTts(token, ipHash) {
  const key = `${token}:${ipHash}`;
  const now = Date.now();
  const arr = (_ttsBuckets.get(key) || []).filter(t => t > now - TTS_WINDOW_MS);
  if (arr.length >= TTS_MAX_PER_WINDOW) {
    _ttsBuckets.set(key, arr);
    return { allowed: false, retryAfterSec: Math.ceil((arr[0] + TTS_WINDOW_MS - now) / 1000) };
  }
  arr.push(now);
  _ttsBuckets.set(key, arr);
  return { allowed: true, remaining: TTS_MAX_PER_WINDOW - arr.length };
}

function _resetAll() {
  _buckets.clear();
  _ttsBuckets.clear();
}

module.exports = { hashIp, check, checkTts, TTS_MAX_PER_WINDOW, _resetAll };
