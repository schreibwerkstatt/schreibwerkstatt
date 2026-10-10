'use strict';
// Seiten-Chat-Job (kind='page'): klassischer Chat neben dem Editor; Antwort-
// Envelope mit `vorschlaege` (zeichengenaue Textersetzung) + updatedAt-Staleness.

const { db } = require('../../../db/schema');
const { getSessionRow } = require('../../../db/chat-sessions');
const { callAIChat, chatTemperature, getContextConfigFor, resolveProvider } = require('../../../lib/ai');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  getPrompts, getBookPrompts,
  htmlToText, htmlToTextForPrompt, jobAbortControllers,
  getFiguren, getLatestReview, getLatestPageCheck, getOpenIdeen, buildChatMessageHistory,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const { generateSessionTitle } = require('../chat-title');
const { recordChatLedgerForMessage } = require('../../../db/cost-ledger');
const { _parseChatResponse, figurenBlockChars } = require('./shared');
const { pageChatBudget, computePageChangeHunks, fitHistory } = require('./page-chat-context');
const { annotateVorschlagMatches } = require('./page-chat-verify');
const { preContextPassages, retrievalQuery } = require('./book-chat-retrieval');
const embed = require('../../../lib/embed');
const appSettings = require('../../../lib/app-settings');
const { normalizeChatIdeeProposals } = require('../../../lib/chat-idee-proposals');

// Zeichendeckel des Buch-Kontext-Blocks: der kleinere Wert aus dem Erst-Kontext-
// Deckel des Buch-Chats und 10 % des Seiten-Chat-Budgets — der Block ist Beiwerk,
// die Seite und der Verlauf haben Vorrang.
function _pageChatRagChars(budget) {
  const base = parseInt(appSettings.get('jobs.book_chat.pre_rag_chars'), 10) || 0;
  return Math.max(0, Math.min(base, Math.floor(budget.total * 0.1)));
}

// Buchweiter Kontext (non-fatal): die semantisch nächsten Stellen zur Frage aus
// ANDEREN Seiten (+ Szenen/Figuren/Orte/Fakten), aktuelle Seite ausgeschlossen —
// sie steht vollständig im Prompt. Ohne Embedding-Endpunkt, mit top_k = 0 oder bei
// Backend-Fehler kein Block. Nur ein Abbruch wird weitergeworfen.
async function _pageChatBookContext(session, query, budget, signal, userEmail, logger) {
  const topK = parseInt(appSettings.get('jobs.page_chat.pre_rag_top_k'), 10);
  const chars = _pageChatRagChars(budget);
  if (!embed.isEnabled() || !(topK > 0) || chars < 500) return null;
  try {
    return await preContextPassages(session.book_id, query, {
      signal, userEmail, topK, chars, excludePageIds: [session.page_id],
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    logger.warn(`Buch-Kontext-Retrieval fehlgeschlagen (${e.message}) – Seiten-Chat ohne Buch-Kontext.`);
    return null;
  }
}

async function runChatJob(jobId, sessionId, userMsgId, message, userEmail) {
  const logger = makeJobLogger(jobId);
  const {
    buildChatSystemPrompt, SCHEMA_CHAT, formatHistoryVorschlaege, formatHistoryIdeen, historyTrimNote, formatPageChange,
    buildPageChatBookContext,
  } = await getPrompts(userEmail);
  const aiCfg = getContextConfigFor(resolveProvider({ userEmail }));
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = getSessionRow(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');

    // Seiteninhalt frisch laden (via content-store). Name und Kapitel kommen aus
    // derselben Zeile — das Kapitel filtert unten die Figuren. Ohne Seite gibt es
    // keinen Seiten-Chat: ein Fehlschlag endet als Job-Fehler, nicht als Antwort
    // „über" eine leere Seite (deren Vorschläge auf nichts zeigen könnten).
    if (!(session.page_id > 0)) throw i18nError('job.error.pageChatLoadFailed');
    let pd;
    try {
      pd = await contentStore.loadPage(session.page_id);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      logger.warn(`Seiteninhalt konnte nicht geladen werden: ${e.message}`);
      throw i18nError('job.error.pageChatLoadFailed');
    }
    // Zwei Sichten derselben Seite: `pageText` (kompakt, einzeilig) ist die
    // Vergleichsform — Diff gegen den Stand beim Chat-Start (`opening_page_text`,
    // gleiche Normalform) und Fundstellen-Prüfung der Vorschläge. `promptText`
    // behält Absatzgrenzen als Leerzeilen: das Modell sieht Absätze und Dialog-
    // wechsel und schlägt keine `original` über eine Absatzgrenze vor (die der
    // Apply-Guard ohnehin abwiese). Der Matcher kollabiert Whitespace, `\n\n` in
    // einem `original` ist darum unschädlich.
    const pageText = htmlToText(pd.html || '');
    const promptText = htmlToTextForPrompt(pd.html || '');
    const pageUpdatedAt = pd.updated_at || null;
    const pageChapterId = pd.chapter_id ?? null;
    session.page_name = pd.name || null;

    // Budget (routes/jobs/chat/page-chat-context.js): Seitentext gedeckelt, Stand
    // beim Chat-Start nur als Diff, Verlauf auf den Rest gekürzt.
    const budget = pageChatBudget(aiCfg);
    if (promptText.length > budget.pageMax) {
      throw i18nError('job.error.pageChatPageTooLarge', { chars: promptText.length, max: budget.pageMax });
    }
    logger.info(`Start: «${session.page_name || '-'}» session=${sessionId}, page=${session.page_id || '-'}, msg-len=${message.length}`);

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const figuren = getFiguren(session.book_id, userEmail, pageChapterId);
    const review  = getLatestReview(session.book_id, userEmail);
    const ideen    = getOpenIdeen(session.page_id, userEmail);
    const lektorat = getLatestPageCheck(session.page_id, userEmail);
    const { SYSTEM_CHAT: chatSysPrompt } = await getBookPrompts(session.book_id, userEmail);
    // opening_page_text: Snapshot beim Chat-Öffnen. Hat der Autor seither
    // editiert, geht nur ein kompakter Wort-Diff an die KI — nie eine zweite
    // Vollfassung neben dem aktuellen Stand.
    const pageChange = computePageChangeHunks(session.opening_page_text, pageText, { maxChars: budget.changeNoteMax });
    const pageChangeNote = pageChange ? formatPageChange(pageChange) : null;
    // Figuren sind hier kapitel-gefiltert, aber ebenfalls Volldossiers → gebudgetet
    // (gleicher Deckel wie im Buch-Chat, siehe figurenBlockChars).
    const systemPrompt = buildChatSystemPrompt(session.page_name || '–', promptText, figuren, review,
      chatSysPrompt, pageChangeNote, ideen, lektorat, { figurenMaxChars: figurenBlockChars(aiCfg) });

    const annotate = (r) => {
      if (r.role !== 'assistant') return '';
      const parts = [];
      if (r.vorschlaege) {
        try { parts.push(formatHistoryVorschlaege(JSON.parse(r.vorschlaege))); } catch { /* kaputtes JSON: ohne Anhang */ }
      }
      if (r.context_info) {
        try { parts.push(formatHistoryIdeen(JSON.parse(r.context_info).proposals)); } catch { /* dito */ }
      }
      return parts.filter(Boolean).join('\n\n');
    };
    const fullHistory = buildChatMessageHistory(session.id, { annotate }).slice(0, -1);

    // Buch-Kontext: pro Frage andere Bytes → eigener dritter System-Block OHNE
    // Breakpoint am Ende; Block 1 (buch-stabil) und Block 2 (seiten-stabil) bleiben
    // gecachte Präfixe. Suchtext = Frage + letzte Runde (Folgefragen).
    const signal = jobAbortControllers.get(jobId)?.signal;
    const bookCtx = await _pageChatBookContext(session, retrievalQuery(message, fullHistory), budget, signal, userEmail, logger);
    const bookCtxText = bookCtx ? buildPageChatBookContext(bookCtx.hits) : '';
    if (bookCtxText) {
      systemPrompt.push({ text: bookCtxText, cache: false });
      logger.info(`Buch-Kontext: ${bookCtx.hits.length} Stellen, ${bookCtx.chars} Zeichen.`);
    }

    // Konversationshistorie: frühere Vorschläge samt Status als Anhang der
    // jeweiligen Antwort, dann auf das Restbudget gekürzt (älteste zuerst).
    const sysChars = systemPrompt.reduce((n, b) => n + (b.text || '').length, 0);
    const historyBudget = budget.total - sysChars - message.length;
    if (historyBudget < 0) {
      throw i18nError('job.error.pageChatContextFull', { chars: sysChars + message.length, max: budget.total });
    }
    const { messages: history, dropped } = fitHistory(fullHistory, historyBudget);
    const aiMessages = [...history, { role: 'user', content: message }];
    if (dropped > 0) {
      aiMessages[0] = { ...aiMessages[0], content: `${historyTrimNote(dropped)}\n\n${aiMessages[0].content}` };
      logger.info(`Verlauf gekürzt: ${dropped} ältere Nachricht(en) weggelassen (Budget ${historyBudget} Zeichen).`);
    }

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 10 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 10 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    // cacheLastMessage: ohne Buch-Kontext ist der System-Prompt über die Turns einer
    // Session stabil (Block 1 buch-stabil, Block 2 seiten-stabil) und das Multi-Turn-
    // Caching der Konversationshistorie greift. Mit Buch-Kontext steht vor dem
    // Verlauf ein Block, der jede Frage wechselt — ein Breakpoint auf der letzten
    // Nachricht wäre dann ein cache_write, das nie gelesen wird.
    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, signal, undefined, SCHEMA_CHAT, chatTemperature(), !bookCtxText);
    // Job-State auf echte Provider-Werte setzen, damit Status-Anzeige und
    // gespeicherte Chat-Nachricht dieselben Tokens zeigen (statt eines
    // Streaming-Zwischenstands).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, vorschlaege, titel_varianten: titelVarianten, ideen: rawIdeen, fallback, lostVorschlaege } = _parseChatResponse(text);
    // Ideen-Vorschläge: Anker = dieser Abschnitt (eine page_id des Modells darf
    // auf einen anderen Abschnitt desselben Buchs zeigen). Nichts wird angelegt —
    // der User erfasst jeden einzeln (POST /ideen).
    const ideenProposals = normalizeChatIdeeProposals(rawIdeen, { bookId: session.book_id, defaultPageId: session.page_id });
    // Fundstellen-Prüfung gegen den Text, den das Modell gesehen hat: „Stelle nie
    // gefunden" ist eine andere Aussage als „inzwischen veraltet" (UI).
    await annotateVorschlagMatches(vorschlaege, pageText);
    const unmatched = vorschlaege.filter(v => v.match).length;
    if (unmatched) logger.info(`${unmatched} von ${vorschlaege.length} Vorschlägen ohne eindeutige Fundstelle.`);
    if (fallback) {
      logger.warn(`Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert${lostVorschlaege ? ', Vorschläge verloren' : ''}.`);
    }
    // Seiten-Chat-Metadaten im vorhandenen `context_info`-JSON (keine eigene
    // Spalte): Parse-Fallback + verlorene Vorschläge (UI-Hinweis), Titelvarianten,
    // gekürzter Verlauf.
    const contextInfo = {
      ...(fallback ? { parse_fallback: true } : {}),
      ...(lostVorschlaege ? { lost_vorschlaege: true } : {}),
      ...(titelVarianten.length ? { titel_varianten: titelVarianten } : {}),
      ...(ideenProposals.length ? { proposals: ideenProposals } : {}),
      ...(dropped > 0 ? { history_trimmed: dropped } : {}),
      ...(bookCtxText ? { book_context: { count: bookCtx.hits.length, chars: bookCtx.chars } } : {}),
    };

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const chatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, context_info, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      Object.keys(contextInfo).length > 0 ? JSON.stringify(contextInfo) : null,
      tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, provider, model, chatTps, assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      updatedAt: pageUpdatedAt,
      tokensIn, tokensOut,
      // Titel folgt asynchron (unten); das Frontend holt ihn mit der Historie nach.
      titlePending: !session.title,
    }, chatTps, `«${session.page_name || '-'}» session=${sessionId}, ${vorschlaege.length} Vorschläge, ${ideenProposals.length} Ideen`);
    // Titel NACH completeJob: ein zweiter KI-Call vor dem Job-Ende hielt die
    // fertige Antwort um seine ganze Laufzeit zurück. Non-fatal, persistiert selbst.
    void generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger });
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

module.exports = { runChatJob };
