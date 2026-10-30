'use strict';
// Werkzeug-Runde des agentischen Chat-Loops (./loop.js): die tool_use-Blöcke einer
// Runde ausführen und als tool_result-Blöcke zurückgeben, mit den Deckeln pro Runde,
// der Prüfung gegen den angebotenen Werkzeugsatz und dem Werkzeug-Verlauf fürs UI.
//
// Jeder tool_use bekommt GENAU ein tool_result — auch die nicht ausgeführten
// (kaputte Argumente, nicht angeboten, Deckel pro Runde), sonst ist die Folgerunde
// ein 400.

const { _skipped } = require('./helpers');

// Eingabe eines Aufrufs, wie sie in context_info.tool_calls landet: lange Strings
// gekürzt, lange Listen gestutzt. Der Verlauf zeigt, WAS gefragt wurde — ein
// Modell, das eine ganze Seite als Suchmuster schickt, soll die Nachricht nicht
// auf Hunderte KB aufblähen. Die Sicht (`view`) entsteht vorher aus der vollen Eingabe.
const LOG_INPUT_STR_MAX = 500;
const LOG_INPUT_LIST_MAX = 50;
const LOG_INPUT_DEPTH = 4;
function capLogInput(v, depth = 0) {
  if (typeof v === 'string') return v.length > LOG_INPUT_STR_MAX ? `${v.slice(0, LOG_INPUT_STR_MAX)}…` : v;
  if (!v || typeof v !== 'object') return v;
  if (depth >= LOG_INPUT_DEPTH) return Array.isArray(v) ? `[${v.length}]` : '{…}';
  if (Array.isArray(v)) {
    const head = v.slice(0, LOG_INPUT_LIST_MAX).map(x => capLogInput(x, depth + 1));
    return v.length > LOG_INPUT_LIST_MAX ? [...head, `… +${v.length - LOG_INPUT_LIST_MAX}`] : head;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = capLogInput(x, depth + 1);
  return out;
}

// Stabiler i18n-Key für einen fehlgeschlagenen Aufruf ohne eigenen Key. Ein Handler,
// der schon einen `chat.toolError.*`-Fehler wirft (i18nError), behält ihn; alles
// andere (DB-Fehler, «Unbekanntes Werkzeug», Netz) zeigt das UI generisch — der
// Rohtext geht ans Modell und ins Log, nicht in den Verlauf.
function failureKey(err) {
  const msg = String(err?.message || '');
  if (/^chat\.toolError\.[\w.]+$/.test(msg)) return { errorKey: msg, errorParams: err.i18nParams || null };
  const code = typeof err?.code === 'string' || typeof err?.code === 'number' ? String(err.code).slice(0, 40) : '';
  return code
    ? { errorKey: 'chat.toolError.failedCode', errorParams: { code } }
    : { errorKey: 'chat.toolError.failed', errorParams: null };
}

/**
 * @param {object} p
 * @param {Function} p.executeTool   config.executeTool(name, input, ctx)
 * @param {object}   p.ctx
 * @param {Set<string>} p.offered    Namen aller Werkzeuge, die der Lauf dem Modell anbietet
 * @param {object}   p.caps          { maxToolsPerRound, roundResultCap, toolResultCaps, capFor }
 * @param {Array}    p.toolLog
 * @param {Function} p.toolView      (name, input, out, ok) → Sicht | null
 * @param {object}   p.logger
 * @param {AbortSignal} [p.jobSignal]
 * @param {Function} p.publishLive
 * @param {object}   p.counters      { skipped, notOffered, failed } — fortgeschrieben
 */
function makeToolRunner({ executeTool, ctx, offered, caps, toolLog, toolView, logger, jobSignal, publishLive, counters }) {
  const { maxToolsPerRound, roundResultCap, toolResultCaps, capFor } = caps;
  return async function runTools(toolUses, iterNum) {
    const toolResults = [];
    let roundChars = 0;
    let executed = 0;
    for (const tu of toolUses) {
      if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const t0 = Date.now();
      let out, ok = true, errMsg = null, skipped = false, thrown = null;
      const remaining = roundResultCap - roundChars;
      if (tu.parseError) {
        skipped = true;
        out = _skipped(`Werkzeug-Argumente waren kein gültiges JSON (${String(tu.parseError).slice(0, 120)}) – Aufruf NICHT ausgeführt. Wiederhole ihn mit gültigen Argumenten.`, 'chat.toolError.invalidArgs');
      } else if (!offered.has(tu.name)) {
        // Nur was dieser Lauf anbietet, läuft — für jeden Chat an derselben Stelle.
        // Ein erfundener oder fremder Name (Werkzeug eines anderen Chats, Slim-Satz
        // ohne dieses Werkzeug, fehlender Endpunkt) erreicht keinen Handler.
        skipped = true;
        counters.notOffered++;
        out = _skipped(`Werkzeug «${String(tu.name).slice(0, 80)}» wird in diesem Lauf nicht angeboten – Aufruf NICHT ausgeführt. Nutze nur die angebotenen Werkzeuge.`, 'chat.toolError.notOffered');
      } else if (executed >= maxToolsPerRound) {
        skipped = true;
        out = _skipped(`Nicht ausgeführt: höchstens ${maxToolsPerRound} Werkzeug-Aufrufe pro Runde. Fordere ihn in der nächsten Runde erneut an, falls er noch nötig ist.`, 'chat.toolError.roundLimit', { max: maxToolsPerRound });
      } else if (remaining < 500 || (Number(toolResultCaps[tu.name]) > 0 && remaining < capFor(tu.name))) {
        // Ein Werkzeug mit eigenem Deckel (Recherche-Chat: read_web_page) misst sein
        // Ergebnis auf genau diesen Deckel; passt der nicht mehr ins Rundenbudget,
        // läuft es in der nächsten Runde, statt hier hart geschnitten zu werden.
        skipped = true;
        out = _skipped('Nicht ausgeführt: das Ergebnis-Budget dieser Runde ist ausgeschöpft. Fordere den Aufruf in der nächsten Runde erneut an, falls er noch nötig ist.', 'chat.toolError.roundBudget');
      } else {
        executed++;
        try {
          out = await executeTool(tu.name, tu.input, ctx);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          ok = false; errMsg = e.message; thrown = e; out = { error: e.message };
        }
      }
      if (skipped) counters.skipped++;
      const durationMs = Date.now() - t0;
      // errorKey/errorParams sind fürs UI (Werkzeug-Liste), nicht fürs Modell.
      let errorKey = null, errorParams = null;
      if (out && typeof out === 'object' && !Array.isArray(out) && ('errorKey' in out || 'errorParams' in out)) {
        ({ errorKey = null, errorParams = null } = out);
        const { errorKey: _k, errorParams: _p, ...rest } = out;
        out = rest;
      }
      const content = JSON.stringify(out);
      const resultBytes = content.length;
      const cap = Math.min(capFor(tu.name), remaining);
      const truncated = resultBytes > cap || !!(out && typeof out === 'object' && out.truncated);
      if (out && typeof out === 'object' && out.error && ok) errMsg = String(out.error);
      const sent = resultBytes > cap ? content.slice(0, cap) + '…' : content;
      roundChars += sent.length;
      const callOk = ok && !(out && out.error);
      // Jeder Fehlschlag trägt einen Key; ohne eigenen den generischen.
      if (!callOk && !errorKey) ({ errorKey, errorParams } = failureKey(thrown));
      if (!callOk && !skipped) counters.failed++;
      const view = toolView(tu.name, tu.input, out, callOk);
      toolLog.push({
        name: tu.name, input: capLogInput(tu.input), ok: callOk, durationMs, resultBytes, truncated, iter: iterNum,
        ...(view ? { view } : {}),
        ...(skipped ? { skipped: true } : {}),
        ...(errMsg ? { error: String(errMsg).slice(0, 300) } : {}),
        ...(errorKey ? { errorKey } : {}),
        ...(errorKey && errorParams ? { errorParams } : {}),
      });
      if (callOk) logger.info(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes}${truncated ? ' truncated' : ''} iter=${iterNum}`);
      else logger.warn(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes} iter=${iterNum} FAILED: ${errMsg}`);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: sent,
        ...(out && out.error ? { is_error: true } : {}),
      });
    }
    publishLive();
    return toolResults;
  };
}

module.exports = { makeToolRunner, capLogInput, failureKey, LOG_INPUT_STR_MAX };
