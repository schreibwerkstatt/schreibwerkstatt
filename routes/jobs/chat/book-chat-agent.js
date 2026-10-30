'use strict';
// Agentischer Buch-Chat (Tool-Use). Loop/Persistenz kommen aus makeAgenticChatJob
// (../agentic-chat.js); hier nur die Buch-Chat-spezifischen Achsen: Provider-
// Override, Werkzeugsatz inkl. generate_image, Erst-Kontext, Kosten-Deckel pro
// Antwort, final_answer-Zitat-Validierung (persistiert als Fussnoten), Recherche-
// Hinweis für Fragen zur Aussenwelt, context_info. Klassischer Pfad + Dispatcher:
// ./book-chat.js.

const { listWorldFacts, worldFactsScanState } = require('../../../db/schema');
const { resolveProvider, providerClass } = require('../../../lib/ai');
const { getBookSettings } = require('../../../db/book-settings');
const { narrativeLabels } = require('../narrative-labels');
const { getPrompts, getBookPrompts, getFiguren, getLatestReview } = require('../shared');
const { executeTool, validateFinalAnswerCitations } = require('../chat-tools');
const { MAX_FINAL_CITATIONS } = require('../chat-tools/citations');
const { makeAgenticChatJob } = require('../agentic-chat');
const { prepareChatTools } = require('../chat-tools/select');
const { maxToolIterFor, agentLimits } = require('../agentic-chat/limits');
const embed = require('../../../lib/embed');
const { agentPreContext, preContextStatus, retrievalQuery } = require('./book-chat-retrieval');
const appSettings = require('../../../lib/app-settings');
const { getSessionWithBookName } = require('../../../db/chat-sessions');
const { getPageWithChapter } = require('../../../db/book-chat/text');
const { resolvePageBookId } = require('../../../lib/content-ownership');
const { figurenBlockChars, weltfaktenBlockChars, _parseChatResponse } = require('./shared');
const { runBookChatJob, _applyBookChatAiOverrides } = require('./book-chat');
const { normalizeChatIdeeProposals } = require('../../../lib/chat-idee-proposals');

// ── Agentic Buch-Chat (Tool-Use) ───────────────────────────────────────────────
// Ersetzt runBookChatJob, wenn der effektive Provider Werkzeuge kann (und
// jobs.book_chat.mode != 'classic'). Der Agent ruft Werkzeuge des gemeinsamen
// Katalogs (../chat-tools/) auf, statt alle Seiten vorab zu laden. Werkzeugsatz und
// Deckel kommen aus den gemeinsamen Modulen aller agentischen Chats
// (../chat-tools/select.js, ../agentic-chat/limits.js).

// Per-Iteration-Limit für Input-Tokens (Context-Window-Schutz, nicht kumulativ).
// Default = `ai.<provider>.context_window` − `ai.<provider>.max_tokens_out` − Puffer.
// Prompt-Caching macht wiederholte Tokens ohnehin billig, deshalb kein Summen-Budget.
function _bookChatTokenBudget(aiCfg) {
  return parseInt(appSettings.get('jobs.book_chat.token_budget'), 10) || aiCfg.inputBudgetTokens;
}

// final_answer-Tool-Use auswerten: Zitate validieren (Beweisspur, nicht blockierend),
// toolLog-Eintrag schreiben und den antwort-Envelope zurückgeben. Geteilt zwischen
// der regulären Loop-Terminierung und dem erzwungenen Synthese-Turn.
async function _consumeFinalAnswer(finalUse, ctx, toolLog, iterNum, logger) {
  const antwort = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
  // Validiert (und als Fussnote gezeigt) werden höchstens MAX_FINAL_CITATIONS —
  // dieselbe Liste geht in Validator, toolLog-Zähler und Fussnoten.
  const zitate  = Array.isArray(finalUse.input?.zitate) ? finalUse.input.zitate.slice(0, MAX_FINAL_CITATIONS) : null;
  let citationValidation = null;
  let invalidCount = 0;
  if (zitate && zitate.length) {
    try {
      citationValidation = await validateFinalAnswerCitations(zitate, ctx);
      invalidCount = citationValidation.filter(v => !v.valid).length;
      if (invalidCount > 0) {
        logger.warn(`final_answer: ${invalidCount}/${citationValidation.length} Zitate ungültig (siehe context_info).`);
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      logger.warn(`final_answer-Zitat-Validierung fehlgeschlagen: ${e.message}`);
      citationValidation = [{ valid: false, reason: `validator_error: ${e.message}` }];
      invalidCount = 1;
    }
  }
  toolLog.push({
    name: 'final_answer',
    input: {
      antwort_chars: antwort.length,
      ...(zitate ? { zitate_count: zitate.length } : {}),
    },
    ok: true,
    durationMs: 0,
    resultBytes: antwort.length,
    truncated: false,
    iter: iterNum,
    ...(citationValidation ? {
      citation_validation: citationValidation,
      citations_invalid: invalidCount,
    } : {}),
  });
  logger.info(`tool=final_answer antwort_chars=${antwort.length} zitate=${zitate?.length || 0} invalid=${invalidCount} iter=${iterNum} (terminal)`);
  if (zitate && zitate.length) ctx.citations = _buildCitations(zitate, citationValidation, ctx.bookId);
  const hint = _rechercheHint(finalUse.input);
  if (hint) ctx.recherche = hint;
  // Ideen-Vorschläge: nur Abschnitte dieses Buchs, nichts wird angelegt — der
  // User erfasst jeden einzeln (POST /ideen, lib/chat-idee-proposals.js).
  ctx.ideenProposals = normalizeChatIdeeProposals(finalUse.input?.ideen, { bookId: ctx.bookId });
  return JSON.stringify({ antwort });
}

// Zitate einer Antwort als Fussnoten-Datensatz für context_info.citations. Nur Daten
// aus dem eigenen Buch bekommen einen Seitennamen (= Sprungziel); eine fremde oder
// unbekannte Seite bleibt ohne Link. Text gedeckelt — die Fussnote ist ein Beleg,
// keine Kopie der Seite.
// Die Buchzugehörigkeit wird hier selbst geprüft und NICHT aus dem Validator-Ergebnis
// abgeleitet: der meldet `bad_shape` (oder bei eigenem Fehler `validator_error`), bevor
// er das Buch prüft — ein fehlendes `page_not_in_book` heisst darum nicht «eigenes Buch».
const CITATION_QUOTE_MAX = 400;
function _buildCitations(zitate, validation, bookId) {
  return zitate.slice(0, MAX_FINAL_CITATIONS).map((z, i) => {
    const v = Array.isArray(validation) ? validation[i] : null;
    const pageId = Number.isInteger(z?.page_id) ? z.page_id : null;
    const inBook = pageId != null && bookId != null && resolvePageBookId(pageId) === bookId;
    const row = inBook ? getPageWithChapter(pageId) : null;
    const quote = String(z?.quote ?? v?.actual ?? '').slice(0, CITATION_QUOTE_MAX);
    return {
      n: i + 1,
      page_id: row ? pageId : null,
      page_name: row?.page_name || null,
      quote,
      valid: !!v?.valid,
      ...(v && !v.valid && v.reason ? { reason: String(v.reason).split(':')[0] } : {}),
    };
  });
}

// Recherche-Hinweis aus final_answer (Fragen zur Aussenwelt, siehe
// buildBookChatOutsideWorldRule). Die vorgeschlagene Frage geht unverändert als
// Text an den Recherche-Chat — gedeckelt, aber nicht umformuliert.
function _rechercheHint(input) {
  if (input?.recherche_hinweis !== true) return null;
  const frage = typeof input.recherche_frage === 'string' ? input.recherche_frage.trim().slice(0, 1000) : '';
  return { frage };
}

// Welt-Fakten fuer den stabilen (gecachten) Prompt-Block. `scanned` reist mit, damit
// buildWeltfaktenBlock einen NICHT erhobenen Index von einem leeren unterscheiden kann
// — ein leerer Block wuerde als «diese Welt hat keine Regeln» gelesen. Nicht-fatal:
// ein DB-Fehler kostet den Block, nicht den Chat.
function _agentWeltContext(bookId, userEmail, logger) {
  try {
    const fakten = listWorldFacts(bookId, userEmail, { withRefuted: true });
    const { scanned } = worldFactsScanState(bookId, userEmail);
    return { scanned, fakten };
  } catch (e) {
    logger.warn(`Welt-Fakten-Block uebersprungen (${e.message}).`);
    return null;
  }
}

// Absolute Deckel der zwei buch-stabilen Prompt-Blöcke im agentischen Pfad
// (~12k bzw. ~6k Tokens). Was darüber hinausgeht, weist der jeweilige Block als
// gekappt aus und verweist aufs Detail-Werkzeug.
const AGENT_FIGUREN_MAX_CHARS    = 48000;
const AGENT_WELTFAKTEN_MAX_CHARS = 24000;

// Agentischer Buch-Chat: ruft Tools aus dem gemeinsamen Katalog (../chat-tools/) auf, um
// Fragen über den gesamten Buchindex zu beantworten, statt alle Seiten vorab zu
// laden. Loop/Persistenz kommen aus makeAgenticChatJob (siehe agentic-chat.js);
// hier nur die Buch-Chat-spezifischen Achsen (Provider-Override, Tool-Set inkl.
// generate_image, final_answer-Zitat-Validierung, context_info mit Bildern).
const runBookChatJobAgent = makeAgenticChatJob({
  startLabel: 'Agent',
  errLabel: 'Agent',
  callProvider: undefined,   // lässt lib/ai den (ggf. via setContext überschriebenen) Provider auflösen
  resolveProvider: (userEmail, logger) => {
    const effectiveProvider = resolveProvider({ userEmail });
    _applyBookChatAiOverrides(effectiveProvider, logger);
    return effectiveProvider;
  },

  loadSession: (sessionId, userEmail) => getSessionWithBookName(parseInt(sessionId), userEmail),

  async prepare({ session, userEmail, aiCfg, logger, jobSignal, message, history }) {
    const prompts = await getPrompts(userEmail);
    const {
      buildBookChatAgentSystemPrompt, buildBookChatPreContext, BOOK_CHAT_OUTPUT_TOOLS, buildErzaehlweiseLine,
      BOOK_CHAT_FORCE_FINAL_INSTRUCTION, buildBookChatOutsideWorldRule, BOOK_CHAT_BUDGET_FINAL_INSTRUCTION,
    } = prompts;
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_BOOK_CHAT: bookChatSys } = await getBookPrompts(session.book_id, userEmail);
    const provider = resolveProvider({ userEmail });
    const maxToolIter = maxToolIterFor('jobs.book_chat.max_tool_iter', 6, provider, userEmail);
    const limits = agentLimits(maxToolIter, aiCfg);
    // Erst-Kontext: die semantisch nächsten Passagen zur Frage, bevor der Loop startet.
    // Die häufigste Frageform ist eine schmale Faktenfrage; ohne diesen Block beginnt der
    // Agent bei null und lädt im Zweifel ganze Kapitel — der Block kostet ein paar Tausend
    // Tokens, eine Volltext-Runde ein Vielfaches. Nicht-fatal: fällt der Embedding-
    // Endpunkt aus, läuft der Agent wie vorher rein über seine Werkzeuge.
    const preContext = await agentPreContext(session.book_id, retrievalQuery(message, history), { signal: jobSignal, logger, userEmail });
    const embOn = embed.isEnabled();
    // Werkzeugsatz: Slim/voll nach Provider-Klasse, ohne Werkzeuge ohne Endpunkt oder
    // ohne Daten im Buch; Prompt, Beschreibungen und Handler-Hinweise nennen nur, was
    // angeboten wird (ctx.offeredTools).
    const toolCtx = { bookId: session.book_id, sessionId: session.id, userEmail, logger };
    const { tools, toolNames, toolSet, offeredTools, unavailable } = prepareChatTools({
      chat: 'book', prompts, provider, userEmail, ctx: toolCtx, outputTools: BOOK_CHAT_OUTPUT_TOOLS,
    });
    // Figuren- und Welt-Fakten-Block: absolut gedeckelt, nicht nur relativ zum
    // Kontextfenster. Auf einem 1M-Fenster griffen die relativen Deckel nie, und
    // ein ausanalysiertes Buch trug so über 200k Zeichen Dossier in JEDE Iteration.
    // Der Agent hat für beides Detail-Werkzeuge (Figurenprofil, Welt-Fakten).
    const figurenMaxChars = Math.min(figurenBlockChars(aiCfg), AGENT_FIGUREN_MAX_CHARS);
    // Welt-Fakten: kurze, schon verdichtete Buchaussagen — Stufe 1 der Kosten-Leiter.
    // Buch-stabil, darum im gecachten Block 1 und nicht im Erst-Kontext.
    const welt = _agentWeltContext(session.book_id, userEmail, logger);
    const weltfaktenMaxChars = Math.min(weltfaktenBlockChars(aiCfg), AGENT_WELTFAKTEN_MAX_CHARS);
    const systemPrompt = buildBookChatAgentSystemPrompt(
      session.book_name || '', figuren, review, bookChatSys, maxToolIter,
      {
        semantic: embOn, toolNames,
        figurenMaxChars, welt, weltfaktenMaxChars,
        erzaehlweise: buildErzaehlweiseLine(narrativeLabels(getBookSettings(session.book_id, userEmail))),
      },
    );
    // Erst-Kontext: pro Frage andere Bytes — darum NICHT im System-Prompt, sondern als
    // Textblock vor der Frage in deren User-Nachricht (userPreamble). So bleiben
    // Werkzeuge + System + Historie ein stabiler Cache-Präfix über die Turns.
    const userPreamble = `${buildBookChatPreContext(preContext?.hits || [], preContextStatus(preContext, { enabled: embOn }), { toolNames })}\n\n=== FRAGE ===`;
    // Aussenwelt-Regel an den stabilen Block 1 (gecacht): der Buch-Chat hat keine
    // Web-Suche und verweist auf den Recherche-Chat.
    if (systemPrompt[0]?.text) {
      systemPrompt[0] = { ...systemPrompt[0], text: `${systemPrompt[0].text}\n\n${buildBookChatOutsideWorldRule(toolNames)}` };
    }
    logger.info(`Werkzeugsatz: ${toolSet} (${tools.length} Werkzeuge${unavailable.length ? `, ohne Daten/Endpunkt: ${unavailable.join(', ')}` : ''}), max ${maxToolIter} Iterationen, Provider=${provider}/${providerClass(provider, { userEmail })}.`);
    logger.info(`System-Prompt: ${systemPrompt.reduce((n, b) => n + (b.text?.length || 0), 0)} Zeichen `
      + `(Figuren: ${figuren.length}, Block-Deckel ${figurenMaxChars} Zeichen; `
      + `Welt-Fakten: ${welt ? `${welt.fakten.length}${welt.scanned ? '' : ' (Index nicht erhoben)'}` : 'aus'}, `
      + `Deckel ${weltfaktenMaxChars} Zeichen), Input-Budget ${aiCfg.inputBudgetChars} Zeichen.`);
    return {
      systemPrompt,
      tools,
      maxToolIter,
      tokenBudget: _bookChatTokenBudget(aiCfg),
      toolResultCap: limits.toolResultCap,
      inputTokenCap: limits.inputTokenCap,
      maxToolsPerRound: limits.maxToolsPerRound,
      roundResultCapChars: limits.roundResultCapChars,
      userPreamble,
      cacheHistory: true,
      forceFinalInstruction: BOOK_CHAT_FORCE_FINAL_INSTRUCTION,
      inputCapInstruction: BOOK_CHAT_BUDGET_FINAL_INSTRUCTION,
      ctx: {
        ...toolCtx,
        jobSignal,
        offeredTools,
        // Strukturierte Kürzung in executeTool auf denselben Deckel wie der harte
        // Schnitt im Loop — sonst schneidet der Loop mitten in ein JSON-Ergebnis.
        resultCapChars: limits.toolResultCap,
        // final_answer: validierte Zitate (Fussnoten), Recherche-Hinweis, Ideen-Vorschläge.
        citations: null,
        recherche: null,
        ideenProposals: [],
        // Welcher Werkzeugsatz lief — landet in context_info (Kosten-Diagnose:
        // ein Slim-Lauf beantwortet manche Frage nicht, das muss sichtbar sein).
        toolSet, toolsOffered: tools.length,
        // generate_image-Tool sammelt hier {image_id, prompt, mime}; nach dem Loop
        // in context_info.images persistiert (Frontend-Anzeige im Verlauf).
        images: [],
        // Input-Budget des effektiven Providers — list_chapters leitet daraus ab,
        // ob das ganze Buch in den Kontext passt (Voll-Lektüre statt Stichwort-Raten).
        inputBudgetChars: aiCfg.inputBudgetChars,
        // Erst-Kontext-Kennzahlen für context_info (Frontend-Plakette + Kosten-Diagnose).
        preContext: preContext
          ? { count: preContext.hits.length, chars: preContext.chars }
          : null,
      },
    };
  },

  executeTool: (name, input, ctx) => executeTool(name, input, ctx),

  // final_answer mit Zitat-Validierung (Beweisspur, nicht blockierend).
  consumeFinalAnswer: ({ finalUse, ctx, toolLog, iterNum, logger }) =>
    _consumeFinalAnswer(finalUse, ctx, toolLog, iterNum, logger),

  parseFinal: (finalText, logger) => {
    const { antwort, fallback } = _parseChatResponse(finalText);
    if (fallback) logger.warn('Agent-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    return antwort;
  },

  buildContextInfo: ({ toolLog, iter, ctx, stopReason, costUsd }) => ({
    mode: 'agent',
    tool_calls: toolLog,
    iterations: iter + 1,
    ...(stopReason ? { stop_reason: stopReason } : {}),
    ...(costUsd > 0 ? { cost_usd: Math.round(costUsd * 10000) / 10000 } : {}),
    ...(ctx.citations?.length ? { citations: ctx.citations } : {}),
    ...(ctx.recherche ? { recherche_hinweis: true, recherche_frage: ctx.recherche.frage } : {}),
    ...(ctx.ideenProposals?.length ? { proposals: ctx.ideenProposals } : {}),
    ...(ctx.toolSet ? { tool_set: ctx.toolSet, tools_offered: ctx.toolsOffered } : {}),
    ...(ctx.preContext ? { pre_context: ctx.preContext } : {}),
    // Im Chat generierte Bilder — Frontend rendert sie unter der Antwort.
    ...(ctx.images.length ? { images: ctx.images } : {}),
  }),

  buildSummary: ({ sessionId, toolLog, iter }) =>
    `Agent session=${sessionId}, ${toolLog.length} Tool-Calls, ${iter + 1} Iter`,

  // Endpunkt/Modell sprechen kein Tool-Protokoll (400/404/422 mit Tool-Bezug, oder
  // `ai.openai-compat.tools=false` waehrend der Job schon lief): statt den Job zu
  // verlieren, dieselbe Frage klassisch beantworten. Greift nur, solange nichts
  // persistiert wurde — der Fehler kann ausschliesslich am callAIWithTools auftreten,
  // und der liegt vor jedem Schreibpfad.
  fallbackJob: runBookChatJob,
});

module.exports = { runBookChatJobAgent, _retrievalQuery: retrievalQuery, _buildCitations };
