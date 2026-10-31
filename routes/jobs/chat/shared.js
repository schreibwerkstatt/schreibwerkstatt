'use strict';
// Geteilte Bausteine der Chats (Seiten-/Buch-/Recherche-/Plot-Chat):
// Antwort-Parsing (lenient), gemeinsamer POST-Handler (_handleChatPost), und der
// Buch-Chat-Seiten-Cache (klassischer Pfad) inkl. Invalidierung.

const { parseJSONLenient } = require('../../../lib/ai');
const { stripTrailingEmptyJson, EMPTY_ANSWER_MARKER, REFUSAL_MARKER } = require('../agentic-chat');
const { toIntId } = require('../../../lib/validate');
const { db, getBookSettings } = require('../../../db/schema');
const { getSessionForJob } = require('../../../db/chat-sessions');
const { recordRepeat } = require('../../../db/chat-quality');
const logger = require('../../../logger');
const { resolvePageBookId } = require('../../../lib/content-ownership');
const { bus: bookEvents } = require('../../../lib/book-events');
const { guardBook, sessionEmail } = require('../../../lib/acl');
const {
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
} = require('../shared');

// Nur die Modell-Felder (`original`, `ersatz`, `begruendung`, `typ`) überleben: `applied`/`applied_at`/`status` setzt
// ausschliesslich der User über die PATCH-Routen (routes/chat.js) — ein Modell,
// das sie mitliefert, darf keinen Vorschlag als erledigt ausgeben. Auch `match`
// (Fundstellen-Prüfung) setzt erst der Job (page-chat-verify.js), nie das Modell.
// `original`/`ersatz` getrimmt gespeichert: die Fundstelle schliesst nie Rand-
// Leerraum ein, ein Ersatz mit eigenem Rand verklebte sonst Nachbarwörter bzw.
// verdoppelte den Leerraum. Eine Leerzeile im `ersatz` ist gewollt (Absatz-
// teilung, public/js/utils/html-replace-rich.js) — Zeilenenden vereinheitlicht,
// mehr als eine Leerzeile auf eine gekürzt. `typ` nur aus dem Enum, sonst weg.
const VORSCHLAG_TYPEN = new Set(['korrektur', 'stil']);
function _sanitizeVorschlaege(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    const orig = typeof v?.original === 'string' ? v.original.trim() : '';
    const ers  = typeof v?.ersatz   === 'string' ? v.ersatz.replace(/\r\n?/g, '\n').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim() : '';
    if (!orig || !ers || orig === ers) continue;
    out.push({
      original: orig,
      ersatz: ers,
      ...(typeof v.begruendung === 'string' && v.begruendung.trim() ? { begruendung: v.begruendung } : {}),
      ...(VORSCHLAG_TYPEN.has(v.typ) ? { typ: v.typ } : {}),
    });
  }
  return out;
}

// Höchstens VORSCHLAEGE_MAX Vorschläge je Antwort (Prompt: die wichtigsten
// zuerst). Mehr überfordert: von 26 Vorschlägen auf eine Frage bleibt der
// Grossteil unberührt. Der Rest wird nicht gespeichert, nur gezählt — die Karte
// zeigt «n weitere auf Nachfrage».
const VORSCHLAEGE_MAX = 8;
function capVorschlaege(list) {
  return { vorschlaege: list.slice(0, VORSCHLAEGE_MAX), dropped: Math.max(0, list.length - VORSCHLAEGE_MAX) };
}

// Titelvarianten (Seiten-Chat, optional): reine Strings, getrimmt, ein
// umschliessendes Anführungszeichen-Paar entfernt, Dubletten (case-insensitiv)
// raus, höchstens TITEL_VARIANTEN_MAX. Überlange Einträge sind kein Titel.
const TITEL_VARIANTEN_MAX = 5;
const TITEL_MAX_CHARS = 200;
const _QUOTE_CHARS = '"\'«»„“”‚‘’‹›';
function _unquoteTitel(t) {
  if (t.length < 2 || !_QUOTE_CHARS.includes(t[0]) || !_QUOTE_CHARS.includes(t[t.length - 1])) return t;
  const inner = t.slice(1, -1);
  return [...inner].some(ch => _QUOTE_CHARS.includes(ch)) ? t : inner.trim();
}
function _sanitizeTitelVarianten(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const t = _unquoteTitel(raw.replace(/\s+/g, ' ').trim());
    if (!t || t.length > TITEL_MAX_CHARS) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= TITEL_VARIANTEN_MAX) break;
  }
  return out;
}

// Kaputtes JSON: sagt die Rohantwort, dass Vorschläge drinstanden, die das
// lenient-Parsing nicht retten konnte? Dann sieht der User das (Flag in
// `context_info.parse_fallback`), statt eine Antwort ohne die angekündigten
// Vorschläge vorzufinden.
function _lostVorschlaege(text) {
  return /"vorschlaege"\s*:\s*\[\s*\{/.test(String(text || ''));
}

// Ablehnung im klassischen (Ein-Call-)Pfad: wie der agentische Loop
// (agentic-chat/loop.js#refusalFinal) — gespeichert wird der Hinweis-Marker, ein
// teilweise gestreamter Text verfällt. Liefert den Marker oder null.
// `aiRes` = Ergebnis von callAI/callAIChat ({ stopReason, stopDetails }).
function classicRefusalAnswer(aiRes, log = logger) {
  if (aiRes?.stopReason !== 'refusal') return null;
  const cat = aiRes.stopDetails?.category || '-';
  log.warn(`Ablehnung durch Sicherheits-Klassifikator (Kategorie ${cat}) – Hinweis statt Antwort.`);
  return REFUSAL_MARKER;
}

// Leere Antwort nie als leere Assistant-Nachricht speichern (dieselbe Regel wie
// agentic-chat/history.js#_ensureNonEmptyFinal): der Marker sagt dem User, dass
// nichts kam, statt einer stummen Sprechblase.
function _nonEmptyAntwort(antwort) {
  return (typeof antwort === 'string' && antwort.trim()) ? antwort : EMPTY_ANSWER_MARKER;
}

function _parseChatResponse(text, aiRes = null, log = logger) {
  const refusal = classicRefusalAnswer(aiRes, log);
  if (refusal) {
    return { antwort: refusal, vorschlaege: [], titel_varianten: [], ideen: [], fallback: false, lostVorschlaege: false, refused: true };
  }
  // Leerer Text: gar nicht erst parsen (die Fallback-Kette schriebe einen
  // Parse-Dump für etwas, das nie JSON war).
  if (!String(text ?? '').trim()) {
    return { antwort: EMPTY_ANSWER_MARKER, vorschlaege: [], titel_varianten: [], ideen: [], fallback: false, lostVorschlaege: false };
  }
  const r = _parseChatResponseRaw(text);
  return { ...r, antwort: _nonEmptyAntwort(r.antwort) };
}

function _parseChatResponseRaw(text) {
  // Lenient: bei kaputtem JSON (z.B. unescaptes `"` oder typografische Quotes
  // im Modell-Output) wenigstens `antwort` per Regex retten. Vorschläge gehen
  // nur sicher zu extrahieren, wenn Gesamt-JSON valid ist.
  const r = parseJSONLenient(text, ['antwort']);
  if (r.ok && typeof r.parsed?.antwort === 'string' && r.parsed.antwort.trim()) {
    return {
      antwort: r.parsed.antwort,
      vorschlaege: _sanitizeVorschlaege(r.parsed.vorschlaege),
      titel_varianten: _sanitizeTitelVarianten(r.parsed.titel_varianten),
      // Roh — Anker-Prüfung + Normalisierung im Job (lib/chat-idee-proposals.js).
      ideen: Array.isArray(r.parsed.ideen) ? r.parsed.ideen : [],
      fallback: false,
      lostVorschlaege: false,
    };
  }
  // r.ok-aber-antwort-leer = Modell schrieb Prosa und trailing leeres `{}`,
  // das extractBalancedJson erwischt hat. Roh-Prosa speichern, fence weg.
  // `antwort` als Feld vorhanden, aber leer: das Modell hat geantwortet, nur ohne
  // Text — kein Prosa-Fall, sonst stünde das rohe `{"antwort":""}` im Chat. Die
  // Vorschläge bleiben, die Antwort wird zum Leer-Marker (_parseChatResponse).
  if (r.ok && r.parsed && typeof r.parsed === 'object' && 'antwort' in r.parsed) {
    return {
      antwort: '',
      vorschlaege: _sanitizeVorschlaege(r.parsed.vorschlaege),
      titel_varianten: _sanitizeTitelVarianten(r.parsed.titel_varianten),
      ideen: Array.isArray(r.parsed.ideen) ? r.parsed.ideen : [],
      fallback: false,
      lostVorschlaege: false,
    };
  }
  if (r.ok) {
    return { antwort: stripTrailingEmptyJson(text) || text, vorschlaege: [], titel_varianten: [], ideen: [], fallback: true, lostVorschlaege: _lostVorschlaege(text) };
  }
  return {
    antwort: r.partial.antwort ?? stripTrailingEmptyJson(r.partial._raw ?? text) ?? text,
    vorschlaege: [],
    titel_varianten: [],
    ideen: [],
    fallback: true,
    lostVorschlaege: _lostVorschlaege(text),
  };
}

// ── Buch-Chat-Seiten-Cache (klassischer Pfad) ────────────────────────────────
// Key `${bookId}:${userEmail}` → { pages, loadedAt }. TTL 10 Minuten, max. 20
// Einträge (FIFO-Eviction). Geteilt zwischen dem klassischen Buch-Chat-Job und
// der Cache-Invalidierung (DELETE /book-chat-cache + invalidateBookPageCache).
const bookPageCache = new Map();
const BOOK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const BOOK_PAGE_CACHE_MAX = 20;

/**
 * Verwirft alle Cache-Einträge eines Buchs (alle User). Läuft bei jeder Änderung
 * über die Content-Store-Facade (Listener unten) und nach Sync-Operationen, damit
 * der Buch-Chat nicht bis zu 10 Min lang auf veraltetem Content antwortet.
 * Cache-Key-Format: `${bookId}:${userEmail}` – Prefix-Match räumt alle User-
 * Varianten gleichzeitig ab (Permissions ändern sich selten und verlieren beim
 * Sync ohnehin ihre Aktualität).
 */
function invalidateBookPageCache(bookId) {
  const prefix = `${bookId}:`;
  for (const key of bookPageCache.keys()) {
    if (key.startsWith(prefix)) bookPageCache.delete(key);
  }
}

// Jeder Schreibweg der Content-Store-Facade (savePage/createPage/deletePage/
// movePage/splitPage, Kapitel-Änderungen) feuert 'change' auf dem Buch-Bus
// (lib/book-events.js) — darüber räumt der Cache sich selbst ab, statt dass die
// Facade Job-Code kennen müsste. movePage feuert für Quell- UND Zielbuch.
bookEvents.on('change', (bookId) => invalidateBookPageCache(bookId));

// ── Gemeinsamer Route-Handler ────────────────────────────────────────────────
// `kind` bindet den Job-Typ an die Session-Art: eine Session läuft nur unter
// dem Chat, für den sie angelegt wurde.
// `preflight(req, res, { session, userEmail })` (optional, darf async sein) läuft
// nach der ACL und VOR dem Speichern der User-Nachricht: liefert es false, ist die
// Antwort schon raus und es bleibt keine verwaiste Nachricht ohne Job in der
// Session liegen (Recherche-Chat: Kill-Switch + Claude-only,
// lib/research-chat-gate.js; Abschnitts-Chat: Abschnitt über dem Deckel).
// Nach dem await laufen Idempotenz- und Lauf-Sperre erneut: ein zweiter POST
// derselben Session kann in der Zwischenzeit durchgekommen sein. Ab der zweiten
// Prüfung bis zum Insert läuft alles synchron.
async function _handleChatPost(req, res, { jobType, kind, labelFn, runFn, preflight, contextFn }) {
  // Typprüfung vor `.trim()`: eine Zahl/ein Objekt als `message` wäre sonst ein
  // TypeError → 500 statt der 400, die der Client-Vertrag für fehlende Felder hat.
  const message = typeof req.body?.message === 'string' ? req.body.message : null;
  const session_id = toIntId(req.body?.session_id);
  const clientMsgId = typeof req.body?.client_msg_id === 'string' && req.body.client_msg_id.length <= 64
    ? req.body.client_msg_id
    : null;
  if (!session_id || !message?.trim()) return res.status(400).json({ error_code: 'SESSION_ID_MSG_REQUIRED' });
  const userEmail = sessionEmail(req);
  // Derselbe Code wie der Buch-Guard — nur früher, weil die Session unten
  // über die E-Mail geladen wird und ohne Login sonst als 404 erschiene.
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  // Idempotency: gleicher client_msg_id in selber Session → bestehende jobId zurück,
  // KEIN zweiter Insert. Schützt vor Doppel-Send bei Connection-Loss-Retry.
  // Läuft für diese Session schon ein Job (zweiter Tab, zweites Gerät), wird die neue
  // Nachricht NICHT gespeichert — ein 200 mit der fremden jobId liesse sie im Client
  // optimistisch stehen, obwohl sie nie beantwortet wird. 409 + jobId: der Client
  // nimmt die Nachricht zurück, behält den Text im Eingabefeld und kann den
  // laufenden Job verfolgen. (Wiederholung DERSELBEN Nachricht fängt die
  // client_msg_id-Idempotenz ab.) true = Antwort ist raus.
  const answeredByDedup = () => {
    if (clientMsgId) {
      const dup = db.prepare(
        `SELECT job_id FROM chat_messages WHERE session_id = ? AND client_msg_id = ?`
      ).get(session_id, clientMsgId);
      if (dup) { res.json({ jobId: dup.job_id || null, existing: true }); return true; }
    }
    const existing = findActiveJobId(jobType, session_id, userEmail);
    if (existing) { res.status(409).json({ error_code: 'CHAT_JOB_RUNNING', jobId: existing }); return true; }
    return false;
  };
  if (answeredByDedup()) return;

  const session = getSessionForJob(session_id, userEmail);
  if (!session || session.kind !== kind) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });

  // Seiten-Chat: die Seite muss (noch) im Buch der Session liegen. Die Session
  // trägt das Buch, gegen das unten geprüft wird — liegt die Seite woanders
  // (verschoben, oder eine Alt-Session mit Client-`book_id`), liefe der Job mit
  // der ACL des einen Buchs über den Text des anderen.
  if (kind === 'page' && resolvePageBookId(session.page_id) !== session.book_id) {
    return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });
  }

  // ACL-Guard. Page-Chat: lektor+. Buch-Chat: editor+, ausser
  // book_settings.allow_lektor_book_chat=1 setzt es auf lektor+.
  // Recherche-/Plot-/Ideen-Chat: editor+ (Recherche-Board, Plot-Werkstatt und
  // Ideen-Board sind editor-scoped).
  let minRole = 'lektor';
  if (jobType === 'book-chat') {
    minRole = getBookSettings(session.book_id)?.allow_lektor_book_chat ? 'lektor' : 'editor';
  } else if (jobType === 'research-chat' || jobType === 'plot-chat' || jobType === 'ideen-chat') {
    minRole = 'editor';
  }
  if (!guardBook(req, res, session.book_id, minRole)) return;
  if (preflight) {
    if (!(await preflight(req, res, { session, userEmail }))) return;
    if (answeredByDedup()) return;
  }
  // Optionaler Kontext der Frage (Recherche-Chat: Seite/Kapitel des Kontext-Chips).
  // `contextFn` prueft ihn gegen das Buch der Session und liefert das, was an der
  // User-Nachricht als context_info steht — der Job liest es von dort, statt die
  // Job-Signatur aller Chats zu erweitern. Ungueltiges faellt still weg.
  const msgContext = contextFn ? contextFn(req, session) : null;

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at, client_msg_id, context_info) VALUES (?, 'user', ?, ?, ?, ?)`
  ).run(session.id, message.trim(), now, clientMsgId, msgContext ? JSON.stringify(msgContext) : null);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);
  // Messung: dieselbe Frage desselben Users binnen 24 h (gleiches Buch, gleiche
  // Chat-Art) → `context_info.repeat_of` an der neuen User-Nachricht
  // (db/chat-quality.js). Darf das Senden nie aufhalten.
  try {
    recordRepeat({
      messageId: userMsgResult.lastInsertRowid, userEmail, bookId: session.book_id,
      kind: session.kind, content: message,
    });
  } catch (e) {
    logger.warn(`[chat] Wiederholungs-Pruefung fehlgeschlagen: ${e.message}`);
  }

  const { key: label, params: labelParams } = labelFn(session);
  const jobId = createJob(jobType, session.book_id || 0, userEmail, label, labelParams, session_id);
  db.prepare('UPDATE chat_messages SET job_id = ? WHERE id = ?').run(jobId, userMsgResult.lastInsertRowid);
  enqueueJob(jobId, () => runFn(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail));
  res.json({ jobId });
}

// Zeichenbudget des Figuren-Blocks im Chat-System-Prompt. `getFiguren`
// (routes/jobs/shared/queries.js) liefert Volldossiers — Szenen, Schauplätze,
// Beziehungen und Lebensereignisse je Figur. Bei einem ausanalysierten Buch sind das
// mehrere Hunderttausend Zeichen, ein Mehrfaches jedes Kontextfensters: ungekappt
// scheitert der Call am Preflight (lib/ai/shared.js#assertPromptFitsContext), bevor
// eine Zeile Buchtext oder ein Werkzeug-Ergebnis im Prompt steht.
// Ein Viertel des Input-Budgets: der Block ist Stufe 1 der Kosten-Leiter und darf
// spürbar kosten, aber nie den Platz für Buchtext (klassisch) bzw. Werkzeug-Ergebnisse
// (agentisch) auffressen. Kappung + Offenlegung macht
// public/js/prompts/chat.js#buildFigurenBlock — geteilt von allen drei Chat-Prompts.
function figurenBlockChars(aiCfg) {
  return Math.max(6000, Math.floor((aiCfg?.inputBudgetChars || 0) * 0.25));
}

// Welt-Fakten-Block: dieselbe Logik, aber ein Zehntel des Budgets — die Fakten sind
// kurze Einzeiler, und der Block soll den Figuren-Block nicht verdraengen. Kein
// eigenes App-Setting: der Wert leitet sich wie der Figuren-Deckel aus dem
// Kontextfenster des effektiven Providers ab. Kappung + Offenlegung macht
// public/js/prompts/chat.js#buildWeltfaktenBlock.
function weltfaktenBlockChars(aiCfg) {
  return Math.max(2000, Math.floor((aiCfg?.inputBudgetChars || 0) * 0.10));
}

module.exports = {
  _sanitizeVorschlaege, capVorschlaege, VORSCHLAEGE_MAX, _sanitizeTitelVarianten, _parseChatResponse, classicRefusalAnswer, _handleChatPost, figurenBlockChars, weltfaktenBlockChars,
  bookPageCache, BOOK_PAGE_CACHE_TTL_MS, BOOK_PAGE_CACHE_MAX, invalidateBookPageCache,
};
