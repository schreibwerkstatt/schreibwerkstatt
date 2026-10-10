'use strict';
// Geteilter agentischer Chat-Loop (Tool-Use), genutzt von Buch-Chat und
// Recherche-Chat. `makeAgenticChatJob(config)` liefert die `runXxxJob`-Funktion;
// beide Chats teilen Loop, Token-Accounting, erzwungenen Synthese-Turn und
// Persistenz-Tail. Die chat-spezifischen Achsen (Provider, Tools, System-Prompt,
// Tool-Executor, final_answer-Auswertung, context_info, Abschluss-Payload)
// kommen als Callbacks aus der Config — analog zu makeChatMethods
// (public/js/chat/chat-base.js) im Frontend.
//
// config = {
//   startLabel, errLabel,                  // Log-Beschriftung ('Agent' / 'Recherche-Chat')
//   callProvider,                          // 7. Arg von callAIWithTools (undefined = ALS/global, 'claude' = erzwungen)
//   resolveProvider(userEmail, logger),    // effektiver Provider-String; darf setContext-Overrides setzen
//   validate({ userEmail }),               // optional, läuft im try → wirft via i18nError (z.B. Claude-only-Guard)
//   loadSession(sessionId, userEmail),     // Session-Row (inkl. book_name) oder null
//   prepare(args) → { systemPrompt, tools, maxToolIter, tokenBudget, toolResultCap?, forceFinalInstruction, ctx,
//                     toolsForIter?, inputTokenCap?, inputCapInstruction? }
//     args enthält u.a. `message` (die aktuelle Userfrage) und `history` (bisheriger
//     Verlauf ohne die aktuelle Frage) — der Buch-Chat zieht daraus seinen
//     semantischen Erst-Kontext, bevor der Loop startet.
//     toolsForIter({ iter, webSearches }) → Werkzeugliste dieser Runde (opt-in; ohne
//       Hook gilt `tools`). Der Synthese-Turn bietet immer nur final_answer aus `tools`.
//     inputTokenCap: Kosten-Deckel — kumulierte Input-Tokens pro Antwort. Erreicht,
//       läuft statt weiterer Runden der erzwungene Synthese-Turn (mit
//       inputCapInstruction ?? forceFinalInstruction). 0/undefined = aus.
//     maxToolsPerRound / roundResultCapChars (opt-in): Deckel pro Runde — Zahl der
//       ausgeführten Werkzeug-Aufrufe bzw. Summe der Ergebnis-Zeichen. Überzählige
//       Aufrufe bekommen ein Fehler-tool_result (Paarung tool_use↔tool_result bleibt
//       gültig), statt auszufallen. Ohne Angabe: kein Deckel.
//     userPreamble (opt-in): Text, der der aktuellen Frage in DERSELBEN User-Nachricht
//       vorangestellt wird (Buch-Chat: Erst-Kontext). Pro Frage wechselnder Kontext
//       gehört hierhin statt in den System-Prompt, sonst bricht er den Cache-Präfix
//       für Werkzeuge + System + Historie. Persistiert wird nur die Frage.
//     cacheHistory (opt-in): Cache-Breakpoint auf das Ende der Historie, damit der
//       nächste Turn Werkzeuge + System + Verlauf aus dem Cache liest (nur Claude).
//   executeTool(name, input, ctx),
//   consumeFinalAnswer({ finalUse, ctx, toolLog, iterNum, logger }) → finalText (JSON-String),
//   parseFinal(finalText, logger) → antwort-String,
//   buildContextInfo({ toolLog, iter, webSearches, webResults, webQueries, ctx, stopReason, costUsd }) → object,
//     stopReason: 'final_answer' | 'prose' | 'max_iter' | 'input_cap' | 'context_budget'
//       (context_budget: Kontextfenster-Schutz — die Runde, die das Budget sprengen
//       würde, wird nicht mehr ausgeführt; Antwort aus der erzwungenen Synthese)
//     costUsd:    Kosten dieser Antwort (lib/pricing, 0 für Nicht-Claude)
//   buildCompletePayload?({ base, ctx }) → object (default: base),
//   buildSummary({ session, sessionId, toolLog, iter, webSearches, ctx }) → string,
//   fallbackJob?(jobId, sessionId, userMsgId, message, userEmail),
//     optional: uebernimmt den Job, wenn der Provider kein Tool-Protokoll spricht
//     (Fehler-Code AI_TOOLS_UNSUPPORTED). Der Buch-Chat haengt hier seinen
//     klassischen Pfad ein — ein Endpunkt, der Function-Calling ablehnt, kostet
//     dann keine Antwort, sondern nur den agentischen Mehrwert. Nur solange noch
//     KEIN Provider-Call geantwortet hat: mitten im Lauf hiesse der Rueckfall, die
//     bezahlten Runden wegzuwerfen und eine zweite Antwort auf anderem Weg zu bauen.
// }
//
// Fehlerpfade: ein Provider-Fehler (auch im Synthese-Turn) endet als Job-Fehler mit
// i18n-Meldung — nie als gespeicherte Platzhalter-Antwort. Was bis dahin verbraucht
// wurde, landet trotzdem im Kosten-Ledger (recordChatLedgerForFailedRun).

const { db } = require('../../db/schema');
// Spät gebunden (ai.callAIWithTools statt Destructuring): der Loop-Unit-Test ersetzt
// den Provider-Call am Modul-Export.
const ai = require('../../lib/ai');
const { getContextConfigFor } = ai;
const { costUsd } = require('../../lib/pricing');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  jobAbortControllers, buildChatMessageHistory,
} = require('./shared');
const appSettings = require('../../lib/app-settings');
const { recordChatLedgerForMessage, recordChatLedgerForFailedRun } = require('../../db/cost-ledger');
const { generateSessionTitle } = require('./chat-title');

// Modell-Drift: schreibt Prosa-Antwort und hängt am Ende ```json\n{}\n``` als
// Compliance-Theater an. extractBalancedJson greift dann das leere {} → antwort
// fehlt. Trailing-Fence vor Speicherung entfernen.
function stripTrailingEmptyJson(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*```(?:json)?\s*\{\s*\}\s*```\s*$/i, '')
    .replace(/\s*\{\s*\}\s*$/, '')
    .trim();
}

// Provider-gerechter Model-Fallback, falls kein callAIWithTools-Result ein Model
// lieferte (z.B. wenn alle Iterationen scheiterten). Sonst würde die Zeile mit dem
// Claude-Model + Claude-Pricing persistiert, obwohl der Job unter ollama/openai-
// compat lief — Cost-Ledger (recordChatLedgerForMessage) liest provider+model direkt
// aus der chat_messages-Zeile.
function _defaultModelFor(provider) {
  if (provider === 'ollama')        return appSettings.get('ai.ollama.model') || 'llama3.2';
  if (provider === 'openai-compat') return appSettings.get('ai.openai-compat.model') || 'llama3.2';
  return appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
}

// Gespeicherte Fallback-Antworten (`__i18n:chat.errors.…__`) sind für das Frontend
// bestimmt, nicht für das Modell: roh im Verlauf hält es den Marker für Gesprächstext
// und ahmt ihn im Zweifel nach. Ersetzt wird nur die Antwort, die Frage davor bleibt —
// so bleibt die Rollen-Alternanz intakt, und das Modell sieht, dass die Frage offen ist.
const I18N_MARKER_RE = /__i18n:[a-zA-Z0-9_.-]+__/g;
const FALLBACK_PLACEHOLDER = '[Keine inhaltliche Antwort: der Lauf zu dieser Frage endete ohne verwertbares Ergebnis.]';
function _neutralizeMarkers(content) {
  return typeof content === 'string' ? content.replace(I18N_MARKER_RE, FALLBACK_PLACEHOLDER) : content;
}

// Belege früherer Antworten (context_info.citations, nur gültige) kompakt an den
// Assistant-Turn im Verlauf hängen: ohne sie kennt das Modell bei einer Folgefrage
// («und was sagt sie danach?») nur die eigene Prosa, nicht mehr die Stellen, auf die
// sie sich stützte — und sucht sie neu. Gedeckelt, der Verlauf soll nicht wachsen.
const HISTORY_CITATIONS_MAX = 6;
const HISTORY_CITATION_QUOTE_MAX = 160;
function _citationNote(row) {
  if (row.role !== 'assistant' || !row.context_info) return '';
  let ci;
  try { ci = JSON.parse(row.context_info); } catch { return ''; }
  const cites = Array.isArray(ci?.citations) ? ci.citations.filter(c => c && c.valid && c.quote) : [];
  if (!cites.length) return '';
  const lines = cites.slice(0, HISTORY_CITATIONS_MAX).map((c) => {
    const q = String(c.quote);
    const quote = q.length > HISTORY_CITATION_QUOTE_MAX ? q.slice(0, HISTORY_CITATION_QUOTE_MAX) + '…' : q;
    const where = c.page_id ? `Abschnitt «${c.page_name || '?'}» (page_id ${c.page_id})` : 'Abschnitt unbekannt';
    return `(${c.n}) ${where}: «${quote}»`;
  });
  return `[Belege dieser Antwort: ${lines.join(' ')}]`;
}

// Rolling-Window: erste user+assistant-Runde als Kontext-Anker + die letzten
// tailMessages Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
// Rollen strikt alternierend, Beginn mit user: ein Tail, der mit einer Antwort
// beginnt, stünde sonst direkt hinter der Anker-Antwort (zwei Assistant-Turns in
// Folge — Anthropic verschmilzt sie stumm, strikte Chat-Vorlagen lokaler Modelle
// werfen). Führende Antworten des Tails fallen darum weg.
function buildAgenticHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId, { annotate: _citationNote })
    .map(m => (m.role === 'assistant' ? { ...m, content: _neutralizeMarkers(m.content) } : m));
  while (all.length && all[0].role !== 'user') all.shift();
  if (all.length <= tailMessages + 2) return all;
  const anchor = all[1]?.role === 'assistant' ? [all[0], all[1]] : [all[0]];
  const tail = all.slice(-tailMessages);
  while (tail.length && tail[0].role === 'assistant') tail.shift();
  return [...anchor, ...tail];
}

// Leere Antwort (final_answer mit antwort:"" oder Prosa ohne Text) nie roh speichern:
// _parseChatResponse fiele sonst auf den Rohtext zurück, und im Chat stünde
// `{"antwort":""}`. Stattdessen ein i18n-Marker, den das Frontend auflöst.
const EMPTY_ANSWER_MARKER = '__i18n:chat.errors.emptyAnswer__';
function _ensureNonEmptyFinal(finalText) {
  if (typeof finalText !== 'string' || !finalText.trim()) return JSON.stringify({ antwort: EMPTY_ANSWER_MARKER });
  const t = finalText.trim();
  if (!t.startsWith('{')) return finalText;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object' && 'antwort' in obj && !String(obj.antwort ?? '').trim()) {
      return JSON.stringify({ ...obj, antwort: EMPTY_ANSWER_MARKER });
    }
  } catch { /* kein JSON → Parser des Chats entscheidet */ }
  return finalText;
}

// Prosa-Abschluss (Modell beendet ohne final_answer): Prosa IST die Antwort.
function _proseFinal(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  return raw.startsWith('{') ? raw : JSON.stringify({ antwort: stripTrailingEmptyJson(raw) || raw });
}

// Grobe Input-Schätzung eines Calls über die serialisierte Request-Form (System +
// Werkzeugkatalog + Nachrichten) — dieselbe Heuristik wie der Preflight im
// openai-compat-Pfad. Den echten Wert meldet erst der Provider; die Schätzung
// reicht, um eine Runde, die das Fenster sprengen würde, gar nicht erst zu senden.
function _estimateTokens(systemPrompt, tools, messages, charsPerToken) {
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  return Math.ceil(JSON.stringify({ s: systemPrompt, t: tools, m: messages }).length / cpt);
}

// Vor dem Synthese-Turn: passt der Prompt nicht ins Budget, die Ergebnisse der
// jüngsten Werkzeug-Runde gleichmässig kürzen (letzter Ausweg: durch eine Notiz
// ersetzen). Die tool_result-Blöcke bleiben stehen — die Paarung mit den tool_use-
// Blöcken davor ist Pflicht, sonst antwortet die API mit 400.
const TRIM_NOTE = ' … [gekürzt: Kontext-Budget erschöpft]';
function _fitMessagesToBudget(messages, estimate, budgetTokens, charsPerToken) {
  const est = estimate(messages);
  if (!(est > budgetTokens)) return { messages, trimmed: false };
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (messages[i]?.role === 'user' && Array.isArray(c) && c.some(b => b?.type === 'tool_result')) { idx = i; break; }
  }
  if (idx < 0) return { messages, trimmed: false };
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  const blocks = messages[idx].content;
  const total = blocks.reduce((n, b) => n + (b?.type === 'tool_result' && typeof b.content === 'string' ? b.content.length : 0), 0);
  const overshoot = (est - budgetTokens) * cpt + 2000;
  const keepRatio = total > 0 ? Math.max(0, (total - overshoot) / total) : 0;
  const shrunk = blocks.map((b) => {
    if (b?.type !== 'tool_result' || typeof b.content !== 'string') return b;
    const keep = Math.floor(b.content.length * keepRatio);
    return { ...b, content: keep >= 300 ? b.content.slice(0, keep) + TRIM_NOTE : TRIM_NOTE.trim() };
  });
  const out = messages.slice();
  out[idx] = { ...messages[idx], content: shrunk };
  return { messages: out, trimmed: true };
}

// Provider-Fehler im Synthese-Turn: eigener i18n-Key statt einer gespeicherten
// Platzhalter-Antwort («formuliere konkreter» wäre bei einer 529 eine falsche Auskunft).
// Schon i18n-keyed Fehler (Timeout, Kontext-Überlauf …) reisen unverändert weiter.
function _synthesisError(e) {
  if (/^(job|error)\./.test(String(e?.message || ''))) return e;
  if (e?.code === 'AI_OVERLOADED') {
    const err = i18nError('job.error.agentSynthesisOverloaded', { status: e.status || '–' });
    err.code = e.code;
    return err;
  }
  const err = i18nError('job.error.agentSynthesisFailed', { msg: String(e?.message || e).slice(0, 300) });
  if (e?.code) err.code = e.code;
  return err;
}

// Werkzeug-Ergebnis, das nicht ausgeführt wurde (kaputte Argumente, Deckel pro Runde).
// Text fürs Modell, `errorKey` für die Werkzeug-Liste im UI.
function _skipped(error, errorKey, errorParams) {
  return { error, errorKey, ...(errorParams ? { errorParams } : {}) };
}

function makeAgenticChatJob(config) {
  return async function runAgenticChatJob(jobId, sessionId, userMsgId, message, userEmail) {
    const logger = makeJobLogger(jobId);
    const provider = config.resolveProvider(userEmail, logger);
    const aiCfg = getContextConfigFor(provider);
    const state = {
      totalTokIn: 0, totalTokOut: 0,
      totalCacheRead: 0, totalCacheCreation: 0, totalCacheCreation1h: 0,
      genMs: 0, lastModel: null, webSearches: 0, webResults: [], webQueries: [], rounds: 0,
    };
    let session = null;
    let persisted = false;
    // Rückfall auf den klassischen Pfad nur, solange kein Call geantwortet hat.
    let fallbackAllowed = true;
    try {
      if (config.validate) config.validate({ userEmail });
      updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

      session = config.loadSession(sessionId, userEmail);
      if (!session) throw i18nError('job.error.sessionNotFound');
      logger.info(`Start (${config.startLabel}): «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

      const jobSignal = jobAbortControllers.get(jobId)?.signal;
      const historyWithoutLast = buildAgenticHistory(session.id).slice(0, -1);
      const prep = await config.prepare({ session, userEmail, aiCfg, logger, jobSignal, message, userMsgId, history: historyWithoutLast });
      const { systemPrompt, tools, maxToolIter, tokenBudget, forceFinalInstruction, ctx } = prep;
      const toolResultCap = prep.toolResultCap ?? Infinity;
      const inputTokenCap = Number(prep.inputTokenCap) > 0 ? Number(prep.inputTokenCap) : Infinity;
      const maxToolsPerRound = Number(prep.maxToolsPerRound) > 0 ? Number(prep.maxToolsPerRound) : Infinity;
      const roundResultCap = Number(prep.roundResultCapChars) > 0 ? Number(prep.roundResultCapChars) : Infinity;
      const estimate = (msgs, roundTools = tools) => _estimateTokens(systemPrompt, roundTools, msgs, aiCfg.charsPerToken);

      // Historie: optional mit Cache-Breakpoint am Ende (lib/ai/claude.js wertet die
      // Markierung aus, die übrigen Provider ignorieren sie). Erst-Kontext o.ä. steht
      // als eigener Textblock VOR der Frage in derselben Nachricht.
      const history = prep.cacheHistory && historyWithoutLast.length
        ? [...historyWithoutLast.slice(0, -1), { ...historyWithoutLast.at(-1), cacheBreakpoint: true }]
        : historyWithoutLast;
      const currentUser = prep.userPreamble
        ? { role: 'user', content: [{ type: 'text', text: `${prep.userPreamble}\n\n` }, { type: 'text', text: message }] }
        : { role: 'user', content: message };
      let messages = [...history, currentUser];

      // Token-Summen fortschreiben + UI mit echten Provider-Zahlen nachziehen
      // (onProgress liefert nur eine chars-basierte Schätzung über Text und
      // Werkzeug-Eingaben, ohne Denk-Tokens). Zählt zudem
      // web_search-Nutzung (server_tool_use-Blöcke, nur Claude-Web-Suche) und
      // sammelt die web_search_result-Trefferdokumente in Auftrittsreihenfolge
      // (für klickbare Zitat-Quellen im Recherche-Chat). NICHT dedupen: das
      // Modell referenziert Treffer über ihre Position (`(cite index="N-…">` →
      // N-tes Dokument); Dedup würde die Indizes verschieben. Buch-Chat nutzt
      // keine Web-Suche → bleibt leer und unberührt.
      const accumulate = (result) => {
        state.totalTokIn  += result.tokensIn;
        state.totalTokOut += result.tokensOut;
        state.totalCacheRead       += (result.cacheReadIn || 0);
        state.totalCacheCreation   += (result.cacheCreationIn || 0);
        state.totalCacheCreation1h += (result.cacheCreation1hIn || 0);
        if (result.genDurationMs) state.genMs += result.genDurationMs;
        if (result.model) state.lastModel = result.model;
        for (const b of result.rawContentBlocks || []) {
          if (b.type === 'server_tool_use' && b.name === 'web_search') {
            state.webSearches++;
            state.webQueries.push(String(b.input?.query || ''));
          }
          // Fehler-Results haben content als Objekt (nicht Array) → Array-Guard.
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
            for (const r of b.content) {
              if (r && r.type === 'web_search_result' && r.url) {
                state.webResults.push({ url: r.url, title: r.title || r.url });
              }
            }
          }
        }
        updateJob(jobId, {
          tokensIn: state.totalTokIn, tokensOut: state.totalTokOut,
          cacheReadIn: state.totalCacheRead, cacheCreationIn: state.totalCacheCreation,
          cacheCreation1hIn: state.totalCacheCreation1h,
        });
      };

      const onProgress = ({ chars, tokIn }) => {
        const updates = {};
        if (tokIn > 0)  updates.tokensIn  = state.totalTokIn + tokIn;
        if (chars > 0)  updates.tokensOut = state.totalTokOut + Math.floor(chars / aiCfg.charsPerToken);
        if (Object.keys(updates).length) updateJob(jobId, updates);
      };

      const call = async (msgs, roundTools) => {
        const result = await ai.callAIWithTools(msgs, systemPrompt, roundTools, onProgress, undefined, jobSignal, config.callProvider);
        fallbackAllowed = false;
        state.rounds++;
        accumulate(result);
        if (result.truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: state.totalTokIn, tokOut: state.totalTokOut, total: state.totalTokIn + state.totalTokOut });
        return result;
      };

      const toolLog = [];
      let finalText = null;
      let stopReason = null;
      let iter = 0;

      // Werkzeuge einer Runde ausführen (Ergebnisse als tool_result-Blöcke). Auch in
      // der final_answer-Runde: Seiteneffekte in ctx (propose_research_item,
      // generate_image) dürfen nicht verloren gehen, nur weil das Modell in derselben
      // Runde schon abschliesst. Jeder tool_use bekommt GENAU ein tool_result — auch
      // die nicht ausgeführten (kaputte Argumente, Deckel pro Runde), sonst ist die
      // Folgerunde ein 400.
      const runTools = async (toolUses, iterNum) => {
        const toolResults = [];
        let roundChars = 0;
        let executed = 0;
        for (const tu of toolUses) {
          if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const t0 = Date.now();
          let out, ok = true, errMsg = null;
          const remaining = roundResultCap - roundChars;
          if (tu.parseError) {
            out = _skipped(`Werkzeug-Argumente waren kein gültiges JSON (${String(tu.parseError).slice(0, 120)}) – Aufruf NICHT ausgeführt. Wiederhole ihn mit gültigen Argumenten.`, 'chat.toolError.invalidArgs');
          } else if (executed >= maxToolsPerRound) {
            out = _skipped(`Nicht ausgeführt: höchstens ${maxToolsPerRound} Werkzeug-Aufrufe pro Runde. Fordere ihn in der nächsten Runde erneut an, falls er noch nötig ist.`, 'chat.toolError.roundLimit', { max: maxToolsPerRound });
          } else if (remaining < 500) {
            out = _skipped('Nicht ausgeführt: das Ergebnis-Budget dieser Runde ist ausgeschöpft. Fordere den Aufruf in der nächsten Runde erneut an, falls er noch nötig ist.', 'chat.toolError.roundBudget');
          } else {
            executed++;
            try {
              out = await config.executeTool(tu.name, tu.input, ctx);
            } catch (e) {
              if (e.name === 'AbortError') throw e;
              ok = false; errMsg = e.message; out = { error: e.message };
            }
          }
          const durationMs = Date.now() - t0;
          // errorKey/errorParams sind fürs UI (Werkzeug-Liste), nicht fürs Modell.
          let errorKey = null, errorParams = null;
          if (out && typeof out === 'object' && !Array.isArray(out) && ('errorKey' in out || 'errorParams' in out)) {
            ({ errorKey = null, errorParams = null } = out);
            const { errorKey: _k, errorParams: _p, ...rest } = out;
            out = rest;
          }
          const content = JSON.stringify(out);
          const resultBytes = content.length;
          const cap = Math.min(toolResultCap, remaining);
          const truncated = resultBytes > cap || !!(out && typeof out === 'object' && out.truncated);
          if (out && typeof out === 'object' && out.error && ok) errMsg = String(out.error);
          const sent = resultBytes > cap ? content.slice(0, cap) + '…' : content;
          roundChars += sent.length;
          toolLog.push({
            name: tu.name, input: tu.input, ok: ok && !(out && out.error), durationMs, resultBytes, truncated, iter: iterNum,
            ...(errMsg ? { error: errMsg } : {}),
            ...(errorKey ? { errorKey } : {}),
            ...(errorKey && errorParams ? { errorParams } : {}),
          });
          if (ok && !(out && out.error)) logger.info(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes}${truncated ? ' truncated' : ''} iter=${iterNum}`);
          else logger.warn(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes} iter=${iterNum} FAILED: ${errMsg}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: sent,
            ...(out && out.error ? { is_error: true } : {}),
          });
        }
        return toolResults;
      };

      for (iter = 0; iter < maxToolIter; iter++) {
        if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        updateJob(jobId, {
          statusText: 'job.phase.agentTools',
          statusParams: { current: iter + 1, total: maxToolIter },
          progress: Math.min(90, 10 + iter * 12),
        });

        const roundTools = prep.toolsForIter ? prep.toolsForIter({ iter, webSearches: state.webSearches }) : tools;
        // Kontextfenster-Schutz VOR dem Call: die angehängten Werkzeug-Ergebnisse der
        // Vorrunde können den Prompt über das Budget heben. Dann nicht mehr recherchieren,
        // sondern aus dem Gesammelten synthetisieren (der Synthese-Turn kürzt bei Bedarf).
        if (iter > 0) {
          const est = estimate(messages, roundTools);
          if (est > tokenBudget) {
            logger.warn(`Kontext-Budget würde überschritten (geschätzt ${est}/${tokenBudget} Input-Tokens) – erzwinge Synthese.`);
            stopReason = 'context_budget';
            break;
          }
        }
        const result = await call(messages, roundTools);

        // Serverseitiges Werkzeug (Anthropic-Web-Suche) hat den Turn pausiert: den
        // bisherigen Assistant-Inhalt zurückspielen, dann setzt die API fort. Kein
        // Abschluss — die Runde zählt aber gegen den Iterationsdeckel.
        if (result.stopReason === 'pause_turn') {
          messages.push({ role: 'assistant', content: result.rawContentBlocks });
          if (state.totalTokIn >= inputTokenCap) { stopReason = 'input_cap'; break; }
          continue;
        }

        const toolUses = result.stopReason === 'tool_use' ? (result.toolUses || []) : [];
        // final_answer zuerst auswerten — auch eine Runde über dem Kontext-Budget
        // liefert damit ihre fertige Antwort aus, statt sie zu verwerfen. Ein
        // final_answer mit kaputtem Argument-JSON ist KEINE Antwort (input wäre {}):
        // er läuft unten als fehlgeschlagenes Werkzeug, das Modell ruft ihn neu.
        const finalUse = toolUses.find(tu => tu.name === 'final_answer' && !tu.parseError);
        if (finalUse) {
          const others = toolUses.filter(tu => tu.name !== 'final_answer');
          if (others.length) await runTools(others, iter + 1);
          finalText = await config.consumeFinalAnswer({ finalUse, ctx, toolLog, iterNum: iter + 1, logger });
          stopReason = 'final_answer';
          break;
        }

        if (result.stopReason !== 'tool_use') {
          // Modell beendet mit Prosa statt final_answer-Tool (Sonnet-Drift).
          // Prosa IST die finale Antwort (Ausnahme: schon {antwort:…}-JSON → unverändert).
          finalText = _proseFinal(result.text) ?? '';
          stopReason = 'prose';
          break;
        }

        // Kontext-Budget überschritten: diese Werkzeug-Runde nicht mehr ausführen (ihre
        // Ergebnisse kämen obendrauf), sondern aus dem bisher Gesammelten synthetisieren.
        // Der Text vor dem Werkzeug-Aufruf ist Erzählung («ich schaue nach …»), keine
        // Antwort — er wird nicht gespeichert.
        if (result.tokensIn > tokenBudget) {
          logger.warn(`Context-Budget überschritten (${result.tokensIn}/${tokenBudget} Input-Tokens) – erzwinge Synthese.`);
          stopReason = 'context_budget';
          break;
        }

        // Tool-Use: alle tool_uses ausführen, als user-tool_result anhängen.
        messages.push({ role: 'assistant', content: result.rawContentBlocks });
        const toolResults = await runTools(toolUses, iter + 1);
        messages.push({ role: 'user', content: toolResults });

        // Kosten-Deckel: die Ergebnisse dieser Runde sind bezahlt und hängen an —
        // daraus synthetisieren, statt eine weitere Recherche-Runde zu starten.
        if (state.totalTokIn >= inputTokenCap) {
          logger.warn(`Input-Deckel pro Antwort erreicht (${state.totalTokIn}/${inputTokenCap} Tokens) – erzwinge Synthese.`);
          stopReason = 'input_cap';
          break;
        }
      }

      if (finalText == null) {
        // Iterationen erschöpft (oder Kosten-/Kontext-Deckel erreicht), ohne dass
        // final_answer gerufen wurde. Statt mit Fehler aufzugeben: ein erzwungener
        // Synthese-Turn. Die bereits gesammelten tool_results hängen in `messages`;
        // wir bieten dem Modell nur noch final_answer als Werkzeug an (kein
        // tool_choice-Forcing — das kollidiert mit adaptive thinking; die Werkzeug-
        // Beschränkung reicht: das Modell ruft final_answer oder antwortet in Prosa,
        // beides terminal).
        if (!stopReason) {
          stopReason = 'max_iter';
          logger.warn(`Max-Iterationen (${maxToolIter}) erreicht – erzwinge Synthese aus dem bereits gesammelten Kontext.`);
        }
        updateJob(jobId, { statusText: 'job.phase.agentSynthesize', progress: 92 });
        const instruction = stopReason === 'max_iter' ? forceFinalInstruction : (prep.inputCapInstruction ?? forceFinalInstruction);
        const finalOnlyTools = tools.filter(t => t.name === 'final_answer');
        const fit = _fitMessagesToBudget([...messages, { role: 'user', content: instruction }], m => estimate(m, finalOnlyTools), tokenBudget, aiCfg.charsPerToken);
        if (fit.trimmed) logger.warn('Synthese-Turn: Ergebnisse der letzten Werkzeug-Runde aufs Kontext-Budget gekürzt.');
        messages = fit.messages;
        let result;
        try {
          result = await call(messages, finalOnlyTools);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          logger.warn(`Synthese-Turn fehlgeschlagen: ${e.message}`);
          throw _synthesisError(e);
        }
        const finalUse = result.toolUses?.find(tu => tu.name === 'final_answer');
        // Kaputtes Argument-JSON im letzten möglichen Turn: keine Antwort, die man
        // speichern könnte — ehrlich als Fehler melden statt `{}` als leere Antwort.
        if (finalUse?.parseError) throw i18nError('job.error.agentFinalAnswerInvalid');
        if (finalUse) {
          finalText = await config.consumeFinalAnswer({ finalUse, ctx, toolLog, iterNum: state.rounds, logger });
        } else {
          // Modell antwortete in Prosa statt via final_answer — Prosa IST die Antwort.
          finalText = _proseFinal(result.text);
        }
        if (finalText == null) finalText = JSON.stringify({ antwort: '__i18n:chat.errors.maxIterReached__' });
      }

      finalText = _ensureNonEmptyFinal(finalText);
      const antwort = config.parseFinal(finalText, logger);

      const assistantNow = new Date().toISOString();
      const tpsVal = (state.genMs > 0 && state.totalTokOut > 0) ? state.totalTokOut / (state.genMs / 1000) : null;
      const model = state.lastModel || _defaultModelFor(provider);
      const answerUsd = costUsd({
        provider, model, tokensIn: state.totalTokIn, tokensOut: state.totalTokOut,
        cacheReadIn: state.totalCacheRead, cacheCreationIn: state.totalCacheCreation,
        cacheCreation1hIn: state.totalCacheCreation1h, webSearches: state.webSearches,
      });
      const contextInfo = config.buildContextInfo({
        toolLog, iter, webSearches: state.webSearches, webResults: state.webResults,
        webQueries: state.webQueries, ctx, stopReason, costUsd: answerUsd,
      });
      const asstMsgResult = db.prepare(`
        INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, web_searches, provider, model, tps, context_info, created_at)
        VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, antwort, state.totalTokIn, state.totalTokOut, state.totalCacheRead, state.totalCacheCreation, state.totalCacheCreation1h, state.webSearches, provider, model, tpsVal, JSON.stringify(contextInfo), assistantNow);
      persisted = true;
      db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
      recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);

      const sessionTitle = await generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger });

      const base = {
        session_id: session.id,
        user_message_id: userMsgId,
        assistant_message_id: asstMsgResult.lastInsertRowid,
        tokensIn: state.totalTokIn, tokensOut: state.totalTokOut,
        toolCalls: toolLog.length, iterations: iter + 1,
        ...(sessionTitle ? { sessionTitle } : {}),
      };
      const payload = config.buildCompletePayload ? config.buildCompletePayload({ base, ctx }) : base;
      completeJob(jobId, payload, tpsVal, config.buildSummary({ session, sessionId, toolLog, iter, webSearches: state.webSearches, ctx }));
    } catch (e) {
      // Provider kann keine Werkzeuge: derselbe Job noch einmal auf dem Fallback-Pfad.
      // Sicher, weil AI_TOOLS_UNSUPPORTED nur aus callAIWithTools kommt und der
      // Rückfall nur vor der ersten beantworteten Runde greift — also vor jedem
      // Schreibpfad (Assistant-Nachricht, Ledger, Session-Titel).
      if (e?.code === 'AI_TOOLS_UNSUPPORTED' && config.fallbackJob && e.name !== 'AbortError' && fallbackAllowed) {
        logger.warn(`${config.errLabel}: Tool-Use nicht verfuegbar (${e.message}) – Rueckfall auf den klassischen Pfad.`);
        return config.fallbackJob(jobId, sessionId, userMsgId, message, userEmail);
      }
      // Bezahlte Runden eines gescheiterten/abgebrochenen Laufs: ohne Assistant-
      // Nachricht fehlte ihr Verbrauch sonst im Ledger (Budget-Gate, Admin-Usage).
      if (!persisted && session) {
        recordChatLedgerForFailedRun({
          jobId, userEmail: session.user_email || userEmail, kind: session.kind, bookId: session.book_id,
          provider, model: state.lastModel || _defaultModelFor(provider),
          tokensIn: state.totalTokIn, tokensOut: state.totalTokOut,
          cacheReadIn: state.totalCacheRead, cacheCreationIn: state.totalCacheCreation,
          cacheCreation1hIn: state.totalCacheCreation1h, webSearches: state.webSearches,
        });
      }
      if (e.name !== 'AbortError') logger.error(`${config.errLabel}-Fehler: ${e.message}`, { stack: e.stack });
      failJob(jobId, e);
    }
  };
}

module.exports = { makeAgenticChatJob, buildAgenticHistory, stripTrailingEmptyJson, EMPTY_ANSWER_MARKER };
