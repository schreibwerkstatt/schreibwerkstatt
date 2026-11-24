'use strict';
// Lauf-Protokoll des agentischen Loops (./loop.js), geteilt von Buch-, Recherche-,
// Plot- und Ideen-Chat: Werkzeug-Log (`context_info.tool_calls`), Runden-Protokoll
// (`context_info.tool_rounds`), Live-Kopie für GET /jobs/:id, Zeilen der
// serverseitigen Anthropic-Websuche, nicht ausgeführte Aufrufe und der Teil-Verlauf
// eines gescheiterten oder abgebrochenen Laufs.
//
// Runde = ein Provider-Call: `{ iter, tokIn, tokOut, cacheReadIn?, cacheCreationIn?,
// durationMs, synth?, note? }`. `tokIn` enthält die Cache-Anteile; `synth` markiert den
// erzwungenen Synthese-Turn. Eine Runde ohne Werkzeug-Zeilen ist die Antwort-Runde.
// `note` ist der Satz, den das Modell neben seine Werkzeug-Aufrufe schreibt (die Prompts
// verlangen ihn in der Sprache der Frage, prompts/chat-round-note.js) — nie die
// Denk-Zusammenfassung des Providers: deren Sprache steuert die App nicht.

const { db } = require('../../../db/schema');
const { capLogInput } = require('./run-tools');
const { roundNote, liveTools, serverSearchEntry, applyServerSearchResult, LIVE_MAX_ROUNDS } = require('./tool-view');

const FAILED_ERROR_MAX = 300;

/**
 * @param {{ jobId: string, updateJob: Function }} p
 */
function makeRunLog({ jobId, updateJob }) {
  const toolLog = [];
  const rounds = [];
  // Für die Abschluss-Logzeile: nicht ausgeführte / nicht angebotene / gescheiterte Aufrufe.
  const counters = { skipped: 0, notOffered: 0, failed: 0 };
  // server_tool_use-id → Verlaufszeile der Anthropic-Websuche (Trefferzahl nachtragen).
  const serverSearches = new Map();

  const publishLive = () => updateJob(jobId, { liveTools: liveTools(toolLog), liveRounds: rounds.slice(-LIVE_MAX_ROUNDS) });

  return {
    toolLog, rounds, counters, publishLive,

    /**
     * Eine Runde protokollieren: was das Modell vorhatte (Text neben den Werkzeug-
     * Aufrufen), Tokens samt Cache-Anteil (nur Claude meldet ihn), Dauer. Text einer
     * Antwort-Runde ist die Antwort, keine Notiz. Liefert die Notiz (oder null).
     */
    round(result, { iter, durationMs, synthesis = false }) {
      const narrates = !synthesis && (result.stopReason === 'tool_use' || result.stopReason === 'pause_turn');
      const note = roundNote(narrates ? result.text : '');
      rounds.push({
        iter, tokIn: result.tokensIn || 0, tokOut: result.tokensOut || 0,
        ...(result.cacheReadIn > 0 ? { cacheReadIn: result.cacheReadIn } : {}),
        ...(result.cacheCreationIn > 0 ? { cacheCreationIn: result.cacheCreationIn } : {}),
        ...(durationMs > 0 ? { durationMs } : {}),
        ...(synthesis ? { synth: true } : {}),
        ...(note ? { note } : {}),
      });
      publishLive();
      return note;
    },

    /** Serverseitige Suche (Anthropic) als Verlaufszeile; die Trefferzahl trägt der Result-Block nach. */
    serverSearch(block, iter) {
      const query = String(block.input?.query || '');
      const entry = serverSearchEntry(query, iter);
      toolLog.push(entry);
      if (block.id) serverSearches.set(block.id, entry);
      return query;
    },
    serverSearchResult(block) {
      applyServerSearchResult(serverSearches.get(block.tool_use_id), block);
    },

    /** Aufruf, den der Loop nicht ausführt (Synthese, final_answer-Runde, verworfene Runde). */
    skip(tu, iter, errorKey) {
      counters.skipped++;
      toolLog.push({
        name: tu.name, input: capLogInput(tu.input), ok: false, skipped: true,
        durationMs: 0, resultBytes: 0, truncated: false, iter, error: errorKey, errorKey,
      });
    },
    /** Alle Aufrufe einer verworfenen Runde (Output-Deckel, Kontext-Budget) — sichtbar statt still weg. */
    skipAll(toolUses, iter, errorKey) {
      for (const tu of toolUses || []) if (tu?.name) this.skip(tu, iter, errorKey);
      if (toolUses?.length) publishLive();
    },
  };
}

/**
 * Teil-Verlauf eines gescheiterten oder abgebrochenen Laufs an die Frage hängen
 * (`context_info.run_failed` der User-Nachricht): bleibt nach dem Neuladen sichtbar,
 * erreicht aber nie den Verlauf, den das Modell sieht — der liest nur `content`.
 * Ohne Aufruf und Runde gibt es nichts zu zeigen; ein Fehler hier stört den Fehlerpfad nie.
 */
function persistFailedRun({ userMsgId, runLog, err, cancelled, logger }) {
  if (!userMsgId || !runLog || (!runLog.toolLog.length && !runLog.rounds.length)) return;
  try {
    const row = db.prepare("SELECT context_info FROM chat_messages WHERE id = ? AND role = 'user'").get(userMsgId);
    if (!row) return;
    let ci = {};
    try { ci = row.context_info ? JSON.parse(row.context_info) || {} : {}; } catch { ci = {}; }
    ci.run_failed = {
      cancelled: !!cancelled,
      error: cancelled ? 'job.cancelled' : String(err?.message || 'common.unknownError').slice(0, FAILED_ERROR_MAX),
      ...(!cancelled && err?.i18nParams ? { errorParams: err.i18nParams } : {}),
      tool_calls: runLog.toolLog,
      tool_rounds: runLog.rounds,
    };
    db.prepare('UPDATE chat_messages SET context_info = ? WHERE id = ?').run(JSON.stringify(ci), userMsgId);
  } catch (e) {
    logger?.warn?.(`Teil-Verlauf des gescheiterten Laufs nicht gespeichert: ${e.message}`);
  }
}

module.exports = { makeRunLog, persistFailedRun };
