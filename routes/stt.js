'use strict';
// Speech-to-Text-Proxy (self-hosted).
// Frontend nimmt im Notebook-Editor an Sprechpausen (browserseitiges VAD) ein
// Audiosegment auf und POSTet es an /stt/transcribe; Server holt Host/Model/
// Key aus app_settings und forwarded an einen OpenAI-kompatiblen Whisper-
// Endpunkt `${host}/v1/audio/transcriptions`. Credentials/Host verlassen den
// Server nie.
//
// Sync-Proxy-Ausnahme zur Job-Queue-Regel (analog routes/languagetool.js):
// kurzer Request/Response-Transkriptionscall, kein KI-Analysejob, kein
// Token-Budget, kein callAI. STT transkribiert 1:1 — keine generative KI.
//
// Disabled / no-Host -> 404 { error: 'stt_disabled' } (Frontend behandelt als
// "Feature aus", Button ist ohnehin nicht im DOM).
//
// Audio kommt als rohes Binary (express.raw) mit dem MediaRecorder-Mime im
// Content-Type — keine Multipart-Dep noetig. Server baut daraus die Multipart-
// FormData an den Whisper-Endpunkt (file mit korrekter Extension, model,
// language). Audio wird nur durchgereicht, nie persistiert, nie geloggt
// (nur Metadaten: Segmentgroesse, Latenz, Upstream-Status, bei Upstream-
// Fehlern die gekuerzte Fehlermeldung des Upstreams).
//
// Kontext: der Client schickt im Header `X-Stt-Prompt` (URI-kodiert) den Text
// links vom Einfuegepunkt; er geht als Whisper-`prompt` mit, damit das Modell
// Schreibweise und Zeichensetzung des bestehenden Textes fortsetzt. Wiederholt
// Whisper bei einem stillen Segment nur den Prompt, wird das als `echo`
// verworfen. Region CH/LI: ß -> ss (Whisper kennt nur "de" und schreibt
// bundesdeutsch).
//
// Upstream-Fehler: transient (5xx, 408/425/429) -> 502 STT_UPSTREAM, der
// Client wiederholt. Dauerhaft (uebrige 4xx: unbekanntes Modell, Key ohne
// Recht, kaputte Anfrage) -> 424 STT_UPSTREAM_REJECTED, der Client wiederholt
// NICHT — ein Konfigurationsfehler verschwindet nicht durch Warten.

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { getBookLocale } = require('../db/schema');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();

const PROMPT_MAX_CHARS = 200;
const ECHO_MIN_CHARS = 12;
const ESZETT_REGIONS = new Set(['ch', 'li']);

// Kontext-Prompt aus dem Header: dekodiert, einzeilig, auf die letzten
// PROMPT_MAX_CHARS Zeichen ab einer Wortgrenze gekuerzt (Whisper nutzt ohnehin
// nur das Ende eines langen Prompts).
function readPrompt(req) {
  const raw = req.headers['x-stt-prompt'];
  if (typeof raw !== 'string' || !raw) return '';
  let text;
  try { text = decodeURIComponent(raw); } catch { return ''; }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= PROMPT_MAX_CHARS) return text;
  const tail = text.slice(-PROMPT_MAX_CHARS);
  const cut = tail.indexOf(' ');
  return cut >= 0 ? tail.slice(cut + 1) : tail;
}

function foldForEcho(s) {
  // ß und ss gleichsetzen: Prompt (Schweizer Buch: ss) und Whisper-Antwort (ß)
  // schreiben dasselbe Wort verschieden.
  return String(s).toLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Whisper wiederholt bei stillen/unklaren Segmenten gern den Prompt (oder
// dessen letzten Satz). Ein Transkript, das vollstaendig im Prompt steht, ist
// darum keine Sprache. Erst ab ECHO_MIN_CHARS — ein kurzes „und dann" darf
// natuerlich mehrfach vorkommen.
function isPromptEcho(text, prompt) {
  if (!prompt) return false;
  const t = foldForEcho(text);
  return t.length >= ECHO_MIN_CHARS && foldForEcho(prompt).includes(t);
}

function swissSpelling(text) {
  return text.replace(/ß/g, 'ss').replace(/ẞ/g, 'SS');
}

const UPSTREAM_TRANSIENT = new Set([408, 425, 429]);
const UPSTREAM_ERR_MAX_CHARS = 300;

// Fehlertext des Upstreams fuers Log: einzeilig, gekuerzt. Ohne ihn steht im
// App-Log nur der Status, und die Ursache (z. B. LiteLLM "Invalid model name")
// ist nur im Upstream-Container zu finden.
async function upstreamErrorText(res) {
  const raw = await res.text().catch(() => '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > UPSTREAM_ERR_MAX_CHARS ? `${flat.slice(0, UPSTREAM_ERR_MAX_CHARS)}…` : flat;
}
const AUDIO_MAX = 5 * 1024 * 1024; // 5 MB — kurze VAD-Segmente
const UPSTREAM_TIMEOUT_DEFAULT_MS = 30_000;
const UPSTREAM_TIMEOUT_MIN_MS = 5_000;
const UPSTREAM_TIMEOUT_MAX_MS = 120_000;

// Upstream-Timeout aus App-Setting (self-hosted tunebar). Grosszuegig genug,
// damit ein GPU-Cold-Start (Modell-Reload nach Idle) nicht als Timeout das
// Segment verliert. Geclampt gegen Fehlkonfiguration.
function upstreamTimeoutMs() {
  const v = Number(appSettings.get('stt.upstream_timeout_ms'));
  if (!Number.isFinite(v)) return UPSTREAM_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(v, UPSTREAM_TIMEOUT_MIN_MS), UPSTREAM_TIMEOUT_MAX_MS);
}

// Whitelist erlaubter Audio-Mimes → Datei-Extension fuer den Forward. Der
// ffmpeg-basierte Whisper-Endpunkt dekodiert anhand der Extension/Mime.
const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg':  'ogg',
  'audio/mp4':  'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac':  'aac',
  'audio/wav':  'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
};

// Content-Type kann Codec-Parameter tragen ("audio/webm;codecs=opus") — nur
// den Basis-Mime fuer die Whitelist heranziehen.
function baseMime(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

const rawAudioBody = express.raw({ type: ['audio/*', 'application/octet-stream'], limit: AUDIO_MAX + 1 });

router.post('/transcribe', rawAudioBody, async (req, res) => {
  const enabled = appSettings.get('stt.enabled') === true;
  const host = String(appSettings.get('stt.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!enabled || !host) {
    return res.status(404).json({ error_code: 'STT_DISABLED', error: 'stt_disabled' });
  }

  const bookId = toIntId(req.query.bookId);
  const pageId = toIntId(req.query.pageId);
  if (bookId) setContext({ book: bookId });
  const userEmail = sessionEmail(req);
  const mime = baseMime(req.headers['content-type']);
  const log = logger.child({ job: 'stt', user: userEmail || '-', book: bookId || '-' });
  const ctx = `page=${pageId || '-'} mime=${mime || '-'} bytes=${Buffer.isBuffer(req.body) ? req.body.length : 0}`;

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    log.warn(`reject no-audio ${ctx}`);
    return res.status(400).json({ error_code: 'STT_NO_AUDIO', error: 'stt_no_audio' });
  }
  if (req.body.length > AUDIO_MAX) {
    log.warn(`reject too-large ${ctx} max=${AUDIO_MAX}`);
    return res.status(413).json({ error_code: 'STT_AUDIO_TOO_LARGE', error: 'stt_audio_too_large', max: AUDIO_MAX });
  }

  const ext = MIME_EXT[mime];
  if (!ext) {
    log.warn(`reject unsupported-mime ${ctx}`);
    return res.status(415).json({ error_code: 'STT_UNSUPPORTED_AUDIO', error: 'stt_unsupported_audio' });
  }

  // Book ist SSoT fuer Locale: bookId vorhanden -> getBookLocale gewinnt.
  // stt.language nur Fallback (Aufrufe ohne Buchscope). Whisper erwartet einen
  // ISO-639-1-Code (de/en), keine Region — Locale wie "de-CH" auf "de" kuerzen;
  // die Region entscheidet nur noch ueber die ß->ss-Umschrift.
  let locale = '';
  if (bookId) {
    try { locale = getBookLocale(bookId, userEmail) || ''; } catch { /* noop */ }
  }
  if (!locale) locale = String(appSettings.get('stt.language') || '');
  const [language = '', region = ''] = locale.trim().toLowerCase().split('-');
  const swiss = language === 'de' && ESZETT_REGIONS.has(region);
  const rawPrompt = readPrompt(req);
  const prompt = swiss ? swissSpelling(rawPrompt) : rawPrompt;

  const model = String(appSettings.get('stt.model') || '').trim();
  const apiKey = String(appSettings.get('stt.api_key') || '').trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), upstreamTimeoutMs());
  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([req.body], { type: mime }), `segment.${ext}`);
    if (model) form.append('model', model);
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);
    form.append('response_format', 'json');
    // Sampling-Temperatur (App-Setting, Default 0 = deterministisch, weniger
    // Halluzinationen bei stillen/unklaren Segmenten).
    const temperature = Number(appSettings.get('stt.temperature'));
    form.append('temperature', String(Number.isFinite(temperature) ? temperature : 0));

    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    const upstream = await fetch(`${host}/v1/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      const status = upstream.status;
      const detail = await upstreamErrorText(upstream);
      log.warn(`upstream ${status} ${ctx} model=${model || '-'} latency=${Date.now() - t0}ms${detail ? ` body=${detail}` : ''}`);
      const permanent = status >= 400 && status < 500 && !UPSTREAM_TRANSIENT.has(status);
      return permanent
        ? res.status(424).json({ error_code: 'STT_UPSTREAM_REJECTED', error: 'stt_upstream_rejected', upstream_status: status })
        : res.status(502).json({ error_code: 'STT_UPSTREAM', error: 'stt_upstream', upstream_status: status });
    }
    const json = await upstream.json().catch(() => null);
    let text = typeof json?.text === 'string' ? json.text : '';
    const echo = isPromptEcho(text, prompt);
    if (echo) text = '';
    else if (swiss) text = swissSpelling(text);
    // Leeres Resultat (Stille/VAD-Fehltrigger/Whisper-Guard) und Prompt-Echo als
    // eigene Marker — sonst nicht von einem echten Treffer unterscheidbar.
    const kind = echo ? 'echo' : (text.length ? 'ok' : 'empty');
    log.info(`${kind} ${ctx} lang=${language || '-'}${swiss ? '-ch' : ''} prompt=${prompt.length} chars=${text.length} ${Date.now() - t0}ms`);
    return res.json({ text });
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    log.warn(`fetch ${isAbort ? 'TIMEOUT' : err.message} ${ctx} latency=${Date.now() - t0}ms`);
    return res.status(isAbort ? 408 : 502).json(isAbort
      ? { error_code: 'STT_TIMEOUT', error: 'stt_timeout' }
      : { error_code: 'STT_UPSTREAM', error: 'stt_upstream' });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
