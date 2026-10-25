'use strict';
// Share-Link Owner-API (GET/POST/PATCH/DELETE /share/api/...): Link-Verwaltung,
// Pro-Seite-Zähler (Kommentare + Links), Buch-Kommentar-Threads, Owner-Reply/
// Resolve/Delete. Prüft Session selbst (requireSession), da der Router VOR dem
// globalen Auth-Guard gemountet ist.

const contentStore = require('../../lib/content-store');
const shareLinks = require('../../db/share-links');
const { guardBook, resolveBookRole, sessionEmail } = require('../../lib/acl');
const { setContext } = require('../../lib/log-context');
const notify = require('../../lib/notify');
const logger = require('../../logger');
const H = require('../../lib/share-helpers');

const { jsonBody, INTRO_MAX, ANCHOR_BID_RE, resolveBidsToPages, backfillScopeBlockIds } = H;
const { chapterScopeIds } = require('../../lib/load-contents');

// ── Auth-Mw ──────────────────────────────────────────────────────────────────
function requireSession(req, res, next) {
  if (!sessionEmail(req)) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  next();
}

// Eigenen Link (Ersteller = Session) laden und den Buchzugriff des Erstellers
// pruefen. Antwortet selbst (404 bzw. 401/403 via guardBook) und liefert dann
// null. Ohne den Buch-Guard behielte ein Ersteller, dem der Buchzugriff
// entzogen wurde, ueber seine Links Zugriff auf Kommentare und Statistik.
function ownLink(req, res, minRole) {
  const token = String(req.params.token || '');
  const link = shareLinks.getShareLinkByToken(token);
  if (!link || link.owner_email !== sessionEmail(req)) {
    res.status(404).json({ error_code: 'NOT_FOUND' });
    return null;
  }
  setContext({ book: link.book_id });
  if (!guardBook(req, res, link.book_id, minRole)) return null;
  return link;
}

// Kommentar → Link → Buch-Guard fuer die Owner-Aktionen per Kommentar-ID.
// Fremde/unbekannte IDs → 404 (die SQL-Seite filtert zusaetzlich auf owner_email).
function guardComment(req, res, id) {
  const c = shareLinks.getCommentById(id);
  const link = c ? shareLinks.getShareLinkByToken(c.share_token) : null;
  if (!link || link.owner_email !== sessionEmail(req)) {
    res.status(404).json({ error_code: 'NOT_FOUND' });
    return false;
  }
  return guardBook(req, res, link.book_id, shareLinks.SHARE_CREATE_MIN_ROLE);
}

// Zeile fuer die Owner-Karte: `mine` (selbst angelegt → Bearbeiten/Kommentare/
// Statistik) und `creator_access` (Ersteller hat noch die noetige Buchrolle —
// sonst ist der Link fuer Leser bereits tot, siehe share-helpers#isExpired).
function _listRow(row, me) {
  return {
    ...row,
    mine: row.owner_email === me,
    creator_access: !H.creatorLostAccess(row),
  };
}

function register(router) {
  router.get('/api/links', requireSession, (req, res) => {
    const me = sessionEmail(req);
    const bookId = parseInt(req.query.book_id, 10);
    if (bookId && !guardBook(req, res, bookId, 'viewer')) return;
    try {
      // Buch-Owner sieht alle Links seines Buchs (auch die anderer Mitarbeiter),
      // alle anderen nur die eigenen.
      const rows = !bookId
        ? shareLinks.listSharesByOwner(me)
        : req.bookRole === 'owner'
          ? shareLinks.listSharesForBook(bookId)
          : shareLinks.listSharesByOwnerAndBook(me, bookId);
      res.json(rows.map(r => _listRow(r, me)));
    } catch (e) {
      logger.error('[share/api/links GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Pro-Seite-Zähler offener Reviewer-Kommentare über alle Links des Buchs
  // (Page-, Chapter- und Book-Shares). Befüllt den Badge am „Teilen"-Menü und
  // im Tree. Page-Shares: direkt via link.page_id. Chapter/Book-Shares: verankerte
  // Kommentare via anchor_bid → Seite (Block-Scan über den Content-Store, nur
  // einmal pro Buch und nur wenn überhaupt verankerte Kommentare vorliegen);
  // nicht-verankerte Kommentare lassen sich keiner Seite zuordnen und zählen nicht.
  router.get('/api/page-comment-counts', requireSession, async (req, res) => {
    const ownerEmail = sessionEmail(req);
    const bookId = parseInt(req.query.book_id, 10);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    if (!guardBook(req, res, bookId, 'viewer')) return;
    try {
      const rows = shareLinks.openReaderCommentsForBook(ownerEmail, bookId);
      const counts = {};
      const bump = (pageId) => { if (pageId) counts[pageId] = (counts[pageId] || 0) + 1; };

      // Block-IDs der noch aufzulösenden, verankerten Kommentare sammeln.
      const pendingBids = new Set();
      for (const r of rows) {
        if (r.kind === 'page') bump(r.page_id);
        else if (r.anchor_bid) pendingBids.add(String(r.anchor_bid).toLowerCase());
      }

      // Block→Seite-Map nur bauen, wenn nötig (gecachter Scan über die Buch-Seiten).
      if (pendingBids.size) {
        const bidToPage = await resolveBidsToPages(bookId, pendingBids);
        for (const r of rows) {
          if (r.kind !== 'page' && r.anchor_bid) bump(bidToPage[String(r.anchor_bid).toLowerCase()]);
        }
      }
      res.json(counts);
    } catch (e) {
      logger.error('[share/api/page-comment-counts GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Pro-Seite-Zähler aktiver Share-Links, die diese Seite enthalten. Speist den
  // `.btn-count`-Badge am „Teilen"-Eintrag des Page-Action-Menüs. Eine Seite ist
  // enthalten in: einem Page-Share auf sie selbst, einem Chapter-Share auf ihr
  // Kapitel oder einen Vorfahren (Teilbaum, analog Reader-Render) und jedem
  // Buch-Share des Buchs.
  router.get('/api/page-link-counts', requireSession, async (req, res) => {
    const ownerEmail = sessionEmail(req);
    const bookId = parseInt(req.query.book_id, 10);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    if (!guardBook(req, res, bookId, 'viewer')) return;
    try {
      const links = shareLinks.activeLinksForOwnerBook(ownerEmail, bookId);
      let bookCount = 0;
      const chapterCount = {};
      const pageCount = {};
      for (const l of links) {
        if (l.kind === 'book') bookCount++;
        else if (l.kind === 'chapter' && l.chapter_id != null) chapterCount[l.chapter_id] = (chapterCount[l.chapter_id] || 0) + 1;
        else if (l.kind === 'page' && l.page_id != null) pageCount[l.page_id] = (pageCount[l.page_id] || 0) + 1;
      }
      const counts = {};
      const pages = await contentStore.listPages(bookId);
      // Kapitel → Zahl der Kapitel-Shares, deren Teilbaum es enthaelt.
      const inChapterShares = {};
      if (Object.keys(chapterCount).length) {
        const chapters = await contentStore.listChapters(bookId);
        for (const [cid, n] of Object.entries(chapterCount)) {
          for (const id of chapterScopeIds(Number(cid), chapters)) inChapterShares[id] = (inChapterShares[id] || 0) + n;
        }
      }
      for (const p of pages) {
        const n = bookCount
          + (p.chapter_id != null ? (inChapterShares[p.chapter_id] || 0) : 0)
          + (pageCount[p.id] || 0);
        if (n > 0) counts[p.id] = n;
      }
      res.json(counts);
    } catch (e) {
      logger.error('[share/api/page-link-counts GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Volle Kommentar-Threads über alle Links eines Owners zu einem Buch. Speist die
  // Kommentar-Leiste der Leseansicht: der Client gruppiert zu Threads und filtert
  // per Anker (data-bid/quote) auf die aktuell gerenderte Seite. Jede Zeile trägt
  // share_token → Reply/Resolve/Delete nutzen die bestehenden Owner-Endpoints.
  router.get('/api/book-comments/:book_id', requireSession, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const bookId = parseInt(req.params.book_id, 10);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    if (!guardBook(req, res, bookId, 'viewer')) return;
    try {
      const rows = shareLinks.listCommentsByOwnerBook(ownerEmail, bookId);
      if (req.query.mark_seen === '1') shareLinks.markOwnerSeenForBook(ownerEmail, bookId);
      res.json(rows);
    } catch (e) {
      logger.error('[share/api/book-comments GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.post('/api/links', requireSession, jsonBody, async (req, res) => {
    const ownerEmail = sessionEmail(req);
    const { kind, page_id, chapter_id, book_id, intro, expires_at, show_toc } = req.body || {};
    if (kind !== 'page' && kind !== 'chapter' && kind !== 'book') return res.status(400).json({ error_code: 'INVALID_KIND' });
    if (kind === 'page' && !Number.isInteger(parseInt(page_id, 10))) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
    if (kind === 'chapter' && !Number.isInteger(parseInt(chapter_id, 10))) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
    if (kind === 'book' && !Number.isInteger(parseInt(book_id, 10))) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    if (intro && String(intro).length > INTRO_MAX) return res.status(400).json({ error_code: 'INTRO_TOO_LONG' });
    if (expires_at) {
      const d = new Date(expires_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
      if (d <= new Date()) return res.status(400).json({ error_code: 'EXPIRES_AT_IN_PAST' });
    }

    // bookId aus Page bzw. Chapter holen + ACL prüfen.
    let bookId = null;
    let pageId = null;
    let chapterId = null;
    try {
      if (kind === 'page') {
        pageId = parseInt(page_id, 10);
        const pd = await contentStore.loadPage(pageId);
        bookId = pd.book_id;
      } else if (kind === 'chapter') {
        chapterId = parseInt(chapter_id, 10);
        const ch = await contentStore.loadChapter(chapterId);
        bookId = ch.book_id;
      } else {
        bookId = parseInt(book_id, 10);
        const b = await contentStore.loadBook(bookId);
        if (!b) throw new Error('book not found');
      }
    } catch {
      return res.status(404).json({ error_code: 'TARGET_NOT_FOUND' });
    }

    if (!guardBook(req, res, bookId, shareLinks.SHARE_CREATE_MIN_ROLE)) return;

    try {
      const created = shareLinks.createShareLink({
        kind, pageId, chapterId, bookId,
        ownerEmail,
        intro: intro ? String(intro).slice(0, INTRO_MAX) : null,
        expiresAt: expires_at || null,
        showToc: !!show_toc,
      });

      // data-bid auf den Scope-Seiten nachziehen (Detail-Begruendung am Helper).
      await backfillScopeBlockIds(created);

      logger.info(`[share/api/links POST] kind=${kind} book=${bookId} token=${created.token.slice(0, 8)}`);
      res.json(created);
    } catch (e) {
      logger.error('[share/api/links POST] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.patch('/api/links/:token', requireSession, jsonBody, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const token = String(req.params.token || '');
    if (!ownLink(req, res, shareLinks.SHARE_CREATE_MIN_ROLE)) return;
    const patch = {};
    if ('intro' in (req.body || {})) {
      const intro = req.body.intro;
      if (intro != null && String(intro).length > INTRO_MAX) return res.status(400).json({ error_code: 'INTRO_TOO_LONG' });
      patch.intro = intro ? String(intro).slice(0, INTRO_MAX) : null;
    }
    if ('expires_at' in (req.body || {})) {
      const exp = req.body.expires_at;
      if (exp) {
        const d = new Date(exp);
        if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
      }
      patch.expiresAt = exp || null;
    }
    if ('show_toc' in (req.body || {})) {
      patch.showToc = !!req.body.show_toc;
    }
    try {
      shareLinks.updateShareLink(token, ownerEmail, patch);
      res.json(shareLinks.getShareLinkByToken(token));
    } catch (e) {
      logger.error('[share/api/links PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.delete('/api/links/:token', requireSession, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    // Eigener Link: der Ersteller darf ihn immer widerrufen (auch ohne Buchrolle —
    // Widerrufen gibt nichts preis). Fremder Link: nur der Buch-Owner. Alle
    // anderen bekommen 404, damit der Token kein Existenz-Orakel ist.
    const mine = link.owner_email === ownerEmail;
    if (!mine && resolveBookRole(req, link.book_id) !== 'owner') {
      return res.status(404).json({ error_code: 'NOT_FOUND' });
    }
    try {
      const ok = mine
        ? shareLinks.revokeShareLink(token, ownerEmail)
        : shareLinks.revokeShareLinkOnBook(token, link.book_id);
      if (!ok) return res.status(409).json({ error_code: 'ALREADY_REVOKED' });
      logger.info(`[share/api/links DELETE] token=${token.slice(0, 8)} book=${link.book_id}${mine ? '' : ' (Buch-Owner)'}`);
      res.json({ ok: true });
    } catch (e) {
      logger.error('[share/api/links DELETE] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.get('/api/links/:token/comments', requireSession, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const token = String(req.params.token || '');
    const link = ownLink(req, res, 'viewer');
    if (!link) return;
    try {
      const rows = shareLinks.listCommentsByToken(token, { order: 'desc' });
      if (req.query.mark_seen === '1') shareLinks.markOwnerSeen(token, ownerEmail);
      res.json(rows);
    } catch (e) {
      logger.error('[share/api/links/comments GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Kapitel-Drop-off eines Links (Autor): pro Kapitel Ø-Lesetiefe + Anzahl der
  // Aufrufe, die es erreicht haben. Nur bei Buch-/Kapitel-Shares gefüllt.
  router.get('/api/links/:token/read-depth', requireSession, (req, res) => {
    const token = String(req.params.token || '');
    const link = ownLink(req, res, 'viewer');
    if (!link) return;
    try {
      res.json({ chapters: shareLinks.readDepthByToken(token) });
    } catch (e) {
      logger.error('[share/api/links/read-depth GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Gesamt-Fazits eines Links (Autor): Sternewertung + Freitext pro Leser.
  router.get('/api/links/:token/feedback', requireSession, (req, res) => {
    const token = String(req.params.token || '');
    const link = ownLink(req, res, 'viewer');
    if (!link) return;
    try {
      res.json({ feedback: shareLinks.listFeedbackByToken(token) });
    } catch (e) {
      logger.error('[share/api/links/feedback GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Owner-Sprung: ordnet einen verankerten Kommentar (Block via data-bid) der
  // konkreten Seite zu, damit der Editor sie öffnen kann. Page-Share = trivial;
  // Chapter-Share = Block in den Kapitel-Seiten suchen (Anker speichert keine
  // page_id).
  router.get('/api/links/:token/locate', requireSession, async (req, res) => {
    const link = ownLink(req, res, 'viewer');
    if (!link) return;
    const bid = String(req.query?.bid || '').toLowerCase();
    if (!ANCHOR_BID_RE.test(bid)) return res.status(400).json({ error_code: 'INVALID_ANCHOR' });
    if (link.kind === 'page') return res.json({ page_id: link.page_id });
    try {
      // data-bid ist buchweit eindeutig → gecachter Scan über alle Buch-Seiten
      // (teilt den Cache mit page-comment-counts).
      const map = await resolveBidsToPages(link.book_id, new Set([bid]));
      res.json({ page_id: map[bid] || null });
    } catch (e) {
      logger.error('[share/api/links/locate GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Owner antwortet auf einen Root-Kommentar (Thread bidirektional).
  router.post('/api/links/:token/comments', requireSession, jsonBody, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const token = String(req.params.token || '');
    const link = ownLink(req, res, shareLinks.SHARE_CREATE_MIN_ROLE);
    if (!link) return;
    const body = String((req.body?.body || '')).trim();
    if (!body) return res.status(400).json({ error_code: 'BODY_REQUIRED' });
    if (body.length > H.BODY_MAX) return res.status(400).json({ error_code: 'BODY_TOO_LONG' });
    const target = parseInt(req.body?.parent_id, 10);
    if (!Number.isInteger(target)) return res.status(400).json({ error_code: 'INVALID_PARENT' });
    // Flacher Thread: Antwort auf eine Antwort hängt unter denselben Root.
    const parentId = shareLinks.resolveThreadRootId(target, token);
    if (!parentId) return res.status(400).json({ error_code: 'INVALID_PARENT' });
    try {
      const reply = shareLinks.insertOwnerReply({ token, parentId, authorEmail: ownerEmail, body });
      logger.info(`[share/api/reply] token=${token.slice(0, 8)} book=${link.book_id} parent=${parentId}`);
      // Reviewer per Mail zurueckholen, wenn er beim Root eine Adresse hinterlegt
      // hat (fire-and-forget, gedrosselt, opt-out). Kein Leak: Mail nur an den
      // Root-Verfasser dieses Threads.
      notify.maybeNotifyReaderReply(link, reply, shareLinks.getCommentById(parentId)).catch(() => {});
      res.json(reply);
    } catch (e) {
      logger.error('[share/api/reply POST] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Owner markiert einen Root-Thread als erledigt / oeffnet ihn wieder.
  router.patch('/api/comments/:id/resolve', requireSession, jsonBody, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    if (!guardComment(req, res, id)) return;
    const resolved = req.body?.resolved !== false;
    try {
      const ok = shareLinks.setCommentResolved(id, ownerEmail, resolved);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      res.json({ ok: true, resolved });
    } catch (e) {
      logger.error('[share/api/comments resolve PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.delete('/api/comments/:id', requireSession, (req, res) => {
    const ownerEmail = sessionEmail(req);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    if (!guardComment(req, res, id)) return;
    try {
      const ok = shareLinks.deleteComment(id, ownerEmail);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      res.json({ ok: true });
    } catch (e) {
      logger.error('[share/api/comments DELETE] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });
}

module.exports = { register, requireSession };
