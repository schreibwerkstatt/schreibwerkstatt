'use strict';
// Plot-Chat (Panel in der Plot-Werkstatt, kind='plot'). Entwickelt das Beat-Board
// im Gespräch und gibt Board-Änderungen als Vorschläge ab. Vorschläge landen in
// context_info.proposals und werden NICHT geschrieben — der User übernimmt jeden
// einzeln (Frontend: public/js/chat/plot-chat-proposals.js).
//
// Jeder Provider: mit Werkzeug-Protokoll agentisch (dieses Modul, Lese-Werkzeuge
// des Buch-Chats + propose_*), sonst klassisch in einem JSON-Call
// (plot-chat-classic.js). `runPlotChatJobDispatch` wählt; lehnt ein Endpunkt
// Function-Calling erst zur Laufzeit ab, übernimmt der klassische Pfad denselben
// Job (fallbackJob). Loop/Persistenz: makeAgenticChatJob (agentic-chat.js).
// Deep-Doc: docs/plot-chat.md

const { getBookSettings } = require('../../db/schema');
const { resolveProvider, providerClass, providerSupportsTools } = require('../../lib/ai');
const { getPrompts, loadOrderedBookContents } = require('./shared');
const { makeAgenticChatJob, stripTrailingEmptyJson } = require('./agentic-chat');
const { executePlotChatTool } = require('./plot-chat-tools');
const {
  loadBoardState, boardOutline, figurenOutline, sessionPlotProposalMemory,
} = require('./plot-chat-context');
const { runPlotChatJobClassic } = require('./plot-chat-classic');
const embed = require('../../lib/embed');
const appSettings = require('../../lib/app-settings');
const { getSessionWithBookName } = require('../../db/chat-sessions');
const { agentPreContext, retrievalQuery } = require('./chat/book-chat-retrieval');

function _maxToolIter(provider, userEmail) {
  const base = parseInt(appSettings.get('jobs.plot_chat.max_tool_iter'), 10) || 8;
  // Lokale Provider zahlen jede Runde den vollen Prompt erneut (kein Caching) —
  // derselbe lokale Deckel wie im Buch-Chat, damit beide Chats gleich teuer bleiben.
  if (providerClass(provider, { userEmail }) !== 'local') return base;
  const local = parseInt(appSettings.get('jobs.book_chat.max_tool_iter_local'), 10) || 0;
  return local > 0 ? Math.min(base, local) : base;
}

// Per-Tool-Result-Cap wie im Buch-Chat: eine einzelne Antwort (get_chapter_text)
// darf das Kontextfenster nicht allein füllen.
function _toolResultCapChars(maxIter, aiCfg) {
  return Math.max(4000, Math.floor(aiCfg.inputBudgetChars / (maxIter * 6)));
}

/**
 * Kontext beider Pfade: Board-Stand, Prompt-Bausteine (Board-Gliederung,
 * Figurenliste, Gedächtnis früherer Vorschläge, Buch-Kontext) und die Felder,
 * die die Vorschlags-Handler im ctx brauchen. Kapitel nur über die
 * Content-Store-Facade, inkl. ausgeschlossener (ein Beat darf darauf zeigen).
 */
async function plotChatContext(session, userEmail) {
  const { buildPlotProposalMemoryBlock, getResearchPromptContext } = await getPrompts(userEmail);
  const { chaptersFlat } = await loadOrderedBookContents(session.book_id, { includeExcluded: true });
  const chapterNames = new Map((chaptersFlat || []).map(c => [c.id, c.path || c.name]));
  const state = loadBoardState(session.book_id, userEmail, chapterNames);
  const settings = getBookSettings(session.book_id, userEmail);
  return {
    state,
    bookContext: getResearchPromptContext(`${settings.language || 'de'}-${settings.region || 'CH'}`, {
      buchtyp: settings.buchtyp || null,
      buchKontext: settings.buch_kontext || null,
      hauptland: settings.schauplatz_land || null,
    }),
    boardOutline: boardOutline(state),
    figurenOutline: figurenOutline(state),
    proposalMemory: buildPlotProposalMemoryBlock(sessionPlotProposalMemory(session.id)),
    toolCtx: {
      bookId: session.book_id, sessionId: session.id, userEmail,
      chapterNames, _board: state, readToolNames: new Set(),
    },
  };
}

const EMPTY_MARKERS = new Set(['__i18n:chat.errors.maxIterReached__', '__i18n:chat.errors.emptyAnswer__']);
// Nur Vorschläge, kein Text → eigener Hinweis statt „Iterationen erschöpft".
function _proposalsOnlyFallback(antwort, n) {
  const a = String(antwort || '').trim();
  return n > 0 && (!a || EMPTY_MARKERS.has(a)) ? '__i18n:plot.chat.proposalsOnly__' : a;
}

const runPlotChatJob = makeAgenticChatJob({
  startLabel: 'Plot-Chat',
  errLabel: 'Plot-Chat',
  callProvider: undefined,
  resolveProvider: (userEmail) => resolveProvider({ userEmail }),

  loadSession: (sessionId, userEmail) => getSessionWithBookName(parseInt(sessionId), userEmail, 'plot'),

  async prepare({ session, userEmail, aiCfg, logger, jobSignal, message, history }) {
    const {
      buildPlotChatSystemPrompt, BOOK_CHAT_TOOLS,
      PLOT_CHAT_PROPOSE_TOOLS, PLOT_CHAT_READ_TOOL_NAMES, PLOT_CHAT_SLIM_READ_TOOL_NAMES,
      PLOT_CHAT_FORCE_FINAL_INSTRUCTION,
    } = await getPrompts(userEmail);
    const provider = resolveProvider({ userEmail });
    const maxToolIter = _maxToolIter(provider, userEmail);
    const slim = providerClass(provider, { userEmail }) === 'local';
    const wanted = new Set(slim ? PLOT_CHAT_SLIM_READ_TOOL_NAMES : PLOT_CHAT_READ_TOOL_NAMES);
    const embOn = embed.isEnabled();
    const readTools = BOOK_CHAT_TOOLS.filter(t => wanted.has(t.name) && (t.name !== 'search_similar' || embOn));
    const tools = [...readTools, ...PLOT_CHAT_PROPOSE_TOOLS];

    const base = await plotChatContext(session, userEmail);
    // Erst-Kontext wie im agentischen Buch-Chat: die semantisch nächsten Passagen zur
    // Frage (+ letzte Runde) stehen schon in Iteration 1 im Prompt — eine Frage wie
    // „passt der Beat zu dem, was in Kapitel 3 steht?" braucht dann oft keine
    // Lese-Runde. Pro Frage andere Bytes → im ungecachten Block 2 am Ende (siehe
    // buildPlotChatSystemPrompt). Non-fatal; ohne Embedding-Endpunkt kein Block.
    const preContext = embOn
      ? await agentPreContext(session.book_id, retrievalQuery(message, history), { signal: jobSignal, logger, userEmail })
      : null;
    const systemPrompt = buildPlotChatSystemPrompt(session.book_name || '', {
      mode: 'agent',
      passages: embOn ? (preContext?.hits || []) : null,
      maxToolIter,
      toolNames: tools.map(t => t.name),
      bookContext: base.bookContext,
      boardOutline: base.boardOutline,
      figurenOutline: base.figurenOutline,
      proposalMemory: base.proposalMemory,
    });
    const toolResultCap = _toolResultCapChars(maxToolIter, aiCfg);
    logger.info(`Plot-Chat: ${tools.length} Werkzeuge (${slim ? 'slim' : 'voll'}), max ${maxToolIter} Iterationen, `
      + `Board ${base.state.acts.length} Akte/${base.state.beats.length} Beats/${base.state.threads.length} Stränge, Provider=${provider}.`);
    return {
      systemPrompt,
      tools,
      maxToolIter,
      tokenBudget: aiCfg.inputBudgetTokens,
      toolResultCap,
      forceFinalInstruction: PLOT_CHAT_FORCE_FINAL_INSTRUCTION,
      ctx: {
        ...base.toolCtx,
        jobSignal, logger,
        resultCapChars: toolResultCap,
        inputBudgetChars: aiCfg.inputBudgetChars,
        readToolNames: new Set(readTools.map(t => t.name)),
        proposals: [],
        preContext: preContext ? { count: preContext.hits.length, chars: preContext.chars } : null,
      },
    };
  },

  executeTool: (name, input, ctx) => executePlotChatTool(name, input, ctx),

  consumeFinalAnswer: ({ finalUse, ctx, toolLog, iterNum, logger }) => {
    const raw = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
    const antwort = _proposalsOnlyFallback(raw, ctx?.proposals?.length || 0);
    toolLog.push({ name: 'final_answer', input: { antwort_chars: antwort.length }, ok: true, durationMs: 0, resultBytes: antwort.length, truncated: false, iter: iterNum });
    logger.info(`tool=final_answer antwort_chars=${antwort.length} iter=${iterNum} (terminal)`);
    return JSON.stringify({ antwort });
  },

  parseFinal: (finalText, logger) => {
    let antwort = '';
    try { antwort = JSON.parse(finalText)?.antwort || ''; }
    catch {
      logger.warn('Plot-Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
      antwort = stripTrailingEmptyJson(finalText) || finalText;
    }
    return antwort || '__i18n:chat.errors.maxIterReached__';
  },

  buildContextInfo: ({ toolLog, iter, ctx, stopReason, costUsd }) => ({
    mode: 'plot',
    tool_calls: toolLog,
    iterations: iter + 1,
    ...(stopReason ? { stop_reason: stopReason } : {}),
    ...(costUsd > 0 ? { cost_usd: Math.round(costUsd * 10000) / 10000 } : {}),
    ...(ctx.proposals.length ? { proposals: ctx.proposals } : {}),
    ...(ctx.preContext ? { pre_context: ctx.preContext } : {}),
  }),

  buildCompletePayload: ({ base, ctx }) => ({ ...base, proposals: ctx.proposals.length }),

  buildSummary: ({ sessionId, toolLog, iter, ctx }) =>
    `Plot-Chat session=${sessionId}, ${toolLog.length} Tool-Calls, ${iter + 1} Iter, ${ctx.proposals.length} Vorschläge`,

  // Endpunkt lehnt Function-Calling erst zur Laufzeit ab → dieselbe Frage klassisch.
  fallbackJob: runPlotChatJobClassic,
});

/** Pfadwahl am EFFEKTIVEN Provider (KI-Profil vor globalem `ai.provider`). */
function plotChatUsesTools(userEmail) {
  return providerSupportsTools(resolveProvider({ userEmail }));
}

function runPlotChatJobDispatch(jobId, sessionId, userMsgId, message, userEmail) {
  return plotChatUsesTools(userEmail)
    ? runPlotChatJob(jobId, sessionId, userMsgId, message, userEmail)
    : runPlotChatJobClassic(jobId, sessionId, userMsgId, message, userEmail);
}

module.exports = {
  runPlotChatJob, runPlotChatJobDispatch, plotChatUsesTools, plotChatContext, _proposalsOnlyFallback,
};
