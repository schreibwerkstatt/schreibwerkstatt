'use strict';
// Agentischer Recherche-Chat mit Web-Suche. Lebt als
// Panel in der Recherche-Karte. Rückwärtsgewandt: recherchiert + sammelt Material,
// schreibt NIE in den Buchtext. Vorschläge (propose_research_item) werden NICHT
// automatisch gespeichert — sie kommen in context_info.proposals zurück, der User
// bestätigt sie im Frontend (POST /research).
//
// Loop/Persistenz teilt sich diese Datei mit dem Buch-Chat über
// makeAgenticChatJob (routes/jobs/agentic-chat.js); hier nur die
// Recherche-spezifischen Achsen (eigenes Tool-Set + Web-Suche, ohne
// Seiten-Vorladen/Zitat-Validierung).
//
// Suchweg (lib/websearch#webSearchMode): 'anthropic' = Claude mit Anthropics
// serverseitigem web_search; 'searxng' = jeder Provider mit Tool-Calling, Suche
// und Seitenlesen als Function-Tools (./research-web-tools.js).

const { db, getBookSettings } = require('../../db/schema');
const { getPrompts, i18nError } = require('./shared');
const { researchChatGate } = require('../../lib/research-chat-gate');
const {
  toolsForRound, validateAnswerSources, sessionProposalMemory, proposalsOnlyFallback,
  readMessageContext, loadResearchContext,
} = require('./research-chat-helpers');
const { executeResearchTool, entityList } = require('./research-chat-tools');
const embed = require('../../lib/embed');
const { makeAgenticChatJob, stripTrailingEmptyJson } = require('./agentic-chat');
const appSettings = require('../../lib/app-settings');
const { getSessionWithBookName } = require('../../db/chat-sessions');
const { resolveProvider } = require('../../lib/ai');
const { webSearchMode } = require('../../lib/websearch');
const { extractUrls } = require('./research-web-tools');

function _maxToolIter() {
  return parseInt(appSettings.get('jobs.research_chat.max_tool_iter'), 10) || 6;
}
function _maxWebSearches() {
  return parseInt(appSettings.get('jobs.research_chat.max_web_searches'), 10) || 10;
}
// Per-Tool-Result-Cap im SearXNG-Modus (wie Buch-/Plot-Chat): eine gelesene Seite
// darf das Kontextfenster nicht allein füllen — entscheidend für lokale Modelle.
function _webToolResultCapChars(maxIter, aiCfg) {
  return Math.max(4000, Math.floor(aiCfg.inputBudgetChars / (maxIter * 6)));
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
    const {
      buildResearchChatAgentSystemPrompt, buildResearchChatTools, buildResearchProposalMemoryBlock,
      getResearchPromptContext, RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION, buildResearchWritingContextBlock,
    } = await getPrompts(userEmail);
    const itemCount = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ? AND archived = 0').get(session.book_id)?.n || 0;
    const maxToolIter = _maxToolIter();
    const maxWebSearches = _maxWebSearches();
    const mode = webSearchMode(userEmail);
    const searxng = mode === 'searxng';
    // Figuren + Schauplätze vorladen, damit das Modell den Welt-Kontext schon in
    // der ersten Web-Suche nutzen kann (ohne list_book_entities-Runde). Gleiche
    // Quelle wie das Tool → kein Drift.
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
    // Frühere Vorschläge dieser Session (gespeichert ja/nein) — Folge-Turns sollen
    // sie kennen, ohne dass sie in der Gesprächshistorie stehen.
    const proposalMemory = buildResearchProposalMemoryBlock(sessionProposalMemory(session.id));
    // Schreibkontext DIESER Frage (Kontext-Chip): an der User-Nachricht abgelegt
    // (_handleChatPost → context_info.research_context). Ein Lesefehler kostet
    // nur den Block, nicht die Antwort.
    let writingContext = '';
    try {
      const wc = await loadResearchContext(readMessageContext(userMsgId), session.book_id);
      writingContext = buildResearchWritingContextBlock(wc);
    } catch (e) {
      logger.warn(`Schreibkontext nicht geladen: ${e.message}`);
    }
    const systemPrompt = buildResearchChatAgentSystemPrompt(
      session.book_name || '', itemCount, maxToolIter, figures, locations, researchProfile,
      { maxWebSearches, bookContext, proposalMemory, writingContext, webSearchMode: mode },
    );

    // Ohne Embedding-Endpunkt hat die Passagen-Suche keine Datenbasis — das
    // Werkzeug gar nicht erst anbieten, statt das Modell eine Runde an einen
    // garantierten Fehlschlag zu verlieren.
    const allTools = buildResearchChatTools({ allowedDomains: researchProfile.domains, webSearchMode: mode });
    const tools = embed.isEnabled()
      ? allTools
      : allTools.filter(t => t.name !== 'search_research_passages');

    // SearXNG: gelesene Seiten sind gross → Deckel pro Ergebnis und pro Runde.
    // Anthropic: kein Cap — die Recherche-Tool-Results sind klein und truncieren
    // würde Fundstücke verstümmeln; die Seitenauswertung macht die API selbst.
    const toolResultCap = searxng ? _webToolResultCapChars(maxToolIter, aiCfg) : null;
    logger.info(`Recherche-Chat: Suchweg=${mode}, ${tools.length} Werkzeuge${toolResultCap ? `, Ergebnis-Deckel ${toolResultCap} Zeichen` : ''}.`);

    return {
      systemPrompt,
      // Anthropic: ein Deckel kleiner als der Rundenwert greift schon hier
      // (max_uses = Deckel). SearXNG: das Function-Tool hat kein max_uses, den
      // Deckel hält der Handler. Die Liste bleibt danach für den ganzen Lauf gleich
      // (Prompt-Cache).
      tools: searxng ? tools : toolsForRound(tools, 0, maxWebSearches),
      // Web-Such-Gesamtdeckel über alle Runden: erreicht → keine weitere Runde,
      // Synthese aus den Treffern. webSearches zählt beide Wege (Loop + webStats).
      stopBeforeRound: ({ webSearches }) => (webSearches >= maxWebSearches ? 'web_cap' : null),
      // Suchen des SearXNG-Handlers (ctx.web) für Deckel, context_info, Zusammenfassung.
      webStats: (ctx) => (ctx.web ? { searches: ctx.web.searches, queries: ctx.web.queries, results: ctx.web.results } : null),
      maxToolIter,
      tokenBudget: aiCfg.inputBudgetTokens,
      toolResultCap,
      ...(searxng ? { roundResultCapChars: Math.max(toolResultCap * 2, Math.floor(aiCfg.inputBudgetChars * 0.25)) } : {}),
      forceFinalInstruction: RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION,
      ctx: {
        bookId: session.book_id, sessionId: session.id, userEmail,
        jobSignal, logger,
        proposals: [], // propose_research_item sammelt hier; nach dem Loop in context_info
        answerSourcesRaw: null, // final_answer.quellen (ungeprüft) → buildContextInfo validiert
        literatureHits: [],     // lookup_literature-Treffer (url/title) — zulässige Belege neben den Web-Treffern
        maxWebSearches,
        // Nur vom SearXNG-Handler gelesen (research-web-tools.js):
        allowedDomains: researchProfile.domains,
        searchLanguage: bookSettings.language || '',
        userMessageUrls: extractUrls(message),
        ...(toolResultCap ? { resultCapChars: toolResultCap } : {}),
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
