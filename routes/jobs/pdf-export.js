'use strict';
// Custom-PDF-Export-Job. Laedt via lib/load-contents (Buch/Kapitel/Seite),
// rendert via lib/pdf-render und persistiert das Buffer in einem In-Memory-
// Result-Store, weil die Standard-Job-Result-Serialisierung JSON ist und MB-
// Buffers darin nichts zu suchen haben. Frontend laedt das fertige PDF ueber
// einen separaten Endpoint als Stream.
//
// Job-Result-JSON enthaelt nur Metadaten: Groesse, MIME, Validation-Status,
// Render-Hinweise. Der eigentliche Buffer liegt im Result-Store
// (./pdf-export-results.js: 2 h TTL + Gesamt-Byte-Deckel mit LRU).
//
// Probeseiten (`sample: true`): nur das erste Kapitel der Einheit, ohne
// Verzeichnis/Apparat/Backmatter (Renderer honoriert `sample`), ohne
// veraPDF/Ghostscript — schnelle Satzprobe vor dem langen Volllauf.

const express = require('express');
const {
  jobs, createJob, enqueueJob, jobAbortControllers,
  updateJob, completeJob, failJob, makeJobLogger,
  findActiveJobId,
  i18nError, emptyScopeError,
  jsonBody,
} = require('./shared');
const { getPdfExportProfile, getPdfExportProfileBackCover, getPdfExportProfileSpineImage, getBookSettings } = require('../../db/schema');
// Cover/Autorfoto + Titelei sind buch-weit (book_publication), geteilt mit dem
// EPUB-Export. Der PDF-Render liest sie von hier, nicht mehr vom Profil.
const {
  getMeta: getBookPublication,
  getCover: getBookPublicationCover,
  getAuthorImage: getBookPublicationAuthorImage,
} = require('../../db/book-publication');
const { loadContents } = require('../../lib/load-contents');
const { getSnapshot } = require('../../db/book-snapshots');
const { snapshotToBundle, snapshotPublication } = require('../../lib/snapshot-export');
const { renderPdfBuffer } = require('../../lib/pdf-render');
const { buildBibliography, pageIdsFromGroups, citationsFromGroups } = require('../../lib/bibliography');
const { renderCoverBuffer, computeSpineMm } = require('../../lib/pdf-cover-render');
const { validatePdfa } = require('../../lib/pdfa-validate');
const { convertToPdfX } = require('../../lib/pdfx-convert');
const { buildExportFilename } = require('../../lib/filenames');
const { resolveSlug } = require('../../lib/export-builders/shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { abortError } = require('../../lib/http-util');
const contentStore = require('../../lib/content-store');
const { createResultStore } = require('./pdf-export-results');

const router = express.Router();

const VALID_SCOPES = new Set(['book', 'chapter', 'page']);
const VALID_TARGETS = new Set(['interior', 'cover']);

// jobId → { buffer, mime, filename }
const pdfResults = createResultStore();

// Probeseiten: Gruppen auf das erste Kapitel der Einheit kuerzen.
//  - scope 'book': erstes Top-Level-Kapitel, das Seiten traegt, samt seinen
//    Unterkapiteln (Gruppen sind depth-first sortiert). Kapitellose Seiten am
//    Buchanfang fallen weg, ausser das Buch hat gar keine Kapitel.
//  - scope 'chapter': die erste Gruppe (Kapitel selbst bzw. erstes Unterkapitel).
//  - scope 'page': unveraendert.
// Wurzel-Schluessel: Kette ueber parent_chapter_id, soweit die Eltern in den
// Gruppen vorkommen; ein Elternkapitel ohne eigene Seiten taucht nicht als
// Gruppe auf und ist dann selbst der Schluessel.
function sampleGroups(groups, scope) {
  if (!Array.isArray(groups) || !groups.length || scope === 'page') return groups;
  const chaptered = groups.filter(g => g.chapter);
  if (!chaptered.length) return groups.slice(0, 1);
  if (scope === 'chapter') return [chaptered[0]];
  const byId = new Map(chaptered.map(g => [g.chapter.id, g.chapter]));
  const rootKey = (ch) => {
    let cur = ch;
    const seen = new Set();
    while (cur.parent_chapter_id != null && byId.has(cur.parent_chapter_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_chapter_id);
    }
    return cur.parent_chapter_id ?? cur.id;
  };
  const root = rootKey(chaptered[0].chapter);
  return chaptered.filter(g => rootKey(g.chapter) === root);
}

// Renderer-Hinweise ins Job-Result (non-fatal). Fehlende Felder → leerer Default.
function renderWarningsFromMeta(meta = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const num = (v) => (Number.isFinite(v) ? v : (Array.isArray(v) ? v.length : 0));
  return {
    footnoteFallback:      !!meta.footnoteFallback,
    footnoteOverflowPages: num(meta.footnoteOverflowPages),
    xrefUnresolved:        arr(meta.xrefUnresolved),
    fontFallbacks:         arr(meta.fontFallbacks),
    dpiWarnings:           arr(meta.dpiWarnings),
    hyphenationDisabled:   arr(meta.hyphenationDisabled),
    oversizeImages:        num(meta.oversizeImages),
  };
}

async function runPdfExportJob(jobId, { scope, entityId, profileId, includeSubchapters, target = 'interior', snapshotId = null, sample = false, userEmail }) {
  const log = makeJobLogger(jobId);
  const ctrl = jobAbortControllers.get(jobId);
  const signal = ctrl?.signal;
  const checkCancelled = () => { if (signal?.aborted || jobs.get(jobId)?.cancelled) throw abortError('job.cancelled'); };

  try {
    updateJob(jobId, { progress: 5, statusText: 'job.phase.loadProfile' });
    const profile = getPdfExportProfile(profileId);
    if (!profile) throw i18nError('job.error.profileNotFound');
    if (profile.user_email !== userEmail) throw i18nError('job.error.forbidden');

    updateJob(jobId, { progress: 10, statusText: 'job.phase.loadBook' });
    // snapshotId gesetzt → Bundle aus dem selbsttragenden Fassungs-Stand bauen
    // (scope ist dann immer 'book', entityId = bookId). Sonst Live-Buchinhalt.
    let bundle;
    let frozenPub = null;
    if (snapshotId) {
      const snap = getSnapshot(entityId, snapshotId);
      if (!snap) throw i18nError('job.error.snapshotNotFound');
      let content;
      try { content = JSON.parse(snap.content_json); }
      catch { throw i18nError('job.error.snapshotCorrupt'); }
      bundle = snapshotToBundle(content, { bookId: entityId });
      if (!bundle.groups.length) throw i18nError('job.error.snapshotCorrupt');
      frozenPub = snapshotPublication(snap.publication_json);
    } else {
      bundle = await loadContents({ scope, id: entityId, includeSubchapters: !!includeSubchapters });
    }
    const { book, chapter, page } = bundle;
    const groups = sample ? sampleGroups(bundle.groups, scope) : bundle.groups;
    const snapDetail = snapshotId ? `, fassungId=${snapshotId}` : '';
    const scopeDetail = scope === 'chapter' && chapter?.id ? `, chapter=${chapter.id}${includeSubchapters ? '+sub' : ''}`
                      : scope === 'page'    && page?.id    ? `, page=${page.id}`
                      : '';
    const sampleDetail = sample ? `, probe=${groups.length} Gruppe(n)` : '';
    log.info(`Start PDF-Export «${book.name}» (scope=${scope}${scopeDetail}${snapDetail}${sampleDetail}, profile=${profile.name})`);

    updateJob(jobId, { progress: 30, statusText: 'job.phase.loadPages' });

    checkCancelled();

    const { language: bookLang, region: bookRegion } = getBookSettings(book.id, userEmail);
    const standard = profile.config.pdfa?.standard || (profile.config.pdfa?.enabled ? 'pdfa' : 'none');

    // Buch-weite Publikations-Metadaten in config.extras spiegeln, damit die
    // Render-Funktionen (pages.js, cover-render) unveraendert config.extras
    // lesen. Render-Toggles (barcode, imprintPosition) bleiben Profil-Sache.
    // Cover/Autorfoto kommen ebenfalls buch-weit (geteilt mit EPUB).
    // Bei einer Fassung mit eingefrorener Publikation (frozenPub) wird statt der
    // Live-book_publication der eingefrorene Stand gespiegelt.
    let pubCoverBuf = null;
    let pubAuthorBuf = null;
    if (scope === 'book') {
      const pub = frozenPub ? frozenPub.meta : getBookPublication(book.id);
      const ex = profile.config.extras;
      ex.authorName  = pub.author_name || '';
      ex.isbn        = pub.isbn || '';
      ex.subtitle    = pub.subtitle || '';
      ex.year        = pub.year || '';
      ex.dedication  = pub.dedication || '';
      ex.imprint     = pub.imprint || '';
      ex.copyright   = pub.copyright || '';
      ex.frontMatter = pub.frontmatter || '';
      ex.authorBio   = pub.author_bio || '';
      // PDF-Info-Dictionary/XMP (Subject, Keywords) — der Renderer liest sie
      // aus extras. Nur Laufzeit-Spiegel: validateConfig kennt die Keys nicht,
      // im gespeicherten Profil landen sie also nie.
      ex.description = pub.description || '';
      ex.keywords    = pub.keywords || '';
      if (frozenPub) {
        if (frozenPub.cover) pubCoverBuf = frozenPub.cover.image;
        if (frozenPub.authorImage) pubAuthorBuf = frozenPub.authorImage.image;
      } else {
        if (pub.has_cover) { const c = getBookPublicationCover(book.id); if (c) pubCoverBuf = c.image; }
        if (pub.has_author_image) { const a = getBookPublicationAuthorImage(book.id); if (a) pubAuthorBuf = a.image; }
      }
    }

    let buffer;
    let lowResImages = 0;
    // Familien, fuer die nicht getrennt werden konnte (non-fatal, siehe
    // lib/pdf-render/fonts.js#_sharesHyphenGlyph).
    let hyphenationDisabled = [];
    let coverInInterior = false;
    let interiorPages = null;
    let renderWarnings = renderWarningsFromMeta();

    if (target === 'cover') {
      // Separates Umschlag-PDF: nur fuer das ganze Buch sinnvoll. Front =
      // buch-weites Cover (book_publication), Rueckseite render-spezifisch (Profil).
      const cs = profile.config.coverSpec || {};
      if (!(cs.pageCount > 0) || !(cs.paperBulkMmPer1000 > 0)) {
        throw i18nError('job.error.coverSpecRequired');
      }
      const frontImageBuf = pubCoverBuf;
      let backImageBuf = null;
      if (profile.has_back_cover) {
        const back = getPdfExportProfileBackCover(profileId);
        if (back) backImageBuf = back.image;
      }
      let spineImageBuf = null;
      if (profile.has_spine) {
        const spine = getPdfExportProfileSpineImage(profileId);
        if (spine) spineImageBuf = spine.image;
      }
      updateJob(jobId, { progress: 40, statusText: 'job.phase.renderCover' });
      buffer = await renderCoverBuffer({ book, profile, frontImageBuf, backImageBuf, spineImageBuf, lang: bookLang });
      log.info(`Umschlag-PDF gerendert (Ruecken=${computeSpineMm(cs).toFixed(1)} mm, ${cs.pageCount} Seiten, profile=${profile.name})`);
    } else {
      const coverBuf = (scope === 'book' && profile.config.cover.enabled) ? pubCoverBuf : null;
      const authorImageBuf = (scope === 'book') ? pubAuthorBuf : null;

      // Quellenverzeichnis + Kurzbeleg-Kontext der gerenderten Einheit. Nummern
      // im numerischen Stil folgen der Einheit: ganzes Buch → Buch-Leserichtung,
      // Kapitel-/Seiten-Scope → nur deren Fundstellen ab 1 (lib/bibliography.js).
      // Fassung: Fundstellen aus deren eingefrorenem HTML, nicht aus dem
      // source_citations-Index des heutigen Seitenstands (gleiche Regel wie der
      // synchrone Fassungs-Export in routes/snapshots.js).
      let citations = null;
      if (snapshotId) {
        try { citations = await citationsFromGroups(bundle.groups); }
        catch (e) { log.warn(`Fassungs-PDF: Fundstellen nicht lesbar (${e.message})`); }
      }
      const bibliography = await buildBibliography({
        bookId: book.id,
        pageIds: scope === 'book' ? null : pageIdsFromGroups(groups),
        citations,
        userEmail,
      });

      updateJob(jobId, { progress: 40, statusText: 'job.phase.renderPdf' });
      const meta = {};
      buffer = await renderPdfBuffer({
        book, groups, profile,
        coverBuf, authorImageBuf, lang: bookLang, region: bookRegion,
        scope, chapter, page, meta, bibliography,
        signal, sample,
      });
      renderWarnings = renderWarningsFromMeta(meta);
      lowResImages = Array.isArray(meta.dpiWarnings) ? meta.dpiWarnings.length : 0;
      interiorPages = Number.isInteger(meta.totalPages) ? meta.totalPages : null;
      if (lowResImages) log.warn(`${lowResImages} Bild(er) unter ${profile.config.print?.dpiWarnThreshold || 300} dpi (scope=${scope})`);
      hyphenationDisabled = Array.isArray(meta.hyphenationDisabled) ? meta.hyphenationDisabled : [];
      if (hyphenationDisabled.length) log.warn(`Silbentrennung deaktiviert — ${hyphenationDisabled.join(', ')} legt Soft-Hyphen und Bindestrich auf denselben Glyph (scope=${scope})`);
      // Druckfertiger Innenteil sollte kein Innen-Cover tragen — Hinweis (non-fatal).
      coverInInterior = !!(scope === 'book' && coverBuf && (profile.config.print?.bleedMm > 0));
      if (coverInInterior) log.warn(`Innenteil enthaelt Cover trotz Beschnitt — separates Umschlag-PDF empfohlen (job=${jobId})`);
    }

    checkCancelled();

    let validation = { available: false };
    if (standard === 'pdfa' && !sample) {
      updateJob(jobId, { progress: 85, statusText: 'job.phase.validatePdfa' });
      try {
        validation = await validatePdfa(buffer, { signal });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        log.warn(`PDF/A validation failed (${e.message}); ignoring`);
        validation = { available: false, reason: 'validator-error' };
      }
      if (validation.available && !validation.passed) {
        log.warn(`veraPDF flagged document as non-compliant (job=${jobId})`);
      }
    }

    // PDF/X-3-Post-Step (Druckvorstufe): Ghostscript stempelt OutputIntent + ICC.
    // RGB bleibt, keine CMYK-Separation. Non-fatal — fehlt gs/ICC, bleibt das
    // unkonvertierte PDF mit Warnung im Result.
    let pdfx = null;
    if (standard === 'pdfx' && !sample) {
      updateJob(jobId, { progress: 85, statusText: 'job.phase.convertPdfx' });
      let conv = { available: false, reason: 'convert-error' };
      try {
        conv = await convertToPdfX(buffer, { title: book.name || 'Document', signal });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        log.warn(`PDF/X conversion threw (${e.message}); ignoring`);
      }
      if (conv.available && conv.buffer) {
        buffer = conv.buffer;
        log.info(`PDF/X-3 erzeugt (OutputIntent=${conv.identifier}, job=${jobId})`);
      } else {
        log.warn(`PDF/X conversion unavailable (${conv.reason}); liefere unkonvertiertes PDF (job=${jobId})`);
      }
      pdfx = { applied: !!conv.available, reason: conv.reason || null, identifier: conv.identifier || null };
    }

    const slug = resolveSlug(bundle);
    let filename = buildExportFilename({
      prefix: target === 'cover' ? 'umschlag' : scope, slug, ext: 'pdf', date: new Date(),
    });
    if (sample) filename = filename.replace(/\.pdf$/i, '-probe.pdf');

    // Abbruch waehrend veraPDF/Ghostscript: kein Ergebnis ablegen, nicht
    // als fertig melden.
    checkCancelled();
    pdfResults.set(jobId, { buffer, mime: 'application/pdf', filename });

    const sizeKb = Math.round(buffer.length / 1024);
    const normLog = standard === 'pdfx'
      ? `pdfx=${pdfx?.applied ? 'ok' : `fallback(${pdfx?.reason})`}`
      : `pdfa=${validation.available ? (validation.passed ? 'pass' : 'fail') : 'skipped'}`;
    log.info(`PDF generiert «${filename}» (${sizeKb} KB, scope=${scope}${scopeDetail}, profile=${profile.name}, ${normLog})`);

    completeJob(jobId, {
      ready: true,
      size: buffer.length,
      mime: 'application/pdf',
      filename,
      profileName: profile.name,
      scope,
      target,
      sample: !!sample,
      coverInInterior,
      interiorPages,
      lowResImages,
      hyphenationDisabled,
      renderWarnings,
      dpiThreshold: profile.config.print?.dpiWarnThreshold || 0,
      standard,
      pdfa: {
        requested: standard === 'pdfa' && !sample,
        validatorAvailable: !!validation.available,
        passed: validation.available ? !!validation.passed : null,
        reason: validation.reason || null,
      },
      pdfx: pdfx ? {
        requested: true,
        applied: !!pdfx.applied,
        reason: pdfx.reason,
        identifier: pdfx.identifier,
      } : { requested: false, applied: false, reason: null, identifier: null },
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.message === 'job.cancelled' || signal?.aborted) {
      pdfResults.delete(jobId);
      // failJob erkennt den Abbruch am Namen (bzw. job.cancelled) — ein vom
      // Renderer als plain Error('job.cancelled') geworfener Abbruch wird
      // hier normalisiert, damit er sicher als 'cancelled' endet.
      failJob(jobId, e?.name === 'AbortError' ? e : abortError('job.cancelled'));
      return;
    }
    const empty = emptyScopeError(e);
    if (empty) { failJob(jobId, empty); return; }
    log.error(`pdf-export job ${jobId}: ${e.message}`);
    failJob(jobId, e);
  }
}

router.post('/pdf-export', jsonBody, async (req, res) => {
  const userEmail = sessionEmail(req);

  // Fassungs-Export: snapshotId gesetzt → immer ganzes Buch, Innenteil.
  const snapshotId = toIntId(req.body?.snapshot_id || req.body?.snapshotId);

  const rawTarget = snapshotId ? 'interior' : String(req.body?.target || 'interior').toLowerCase();
  const target = VALID_TARGETS.has(rawTarget) ? rawTarget : null;
  if (!target) return res.status(400).json({ error_code: 'BAD_TARGET' });

  // Umschlag-PDF gibt es nur fuer das ganze Buch; Fassungs-Export ebenso.
  const rawScope = (target === 'cover' || snapshotId) ? 'book' : String(req.body?.scope || 'book').toLowerCase();
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : null;
  if (!scope) return res.status(400).json({ error_code: 'BAD_SCOPE' });

  const entityId = toIntId(req.body?.entityId ?? req.body?.entity_id ?? req.body?.book_id ?? req.body?.bookId);
  const profileId = toIntId(req.body?.profile_id || req.body?.profileId);
  if (!entityId || !profileId) return res.status(400).json({ error_code: 'ENTITY_OR_PROFILE_REQUIRED' });
  const includeSubchapters = scope === 'chapter' && (req.body?.include_subchapters === true || req.body?.includeSubchapters === true);
  // Probeseiten nur fuer den Innenteil — ein Umschlag ist ein einziger Bogen.
  const sample = req.body?.sample === true && target === 'interior';

  // 1) Buch-ID aufloesen: scope='book' (inkl. Fassung) → entityId, sonst ueber
  //    den Content-Store. Nicht aufloesbar → 404, der Guard wird nie
  //    uebersprungen.
  let bookId = scope === 'book' ? entityId : null;
  if (scope !== 'book') {
    try {
      const row = scope === 'chapter'
        ? await contentStore.loadChapter(entityId, req)
        : await contentStore.loadPage(entityId, req);
      bookId = toIntId(row?.book_id);
    } catch (e) {
      if (e.status !== 404) return res.status(502).json({ error_code: 'CONTENT_LOAD_FAILED' });
    }
  }
  if (!bookId) return res.status(404).json({ error_code: 'NOT_FOUND' });
  setContext({ book: bookId });

  // 2) Buch-ACL vor jeder weiteren Bestandsfrage (Profil, Fassung) — sonst
  //    beantwortet der Server einem Fremden erst, ob es die Fassung gibt.
  //    PDF-Export: viewer reicht (Export gilt fuer alle Rollen).
  if (!guardBook(req, res, bookId, 'viewer')) return;

  // 3) Existenzpruefungen.
  const profile = getPdfExportProfile(profileId);
  if (!profile) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  if (profile.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  // Fassung muss existieren (entityId ist bei snapshotId immer die bookId).
  if (snapshotId && !getSnapshot(entityId, snapshotId)) {
    return res.status(404).json({ error_code: 'SNAPSHOT_NOT_FOUND' });
  }

  const dedupId = `${target}:${scope}:${entityId}:${profileId}${includeSubchapters ? ':sub' : ''}${snapshotId ? `:snap${snapshotId}` : ''}${sample ? ':sample' : ''}`;
  const existing = findActiveJobId('pdf-export', dedupId, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('pdf-export', bookId, userEmail, 'job.label.pdfExportProfile', { profile: profile.name }, dedupId);
  enqueueJob(jobId, () => runPdfExportJob(jobId, { scope, entityId, profileId, includeSubchapters, target, snapshotId, sample, userEmail }));
  res.status(202).json({ jobId, sample });
});

router.get('/pdf-export/:id/file', (req, res) => {
  const userEmail = sessionEmail(req);
  const job = jobs.get(req.params.id);
  if (!job || job.type !== 'pdf-export') return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  // Buchzugriff kann seit dem Export entzogen worden sein.
  const jobBookId = toIntId(job.bookId);
  if (jobBookId && !guardBook(req, res, jobBookId, 'viewer')) return;
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_READY', params: { status: job.status } });
  const r = pdfResults.get(req.params.id);
  if (!r) return res.status(410).json({ error_code: 'RESULT_EXPIRED' });

  res.setHeader('Content-Type', r.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Content-Length', r.buffer.length);
  res.end(r.buffer);
});

module.exports = { pdfExportRouter: router, runPdfExportJob, pdfResults, sampleGroups, renderWarningsFromMeta };
