'use strict';
// Eine Logzeile je KI-Call aus `aiCall` (alle Jobs). Die Job-Zeile «Fertig (…)»
// trägt nur Summen; ob ein Prompt-Cache greift (welcher Call schreibt, welche
// lesen), ob der gestaffelte Start wirkt und welcher Teil-Call teuer oder langsam
// war, sieht man nur je Call. Benennung: ausdrückliches `label` des Aufrufers
// (Lektorat: «objektiv 3/7»), sonst das Tier-Label (Komplettanalyse-Phasen),
// dazu immer die Job-Phase zum Startzeitpunkt (`statusText`, ohne `job.phase.`).
// Level `info`, weil Prod auf `info` läuft — die Zeilen sind für die Diagnose
// dort gedacht. Nie werfen: Logging darf keinen Call scheitern lassen.
const { AsyncLocalStorage } = require('node:async_hooks');
const logger = require('../../../logger');
const { jobs } = require('./state');
const { fmtTok } = require('./jobs');

// Laufnummer je Job, ohne Feld am Job-Objekt (das geht an den Client).
const _seq = new WeakMap();

// Bezeichnung aus dem umgebenden Aufruf, ohne sie durch jede Call-Signatur zu
// reichen: `retryOnTransientAi(fn, { label })` (Komplettanalyse: «Single-Pass
// Fakten (C)», Chunk-Label je Kapitel) setzt sie für alle Calls in `fn`.
const _labelStore = new AsyncLocalStorage();
function withCallLabel(label, fn) {
  return label ? _labelStore.run(label, fn) : fn();
}

const _fmtChars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const _fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;

function _phase(job) {
  const key = typeof job?.statusText === 'string' ? job.statusText.replace(/^job\.phase\./, '') : '';
  if (!key) return '';
  const params = job.statusParams && typeof job.statusParams === 'object'
    ? Object.entries(job.statusParams)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
      .join(' ')
    : '';
  return params ? `${key} ${params}` : key;
}

// Form eines Prompts bzw. System-Prompts: Länge, bei Content-Blöcken je Block
// und wie viele davon einen Cache-Breakpoint tragen. Prompt-Blöcke tragen
// `cache_control`; System-Blöcke kommen roh als {text, ttl?, cache?} und werden
// im Provider zu Breakpoints, ausser `cache: false` (lib/ai/claude.js).
function _shape(p) {
  if (typeof p === 'string') return `${_fmtChars(p.length)} Z.`;
  if (!Array.isArray(p)) return '-';
  const lens = p.map(b => _fmtChars(String(b?.text ?? '').length)).join('+');
  const cached = p.filter(b => b && (b.type ? !!b.cache_control : b.cache !== false)).length;
  return `${p.length} Blöcke ${lens} Z.${cached ? `, ${cached} mit Cache` : ''}`;
}

/** Vor dem Call: Laufnummer, Name, Phase und Prompt-Form festhalten. */
function beginCallLog(jobId, { label, tierLabel, prompt, system }) {
  try {
    const job = jobs.get(jobId);
    let seq = null;
    if (job) { seq = (_seq.get(job) || 0) + 1; _seq.set(job, seq); }
    const outer = _labelStore.getStore();
    const name = [label || outer, tierLabel && tierLabel !== (label || outer) ? `(${tierLabel})` : '']
      .filter(Boolean).join(' ');
    return {
      seq, name, phase: _phase(job),
      prompt: _shape(prompt), system: _shape(system),
      t0: Date.now(), tStart: null,
    };
  } catch {
    return { seq: null, name: label || '', phase: '', prompt: '-', system: '-', t0: Date.now(), tStart: null };
  }
}

/** Erster Stream-Event mit Input-Zählung: Antwort hat begonnen (Cache ab jetzt lesbar). */
function markCallStarted(ctx) {
  if (ctx && ctx.tStart == null) ctx.tStart = Date.now();
}

function _head(ctx) {
  const nr = ctx.seq != null ? `#${ctx.seq}` : '';
  const name = ctx.name ? ` ${ctx.name}` : '';
  const phase = ctx.phase ? ` [${ctx.phase}]` : '';
  return `KI-Call${nr ? ` ${nr}` : ''}${name}${phase}`;
}

/** Nach dem Call: Tokens, Cache-Anteile, Dauer, Modell, Abschlussgrund. */
function endCallLog(ctx, res, provider) {
  try {
    const {
      tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0,
      stopReason, servedModel, truncated, genDurationMs,
    } = res || {};
    const uncached = Math.max(0, tokensIn - cacheReadIn - cacheCreationIn);
    const write5m = Math.max(0, cacheCreationIn - cacheCreation1hIn);
    const cache = (cacheReadIn || cacheCreationIn)
      ? `Cache ${fmtTok(cacheReadIn)} gelesen, ${fmtTok(write5m)}+${fmtTok(cacheCreation1hIn)}(1h) geschrieben, ${fmtTok(uncached)} ungecacht`
      : 'kein Cache';
    const total = Date.now() - ctx.t0;
    const start = ctx.tStart != null ? `, Antwort ab ${_fmtSec(ctx.tStart - ctx.t0)}` : '';
    const gen = genDurationMs != null ? `, Generierung ${_fmtSec(genDurationMs)}` : '';
    const stop = stopReason && stopReason !== 'end_turn' ? `, stop=${stopReason}` : '';
    const trunc = truncated ? ', ABGESCHNITTEN' : '';
    logger.info(`${_head(ctx)}: ${fmtTok(tokensIn)}↑ (${cache}) ${fmtTok(tokensOut)}↓, ${_fmtSec(total)}${start}${gen}${stop}${trunc}, ${provider}/${servedModel || '-'} · Prompt ${ctx.prompt} · System ${ctx.system}`);
  } catch { /* Logging darf nie werfen */ }
}

/** Call geworfen (Abbruch, Timeout, Provider-Fehler). */
function failCallLog(ctx, err, provider) {
  try {
    const start = ctx.tStart != null ? `, Antwort ab ${_fmtSec(ctx.tStart - ctx.t0)}` : ', keine Antwort';
    const what = err?.name === 'AbortError' ? 'abgebrochen' : 'fehlgeschlagen';
    logger.warn(`${_head(ctx)} ${what} nach ${_fmtSec(Date.now() - ctx.t0)}${start} (${provider}): ${String(err?.message || err).slice(0, 300)} · Prompt ${ctx.prompt}`);
  } catch { /* Logging darf nie werfen */ }
}

module.exports = { beginCallLog, markCallStarted, endCallLog, failCallLog, withCallLabel };
