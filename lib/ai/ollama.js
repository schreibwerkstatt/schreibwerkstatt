'use strict';
// Ollama-Provider: streamt /api/chat (NDJSON), dynamisches num_ctx aus Input-
// Schätzung + Output-Limit, optionales Grammar-Constrained JSON via `format`.

const logger = require('../../logger');
const appSettings = require('../app-settings');
const {
  getContextConfigFor,
  ollamaTemp, ollamaThink, ollamaRepeatPenalty,
} = require('./config');
const {
  MAX_OUTPUT_RATIO, _connErrorCode, _unreachableError,
  estimatePromptTokens, assertPromptFitsContext, combineSignals, timeoutError, providerError, httpError,
} = require('./shared');
const { aiSetting } = require('./profile');

// Hard-Timeout pro Call (fetch + Stream). Instanz-Setting, kein Profil-Overlay:
// der Ollama-Mutex ist global, ein haengender Call blockiert jeden Nachfolger.
function _timeoutMs() {
  return parseInt(appSettings.get('ai.ollama.timeout_ms'), 10) || 1800000;
}

/** Fehler-Chunk im NDJSON-Stream (`{"error":"…"}`, z.B. Modell nicht geladen,
 *  Kontext zu gross). Ohne diesen Check endete der Stream still mit leerem Text. */
function _streamChunkError(chunk) {
  if (!chunk || chunk.error == null) return null;
  const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message || JSON.stringify(chunk.error));
  return providerError('job.error.aiStreamError', { provider: 'Ollama', detail: msg, log: true });
}

async function _callOllama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride) {
    const host = String(aiSetting('ollama', 'host') || 'http://localhost:11434').replace(/\/$/, '');
    const model = aiSetting('ollama', 'model') || 'llama3.2';
    const ollamaCfg = getContextConfigFor('ollama');
    const globalMax = ollamaCfg.maxTokensOut;
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    const temperature = ollamaTemp(temperatureOverride);
    const allMessages = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...messages);

    // Dient als Untergrenze – Ollama meldet bei KV-Cache-Treffer 0 oder nur User-Tokens.
    const estimatedTokIn = estimatePromptTokens(allMessages, ollamaCfg.charsPerToken);
    // Preflight VOR dem fetch: nicht alle Pfade laufen ueber routes/jobs/shared/ai.js#aiCall
    // (callAIChat aus den Chat-Jobs geht direkt hier durch). Ohne den Guard klemmt das
    // num_ctx unten still auf contextWindow und Ollama schneidet den Prompt-Anfang ab —
    // der Job laeuft weiter und analysiert weniger Buch, als er behauptet.
    // i18n-Aufloesung passiert weiter oben (failJob).
    assertPromptFitsContext({ provider: 'ollama', cfg: ollamaCfg, maxTokensOut: maxTokens, estTokIn: estimatedTokIn });
    // num_ctx: Gesamtkontextfenster (Input + Output) – dynamisch aus Input-Schätzung + Output-Limit,
    // begrenzt durch das in app_settings konfigurierte native Modellfenster (`ai.ollama.context_window`).
    // Fester Wert wäre bei grossen Prompts zu klein und würde Input stillschweigend kürzen.
    // +1000 als Sicherheitspuffer.
    const num_ctx = Math.min(estimatedTokIn + maxTokens + 1000, ollamaCfg.contextWindow);
    // format: JSON-Schema-Objekt (strikt) oder 'json' (permissiv). Schema erzwingt via GBNF-Grammatik
    //   nicht nur gültiges JSON sondern auch korrekt escapete Strings und schema-konforme Felder –
    //   verhindert die «unescaped `"` im String»-Klasse von Bugs, die mistral-small3.2 regelmässig
    //   produziert. Fallback 'json' (ohne Schema) ist nur hint-basiert.
    const fmt = jsonSchema || 'json';
    const cpt = ollamaCfg.charsPerToken || 4;
    const timeoutMs = _timeoutMs();
    const { signal: combinedSignal, cleanup, state: signalState } = combineSignals(signal, timeoutMs, 'Ollama');
    try {
    let resp;
    try {
      resp = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: allMessages, stream: true, format: fmt, think: ollamaThink(), options: { num_ctx, num_predict: maxTokens, temperature, repeat_penalty: ollamaRepeatPenalty() } }),
        signal: combinedSignal,
      });
    } catch (fetchErr) {
      if (signalState.timedOut) throw timeoutError('Ollama', timeoutMs);
      if (fetchErr.name === 'AbortError') throw fetchErr;
      if (_connErrorCode(fetchErr)) throw _unreachableError('ollama', host, fetchErr);
      throw providerError('job.error.aiRequestFailed', { provider: 'Ollama', detail: `${host}: ${fetchErr.message}`, cause: fetchErr, log: true });
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw httpError('Ollama', resp.status, detail || resp.statusText);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0, truncated = false, genDurationMs = null;
    let sawDone = false, incomplete = false;
    while (true) {
      let chunkRead;
      try { chunkRead = await reader.read(); }
      catch (streamErr) {
        if (signalState.timedOut) throw timeoutError('Ollama', timeoutMs);
        throw streamErr;
      }
      const { done, value } = chunkRead;
      if (done) {
        // Stream-Ende ohne finalen `done`-Chunk: die Verbindung riss ab, die Antwort
        // ist unvollständig. Als truncated melden, damit der Aufrufer wirft, statt ein
        // jsonrepair-Teilstück als vollständige Antwort zu verbuchen.
        if (!sawDone && !truncated) {
          logger.warn(`Ollama-Stream ohne Abschluss-Chunk beendet (${text.length} Zeichen) – als unvollständig gewertet.`);
          truncated = true;
          incomplete = true;
        }
        break;
      }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk;
        try { chunk = JSON.parse(line); }
        catch (e) {
          // Malformed NDJSON-Line: nicht abbrechen (Ollama emittiert manchmal
          // Partial-Lines am Stream-Ende), aber bei Debug-Level loggen, damit
          // Token-Drops sichtbar werden.
          logger.debug?.(`Ollama Chunk-Parse-Fehler: ${e.message} — Line: ${line.slice(0, 120)}`);
          continue;
        }
        const chunkErr = _streamChunkError(chunk);
        if (chunkErr) { reader.cancel().catch(() => {}); throw chunkErr; }
        if (chunk.done) {
          sawDone = true;
          // Echten prompt_eval_count bevorzugen; nur bei vollständigem Cache-Hit
          // (prompt_eval_count=0) Fallback auf Schätzung, damit die Anzeige nicht 0 wird.
          // Vorher: Math.max(real, estimate) führte zu Überzählen, wenn die Schätzung
          // (CHARS_PER_TOKEN=3) zu pessimistisch war – die DB speicherte dann z.B. 128k,
          // obwohl das Modell 98k echte Tokens meldete.
          tokensIn = chunk.prompt_eval_count && chunk.prompt_eval_count > 0
            ? chunk.prompt_eval_count
            : estimatedTokIn;
          tokensOut = chunk.eval_count || 0;
          if (chunk.done_reason === 'length') truncated = true;
          if (chunk.eval_duration) genDurationMs = Math.round(chunk.eval_duration / 1e6);
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
        } else {
          const delta = chunk.message?.content || '';
          text += delta;
          // tokIn live als Schätzung durchreichen, sonst bleibt die Input-Anzeige
          // während des Streamings bei 0 (Ollama meldet prompt_eval_count erst in
          // der finalen done-Chunk). Der echte Wert überschreibt sie unten.
          if (onProgress) onProgress({ chars: text.length, tokIn: estimatedTokIn, delta });
          // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife)
          const estOut = Math.ceil(text.length / cpt);
          if (estOut > MAX_OUTPUT_RATIO * estimatedTokIn) {
            logger.warn(`Ollama Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
            truncated = true;
            reader.cancel();
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (!tokensIn) tokensIn = estimatedTokIn;
    if (!tokensOut) tokensOut = Math.ceil(text.length / cpt);
    return { text, truncated, ...(incomplete ? { incomplete: true } : {}), tokensIn, tokensOut, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0, genDurationMs, provider: 'ollama', model };
    } finally {
      cleanup();
    }
}

module.exports = { _callOllama, _streamChunkError };
