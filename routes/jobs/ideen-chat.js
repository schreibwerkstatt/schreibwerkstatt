'use strict';
// Ideen-Chat (Panel im Ideen-Board, kind='ideen'). Arbeitet die Pendenzen und
// Einfälle eines Buches im Gespräch durch: prüft offene Ideen gegen den Text
// (Erledigt-Check), sucht Buch-Ideen einen Ort, findet Dubletten, schlägt
// Verknüpfungen und neue Ideen vor. Vorschläge landen in context_info.proposals
// und werden NICHT geschrieben — der User übernimmt jeden einzeln (Frontend:
// public/js/chat/ideen-chat-proposals.js).
//
// Jeder Provider: mit Werkzeug-Protokoll agentisch (dieses Modul, Lese-Werkzeuge
// des Buch-Chats + propose_*), sonst klassisch in einem JSON-Call
// (ideen-chat-classic.js). `runIdeenChatJobDispatch` wählt; lehnt ein Endpunkt
// Function-Calling erst zur Laufzeit ab, übernimmt der klassische Pfad denselben
// Job (fallbackJob). Loop/Persistenz: makeAgenticChatJob (agentic-chat.js).
// Deep-Doc: docs/ideen-chat.md

const { getBookSettings } = require('../../db/schema');
const { resolveProvider, providerClass, providerSupportsTools } = require('../../lib/ai');
const { getPrompts, loadOrderedBookContents } = require('./shared');
const { makeAgenticChatJob, stripTrailingEmptyJson } = require('./agentic-chat');
const { executeIdeenChatTool } = require('./ideen-chat-tools');
const {
  loadIdeenState, ideenOutline, gliederungOutline, targetsOutline, sessionIdeenProposalMemory,
} = require('./ideen-chat-context');
const { runIdeenChatJobClassic } = require('./ideen-chat-classic');
const embed = require('../../lib/embed');
const appSettings = require('../../lib/app-settings');
const { getSessionWithBookName } = require('../../db/chat-sessions');
const { agentPreContext, retrievalQuery } = require('./chat/book-chat-retrieval');

function _maxToolIter(provider, userEmail) {
  const base = parseInt(appSettings.get('jobs.ideen_chat.max_tool_iter'), 10) || 8;
  // Lokale Provider zahlen jede Runde den vollen Prompt erneut (kein Caching) —
  // derselbe lokale Deckel wie Buch- und Plot-Chat.
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
 * Kontext beider Pfade: Ideen-Stand, Prompt-Bausteine (Ideenliste, Gliederung,
 * Link-Ziele, Gedächtnis, Buch-Kontext) und die Felder, die die Vorschlags-
 * Handler im ctx brauchen. Gliederung nur über die Content-Store-Facade, inkl.
 * ausgeschlossener Kapitel (eine Idee darf dort hängen).
 */
async function ideenChatContext(session, userEmail) {
  const { buildIdeenProposalMemoryBlock, getResearchPromptContext } = await getPrompts(userEmail);
  const tree = await loadOrderedBookContents(session.book_id, { includeExcluded: true });
  const state = loadIdeenState(session.book_id, userEmail, tree);
  const settings = getBookSettings(session.book_id, userEmail);
  return {
    state,
    bookContext: getResearchPromptContext(`${settings.language || 'de'}-${settings.region || 'CH'}`, {
      buchtyp: settings.buchtyp || null,
      buchKontext: settings.buch_kontext || null,
      hauptland: settings.schauplatz_land || null,
    }),
    ideenOutline: ideenOutline(state),
    gliederungOutline: gliederungOutline(state),
    targetsOutline: targetsOutline(state),
    stages: state.stages,
    proposalMemory: buildIdeenProposalMemoryBlock(sessionIdeenProposalMemory(session.id)),
    toolCtx: {
      bookId: session.book_id, sessionId: session.id, userEmail,
      tree, _ideen: state, readToolNames: new Set(),
    },
  };
}

const EMPTY_MARKERS = new Set(['__i18n:chat.errors.maxIterReached__', '__i18n:chat.errors.emptyAnswer__']);
// Nur Vorschläge, kein Text → eigener Hinweis statt „Iterationen erschöpft".
function _proposalsOnlyFallback(antwort, n) {
  const a = String(antwort || '').trim();
  return n > 0 && (!a || EMPTY_MARKERS.has(a)) ? '__i18n:ideenBoard.chat.proposalsOnly__' : a;
}

const runIdeenChatJob = makeAgenticChatJob({
  startLabel: 'Ideen-Chat',
  errLabel: 'Ideen-Chat',
  callProvider: undefined,
  resolveProvider: (userEmail) => resolveProvider({ userEmail }),

  loadSession: (sessionId, userEmail) => getSessionWithBookName(parseInt(sessionId), userEmail, 'ideen'),

  async prepare({ session, userEmail, aiCfg, logger, jobSignal, message, history }) {
    const {
      buildIdeenChatSystemPrompt, BOOK_CHAT_TOOLS,
      IDEEN_CHAT_PROPOSE_TOOLS, IDEEN_CHAT_READ_TOOL_NAMES, IDEEN_CHAT_SLIM_READ_TOOL_NAMES,
      IDEEN_CHAT_FORCE_FINAL_INSTRUCTION,
    } = await getPrompts(userEmail);
    const provider = resolveProvider({ userEmail });
    const maxToolIter = _maxToolIter(provider, userEmail);
    const slim = providerClass(provider, { userEmail }) === 'local';
    const wanted = new Set(slim ? IDEEN_CHAT_SLIM_READ_TOOL_NAMES : IDEEN_CHAT_READ_TOOL_NAMES);
    const embOn = embed.isEnabled();
    const readTools = BOOK_CHAT_TOOLS.filter(t => wanted.has(t.name) && (t.name !== 'search_similar' || embOn));
    const tools = [...readTools, ...IDEEN_CHAT_PROPOSE_TOOLS];

    const base = await ideenChatContext(session, userEmail);
    // Erst-Kontext wie im Plot-Chat: die semantisch nächsten Passagen zur Frage
    // (+ letzte Runde) stehen schon in Iteration 1 im Prompt. Non-fatal; ohne
    // Embedding-Endpunkt kein Block.
    const preContext = embOn
      ? await agentPreContext(session.book_id, retrievalQuery(message, history), { signal: jobSignal, logger, userEmail })
      : null;
    const systemPrompt = buildIdeenChatSystemPrompt(session.book_name || '', {
      mode: 'agent',
      passages: embOn ? (preContext?.hits || []) : null,
      maxToolIter,
      toolNames: tools.map(t => t.name),
      bookContext: base.bookContext,
      ideenOutline: base.ideenOutline,
      gliederungOutline: base.gliederungOutline,
      targetsOutline: base.targetsOutline,
      stages: base.stages,
      proposalMemory: base.proposalMemory,
    });
    const toolResultCap = _toolResultCapChars(maxToolIter, aiCfg);
    logger.info(`Ideen-Chat: ${tools.length} Werkzeuge (${slim ? 'slim' : 'voll'}), max ${maxToolIter} Iterationen, `
      + `${base.state.ideen.length} Ideen, ${base.state.pages.length} Abschnitte, Provider=${provider}.`);
    return {
      systemPrompt,
      tools,
      maxToolIter,
      tokenBudget: aiCfg.inputBudgetTokens,
      toolResultCap,
      forceFinalInstruction: IDEEN_CHAT_FORCE_FINAL_INSTRUCTION,
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

  executeTool: (name, input, ctx) => executeIdeenChatTool(name, input, ctx),

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
      logger.warn('Ideen-Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
      antwort = stripTrailingEmptyJson(finalText) || finalText;
    }
    return antwort || '__i18n:chat.errors.maxIterReached__';
  },

  buildContextInfo: ({ toolLog, iter, ctx, stopReason, costUsd }) => ({
    mode: 'ideen',
    tool_calls: toolLog,
    iterations: iter + 1,
    ...(stopReason ? { stop_reason: stopReason } : {}),
    ...(costUsd > 0 ? { cost_usd: Math.round(costUsd * 10000) / 10000 } : {}),
    ...(ctx.proposals.length ? { proposals: ctx.proposals } : {}),
    ...(ctx.preContext ? { pre_context: ctx.preContext } : {}),
  }),

  buildCompletePayload: ({ base, ctx }) => ({ ...base, proposals: ctx.proposals.length }),

  buildSummary: ({ sessionId, toolLog, iter, ctx }) =>
    `Ideen-Chat session=${sessionId}, ${toolLog.length} Tool-Calls, ${iter + 1} Iter, ${ctx.proposals.length} Vorschläge`,

  // Endpunkt lehnt Function-Calling erst zur Laufzeit ab → dieselbe Frage klassisch.
  fallbackJob: runIdeenChatJobClassic,
});

/** Pfadwahl am EFFEKTIVEN Provider (KI-Profil vor globalem `ai.provider`). */
function ideenChatUsesTools(userEmail) {
  return providerSupportsTools(resolveProvider({ userEmail }));
}

function runIdeenChatJobDispatch(jobId, sessionId, userMsgId, message, userEmail) {
  return ideenChatUsesTools(userEmail)
    ? runIdeenChatJob(jobId, sessionId, userMsgId, message, userEmail)
    : runIdeenChatJobClassic(jobId, sessionId, userMsgId, message, userEmail);
}

module.exports = {
  runIdeenChatJob, runIdeenChatJobDispatch, ideenChatUsesTools, ideenChatContext, _proposalsOnlyFallback,
};
