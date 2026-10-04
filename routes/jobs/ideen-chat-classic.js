'use strict';
// Ideen-Chat, klassischer Pfad: Provider ohne Werkzeug-Protokoll (Ollama,
// openai-compat mit `ai.openai-compat.tools = false`) bzw. Rückfall, wenn der
// Endpunkt Function-Calling zur Laufzeit ablehnt (AI_TOOLS_UNSUPPORTED). Ein
// einziger JSON-Call: Ideen + Gliederung + die semantisch nächsten Textpassagen
// im Prompt, die Antwort trägt `vorschlaege` ({ werkzeug, …Felder }). Jeder
// Vorschlag läuft durch DIESELBEN Handler wie im agentischen Pfad
// (ideen-chat-tools.js) — was dort abgelehnt würde, fällt hier still heraus
// (gezählt in context_info.rejected). Persistenz wie im agentischen Pfad, damit
// das Frontend beide gleich rendert.
// Deep-Doc: docs/ideen-chat.md

const { db } = require('../../db/schema');
// Spät gebunden (ai.callAIChat statt Destructuring): der Unit-Test ersetzt den
// Provider-Call am Modul-Export.
const ai = require('../../lib/ai');
const { chatTemperature, getContextConfigFor, resolveProvider, parseJSONLenient } = ai;
const { buildAgenticHistory } = require('./agentic-chat');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, getPrompts, jobAbortControllers,
} = require('./shared');
const { executeIdeenChatTool, PROPOSE_TOOLS } = require('./ideen-chat-tools');
const { recordChatLedgerForMessage } = require('../../db/cost-ledger');
const { generateSessionTitle } = require('./chat-title');
const { getSessionWithBookName } = require('../../db/chat-sessions');
const embed = require('../../lib/embed');
const { preContextPassages, retrievalQuery } = require('./chat/book-chat-retrieval');

// Leere Werte, die ein Modell mit Constrained Decoding gern mitschickt, weglassen:
// "" als content wäre für den Handler „Text leeren", 0 als id eine ungültige id.
function _cleanInput(v) {
  const out = {};
  for (const [k, val] of Object.entries(v || {})) {
    if (k === 'werkzeug') continue;
    if (val === null || val === '' || val === 0) continue;
    out[k] = val;
  }
  return out;
}

/**
 * Vorschläge aus der Antwort durch die Werkzeug-Handler schicken. Pure bis auf
 * den DB-Lesepfad der Handler; unit-getestet.
 * @returns {Promise<{ proposals, rejected }>}
 */
async function collectClassicProposals(vorschlaege, ctx, logger) {
  let rejected = 0;
  for (const v of Array.isArray(vorschlaege) ? vorschlaege : []) {
    const name = v?.werkzeug;
    if (!PROPOSE_TOOLS.has(name)) { rejected++; continue; }
    const out = await executeIdeenChatTool(name, _cleanInput(v), ctx);
    if (out?.error) {
      rejected++;
      logger?.warn?.(`Ideen-Chat (klassisch): Vorschlag ${name} verworfen — ${out.error}`);
    }
  }
  return { proposals: ctx.proposals, rejected };
}

async function runIdeenChatJobClassic(jobId, sessionId, userMsgId, message, userEmail) {
  const logger = makeJobLogger(jobId);
  const provider = resolveProvider({ userEmail });
  const aiCfg = getContextConfigFor(provider);
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });
    const session = getSessionWithBookName(parseInt(sessionId), userEmail, 'ideen');
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start (Ideen-Chat klassisch): «${session.book_name || '-'}» session=${sessionId}, Provider=${provider}`);

    const { buildIdeenChatSystemPrompt, SCHEMA_IDEEN_CHAT_CLASSIC } = await getPrompts(userEmail);
    // Kontext-Bausteine teilt der klassische mit dem agentischen Pfad (ideen-chat.js).
    const { ideenChatContext } = require('./ideen-chat');
    const jobSignal = jobAbortControllers.get(jobId)?.signal;
    const base = await ideenChatContext(session, userEmail);

    const history = buildAgenticHistory(session.id).slice(0, -1);
    let passages = [];
    if (embed.isEnabled()) {
      updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 20 });
      try {
        // Suchtext = Frage + letzte Runde: Folgefragen tragen ihr Subjekt nicht selbst.
        const pre = await preContextPassages(session.book_id, retrievalQuery(message, history), { signal: jobSignal, userEmail });
        passages = pre?.hits || [];
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Ideen-Chat (klassisch): Passagen-Suche fehlgeschlagen (${e.message}) – nur Ideen/Gliederung.`);
      }
    }

    const systemPrompt = buildIdeenChatSystemPrompt(session.book_name || '', {
      mode: 'classic', bookContext: base.bookContext, ideenOutline: base.ideenOutline,
      gliederungOutline: base.gliederungOutline, targetsOutline: base.targetsOutline,
      stages: base.stages, proposalMemory: base.proposalMemory, passages,
    });
    const aiMessages = [...history, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 50 });
    const onProgress = ({ chars, tokIn }) => {
      const u = { progress: Math.min(97, 50 + Math.round(chars / 50)) };
      if (tokIn > 0) u.tokensIn = tokIn;
      if (chars > 0) u.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, u);
    };
    const {
      text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0,
      provider: usedProvider, model, genDurationMs,
    } = await ai.callAIChat(aiMessages, systemPrompt, onProgress, null, jobSignal, undefined, SCHEMA_IDEEN_CHAT_CLASSIC, chatTemperature());
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const r = parseJSONLenient(text, ['antwort']);
    const parsed = r.ok ? r.parsed : r.partial;
    let antwort = typeof parsed?.antwort === 'string' ? parsed.antwort.trim() : '';
    const ctx = { ...base.toolCtx, proposals: [] };
    const { proposals, rejected } = await collectClassicProposals(r.ok ? parsed.vorschlaege : [], ctx, logger);
    if (!antwort) antwort = proposals.length ? '__i18n:ideenBoard.chat.proposalsOnly__' : '__i18n:chat.errors.emptyAnswer__';

    const contextInfo = {
      mode: 'ideen-classic',
      ...(passages.length ? { pre_context: { count: passages.length } } : {}),
      ...(proposals.length ? { proposals } : {}),
      ...(rejected ? { rejected } : {}),
      ...(r.ok ? {} : { parse_fallback: true }),
    };
    const now = new Date().toISOString();
    const tps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asst = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, antwort, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, usedProvider, model, tps, JSON.stringify(contextInfo), now);
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);
    recordChatLedgerForMessage(asst.lastInsertRowid);
    const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger });
    completeJob(jobId, {
      session_id: session.id, user_message_id: userMsgId, assistant_message_id: asst.lastInsertRowid,
      tokensIn, tokensOut, proposals: proposals.length,
      ...(sessionTitle ? { sessionTitle } : {}),
    }, tps, `Ideen-Chat klassisch session=${sessionId}, ${proposals.length} Vorschläge, ${rejected} verworfen`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Ideen-Chat-Fehler (klassisch): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

module.exports = { runIdeenChatJobClassic, collectClassicProposals };
