const express = require('express');
const { db } = require('../db/schema');
const logger = require('../logger');
const { toIntId } = require('../lib/validate');
const contentStore = require('../lib/content-store');
const { aclParamGuard, guardBook, sessionEmail } = require('../lib/acl');
const { pageBookGuard } = require('../lib/page-guard');
const chatSessions = require('../db/chat-sessions');
const chatQuality = require('../db/chat-quality');
const { htmlToText } = require('./jobs/shared');
const { setContext } = require('../lib/log-context');
const { resolvePageBookId } = require('../lib/content-ownership');
const { searchChatHistory } = require('../lib/chat-search');
const { enqueueChatEmbedIndexJob } = require('./jobs/chat-embed-index');

const router = express.Router();
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Normalisiert context_info aus der DB – ältere Einträge speicherten pages als
 * String-Array, neue als Objekt-Array { name, id, slug, book_slug }.
 */
function normalizeContextInfo(ci) {
  if (!ci || !Array.isArray(ci.pages)) return ci;
  ci.pages = ci.pages.map(p => (typeof p === 'string' ? { name: p } : p));
  return ci;
}

// ── Routen ───────────────────────────────────────────────────────────────────

/** Neue Seiten-Chat-Session erstellen.
 *  Das Buch kommt aus der SEITE, nie aus dem Body (lib/page-guard.js): mit einem
 *  eigenen `book_id` und einer fremden `page_id` läse der Snapshot unten sonst
 *  fremden Seitentext in die eigene Session. */
router.post('/session', jsonBody, async (req, res) => {
  const g = pageBookGuard(req, res, { minRole: 'lektor', pageId: req.body?.page_id ?? 0 });
  if (!g) return;
  const { pageId: page_id, bookId: book_id } = g;
  const userEmail = sessionEmail(req);

  // Snapshot: Seitentext beim Chat-Öffnen einmalig sichern. Ermöglicht später
  // im System-Prompt einen Vergleich „Stand beim Öffnen" vs. „aktueller Stand",
  // damit die KI Änderungen während laufendem Chat erkennt.
  let openingPageText = null;
  try {
    const pd = await contentStore.loadPage(page_id, req);
    openingPageText = htmlToText(pd.html || '');
  } catch (e) {
    const status = e?.status ? ` status=${e.status}` : '';
    logger.warn(`[chat/session] Snapshot-Load fehlgeschlagen page=${page_id}${status}: ${e.message}`);
  }

  // Orphan-Cleanup: vorher angelegte leere Sessions desselben Users für dieselbe
  // Seite löschen, bevor wir eine neue erstellen. So sammeln sich keine Karteileichen
  // an, wenn der User Chat-Karte mehrmals öffnet/schliesst, ohne zu schreiben.
  // Schonfrist + Begründung: db/chat-sessions.js#ORPHAN_GRACE_MS.
  const removed = chatSessions.deleteEmptyPageSessions(page_id, userEmail);
  if (removed > 0) {
    logger.info(`[chat/session] Orphan-Cleanup: ${removed} leere page-Session(s) für page=${page_id} entfernt.`);
  }

  const id = chatSessions.insertPageSession({ bookId: book_id, pageId: page_id, userEmail, openingPageText });
  res.json({ id });
});

// Buch-weite Chat-Session anlegen (Buch-, Recherche- und Plot-Chat). Alle
// unterscheiden sich nur in `kind` und der ACL-Mindestrolle; Orphan-Cleanup
// (leere, nie benutzte Sessions desselben kind älter als 60 s verwerfen) und
// Insert sind geteilt. `minRole(book_id)` löst die Rolle ggf. buch-abhängig auf.
function createBookScopedSession(req, res, { kind, minRole }) {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, book_id, minRole(book_id))) return;
  const userEmail = sessionEmail(req);

  const removed = chatSessions.deleteEmptyBookSessions(book_id, kind, userEmail);
  if (removed > 0) logger.info(`[chat/session/${kind}] Orphan-Cleanup: ${removed} leere Session(s) für book=${book_id} entfernt.`);

  const id = chatSessions.insertBookSession({ bookId: book_id, kind, userEmail });
  res.json({ id });
}

// Kappung des Listen-`preview` (erste User-Nachricht). Die Session-Liste zeigt
// davon nur 80 Zeichen (partials/chat.html); der Rest reist ungenutzt mit und
// waere bei vielen Sessions der eigentliche Antwort-Umfang.
const PREVIEW_CHARS = 200;

// Buch-weite Chat-Sessions auflisten (neueste zuerst, vollstaendig). Leere Sessions
// (ohne Nachrichten) werden ausgefiltert — sie entstehen beim Öffnen der Karte
// (auto-`startNewSession`) und sollen erst auftauchen, wenn der User schreibt.
// Kein Zeilen-Deckel: ein gekappter Verlauf laesst aeltere Sessions unerreichbar
// in der DB liegen — es gibt keinen zweiten Weg zu ihnen ausser der Session-ID.
// Stattdessen ist der `preview` serverseitig gekappt (die Liste zeigt ohnehin nur
// 80 Zeichen), damit die Antwort nicht mit der Zahl der Sessions mitwaechst.
// Login + Buch-ID hat `aclParamGuard` geprüft, `req.bookId` ist gesetzt.
function listBookScopedSessions(req, res, { kind }) {
  res.json(chatSessions.listBookSessions(req.bookId, kind, sessionEmail(req), PREVIEW_CHARS));
}

/** Neue Buch-Chat-Session erstellen (ohne Seiten-Bezug).
 *  Buch-Chat: editor+, ausser allow_lektor_book_chat=1 → lektor+. */
router.post('/session/book', jsonBody, (req, res) => createBookScopedSession(req, res, {
  kind: 'book',
  minRole: (book_id) => {
    const { getBookSettings } = require('../db/schema');
    return getBookSettings(book_id)?.allow_lektor_book_chat ? 'lektor' : 'editor';
  },
}));

router.get('/sessions/book/:book_id', (req, res) => listBookScopedSessions(req, res, { kind: 'book' }));

/** Neue Recherche-Chat-Session erstellen (kind='research', buchweit, editor+).
 *  Claude-only — das Frontend öffnet sie nur, wenn der Provider Claude ist. */
router.post('/session/research', jsonBody, (req, res) => createBookScopedSession(req, res, {
  kind: 'research',
  minRole: () => 'editor',
}));

router.get('/sessions/research/:book_id', (req, res) => listBookScopedSessions(req, res, { kind: 'research' }));

/** Neue Plot-Chat-Session erstellen (kind='plot', buchweit, editor+ wie die Plot-Werkstatt). */
router.post('/session/plot', jsonBody, (req, res) => createBookScopedSession(req, res, {
  kind: 'plot',
  minRole: () => 'editor',
}));

router.get('/sessions/plot/:book_id', (req, res) => listBookScopedSessions(req, res, { kind: 'plot' }));

/** Neue Ideen-Chat-Session erstellen (kind='ideen', buchweit, editor+ wie das Ideen-Board). */
router.post('/session/ideen', jsonBody, (req, res) => createBookScopedSession(req, res, {
  kind: 'ideen',
  minRole: () => 'editor',
}));

router.get('/sessions/ideen/:book_id', (req, res) => listBookScopedSessions(req, res, { kind: 'ideen' }));

/** Suche im eigenen Verlauf (docs/chats.md#suche-im-verlauf): Wortlaut + Bedeutung
 *  über die Abschnitts- (`kind=page`, optional `page_id`) bzw. Buch-Chats
 *  (`kind=book`) des Users in diesem Buch. Sind Runden noch nicht vektorisiert,
 *  stösst die Suche den Index-Lauf an (`indexing`) — bis dahin findet sie sie
 *  über den Wortlaut. */
router.get('/search/:book_id', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 300);
  const kind = req.query.kind === 'page' ? 'page' : req.query.kind === 'book' ? 'book' : null;
  if (!q || !kind) return res.status(400).json({ error_code: 'INVALID_QUERY' });
  const pageId = kind === 'page' && req.query.page_id ? toIntId(req.query.page_id) : null;
  const result = await searchChatHistory({
    bookId: req.bookId, userEmail: sessionEmail(req), query: q, kinds: [kind], pageId,
  });
  const indexing = result.pending > 0 && !!enqueueChatEmbedIndexJob(req.bookId);
  res.json({ ...result, indexing });
});

/** Alle Sessions einer Seite (neueste zuerst, vollständig — gleiche Begründung
 *  wie bei den Buch-Sessions oben: ein Zeilen-Deckel liesse ältere Gespräche
 *  unerreichbar in der DB liegen). Leere Sessions werden ausgefiltert, der
 *  `preview` ist serverseitig gekappt. */
router.get('/sessions/:page_id', (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = resolvePageBookId(pageId);
  if (bookId) setContext({ book: bookId });
  res.json(chatSessions.listPageSessions(pageId, sessionEmail(req), PREVIEW_CHARS));
});

/** Session mit allen Nachrichten laden. Der Öffnungs-Snapshot
 *  (`opening_page_text`) bleibt serverseitig — Prompt-Material des Jobs. */
router.get('/session/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const session = chatSessions.getOwnedSession(id, userEmail);
  if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });
  if (session.book_id) setContext({ book: session.book_id });

  const messages = db.prepare(`
    SELECT id, role, content, vorschlaege, tokens_in, tokens_out,
           cache_read_in, cache_creation_in, tps, context_info, feedback, created_at
    FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id);

  res.json({
    ...session,
    messages: messages.map(m => ({
      ...m,
      vorschlaege:  m.vorschlaege  ? JSON.parse(m.vorschlaege)  : [],
      context_info: m.context_info ? normalizeContextInfo(JSON.parse(m.context_info)) : null,
    })),
  });
});


/** Im Buch-Chat generiertes Bild streamen (Owner-Scope via Session-Join).
 *  ?download=1 erzwingt den Attachment-Disposition (Speichern-Dialog). */
router.get('/image/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const { getChatImage } = require('../db/chat-images');
  const row = getChatImage(id);
  if (!row) return res.status(404).json({ error_code: 'IMAGE_NOT_FOUND' });
  if (row.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  // Defense-in-depth gegen Stored XSS: row.mime stammt letztlich aus dem
  // (untrusted) Upstream-Image-Endpunkt. Nur Raster-MIMEs inline ausliefern;
  // alles andere als Download mit neutralem Typ. nosniff + restriktive CSP
  // verhindern, dass der Browser den Body als HTML/Script interpretiert.
  const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const safe = SAFE_IMAGE_MIME.has(row.mime);
  const ext = (safe && row.mime.split('/')[1]) || 'png';
  res.setHeader('Content-Type', safe ? row.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download || !safe) {
    res.setHeader('Content-Disposition', `attachment; filename="bild-${id}.${ext}"`);
  }
  res.setHeader('Content-Length', row.image.length);
  res.end(row.image);
});

/** Session löschen */
router.delete('/session/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const owned = chatSessions.getOwnedSession(id, userEmail);
  if (owned?.book_id) setContext({ book: owned.book_id });
  db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_email = ?')
    .run(id, userEmail);
  res.json({ ok: true });
});

// Gemeinsamer Vorspann der Vorschlags-PATCH-Routen: Nachricht des Users laden,
// Index prüfen, Buch in den Log-Context. Antwortet selbst und liefert dann null.
function loadVorschlagForPatch(req, res) {
  const userEmail = sessionEmail(req);
  const msgId = toIntId(req.params.id);
  // idx kann 0 sein → toIntId reicht nicht (lehnt 0 ab). Eigene Prüfung auf nicht-negativen Integer.
  const idx = /^(0|[1-9][0-9]*)$/.test(String(req.params.idx ?? '')) ? Number(req.params.idx) : null;
  if (!msgId || idx == null) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }

  const row = db.prepare(`
    SELECT cm.vorschlaege, cs.book_id FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.id = ? AND cs.user_email = ?
  `).get(msgId, userEmail);
  if (!row) { res.status(404).json({ error_code: 'MESSAGE_NOT_FOUND' }); return null; }
  if (row.book_id) setContext({ book: row.book_id });

  const vorschlaege = row.vorschlaege ? JSON.parse(row.vorschlaege) : [];
  if (!vorschlaege[idx]) { res.status(400).json({ error_code: 'VORSCHLAG_INDEX_INVALID' }); return null; }
  return { msgId, idx, vorschlaege };
}

function saveVorschlaege(msgId, vorschlaege) {
  db.prepare('UPDATE chat_messages SET vorschlaege = ? WHERE id = ?').run(JSON.stringify(vorschlaege), msgId);
}

/** Einzelnen Vorschlag einer Assistant-Nachricht als übernommen markieren (oder
 *  zurücksetzen — „Rückgängig"). Übernehmen hebt ein „verworfen" auf. */
router.patch('/message/:id/vorschlag/:idx/applied', jsonBody, (req, res) => {
  const ctx = loadVorschlagForPatch(req, res);
  if (!ctx) return;
  const { msgId, idx, vorschlaege } = ctx;
  const applied = req.body?.applied !== false;
  if (applied) {
    vorschlaege[idx].applied = true;
    vorschlaege[idx].applied_at = new Date().toISOString();
    delete vorschlaege[idx].status;
  } else {
    delete vorschlaege[idx].applied;
    delete vorschlaege[idx].applied_at;
  }
  saveVorschlaege(msgId, vorschlaege);
  res.json({ ok: true });
});

/** Vorschlag verwerfen bzw. wieder öffnen. Persistiert als `status` im
 *  vorschlaege-JSON (keine eigene Spalte); `applied` bleibt die Wahrheit fürs
 *  Übernommen-Sein — ein übernommener Vorschlag lässt sich nicht verwerfen. */
router.patch('/message/:id/vorschlag/:idx/status', jsonBody, (req, res) => {
  const status = req.body?.status ?? null;
  if (status !== null && status !== 'discarded') return res.status(400).json({ error_code: 'VORSCHLAG_STATUS_INVALID' });
  const ctx = loadVorschlagForPatch(req, res);
  if (!ctx) return;
  const { msgId, idx, vorschlaege } = ctx;
  if (status === 'discarded' && vorschlaege[idx].applied) return res.status(409).json({ error_code: 'VORSCHLAG_ALREADY_APPLIED' });
  if (status) vorschlaege[idx].status = status;
  else delete vorschlaege[idx].status;
  saveVorschlaege(msgId, vorschlaege);
  res.json({ ok: true });
});

/** Feedback (Daumen hoch/runter) zu einer Assistant-Antwort setzen bzw.
 *  zuruecknehmen — alle Chats (Seiten-, Buch-, Recherche-Chat). Body
 *  `{ feedback: 1 | -1 | null }`. Nur der Besitzer der Session: eine fremde
 *  Nachricht ist wie bei den Vorschlags-Routen nicht auffindbar (404), und das
 *  Buch muss er weiterhin lesen duerfen. Auswertung: db/chat-quality.js. */
router.patch('/message/:id/feedback', jsonBody, (req, res) => {
  const msgId = toIntId(req.params.id);
  if (!msgId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const raw = req.body?.feedback;
  if (!(raw === null || raw === 1 || raw === -1)) return res.status(400).json({ error_code: 'FEEDBACK_INVALID' });
  const msg = chatQuality.getOwnedMessage(msgId, sessionEmail(req));
  if (!msg) return res.status(404).json({ error_code: 'MESSAGE_NOT_FOUND' });
  setContext({ book: msg.book_id });
  if (!guardBook(req, res, msg.book_id, 'viewer')) return;
  if (msg.role !== 'assistant') return res.status(400).json({ error_code: 'FEEDBACK_NOT_ASSISTANT' });
  chatQuality.setFeedback(msgId, raw);
  res.json({ ok: true, feedback: raw });
});

module.exports = router;
