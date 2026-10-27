'use strict';
// Claude-Provider (Anthropic Messages API): Streaming-Calls (Text + Tool-Use),
// Prompt-Caching-Blocks, Retry/Backoff bei Overload/Rate-Limit, Timeout-Signal,
// Modell-spezifische Sampling/Thinking/Effort-Parameter (aus config.js).

const appSettings = require('../app-settings');
const logger = require('../../logger');
const {
  _resolveClaudeModel, _resolveClaudeContextWindow, _resolveClaudeMaxOut, _claudeModelMaxOut,
  _claudeSamplingParams, _claudeThinkingParams, _claudeToolThinkingParams, _claudeOutputConfigParams,
  _claudeSupportsStructuredOutputs, _claudeSupportsRefusalFallback, jobOverride,
} = require('./config');
const { startBlock, applyDelta, stopBlock, finalizeBlocks, progressNote } = require('./claude-tool-blocks');
const {
  normalizeTier, combineSignals, timeoutError, withOverloadRetry,
  parseRetryAfter: _parseRetryAfter, overloadError, providerError, httpError,
} = require('./shared');
const { aiApiKey } = require('./profile');

// Claude-API liefert 529 (Overloaded) und 429 (Rate-Limit) als transiente Fehler. Beide
// retryen mit Exponential-Backoff (1s/2s/4s + Jitter). Stream-`overloaded_error` retried
// nur, wenn noch kein Text/Block emittiert wurde (sonst würde Output dupliziert).
// 503 mit `error.type === 'overloaded_error'` (z. B. "API key validation is temporarily
// unavailable") ist ebenfalls transient – Detection nicht über Status, sondern über
// den Body-Typ (siehe `_isOverloadedBody`).
const RETRY_STATUS = new Set([429, 529]);
function _retryMaxAttempts() {
  return parseInt(appSettings.get('ai.claude.retry_max'), 10) || 3;
}

function _isOverloadedBody(rawText) {
  if (!rawText) return false;
  try {
    const parsed = JSON.parse(rawText);
    return parsed?.error?.type === 'overloaded_error';
  } catch {
    return false;
  }
}

const _overloadError = (status, retryAfterSec, message) =>
  overloadError('Claude', status, retryAfterSec, message);

// Hard-Timeout pro Claude-Call. Schützt gegen hängende Streams (z.B. wenn die
// Anthropic-API die Verbindung stumm hält). User-Cancel (signal) bleibt zusätzlich aktiv.
// Per-Job-Override aus dem ALS-Bag (`aiJob.timeoutMs`, siehe config.js#jobOverride) >
// globaler ai.claude.timeout_ms > Default. Die Komplettanalyse setzt den Override, weil
// Opus langsamer ist und der Single-Pass mehrere grosse Calls macht – analog zu
// Modell/Kontext/Output.
function _claudeTimeoutMs() {
  return Number(jobOverride('claude', 'timeoutMs'))
    || parseInt(appSettings.get('ai.claude.timeout_ms'), 10) || 600000;
}

// Beta-Feature-Header für Claude. Das 1M-Kontextfenster (Input > 200K Tokens)
// ist hinter dem `context-1m-2025-08-07`-Beta gated; ohne ihn lehnt die API
// Requests mit context_window > 200K ab. Greift automatisch, sobald
// ai.claude.context_window > 200000 gesetzt ist (Sonnet 4.x und Opus 4.6+ tragen 1M).
function _claudeBetaHeader(extra = []) {
  const betas = ['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11'];
  if (_resolveClaudeContextWindow() > 200000) betas.push('context-1m-2025-08-07');
  return [...betas, ...extra].join(',');
}

/**
 * Baut Claude-system-Blocks aus String oder Array.
 * String  → ein cache_control-Block (5-min-TTL, Default-Verhalten).
 * Array   → je Eintrag ein Block; {text, ttl?} – ttl:'1h' nutzt den Extended-TTL-Beta.
 *           Mehrere Blöcke = mehrere Cache-Breakpoints (z.B. [Buchtext(1h), Phase-System(5min)]).
 */
function _buildClaudeSystemBlocks(systemPrompt) {
  if (!systemPrompt) return null;
  if (typeof systemPrompt === 'string') {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  if (Array.isArray(systemPrompt) && systemPrompt.length > 0) {
    return systemPrompt.map(b => {
      // cache:false → volatiler Block OHNE Breakpoint (z.B. die pro Query neu
      // keyword-selektierten Buchseiten im klassischen Buch-Chat). Ein Breakpoint
      // hier wäre ein cache_write, der nie gelesen wird, weil der Block jede Runde
      // andere Bytes trägt. Der Block muss am Ende des Arrays stehen (Präfix-Match).
      if (b.cache === false) return { type: 'text', text: b.text };
      return {
        type: 'text',
        text: b.text,
        cache_control: b.ttl === '1h'
          ? { type: 'ephemeral', ttl: '1h' }
          : { type: 'ephemeral' },
      };
    });
  }
  return null;
}

// Multi-Turn-Caching für den Tool-Use-Loop: setzt einen Cache-Breakpoint auf den
// letzten Content-Block der letzten Nachricht. Pro Iteration wächst die Message-Liste
// (assistant tool_use + user tool_result); ohne Breakpoint wird die ganze History
// jede Runde voll bezahlt. Mit Breakpoint liest Iteration N+1 den Präfix bis Iteration N
// aus dem Cache (Render-Order tools→system→messages). Klont nur die betroffenen
// Nachrichten — die Original-`messages` (vom Loop wiederverwendet + persistiert)
// bleiben unangetastet. String-Content wird in einen text-Block mit cache_control
// gewandelt.
//
// Zusätzlich darf der Aufrufer einzelne Nachrichten mit `cacheBreakpoint: true`
// markieren (Buch-Chat: Ende der Historie vor der aktuellen Frage — damit liest der
// NÄCHSTE Turn Werkzeuge + System + Verlauf aus dem Cache, obwohl seine Frage samt
// Erst-Kontext neu ist). Die Markierung ist kein API-Feld und wird immer entfernt;
// gesetzt wird sie nur, solange `maxBreakpoints` (4 minus System-Breakpoints) reicht —
// von hinten nach vorn, die letzte Nachricht hat Vorrang. `ttl` '1h' für Chats, deren
// Turns weiter als fünf Minuten auseinanderliegen (Abschnitts-Chat); die System-Blöcke
// davor müssen dann ebenfalls 1h tragen (keine längere TTL hinter einer kürzeren).
function _withBlockBreakpoint(msg, cc) {
  if (typeof msg.content === 'string') {
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: cc }] };
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const blocks = msg.content.slice();
    const bi = blocks.length - 1;
    blocks[bi] = { ...blocks[bi], cache_control: cc };
    return { ...msg, content: blocks };
  }
  return msg;
}

function _withMessageCacheBreakpoints(messages, maxBreakpoints = 1, ttl = null) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const cc = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const last = messages.length - 1;
  const marked = new Set(maxBreakpoints > 0 ? [last] : []);
  for (let i = last - 1; i >= 0 && marked.size < maxBreakpoints; i--) {
    if (messages[i]?.cacheBreakpoint) marked.add(i);
  }
  return messages.map((m, i) => {
    let msg = m;
    if (m && Object.prototype.hasOwnProperty.call(m, 'cacheBreakpoint')) {
      const { cacheBreakpoint: _drop, ...rest } = m;
      msg = rest;
    }
    return marked.has(i) && msg ? _withBlockBreakpoint(msg, cc) : msg;
  });
}

// Anthropic erlaubt höchstens vier cache_control-Breakpoints pro Request.
const MAX_CACHE_BREAKPOINTS = 4;
function _systemBreakpointCount(sysBlocks) {
  return Array.isArray(sysBlocks) ? sysBlocks.filter(b => b.cache_control).length : 0;
}

// Geteilter 1h-Präfix: der vorderste System-Block ist ausdrücklich als solcher markiert
// (`{ sharedPrefix: true, ttl: '1h' }` — Buch-/Kapiteltext-Block der Komplettanalyse,
// den viele Pässe mit je eigenem Schema lesen) → KEIN output_config.format.
// Structured Outputs gehören zum Cache-Präfix — ein anderes Schema je Pass bricht den
// Cache, und jeder Pass schreibt den ganzen Block neu (1h-Write = 2× Input-Preis; in
// der Komplettanalyse ~13 Buch-Writes pro Lauf statt einem). JSON erzwingt dort der
// Systemprompt (JSON_ONLY + Schema-Text); das Schema bleibt am Call für andere
// Provider (Grammar) und für die Pflichtfeld-Prüfung des Aufrufers.
// Bewusst eine Markierung statt «erster Block ist 1h»: die `SYSTEM_*_BLOCKS` mit
// Autorenkontext beginnen auch mit einem 1h-Block, ihre Calls (Lektorat, Review …)
// behalten Structured Outputs.
function _isSharedPrefixSystem(systemPrompt) {
  const first = Array.isArray(systemPrompt) ? systemPrompt[0] : null;
  return !!(first && first.sharedPrefix && first.ttl === '1h');
}

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

// Technische Fehlermeldung inkl. Ursache (undici: «fetch failed» – ECONNRESET) fürs Log/Detail.
function _errText(e) {
  const cause = e?.cause?.code || e?.cause?.message || '';
  return `${e?.message || e}${cause ? ` – ${cause}` : ''}`;
}

/**
 * Ein Claude-Streaming-Request als Event-Iterator: POST, HTTP-Fehler-Klassifikation,
 * SSE-Zeilen → geparste Events. Hard-Timeout (`combineSignals`) deckt fetch UND
 * Stream; ein Timeout — auch mitten im `reader.read()` — wirft `AI_TIMEOUT`
 * (transient, `routes/jobs/shared/ai.js#_isTransientAiError`), ein User-Abbruch
 * bleibt AbortError. `sentFormat`: Structured-Output-Format wurde mitgeschickt →
 * eine 400 mit Schema-Hinweis wird zu `AI_STRUCTURED_OUTPUT_UNSUPPORTED`.
 * `error`-Events reicht der Iterator durch — ob ein Stream-Overload retrybar ist,
 * haengt am bereits emittierten Inhalt und entscheidet darum der Reducer.
 */
async function* _claudeStreamEvents(body, signal, { sentFormat = false, betas = [], sentFallback = false } = {}) {
  const timeoutMs = _claudeTimeoutMs();
  const { signal: combinedSignal, cleanup, state: signalState } = combineSignals(signal, timeoutMs, 'Claude');
  try {
    let resp;
    try {
      resp = await fetch(CLAUDE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': aiApiKey('claude'),
          'anthropic-version': '2023-06-01',
          'anthropic-beta': _claudeBetaHeader(betas),
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (e) {
      if (signalState.timedOut) throw timeoutError('Claude', timeoutMs);
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      throw providerError('job.error.aiRequestFailed', { provider: 'Claude', detail: _errText(e), cause: e, log: true });
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      if (RETRY_STATUS.has(resp.status) || _isOverloadedBody(detail)) {
        const ra = _parseRetryAfter(resp);
        throw _overloadError(resp.status, ra, `Claude ${resp.status}: ${detail.slice(0, 300)}`);
      }
      // Structured-Output-Ablehnung (nur wenn wir format tatsächlich gesendet haben):
      // eigener Code, damit _callClaude einmalig ohne output_config.format retryt statt
      // den Job non-retryable zu killen. Nur bei 400 + einschlägigem Body-Hinweis.
      if (resp.status === 400 && sentFormat && /output_config|json_schema|\bschema\b|\bformat\b/i.test(detail)) {
        const err = new Error(`Claude 400 (structured output): ${detail.slice(0, 200)}`);
        err.code = 'AI_STRUCTURED_OUTPUT_UNSUPPORTED';
        throw err;
      }
      // Refusal-Fallback abgelehnt (Beta für den Account nicht frei, Modell nicht
      // zugelassen): eigener Code, _callClaudeWithTools wiederholt einmal ohne.
      if (resp.status === 400 && sentFallback && /fallback/i.test(detail)) {
        const err = new Error(`Claude 400 (fallbacks): ${detail.slice(0, 200)}`);
        err.code = 'AI_FALLBACK_UNSUPPORTED';
        throw err;
      }
      throw httpError('Claude', resp.status, detail || resp.statusText);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (e) {
        if (signalState.timedOut) throw timeoutError('Claude', timeoutMs);
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        // Verbindung mitten in der Antwort abgerissen («terminated»): transient
        // (routes/jobs/shared/ai.js#_isTransientAiError), der Original-Fehler bleibt `cause`.
        const err = providerError('job.error.aiStreamInterrupted', { provider: 'Claude', detail: _errText(e), cause: e, log: true });
        err.code = 'AI_STREAM_INTERRUPTED';
        throw err;
      }
      if (chunk.done) return;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') return;
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
        yield ev;
      }
    }
  } finally {
    cleanup();
  }
}

/** Stream-`error`-Event → Fehler. Overload ist nur retrybar, solange noch nichts
 *  emittiert wurde (`emitted === false`), sonst wuerde Output dupliziert. */
function _streamError(ev, emitted) {
  if (ev.error?.type === 'overloaded_error' && !emitted) {
    return _overloadError(null, null, `Claude Stream-Fehler: overloaded_error – ${ev.error?.message || ''}`);
  }
  return providerError('job.error.aiStreamError', { provider: 'Claude', detail: `${ev.error?.type} – ${ev.error?.message}`, log: true });
}

/** Usage + Stop-Grund + Generierungsdauer, gemeinsam fuer Text- und Tool-Pfad.
 *  `onEvent` liefert 'usage', wenn message_start die Input-Tokens gesetzt hat.
 *  Das Generierungsfenster umfasst JEDES content_block_*-Event (Thinking, Text,
 *  Tool-Input, Signatur): `output_tokens` zaehlt die Denk-Tokens mit, und bei
 *  display:'omitted' streamt der Denk-Block nur Start + signature_delta. Ein Fenster
 *  nur ueber text_delta teilte Denk- plus Text-Tokens durch die reine Textzeit und
 *  blaeht tok/s auf. */
function _makeUsageAcc() {
  return {
    tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0,
    truncated: false, stopReason: null, stopDetails: null, servedModel: null, t_first: 0, t_last: 0, stopped: false,
    onEvent(ev) {
      if (typeof ev.type === 'string' && ev.type.startsWith('content_block_')) this.markOutput();
      // Bedienendes Modell: nach einem Refusal-Fallback vor dem ersten Output nennt
      // message_start schon das Ersatzmodell (Kosten laufen zu dessen Preisen).
      if (ev.type === 'message_start' && ev.message?.model) this.servedModel = ev.message.model;
      if (ev.type === 'message_start' && ev.message?.usage) {
        const u = ev.message.usage;
        this.cacheCreationIn = u.cache_creation_input_tokens || 0;
        // 1h-TTL-Writes kosten 2x statt 1.25x (5min) — Anteil separat fuer costUsd.
        // cacheCreationIn bleibt das TTL-uebergreifende Total (Anzeige-Kompatibilitaet).
        this.cacheCreation1hIn = u.cache_creation?.ephemeral_1h_input_tokens || 0;
        this.cacheReadIn = u.cache_read_input_tokens || 0;
        this.tokensIn = (u.input_tokens || 0) + this.cacheCreationIn + this.cacheReadIn;
        return 'usage';
      }
      if (ev.type === 'message_stop') this.stopped = true;
      if (ev.type === 'message_delta') {
        if (ev.usage?.output_tokens != null) this.tokensOut = ev.usage.output_tokens;
        if (ev.delta?.stop_reason) this.stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_details) this.stopDetails = ev.delta.stop_details;
        if (ev.delta?.stop_reason === 'max_tokens') this.truncated = true;
      }
      return null;
    },
    markOutput() {
      const now = Date.now();
      if (!this.t_first) this.t_first = now;
      this.t_last = now;
    },
    result() {
      const { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, stopReason, stopDetails, servedModel, t_first, t_last } = this;
      let { truncated } = this;
      // Stream ohne Endmarke (weder stop_reason im message_delta noch message_stop):
      // die Verbindung endete vor dem Abschluss der Antwort. Als truncated melden,
      // damit der Aufrufer wirft, statt ein jsonrepair-Teilstück zu verbuchen.
      const incomplete = !stopReason && !this.stopped;
      if (incomplete && !truncated) {
        logger.warn(`Claude-Stream ohne Endmarke beendet (out=${tokensOut}) – als unvollständig gewertet.`);
        truncated = true;
      }
      const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
      return { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, truncated, ...(incomplete ? { incomplete: true } : {}), stopReason, stopDetails, servedModel, genDurationMs };
    },
  };
}

// cacheLastMessage: setzt einen Cache-Breakpoint auf die letzte Message und auf
// mit `cacheBreakpoint` markierte frühere (_withMessageCacheBreakpoints); `true` mit
// 5-min-TTL, `'1h'` mit 1h-TTL. Nur sinnvoll für Multi-Turn-Chats mit
// über die Turns STABILEM System-Prompt (Seiten-Chat) — dann liest Turn N+1 die
// bisherige Konversation aus dem Cache. Bei volatilem System (klassischer
// Buch-Chat: Seiten pro Query neu selektiert) bringt es nichts, weil eine
// System-Änderung den Messages-Cache ohnehin invalidiert.
// jsonSchema: optionales JSON-Schema. Bei unterstützten Modellen (Opus 4.7+/Sonnet 5/
// Fable/Haiku 4.5/Legacy-Opus, siehe _claudeSupportsStructuredOutputs) wird es als
// output_config.format = json_schema gesendet (Structured Outputs) → garantiert schema-
// valides JSON, kein Prosa-Leak durch adaptive Thinking, kein jsonrepair-Partial-Risiko.
// Lehnt die API es mit HTTP 400 ab (Schema-Grenzverletzung, Modell doch nicht unterstützt),
// wird der Call EINMALIG ohne output_config.format wiederholt statt den Job
// non-retryable zu killen. Der Fallback zählt nicht gegen das Overload-Budget.
// Refusal-Fallback (siehe _callClaudeWithTools): lehnt die API das Feld ab, laufen
// Text- und Werkzeug-Pfad bis zum Neustart ohne — eine nicht freigeschaltete Beta
// darf keinen Job kosten.
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
let _fallbackRejected = false;
function _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, jsonSchema) {
  let schema = jsonSchema || null;
  return withOverloadRetry(async () => {
    for (;;) {
      try {
        return await _callClaudeAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, schema, !_fallbackRejected);
      } catch (e) {
        if (e?.code === 'AI_FALLBACK_UNSUPPORTED' && !_fallbackRejected) {
          _fallbackRejected = true;
          logger.warn(`Claude Refusal-Fallback abgelehnt (${(e.message || '').slice(0, 160)}) – weiter ohne fallbacks bis zum Neustart.`);
          continue;
        }
        if (e?.code !== 'AI_STRUCTURED_OUTPUT_UNSUPPORTED' || !schema) throw e;
        schema = null;
        // Lang genug, dass die API-Meldung den abgelehnten Schema-Teil noch nennt.
        logger.warn(`Claude Structured-Output abgelehnt (${(e.message || '').slice(0, 600)}) – Retry ohne output_config.format.`);
      }
    }
  }, { label: 'Claude overload', maxAttempts: _retryMaxAttempts(), signal });
}

async function _callClaudeAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, jsonSchema, allowFallback = true) {
  // Per-Call-Tier (Modell + Effort), siehe normalizeTier in ./shared: die
  // Komplettanalyse routet Extraktion und Konsolidierung parallel auf verschiedene
  // Modelle/Denk-Tiefen, darum darf hier NICHTS aus dem geteilten ALS-Store gepatcht
  // werden. Ohne Tier bleibt es beim ALS-/Setting-Wert (unverändertes Verhalten).
  const { model: tierModel, effort: tierEffort } = normalizeTier(tier);
  const model = _resolveClaudeModel(tierModel);
  // Konfigurierten/Override-Output-Cap zusätzlich aufs harte Modell-Ceiling klemmen
  // (sonst HTTP 400 → non-retryable Job-Kill bei zu hoch gesetztem max_tokens_out).
  const globalMax = Math.min(_resolveClaudeMaxOut(), _claudeModelMaxOut(model));
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  // output_config kombiniert Effort (ai.claude.effort.* via ALS) und – bei unterstützten
  // Modellen mit Schema – Structured Outputs (format). Beide sind Geschwister-Keys.
  const sentFormat = !!(jsonSchema && _claudeSupportsStructuredOutputs(model)) && !_isSharedPrefixSystem(systemPrompt);
  const outputConfig = { ...(_claudeOutputConfigParams(model, tierEffort).output_config || {}) };
  if (sentFormat) outputConfig.format = { type: 'json_schema', schema: jsonSchema };
  const fallback = allowFallback && appSettings.get('ai.claude.refusal_fallback') !== false && _claudeSupportsRefusalFallback(model);
  const sysBlocks = _buildClaudeSystemBlocks(systemPrompt);
  const body = {
    model, max_tokens: maxTokens,
    ..._claudeSamplingParams(model),
    ..._claudeThinkingParams(model),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(fallback ? { fallbacks: 'default' } : {}),
    // Breakpoint auf die letzte Message plus — so viele die vier erlaubten neben den
    // System-Breakpoints hergeben — auf mit `cacheBreakpoint` markierte frühere
    // Messages (Abschnitts-Chat: Verlaufsende vor der Präambel-Frage, damit Turn
    // N+1 den Verlauf liest, obwohl die letzte Message jede Runde neu ist).
    messages: cacheLastMessage
      ? _withMessageCacheBreakpoints(messages, Math.max(1, MAX_CACHE_BREAKPOINTS - _systemBreakpointCount(sysBlocks)), cacheLastMessage === '1h' ? '1h' : null)
      : messages,
    stream: true,
  };
  if (sysBlocks) body.system = sysBlocks;

  const acc = _makeUsageAcc();
  let text = '';
  let fellBack = false;
  const betas = fallback ? [REFUSAL_FALLBACK_BETA] : [];
  for await (const ev of _claudeStreamEvents(body, signal, { sentFormat, betas, sentFallback: fallback })) {
    if (ev.type === 'error') throw _streamError(ev, text.length > 0);
    if (acc.onEvent(ev) === 'usage' && onProgress) onProgress({ chars: text.length, tokIn: acc.tokensIn });
    // Modellwechsel mitten in der Antwort: der `fallback`-Block markiert die Grenze, der
    // Text davor stammt vom ablehnenden Modell und ist kein Teil der JSON-Antwort.
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'fallback') {
      fellBack = true;
      text = '';
    }
    // Adaptives Denken streamt (display 'omitted') bis zum ersten Text nur Pings —
    // ohne dieses Signal sieht ein minutenlanger Denk-Block wie ein Hänger aus.
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
      if (onProgress) onProgress({ chars: text.length, tokIn: acc.tokensIn, thinking: true });
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const delta = ev.delta.text || '';
      text += delta;
      if (onProgress) onProgress({ chars: text.length, tokIn: acc.tokensIn, delta });
    }
  }
  const r = acc.result();
  const served = r.servedModel || model;
  if (fellBack || served !== model) {
    logger.warn(`Claude Refusal-Fallback: ${model} lehnte ab, ${served} hat übernommen${fellBack ? ' (mitten in der Antwort)' : ''}.`);
  }
  _logUnusualStop(r, served, text);
  return {
    text, truncated: r.truncated, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
    cacheReadIn: r.cacheReadIn, cacheCreationIn: r.cacheCreationIn, cacheCreation1hIn: r.cacheCreation1hIn,
    genDurationMs: r.genDurationMs, stopReason: r.stopReason, stopDetails: r.stopDetails, provider: 'claude', model: served,
  };
}

// Ein Text-Call, der nicht regulär endet, ist sonst nur an seiner Folge sichtbar
// (leeres JSON, fehlendes Pflichtfeld) — der Grund gehört ins Log, damit eine
// Ablehnung nicht als Parse-Fehler diagnostiziert wird.
function _logUnusualStop(r, model, text) {
  const reason = r.stopReason;
  if (reason === 'end_turn' && text) return;
  if (reason === 'max_tokens') return; // aiCall meldet die Truncation selbst
  const det = r.stopDetails ? ` ${JSON.stringify(r.stopDetails).slice(0, 300)}` : '';
  logger.warn(`Claude-Antwort ungewöhnlich beendet: stop_reason=${reason || '-'}, ${text.length} Zeichen Text, out=${r.tokensOut} (${model})${det}.`);
}

// ── Tool-Use (Anthropic Messages API) ──────────────────────────────────────
// Einzelner Round-Trip mit Tool-Use. Der Caller (Job-Runner) verwaltet den Loop:
// wenn stopReason === 'tool_use' muss er die Tools ausführen, Results als
// tool_result-Blocks an die messages anhängen und erneut aufrufen.
//
// Rückgabe:
//   { text, toolUses, stopReason, stopDetails, rawContentBlocks, tokensIn, tokensOut, genDurationMs, truncated, model }
//   - text: kumulierter Text aller text_delta-Blocks (kann leer sein bei reiner Tool-Antwort)
//   - toolUses: [{ id, name, input }] mit bereits geparstem input (Objekt)
//   - stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | 'refusal' | ...
//   - stopDetails: nur bei 'refusal' gefüllt ({ category, explanation }), sonst null
//   - rawContentBlocks: Blöcke für die nächste Runde (siehe claude-tool-blocks.js)
//   - model: bedienendes Modell (nach einem Refusal-Fallback das Ersatzmodell)
// onProgress({ chars, tokIn }) wie im Text-Pfad, zusätzlich ({ note }) mit dem
// Zwischenstand aus einer abgeschlossenen Thinking-Zusammenfassung.
// Lehnt die API den Refusal-Fallback ab (AI_FALLBACK_UNSUPPORTED), läuft der Call
// einmal ohne ihn — eine nicht freigeschaltete Beta darf keinen Chat kosten. Der
// Rückzug gilt bis zum Neustart des Prozesses (`_fallbackRejected`, oben).
function _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  return withOverloadRetry(async () => {
    try {
      return await _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal, !_fallbackRejected);
    } catch (e) {
      if (e?.code !== 'AI_FALLBACK_UNSUPPORTED') throw e;
      _fallbackRejected = true;
      logger.warn(`Claude Refusal-Fallback abgelehnt (${(e.message || '').slice(0, 160)}) – weiter ohne fallbacks bis zum Neustart.`);
      return await _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal, false);
    }
  }, { label: 'Claude overload', maxAttempts: _retryMaxAttempts(), signal });
}

// Werkzeug-Definitionen für den Request. `final_answer` trägt die ganze Antwort als
// Argument; ohne eager_input_streaming puffert die API es bis zum Schluss, und die
// Output-Anzeige stünde während der längsten Phase still. Das Argument wird beim
// content_block_stop strikt geparst (claude-tool-blocks.js#stopBlock) — ein kaputtes
// oder abgeschnittenes JSON wird `parseError`, nie eine still gekürzte Antwort.
function _claudeTools(tools) {
  return tools.map(t => (t && !t.type && t.name === 'final_answer' ? { ...t, eager_input_streaming: true } : t));
}


async function _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal, allowFallback = true) {
  const model = _resolveClaudeModel();
  // Output-Cap aufs harte Modell-Ceiling klemmen (siehe _callClaudeAttempt / _claudeModelMaxOut).
  const globalMax = Math.min(_resolveClaudeMaxOut(), _claudeModelMaxOut(model));
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const fallback = allowFallback && appSettings.get('ai.claude.refusal_fallback') !== false && _claudeSupportsRefusalFallback(model);
  const body = {
    model, max_tokens: maxTokens,
    ..._claudeSamplingParams(model),
    ..._claudeToolThinkingParams(model),
    ..._claudeOutputConfigParams(model),
    ...(fallback ? { fallbacks: 'default' } : {}),
    stream: true,
  };
  const sysBlocks = _buildClaudeSystemBlocks(systemPrompt);
  if (sysBlocks) body.system = sysBlocks;
  body.messages = _withMessageCacheBreakpoints(messages, Math.max(1, MAX_CACHE_BREAKPOINTS - _systemBreakpointCount(sysBlocks)));
  if (Array.isArray(tools) && tools.length) body.tools = _claudeTools(tools);

  // Content-Blocks werden per Index adressiert (content_block_start/delta/stop).
  const blocks = [];
  const acc = _makeUsageAcc();
  let textAcc = '';
  // Werkzeug-Eingaben zählen live mit: Plot-/Ideen-Chat liefern ihre Antwort fast
  // ganz als final_answer/propose_*-Input — nur über text_delta stünde die
  // Output-Anzeige bis zum Rundenende still (der echte Wert kommt aus message_delta).
  let outChars = 0;
  const betas = fallback ? [REFUSAL_FALLBACK_BETA] : [];
  for await (const ev of _claudeStreamEvents(body, signal, { betas, sentFallback: fallback })) {
    if (ev.type === 'error') throw _streamError(ev, textAcc.length > 0 || blocks.some(Boolean));
    if (acc.onEvent(ev) === 'usage' && onProgress) onProgress({ chars: outChars, tokIn: acc.tokensIn });
    if (ev.type === 'content_block_start') {
      const b = startBlock(ev.content_block);
      if (b) blocks[ev.index] = b;
    }
    if (ev.type === 'content_block_delta') {
      const { chars, text } = applyDelta(blocks[ev.index], ev.delta);
      textAcc += text;
      outChars += chars;
      if (chars && onProgress) onProgress({ chars: outChars, tokIn: acc.tokensIn });
    }
    if (ev.type === 'content_block_stop') {
      const b = blocks[ev.index];
      stopBlock(b);
      if (b?.type === 'thinking' && b.thinking && onProgress) {
        const note = progressNote(b.thinking);
        if (note) onProgress({ note });
      }
    }
  }
  const { toolUses, rawContentBlocks, fellBack } = finalizeBlocks(blocks);
  const r = acc.result();
  const served = r.servedModel || model;
  if (fellBack || served !== model) {
    logger.warn(`Claude Refusal-Fallback: ${model} lehnte ab, ${served} hat übernommen${fellBack ? ' (mitten in der Antwort)' : ''}.`);
  }
  return {
    text: textAcc, toolUses, stopReason: r.stopReason, stopDetails: r.stopDetails, rawContentBlocks,
    tokensIn: r.tokensIn, tokensOut: r.tokensOut, cacheReadIn: r.cacheReadIn,
    cacheCreationIn: r.cacheCreationIn, cacheCreation1hIn: r.cacheCreation1hIn,
    genDurationMs: r.genDurationMs, truncated: r.truncated, provider: 'claude', model: served,
  };
}

// Nur für Tests: Rückzug des Refusal-Fallbacks zurücksetzen.
function _resetFallbackRejected() { _fallbackRejected = false; }

module.exports = { _callClaude, _callClaudeWithTools, _claudeStreamEvents, _withMessageCacheBreakpoints, _resetFallbackRejected };
