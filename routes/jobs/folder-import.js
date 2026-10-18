'use strict';

// Folder-Import-Job. Empfaengt ein ZIP-Archiv (Struktur YYYY/Monat/Tagesdatei),
// entpackt es, erkennt Datumsformate via Regel-Heuristik (+AI-Fallback wenn
// Confidence < Threshold), parst .docx via mammoth und .odt via eigenem Mini-
// Parser, und legt Kapitel pro Jahr + Seiten pro Tag via Content-Store an.
//
// ZIP-Buffer landet beim POST in `importBuffers`-Map und wird vom Worker konsumiert.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, jobs, createJob, enqueueJob, findActiveJobId, isJobActive, throwIfCancelled,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { detectDate, detectDateInText, firstLineFromHtml, extractTitle, scoreSample, parseMonthToken } = require('../../lib/import-parsers/date-detect');
const { parseImportFile, extOf, SUPPORTED_EXTS } = require('../../lib/import-parsers/dispatch');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { resolveProvider } = require('../../lib/ai');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { getBookLocale, getBookSettings, setBookBuchtyp } = require('../../db/schema');
const { BUCHTYP_TAGEBUCH } = require('../../lib/buchtyp');
const { createOwnedBook, discardImportedBook, bookNameError, BOOK_NAME_MAX } = require('../../lib/book-create');
const { openCappedZip, ZipLimitError } = require('../../lib/zip-limits');
const { ImportBufferStore } = require('../../lib/import-buffers');
const { makeImportAudit } = require('../../lib/import-audit');
const { seedImportBaseline } = require('../../lib/import-baseline');

const router = express.Router();

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Entpackt-Deckel fuers ganze Archiv (lib/zip-limits.js). Einzeldateien
// deckelt MAX_FILE_BYTES beim Lesen (zu gross → uebersprungen); die Summe
// deckelt die CPU-/Zeitkosten eines Archivs voller grosser Dateien.
const FOLDER_ZIP_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
});
const CONFIDENCE_THRESHOLD = 0.8;
const AI_SAMPLE_SIZE = 30;
const BUFFER_TTL_MS = 30 * 60 * 1000;

// Kapitel-Gruppierung pro Import (Query-Param `grouping`): Jahr+Monat (Default),
// nur Jahr, oder flach (keine Kapitel). Unbekannte Werte fallen auf 'year-month'.
const GROUPINGS = new Set(['year-month', 'year', 'flat']);

// Monatsnamen fuer die Sub-Chapter-Benennung ("2020 November"). Sprache richtet
// sich nach der Buch-Locale (getBookLocale), nicht hartcodiert deutsch.
const MONTH_NAMES_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Monat (1–12) aus dem Namen eines bestehenden Monats-Unterkapitels, sonst null.
// Ein fuehrendes Jahr muss das des Eltern-Kapitels sein.
function _monthFromChapterName(name, parentYear) {
  const raw = String(name || '').trim();
  const m = /^(\d{4})\s+(.+)$/.exec(raw);
  if (m && Number(m[1]) !== parentYear) return null;
  return parseMonthToken(m ? m[2] : raw);
}

// jobId -> { buffer, userEmail, mode, bookName, bookId }. Deckel: lib/import-buffers.js.
const importBuffers = new ImportBufferStore({
  ttlMs: BUFFER_TTL_MS,
  maxPerUser: 1,
  maxTotalBytes: 2 * MAX_ZIP_BYTES,
  isLive: isJobActive,
});

function _parsePath(p) {
  // Erwartet: "<YYYY>/<Monat>/<Datei>". Trim Mac-Resource-Forks und Hidden-Files.
  const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/');
  if (parts.length < 3) return null;
  if (parts.some(seg => seg.startsWith('._') || seg === '.DS_Store' || seg === '__MACOSX')) return null;
  const baseFile = parts[parts.length - 1];
  if (!baseFile || baseFile.startsWith('.')) return null;
  // Erstes Element mit 4-stelliger Jahreszahl als Jahr-Ordner nehmen.
  let yearIdx = -1;
  for (let i = 0; i < parts.length - 2; i += 1) {
    if (/^\d{4}$/.test(parts[i])) { yearIdx = i; break; }
  }
  if (yearIdx < 0) return null;
  const year = parseInt(parts[yearIdx], 10);
  const monthRaw = parts[yearIdx + 1];
  const file = parts.slice(yearIdx + 2).join('/');
  return { year, monthRaw, file, fullPath: parts.slice(yearIdx).join('/') };
}

function _monthFromRaw(monthRaw) {
  return parseMonthToken(monthRaw);
}

async function runFolderImportJob(jobId, { userEmail, mode, bookName, bookId, grouping = 'year-month', zipLimits = FOLDER_ZIP_LIMITS }) {
  const log = makeJobLogger(jobId);
  // Import-Log (lib/import-audit.js): i18n-Key + Params, Result-JSON liefert
  // es ans Frontend (Collapsible "Import-Log").
  const { entries: auditLog, audit } = makeImportAudit(log);
  const skipped = [];
  const recordSkip = (path, reason) => {
    skipped.push({ path, reason });
    audit('warn', 'importLog.skipped', { path, reason });
  };
  let createdBookId = null;   // nur new-book: Rueckbau bei Abbruch/Fehler
  try {
    const entry = importBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');
    const { buffer } = entry;

    updateJob(jobId, { progress: 5, statusText: 'job.folder-import.unpacking' });
    const reader = await openCappedZip(buffer, zipLimits);
    const { zip } = reader;

    const files = [];
    zip.forEach((relativePath, file) => {
      if (file.dir) return;
      const parsed = _parsePath(relativePath);
      if (!parsed) {
        recordSkip(relativePath, 'BAD_PATH');
        return;
      }
      const ext = extOf(parsed.file);
      if (!SUPPORTED_EXTS.has(ext)) {
        recordSkip(relativePath, 'UNSUPPORTED_EXT');
        return;
      }
      files.push({ relativePath, zipEntry: file, ...parsed });
    });

    if (!files.length) {
      throw i18nError('job.error.emptyArchive');
    }
    audit('info', 'importLog.filesFound', { n: files.length, skipped: skipped.length });

    updateJob(jobId, { progress: 10, statusText: 'job.folder-import.detectingDates' });

    // Sample fuer Pattern-Scoring (erste 20 Filenames mit Path-Context)
    const samplePool = files.slice(0, 20).map(f => ({
      filename: f.file,
      year: f.year,
      month: _monthFromRaw(f.monthRaw),
    }));
    const score = scoreSample(samplePool);
    audit('info', 'importLog.dateScore', { pct: Math.round(score.confidence * 100) });

    let aiDateMap = null;
    if (score.confidence < CONFIDENCE_THRESHOLD) {
      audit('info', 'importLog.aiFallback', { pct: CONFIDENCE_THRESHOLD * 100 });
      updateJob(jobId, { progress: 15, statusText: 'job.folder-import.aiDateDetect' });
      try {
        const aiSamples = files.slice(0, AI_SAMPLE_SIZE).map(f => ({
          path: f.fullPath,
          year: f.year,
          month: _monthFromRaw(f.monthRaw),
        }));
        const prompts = await getPrompts(userEmail);
        const { buildDateDetectPrompt, SCHEMA_DATE_DETECT } = prompts;
        const SYSTEM = 'Du bist ein Assistent fuer das Erkennen von Datumsformaten in Dateinamen. Antworte ausschliesslich mit einem JSON-Objekt.';
        const tok = { in: 0, out: 0, ms: 0 };
        const result = await aiCall(
          jobId, tok,
          buildDateDetectPrompt(aiSamples),
          SYSTEM,
          15, 25, 2000, 0.2, 4000, undefined, SCHEMA_DATE_DETECT,
        );
        if (Array.isArray(result?.dateien)) {
          aiDateMap = new Map();
          for (const d of result.dateien) {
            if (d && typeof d.path === 'string' && typeof d.iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.iso)) {
              aiDateMap.set(d.path, d.iso);
            }
          }
          audit('info', 'importLog.aiResolved', { n: aiDateMap.size, total: aiSamples.length });
        }
      } catch (e) {
        log.warn(`AI date-detect failed: ${e.message}`);
        audit('warn', 'importLog.aiFailed');
      }
    }

    // Pro Datei: Datum aus Filename → erste Zeile (nach Parse) → AI-Map.
    // Parse passiert HIER (nicht spaeter), damit Fallback-Quelle "erste
    // Dokumentzeile" verfuegbar ist. HTML + Warnings werden mit-gespeichert,
    // damit createPage spaeter nicht erneut parst.
    updateJob(jobId, { progress: 25, statusText: 'job.folder-import.parsing', statusParams: { file: '', current: 0, total: files.length } });
    const enriched = [];
    const warningsCollected = [];
    let parseCount = 0;
    for (const f of files) {
      throwIfCancelled(jobId);
      parseCount += 1;
      const month = _monthFromRaw(f.monthRaw);
      const ctx = { year: f.year, month };
      let isoDate = null;
      let dateSource = null;

      const ruleResult = detectDate(f.file, ctx);
      if (ruleResult) { isoDate = ruleResult.iso; dateSource = 'filename'; }

      // Datei jetzt parsen — entweder fuer Date-Fallback oder fuer
      // spaeteren Page-Insert.
      // Gedeckelt WAEHREND des Entpackens: eine zu grosse Datei wird
      // uebersprungen, bevor sie ganz im Speicher liegt. Reisst das Archiv
      // den Gesamtdeckel, bricht der Job ab.
      let buf;
      try {
        buf = await reader.read(f.zipEntry, 'nodebuffer', { maxBytes: MAX_FILE_BYTES });
      } catch (e) {
        if (e instanceof ZipLimitError && e.reason === 'total') throw e;
        recordSkip(f.relativePath, e instanceof ZipLimitError ? 'FILE_TOO_LARGE' : 'ZIP_READ_FAILED');
        continue;
      }
      let parsed;
      try {
        parsed = await parseImportFile(f.file, buf);
      } catch (e) {
        log.warn(`Parse fail ${f.relativePath}: ${e.message}`);
        recordSkip(f.relativePath, e instanceof ZipLimitError ? 'FILE_TOO_LARGE' : 'PARSE_FAILED');
        continue;
      }
      if (!parsed) {
        recordSkip(f.relativePath, 'UNSUPPORTED_EXT');
        continue;
      }

      // Fallback: erste Text-Zeile pruefen
      if (!isoDate) {
        const firstLine = firstLineFromHtml(parsed.html);
        const textResult = detectDateInText(firstLine, ctx);
        if (textResult) { isoDate = textResult.iso; dateSource = 'first-line'; }
      }

      // Fallback: AI-Map
      if (!isoDate && aiDateMap) {
        const aiIso = aiDateMap.get(f.fullPath);
        if (aiIso) { isoDate = aiIso; dateSource = 'ai'; }
      }

      // Fallback: ZIP-Entry-Modified-Date (mtime). Pfad-Jahr ist immer fuehrend
      // (User-Organisations-Intent schlaegt Filesystem-Metadaten); mtime liefert
      // nur Monat/Tag. Sanity-Cap: mtYear >= 1990 (filtert JSZip-Default
      // 1980-01-01 fuer unset mtimes).
      //   - Pfad-Monat bekannt: strict — mtYear muss f.year matchen (sonst ist
      //     mtime ein Repack-Artefakt). Pfad-Monat gewinnt, Tag aus mtime.
      //   - Pfad-Monat fehlt: relaxed — Year-Match-Constraint fallen lassen,
      //     mtime liefert Monat+Tag. Synthetisches YYYY-06-15 (year-only) waere
      //     sonst die einzige Alternative und gibt null Info ueber den Monat.
      if (!isoDate && f.zipEntry?.date instanceof Date && !isNaN(f.zipEntry.date)) {
        const mt = f.zipEntry.date;
        const mtYear = mt.getUTCFullYear();
        if (mtYear >= 1990) {
          const mtMonth = mt.getUTCMonth() + 1;
          const mtDay = mt.getUTCDate();
          if (Number.isFinite(month)) {
            if (mtYear === f.year) {
              isoDate = `${f.year}-${String(month).padStart(2, '0')}-${String(mtDay).padStart(2, '0')}`;
              dateSource = 'mtime';
            }
          } else {
            isoDate = `${f.year}-${String(mtMonth).padStart(2, '0')}-${String(mtDay).padStart(2, '0')}`;
            dateSource = 'mtime';
          }
        }
      }

      // Letzter Fallback: nur Jahr+Monat aus Pfad ableitbar → synthetisches
      // Datum YYYY-MM-15 (Mitte des Monats fuer Sortierung). Page-Name behaelt
      // den Filename, damit der User sieht, dass kein echtes Datum vorlag.
      if (!isoDate && Number.isFinite(month)) {
        isoDate = `${f.year}-${String(month).padStart(2, '0')}-15`;
        dateSource = 'month-only';
      }

      // Allerletzter Fallback: nur Jahr ableitbar → synthetisches Mid-Year-
      // Datum YYYY-06-15 (sortierbar, Page-Name nutzt YYYY + Thema, damit
      // User sieht dass kein echter Tag vorlag).
      if (!isoDate && Number.isFinite(f.year)) {
        isoDate = `${f.year}-06-15`;
        dateSource = 'year-only';
      }

      if (!isoDate) {
        recordSkip(f.relativePath, 'NO_DATE');
        continue;
      }

      if (parsed.warnings?.length) {
        warningsCollected.push({ path: f.relativePath, items: parsed.warnings });
      }
      enriched.push({ ...f, isoDate, dateSource, html: parsed.html, month });
    }

    if (!enriched.length) {
      throw i18nError('job.error.noDatesFound');
    }

    const bySource = (src) => enriched.filter(e => e.dateSource === src).length;
    audit('info', 'importLog.dateSources', {
      filename: bySource('filename'), firstLine: bySource('first-line'), ai: bySource('ai'),
      mtime: bySource('mtime'), monthOnly: bySource('month-only'), yearOnly: bySource('year-only'),
    });

    // Sortieren chronologisch
    enriched.sort((a, b) => a.isoDate.localeCompare(b.isoDate));

    // Kollisions-Resolve fuer echte Datums-Quellen: zwei Files auf gleichen Tag
    // wuerden sonst beide den nackten ISO-Namen tragen (mit "(2)"-Suffix). Wir
    // versuchen: (A) Thema aus jedem File extrahieren und `YYYY-MM-DD <Thema>`
    // setzen. (B) wo kein Thema ableitbar ist, HTML in den ersten Tageseintrag
    // mergen — Tagebuch-Semantik: ein Tag = ein Eintrag, kein Datenverlust.
    const REAL_DATE_SOURCES = new Set(['filename', 'first-line', 'ai', 'mtime']);
    const mergedAway = new Set();
    const byDate = new Map();
    for (const f of enriched) {
      if (!REAL_DATE_SOURCES.has(f.dateSource)) continue;
      if (!byDate.has(f.isoDate)) byDate.set(f.isoDate, []);
      byDate.get(f.isoDate).push(f);
    }
    for (const [iso, group] of byDate) {
      if (group.length < 2) continue;
      const annotated = group.map(f => ({ f, thema: extractTitle(f.html, f.file) }));
      const themaful = annotated.filter(x => x.thema);
      const themaless = annotated.filter(x => !x.thema);
      if (themaless.length === group.length) {
        // Alle ohne Thema → in ersten Eintrag mergen
        const [first, ...rest] = group;
        const parts = [first.html, ...rest.map(r => r.html)];
        first.html = parts.join('\n<hr class="day-merge">\n');
        for (const r of rest) mergedAway.add(r);
        audit('info', 'importLog.dayMerged', { date: iso, n: rest.length + 1 });
      } else if (themaless.length === 0) {
        // Alle mit Thema → jeden umbenennen
        for (const { f, thema } of annotated) f._resolvedName = `${iso} ${thema}`;
      } else {
        // Mixed: themaful umbenennen, themaless ins erste themaful-Target mergen
        const target = themaful[0].f;
        for (const { f, thema } of themaful) f._resolvedName = `${iso} ${thema}`;
        for (const { f } of themaless) {
          target.html = `${target.html}\n<hr class="day-merge">\n${f.html}`;
          mergedAway.add(f);
        }
        audit('info', 'importLog.dayMergedInto', { date: iso, n: themaless.length, name: target._resolvedName });
      }
    }
    const resolved = enriched.filter(f => !mergedAway.has(f));

    // Buch sicherstellen
    let effBookId = bookId;
    if (mode === 'new-book') {
      updateJob(jobId, { progress: 28, statusText: 'job.folder-import.creatingBook' });
      const created = await createOwnedBook({ name: bookName }, userEmail, { session: { user: { email: userEmail } } });
      effBookId = created.id;
      createdBookId = created.id;
      audit('info', 'importLog.bookCreated', { name: bookName });
    }
    if (!effBookId) throw i18nError('job.error.bookMissing');
    setContext({ book: effBookId });
    // Ohne Buchtyp fehlen Kalender, Eintrag-Navigation und Rückblick. Ein neues
    // Buch wird darum zum Tagebuch; ein bestehendes nur, wenn es noch keinen Typ
    // hat — ein bewusst gewählter Typ (z.B. Memoiren) bleibt stehen.
    if (mode === 'new-book' || !getBookSettings(effBookId, userEmail).buchtyp) {
      setBookBuchtyp(effBookId, BUCHTYP_TAGEBUCH, userEmail);
    }

    // Kapitel-Cache: pro Jahr ein Top-Level-Chapter, pro Jahr+Monat ein
    // Sub-Chapter (parent_chapter_id = Jahr-Chapter-ID).
    const chapterByYear = new Map();        // year (Number) -> chapter_id
    const chapterByYearMonth = new Map();   // "YYYY-MM" -> chapter_id
    // Buch-Locale steuert die Monatsnamen der Sub-Chapter. Fuer neue Buecher
    // greift getBookSettings auf die default_language des Users zurueck.
    const MONTH_NAMES = getBookLocale(effBookId, userEmail).startsWith('en') ? MONTH_NAMES_EN : MONTH_NAMES_DE;
    if (mode === 'merge' && grouping !== 'flat') {
      const existing = await contentStore.listChapters(effBookId, { session: { user: { email: userEmail } } });
      // Erst Top-Level (Jahre) cachen, dann Sub-Chapter (Monate) den Parents zuordnen.
      for (const ch of existing) {
        if (ch.parent_chapter_id) continue;
        const y = parseInt(ch.name, 10);
        if (Number.isFinite(y) && /^\d{4}$/.test(String(ch.name).trim())) {
          chapterByYear.set(y, ch.id);
        }
      }
      for (const ch of existing) {
        if (!ch.parent_chapter_id) continue;
        // Jahr ueber das Eltern-Kapitel, Monat ueber den NAMEN ("2020 März",
        // "2020 March", auch nur "März"). Nicht ueber chapters.position: die
        // materialisiert book_order buchweit depth-first, 1–12 ist dort kein Monat.
        const parentYear = [...chapterByYear.entries()].find(([, id]) => id === ch.parent_chapter_id)?.[0];
        if (!Number.isFinite(parentYear)) continue;
        const monthNum = _monthFromChapterName(ch.name, parentYear);
        if (!monthNum) continue;
        const key = `${parentYear}-${String(monthNum).padStart(2, '0')}`;
        if (!chapterByYearMonth.has(key)) chapterByYearMonth.set(key, ch.id);
      }
    }

    // Pages anlegen (HTML stammt aus Enrichment-Pass)
    const total = resolved.length;
    let current = 0;
    const dateSeen = new Map(); // iso -> count (fuer Duplikat-Suffix)
    let pagesCreated = 0;

    for (const f of resolved) {
      throwIfCancelled(jobId);
      current += 1;
      const progress = 30 + Math.round(65 * (current / total));
      updateJob(jobId, {
        progress,
        statusText: 'job.folder-import.creating',
        statusParams: { file: f.relativePath, current, total },
      });

      // Kapitel-Zuordnung je nach Gruppierungs-Modus:
      //   'flat'       → keine Kapitel, Seite haengt direkt am Buch (chapter_id null)
      //   'year'       → nur Jahr-Top-Level-Chapter
      //   'year-month' → Jahr-Chapter + Monats-Sub-Chapter (Default)
      let chapterId = null;
      if (grouping !== 'flat') {
        // Year-Chapter (Top-Level) sicherstellen
        let yearChapterId = chapterByYear.get(f.year);
        if (!yearChapterId) {
          const ch = await contentStore.createChapter(
            { book_id: effBookId, name: String(f.year), position: f.year },
            { session: { user: { email: userEmail } } },
          );
          yearChapterId = ch.id;
          chapterByYear.set(f.year, yearChapterId);
          audit('info', 'importLog.yearChapter', { year: f.year });
        }
        chapterId = yearChapterId;

        // Month-Sub-Chapter nur im 'year-month'-Modus (parent = year-chapter).
        // Wenn Monat unbekannt (year-only-Fallback), bleibt die Seite am
        // Year-Chapter. Name-Format: "YYYY Monatsname" (z.B. "2020 November").
        const isoMonth = f.isoDate.slice(5, 7);
        const monthNum = parseInt(isoMonth, 10);
        if (grouping === 'year-month' && Number.isFinite(monthNum) && monthNum >= 1 && monthNum <= 12 && f.dateSource !== 'year-only') {
          const ymKey = `${f.year}-${isoMonth}`;
          let subId = chapterByYearMonth.get(ymKey);
          if (!subId) {
            const subName = `${f.year} ${MONTH_NAMES[monthNum - 1]}`;
            const sub = await contentStore.createChapter(
              { book_id: effBookId, name: subName, parent_chapter_id: yearChapterId, position: monthNum },
              { session: { user: { email: userEmail } } },
            );
            subId = sub.id;
            chapterByYearMonth.set(ymKey, subId);
            audit('info', 'importLog.monthChapter', { name: subName });
          }
          chapterId = subId;
        }
      }

      // Page-Name: ISO-Date bei echtem Datum, sonst "YYYY-MM <Thema>" fuer
      // month-only-Eintraege. Thema wird via extractTitle aus Heading/
      // Filename/erster Zeile geholt (siehe lib/import-parsers/date-detect).
      // _resolvedName setzt der Kollisions-Resolve oben fuer echte Datums-
      // Quellen mit Kollision (z.B. "2024-03-05 Persoenliches").
      let pageName;
      if (f._resolvedName) {
        pageName = f._resolvedName;
      } else if (f.dateSource === 'month-only') {
        const ym = f.isoDate.slice(0, 7);
        const thema = extractTitle(f.html, f.file);
        pageName = thema ? `${ym} ${thema}` : ym;
      } else if (f.dateSource === 'year-only') {
        const thema = extractTitle(f.html, f.file);
        pageName = thema ? `${f.year} ${thema}` : String(f.year);
      } else {
        pageName = f.isoDate;
      }
      // Duplikat-Suffix auf pageName (nicht mehr auf isoDate, damit
      // month-only-Eintraege mit unterschiedlichen Filenames eigenstaendig sind)
      const seenCount = dateSeen.get(pageName) || 0;
      dateSeen.set(pageName, seenCount + 1);
      if (seenCount > 0) pageName = `${pageName} (${seenCount + 1})`;

      try {
        await contentStore.createPage(
          {
            book_id: effBookId,
            chapter_id: chapterId,
            name: pageName,
            html: f.html,
          },
          { session: { user: { email: userEmail } } },
        );
        pagesCreated += 1;
      } catch (e) {
        log.warn(`createPage fail ${f.relativePath}: ${e.message}`);
        recordSkip(f.relativePath, 'CREATE_FAILED');
      }
    }

    // Jahres-/Monatskapitel chronologisch: ein Merge, der ein frueheres Jahr
    // oder einen frueheren Monat nachliefert, haengte sie sonst ans Ende.
    if (grouping !== 'flat') {
      const keyById = new Map();
      for (const [y, id] of chapterByYear) keyById.set(id, y);
      for (const [ym, id] of chapterByYearMonth) keyById.set(id, parseInt(ym.slice(5, 7), 10));
      try { contentStore.sortChapterSlots(effBookId, keyById); }
      catch (e) { log.warn(`Kapitel-Sortierung fehlgeschlagen: ${e.message}`); }
    }
    createdBookId = null;   // Buch steht vollstaendig — kein Rueckbau mehr

    audit('info', 'importLog.doneFolder', {
      pages: pagesCreated, years: chapterByYear.size, months: chapterByYearMonth.size, skipped: skipped.length,
    });

    if (pagesCreated > 0) {
      await seedImportBaseline(effBookId, userEmail,
        log, 'Ordner-Import');
    }

    completeJob(jobId, {
      bookId: effBookId,
      pagesCreated,
      chaptersCreated: chapterByYear.size + chapterByYearMonth.size,
      yearChaptersCreated: chapterByYear.size,
      monthSubChaptersCreated: chapterByYearMonth.size,
      skipped,
      warnings: warningsCollected,
      auditLog,
    });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`folder-import job ${jobId}: ${e.message}`, { stack: e.stack });
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

router.post('/folder-import', rawZipBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const mode = (req.query?.mode === 'merge') ? 'merge' : 'new-book';
  const bookName = String(req.query?.book_name || '').trim();
  const bookId = mode === 'merge' ? toIntId(req.query?.book_id) : null;
  const grouping = GROUPINGS.has(req.query?.grouping) ? req.query.grouping : 'year-month';

  if (mode === 'new-book' && !bookName) {
    return res.status(400).json({ error_code: 'BOOK_NAME_REQUIRED' });
  }
  if (mode === 'new-book' && bookNameError(bookName)) {
    return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: BOOK_NAME_MAX } });
  }
  if (mode === 'merge' && !bookId) {
    return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  }

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (req.body.length > MAX_ZIP_BYTES) {
    return res.status(413).json({ error_code: 'ZIP_TOO_LARGE' });
  }

  if (mode === 'merge') {
    if (!guardBook(req, res, bookId, 'editor')) return;
  }

  const dedupKey = mode === 'merge' ? `merge:${bookId}` : `new:${bookName}`;
  const existing = findActiveJobId('folder-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const admission = importBuffers.admissionError(userEmail, req.body.length);
  if (admission) return res.status(429).json({ error_code: admission });

  const jobId = createJob(
    'folder-import',
    bookId || 0,
    userEmail,
    'job.label.folderImportBook',
    { name: bookName || `Book #${bookId}` },
    dedupKey,
  );
  importBuffers.put(jobId, { buffer: req.body, userEmail, mode, bookName, bookId });

  enqueueJob(jobId, () => runFolderImportJob(jobId, { userEmail, mode, bookName, bookId, grouping }));
  res.status(202).json({ jobId });
});

module.exports = { folderImportRouter: router, runFolderImportJob, importBuffers, FOLDER_ZIP_LIMITS };
