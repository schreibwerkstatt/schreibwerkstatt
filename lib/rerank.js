'use strict';
// Reranker-Client (self-hosted, OpenAI/Jina-kompatibler /v1/rerank-Endpunkt,
// z.B. LocalAI, HuggingFace TEI). Cross-Encoder-Nachordnung der Freitext-
// Kandidaten aus der semantischen Suche: bewertet (query, document)-Paare direkt
// statt über Vektor-Distanz → schärfere Relevanz als die Retrieval-Stufe allein.
// Reiner Netz-Adapter wie lib/embed.js — keine Prompt-/JSON-Logik. Host/Model/Key
// kommen aus app_settings (rerank.*) und verlassen den Server nie. Konsument:
// lib/semantic-retrieval.js. Fällt der Endpunkt aus, greift dort still die RRF-/
// Cosinus-Reihenfolge (non-fatal, wie veraPDF beim PDF-Export) — ausser für
// Aufrufer, die `strictRerank` verlangen (speichernde Anker-Jobs).

const appSettings = require('./app-settings');
const logger = require('../logger');
const { fetchWithTimeout, withRetry } = require('./http-util');

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

// Retry bei transienten Backend-Aussetzern (Netz-Blip, Neustart, 429/5xx).
// Nicht-transiente Fehler (HTTP 4xx ausser 429, echter Job-Cancel) werfen sofort.
function _withRetry(fn, { retries = MAX_RETRIES, baseMs = RETRY_BASE_MS, signal, label = '' } = {}) {
  return withRetry(fn, {
    retries, baseMs, signal,
    onRetry: (e, n) => logger.warn(`Rerank-Retry ${n}/${retries}${label ? ` (${label})` : ''}: ${e.message}`),
  });
}

// Reranking setzt aktivierte semantische Suche voraus (es ordnet deren Kandidaten
// nach) — ohne Embedding-Index gibt es nichts zu reranken.
function isEnabled() {
  const embed = require('./embed');
  return !!appSettings.get('rerank.enabled')
    && !!String(appSettings.get('rerank.host') || '').trim()
    && embed.isEnabled();
}

function getConfig() {
  return {
    host: String(appSettings.get('rerank.host') || '').trim().replace(/\/$/, ''),
    model: String(appSettings.get('rerank.model') || 'bge-reranker-v2-m3').trim(),
    apiKey: String(appSettings.get('rerank.api_key') || '').trim(),
    timeoutMs: parseInt(appSettings.get('rerank.timeout_ms'), 10) || 30000,
    topN: parseInt(appSettings.get('rerank.top_n'), 10) || 30,
    minScore: Number(appSettings.get('rerank.min_score')) || 0,
    batchSize: parseInt(appSettings.get('rerank.batch_size'), 10) || 32,
  };
}

// Parst die /v1/rerank-Antwort (Jina/Cohere-Schema) → [{ index, score }]
// absteigend. Akzeptiert `results` oder `data`; Score aus `relevance_score` oder
// `score`; `index` verweist auf die Dokument-Position (nicht die Array-Position).
// Ungültige/ausserhalb-des-Bereichs liegende Indizes werden verworfen (defensiv
// gegen fehlerhafte Backends), Duplikate auf denselben Index ebenfalls.
function _parseRerankResponse(json, nDocs) {
  const results = Array.isArray(json?.results) ? json.results
    : Array.isArray(json?.data) ? json.data
    : null;
  if (!results) throw new Error('Rerank-Antwort ohne results-Array.');
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const ix = Number.isInteger(r?.index) ? r.index : null;
    if (ix == null || ix < 0 || ix >= nDocs || seen.has(ix)) continue;
    const score = typeof r.relevance_score === 'number' ? r.relevance_score
      : typeof r.score === 'number' ? r.score
      : null;
    if (score == null || !Number.isFinite(score)) continue;
    seen.add(ix);
    out.push({ index: ix, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function _post(host, model, apiKey, timeoutMs, query, documents, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let resp;
  try {
    resp = await fetchWithTimeout(`${host}/v1/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, query, documents }),
      signal,
    }, timeoutMs);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    const err = new Error(`Rerank-Endpunkt nicht erreichbar (${host}): ${e.message}`);
    err.retriable = true;
    throw err;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Rerank-Endpunkt HTTP ${resp.status}: ${body.slice(0, 300)}`);
    err.retriable = resp.status === 429 || resp.status >= 500;
    throw err;
  }
  const json = await resp.json();
  return _parseRerankResponse(json, documents.length);
}

// Teilt documents in Pakete zu höchstens batchSize, bewertet sie nacheinander
// über postBatch(slice) → [{ index, score }] (index relativ zum Paket) und führt
// sie zu einer absteigenden Liste mit globalen Indizes zusammen. Backends wie
// HuggingFace TEI weisen Anfragen über ihrer max-client-batch-size mit 422 ab,
// unabhängig von rerank.top_n. Ein Cross-Encoder bewertet jedes (Anfrage,
// Dokument)-Paar für sich — Scores verschiedener Pakete sind direkt vergleichbar.
// Nacheinander statt parallel: das Backend teilt sich die GPU mit Embeddings.
async function _rerankBatched(documents, batchSize, postBatch) {
  const size = Math.max(1, batchSize | 0);
  const out = [];
  for (let off = 0; off < documents.length; off += size) {
    const part = await postBatch(documents.slice(off, off + size));
    for (const r of part) out.push({ index: r.index + off, score: r.score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Circuit-Breaker: ist der Endpunkt nach allen Retries weiterhin transient weg
// (Host down, Proxy liefert 5xx), scheitert jeder weitere Aufruf für
// BREAKER_COOLDOWN_MS sofort, statt erneut die volle Retry-Kette zu laufen.
// Ein Anker-Job mit 90 Anfragen verbrannte sonst ~20 s je Anfrage, bloss um
// 90-mal denselben Ausfall festzustellen. Nach Ablauf probiert der nächste
// Aufruf den Endpunkt wieder; ein Erfolg schliesst den Breaker.
const BREAKER_COOLDOWN_MS = 60_000;
let _openUntil = 0;
// Test-Stellschraube: Unit-Tests verkürzen das Retry-Backoff, statt Sekunden zu warten.
const _testing = { retryBaseMs: RETRY_BASE_MS };

function _breakerOpenError() {
  const err = new Error(`Reranker nach Ausfall pausiert (noch ${Math.ceil((_openUntil - Date.now()) / 1000)} s).`);
  err.rerankDown = true;
  err.breakerOpen = true;
  return err;
}

// Rerankt documents gegen query → [{ index, score }] absteigend. Leere Eingabe
// → []. Grosse Pools gehen in Paketen zu rerank.batch_size raus. Wirft bei
// hartem Backend-Fehler in irgendeinem Paket (Aufrufer fängt und fällt auf die
// Retrieval-Reihenfolge zurück). Ein Ausfall des Endpunkts trägt `rerankDown`.
async function rerank(query, documents, { signal } = {}) {
  if (!isEnabled()) throw new Error('Reranker nicht konfiguriert (rerank.enabled/host).');
  const docs = Array.isArray(documents) ? documents : [];
  if (!docs.length) return [];
  if (Date.now() < _openUntil) throw _breakerOpenError();
  const { host, model, apiKey, timeoutMs, batchSize } = getConfig();
  const clean = docs.map(d => String(d == null ? '' : d));
  const q = String(query == null ? '' : query);
  try {
    const out = await _rerankBatched(clean, batchSize, part => _withRetry(
      () => _post(host, model, apiKey, timeoutMs, q, part, signal),
      { signal, baseMs: _testing.retryBaseMs, label: `${part.length} docs` },
    ));
    _openUntil = 0;
    return out;
  } catch (e) {
    if (e?.retriable && !(signal && signal.aborted)) {
      _openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      e.rerankDown = true;
    }
    throw e;
  }
}

function _resetBreaker() { _openUntil = 0; }

module.exports = {
  isEnabled, getConfig, rerank, _parseRerankResponse, _withRetry, _rerankBatched,
  _resetBreaker, _testing,
};
