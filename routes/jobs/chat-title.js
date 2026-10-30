'use strict';
// Generiert einen kurzen, KI-zusammengefassten Titel für den History-Eintrag
// einer Chat-Session (Seiten-/Buch-/Recherche-Chat). Wird einmal pro Session
// erzeugt — beim ersten Antwort-Turn; danach via vorhandenem title-Feld
// übersprungen. Non-fatal: schlägt die Generierung fehl, bleibt title NULL und
// das Frontend fällt auf die Vorschau (erste Nachricht) zurück.

const { db } = require('../../db/schema');
// Spät gebunden (ai.callAI statt Destructuring): Unit-Tests ersetzen den Call am Export.
const ai = require('../../lib/ai');
const { getPromptsForProvider } = require('../../lib/prompts-loader');
const { recordChatLedgerEntry } = require('../../db/cost-ledger');

const MAX_TITLE_LEN = 80;
// Hartes Zeitlimit des Titel-Calls: ein Einzeiler aus ~4000 Zeichen. Er läuft
// oft NACH completeJob (Abschnitts-Chat) ausserhalb jedes Queue-Slots — ohne
// Deckel hielte ein hängender Endpunkt den Ollama-Mutex/openai-compat-Semaphor
// beliebig lange und blockierte damit alle folgenden KI-Calls.
const TITLE_TIMEOUT_MS = 60_000;

/**
 * @param {object}  args
 * @param {object}  args.session          Session-Row (braucht id + title)
 * @param {string}  args.userMessage      Frage dieser Runde (Rückfall, falls die Session
 *                                        noch keine gespeicherte Frage hat)
 * @param {string}  args.assistantAnswer  Antwort dieser Runde (Rückfall, s.o.)
 * @param {string}  args.provider         Effektiver Provider für den Titel-Call
 * @param {object} [args.logger]
 * @param {AbortSignal} [args.signal]     Abbruch des umgebenden Jobs (optional);
 *                                        zusätzlich greift TITLE_TIMEOUT_MS.
 * @returns {Promise<string|null>}        Generierter Titel oder null (Fallback)
 */
async function generateSessionTitle({ session, userMessage, assistantAnswer, provider, logger, signal = null }) {
  if (!session || session.title) return null;
  // Der Titel beschreibt das Gespräch von seiner ERSTEN Frage her. Scheiterte der
  // Titel-Call der ersten Runde, läuft er in einer späteren Runde erneut — dann
  // aber auf der ersten Frage samt ihrer Antwort, nicht auf der aktuellen Runde.
  const first = _firstTurn(session.id);
  if (first.question) {
    userMessage = first.question;
    assistantAnswer = first.answer;
  }
  const uMsg = (userMessage || '').trim();
  if (!uMsg) return null;
  try {
    const { buildChatTitlePrompt, SCHEMA_CHAT_TITLE } = await getPromptsForProvider(provider);
    const systemPrompt = buildChatTitlePrompt();
    const convo = [
      `Nutzer: ${uMsg}`,
      (assistantAnswer || '').trim() ? `Assistent: ${assistantAnswer.trim()}` : null,
    ].filter(Boolean).join('\n\n').slice(0, 4000);

    // Der Titel-Call läuft NACH der gespeicherten Antwort. Ein Abbruch (Job-Signal
    // oder Zeitlimit) bricht nur den Titel ab — er wirft hier und landet im catch
    // unten, der fertige Chat-Turn bleibt unberührt (kein failJob).
    const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
    const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await ai.callAI(convo, systemPrompt, null, 120, callSignal, provider, SCHEMA_CHAT_TITLE);
    _recordTitleCost(session, provider, res);
    const { text, truncated } = res;
    if (truncated) throw new Error('Titel-Antwort truncated');
    const parsed = ai.parseJSON(text);
    let titel = typeof parsed?.titel === 'string' ? parsed.titel.trim() : '';
    if (!titel) return null;
    // Umrahmende Anführungszeichen/Schlusspunkte abräumen, hart kappen.
    titel = titel.replace(/^[\s"'«»„“”]+|[\s"'«»„“”.]+$/g, '').slice(0, MAX_TITLE_LEN).trim();
    if (!titel) return null;
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(titel, session.id);
    logger?.info?.(`Session-Titel generiert: «${titel}» (session=${session.id}).`);
    return titel;
  } catch (e) {
    logger?.warn?.(`Session-Titel-Generierung fehlgeschlagen: ${e.message}`);
    return null;
  }
}

// Erste User-Frage der Session und ihre Antwort (die nächste Assistant-Nachricht
// vor der zweiten Frage; null, wenn die erste Runde keine hat). Antworten ohne
// Inhalt (i18n-Marker) zählen nicht.
function _firstTurn(sessionId) {
  const rows = db.prepare(`SELECT role, content FROM chat_messages
    WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT 20`).all(sessionId);
  const qi = rows.findIndex(r => r.role === 'user');
  if (qi < 0) return { question: null, answer: null };
  let answer = null;
  for (const r of rows.slice(qi + 1)) {
    if (r.role === 'user') break;
    if (r.role === 'assistant' && typeof r.content === 'string' && !r.content.startsWith('__i18n:')) { answer = r.content; break; }
  }
  return { question: rows[qi].content, answer };
}

// Der Titel-Call ist ein eigener, bezahlter KI-Call ohne Assistant-Nachricht:
// er hängt an keiner chat_messages-Zeile und (beim Abschnitts-Chat) an keinem
// laufenden Job mehr. Gebucht wird er als Chat-Verbrauch ohne Nachricht
// (db/cost-ledger.js#recordChatLedgerEntry); `source_ref` je Session ist
// idempotent, der Titel entsteht ohnehin einmal pro Session. Wirft nie.
function _recordTitleCost(session, provider, res) {
  if (!res) return;
  recordChatLedgerEntry({
    jobId: `title:${session.id}`,
    userEmail: session.user_email || null,
    kind: session.kind || null,
    bookId: session.book_id || null,
    provider: res.provider || provider,
    model: res.model || null,
    tokensIn: res.tokensIn || 0,
    tokensOut: res.tokensOut || 0,
    cacheReadIn: res.cacheReadIn || 0,
    cacheCreationIn: res.cacheCreationIn || 0,
    cacheCreation1hIn: res.cacheCreation1hIn || 0,
  });
}

module.exports = { generateSessionTitle, TITLE_TIMEOUT_MS, _firstTurn };
