'use strict';
// Content-Routes: Kapitel-Ebene (Detail/Create/Update/Delete).

const contentStore = require('../../lib/content-store');
const { toIntId } = require('../../lib/validate');
const { guardBook } = require('../../lib/acl');
const { resolveChapterBookId } = require('../../lib/content-ownership');
const { jsonBody, _guardChapter, _fail } = require('./shared');

function register(router) {
  // GET /content/chapters/:chapter_id — Kapitel-Detail.
  router.get('/chapters/:chapter_id', async (req, res) => {
    const chapterId = toIntId(req.params.chapter_id);
    if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
    if (_guardChapter(req, res, chapterId, 'viewer') == null) return;
    try { res.json(await contentStore.loadChapter(chapterId, req)); }
    catch (e) { _fail(res, e, 'GET /content/chapters/:id'); }
  });

  // POST /content/chapters — Neues Kapitel. Body: { book_id, name, position?, parent_chapter_id?, after_chapter_id? }.
  // `after_chapter_id` fuegt als Geschwister hinter dem Anker ein und laesst die
  // Nachfolger aufruecken; `position`/`parent_chapter_id` werden dann ignoriert.
  router.post('/chapters', jsonBody, async (req, res) => {
    const bookId = toIntId(req.body?.book_id);
    const name = (req.body?.name || '').toString().trim();
    if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
    if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
    if (!guardBook(req, res, bookId, 'editor')) return;
    const parentChapterId = Number.isFinite(req.body?.parent_chapter_id) ? req.body.parent_chapter_id : null;
    // Eltern-Kapitel muss im geprüften Buch liegen (kein Fremd-Verweis im Baum).
    if (parentChapterId != null && resolveChapterBookId(parentChapterId) !== bookId) {
      return res.status(400).json({ error_code: 'CHAPTER_NOT_IN_BOOK' });
    }
    const afterChapterId = Number.isFinite(req.body?.after_chapter_id) ? req.body.after_chapter_id : null;
    if (afterChapterId != null && resolveChapterBookId(afterChapterId) !== bookId) {
      return res.status(400).json({ error_code: 'CHAPTER_NOT_IN_BOOK' });
    }
    try {
      const created = await contentStore.createChapter({
        book_id: bookId,
        name,
        position: req.body?.position,
        parent_chapter_id: parentChapterId,
        after_chapter_id: afterChapterId,
      }, req);
      res.json(created);
    } catch (e) { _fail(res, e, 'POST /content/chapters'); }
  });

  // PUT /content/chapters/:chapter_id — Kapitel-Update (rename / reorder / exclude).
  router.put('/chapters/:chapter_id', jsonBody, async (req, res) => {
    const chapterId = toIntId(req.params.chapter_id);
    if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
    const hasName = typeof req.body?.name === 'string';
    const hasPos = Number.isFinite(req.body?.position);
    const hasExcluded = typeof req.body?.excluded === 'boolean';
    if (!hasName && !hasPos && !hasExcluded) {
      return res.status(400).json({ error_code: 'EMPTY_BODY' });
    }
    if (_guardChapter(req, res, chapterId, 'editor') == null) return;
    try { res.json(await contentStore.updateChapter(chapterId, req.body || {}, req)); }
    catch (e) { _fail(res, e, 'PUT /content/chapters/:id'); }
  });

  // DELETE /content/chapters/:chapter_id — loescht das Kapitel hart (kein
  // Papierkorb). Seine Seiten und Sub-Kapitel bleiben erhalten und verlieren nur
  // die Zuordnung (FK `ON DELETE SET NULL` auf pages.chapter_id bzw.
  // chapters.parent_chapter_id). Der Buchorganizer loescht nur leere Kapitel.
  router.delete('/chapters/:chapter_id', async (req, res) => {
    const chapterId = toIntId(req.params.chapter_id);
    if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
    if (_guardChapter(req, res, chapterId, 'editor') == null) return;
    try {
      await contentStore.deleteChapter(chapterId, req);
      res.json({ ok: true });
    } catch (e) { _fail(res, e, 'DELETE /content/chapters/:id'); }
  });
}

module.exports = { register };
