'use strict';
// Agentischer Buch-Chat (Tool-Use). Loop/Persistenz kommen aus makeAgenticChatJob
// (../agentic-chat.js); hier nur die Buch-Chat-spezifischen Achsen: Provider-
// Override, Werkzeugsatz inkl. generate_image, Erst-Kontext, Kosten-Deckel pro
// Antwort, final_answer-Zitat-Validierung (persistiert als Fussnoten), Recherche-
// Hinweis für Fragen zur Aussenwelt, context_info. Klassischer Pfad + Dispatcher:
// ./book-chat.js.

const { listWorldFacts, worldFactsScanState } = require('../../../db/schema');
const { resolveProvider, providerClass } = require('../../../lib/ai');
const { getPrompts, getBookPrompts, getFiguren, getLatestReview } = require('../shared');
const { executeTool, validateFinalAnswerCitations } = require('../book-chat-tools');
const { makeAgenticChatJob } = require('../agentic-chat');
const { imageGenEnabled } = require('../../../lib/image-gen');
const embed = require('../../../lib/embed');
const { agentPreContext, retrievalQuery } = require('./book-chat-retrieval');
const appSettings = require('../../../lib/app-settings');
const { getSessionWithBookName } = require('../../../db/chat-sessions');
const { getPageWithChapter } = require('../../../db/book-chat/text');
const { figurenBlockChars, weltfaktenBlockChars, _parseChatResponse } = require('./shared');
const { runBookChatJob, _applyBookChatAiOverrides } = require('./book-chat');

// ── Agentic Buch-Chat (Tool-Use) ───────────────────────────────────────────────
// Ersetzt runBookChatJob bei API_PROVIDER=claude (und BOOK_CHAT_MODE != 'classic').
// Der Agent ruft Tools aus routes/jobs/book-chat-tools.js auf, um Fragen
// über den gesamten Buchindex zu beantworten, statt alle Seiten vorab zu laden.
// Iterations-Deckel. Lokale Provider bekommen einen eigenen, niedrigeren Wert:
// ohne Prompt-Caching kostet jede Runde den vollen Prompt erneut (Werkzeugkatalog +
// Historie + alle bisherigen Tool-Results), und eine Runde dauert dort Sekunden bis
// Minuten. `..._local = 0` schaltet den eigenen Deckel ab.
function _bookChatMaxToolIter(provider, userEmail) {
  const base = parseInt(appSettings.get('jobs.book_chat.max_tool_iter'), 10) || 6;
  if (providerClass(provider, { userEmail }) !== 'local') return base;
  const local = parseInt(appSettings.get('jobs.book_chat.max_tool_iter_local'), 10) || 0;
  return local > 0 ? Math.min(base, local) : base;
}

// Werkzeugsatz: 'full' (alle) oder 'slim' (kuratierte Teilmenge, SSoT
// BOOK_CHAT_SLIM_TOOL_NAMES in public/js/prompts/book-chat-tools.js). 'auto' folgt der
// Provider-KLASSE — der volle Katalog kostet ~10k Input-Tokens pro Iteration, die ein
// lokaler Endpunkt ohne Caching jede Runde neu bezahlt, und ein kleineres Modell
// wählt aus der kleinen Teilmenge zuverlässiger als aus dem vollen Katalog.
function _bookChatToolSet(provider, userEmail) {
  const mode = String(appSettings.get('jobs.book_chat.tool_set') || 'auto').toLowerCase();
  if (mode === 'slim' || mode === 'full') return mode;
  return providerClass(provider, { userEmail }) === 'local' ? 'slim' : 'full';
}
// Per-Iteration-Limit für Input-Tokens (Context-Window-Schutz, nicht kumulativ).
// Default = `ai.<provider>.context_window` − `ai.<provider>.max_tokens_out` − Puffer.
// Prompt-Caching macht wiederholte Tokens ohnehin billig, deshalb kein Summen-Budget.
function _bookChatTokenBudget(aiCfg) {
  return parseInt(appSettings.get('jobs.book_chat.token_budget'), 10) || aiCfg.inputBudgetTokens;
}
// Kosten-Deckel pro Antwort: kumulierte Input-Tokens über alle Iterationen (inkl.
// Cache-Lesen — der Wert, den auch die Token-Anzeige zeigt). Prompt-Caching macht
// eine Runde billig, aber nicht gratis: zwölf Runden mit Kapitel-Volltexten summieren
// sich auf Millionen Tokens. Erreicht → erzwungene Synthese-Runde (nur final_answer),
// kein Hart-Abbruch. 0 = aus.
function _bookChatInputTokenCap() {
  const v = parseInt(appSettings.get('jobs.book_chat.max_input_tokens_per_answer'), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Per-Tool-Result-Cap: damit eine einzelne Tool-Antwort nicht allein das Budget sprengt.
// Annahme: bis zu 6 Iterationen × ~3 Tool-Calls × Sicherheitsfaktor 2 ⇒ /36.
// Min 4000 Zeichen, damit Tool-Results bei kleinen Kontextfenstern noch brauchbar sind.
function _toolResultCapChars(maxIter, aiCfg) {
  return Math.max(4000, Math.floor(aiCfg.inputBudgetChars / (maxIter * 6)));
}

// final_answer-Tool-Use auswerten: Zitate validieren (Beweisspur, nicht blockierend),
// toolLog-Eintrag schreiben und den antwort-Envelope zurückgeben. Geteilt zwischen
// der regulären Loop-Terminierung und dem erzwungenen Synthese-Turn.
async function _consumeFinalAnswer(finalUse, ctx, toolLog, iterNum, logger) {
  const antwort = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
  const zitate  = Array.isArray(finalUse.input?.zitate) ? finalUse.input.zitate : null;
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
  if (zitate && zitate.length) ctx.citations = _buildCitations(zitate, citationValidation);
  const hint = _rechercheHint(finalUse.input);
  if (hint) ctx.recherche = hint;
  return JSON.stringify({ antwort });
}

// Zitate einer Antwort als Fussnoten-Datensatz für context_info.citations. Nur Daten
// aus dem eigenen Buch bekommen einen Seitennamen (= Sprungziel); eine fremde oder
// unbekannte Seite bleibt ohne Link. Text gedeckelt — die Fussnote ist ein Beleg,
// keine Kopie der Seite.
const CITATION_QUOTE_MAX = 400;
function _buildCitations(zitate, validation) {
  return zitate.slice(0, 30).map((z, i) => {
    const v = Array.isArray(validation) ? validation[i] : null;
    const pageId = Number.isInteger(z?.page_id) ? z.page_id : null;
    const inBook = v ? v.reason !== 'page_not_in_book' : false;
    const row = pageId != null && inBook ? getPageWithChapter(pageId) : null;
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
// BOOK_CHAT_OUTSIDE_WORLD_RULE). Die vorgeschlagene Frage geht unverändert als
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

// Agentischer Buch-Chat: ruft Tools aus routes/jobs/book-chat-tools.js auf, um
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
    const {
      buildBookChatAgentSystemPrompt, BOOK_CHAT_TOOLS, BOOK_CHAT_SLIM_TOOL_NAMES, BOOK_CHAT_FORCE_FINAL_INSTRUCTION,
      BOOK_CHAT_OUTSIDE_WORLD_RULE, BOOK_CHAT_BUDGET_FINAL_INSTRUCTION,
    } = await getPrompts(userEmail);
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_BOOK_CHAT: bookChatSys } = await getBookPrompts(session.book_id, userEmail);
    const provider = resolveProvider({ userEmail });
    const maxToolIter = _bookChatMaxToolIter(provider, userEmail);
    // Erst-Kontext: die semantisch nächsten Passagen zur Frage, bevor der Loop startet.
    // Die häufigste Frageform ist eine schmale Faktenfrage; ohne diesen Block beginnt der
    // Agent bei null und lädt im Zweifel ganze Kapitel — der Block kostet ein paar Tausend
    // Tokens, eine get_chapter_text-Runde ein Vielfaches. Nicht-fatal: fällt der Embedding-
    // Endpunkt aus, läuft der Agent wie vorher rein über seine Werkzeuge.
    const preContext = await agentPreContext(session.book_id, retrievalQuery(message, history), { signal: jobSignal, logger, userEmail });
    const embOn = embed.isEnabled();
    // generate_image / search_similar nur anbieten, wenn der jeweilige Endpunkt
    // (Bild bzw. Embeddings) konfiguriert ist — sonst spart das Input-Tokens und
    // das Modell ruft kein totes Werkzeug. Im Slim-Satz (lokale Provider) faellt
    // zusaetzlich alles weg, was nicht auf der kuratierten Liste steht.
    const imgOn = imageGenEnabled();
    const toolSet = _bookChatToolSet(provider, userEmail);
    const slim = toolSet === 'slim' ? new Set(BOOK_CHAT_SLIM_TOOL_NAMES) : null;
    const tools = BOOK_CHAT_TOOLS.filter(t =>
      (!slim || slim.has(t.name))
      && (t.name !== 'generate_image' || imgOn) && (t.name !== 'search_similar' || embOn));
    // Der Prompt darf nur empfehlen, was tatsaechlich angeboten wird — sonst
    // verbrennt das Modell Runden an Werkzeugen, die es nicht hat.
    // Figuren- und Welt-Fakten-Block: absolut gedeckelt, nicht nur relativ zum
    // Kontextfenster. Auf einem 1M-Fenster griffen die relativen Deckel nie, und
    // ein ausanalysiertes Buch trug so über 200k Zeichen Dossier in JEDE Iteration.
    // Der Agent hat für beides Detail-Werkzeuge (get_figure_profile, list_world_facts).
    const figurenMaxChars = Math.min(figurenBlockChars(aiCfg), AGENT_FIGUREN_MAX_CHARS);
    // Welt-Fakten: kurze, schon verdichtete Buchaussagen — Stufe 1 der Kosten-Leiter.
    // Buch-stabil, darum im gecachten Block 1 und nicht im Erst-Kontext.
    const welt = _agentWeltContext(session.book_id, userEmail, logger);
    const weltfaktenMaxChars = Math.min(weltfaktenBlockChars(aiCfg), AGENT_WELTFAKTEN_MAX_CHARS);
    const systemPrompt = buildBookChatAgentSystemPrompt(
      session.book_name || '', figuren, review, bookChatSys, maxToolIter,
      {
        passages: preContext?.hits || [], semantic: embOn, toolNames: tools.map(t => t.name),
        figurenMaxChars, welt, weltfaktenMaxChars,
      },
    );
    // Aussenwelt-Regel an den stabilen Block 1 (gecacht, buch-unabhängig): der
    // Buch-Chat hat keine Web-Suche und verweist auf den Recherche-Chat.
    if (BOOK_CHAT_OUTSIDE_WORLD_RULE && systemPrompt[0]?.text) {
      systemPrompt[0] = { ...systemPrompt[0], text: `${systemPrompt[0].text}\n\n${BOOK_CHAT_OUTSIDE_WORLD_RULE}` };
    }
    const toolResultCap = _toolResultCapChars(maxToolIter, aiCfg);
    const inputTokenCap = _bookChatInputTokenCap();
    logger.info(`Werkzeugsatz: ${toolSet} (${tools.length} Werkzeuge), max ${maxToolIter} Iterationen, Provider=${provider}/${providerClass(provider, { userEmail })}.`);
    logger.info(`System-Prompt: ${systemPrompt.reduce((n, b) => n + (b.text?.length || 0), 0)} Zeichen `
      + `(Figuren: ${figuren.length}, Block-Deckel ${figurenMaxChars} Zeichen; `
      + `Welt-Fakten: ${welt ? `${welt.fakten.length}${welt.scanned ? '' : ' (Index nicht erhoben)'}` : 'aus'}, `
      + `Deckel ${weltfaktenMaxChars} Zeichen), Input-Budget ${aiCfg.inputBudgetChars} Zeichen.`);
    return {
      systemPrompt,
      tools,
      maxToolIter,
      tokenBudget: _bookChatTokenBudget(aiCfg),
      toolResultCap,
      inputTokenCap,
      forceFinalInstruction: BOOK_CHAT_FORCE_FINAL_INSTRUCTION,
      inputCapInstruction: BOOK_CHAT_BUDGET_FINAL_INSTRUCTION,
      ctx: {
        bookId: session.book_id, sessionId: session.id, userEmail,
        jobSignal, logger,
        // Strukturierte Kürzung in executeTool auf denselben Deckel wie der harte
        // Schnitt im Loop — sonst schneidet der Loop mitten in ein JSON-Ergebnis.
        resultCapChars: toolResultCap,
        // final_answer: validierte Zitate (Fussnoten) + Recherche-Hinweis.
        citations: null,
        recherche: null,
        // Welcher Werkzeugsatz lief — landet in context_info (Kosten-Diagnose:
        // ein Slim-Lauf beantwortet manche Frage nicht, das muss sichtbar sein).
        toolSet, toolsOffered: tools.length,
        // generate_image-Tool sammelt hier {image_id, prompt, mime}; nach dem Loop
        // in context_info.images persistiert (Frontend-Anzeige im Verlauf).
        images: [],
        // Input-Budget des effektiven Providers — list_chapters leitet daraus ab,
        // ob das ganze Buch in den Kontext passt (Voll-Lektüre statt search-Raten).
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
