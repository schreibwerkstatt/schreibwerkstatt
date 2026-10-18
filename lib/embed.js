'use strict';
// Embedding-Client (self-hosted, OpenAI-kompatibler /v1/embeddings-Endpunkt,
// z.B. LocalAI). Reiner Netz-Adapter — keine Prompt-/JSON-Logik wie lib/ai.js,
// Embeddings sind blosse Zahlenvektoren. Host/Model/Key kommen aus app_settings
// (embed.*) und verlassen den Server nie. Konsumenten: der Index-Job
// (routes/jobs/embed-index.js) und der Semantik-Query-Pfad (routes/search.js).

const appSettings = require('./app-settings');
const logger = require('../logger');
const { fetchWithTimeout, withRetry } = require('./http-util');

// Grösster Rohbatch pro HTTP-Call. LocalAI/llama.cpp nehmen Arrays; zu grosse
// Batches sprengen das Server-Kontextfenster. Der Job chunkt oberhalb weiter.
// Bewusst klein, nicht auf Durchsatz "optimieren": der Prod-Endpunkt (bge-m3 auf
// einer einzelnen GPU) schafft ~1,4 Texte/s, und der nächtliche Cron lässt bis zu
// jobs.max_concurrent embed-index-Jobs parallel auf dasselbe Backend los. 8 Texte
// ≈ 6 s pro Call; selbst hinter 11 wartenden Calls (12 × 8 / 1,4 ≈ 70 s) bleibt
// einer klar unter embed.timeout_ms (Prod 180 s). Mit 32 Texten dauerte ein Call
// 35–72 s, riss den Timeout, und die Retries erhöhten die Last zusätzlich.
const MAX_BATCH = 8;

// Retry bei transienten Backend-Aussetzern (Netz-Blip, Neustart, 429/5xx). Ein
// grosser Index besteht aus vielen HTTP-Calls — ohne Retry reisst ein einziger
// Blip den ganzen Job ab. Lineare Backoffs (1×, 2×, 3× base). Nicht-transiente
// Fehler (HTTP 4xx ausser 429, echter Job-Cancel) werfen sofort ohne Retry.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

// Ruft fn() mit Retry auf, solange der Fehler als transient markiert ist
// (err.retriable) und noch Versuche offen sind. Job-Cancel (signal) bricht sofort
// ab. Exportiert für Unit-Tests (retries/baseMs injizierbar).
function _withRetry(fn, { retries = MAX_RETRIES, baseMs = RETRY_BASE_MS, signal, label = '' } = {}) {
  return withRetry(fn, {
    retries, baseMs, signal,
    onRetry: (e, n) => logger.warn(`Embedding-Retry ${n}/${retries}${label ? ` (${label})` : ''}: ${e.message}`),
  });
}

// Entfernt einzelne (halbe) UTF-16-Surrogate. HTML→Text-Extraktion und das
// zeichenbasierte Chunking (lib/embed-chunk.js) können ein Emoji-Surrogatpaar
// (z.B. 🙈 = 🙈) an der Chunk-Grenze zerteilen. JSON.stringify
// serialisiert die verbleibende Hälfte als \udXXX-Escape, das der Embedding-
// Endpunkt (Python/UTF-8, z.B. LiteLLM) nicht kodieren kann → HTTP 500 und der
// ganze Index-Job stirbt. \p{Surrogate} matcht mit u-Flag ausschliesslich
// einzelne Surrogate — gültige Paare zählen als ein astrales Codepoint und
// bleiben erhalten.
function _stripLoneSurrogates(s) {
  return s.replace(/\p{Surrogate}/gu, '');
}

function isEnabled() {
  return !!appSettings.get('embed.enabled') && !!String(appSettings.get('embed.host') || '').trim();
}

function getConfig() {
  return {
    host: String(appSettings.get('embed.host') || '').trim().replace(/\/$/, ''),
    model: String(appSettings.get('embed.model') || 'bge-m3').trim(),
    dim: parseInt(appSettings.get('embed.dim'), 10) || 1024,
    apiKey: String(appSettings.get('embed.api_key') || '').trim(),
    timeoutMs: parseInt(appSettings.get('embed.timeout_ms'), 10) || 60000,
    // Instruction-Präfixe für asymmetrische Modelle (e5 &co). Leer bei bge-m3.
    queryPrefix: String(appSettings.get('embed.query_prefix') || ''),
    passagePrefix: String(appSettings.get('embed.passage_prefix') || ''),
  };
}

async function _postBatch(host, model, apiKey, timeoutMs, input, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let resp;
  try {
    resp = await fetchWithTimeout(`${host}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input }),
      signal,
    }, timeoutMs);
  } catch (e) {
    if (signal && signal.aborted) throw e; // echter Abbruch (Job-Cancel)
    // Netz-Ebene (fetch failed / DNS / Reset) oder Timeout → transient, Retry.
    const err = new Error(`Embedding-Endpunkt nicht erreichbar (${host}): ${e.message}`);
    err.retriable = true;
    throw err;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Embedding-Endpunkt HTTP ${resp.status}: ${body.slice(0, 300)}`);
    // 429/5xx sind transient (Überlast/Neustart), 4xx nicht (Bad Request bleibt Bad Request).
    err.retriable = resp.status === 429 || resp.status >= 500;
    throw err;
  }
  const json = await resp.json();
  const data = Array.isArray(json?.data) ? json.data : null;
  if (!data || data.length !== input.length) {
    // Unvollständige Antwort → Backend unter Last, nächster Versuch kann klappen.
    const err = new Error(`Embedding-Antwort unvollständig: erwartet ${input.length}, erhalten ${data ? data.length : 0}`);
    err.retriable = true;
    throw err;
  }
  // OpenAI-Kontrakt: data[].index gibt die Zuordnung, nicht die Array-Position.
  const out = new Array(input.length);
  for (const row of data) {
    const ix = Number.isInteger(row.index) ? row.index : data.indexOf(row);
    const emb = row?.embedding;
    if (!Array.isArray(emb) || !emb.length) throw new Error('Embedding-Antwort ohne Vektor.');
    out[ix] = Float32Array.from(emb);
  }
  return out;
}

// Embeddet ein Array von Strings → Array von Float32Array (gleiche Reihenfolge).
// Ein einzelner String wird als [string] behandelt. Batcht intern auf MAX_BATCH.
async function embedBatch(texts, { signal } = {}) {
  if (!isEnabled()) throw new Error('Embedding-Backend nicht konfiguriert (embed.enabled/host).');
  const arr = Array.isArray(texts) ? texts : [texts];
  if (!arr.length) return [];
  const { host, model, apiKey, timeoutMs } = getConfig();
  if (!host) throw new Error('embed.host nicht gesetzt.');

  const result = [];
  for (let i = 0; i < arr.length; i += MAX_BATCH) {
    const slice = arr.slice(i, i + MAX_BATCH).map(s => _stripLoneSurrogates(String(s == null ? '' : s)));
    const vecs = await _withRetry(
      () => _postBatch(host, model, apiKey, timeoutMs, slice, signal),
      { signal, label: `${slice.length} texts` },
    );
    result.push(...vecs);
  }
  return result;
}

// Einzeltext → Float32Array (roh, ohne Präfix). Für Passagen/Chunks; der Index-
// Job hängt den passage_prefix selbst an (er muss ihn in den Chunk-Hash falten).
async function embedOne(text, opts) {
  const [v] = await embedBatch([text], opts);
  return v;
}

// Query-Pfad → Float32Array MIT vorangestelltem query_prefix (asymmetrische
// Modelle wie e5). Bei leerem Präfix (bge-m3-Default) identisch zu embedOne.
// Alle Query-seitigen Aufrufer (Suche, Buch-Chat-Tool, Kontinuitäts-Fallback)
// nutzen dies, damit Query- und Passage-Vektoren im selben Raum liegen.
async function embedQuery(text, opts) {
  const { queryPrefix } = getConfig();
  const input = queryPrefix ? queryPrefix + String(text == null ? '' : text) : text;
  return embedOne(input, opts);
}

module.exports = { isEnabled, getConfig, embedBatch, embedOne, embedQuery, MAX_BATCH, _withRetry, _stripLoneSurrogates };
