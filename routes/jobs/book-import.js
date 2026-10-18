'use strict';

// Book-Import-Job. Empfaengt ein `.swbook`-Bundle (ZIP mit manifest.json +
// book.json, siehe lib/book-bundle.js), validiert das Manifest, legt ein NEUES
// Buch (Owner = importierender User) an und schreibt Kapitel + Seiten in
// Tree-Reihenfolge via Content-Store-Facade. Gegenstueck zum Sync-Export in
// routes/book-migration.js. Spiegelt das Buffer-Map-Pattern von folder-import.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  jobs, createJob, enqueueJob, findActiveJobId, isJobActive, throwIfCancelled,
} = require('./shared');
const { validateManifest, validateBookJson, planFromNodes, normalizeIncludes } = require('../../lib/book-bundle');
const { restoreExtras } = require('../../db/book-migration-data');
const { materializeOps, applyBundleSettings } = require('../../lib/bundle-apply');
const { setContext } = require('../../lib/log-context');
const { createOwnedBook, discardImportedBook, bookNameError, BOOK_NAME_MAX } = require('../../lib/book-create');
const { openCappedZip } = require('../../lib/zip-limits');
const { ImportBufferStore, contentHash } = require('../../lib/import-buffers');
const { sessionEmail } = require('../../lib/acl');
const { seedImportBaseline } = require('../../lib/import-baseline');

const router = express.Router();

const MB = 1024 * 1024;
const MAX_ZIP_BYTES = 200 * MB;
const BUFFER_TTL_MS = 30 * 60 * 1000;

// Entpackt-Deckel fuer ein .swbook (lib/zip-limits.js). book.json eines sehr
// grossen Buchs liegt im einstelligen MB-Bereich, Analyse-/Chat-Bloecke etwas
// darueber; 256 MB pro Eintrag bleiben unter der V8-String-Grenze.
const SWBOOK_ZIP_LIMITS = Object.freeze({
  maxEntries: 100,
  maxEntryBytes: 256 * MB,
  maxTotalBytes: 512 * MB,
});

// jobId -> { buffer, userEmail }. Ein offener Upload pro User, Summe gedeckelt.
const importBuffers = new ImportBufferStore({
  ttlMs: BUFFER_TTL_MS,
  maxPerUser: 1,
  maxTotalBytes: 2 * MAX_ZIP_BYTES,
  isLive: isJobActive,
});

async function _readJsonEntry(zip, name) {
  const text = await zip.read(name, 'string');
  if (text == null) return null;
  try { return JSON.parse(text); }
  catch { throw i18nError('job.error.badManifest'); }
}

async function runBookImportJob(jobId, { userEmail, zipLimits = SWBOOK_ZIP_LIMITS }) {
  const log = makeJobLogger(jobId);
  const ctx = { session: { user: { email: userEmail } } };
  let createdBookId = null;   // Rueckbau, solange der Inhalt nicht steht
  try {
    const entry = importBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');

    updateJob(jobId, { progress: 5, statusText: 'job.book-import.unpacking' });
    const zip = await openCappedZip(entry.buffer, zipLimits);

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

    // Gleiche Namensregel wie die Buch-Karte (lib/book-create.js).
    const bookName = String(bookJson.book.name || '').trim();
    if (bookNameError(bookName)) throw i18nError('job.error.bookNameInvalid', { max: BOOK_NAME_MAX });
    const description = typeof bookJson.book.description === 'string' ? bookJson.book.description : '';

    const { ops, cappedChapters } = planFromNodes(bookJson.tree);
    if (cappedChapters) log.warn(`book-import: ${cappedChapters} Kapitel jenseits Tiefe 3 gekappt`);

    // Buch + Owner-Grant als Einheit; scheitert der Grant, bricht der Job ab.
    updateJob(jobId, { progress: 20, statusText: 'job.book-import.creatingBook' });
    const created = await createOwnedBook({ name: bookName, description }, userEmail, ctx);
    const bookId = created.id;
    createdBookId = bookId;
    setContext({ book: bookId });
    log.info(`book-import: Buch «${bookName}» angelegt (id=${bookId})`);

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
        throwIfCancelled(jobId);
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
    // Das Bundle hatte Abschnitte, angelegt wurde keiner (z.B. alle am Sanitizer
    // gescheitert): das ist kein Import, sondern ein leeres Buch, das wie ein
    // Ergebnis aussieht. Fehler, Buch wird zurueckgenommen.
    const pagesInBundle = ops.filter(o => o.op === 'page').length;
    if (pagesInBundle > 0 && pagesCreated === 0) {
      throw i18nError('job.error.swbookNoPagesCreated', { n: pagesInBundle });
    }
    createdBookId = null;   // Inhalt steht — spaetere Fehler nehmen das Buch nicht mehr zurueck

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

    // `failed`/`pagesInBundle` und ein gescheiterter Extra-Block gehen ins
    // Ergebnis, damit die Karte einen Teilimport als solchen zeigt.
    completeJob(jobId, {
      bookId, bookName, pagesCreated, chaptersCreated, cappedChapters, extras: extrasResult,
      failed: applied.failed || 0, pagesInBundle,
    });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`book-import job ${jobId}: ${e.message}`, { stack: e.stack });
    if (createdBookId) await discardImportedBook(createdBookId, userEmail);
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

  // Dedup ueber den Inhalts-Hash + User: derselbe Upload zweimal ergibt
  // denselben Job; verschiedene Dateien gleicher Groesse bleiben verschieden.
  const dedupKey = `swbook:${contentHash(req.body)}`;
  const existing = findActiveJobId('book-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const admission = importBuffers.admissionError(userEmail, req.body.length);
  if (admission) return res.status(429).json({ error_code: admission });

  const jobId = createJob('book-import', 0, userEmail, 'job.label.bookImport', {}, dedupKey);
  importBuffers.put(jobId, { buffer: req.body, userEmail });

  enqueueJob(jobId, () => runBookImportJob(jobId, { userEmail }));
  res.status(202).json({ jobId });
});

module.exports = { bookImportRouter: router, runBookImportJob, importBuffers, SWBOOK_ZIP_LIMITS };
