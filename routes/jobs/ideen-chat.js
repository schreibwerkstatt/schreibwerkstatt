'use strict';
// Ideen-Chat (Panel im Ideen-Board, kind='ideen'). Arbeitet die Pendenzen und
// Einfälle eines Buches im Gespräch durch: prüft offene Ideen gegen den Text
// (Erledigt-Check), sucht Buch-Ideen einen Ort, findet Dubletten, schlägt
// Verknüpfungen und neue Ideen vor. Vorschläge landen in context_info.proposals
// und werden NICHT geschrieben — der User übernimmt jeden einzeln (Frontend:
// public/js/chat/ideen-chat-proposals.js).
//
// Jeder Provider: mit Werkzeug-Protokoll agentisch (Lese-Werkzeuge des Buch-Chats
// + propose_*), sonst klassisch in einem JSON-Call. Beide Pfade, die Weiche und
// der Laufzeit-Rückfall kommen aus makeProposalChatJob (proposal-chat.js); hier
// stehen nur Ideen-Kontext und Prompt-Bausteine.
// Deep-Doc: docs/ideen-chat.md

const { getBookSettings } = require('../../db/schema');
const { getPrompts, loadOrderedBookContents } = require('./shared');
const { makeProposalChatJob } = require('./proposal-chat');
const { executeIdeenChatTool, PROPOSE_TOOLS } = require('./ideen-chat-tools');
const {
  loadIdeenState, fitIdeenOutline, gliederungOutline, targetsOutline, sessionIdeenProposalMemory,
} = require('./ideen-chat-context');

/**
 * Kontext beider Pfade: Ideen-Stand, Prompt-Bausteine (Ideenliste, Gliederung,
 * Link-Ziele, Gedächtnis, Buch-Kontext) und die Felder, die die Vorschlags-
 * Handler im ctx brauchen. Gliederung nur über die Content-Store-Facade, inkl.
 * ausgeschlossener Kapitel (eine Idee darf dort hängen).
 */
async function ideenChatContext(session, userEmail, { outlineBudgetChars = Infinity } = {}) {
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
    ideen: fitIdeenOutline(state, { budgetChars: outlineBudgetChars }),
    gliederungOutline: gliederungOutline(state),
    targetsOutline: targetsOutline(state),
    stages: state.stages,
    proposalMemory: buildIdeenProposalMemoryBlock(sessionIdeenProposalMemory(session.id, state)),
    toolCtx: {
      bookId: session.book_id, sessionId: session.id, userEmail,
      tree, _ideen: state,
    },
  };
}

const ideenChat = makeProposalChatJob({
  kind: 'ideen',
  label: 'Ideen-Chat',
  maxIterSettingKey: 'jobs.ideen_chat.max_tool_iter',
  effortSettingKey: 'ai.claude.effort.ideenchat',
  proposalsOnlyMarker: '__i18n:ideenBoard.chat.proposalsOnly__',
  proposalsCutMarker: '__i18n:ideenBoard.chat.proposalsCut__',
  prompts: (p) => ({
    buildSystemPrompt: p.buildIdeenChatSystemPrompt,
    schemaClassic: p.SCHEMA_IDEEN_CHAT_CLASSIC,
    proposeTools: p.IDEEN_CHAT_PROPOSE_TOOLS,
    forceFinalInstruction: p.IDEEN_CHAT_FORCE_FINAL_INSTRUCTION,
  }),
  loadContext: ideenChatContext,
  promptParts: (base) => ({
    bookContext: base.bookContext,
    ideenOutline: base.ideen.text,
    ideenTrimmed: base.ideen.trimmed,
    gliederungOutline: base.gliederungOutline,
    targetsOutline: base.targetsOutline,
    stages: base.stages,
    proposalMemory: base.proposalMemory,
  }),
  stateSummary: (s) => `${s.ideen.length} Ideen, ${s.pages.length} Abschnitte`,
  executeTool: executeIdeenChatTool,
  proposeToolNames: PROPOSE_TOOLS,
  classicFallbackNote: 'nur Ideen/Gliederung',
});

module.exports = {
  runIdeenChatJob: ideenChat.runAgent,
  runIdeenChatJobClassic: ideenChat.runClassic,
  runIdeenChatJobDispatch: ideenChat.runDispatch,
  ideenChatUsesTools: ideenChat.usesTools,
  collectClassicProposals: ideenChat.collectClassicProposals,
  _proposalsOnlyFallback: ideenChat.proposalsOnlyFallback,
  ideenChatContext,
};
