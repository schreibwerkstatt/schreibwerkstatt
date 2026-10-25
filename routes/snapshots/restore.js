'use strict';

// Fassungs-Restore — ganzes Buch und einzelne Seite/Kapitel. Synchroner Pfad
// wie der Capture (reiner DB-Read/-Write, kein KI-/Netz-Call).
//
//   POST /:bookId/:id/restore        Buch auf die Fassung zuruecksetzen
//   POST /:bookId/:id/restore-node   { kind:'page'|'chapter', srcId } nur diesen Knoten
//
// Beide schreiben an Ort und Stelle (lib/bundle-apply.js#materializeOps): was es
// im Buch noch gibt, behaelt seine ID; nur Fehlendes wird neu angelegt.

const express = require('express');
const logger = require('../../logger');
const contentStore = require('../../lib/content-store');
const { validateBookJson, planFromNodes } = require('../../lib/book-bundle');
const { materializeOps, applyBundleSettings } = require('../../lib/bundle-apply');
const { snapshotPublication } = require('../../lib/snapshot-export');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const snapshots = require('../../db/book-snapshots');
const { MAX_CHAPTER_DEPTH } = require('../../db/book-order');
const pagePresence = require('../../db/page-presence');
const { SETTINGS_FIELDS } = require('../../lib/snapshot-drift');
const { buildSnapshotPayload, insertPayload, sameAsBaseline } = require('./payload');

// Label der automatischen Sicherung, die ein Restore anlegt. Persistiert als
// __i18n:-Marker, damit der spaetere Betrachter die Bezeichnung in seiner
// eigenen Locale sieht (Frontend loest via t() auf).
const AUTO_BACKUP_LABEL = '__i18n:snapshots.autoBackupLabel__';

// Laufende Restores pro Buch (Prozess-lokal; die App laeuft als ein Prozess).
// Zwei ueberlappende Restores — Doppelklick, zweiter Tab — wuerden sonst ihre
// Zuordnungen und Loeschungen ineinander verschraenken.
const _running = new Set();

function _loadContent(row) {
  const content = JSON.parse(row.content_json);
  validateBookJson(content);
  return content;
}

// Editiert gerade ein ANDERER User am Buch (Live-Presence, stale-gefiltert)?
// Die eigene Presence (auch auf anderen Geraeten) zaehlt nicht.
function _otherEditors(bookId, userEmail) {
  const selfLc = (userEmail || '').toLowerCase();
  try {
    const others = pagePresence.listForBook(bookId)
      .filter((r) => String(r.user_email || '').toLowerCase() !== selfLc);
    return [...new Set(others.map((r) => r.user_display_name || r.user_email).filter(Boolean))];
  } catch (e) {
    logger.warn(`Restore-Presence-Check fehlgeschlagen (book=${bookId}): ${e.message}`);
    return [];
  }
}

// Auto-Sicherung des aktuellen Stands → Restore bleibt umkehrbar. Uebersprungen,
// wenn die Baseline-Fassung genau diesen Stand schon haelt (sonst legte jeder
// Restore eine weitere identische Sicherung ab). BOOK_EMPTY ist ok (nichts zu
// sichern); jeder andere Fehler wirft.
async function _backup(bookId, req, userEmail) {
  let cur;
  try { cur = await buildSnapshotPayload(bookId, req); }
  catch (e) { if (e.code === 'BOOK_EMPTY') return; throw e; }
  if (sameAsBaseline(bookId, cur, { scope: 'state' })) return;
  insertPayload(bookId, cur, { kind: 'auto_backup', label: AUTO_BACKUP_LABEL, userEmail });
}

// 409 BOOK_BUSY senden, wenn ein ANDERER User gerade am Buch editiert (ohne
// ?force=1). Liefert true, wenn die Antwort raus ist.
function _rejectIfBusy(req, res, bookId, userEmail) {
  const force = req.query.force === '1' || req.query.force === 'true';
  if (force) return false;
  const editors = _otherEditors(bookId, userEmail);
  if (!editors.length) return false;
  logger.info(`Restore blockiert: Buch ${bookId} wird von ${editors.length} anderen editiert.`);
  res.status(409).json({ error_code: 'BOOK_BUSY', editors });
  return true;
}

function _summary(r) {
  return {
    pagesCreated: r.created.pages, chaptersCreated: r.created.chapters,
    pagesUpdated: r.updated.pages, chaptersUpdated: r.updated.chapters,
    pagesDeleted: r.deleted.pages, chaptersDeleted: r.deleted.chapters,
    failed: r.failed,
  };
}

async function _syncStats(bookId, req) {
  try {
    const { syncBook } = require('../sync');
    await syncBook(bookId, req);
  } catch (e) { logger.warn(`Restore-Sync fehlgeschlagen (book=${bookId}): ${e.message}`); }
}

// Eingefrorene Publikation zurueckschreiben (best-effort, Voll-Replace wie
// upsertMeta). Cover/Autorfoto auf den Fassungs-Stand setzen — fehlt das BLOB in
// der Fassung, wird das Live-Bild geloescht. Die Auto-Sicherung hat den
// vorherigen Publikations-Stand mitgefroren → umkehrbar.
function _restorePublication(bookId, publicationJson) {
  const pub = snapshotPublication(publicationJson);
  if (!pub) return;
  try {
    const bp = require('../../db/book-publication');
    bp.upsertMeta(bookId, pub.meta);
    if (pub.cover) bp.setCover(bookId, pub.cover.image, pub.cover.mime);
    else bp.clearCover(bookId);
    if (pub.authorImage) bp.setAuthorImage(bookId, pub.authorImage.image, pub.authorImage.mime);
    else bp.clearAuthorImage(bookId);
  } catch (e) { logger.warn(`Restore-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`); }
}

// Buchname + Beschreibung der Fassung (best-effort; ein leerer Name bleibt aussen vor).
async function _restoreBookMeta(bookId, book, req) {
  if (!book || typeof book.name !== 'string' || !book.name.trim()) return;
  try {
    const cur = await contentStore.loadBook(bookId, req);
    const desc = typeof book.description === 'string' ? book.description : '';
    if ((cur?.name || '') !== book.name || (cur?.description || '') !== desc) {
      await contentStore.updateBook(bookId, { name: book.name, description: desc }, req);
    }
  } catch (e) { logger.warn(`Restore-Buchname fehlgeschlagen (book=${bookId}): ${e.message}`); }
}

// Knoten im Fassungs-Tree suchen. Liefert { node, parentSrcId } oder null.
function _findNode(nodes, kind, srcId, parentSrcId = null) {
  for (const n of (nodes || [])) {
    if (!n || typeof n !== 'object') continue;
    if (n.type === kind && n.srcId === srcId) return { node: n, parentSrcId };
    if (n.type === 'chapter') {
      const hit = _findNode(n.children, kind, srcId, Number.isFinite(n.srcId) ? n.srcId : null);
      if (hit) return hit;
    }
  }
  return null;
}

// Kapitel-Ebenen eines Fassungs-Knotens (Abschnitt 0, Kapitel ohne
// Unterkapitel 1, …).
function _chapterHeight(node) {
  if (!node || node.type !== 'chapter') return 0;
  return 1 + Math.max(0, ...(node.children || []).map(_chapterHeight));
}

// Elternkapitel fuer einen wiederhergestellten Teilbaum der Hoehe `height`: das
// urspruengliche, solange die Tiefe MAX_CHAPTER_DEPTH haelt — sonst der naechste
// Vorfahre, unter dem der Teilbaum passt (null = oberste Ebene). Das Elternkapitel
// kann seit der Fassung tiefer gewandert sein.
function _fittingParent(chapters, parentId, height) {
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const depthOf = (id) => {
    let d = 0;
    const seen = new Set();
    for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = byId.get(cur.parent_chapter_id)) {
      seen.add(cur.id);
      d++;
    }
    return d;
  };
  const visited = new Set();
  for (let cur = byId.get(parentId); cur && !visited.has(cur.id); cur = byId.get(cur.parent_chapter_id)) {
    visited.add(cur.id);
    if (depthOf(cur.id) + height <= MAX_CHAPTER_DEPTH) return cur.id;
  }
  return null;
}

function registerRestoreRoutes(router) {
  // ── Ganzes Buch ──────────────────────────────────────────────────────────────
  // Destruktiv fuer alles, was seit der Fassung hinzukam (Seiten → Papierkorb).
  // Reihenfolge (Pflicht): Sperren → Ziel planen → Auto-Sicherung → an Ort und
  // Stelle schreiben → Settings/Buchname/Publikation → Stats.
  router.post('/:bookId/:id/restore', express.json({ limit: '1mb' }), async (req, res) => {
    const bookId = toIntId(req.params.bookId);
    const id = toIntId(req.params.id);
    if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
    if (!guardBook(req, res, bookId, 'editor')) return;

    const row = snapshots.getSnapshot(bookId, id);
    if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
    let content, plan;
    try {
      content = _loadContent(row);
      plan = planFromNodes(content.tree);
      if (!plan.ops.length) throw new Error('no ops');
    } catch (e) {
      logger.error(`Restore: Ziel-Fassung defekt (book=${bookId}, id=${id}): ${e.message}`);
      return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
    }

    const userEmail = sessionEmail(req);
    if (_rejectIfBusy(req, res, bookId, userEmail)) return;
    if (_running.has(bookId)) return res.status(409).json({ error_code: 'RESTORE_RUNNING' });
    _running.add(bookId);
    try {
      // Jeder Fehler der Sicherung bricht ab, bevor etwas angefasst wird.
      try { await _backup(bookId, req, userEmail); }
      catch (e) {
        logger.error(`Restore-Sicherung fehlgeschlagen (book=${bookId}): ${e.message}`);
        return res.status(500).json({ error_code: 'BACKUP_FAILED' });
      }

      let result;
      try {
        result = await materializeOps(bookId, plan.ops, req, { replace: true });
      } catch (e) {
        logger.error(`Restore fehlgeschlagen (book=${bookId}): ${e.message}`);
        return res.status(500).json({ error_code: 'RESTORE_FAILED' });
      }

      // Nur Einstellungen, die Text oder Ausgabe betreffen (dieselbe Liste wie
      // der Drift-Check). Arbeits-/Status-Felder — fertig, Tages-/Zielvorgaben,
      // Deadline, Statistik-Ausschluss, Stilprofil, Recherche-Profil, Ideen-
      // Stufen — bleiben auf dem aktuellen Stand: wer Text von vor drei Monaten
      // zurueckholt, will nicht auch seine Deadline von damals.
      try { applyBundleSettings(bookId, content.book?.settings, { only: SETTINGS_FIELDS }); }
      catch (e) { logger.warn(`Restore-Settings fehlgeschlagen (book=${bookId}): ${e.message}`); }
      await _restoreBookMeta(bookId, content.book, req);
      _restorePublication(bookId, row.publication_json);
      // Ab jetzt hat das Buch den Stand dieser Fassung → Drift-Baseline.
      try { snapshots.markRestored(bookId, id); }
      catch (e) { logger.warn(`Restore-Markierung fehlgeschlagen (book=${bookId}): ${e.message}`); }
      await _syncStats(bookId, req);

      const summary = _summary(result);
      logger.info(`Buch auf «Fassung ${row.seq}» zurueckgesetzt (book=${bookId}, ${JSON.stringify(summary)}).`);
      return res.json({ ok: true, seq: row.seq, ...summary });
    } finally {
      _running.delete(bookId);
    }
  });

  // ── Einzelne Seite / einzelnes Kapitel ─────────────────────────────────────
  // Uebernimmt nur diesen Knoten aus der Fassung (Kapitel: samt Inhalt), ohne
  // etwas zu loeschen. Existiert die Seite noch, wird ihr Inhalt ersetzt — der
  // vorherige Stand bleibt in der Seiten-Historie. Fehlt sie, entsteht sie neu
  // im urspruenglichen Kapitel (bzw. auf Buch-Ebene, wenn auch das fehlt).
  // Ein Kapitel-Restore legt vorher eine Auto-Sicherung an: Kapitelname und
  // Export-Ausschluss haben keine eigene Historie.
  router.post('/:bookId/:id/restore-node', express.json({ limit: '4kb' }), async (req, res) => {
    const bookId = toIntId(req.params.bookId);
    const id = toIntId(req.params.id);
    const kind = req.body?.kind;
    const srcId = toIntId(req.body?.srcId);
    if (!bookId || !id || !srcId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
    if (kind !== 'page' && kind !== 'chapter') return res.status(400).json({ error_code: 'BAD_KIND' });
    if (!guardBook(req, res, bookId, 'editor')) return;

    const row = snapshots.getSnapshot(bookId, id);
    if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
    let hit;
    try { hit = _findNode(_loadContent(row).tree, kind, srcId); }
    catch { return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' }); }
    if (!hit) return res.status(404).json({ error_code: 'NODE_NOT_FOUND' });

    const userEmail = sessionEmail(req);
    if (_rejectIfBusy(req, res, bookId, userEmail)) return;
    if (_running.has(bookId)) return res.status(409).json({ error_code: 'RESTORE_RUNNING' });
    _running.add(bookId);
    try {
      if (kind === 'chapter') {
        try { await _backup(bookId, req, userEmail); }
        catch (e) {
          logger.error(`Knoten-Restore-Sicherung fehlgeschlagen (book=${bookId}): ${e.message}`);
          return res.status(500).json({ error_code: 'BACKUP_FAILED' });
        }
      }
      let rootParentChapterId = null;
      if (hit.parentSrcId != null) {
        const chapters = await contentStore.listChapters(bookId, req);
        if (chapters.some((c) => c.id === hit.parentSrcId)) {
          rootParentChapterId = _fittingParent(chapters, hit.parentSrcId, _chapterHeight(hit.node));
        }
      }
      const { ops } = planFromNodes([hit.node]);
      const result = await materializeOps(bookId, ops, req, { replace: false, rootParentChapterId });
      await _syncStats(bookId, req);
      const summary = _summary(result);
      logger.info(`Fassung ${row.seq}: ${kind} ${srcId} wiederhergestellt (book=${bookId}, ${JSON.stringify(summary)}).`);
      return res.json({
        ok: true, seq: row.seq, ...summary,
        pageId: kind === 'page' ? (result.pageIdBySrc.get(srcId) ?? null) : null,
      });
    } catch (e) {
      logger.error(`Knoten-Restore fehlgeschlagen (book=${bookId}, ${kind} ${srcId}): ${e.message}`);
      return res.status(500).json({ error_code: 'RESTORE_FAILED' });
    } finally {
      _running.delete(bookId);
    }
  });
}

module.exports = { registerRestoreRoutes };
