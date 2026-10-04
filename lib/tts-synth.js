'use strict';
// TTS-Synthese-Kern (SSoT) — geteilt zwischen der auth-pflichtigen Route
// routes/tts.js (Notebook-Proof-Listening) und der public, token-skopierten
// Route routes/share/reader.js (Vorlesen im Share-Reader). Beide reichen einen
// Satz/Absatz an einen OpenAI-kompatiblen Speech-Endpunkt `${host}/v1/audio/speech`
// durch; Host/Model/Voice/Key kommen aus app_settings und verlassen den Server
// nie. Kein Persistieren, kein callAI, kein Token-Budget — verbatim vorlesen.
//
// Dritte Sync-Proxy-Ausnahme zur Job-Queue-Regel (analog routes/stt.js und
// routes/languagetool.js): kurzer Request/Response-Synthesecall.

const crypto = require('crypto');
const appSettings = require('./app-settings');

const TEXT_MAX = 8 * 1024; // 8 KB — ein Satz/Absatz pro Request, nie ganze Seiten
const UPSTREAM_TIMEOUT_MS = 20_000;

// response_format -> MIME fuer den Audio-Download. Nur Formate, die ein
// Browser-<audio> abspielen kann: rohes PCM (ohne Container) kann keiner — ein
// gespeichertes `pcm` (Alt-Einstellung) faellt deshalb auf mp3 zurueck, statt
// jeden Satz still scheitern zu lassen.
const FORMAT_MIME = {
  mp3:  'audio/mpeg',
  opus: 'audio/ogg',
  aac:  'audio/aac',
  flac: 'audio/flac',
  wav:  'audio/wav',
};

// Audio-Cache (Prozess-Speicher, LRU nach Bytes). Proof-Listening heisst: eine
// Seite nach einer kleinen Korrektur noch einmal hoeren — die unveraenderten
// Saetze kommen dann aus dem Cache statt erneut ueber die GPU. Schluessel ueber
// alles, was das Audio bestimmt (Host, Modell, Stimme, Format, Tempo, Text);
// eine geaenderte Einstellung trifft so nie altes Audio. Fehler werden nie
// gecacht.
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const _cache = new Map(); // key -> { buf, mime }
let _cacheBytes = 0;
function _cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  _cache.delete(key);
  _cache.set(key, e);
  return e;
}
function _cachePut(key, entry) {
  if (_cache.has(key) || entry.buf.length > CACHE_MAX_BYTES / 8) return;
  _cache.set(key, entry);
  _cacheBytes += entry.buf.length;
  while (_cacheBytes > CACHE_MAX_BYTES && _cache.size) {
    const [k, v] = _cache.entries().next().value;
    _cache.delete(k);
    _cacheBytes -= v.buf.length;
  }
}
function clearAudioCache() { _cache.clear(); _cacheBytes = 0; }

// Typisierter Fehler, damit die Aufrufer den passenden HTTP-Status setzen.
class TtsError extends Error {
  constructor(code, status, extra) {
    super(code);
    this.code = code;
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

// Aktivierungs-Check + normalisierter Host (ohne trailing / und ohne /v1).
function resolveHost() {
  return String(appSettings.get('tts.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}
function isEnabled() {
  return appSettings.get('tts.enabled') === true && !!resolveHost();
}

// Atempausen (ms) fuer die browserseitige Abspiel-Schleife. Kein Secret (analog
// STT-VAD-Schwellen) — geht ans Frontend via /config bzw. Share-Config.
function pauseConfig() {
  const fragmentMs = Number(appSettings.get('tts.pause.fragment_ms'));
  const paragraphMs = Number(appSettings.get('tts.pause.paragraph_ms'));
  return {
    fragmentMs:  Number.isFinite(fragmentMs)  ? fragmentMs  : 250,
    paragraphMs: Number.isFinite(paragraphMs) ? paragraphMs : 550,
  };
}

// Stimme locale-aware aufloesen: ist fuer den Sprachcode (`de`, `en`, …) eine
// Stimme gesetzt (tts.voice.<lang>), gewinnt sie; sonst die Standard-Stimme
// (tts.voice). `lang` ist der bereits auf den Sprachcode reduzierte Wert
// (de-CH -> de); leer -> Default.
function resolveVoice(lang) {
  const code = String(lang || '').split('-')[0].trim().toLowerCase();
  const localeVoice = code ? String(appSettings.get(`tts.voice.${code}`) || '').trim() : '';
  return localeVoice || String(appSettings.get('tts.voice') || '').trim();
}

// Einen Satz/Absatz synthetisieren. Wirft TtsError bei disabled/no-text/too-large
// bzw. Upstream-Fehler/Timeout. Bei Erfolg: { buf: Buffer, mime, bytes, latency,
// cached } — `cached` = aus dem Audio-Cache, kein Upstream-Call.
async function synthesizeSpeech({ text, lang }) {
  if (!isEnabled()) throw new TtsError('tts_disabled', 404);
  const host = resolveHost();

  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) throw new TtsError('tts_no_text', 400);
  if (raw.length > TEXT_MAX) throw new TtsError('tts_text_too_large', 413, { max: TEXT_MAX });

  const model = String(appSettings.get('tts.model') || '').trim();
  const voice = resolveVoice(lang);
  const fmtRaw = String(appSettings.get('tts.format') || 'mp3').trim().toLowerCase();
  const format = FORMAT_MIME[fmtRaw] ? fmtRaw : 'mp3';
  const speedRaw = Number(appSettings.get('tts.speed'));
  const speed = Number.isFinite(speedRaw) ? speedRaw : 1;
  const apiKey = String(appSettings.get('tts.api_key') || '').trim();

  const payload = { model, input: trimmed, response_format: format, speed };
  if (voice) payload.voice = voice;

  const cacheKey = crypto.createHash('sha256')
    .update(JSON.stringify([host, model, voice, format, speed, trimmed])).digest('hex');
  const hit = _cacheGet(cacheKey);
  if (hit) return { buf: hit.buf, mime: hit.mime, bytes: hit.buf.length, latency: 0, cached: true };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const upstream = await fetch(`${host}/v1/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      throw new TtsError('tts_upstream', 502, { upstream_status: upstream.status, latency: Date.now() - t0 });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const mime = FORMAT_MIME[format];
    if (buf.length) _cachePut(cacheKey, { buf, mime });
    return { buf, mime, bytes: buf.length, latency: Date.now() - t0, cached: false };
  } catch (err) {
    if (err instanceof TtsError) throw err;
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    throw new TtsError(isAbort ? 'tts_timeout' : 'tts_upstream', isAbort ? 408 : 502, {
      latency: Date.now() - t0,
      cause: err?.message,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  TtsError,
  TEXT_MAX,
  isEnabled,
  resolveHost,
  resolveVoice,
  pauseConfig,
  synthesizeSpeech,
  clearAudioCache,
};
