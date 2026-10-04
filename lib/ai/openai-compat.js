'use strict';
// OpenAI-kompatibler Provider (/v1/chat/completions, SSE): llama.cpp/vLLM/LiteLLM/
// OpenAI. Optionaler Bearer-Token, response_format json_schema (strict) für
// Grammar-Constrained Decoding, chat_template_kwargs zum Unterdrücken von Thinking.
// Zweiter Modus: Function-Calling (`tools`) für den agentischen Buch-Chat — dann
// KEIN response_format (das drängt das Modell in eine JSON-Antwort statt in einen
// Tool-Aufruf) und die Antwort kommt als `tool_calls` zurück. Übersetzung in die
// kanonische Anthropic-Form: lib/ai/tool-translate.js.

const appSettings = require('../app-settings');
const logger = require('../../logger');
const {
  getContextConfigFor, jobOverride,
  openaiCompatTemp, openaiCompatThink, openaiCompatRepeatPenalty,
} = require('./config');
const {
  MAX_OUTPUT_RATIO, _connErrorCode, _unreachableError,
  estimatePromptTokens, assertPromptFitsContext,
  combineSignals, timeoutError, parseRetryAfter, overloadError, withOverloadRetry,
} = require('./shared');
const { aiSetting, aiApiKey, usesOwnAccess } = require('./profile');
const { safeFetch } = require('../ssrf-guard');
const { toolsToOpenAI, messagesToOpenAI, toolCallsToCanonical, salvageTextToolCalls } = require('./tool-translate');

// Transiente HTTP-Antworten eines OpenAI-kompatiblen Endpunkts. 429 = Rate-Limit,
// 408 = Request-Timeout, 5xx = Server ueberlastet/neu gestartet (vLLM/LiteLLM/OpenAI
// liefern 502/503/504 waehrend eines Modell-Reloads). Deterministische Fehler (400
// Kontext zu gross, 401 Key falsch, 404 Modell unbekannt) sind bewusst NICHT dabei —
// sie mit Backoff zu wiederholen verzoegert nur die Fehlermeldung.
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
function _retryMaxAttempts() {
  return parseInt(appSettings.get('ai.openai-compat.retry_max'), 10) || 3;
}

// Hard-Timeout pro Call. Ohne ihn haelt ein stummer Endpunkt (haengender Stream,
// gehosteter Anbieter im Ausfall) den Job-Slot unbegrenzt — der Job-Worker sieht
// weder Fehler noch Fortschritt. Per-Job-Override (Komplettanalyse) > Instanz-Setting
// > 10 Minuten, gleiche Kette wie bei Claude.
function _timeoutMs() {
  return Number(jobOverride('openai-compat', 'timeoutMs'))
    || parseInt(appSettings.get('ai.openai-compat.timeout_ms'), 10) || 600000;
}

/** Retry-Schleife um `_callOpenAICompatAttempt`. Wiederholt wird NUR, was vor dem
 *  ersten Delta scheitert (HTTP-Status) — ein mitten im Stream abgerissener Call
 *  haette bereits Text emittiert und wuerde beim zweiten Versuch doppelt zaehlen;
 *  den Fall faengt der transiente Retry der Job-Schicht ab
 *  (routes/jobs/shared/ai.js#retryOnTransientAi). */
function _callOpenAICompat(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride, tools) {
  return withOverloadRetry(
    () => _callOpenAICompatAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride, tools),
    { label: 'OpenAI-kompatibel transient', maxAttempts: _retryMaxAttempts(), signal },
  );
}

/** Fehler-Chunk im SSE-Stream (`data: {"error":{…}}`) → Error mit der Server-Meldung.
 *  llama.cpp/vLLM/LiteLLM melden so z.B. einen Kontext-Ueberlauf oder Modell-Absturz
 *  mitten im Stream; ohne den Check endete der Call still mit leerem Text. */
function _streamChunkError(chunk) {
  if (!chunk || chunk.error == null) return null;
  const e = chunk.error;
  const msg = typeof e === 'string' ? e : (e.message || e.type || JSON.stringify(e));
  const err = new Error(`OpenAI-kompatibel Stream-Fehler: ${msg}`);
  if (typeof e === 'object' && e.code != null) err.status = Number(e.code) || null;
  return err;
}

/** Tool-Use-Variante von `_callOpenAICompat` (Signatur wie `_callClaudeWithTools`).
 *  Liefert zusätzlich `toolUses` / `stopReason` / `rawContentBlocks` in kanonischer
 *  Anthropic-Form, damit routes/jobs/agentic-chat.js provider-neutral bleibt. */
async function _callOpenAICompatWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  return _callOpenAICompat(messages, systemPrompt, onProgress, maxTokensOverride, signal, null, undefined, tools);
}

async function _callOpenAICompatAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride, tools) {
  const host = String(aiSetting('openai-compat', 'host') || 'http://localhost:8080').replace(/\/$/, '');
  // Per-Job-Modell (Komplettanalyse) vor Profil-/Instanz-Modell — dieselbe Kette wie
  // _resolveClaudeModel; erlaubt ein staerkeres Analyse-Modell neben dem Alltags-Modell.
  const model = jobOverride('openai-compat', 'model') || aiSetting('openai-compat', 'model') || 'llama3.2';
  const cfg = getContextConfigFor('openai-compat');
  const globalMax = cfg.maxTokensOut;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const temperature = openaiCompatTemp(temperatureOverride);
  // Optionaler Bearer-Token: gehostete OpenAI-kompatible Endpoints (vLLM, LiteLLM,
  // OpenAI selbst) verlangen ihn; lokale llama.cpp-Server brauchen ihn meist nicht.
  // Leer = kein Authorization-Header. Profil-Key vor globalem Key — zwei Endpunkte
  // desselben Providers haben in aller Regel verschiedene Zugaenge.
  const apiKey = String(aiApiKey('openai-compat') || '').trim();
  const withTools = Array.isArray(tools) && tools.length > 0;
  const allMessages = [];
  if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
  // Im Tool-Modus tragen die Messages Content-Blöcke (tool_use/tool_result) in
  // kanonischer Anthropic-Form — hier in die OpenAI-Form übersetzen.
  allMessages.push(...(withTools ? messagesToOpenAI(messages) : messages));

  // response_format:
  //   - Mit Schema: json_schema strict:true → GBNF-Grammar-Constrained Decoding. Erzwingt
  //     schema-konforme Struktur UND korrekt escapete Strings (fixt den «unescaped `"`»-Bug,
  //     den mistral-small3.2 im json_object-Modus produziert).
  //   - Ohne Schema: json_object als Fallback-Hint (nicht grammar-erzwungen).
  //   - Im Tool-Modus: GAR KEINS. Ein erzwungenes JSON-Objekt kollidiert mit dem
  //     Function-Calling — das Modell schreibt dann eine JSON-Antwort, statt ein
  //     Werkzeug zu rufen. Die Struktur der Endantwort erzwingt dort das
  //     `final_answer`-Werkzeug.
  const responseFormat = withTools
    ? null
    : (jsonSchema
      ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: jsonSchema } }
      : { type: 'json_object' });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const reqBody = {
    model,
    messages: allMessages,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    max_tokens: maxTokens,
    repeat_penalty: openaiCompatRepeatPenalty(),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(withTools ? { tools: toolsToOpenAI(tools), tool_choice: 'auto' } : {}),
  };
  // Reasoning unterdrücken: vLLM/SGLang/llama.cpp reichen `chat_template_kwargs`
  // an die Jinja-Chat-Vorlage durch; bei Qwen3 & Co schaltet `enable_thinking:false`
  // die <think>-Spur ab. Server ohne dieses Kwarg ignorieren es folgenlos. Bei
  // think=true gar nicht senden (Modell-Default; echtes OpenAI bleibt nutzbar).
  if (!openaiCompatThink()) {
    reqBody.chat_template_kwargs = { enable_thinking: false };
  }

  // Preflight VOR dem fetch: nicht alle Pfade laufen ueber routes/jobs/shared/ai.js#aiCall
  // (callAIChat aus den Chat-Jobs geht direkt hier durch). Ohne den Guard antwortet
  // llama.cpp/vLLM mit „OpenAI-kompatibel 400: <Server-Text>" und niemand sieht, dass
  // der Prompt schlicht zu gross war. i18n-Aufloesung passiert weiter oben (failJob).
  // Tool-Schemas wandern in JEDER Iteration mit in den Prompt (lokale Provider haben
  // kein Prompt-Caching) — beim Fenster-Preflight also mitzählen, sonst unterschätzt
  // er den Prompt um die Grösse des Werkzeugkatalogs. estimatePromptTokens sieht
  // ausserdem weder `tool_calls` noch `tool_call_id`, darum im Tool-Modus über die
  // serialisierte Request-Form schätzen.
  const estimatedTokIn = withTools
    ? Math.ceil(JSON.stringify({ m: allMessages, t: reqBody.tools }).length / (cfg.charsPerToken || 4))
    : estimatePromptTokens(allMessages, cfg.charsPerToken);
  assertPromptFitsContext({ provider: 'openai-compat', cfg, maxTokensOut: maxTokens, estTokIn: estimatedTokIn });

  // Hard-Timeout ueber den ganzen Call (fetch UND Stream); User-Cancel bleibt aktiv.
  // `signalState.timedOut` trennt Timeout von Abbruch — beides kommt sonst als
  // AbortError an und der Job-Catch verbuchte einen haengenden Server als User-Abbruch.
  const timeoutMs = _timeoutMs();
  const { signal: combinedSignal, cleanup, state: signalState } = combineSignals(signal, timeoutMs, 'OpenAI-kompatibel');
  try {
  let resp;
  try {
    const url = `${host}/v1/chat/completions`;
    const init = { method: 'POST', headers, body: JSON.stringify(reqBody), signal: combinedSignal };
    if (usesOwnAccess()) {
      // Eigener Zugang: der Host kommt vom User → SSRF-Guard (lib/ssrf-guard.js).
      // Keine Redirects (ein Chat-Completions-Endpunkt leitet nicht um), Body
      // ungelesen, damit der Stream unten wie gewohnt laeuft; der Timeout bleibt
      // der des combinedSignal.
      ({ response: resp } = await safeFetch(url, {
        ...init, timeoutMs: timeoutMs + 1000, maxRedirects: 0, readBody: false,
      }));
    } else {
      resp = await fetch(url, init);
    }
  } catch (fetchErr) {
    if (signalState.timedOut) throw timeoutError('OpenAI-kompatibel', timeoutMs);
    if (fetchErr.name === 'AbortError') throw fetchErr;
    if (/^SSRF_|^FETCH_REDIRECT/.test(String(fetchErr.code || ''))) {
      const err = new Error('error.AI_OWN_HOST_BLOCKED');
      err.i18nParams = { host };
      err.code = 'AI_OWN_HOST_BLOCKED';
      throw err;
    }
    if (_connErrorCode(fetchErr)) throw _unreachableError('openai-compat', host, fetchErr);
    const cause = fetchErr.cause?.message || fetchErr.cause?.code || '';
    throw new Error(`OpenAI-kompatibel fetch fehlgeschlagen (${host}): ${fetchErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    if (RETRY_STATUS.has(resp.status)) {
      throw overloadError('OpenAI-kompatibel', resp.status, parseRetryAfter(resp),
        `OpenAI-kompatibel ${resp.status}: ${detail.slice(0, 300)}`);
    }
    const err = new Error(`OpenAI-kompatibel ${resp.status}: ${detail || resp.statusText}`);
    // Endpunkt/Modell kann kein Function-Calling: als eigener Code melden, damit der
    // Buch-Chat auf den klassischen Pfad zurückfallen kann statt den Job zu verlieren
    // (routes/jobs/agentic-chat.js#fallbackJob).
    if (withTools && (resp.status === 400 || resp.status === 404 || resp.status === 422)
        && /tool|function/i.test(detail || '')) {
      err.code = 'AI_TOOLS_UNSUPPORTED';
    }
    throw err;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  // Runaway-Schaetzung mit dem Zeichen/Token-Verhaeltnis DIESES Providers
  // (Profil/Instanz), nicht dem globalen Claude-Wert.
  const cpt = cfg.charsPerToken || 4;
  let buf = '', text = '', tokensIn = 0, tokensOut = 0, truncated = false;
  let t_first = 0, t_last = 0;
  // Ausgabe neben `text`: Werkzeug-Argumente (Plot-/Ideen-Chat antworten fast ganz
  // über final_answer/propose_*) und Reasoning. Beides zählt in completion_tokens —
  // ohne usage-Chunk schätzt der Fallback sonst nur den Text und landet bei ~0.
  let toolArgChars = 0, reasoningChars = 0;
  // Tool-Call-Akkumulator: `delta.tool_calls[]` liefert Name und Argument-JSON
  // stückweise. Adressiert wird über `index`; Endpunkte, die keinen mitschicken,
  // werden über die `id` bzw. die Auftrittsreihenfolge einsortiert.
  const toolCallAcc = [];
  const _estimateOut = () => Math.ceil((text.length + toolArgChars + reasoningChars) / cpt);
  // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife) — in Text
  // wie in Werkzeug-Argumenten. Reasoning bleibt draussen: eine lange Denkspur zu
  // einer kurzen Frage ist kein Durchdrehen.
  const _runaway = () => {
    const estOut = Math.ceil((text.length + toolArgChars) / cpt);
    if (estOut <= MAX_OUTPUT_RATIO * estimatedTokIn) return false;
    logger.warn(`OpenAI-kompatibel Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
    truncated = true;
    reader.cancel();
    return true;
  };
  let finishReason = null;
  const _slotFor = (tc, seen) => {
    if (Number.isInteger(tc.index)) return tc.index;
    if (tc.id) {
      const hit = toolCallAcc.findIndex(a => a && a.id === tc.id);
      if (hit >= 0) return hit;
    }
    return seen;
  };
  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(raw); }
      catch (e) {
        logger.debug?.(`OpenAI-kompatibel Chunk-Parse-Fehler: ${e.message} — Line: ${line.slice(0, 120)}`);
        continue;
      }
      const chunkErr = _streamChunkError(chunk);
      if (chunkErr) { chunkErr._fromStream = true; throw chunkErr; }
      const delta = chunk.choices?.[0]?.delta?.content || '';
      // Reasoning-Deltas (vLLM/llama.cpp: reasoning_content, OpenRouter: reasoning)
      // zaehlen in completion_tokens mit → gehoeren ins Generierungsfenster, sonst
      // teilt tok/s Denk- plus Text-Tokens durch die reine Textzeit.
      const rDelta = chunk.choices?.[0]?.delta;
      const rText = rDelta?.reasoning_content || rDelta?.reasoning;
      if (typeof rText === 'string') reasoningChars += rText.length;
      if (!delta && rText) {
        if (!t_first) t_first = Date.now();
        t_last = Date.now();
      }
      if (delta) {
        const now = Date.now();
        if (!t_first) t_first = now;
        t_last = now;
        text += delta;
        // tokIn live als Schätzung durchreichen, sonst bleibt die Input-Anzeige
        // während des Streamings bei 0 (openai-compat meldet prompt_tokens erst
        // in der finalen usage-Chunk). Der echte Wert überschreibt sie unten.
        if (onProgress) onProgress({ chars: text.length + toolArgChars, tokIn: estimatedTokIn, delta });
        if (_runaway()) break;
      }
      const deltaCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(deltaCalls)) {
        for (let i = 0; i < deltaCalls.length; i++) {
          const tc = deltaCalls[i];
          if (!tc) continue;
          const slot = _slotFor(tc, toolCallAcc.length + i);
          const acc = toolCallAcc[slot] || (toolCallAcc[slot] = { id: null, name: '', arguments: '' });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') {
            acc.arguments += tc.function.arguments;
            toolArgChars += tc.function.arguments.length;
          }
          if (!t_first) t_first = Date.now();
          t_last = Date.now();
        }
        if (onProgress) onProgress({ chars: text.length + toolArgChars, tokIn: estimatedTokIn });
        if (_runaway()) break;
      }
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;
      if (fr === 'length') truncated = true;
      if (chunk.usage) {
        tokensIn  = chunk.usage.prompt_tokens     || estimatedTokIn;
        tokensOut = chunk.usage.completion_tokens || _estimateOut();
        if (onProgress) onProgress({ chars: text.length + toolArgChars, tokIn: tokensIn });
      }
    }
    if (truncated) break;
  }
  } catch (streamErr) {
    if (streamErr._fromStream) { reader.cancel().catch(() => {}); delete streamErr._fromStream; throw streamErr; }
    if (signalState.timedOut) throw timeoutError('OpenAI-kompatibel', timeoutMs);
    if (streamErr.name === 'AbortError') throw streamErr;
    if (_connErrorCode(streamErr)) throw _unreachableError('openai-compat', host, streamErr);
    const cause = streamErr.cause?.message || streamErr.cause?.code || '';
    throw new Error(`OpenAI-kompatibel Stream-Abbruch (${host}): ${streamErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!tokensIn)  tokensIn  = estimatedTokIn;
  if (!tokensOut) tokensOut = _estimateOut();
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  const base = { text, truncated, tokensIn, tokensOut, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0, genDurationMs, provider: 'openai-compat', model };
  if (!withTools) return base;

  const calls = toolCallAcc.filter(Boolean);
  let canonical = toolCallsToCanonical(text, calls);
  // Rettung: Modell hat den Aufruf als TEXT geschrieben statt als tool_calls (Chat-
  // Vorlage ohne Tool-Protokoll). Ohne sie wäre das JSON-Fragment die «Antwort».
  if (!calls.length) {
    const salvaged = salvageTextToolCalls(text, tools.map(t => t.name));
    if (salvaged) {
      logger.warn(`OpenAI-kompatibel: Tool-Aufruf kam als Text (${salvaged.toolUses.map(t => t.name).join(', ')}) – gerettet.`);
      canonical = salvaged;
    }
  }
  // stopReason aus dem TATSÄCHLICHEN Inhalt ableiten, nicht aus finish_reason: viele
  // Endpunkte melden 'stop', obwohl tool_calls im Delta standen. Der Loop entscheidet
  // daran, ob er weiterarbeitet — eine falsche Angabe beendet die Recherche zu früh.
  const stopReason = canonical.toolUses.length
    ? 'tool_use'
    : (truncated || finishReason === 'length' ? 'max_tokens' : 'end_turn');
  return { ...base, text: canonical.rawContentBlocks.find(b => b.type === 'text')?.text ?? '', ...canonical, stopReason };
  } finally {
    cleanup();
  }
}

module.exports = { _callOpenAICompat, _callOpenAICompatWithTools, _streamChunkError };
