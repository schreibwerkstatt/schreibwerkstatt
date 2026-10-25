'use strict';
// Plot-Chat (Panel in der Plot-Werkstatt, kind='plot'). Entwickelt das Beat-Board
// im Gespräch und gibt Board-Änderungen als Vorschläge ab. Vorschläge landen in
// context_info.proposals und werden NICHT geschrieben — der User übernimmt jeden
// einzeln (Frontend: public/js/chat/plot-chat-proposals.js).
//
// Jeder Provider: mit Werkzeug-Protokoll agentisch (Lese-Werkzeuge des Buch-Chats
// + propose_*), sonst klassisch in einem JSON-Call. Beide Pfade, die Weiche und
// der Laufzeit-Rückfall kommen aus makeProposalChatJob (proposal-chat.js); hier
// stehen nur Board-Kontext und Prompt-Bausteine.
// Deep-Doc: docs/plot-chat.md

const { getBookSettings } = require('../../db/schema');
const { getPrompts, loadOrderedBookContents } = require('./shared');
const { makeProposalChatJob } = require('./proposal-chat');
const { executePlotChatTool, PROPOSE_TOOLS } = require('./plot-chat-tools');
const {
  loadBoardState, boardOutline, figurenOutline, sessionPlotProposalMemory,
} = require('./plot-chat-context');

/**
 * Kontext beider Pfade: Board-Stand, Prompt-Bausteine (Board-Gliederung,
 * Figurenliste, Gedächtnis früherer Vorschläge, Buch-Kontext) und die Felder,
 * die die Vorschlags-Handler im ctx brauchen. Kapitel nur über die
 * Content-Store-Facade, inkl. ausgeschlossener (ein Beat darf darauf zeigen).
 */
async function plotChatContext(session, userEmail) {
  const { buildPlotProposalMemoryBlock, getResearchPromptContext, ideenMarker } = await getPrompts(userEmail);
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
    boardOutline: boardOutline(state, { ideenMarker }),
    figurenOutline: figurenOutline(state),
    proposalMemory: buildPlotProposalMemoryBlock(sessionPlotProposalMemory(session.id)),
    toolCtx: {
      bookId: session.book_id, sessionId: session.id, userEmail,
      chapterNames, _board: state,
    },
  };
}

const plotChat = makeProposalChatJob({
  kind: 'plot',
  label: 'Plot-Chat',
  maxIterSettingKey: 'jobs.plot_chat.max_tool_iter',
  effortSettingKey: 'ai.claude.effort.plotchat',
  proposalsOnlyMarker: '__i18n:plot.chat.proposalsOnly__',
  prompts: (p) => ({
    buildSystemPrompt: p.buildPlotChatSystemPrompt,
    schemaClassic: p.SCHEMA_PLOT_CHAT_CLASSIC,
    proposeTools: p.PLOT_CHAT_PROPOSE_TOOLS,
    forceFinalInstruction: p.PLOT_CHAT_FORCE_FINAL_INSTRUCTION,
  }),
  loadContext: plotChatContext,
  promptParts: (base) => ({
    bookContext: base.bookContext,
    boardOutline: base.boardOutline,
    figurenOutline: base.figurenOutline,
    proposalMemory: base.proposalMemory,
  }),
  stateSummary: (s) => `Board ${s.acts.length} Akte/${s.beats.length} Beats/${s.threads.length} Stränge`,
  executeTool: executePlotChatTool,
  proposeToolNames: PROPOSE_TOOLS,
  // Leere Figurenliste heisst «Figuren vom Beat lösen», nicht «weglassen».
  keepEmptyArrays: ['figuren'],
  classicFallbackNote: 'nur Board/Figuren',
});

module.exports = {
  runPlotChatJob: plotChat.runAgent,
  runPlotChatJobClassic: plotChat.runClassic,
  runPlotChatJobDispatch: plotChat.runDispatch,
  plotChatUsesTools: plotChat.usesTools,
  collectClassicProposals: plotChat.collectClassicProposals,
  _proposalsOnlyFallback: plotChat.proposalsOnlyFallback,
  plotChatContext,
};
