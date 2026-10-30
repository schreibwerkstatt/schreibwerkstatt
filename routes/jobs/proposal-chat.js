'use strict';
// Gemeinsames Gerüst der Vorschlags-Chats (Plot-Chat, Ideen-Chat). Beide geben
// Änderungen an ihrem Board als Vorschläge ab (context_info.proposals), die der
// User einzeln übernimmt, und laufen auf jedem Provider:
//   - agentisch (Werkzeug-Protokoll): Lese-Werkzeuge des gemeinsamen Katalogs +
//     propose_*, Loop/Persistenz aus makeAgenticChatJob (agentic-chat.js);
//   - klassisch (Ollama, openai-compat ohne Tools, und als fallbackJob bei
//     AI_TOOLS_UNSUPPORTED): ein JSON-Call `{ antwort, vorschlaege: [{ werkzeug,
//     …Felder }] }`, jeder Eintrag läuft durch DIESELBEN Handler wie ein
//     Werkzeug-Aufruf — was dort abgelehnt würde, fällt still heraus (gezählt in
//     context_info.rejected).
// `makeProposalChatJob(config)` liefert beide Pfade plus die Weiche. Die
// chat-spezifischen Achsen (Kontext, Prompt-Bausteine, Werkzeug-Handler) kommen
// aus der Config; was hier steht, gilt für beide Chats.
//
// config = {
//   kind,                     // Session-kind und context_info.mode ('plot' | 'ideen')
//   label,                    // Log-Beschriftung ('Plot-Chat')
//   maxIterSettingKey,        // App-Setting mit dem Iterationsdeckel
//   effortSettingKey,         // App-Setting mit dem Claude-Effort
//   proposalsOnlyMarker,      // i18n-Marker, wenn nur Vorschläge und kein Text kamen
//   proposalsCutMarker,       // i18n-Marker, wenn der Lauf ohne Antwort endete, aber Vorschläge sammelte
//   prompts(p) → { buildSystemPrompt, schemaClassic, proposeTools,
//                  forceFinalInstruction }   // aus getPrompts()
//   Lese-Werkzeuge: Spalte `kind` in prompts/chat-tools/access.js
//   loadContext(session, userEmail, { outlineBudgetChars }) → { state, toolCtx, … }  // beide Pfade
//   promptParts(base) → Objekt   // chat-eigene Felder für buildSystemPrompt
//   stateSummary(state) → String // Log-Zeile des agentischen Starts
//   extraReadTools?(base) → string[]  // Katalog-Lese-Werkzeuge, die NUR in diesem Lauf
//                                     // zusätzlich angeboten werden (Ideen-Chat: list_ideen,
//                                     // wenn die Ideenliste gekürzt ist)
//   executeTool(name, input, ctx), proposeToolNames (Set),
//   classicFallbackNote          // Log, wenn die Passagen-Suche ausfällt
// }
//
// Prompt-Aufbau (beide Pfade gleich): buildSystemPrompt liefert Blöcke; der
// stabile Block (Rolle, Regeln, Buch-Kontext, ttl '1h') ist der System-Prompt,
// der mit `preamble: true` markierte (Board/Ideen, Gedächtnis, Textpassagen —
// ändert sich mit jeder Übernahme und Frage) steht als Vorspann VOR der Frage in
// der aktuellen User-Nachricht (`userPreamble`, wie der Erst-Kontext des
// Buch-Chats). So bleiben Werkzeuge + System + Verlauf ein stabiler Cache-Präfix
// (`cacheHistory`); persistiert wird nur die Frage.

const { db } = require('../../db/schema');
// Spät gebunden (ai.callAIChat statt Destructuring): der Unit-Test ersetzt den
// Provider-Call am Modul-Export.
const ai = require('../../lib/ai');
const { chatTemperature, getContextConfigFor, resolveProvider, providerSupportsTools, parseJSONLenient } = ai;
const { makeAgenticChatJob, buildAgenticHistory, stripTrailingEmptyJson } = require('./agentic-chat');
const { classicRefusalAnswer } = require('./chat/shared');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, getPrompts, jobAbortControllers,
} = require('./shared');
const { recordChatLedgerForMessage } = require('../../db/cost-ledger');
const { generateSessionTitle } = require('./chat-title');
const { getSessionWithBookName } = require('../../db/chat-sessions');
const embed = require('../../lib/embed');
const { agentPreContext, preContextStatus, preContextPassages, retrievalQuery } = require('./chat/book-chat-retrieval');
const { prepareChatTools } = require('./chat-tools/select');
const { maxToolIterFor, agentLimits } = require('./agentic-chat/limits');
const { getBookSettings } = require('../../db/book-settings');
const { narrativeLabels } = require('./narrative-labels');
const { cleanProposalInput } = require('./proposal-chat-shared');

const MAX_ITER_MARKER = '__i18n:chat.errors.maxIterReached__';
const EMPTY_MARKERS = new Set([MAX_ITER_MARKER, '__i18n:chat.errors.emptyAnswer__']);
const QUESTION_HEAD = '=== FRAGE ===';

// Anteil des Input-Budgets für die Board- bzw. Ideen-Gliederung im Vorspann.
function outlineBudgetChars(aiCfg) {
  return Math.max(6000, Math.floor((aiCfg?.inputBudgetChars || 0) * 0.15));
}

/** Prompt-Blöcke → { system (Blöcke ohne Vorspann), preamble (Text oder '') }. */
function splitPromptBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [{ text: String(blocks || '') }];
  const system = list.filter(b => !b.preamble);
  const preamble = list.filter(b => b.preamble).map(b => b.text).filter(Boolean).join('\n\n');
  return { system, preamble };
}

const _chars = (blocks) => blocks.reduce((n, b) => n + (b.text?.length || 0), 0);
const _msgChars = (msgs) => msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

/**
 * Lese-Werkzeuge aus dem Katalog, die nur in DIESEM Lauf zusätzlich angeboten
 * werden (die Zugriffstabelle kennt keine Bedingung). Gleich gerendert wie der
 * Satz (Querverweise nur auf Angebotenes), vor den Ausgabe-Werkzeugen eingereiht;
 * Namen, die schon angeboten sind oder im Katalog fehlen, fallen weg.
 * → { tools, toolNames, offeredTools }
 */
function withExtraReadTools({ tools, toolNames, offeredTools }, names, prompts, outputTools = []) {
  const defs = names
    .filter(n => !offeredTools.has(n))
    .map(n => (prompts.CHAT_TOOLS || []).find(t => t.name === n))
    .filter(Boolean);
  if (!defs.length) return { tools, toolNames, offeredTools };
  const rendered = prompts.renderChatTools([...defs, ...tools]).slice(0, defs.length);
  const outNames = new Set(outputTools.map(t => t.name));
  const read = tools.filter(t => !outNames.has(t.name));
  const out = tools.filter(t => outNames.has(t.name));
  const next = [...read, ...rendered, ...out];
  const nextNames = next.map(t => t.name);
  return { tools: next, toolNames: nextNames, offeredTools: new Set(nextNames) };
}

function makeProposalChatJob(cfg) {
  const { kind, label } = cfg;
  // ctx des laufenden agentischen Jobs je Logger (pro Job eine Instanz): parseFinal
  // bekommt vom Loop nur (finalText, logger), braucht aber die gesammelten Vorschläge.
  const ctxByLogger = new WeakMap();

  // Erzählweise (Perspektive, Tempus) für den stabilen Prompt-Block beider Pfade.
  function erzaehlweise(p, session, userEmail) {
    return p.buildErzaehlweiseLine(narrativeLabels(getBookSettings(session.book_id, userEmail)));
  }

  // Vorschläge gesammelt, aber keine Antwort: eigener Hinweis statt Fehler —
  // «Iterationen erschöpft» bekommt den Abbruch-Hinweis, leer den Nur-Vorschläge-Hinweis.
  function proposalsOnlyFallback(antwort, n) {
    const a = String(antwort || '').trim();
    if (!(n > 0) || (a && !EMPTY_MARKERS.has(a))) return a;
    return a === MAX_ITER_MARKER && cfg.proposalsCutMarker ? cfg.proposalsCutMarker : cfg.proposalsOnlyMarker;
  }

  // Vorschlags-Aufrufe beider Pfade durch dieselbe Säuberung (leer = nicht angegeben).
  function runTool(name, input, ctx) {
    return cfg.executeTool(name, cfg.proposeToolNames.has(name) ? cleanProposalInput(input) : input, ctx);
  }

  /**
   * Vorschläge aus der klassischen Antwort durch die Werkzeug-Handler schicken.
   * Pure bis auf den DB-Lesepfad der Handler; unit-getestet.
   * @returns {Promise<{ proposals, rejected }>}
   */
  async function collectClassicProposals(vorschlaege, ctx, logger) {
    let rejected = 0;
    for (const v of Array.isArray(vorschlaege) ? vorschlaege : []) {
      const name = v?.werkzeug;
      if (!cfg.proposeToolNames.has(name)) { rejected++; continue; }
      const out = await runTool(name, v, ctx);
      if (out?.error) {
        rejected++;
        logger?.warn?.(`${label} (klassisch): Vorschlag ${name} verworfen — ${out.error}`);
      }
    }
    return { proposals: ctx.proposals, rejected };
  }

  async function runClassic(jobId, sessionId, userMsgId, message, userEmail) {
    const logger = makeJobLogger(jobId);
    const provider = resolveProvider({ userEmail });
    const aiCfg = getContextConfigFor(provider);
    try {
      updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });
      const session = getSessionWithBookName(parseInt(sessionId), userEmail, kind);
      if (!session) throw i18nError('job.error.sessionNotFound');
      logger.info(`Start (${label} klassisch): «${session.book_name || '-'}» session=${sessionId}, Provider=${provider}`);

      const p = await getPrompts(userEmail);
      const { buildSystemPrompt, schemaClassic } = cfg.prompts(p);
      const jobSignal = jobAbortControllers.get(jobId)?.signal;
      const base = await cfg.loadContext(session, userEmail, { outlineBudgetChars: outlineBudgetChars(aiCfg) });

      let history = buildAgenticHistory(session.id).slice(0, -1);
      let passages = [];
      if (embed.isEnabled()) {
        updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 20 });
        try {
          // Suchtext = Frage + letzte Runde: Folgefragen tragen ihr Subjekt nicht selbst.
          const pre = await preContextPassages(session.book_id, retrievalQuery(message, history), { signal: jobSignal, userEmail });
          passages = pre?.hits || [];
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          logger.warn(`${label} (klassisch): Passagen-Suche fehlgeschlagen (${e.message}) – ${cfg.classicFallbackNote}.`);
        }
      }

      const build = (pass) => splitPromptBlocks(buildSystemPrompt(session.book_name || '', {
        mode: 'classic', ...cfg.promptParts(base), passages: pass, erzaehlweise: erzaehlweise(p, session, userEmail),
      }));
      // Budget-Prüfung vor dem Call: erst die Textpassagen, dann der älteste Verlauf
      // weichen — statt am Preflight des Providers zu scheitern. Board/Ideen sind
      // schon in loadContext aufs Budget gekürzt.
      let prompt = build(passages);
      const total = () => _chars(prompt.system) + prompt.preamble.length + _msgChars(history) + message.length + QUESTION_HEAD.length;
      if (total() > aiCfg.inputBudgetChars && passages.length) {
        logger.warn(`${label} (klassisch): Prompt über Budget (${total()}/${aiCfg.inputBudgetChars} Zeichen) – ohne Textpassagen.`);
        passages = [];
        prompt = build(passages);
      }
      let dropped = 0;
      while (total() > aiCfg.inputBudgetChars && history.length) { history = history.slice(1); dropped++; }
      if (dropped) logger.warn(`${label} (klassisch): ${dropped} ältere Verlaufsnachricht(en) fürs Budget weggelassen.`);
      // Verlauf beginnt mit einer User-Nachricht (Provider erwarten den Wechsel ab user).
      while (history.length && history[0].role !== 'user') history = history.slice(1);
      const systemPrompt = prompt.system;
      const userContent = prompt.preamble ? `${prompt.preamble}\n\n${QUESTION_HEAD}\n\n${message}` : message;
      const aiMessages = [...history, { role: 'user', content: userContent }];

      updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 50 });
      const onProgress = ({ chars, tokIn }) => {
        const u = { progress: Math.min(97, 50 + Math.round(chars / 50)) };
        if (tokIn > 0) u.tokensIn = tokIn;
        if (chars > 0) u.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
        updateJob(jobId, u);
      };
      const {
        text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0,
        provider: usedProvider, model, genDurationMs, stopReason, stopDetails,
      } = await ai.callAIChat(aiMessages, systemPrompt, onProgress, null, jobSignal, undefined, schemaClassic, chatTemperature());
      updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
      if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

      // Ablehnung: Hinweis-Marker statt Antwort, Teil-Output samt Vorschlägen verfällt
      // (wie im agentischen Pfad und im Abschnitts-/Buch-Chat).
      const refusal = classicRefusalAnswer({ stopReason, stopDetails }, logger);
      const r = refusal ? { ok: false, partial: {} } : parseJSONLenient(text, ['antwort']);
      const parsed = r.ok ? r.parsed : r.partial;
      let antwort = refusal || (typeof parsed?.antwort === 'string' ? parsed.antwort.trim() : '');
      const ctx = { ...base.toolCtx, proposals: [] };
      const { proposals, rejected } = await collectClassicProposals(r.ok ? parsed.vorschlaege : [], ctx, logger);
      antwort = proposalsOnlyFallback(antwort, proposals.length) || '__i18n:chat.errors.emptyAnswer__';

      const contextInfo = {
        mode: `${kind}-classic`,
        ...(passages.length ? { pre_context: { count: passages.length } } : {}),
        ...(proposals.length ? { proposals } : {}),
        ...(rejected ? { rejected } : {}),
        ...(r.ok || refusal ? {} : { parse_fallback: true }),
        ...(refusal ? { refused: true } : {}),
      };
      const now = new Date().toISOString();
      const tps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
      const asst = db.prepare(`
        INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, context_info, created_at)
        VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, antwort, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, usedProvider, model, tps, JSON.stringify(contextInfo), now);
      db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);
      recordChatLedgerForMessage(asst.lastInsertRowid);
      const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger, signal: jobSignal });
      completeJob(jobId, {
        session_id: session.id, user_message_id: userMsgId, assistant_message_id: asst.lastInsertRowid,
        tokensIn, tokensOut, proposals: proposals.length,
        ...(sessionTitle ? { sessionTitle } : {}),
      }, tps, `${label} klassisch session=${sessionId}, ${proposals.length} Vorschläge, ${rejected} verworfen`);
    } catch (e) {
      if (e.name !== 'AbortError') logger.error(`${label}-Fehler (klassisch): ${e.message}`, { stack: e.stack });
      failJob(jobId, e);
    }
  }

  const runAgent = makeAgenticChatJob({
    startLabel: label,
    errLabel: label,
    callProvider: undefined,
    resolveProvider: (userEmail) => resolveProvider({ userEmail }),
    effortSettingKey: cfg.effortSettingKey,

    loadSession: (sessionId, userEmail) => getSessionWithBookName(parseInt(sessionId), userEmail, kind),

    async prepare({ session, userEmail, aiCfg, logger, jobSignal, message, history }) {
      const p = await getPrompts(userEmail);
      const { buildSystemPrompt, proposeTools, forceFinalInstruction } = cfg.prompts(p);
      const provider = resolveProvider({ userEmail });
      const maxIter = maxToolIterFor(cfg.maxIterSettingKey, 8, provider, userEmail);
      const limits = agentLimits(maxIter, aiCfg);
      const embOn = embed.isEnabled();

      const base = await cfg.loadContext(session, userEmail, { outlineBudgetChars: outlineBudgetChars(aiCfg) });
      // Werkzeugsatz wie in allen agentischen Chats (chat-tools/select.js): Slim/voll,
      // ohne Werkzeuge ohne Endpunkt oder Daten; Handler-Hinweise folgen ctx.offeredTools.
      const prepared = prepareChatTools({
        chat: kind, prompts: p, provider, userEmail,
        ctx: { ...base.toolCtx, logger }, outputTools: proposeTools,
      });
      const { toolSet, unavailable } = prepared;
      const { tools, toolNames, offeredTools } = withExtraReadTools(prepared, cfg.extraReadTools?.(base) || [], p, proposeTools);
      // Erst-Kontext wie im agentischen Buch-Chat: die semantisch nächsten Passagen zur
      // Frage (+ letzte Runde) stehen schon in Iteration 1 im Vorspann der Frage — eine
      // Frage, die den Text betrifft, braucht dann oft keine Lese-Runde. Non-fatal;
      // ohne Embedding-Endpunkt kein Block.
      const preContext = embOn
        ? await agentPreContext(session.book_id, retrievalQuery(message, history), { signal: jobSignal, logger, userEmail })
        : null;
      const { system: systemPrompt, preamble } = splitPromptBlocks(buildSystemPrompt(session.book_name || '', {
        mode: 'agent',
        passages: embOn ? (preContext?.hits || []) : null,
        passageStatus: preContextStatus(preContext, { enabled: embOn }),
        maxToolIter: maxIter,
        toolNames,
        erzaehlweise: erzaehlweise(p, session, userEmail),
        ...cfg.promptParts(base),
      }));
      logger.info(`${label}: ${tools.length} Werkzeuge (${toolSet}${unavailable.length ? `, ohne Daten/Endpunkt: ${unavailable.join(', ')}` : ''}), max ${maxIter} Iterationen, `
        + `${cfg.stateSummary(base.state)}, Provider=${provider}.`);
      const ctx = {
        ...base.toolCtx,
        jobSignal, logger,
        offeredTools,
        resultCapChars: limits.toolResultCap,
        inputBudgetChars: aiCfg.inputBudgetChars,
        proposals: [],
        preContext: preContext ? { count: preContext.hits.length, chars: preContext.chars } : null,
      };
      ctxByLogger.set(logger, ctx);
      return {
        systemPrompt,
        tools,
        maxToolIter: maxIter,
        tokenBudget: aiCfg.inputBudgetTokens,
        toolResultCap: limits.toolResultCap,
        maxToolsPerRound: limits.maxToolsPerRound,
        roundResultCapChars: limits.roundResultCapChars,
        inputTokenCap: limits.inputTokenCap,
        forceFinalInstruction,
        ...(preamble ? { userPreamble: `${preamble}\n\n${QUESTION_HEAD}` } : {}),
        cacheHistory: true,
        ctx,
      };
    },

    executeTool: (name, input, ctx) => runTool(name, input, ctx),

    consumeFinalAnswer: ({ finalUse, ctx, toolLog, iterNum, logger }) => {
      const raw = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
      const antwort = proposalsOnlyFallback(raw, ctx?.proposals?.length || 0);
      toolLog.push({ name: 'final_answer', input: { antwort_chars: antwort.length }, ok: true, durationMs: 0, resultBytes: antwort.length, truncated: false, iter: iterNum });
      logger.info(`tool=final_answer antwort_chars=${antwort.length} iter=${iterNum} (terminal)`);
      return JSON.stringify({ antwort });
    },

    // Auch wenn die Synthese kein final_answer liefert (Loop schreibt dann den
    // maxIterReached-Marker): sind Vorschläge gesammelt, stehen sie mit Hinweis da
    // statt hinter einer Fehlermeldung. ctx kommt als drittes Argument, falls der
    // Loop es reicht, sonst über den Logger dieses Laufs.
    parseFinal: (finalText, logger, loopCtx) => {
      let antwort = '';
      try { antwort = JSON.parse(finalText)?.antwort || ''; }
      catch {
        logger.warn(`${label}-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.`);
        antwort = stripTrailingEmptyJson(finalText) || finalText;
      }
      const ctx = loopCtx || ctxByLogger.get(logger);
      return proposalsOnlyFallback(antwort || MAX_ITER_MARKER, ctx?.proposals?.length || 0) || MAX_ITER_MARKER;
    },

    buildContextInfo: ({ toolLog, iter, ctx, stopReason, costUsd }) => ({
      mode: kind,
      tool_calls: toolLog,
      iterations: iter + 1,
      ...(stopReason ? { stop_reason: stopReason } : {}),
      ...(costUsd > 0 ? { cost_usd: Math.round(costUsd * 10000) / 10000 } : {}),
      ...(ctx.proposals.length ? { proposals: ctx.proposals } : {}),
      ...(ctx.preContext ? { pre_context: ctx.preContext } : {}),
    }),

    buildCompletePayload: ({ base, ctx }) => ({ ...base, proposals: ctx.proposals.length }),

    buildSummary: ({ sessionId, toolLog, iter, ctx }) =>
      `${label} session=${sessionId}, ${toolLog.length} Tool-Calls, ${iter + 1} Iter, ${ctx.proposals.length} Vorschläge`,

    // Endpunkt lehnt Function-Calling erst zur Laufzeit ab → dieselbe Frage klassisch.
    fallbackJob: runClassic,
  });

  /** Pfadwahl am EFFEKTIVEN Provider (KI-Profil vor globalem `ai.provider`). */
  function usesTools(userEmail) {
    return providerSupportsTools(resolveProvider({ userEmail }));
  }

  function runDispatch(jobId, sessionId, userMsgId, message, userEmail) {
    return usesTools(userEmail)
      ? runAgent(jobId, sessionId, userMsgId, message, userEmail)
      : runClassic(jobId, sessionId, userMsgId, message, userEmail);
  }

  return { runAgent, runClassic, runDispatch, usesTools, collectClassicProposals, proposalsOnlyFallback };
}

module.exports = { makeProposalChatJob, splitPromptBlocks, outlineBudgetChars, withExtraReadTools };
