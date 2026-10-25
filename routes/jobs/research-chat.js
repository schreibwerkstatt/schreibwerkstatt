'use strict';
// Agentischer Recherche-Chat mit Web-Suche. Lebt als
// Panel in der Recherche-Karte. Rückwärtsgewandt: recherchiert + sammelt Material,
// schreibt NIE in den Buchtext. Vorschläge (propose_research_item) werden NICHT
// automatisch gespeichert — sie kommen in context_info.proposals zurück, der User
// bestätigt sie im Frontend (POST /research).
//
// Loop/Persistenz teilt sich diese Datei mit den anderen agentischen Chats über
// makeAgenticChatJob (routes/jobs/agentic-chat.js), Werkzeugsatz und Deckel über
// chat-tools/select.js und agentic-chat/limits.js; hier nur die Recherche-
// spezifischen Achsen (Web-Suche, Vorschläge, Quellen-Validierung).
//
// Suchweg (lib/websearch#webSearchMode): 'anthropic' = Claude mit Anthropics
// serverseitigem web_search; 'searxng' = jeder Provider mit Tool-Calling, Suche
// und Seitenlesen als Function-Tools (./research-web-tools.js).

const { getBookSettings } = require('../../db/schema');
const { countActiveResearchItems } = require('../../db/book-chat/research');
const { getPrompts, i18nError } = require('./shared');
const { researchChatGate } = require('../../lib/research-chat-gate');
const {
  toolsForRound, validateAnswerSources, sessionProposalMemory, proposalsOnlyFallback,
  readMessageContext, loadResearchContext,
} = require('./research-chat-helpers');
const { executeResearchTool } = require('./research-chat-tools');
const { entityList } = require('./chat-tools/tools-research');
const { prepareChatTools } = require('./chat-tools/select');
const { maxToolIterFor, agentLimits } = require('./agentic-chat/limits');
const { makeAgenticChatJob, stripTrailingEmptyJson } = require('./agentic-chat');
const appSettings = require('../../lib/app-settings');
const { getSessionWithBookName } = require('../../db/chat-sessions');
const { resolveProvider } = require('../../lib/ai');
const { webSearchMode } = require('../../lib/websearch');
const { extractUrls, MAX_PAGE_READS, PAGE_TEXT_MAX, PAGE_OVERHEAD } = require('./research-web-tools');

function _maxWebSearches() {
  return parseInt(appSettings.get('jobs.research_chat.max_web_searches'), 10) || 10;
}
// Eigener Deckel für read_web_page: der allgemeine rechnet, als könne jeder Aufruf
// jeder Runde voll ausfallen, und schnitt Seiten bei ~4K ab — eine Tabellenzeile
// weiter unten erreichte das Modell nie. Seitenaufrufe zählt der Handler selbst
// (MAX_PAGE_READS); alle zusammen bekommen höchstens 40 % des Input-Budgets, der
// Rest bleibt System-Prompt, Verlauf und Suchtreffern. Nie unter dem allgemeinen
// Deckel, nie über PAGE_TEXT_MAX samt Hülle.
function _pageResultCapChars(generalCap, aiCfg) {
  const share = Math.floor((aiCfg.inputBudgetChars * 0.4) / MAX_PAGE_READS);
  return Math.max(generalCap, Math.min(PAGE_TEXT_MAX + PAGE_OVERHEAD, share));
}

const runResearchChatJob = makeAgenticChatJob({
  startLabel: 'Recherche-Chat',
  errLabel: 'Recherche-Chat',
  // Effektiver Provider des Users (KI-Profil > global). Ob er suchen kann, prüft
  // das Gate (validate); das Frontend blendet das Panel nach demselben Gate aus.
  callProvider: undefined,
  resolveProvider: (userEmail) => resolveProvider({ userEmail }),
  effortSettingKey: 'ai.claude.effort.researchchat',
  // Dieselbe Prüfung blockt schon POST /jobs/research-chat (vor dem Speichern der
  // Frage); hier nochmals, weil Setting/Provider zwischen POST und Queue-Start
  // wechseln können.
  validate: ({ userEmail }) => {
    const block = researchChatGate(userEmail);
    if (block) throw i18nError(block.i18nKey);
  },

  loadSession: (sessionId, userEmail) => getSessionWithBookName(parseInt(sessionId), userEmail, 'research'),

  async prepare({ session, userEmail, aiCfg, logger, jobSignal, userMsgId, message }) {
    const prompts = await getPrompts(userEmail);
    const {
      buildResearchChatAgentSystemPrompt, buildResearchChatTools, buildResearchProposalMemoryBlock,
      getResearchPromptContext, RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION, RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION_SEARXNG, buildResearchWritingContextBlock,
    } = prompts;
    const itemCount = countActiveResearchItems(session.book_id);
    const provider = resolveProvider({ userEmail });
    const maxToolIter = maxToolIterFor('jobs.research_chat.max_tool_iter', 6, provider, userEmail);
    const limits = agentLimits(maxToolIter, aiCfg);
    const maxWebSearches = _maxWebSearches();
    const mode = webSearchMode(userEmail);
    const searxng = mode === 'searxng';
    // Figuren + Schauplätze vorladen, damit das Modell den Welt-Kontext schon in
    // der ersten Web-Suche nutzen kann (ohne Werkzeug-Runde). Gleiche Quelle wie
    // das Werkzeug list_book_entities → kein Drift.
    const entityCtx = { bookId: session.book_id, userEmail };
    const figures = entityList('figur', entityCtx);
    const locations = entityList('ort', entityCtx);
    // Recherche-Profil des Buchs (Freitext + Domain-Eingrenzung). Geht doppelt in
    // den Call: als Klartext in den System-Prompt UND als `allowed_domains` ans
    // serverseitige web_search — nur das Werkzeug grenzt wirklich ein, nur der
    // Prompt sagt dem Modell, DASS es eingegrenzt ist.
    const bookSettings = getBookSettings(session.book_id, userEmail);
    const researchProfile = {
      text: bookSettings.research_profile || '',
      domains: bookSettings.research_domains || [],
    };
    // Buch-Kontext: NUR Sprachnorm + Buchtyp/Autoren-Angaben/Hauptland — nicht der
    // ganze Buch-Chat-Prompt. Dessen Persona („kritischer Lektor, Feedback zu Stil")
    // überstimmte sonst das Verbot von Stil-Vorschlägen weiter oben.
    const bookContext = getResearchPromptContext(`${bookSettings.language || 'de'}-${bookSettings.region || 'CH'}`, {
      buchtyp: bookSettings.buchtyp || null,
      buchKontext: bookSettings.buch_kontext || null,
      hauptland: bookSettings.schauplatz_land || null,
    });
    // Werkzeugsatz wie in allen agentischen Chats (chat-tools/select.js): Lese-Werkzeuge
    // der Spalte `research`, ohne Daten/Endpunkt (leeres Archiv, keine Embeddings)
    // weggelassen, plus Web- und Ausgabe-Werkzeuge des Suchwegs. Anthropic: ein
    // Web-Such-Deckel kleiner als der Rundenwert greift schon hier (max_uses =
    // Deckel); bei aufgebrauchtem Deckel fällt web_search vor dem Rendern weg, damit
    // keine Beschreibung es noch nennt. SearXNG: den Deckel hält der Handler. Die
    // Liste bleibt danach für den ganzen Lauf gleich (Prompt-Cache).
    const outputTools = buildResearchChatTools({ allowedDomains: researchProfile.domains, webSearchMode: mode });
    const { tools, toolNames, offeredTools, unavailable } = prepareChatTools({
      chat: 'research', prompts, provider, userEmail,
      ctx: { bookId: session.book_id, sessionId: session.id, userEmail, logger },
      outputTools: searxng ? outputTools : toolsForRound(outputTools, 0, maxWebSearches),
    });
    // Frühere Vorschläge dieser Session (gespeichert ja/nein) — Folge-Turns sollen
    // sie kennen, ohne dass sie in der Gesprächshistorie stehen.
    const proposalMemory = buildResearchProposalMemoryBlock(sessionProposalMemory(session.id), { toolNames });
    // Schreibkontext DIESER Frage (Kontext-Chip): an der User-Nachricht abgelegt
    // (_handleChatPost → context_info.research_context). Ein Lesefehler kostet
    // nur den Block, nicht die Antwort.
    let writingContext = '';
    try {
      const wc = await loadResearchContext(readMessageContext(userMsgId), session.book_id);
      writingContext = buildResearchWritingContextBlock(wc, { toolNames });
    } catch (e) {
      logger.warn(`Schreibkontext nicht geladen: ${e.message}`);
    }
    const systemPrompt = buildResearchChatAgentSystemPrompt(
      session.book_name || '', itemCount, maxToolIter, figures, locations, researchProfile,
      { maxWebSearches, bookContext, proposalMemory, writingContext, webSearchMode: mode, toolNames },
    );

    // Deckel wie in allen agentischen Chats; gelesene Webseiten (SearXNG) bekommen
    // ihren eigenen, grösseren Deckel — die API wertet Seiten beim Suchweg
    // Anthropic selbst aus.
    const toolResultCap = limits.toolResultCap;
    const pageResultCap = searxng ? _pageResultCapChars(toolResultCap, aiCfg) : null;
    logger.info(`Recherche-Chat: Suchweg=${mode}, ${tools.length} Werkzeuge${unavailable.length ? ` (ohne Daten/Endpunkt: ${unavailable.join(', ')})` : ''}, Ergebnis-Deckel ${toolResultCap} Zeichen${pageResultCap ? ` (Seiten ${pageResultCap})` : ''}.`);

    return {
      systemPrompt,
      tools,
      // Web-Such-Gesamtdeckel über alle Runden: erreicht → keine weitere Runde,
      // Synthese aus den Treffern. webSearches zählt beide Wege (Loop + webStats).
      stopBeforeRound: ({ webSearches }) => (webSearches >= maxWebSearches ? 'web_cap' : null),
      // Suchen des SearXNG-Handlers (ctx.web) für Deckel, context_info, Zusammenfassung.
      webStats: (ctx) => (ctx.web ? { searches: ctx.web.searches, queries: ctx.web.queries, results: ctx.web.results } : null),
      maxToolIter,
      tokenBudget: aiCfg.inputBudgetTokens,
      toolResultCap,
      ...(searxng ? { toolResultCaps: { read_web_page: pageResultCap } } : {}),
      maxToolsPerRound: limits.maxToolsPerRound,
      roundResultCapChars: limits.roundResultCapChars,
      inputTokenCap: limits.inputTokenCap,
      forceFinalInstruction: searxng ? RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION_SEARXNG : RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION,
      ctx: {
        bookId: session.book_id, sessionId: session.id, userEmail,
        jobSignal, logger, offeredTools,
        proposals: [], // propose_research_item sammelt hier; nach dem Loop in context_info
        answerSourcesRaw: null, // final_answer.quellen (ungeprüft) → buildContextInfo validiert
        literatureHits: [],     // lookup_literature-Treffer (url/title) — zulässige Belege neben den Web-Treffern
        maxWebSearches,
        // Nur vom SearXNG-Handler gelesen (research-web-tools.js):
        allowedDomains: researchProfile.domains,
        searchLanguage: bookSettings.language || '',
        userMessageUrls: extractUrls(message),
        resultCapChars: toolResultCap,
        ...(pageResultCap ? { pageResultCapChars: pageResultCap } : {}),
      },
    };
  },

  executeTool: (name, input, ctx) => executeResearchTool(name, input, ctx),

  // Recherche kennt keine Zitat-Validierung — antwort schlicht extrahieren.
  consumeFinalAnswer: ({ finalUse, ctx, toolLog, iterNum, logger }) => {
    const raw = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
    // Leere Antwort trotz Vorschlägen ist kein Abbruch: eigener Hinweis statt
    // „Iterationen erschöpft".
    const antwort = proposalsOnlyFallback(raw, ctx?.proposals?.length || 0);
    if (ctx && Array.isArray(finalUse.input?.quellen)) ctx.answerSourcesRaw = finalUse.input.quellen;
    toolLog.push({ name: 'final_answer', input: { antwort_chars: antwort.length }, ok: true, durationMs: 0, resultBytes: antwort.length, truncated: false, iter: iterNum });
    logger.info(`tool=final_answer antwort_chars=${antwort.length} iter=${iterNum} (terminal)`);
    return JSON.stringify({ antwort });
  },

  parseFinal: (finalText) => {
    let antwort = '';
    try { antwort = JSON.parse(finalText)?.antwort || ''; }
    catch { antwort = stripTrailingEmptyJson(finalText) || finalText; }
    if (!antwort) antwort = '__i18n:chat.errors.maxIterReached__';
    return antwort;
  },

  buildContextInfo: ({ toolLog, iter, webSearches, webResults, webQueries, ctx, stopReason, costUsd }) => ({
    mode: 'research',
    tool_calls: toolLog,
    iterations: iter + 1,
    web_searches: webSearches,
    web_search_cap: ctx.maxWebSearches,
    ...(stopReason ? { stop_reason: stopReason } : {}),
    // Kosten dieser Antwort (Tokens + Web-Suchen, lib/pricing) — UI zeigt sie am Fuss.
    ...(Number.isFinite(costUsd) ? { cost_usd: Math.round(costUsd * 10000) / 10000 } : {}),
    // Gelaufene Suchbegriffe (server_tool_use.input.query), falls der Loop sie liefert.
    ...(Array.isArray(webQueries) && webQueries.length ? { web_queries: webQueries.slice(0, 50) } : {}),
    // Web-Such-Trefferdokumente in Auftrittsreihenfolge (1-basiert). Das Frontend
    // löst die `<cite index="N-…">`-Marker des Modells über die Position N auf und
    // rendert klickbare Quell-Links + eine Quellenliste.
    ...(webResults.length ? { sources: webResults } : {}),
    // Vom Modell benannte Belege (final_answer.quellen), gegen webResults geprüft.
    // Das Frontend bevorzugt sie vor den cite-Markern (robuster als Index-Zuordnung).
    ...(() => {
      // Zulässige Belege neben den Treffern: Literatur-Register und gelesene Seiten
      // (read_web_page, inkl. Redirect-Ziel).
      const answerSources = validateAnswerSources(ctx.answerSourcesRaw, webResults, {
        extra: [...ctx.literatureHits, ...(ctx.web?.pages || [])],
      });
      return answerSources.length ? { answer_sources: answerSources } : {};
    })(),
    // Speicher-Vorschläge — Frontend rendert sie als „Als … speichern"-Buttons.
    ...(ctx.proposals.length ? { proposals: ctx.proposals } : {}),
  }),

  buildCompletePayload: ({ base, ctx }) => ({ ...base, proposals: ctx.proposals.length }),

  buildSummary: ({ sessionId, toolLog, webSearches, ctx }) =>
    `Recherche-Chat session=${sessionId}, ${toolLog.length} Tool-Calls, ${webSearches} Web-Suchen, ${ctx.proposals.length} Vorschläge`,
});

module.exports = { runResearchChatJob };
