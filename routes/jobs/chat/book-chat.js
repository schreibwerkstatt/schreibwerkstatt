'use strict';
// Buch-Chat-Job (kind='book', buchweit, read-only): klassischer Pfad (Seiten
// vorab laden + Relevanz-Scoring) UND agentischer Pfad (Tool-Use über den
// Buchindex). Dispatcher wählt anhand der App-Settings (Provider/Modus).

const { db } = require('../../../db/schema');
const { callAIChat, chatTemperature, getContextConfigFor, resolveProvider, providerSupportsTools } = require('../../../lib/ai');
const { buildAgenticHistory } = require('../agentic-chat');
const {
  _promptConfig,
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  getFiguren, getLatestReview,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const { generateSessionTitle } = require('../chat-title');
const embed = require('../../../lib/embed');
const { selectPassagesSemantic, retrievalQuery } = require('./book-chat-retrieval');
const { setContext } = require('../../../lib/log-context');
const appSettings = require('../../../lib/app-settings');
const { recordChatLedgerForMessage, recordChatLedgerForFailedRun } = require('../../../db/cost-ledger');
const { getSessionWithBookName } = require('../../../db/chat-sessions');
const {
  _parseChatResponse, figurenBlockChars,
  bookPageCache, BOOK_PAGE_CACHE_TTL_MS, BOOK_PAGE_CACHE_MAX,
} = require('./shared');

// Fallback-Stoppwörter für Book-Chat (Default-Locale); wird pro Job locale-spezifisch überschrieben
const _BOOK_CHAT_STOPWORDS = new Set(
  (() => {
    const def = _promptConfig.defaultLocale || 'de-CH';
    return (_promptConfig.locales?.[def]?.stopwords) || _promptConfig.stopwords || [];
  })()
);

function _scorePageRelevance(query, text, stopwords = _BOOK_CHAT_STOPWORDS) {
  const tokens = query.toLowerCase()
    .split(/[\s,\.!?;:«»"'()\[\]{}]+/)
    .filter(w => w.length >= 3 && !stopwords.has(w));
  if (!tokens.length) return 0;
  const textLow = text.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    const re = new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    score += Math.min((textLow.match(re) || []).length, 5);
  }
  return score;
}

// Per-Job-Override für den Buch-Chat (klassisch + agentisch), analog zur
// Komplettanalyse (_komplettAiOverrides in routes/jobs/komplett/job-shared.js): Keys
// `ai.<provider>.{model,context_window,max_tokens_out,timeout_ms}.bookchat`, leer/0 =
// folgt dem globalen Wert. Erlaubt bei Claude z.B. Opus für den Tool-Loop, während
// global Sonnet läuft. Kein eigener Timeout-Default (anders als komplett) – der
// Buch-Chat macht pro Call nur eine Tool-Use-Runde, der globale 10-Min-Timeout reicht.
//
// Warum auch openai-compat: der agentische Pfad läuft dort ebenfalls (Function-Calling),
// und er braucht das umgekehrte Zuschnitt-Verhältnis wie die Analyse — VIEL Input
// (Werkzeugkatalog + Erst-Kontext + wachsende Tool-Results, jede Iteration ungecacht)
// und wenig Output. Ein für die Komplettanalyse gesetzter Output-Cap frisst sonst das
// Input-Budget des Chats auf, weil beide aus demselben Kontextfenster kommen.
const _BOOKCHAT_OVERRIDE_PROVIDERS = new Set(['claude', 'openai-compat']);
function _bookChatAiOverrides(effectiveProvider) {
  if (!_BOOKCHAT_OVERRIDE_PROVIDERS.has(effectiveProvider)) return null;
  const p = effectiveProvider;
  const model = String(appSettings.get(`ai.${p}.model.bookchat`) || '').trim();
  const contextWindow = parseInt(appSettings.get(`ai.${p}.context_window.bookchat`), 10) || 0;
  const maxTokensOut = parseInt(appSettings.get(`ai.${p}.max_tokens_out.bookchat`), 10) || 0;
  const timeoutMs = parseInt(appSettings.get(`ai.${p}.timeout_ms.bookchat`), 10) || 0;
  const bag = { provider: p };
  if (model) bag.model = model;
  if (contextWindow > 0) bag.contextWindow = contextWindow;
  if (maxTokensOut > 0) bag.maxTokensOut = maxTokensOut;
  if (timeoutMs > 0) bag.timeoutMs = timeoutMs;
  // effort (output_config) für Opus 4.5+/Sonnet 4.6: low|medium|high|xhigh|max. Leer =
  // API-Default (high). lib/ai.js klemmt Tier-Mismatch (max→Opus-only, xhigh→Opus-4.7+)
  // automatisch auf high. Claude-API-Eigenheit — kein openai-compat-Pendant.
  if (p === 'claude') {
    const effort = String(appSettings.get('ai.claude.effort.bookchat') || '').trim();
    if (effort) bag.effort = effort;
  }
  return Object.keys(bag).length > 1 ? { aiJob: bag } : null;
}

// Override via ALS-Context binden (greift für alle Calls dieses Jobs gegen DIESEN
// Provider, ohne globale Calls zu beeinflussen — der `provider` im Bag ist Teil des
// Vertrags). MUSS vor getContextConfigFor() laufen, damit das aiCfg (Token-Budget,
// Tool-Result-Cap) das Buch-Chat-Kontextfenster/Output-Cap reflektiert.
function _applyBookChatAiOverrides(effectiveProvider, logger) {
  const overrides = _bookChatAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    logger.info(`Buch-Chat-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)}.`);
  }
  return overrides;
}

async function runBookChatJob(jobId, sessionId, userMsgId, message, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildBookChatSystemPrompt, SCHEMA_BOOK_CHAT } = await getPrompts(userEmail);
  const effectiveProvider = resolveProvider({ userEmail });
  _applyBookChatAiOverrides(effectiveProvider, logger);
  const aiCfg = getContextConfigFor(effectiveProvider);
  // Verbrauch des KI-Calls, falls der Lauf danach ohne Antwort endet (Truncation):
  // landet dann über recordChatLedgerForFailedRun im Ledger statt nirgends.
  let session = null;
  let spent = null;
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    session = getSessionWithBookName(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start: «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

    const { SYSTEM_BOOK_CHAT: bookChatSys, STOPWORDS: bookChatSW } = await getBookPrompts(session.book_id, userEmail);
    const bookChatStopwords = new Set(bookChatSW || []);

    const cacheKey = `${session.book_id}:${userEmail}`;
    const jobSignal = jobAbortControllers.get(jobId)?.signal;

    // ── Historien-Rolling-Window (Anker + letzte 10 Nachrichten) ────────────────
    const historyWithoutLast = buildAgenticHistory(session.id).slice(0, -1);
    const historyChars = historyWithoutLast.reduce((s, m) => s + (m.content?.length || 0), 0);

    // ── Dynamisches Text-Budget (seiten-unabhängig) ─────────────────────────────
    // aiCfg.inputBudgetChars = (context_window − max_tokens_out − Sicherheitspuffer) · chars_per_token
    // pro effektivem Provider. Davon noch Platz für System-Prompt und History reservieren.
    const SYSTEM_OVERHEAD_CHARS = 8000;   // ~2k Tokens für System-Prompt-Overhead
    // Der Figuren-Block wird RESERVIERT, nicht geschätzt: er steht im selben Prompt
    // und war die Grösse, die den Call vor jedem Buchtext am Kontextfenster scheitern
    // liess. Reserviert wird sein Deckel (nicht die tatsächliche Länge) — der Block
    // entsteht erst unten, und ein zu knapp gerechnetes Textbudget ist teurer als ein
    // paar ungenutzte Zeichen.
    const FIGUREN_MAX_CHARS = figurenBlockChars(aiCfg);
    const TEXT_CHAR_BUDGET = Math.max(
      20000,
      Math.floor((aiCfg.inputBudgetChars - historyChars - SYSTEM_OVERHEAD_CHARS - FIGUREN_MAX_CHARS) * 0.98)
    );

    // ── Retrieval: Mini-RAG mit Keyword-Fallback ────────────────────────────────
    // Bei vollständigem Embedding-Index zieht die semantische Pipeline die bedeutungs-
    // relevantesten Auszüge (bester Chunk je Seite + Nachbar-Chunks) — dichterer,
    // präziserer Kontext als reines Keyword-Scoring, und ohne alle Seiten zu laden.
    // Fällt auf das Keyword-Scoring über alle Seiten zurück, wenn der Index fehlt oder
    // unvollständig ist (Treffer deckten nur einen Teil des Buchs ab), das Backend
    // ausfällt oder die Anfrage keine semantischen Treffer liefert. Der Grund steht in
    // context_info.retrievalFallback. Suchtext = Frage + letzte Runde (Folgefragen).
    let selectedPages = [];
    let usedChars = 0;
    let totalPages = 0;
    let retrievalMode = 'keyword';
    let retrievalFallback = embed.isEnabled() ? null : 'disabled';

    if (embed.isEnabled()) {
      updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 20 });
      try {
        const sem = await selectPassagesSemantic(
          session.book_id, retrievalQuery(message, historyWithoutLast), TEXT_CHAR_BUDGET, jobSignal,
        );
        if (sem.status === 'ok') {
          ({ selectedPages, usedChars, totalPages } = sem);
          retrievalMode = 'semantic';
        } else {
          retrievalFallback = sem.status;
          logger.info(`Semantisches Retrieval: ${sem.status === 'no_index' ? 'Index fehlt/unvollständig' : 'keine Treffer'} – Keyword-Scoring.`);
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        retrievalFallback = 'error';
        logger.warn(`Semantisches Retrieval fehlgeschlagen (${e.message}) – Fallback auf Keyword-Scoring.`);
      }
    }

    if (retrievalMode === 'keyword') {
      // ── Alle Seiten aus Cache oder frisch via Content-Store laden ─────────────
      let pageContents;
      const cached = bookPageCache.get(cacheKey);
      if (cached && Date.now() - cached.loadedAt < BOOK_PAGE_CACHE_TTL_MS) {
        pageContents = cached.pages;
        updateJob(jobId, { statusText: 'job.phase.pagesFromCache', progress: 40 });
      } else {
        updateJob(jobId, { statusText: 'job.phase.pageListLoading', progress: 8 });
        let pages;
        try { pages = await contentStore.listPages(session.book_id); }
        catch (e) {
          if (e?.status) throw i18nError('job.error.contentStorePageList', { status: e.status });
          throw e;
        }

        const BATCH = 5;
        pageContents = [];
        for (let i = 0; i < pages.length; i += BATCH) {
          if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
          updateJob(jobId, {
            statusText: 'job.phase.loadingPagesBatch',
            statusParams: { loaded: Math.min(i + BATCH, pages.length), total: pages.length },
            progress: 10 + Math.round((i / Math.max(pages.length, 1)) * 30),
          });
          const batch = pages.slice(i, i + BATCH);
          const results = await Promise.allSettled(batch.map(async p => {
            try {
              const pd = await contentStore.loadPage(p.id);
              const text = htmlToText(pd.html || '').trim();
              return text ? { name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text } : null;
            } catch { return null; }
          }));
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) pageContents.push(r.value);
          }
        }
        // FIFO-Eviction: ältesten Eintrag entfernen wenn Cache voll
        if (bookPageCache.size >= BOOK_PAGE_CACHE_MAX) {
          const firstKey = bookPageCache.keys().next().value;
          bookPageCache.delete(firstKey);
        }
        bookPageCache.set(cacheKey, { pages: pageContents, loadedAt: Date.now() });
      }

      // ── Relevanz-Scoring + Seitenauswahl ──────────────────────────────────────
      updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 42 });
      const scored = pageContents.map(p => ({ ...p, score: _scorePageRelevance(message, p.text, bookChatStopwords) }));
      const anyScore = scored.some(p => p.score > 0);
      if (anyScore) scored.sort((a, b) => b.score - a.score);

      if (!anyScore && scored.length > 0) {
        // Gleichmässige Verteilung: jede Seite bekommt denselben Anteil → Querschnitt durch das Buch
        const perPage = Math.floor(TEXT_CHAR_BUDGET / scored.length);
        for (const p of scored) {
          const text = p.text.slice(0, perPage);
          if (text.length >= 100) {
            selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
            usedChars += text.length;
          }
        }
      } else {
        // Relevanz-sortiert: Top-Seiten zuerst bis Budget erschöpft
        for (const p of scored) {
          if (usedChars >= TEXT_CHAR_BUDGET) break;
          const remaining = TEXT_CHAR_BUDGET - usedChars;
          const text = p.text.slice(0, remaining);
          selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
          usedChars += text.length;
        }
      }
      totalPages = pageContents.length;
    }

    logger.info(
      `Kontext: ${selectedPages.length}/${totalPages} ${retrievalMode === 'semantic' ? 'Auszüge' : 'Seiten'} ` +
      `(${usedChars}/${TEXT_CHAR_BUDGET} Zeichen, Hist ${Math.round(historyChars / 1000)}k Zeichen, ` +
      `Retrieval=${retrievalMode}).`
    );

    // ── System-Prompt + KI-Aufruf ───────────────────────────────────────────────
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const systemPrompt = buildBookChatSystemPrompt(session.book_name || '', selectedPages, figuren, review, bookChatSys,
      { excerpt: retrievalMode === 'semantic', figurenMaxChars: FIGUREN_MAX_CHARS });
    const contextInfo = {
      pages:      selectedPages.map(p => ({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug })),
      totalPages,
      retrievalMode,
      ...(retrievalFallback ? { retrievalFallback } : {}),
      figuren:    figuren.length > 0,
      review:     !!review,
    };

    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 50 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 50 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    // Kein cacheLastMessage: der System-Prompt (Block 2: keyword-selektierte
    // Seiten) ändert sich jede Runde, das würde den Messages-Cache ohnehin
    // invalidieren. Gecacht wird nur der stabile Block 1 (System/Figuren/Review).
    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, jobSignal, undefined, SCHEMA_BOOK_CHAT, chatTemperature());
    // Job-State auf echte Provider-Werte setzen (Ollama/Llama melden prompt_tokens
    // erst am Streaming-Ende; ohne diesen Update bleibt die Status-Anzeige auf
    // einem Zwischenstand und weicht von der DB-Nachricht ab).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    spent = { provider, model, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn };
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, fallback } = _parseChatResponse(text);
    if (fallback) {
      logger.warn('Buch-Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    }

    // Assistant-Nachricht in DB speichern (vorschlaege=NULL)
    const assistantNow = new Date().toISOString();
    const bookChatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, antwort, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, provider, model, bookChatTps, JSON.stringify(contextInfo), assistantNow);
    spent = null;
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);
    const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider: effectiveProvider, logger });
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
      pagesUsed: selectedPages.length,
      pagesTotal: totalPages,
      ...(sessionTitle ? { sessionTitle } : {}),
    }, bookChatTps, `«${session.book_name || '-'}» session=${sessionId}, ${selectedPages.length}/${totalPages} Seiten`);
  } catch (e) {
    if (spent && session) {
      recordChatLedgerForFailedRun({
        jobId, userEmail, kind: 'book', bookId: session.book_id, ...spent,
        provider: spent.provider || effectiveProvider,
      });
    }
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Der agentische Pfad (Tool-Use-Loop) liegt in ./book-chat-agent.js. Er braucht
// runBookChatJob (Rückfall) und die Overrides von hier — darum lädt der Dispatcher
// ihn erst beim Aufruf (sonst zirkulärer require mit halbfertigen Exports).
function _agent() { return require('./book-chat-agent'); }

// Pfadwahl haengt am EFFEKTIVEN Provider (KI-Profil aus app_users.ai_profile_id vor
// globalem `ai.provider`), nicht am globalen Setting: ein auf openai-compat
// uebersteuerter User landete bei global=claude sonst im Claude-Pfad. userEmail ist im
// Dispatch-Pfad vorhanden; ohne Argument zieht resolveProvider den User aus dem
// ALS-Context des Job-Workers.
//
// Ob ueberhaupt Werkzeuge gehen, entscheidet `providerSupportsTools`
// (lib/ai/config.js) — dieselbe Frage, die auch der Dispatch in lib/ai/core.js
// stellt. Zwei verschiedene Fragen an dieser Stelle hiessen: Job waehlt den
// agentischen Pfad, und der erste Call wirft «Tool-Use nicht unterstuetzt».
// `mode='agent'` erzwingt nichts, was der Provider nicht kann — es schaltet nur den
// klassischen Pfad als Alternative aus.
function _bookChatUseAgent(userEmail) {
  const provider = resolveProvider({ userEmail });
  const mode = String(appSettings.get('jobs.book_chat.mode') || 'auto').toLowerCase();
  if (mode === 'classic') return false;
  return providerSupportsTools(provider);
}

// Dispatcher: wählt zwischen Agent-Pfad und klassischem Pfad.
function runBookChatJobDispatch(jobId, sessionId, userMsgId, message, userEmail) {
  if (_bookChatUseAgent(userEmail)) {
    return _agent().runBookChatJobAgent(jobId, sessionId, userMsgId, message, userEmail);
  }
  return runBookChatJob(jobId, sessionId, userMsgId, message, userEmail);
}

module.exports = {
  runBookChatJob, runBookChatJobDispatch, _applyBookChatAiOverrides,
  get runBookChatJobAgent() { return _agent().runBookChatJobAgent; },
};
