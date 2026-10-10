'use strict';

// Book-Import-Job. Empfaengt ein `.swbook`-Bundle (ZIP mit manifest.json +
// book.json, siehe lib/book-bundle.js), validiert das Manifest, legt ein NEUES
// Buch (Owner = importierender User) an und schreibt Kapitel + Seiten in
// Tree-Reihenfolge via Content-Store-Facade. Gegenstueck zum Sync-Export in
// routes/book-migration.js. Spiegelt das Buffer-Map-Pattern von folder-import.

const express = require('express');
const JSZip = require('jszip');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  jobs, createJob, enqueueJob, findActiveJobId,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { validateManifest, validateBookJson, planFromNodes, normalizeIncludes } = require('../../lib/book-bundle');
const { restoreExtras } = require('../../db/book-migration-data');
const { materializeOps, applyBundleSettings } = require('../../lib/bundle-apply');
const { setContext } = require('../../lib/log-context');
const bookAccess = require('../../db/book-access');
const { db } = require('../../db/connection');
const logger = require('../../logger');
const { sessionEmail } = require('../../lib/acl');
const { seedImportBaseline } = require('../../lib/import-baseline');

const router = express.Router();

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const BUFFER_TTL_MS = 30 * 60 * 1000;

// jobId -> { buffer }
const importBuffers = new Map();

function _scheduleBufferCleanup(jobId) {
  const t = setTimeout(() => importBuffers.delete(jobId), BUFFER_TTL_MS);
  t.unref?.();
}

async function _readJsonEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry) return null;
  const text = await entry.async('string');
  try { return JSON.parse(text); }
  catch { throw i18nError('job.error.badManifest'); }
}

async function runBookImportJob(jobId, { userEmail }) {
  const log = makeJobLogger(jobId);
  const ctx = { session: { user: { email: userEmail } } };
  try {
    const entry = importBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');

    updateJob(jobId, { progress: 5, statusText: 'job.book-import.unpacking' });
    const zip = await JSZip.loadAsync(entry.buffer);

    updateJob(jobId, { progress: 10, statusText: 'job.book-import.validating' });
    const manifest = await _readJsonEntry(zip, 'manifest.json');
    if (!manifest) throw i18nError('job.error.badManifest');
    try { validateManifest(manifest); }
    catch (e) {
      throw i18nError(e.code === 'UNSUPPORTED_VERSION' ? 'job.error.unsupportedVersion' : 'job.error.badManifest');
    }

    const bookJson = await _readJsonEntry(zip, 'book.json');
    try { validateBookJson(bookJson); }
    catch { throw i18nError('job.error.swbookEmpty'); }

    const { ops, cappedChapters } = planFromNodes(bookJson.tree);
    if (cappedChapters) log.warn(`book-import: ${cappedChapters} Kapitel jenseits Tiefe 3 gekappt`);

    // Buch anlegen + Owner-Grant.
    updateJob(jobId, { progress: 20, statusText: 'job.book-import.creatingBook' });
    const created = await contentStore.createBook(
      { name: bookJson.book.name, description: bookJson.book.description || '', owner_email: userEmail },
      ctx,
    );
    const bookId = created.id;
    setContext({ book: bookId });
    try {
      contentStore.setBookOwner(bookId, userEmail, { onlyIfUnset: true });
      bookAccess.grantAccess(bookId, userEmail, 'owner', userEmail);
    } catch (gErr) {
      logger.warn(`Auto-Owner-Grant fuer book=${bookId} fehlgeschlagen: ${gErr.message}`);
    }
    log.info(`book-import: Buch «${bookJson.book.name}» angelegt (id=${bookId})`);

    // Buch-Konfig (authored). allow_lektor_book_chat bewusst auf 0 — ACL-relevant,
    // instanzspezifisch.
    try { applyBundleSettings(bookId, bookJson.book.settings, { allowLektorBookChat: 0 }); }
    catch (e) { log.warn(`book-import: Settings-Uebernahme fehlgeschlagen: ${e.message}`); }

    // Kapitel + Seiten anlegen (gemeinsamer Schreibpfad mit dem Fassungs-Restore):
    // Reihenfolge inkl. Interleaving, excluded-Flag, Kapitel-Querverweise auf die
    // neuen IDs. srcId -> neue ID fuellt die Remap-Maps fuer die Extra-Bloecke.
    const applied = await materializeOps(bookId, ops, ctx, {
      replace: true,
      onProgress: (done, total) => {
        if (done % 10 !== 0 && done !== total) return;
        updateJob(jobId, {
          progress: 25 + Math.round(65 * (done / total)),
          statusText: 'job.book-import.creatingPages',
          statusParams: { current: done, total },
        });
      },
    });
    const pageIdMap = applied.pageIdBySrc;       // srcPageId    -> neue page_id
    const chapterIdMap = applied.chapterIdBySrc; // srcChapterId -> neue chapter_id
    const pagesCreated = applied.created.pages;
    const chaptersCreated = applied.created.chapters;
    if (applied.failed) log.warn(`book-import: ${applied.failed} Kapitel/Seiten nicht angelegt`);

    log.info(`book-import abgeschlossen: ${pagesCreated} Seiten, ${chaptersCreated} Kapitel`);

    // Optionale Extra-Bloecke (Komplettanalyse / Lektorat / Chats) wiederherstellen.
    // Non-fatal: scheitert das, bleibt das Buch mit Inhalt erhalten.
    const includes = normalizeIncludes(manifest.includes);
    let extrasResult = null;
    if (includes.analysis || includes.lektorat || includes.chats || includes.research) {
      updateJob(jobId, { progress: 92, statusText: 'job.book-import.restoringExtras' });
      const extras = {};
      try {
        if (includes.analysis) extras.analysis = await _readJsonEntry(zip, 'analysis.json');
        if (includes.lektorat) extras.lektorat = await _readJsonEntry(zip, 'lektorat.json');
        if (includes.chats)    extras.chats = await _readJsonEntry(zip, 'chats.json');
        if (includes.research) extras.research = await _readJsonEntry(zip, 'research.json');
        extrasResult = restoreExtras(bookId, extras, { pageIdMap, chapterIdMap }, userEmail);
        log.info(`book-import Extras wiederhergestellt: ${JSON.stringify(extrasResult)}`);
      } catch (e) {
        log.warn(`book-import: Extra-Wiederherstellung fehlgeschlagen: ${e.message}`);
        extrasResult = { error: true };
      }
    }

    if (pagesCreated > 0) await seedImportBaseline(bookId, userEmail, log, '.swbook-Import');

    completeJob(jobId, { bookId, bookName: bookJson.book.name, pagesCreated, chaptersCreated, cappedChapters, extras: extrasResult });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`book-import job ${jobId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    importBuffers.delete(jobId);
  }
}

const rawZipBody = express.raw({
  type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
  limit: MAX_ZIP_BYTES + 1,
});

router.post('/book-import', rawZipBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (req.body.length > MAX_ZIP_BYTES) {
    return res.status(413).json({ error_code: 'ZIP_TOO_LARGE' });
  }

  // Dedup ueber Buffer-Groesse + User: zwei identische Uploads parallel sind der
  // einzige praktisch deckbare Fall; bewusst grob.
  const dedupKey = `swbook:${req.body.length}`;
  const existing = findActiveJobId('book-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('book-import', 0, userEmail, 'job.label.bookImport', {}, dedupKey);
  importBuffers.set(jobId, { buffer: req.body });
  _scheduleBufferCleanup(jobId);

  enqueueJob(jobId, () => runBookImportJob(jobId, { userEmail }));
  res.status(202).json({ jobId });
});

module.exports = { bookImportRouter: router, runBookImportJob, importBuffers };
