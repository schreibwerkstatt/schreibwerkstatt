'use strict';
// Ideen pro Seite ODER pro Kapitel — User-isolierte Notizen fuer moegliche
// Fortsetzungen, Szenen, inhaltliche Anker; in der Praxis genauso oft Pendenzen
// („hier fehlt noch …"). Offene werden im Seiten-Chat als Kontext eingespielt
// (nur offene; Seite + umliegendes Kapitel).
//
// Scope-Modell: eine Idee haengt an hoechstens EINEM Anker — einer Seite, einem
// Kapitel oder (beide NULL) nur am Buch (CHECK im Schema). Eine Buch-Idee ist ein
// Einfall ohne Ort im Text; der Autor ordnet sie spaeter selbst einer Seite oder
// einem Kapitel zu. Danach darf sie frei umziehen — Seite ↔ Seite, Kapitel ↔
// Kapitel und quer zwischen Seite und Kapitel; der alte Anker wird dabei geleert.
// Ein Kapitel mit genau einem Abschnitt ist derselbe Ort wie dieser Abschnitt:
// ein Kapitel-Anker wird dort beim Anlegen und Umziehen zum Abschnitt
// (lib/idee-anchor.js).
//
// Stufen-Modell: `status` (offen → in_arbeit → erledigt, daneben verworfen) ist
// die einzige Wahrheit ueber den Bearbeitungsstand; SSoT der Stufen ist
// lib/ideen-status.js. Alles SQL liegt in db/ideen.js — hier stehen nur noch
// Validierung, ACL und die Antwortform.

const express = require('express');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { resolvePageBookId, resolveChapterBookId } = require('../lib/content-ownership');
const { canonicalIdeeAnchor } = require('../lib/idee-anchor');
const { IDEE_STATUSES, IDEE_OPEN_STATUSES, isIdeeStatus, isIdeaLinkKind } = require('../lib/ideen-status');
const { getBookIdeenStages, setBookIdeenStages } = require('../db/book-settings');
const { setContext } = require('../lib/log-context');
const ideenDb = require('../db/ideen');
const searchIndex = require('../lib/search');
const { replayIdempotent, rememberIdempotent } = require('../lib/idempotency');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Ideen-Vorschläge aus Chats: Status (PATCH /ideen/chat-proposal) und Beleg-Prüfung
// vor dem Übernehmen (POST /ideen/chat-proposal/beleg-check) — routes/ideen-chat-proposals.js.
// Vor `/:id` registriert, sonst griffe PATCH /:id mit id='chat-proposal'.
router.use('/', require('./ideen-chat-proposals').ideenChatProposalsRouter);

const MAX_LEN = 4000;

// Vorspann fuer die Routen auf einer bestehenden Idee: Login, Besitz und
// Buch-ACL in einem Zug. Liefert die Besitz-Zeile oder null (Antwort ist raus).
// Der Login-Check steht hier VOR dem Guard, weil die Besitz-Zeile ueber die
// E-Mail geladen wird — ohne ihn erschiene „nicht angemeldet" als 404. Er
// antwortet mit demselben Code wie der Guard.
function _ownedIdee(req, res) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'NOT_LOGGED_IN' }); return null; }
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const row = ideenDb.getIdeeOwned(id, userEmail);
  if (!row) { res.status(404).json({ error_code: 'IDEE_NOT_FOUND' }); return null; }
  setContext({ book: row.book_id });
  if (!guardBook(req, res, row.book_id, 'editor')) return null;
  return { ...row, userEmail };
}

// Map page_id ODER chapter_id → Anzahl OFFENER Ideen fuer ein Buch.
// `kind=page` (Default) zaehlt Seiten-Ideen; `kind=chapter` zaehlt Kapitel-Ideen.
router.get('/counts', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  const kind = req.query.kind === 'chapter' ? 'chapter' : 'page';
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  res.json(ideenDb.openIdeenCounts(bookId, userEmail, kind));
});

// Alle Ideen eines Buches — die Datenquelle des Ideen-Boards.
//
// Bewusst OHNE Status-/Kapitel-Filter in der Abfrage: Board-Spalten, Bahnen und
// Filterleiste rendern dieselbe Liste desselben Requests (gleiche Regel wie die
// zwei Ansichten des Recherche-Boards). Ein serverseitiger Filter machte aus der
// ausgeblendeten `verworfen`-Spalte eine nicht geladene — und die Zahl neben dem
// Filter, die sagt wie viel gerade versteckt ist, waere nicht mehr zu bilden.
router.get('/board', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  res.json({
    statuses: IDEE_STATUSES,
    stages: getBookIdeenStages(bookId),
    ideen: ideenDb.listBoardIdeen(bookId, userEmail),
  });
});

// Aktive Stufen des Buches (book_settings.ideen_stages) — fuer die Ideen-Karte,
// die ohne Board-Request auskommen muss. Buchweit, nicht user-privat: die
// Stufen sind eine Eigenschaft des Buches, die Ideen darauf gehoeren dem User.
router.get('/stages', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  res.json({ stages: getBookIdeenStages(bookId) });
});

// Stufen umschalten. `offen` und `erledigt` kommen immer dazu, Unbekanntes
// faellt weg (lib/ideen-status.js#normalizeIdeeStages); die Antwort traegt den
// gespeicherten Stand. Ideen in einer abgeschalteten Stufe behalten ihren
// Status — abgeschaltet heisst nur „nicht mehr anbieten".
router.put('/stages', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!Array.isArray(req.body?.stages)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const stages = setBookIdeenStages(bookId, req.body.stages);
  logger.info(`[ideen] stufen book=${bookId} aktiv=${stages.join(',')}`);
  res.json({ stages });
});

// Manuelle Reihenfolge einer Board-Zelle (Bahn × Stufe) speichern: `ids` in
// Anzeige-Reihenfolge. Nur eigene Ideen dieses Buchs — eine fremde ID kippt den
// ganzen Request (ORDER_MISMATCH), statt eine halbe Reihenfolge zu schreiben.
router.put('/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(toIntId) : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!ids || !ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error_code: 'ORDER_REQ' });
  }
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  if (!ideenDb.reorderIdeen(bookId, userEmail, ids)) return res.status(400).json({ error_code: 'ORDER_MISMATCH' });
  res.json({ ok: true });
});

// Verknuepfbare Ziele fuer den Link-Picker (Recherche / Beat / Motiv).
router.get('/link-targets', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  res.json(ideenDb.listIdeaLinkTargets(bookId, userEmail));
});

// Rueckwaerts-Lesung fuer die Gegenseiten: Map Ziel-ID → Ideen-Anrisse.
//
// EIN Endpunkt fuer alle drei Kataloge statt drei erweiterter Payloads. Damit
// bleiben `/research`, `/plot` und `/motifs` unveraendert — und vor allem bleibt
// die Skopierung an EINER Stelle richtig: Ideen sind user-privat, Recherche-
// Fundstuecke dagegen buchweit geteilt. Haengte man die Anrisse an die
// Fundstueck-Zeile, muesste jeder ihrer Schreibpfade (capture, media, scrape,
// interview, patch …) die E-Mail des Betrachters mitfuehren, und der erste, der
// es vergisst, zeigt dem Mitarbeiter die privaten Pendenzen des Autors.
router.get('/links', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  const targetKind = req.query.target_kind;
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!isIdeaLinkKind(targetKind)) return res.status(400).json({ error_code: 'INVALID_LINK_KIND' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const map = ideenDb.ideaLinksByTarget(targetKind, bookId, userEmail);
  res.json({ target_kind: targetKind, links: Object.fromEntries(map) });
});

// Liste aller Ideen einer Seite ODER eines Kapitels (offen oben, dann der Rest;
// je Block neueste zuerst). Genau ein Scope-Parameter ist erforderlich.
router.get('/', (req, res) => {
  const userEmail = sessionEmail(req);
  const pageId = toIntId(req.query.page_id);
  const chapterId = toIntId(req.query.chapter_id);
  if ((!pageId && !chapterId) || (pageId && chapterId)) {
    return res.status(400).json({ error_code: 'INVALID_SCOPE' });
  }

  const kind = pageId ? 'page' : 'chapter';
  const scopeId = pageId || chapterId;
  const bookId = pageId ? resolvePageBookId(pageId) : resolveChapterBookId(chapterId);
  if (!bookId) {
    return res.status(404).json({ error_code: pageId ? 'PAGE_NOT_FOUND' : 'CHAPTER_NOT_FOUND' });
  }
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  res.json(ideenDb.listIdeenForScope(kind, scopeId, userEmail));
});

// Idee anlegen: page_id ODER chapter_id ODER keins von beiden (Buch-Idee).
router.post('/', jsonBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.body?.book_id);
  let pageId = toIntId(req.body?.page_id);
  let chapterId = toIntId(req.body?.chapter_id);
  const content = (req.body?.content || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (pageId && chapterId) return res.status(400).json({ error_code: 'INVALID_SCOPE' });
  if (!content)                 return res.status(400).json({ error_code: 'CONTENT_REQ' });
  if (content.length > MAX_LEN) return res.status(400).json({ error_code: 'CONTENT_TOO_LONG' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;

  // Cross-Check: page/chapter muss zum Buch gehoeren.
  if (pageId || chapterId) {
    const ankerBook = pageId ? resolvePageBookId(pageId) : resolveChapterBookId(chapterId);
    if (ankerBook !== bookId) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
  }
  if (chapterId) {
    const c = canonicalIdeeAnchor({ kind: 'chapter', id: chapterId });
    if (c.kind === 'page') { pageId = c.id; chapterId = null; }
  }

  // Nachgespielt aus der Offline-Warteschlange (lib/idempotency.js): derselbe
  // Schlüssel legt nicht doppelt an.
  if (await replayIdempotent(req, res, 'POST /ideen', userEmail)) return;
  const id = ideenDb.createIdee({ bookId, pageId, chapterId, userEmail, content });
  const row = ideenDb.getIdee(id);
  searchIndex.upsertIdea(id);
  logger.info(`[ideen] create id=${id} ${pageId ? 'page=' + pageId : chapterId ? 'chapter=' + chapterId : 'book=' + bookId}`);
  rememberIdempotent(req, 'POST /ideen', userEmail, row);
  res.json(row);
});

// Content + Status + Move aktualisieren (Felder optional einzeln).
// Move: `page_id` ODER `chapter_id` setzt den neuen Anker und leert den anderen —
// eine Kapitel-Idee darf so in einen Abschnitt ziehen und umgekehrt. Beide Felder
// zugleich und beide `null` loesen den Anker: die Idee wird wieder Buch-Idee.
router.patch('/:id', jsonBody, (req, res) => {
  const existing = _ownedIdee(req, res);
  if (!existing) return;
  const { userEmail } = existing;
  const id = existing.id;

  const fields = {};
  if (typeof req.body?.content === 'string') {
    const c = req.body.content.trim();
    if (!c) return res.status(400).json({ error_code: 'CONTENT_REQ' });
    if (c.length > MAX_LEN) return res.status(400).json({ error_code: 'CONTENT_TOO_LONG' });
    fields.content = c;
  }
  if (typeof req.body?.status !== 'undefined') {
    if (!isIdeeStatus(req.body.status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
    // In eine abgeschaltete Stufe wird nicht gewechselt. Wer schon dort steht,
    // darf bleiben (No-op) und herauswechseln — sonst saesse die Idee fest.
    if (req.body.status !== existing.status && !getBookIdeenStages(existing.book_id).includes(req.body.status)) {
      return res.status(400).json({ error_code: 'IDEE_STATUS_INACTIVE' });
    }
    fields.status = req.body.status;
  }

  let movedFrom = null, movedTo = null;
  const hasPageMove    = typeof req.body?.page_id    !== 'undefined';
  const hasChapterMove = typeof req.body?.chapter_id !== 'undefined';
  const toBook = hasPageMove && hasChapterMove && req.body.page_id === null && req.body.chapter_id === null;
  if (hasPageMove && hasChapterMove && !toBook) return res.status(400).json({ error_code: 'INVALID_SCOPE' });
  if (hasPageMove || hasChapterMove) {
    let isPage = hasPageMove && !toBook;
    let newId = toBook ? null : toIntId(isPage ? req.body.page_id : req.body.chapter_id);
    if (!toBook && !newId) return res.status(400).json({ error_code: isPage ? 'INVALID_PAGE_ID' : 'INVALID_CHAPTER_ID' });
    // Eine abgeschlossene Idee (erledigt/verworfen) wandert nicht mehr: sie ist
    // die Spur einer Entscheidung an DIESER Stelle, und anderswo hingehaengt
    // wuerde sie zur Aussage ueber eine Stelle, an der sie nie stand.
    // Gilt auch fuer die Stufe, die derselbe Request setzt: zuordnen und
    // zugleich abschliessen hiesse, die Idee haette an ihrem Anker nie offen
    // gestanden.
    const finalStatus = fields.status ?? existing.status;
    if (!IDEE_OPEN_STATUSES.includes(existing.status) || !IDEE_OPEN_STATUSES.includes(finalStatus)) {
      return res.status(400).json({ error_code: 'IDEE_CLOSED' });
    }
    if (!toBook) {
      const targetBook = isPage ? resolvePageBookId(newId) : resolveChapterBookId(newId);
      if (targetBook !== existing.book_id) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
      if (!isPage) {
        const c = canonicalIdeeAnchor({ kind: 'chapter', id: newId });
        if (c.kind === 'page') { isPage = true; newId = c.id; }
      }
    }
    movedFrom = existing.page_id !== null ? 'page=' + existing.page_id
      : existing.chapter_id !== null ? 'chapter=' + existing.chapter_id : 'book';
    movedTo = toBook ? 'book' : `${isPage ? 'page' : 'chapter'}=${newId}`;
    fields.page_id = isPage ? newId : null;
    fields.chapter_id = isPage || toBook ? null : newId;
  }

  if (!ideenDb.updateIdee(id, userEmail, fields)) {
    return res.status(400).json({ error_code: 'NO_FIELDS' });
  }
  const row = ideenDb.getIdee(id);
  searchIndex.upsertIdea(id);
  if (movedTo) logger.info(`[ideen] move id=${id} from=${movedFrom} to=${movedTo}`);
  res.json(row);
});

// ── Verknuepfungen (Recherche-Fundstueck / Plot-Beat / Motiv) ───────────────
// Beidseitig: die Gegenseiten lesen dieselbe Bruecke zurueck (db/ideen.js#
// attachIdeasTo), gesetzt und geloest wird sie ausschliesslich hier.

router.post('/:id/links', jsonBody, (req, res) => {
  const existing = _ownedIdee(req, res);
  if (!existing) return;
  const targetKind = req.body?.target_kind;
  const targetId = toIntId(req.body?.target_id);
  if (!isIdeaLinkKind(targetKind)) return res.status(400).json({ error_code: 'INVALID_LINK_KIND' });
  if (!targetId)                   return res.status(400).json({ error_code: 'INVALID_TARGET_ID' });

  const result = ideenDb.addIdeaLink(existing.id, existing.book_id, targetKind, targetId, existing.userEmail);
  if (result.error_code) return res.status(400).json(result);
  res.json(ideenDb.getIdee(existing.id));
});

router.delete('/:id/links/:linkId', (req, res) => {
  const existing = _ownedIdee(req, res);
  if (!existing) return;
  const linkId = toIntId(req.params.linkId);
  if (!linkId) return res.status(400).json({ error_code: 'INVALID_ID' });
  ideenDb.removeIdeaLink(existing.id, linkId);
  res.json(ideenDb.getIdee(existing.id));
});

// Idee loeschen.
router.delete('/:id', (req, res) => {
  const existing = _ownedIdee(req, res);
  if (!existing) return;
  ideenDb.deleteIdee(existing.id, existing.userEmail);
  searchIndex.remove('idea', existing.id);
  res.json({ ok: true });
});

module.exports = router;
