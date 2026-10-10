'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  getBookSettings,
  loadChapterMacroReviewCache, saveChapterMacroReviewCache,
  insertChapterReview,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  jobAbortControllers,
  htmlToText, splitGroupsIntoChunks, loadOrderedBookContents,
  _modelName, applyReviewAiOverrides, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody, BATCH_SIZE, chunkLimitsFor,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { narrativeLabels } = require('./narrative-labels');
const { loadChapterReviewKomplettContext, loadStrukturContext, loadChapterPlanContext, loadChapterIdeenContext, werkstandFor } = require('./review-context');
const { applyQuoteVerification, belegHaystack } = require('../../lib/quote-verify');
const { toIntId } = require('../../lib/validate');
const appSettings = require('../../lib/app-settings');
const { resolveProvider } = require('../../lib/ai');
const { getDescendantChapterIds } = require('../../db/book-order');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { setContext } = require('../../lib/log-context');

function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

// Revision des Job-Aufbaus in der Cache-Signatur. Der Wortlaut der Prompt-
// Builder fliesst nicht in PROMPTS_VERSION (nur Schemas + Locale-Snapshot) —
// ändert sich Prompt-Aufbau oder Ergebnis-Form, hier hochzählen.
const CACHE_REV = 2;

const kapitelRouter = express.Router();

// ── Job: Kapitel-Review (Makrobewertung eines einzelnen Kapitels) ────────────
// Folgt in `laterPages` (Buchreihenfolge) noch Text? Lädt der Reihe nach und
// hört beim ersten Abschnitt mit Text auf — im Normalfall ein einziger Load.
// Leere Hüllen werden übersprungen. Mindestlänge wie die Buchbewertung
// (loadPageContents, 50 Zeichen). Nach SCAN_MAX leeren Abschnitten ohne Befund:
// null (unbekannt) — dann wird nichts behauptet.
const FRONT_MIN_CHARS = 50;
const FRONT_SCAN_MAX = 40;
async function _textFollows(laterPages, signal) {
  for (const p of laterPages.slice(0, FRONT_SCAN_MAX)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const pd = await contentStore.loadPage(p.id).catch(e => { throw contentHttpError(e); });
    if (htmlToText(pd.html).trim().length >= FRONT_MIN_CHARS) return true;
  }
  return laterPages.length > FRONT_SCAN_MAX ? null : false;
}

async function runChapterReviewJob(jobId, bookId, chapterId, chapterName, bookName, userEmail, { includeSubchapters = false } = {}) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const {
    buildChapterReviewPrompt, buildChapterReviewMultiPassPrompt,
    buildChapterAnalysisPrompt,
    buildChapterReviewSchema, buildChapterAnalysisSchema, reviewProfil,
    getBuchtypReviewSchwerpunkt,
    PROMPTS_VERSION,
  } = prompts;
  const { SYSTEM_KAPITELREVIEW_BLOCKS: SYSTEM_KAPITELREVIEW, SYSTEM_KAPITELANALYSE_BLOCKS: SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  const narrative = narrativeLabels(bookSettings);
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const reviewSchwerpunkt = getBuchtypReviewSchwerpunkt(locale, bookSettings?.buchtyp || null);
  // Achsen-Set, Notenanker und Schema hängen am Bewertungsprofil des Buchtyps.
  const buchtyp = narrative.buchtyp || null;
  const profil = reviewProfil(buchtyp);
  const SCHEMA_CHAPTER_REVIEW = buildChapterReviewSchema({ buchtyp });
  const SCHEMA_CHAPTER_ANALYSIS = buildChapterAnalysisSchema({ buchtyp });

  const bookIdInt = parseInt(bookId);
  const chapterIdInt = parseInt(chapterId);
  const email = userEmail || '';
  const effectiveProvider = resolveProvider({ userEmail });
  const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(effectiveProvider);
  const effortSuffix = applyReviewAiOverrides(effectiveProvider, logger);
  const cacheVersion = `${_modelName(effectiveProvider)}${effortSuffix}:${PROMPTS_VERSION || ''}`;
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    // Bei includeSubchapters: rekursiv alle Sub-Kapitel-IDs ermitteln und
    // Seiten aller Tiefen einbeziehen. Sonst nur direkte Kapitel-Seiten.
    const chapterIds = includeSubchapters
      ? new Set(getDescendantChapterIds(chapterIdInt, { includeSelf: true }).map(String))
      : new Set([String(chapterIdInt)]);
    // Tree-Walk liefert Pages in echter Buchorganizer-Reihenfolge (depth-first)
    // mit Sub-Kapitel-Pfad in chMap. Filter behält Tree-Order.
    // includeExcluded: ausgeschlossene Kapitel sind direkt in der Kapitel-
    // bewertung bewertbar (anders als Buch-/Komplettanalyse) — der Filter unten
    // beschränkt ohnehin auf die angeforderten chapterIds.
    const { chMap, chaptersFlat, pages: allPages } = await loadOrderedBookContents(bookId, { includeExcluded: true })
      .catch(e => { throw contentHttpError(e); });
    const pages = allPages.filter(p => chapterIds.has(String(p.chapter_id || '')));

    if (!pages.length) { completeJob(jobId, { empty: true, chapterName }); return; }
    logger.info(`Start: «${chapterName}» chap=${chapterId}${includeSubchapters ? ' (+Sub-Kapitel)' : ''}, ${pages.length} Seiten`);

    // Kapitelname aus dem Tree-Pfad (letztes Segment) – für Kontext-Scoping
    // (Kontinuität/Zeitstrahl filtern über Namen) und Nachbar-Anzeige.
    const _nameOf = (cid) => {
      const pth = chMap[cid] || chMap[Number(cid)] || '';
      return pth ? pth.split(' › ').pop() : '';
    };
    const chapterNames = [...new Set([...chapterIds].map(_nameOf).concat(chapterName).filter(Boolean))];

    // Buchwahrheit (Figuren/Beziehungen/Kontinuität/Zeitstrahl) auf die bewerteten
    // Kapitel gescopt: schärft die Achsen `figuren` und `kohaerenz` gegen die
    // Kartei, statt das Kapitel isoliert zu beurteilen.
    const komplettContext = loadChapterReviewKomplettContext(bookIdInt, email, {
      chapterIds: [...chapterIds], chapterNames,
    });

    // Ist-Befunde des Struktur-Checks, auf die Seiten dieses Kapitels gescopt
    // (nur journalistische Bücher; sonst null). Anders als in der Buchbewertung
    // wird hier jeder auffällige Beitrag einzeln gelistet — auf Kapitelebene ist
    // das die brauchbare Auflösung, und die Menge bleibt klein.
    const strukturContext = loadStrukturContext(bookIdInt, pages, { scope: 'chapter' });
    if (strukturContext) {
      logger.info(`Struktur-Befunde: ${strukturContext.geprueft}/${strukturContext.gesamt} Beiträge im Kapitel geprüft – fliessen in die Bewertung ein.`);
    }

    // Geplante Handlung (Plot-Werkstatt): Beats, die auf diese Kapitel zielen —
    // Autor-Absicht, gegen die die Dramaturgie-Achse das Kapitel lesen kann.
    // null ohne Plot-Planung für dieses Kapitel (Block entfällt).
    const planContext = loadChapterPlanContext(bookIdInt, email, [...chapterIds]);
    if (planContext) {
      logger.info(`Plot-Planung: ${planContext.gesamt} Beat(s) zielen auf das Kapitel – fliessen in die Bewertung ein.`);
    }

    // Offene Pendenzen des Autors an diesen Kapiteln (Ideen, user-privat): die
    // Bewertung soll Bekanntes nicht als neue Empfehlung wiederholen.
    const ideenContext = loadChapterIdeenContext(bookIdInt, email, [...chapterIds]);

    // Position in der Lesereihenfolge: erlaubt dem Modell, Dramaturgie/Pacing
    // relativ zur Funktion des Kapitels im Buch zu bewerten statt absolut.
    // Gezählt wird wie die Positions-Kachel der Karte (kdPosition): alle
    // Kapitel des Baums depth-first, Sub-Kapitel und leere eingeschlossen —
    // sonst lesen Modell und User zwei verschiedene „Kapitel X von Y".
    // Die Sub-Kapitel eines Kapitels stehen depth-first direkt dahinter; der
    // Nachfolger ist bei includeSubchapters das erste Kapitel hinter dem Teilbaum.
    const flatIdx = chaptersFlat.findIndex(c => String(c.id) === String(chapterIdInt));
    let position = null;
    if (flatIdx >= 0) {
      let nextIdx = flatIdx + 1;
      while (nextIdx < chaptersFlat.length && chapterIds.has(String(chaptersFlat[nextIdx].id))) nextIdx++;
      position = {
        index: flatIdx + 1,
        total: chaptersFlat.length,
        prevName: flatIdx > 0 ? chaptersFlat[flatIdx - 1].name : '',
        nextName: nextIdx < chaptersFlat.length ? chaptersFlat[nextIdx].name : '',
      };
    }
    // Werkstand: im unfertigen Buch ist das Kapitel, hinter dem kein Text mehr
    // folgt, die Schreibfront, kein Schlusskapitel. Ohne Zeichenzahl — siehe
    // werkstandFor. Die Folgekapitel sind dann angelegte, leere Hüllen.
    const werkstand = werkstandFor(bookSettings);
    if (werkstand && position) {
      const lastIdx = allPages.reduce((m, p, i) => (chapterIds.has(String(p.chapter_id || '')) ? i : m), -1);
      const follows = await _textFollows(allPages.slice(lastIdx + 1), jobAbortControllers.get(jobId)?.signal);
      if (follows === false) {
        const rest = chaptersFlat.slice(flatIdx + 1).filter(c => !chapterIds.has(String(c.id)));
        position.front = true;
        position.nextName = '';
        if (rest.length) position.ungeschrieben = { namen: rest.slice(0, 8).map(c => c.name), gesamt: rest.length };
      } else if (follows === true) {
        position.front = false;
      }
    }

    // Stilprofil fliesst in SYSTEM_KAPITELREVIEW (Referenz-Framing) → Cache-Bust bei Profil-Änderung.
    // Komplettanalyse-Kontext + Position ebenfalls in die Sig, damit ein neuer
    // Kartei-/Kontinuitätsstand bzw. eine Umgruppierung den Cache invalidiert.
    const optionsSig = _sigHash({
      rev: CACHE_REV, narrative, schwerpunkt: reviewSchwerpunkt, includeSubchapters,
      stilprofil: bookSettings?.stilprofil || '', komplettContext, position, strukturContext,
      // Nur wenn in Arbeit: abgeschlossene Bücher behalten ihre Signatur.
      ...(werkstand ? { werkstand } : {}),
      // Nur wenn vorhanden: ohne Plot-Planung bleibt die Signatur wortgleich, und
      // bestehende Cache-Einträge dieser Kapitel treffen weiter.
      ...(planContext ? { planContext } : {}),
      ...(ideenContext ? { ideenContext } : {}),
    });

    // pages_sig: jede Seite + ihr updated_at + Sub-Tree-Kapitelmenge inkl. deren
    // Pfade. Ändert sich eine Seite, ein Sub-Kapitel-Name/Pfad oder der Modus →
    // Cache-Miss. Sub-Pfad-Hash, damit Sub-Kapitel-Rename den Prompt-Text
    // invalidiert (sonst landet umbenanntes Sub-Kapitel im stale Cache-Result).
    const chaptersSig = [...chapterIds].sort().map(id => `${id}:${chMap[id] || ''}`).join(',');
    const pagesSig = pages.map(p => `${p.id}:${p.updated_at || ''}`).sort().join('|')
                     + `||${chapterName}||${bookName}||${optionsSig}||${chaptersSig}||${cacheVersion}`;
    const cached = loadChapterMacroReviewCache(bookIdInt, email, chapterIdInt, pagesSig, effectiveProvider);
    if (cached) {
      logger.info(`«${chapterName}» – Cache-HIT (pages_sig match) – spart Kapitel-Review-Call.`);
      updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
      // Unverändertes Kapitel → identisches Ergebnis: keinen Doppel-Eintrag in
      // den auf zehn Läufe gedeckelten Verlauf schreiben.
      insertChapterReview({
        bookId: bookIdInt, chapterId: chapterIdInt, review: cached,
        model: _modelName(effectiveProvider), userEmail,
      }, { skipIfSameAsLatest: true });
      completeJob(jobId, {
        review: cached,
        chapterId: chapterIdInt,
        chapterName,
        // Seitenzahl aus dem Ergebnis (nur Seiten mit Text) — dieselbe Zahl wie
        // im frischen Lauf, nicht die Rohzahl inkl. leerer Seiten.
        pageCount: cached.pageCount ?? pages.length,
        tokensIn: 0,
        tokensOut: 0,
        cached: true,
      }, null, `«${chapterName}» Cache-HIT, Note ${cached.gesamtnote}`);
      return;
    }

    const tok = { in: 0, out: 0, ms: 0 };
    const signal = jobAbortControllers.get(jobId)?.signal;
    const contents = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      updateJob(jobId, {
        progress: Math.round((i / pages.length) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, pages.length), total: pages.length },
      });
      // Eine Seite, die nicht lädt, bricht den Lauf ab: die Bewertung eines
      // lückenhaften Kapitels landete sonst unter der Signatur des vollständigen
      // im Cache und käme bei jedem Folgelauf wieder. Promise.all erhält die
      // Reihenfolge des Batches.
      const batch = pages.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async p => {
        const pd = await contentStore.loadPage(p.id).catch(e => { throw contentHttpError(e); });
        const text = htmlToText(pd.html).trim();
        if (!text) return null;
        return { title: p.name, text, chapterId: p.chapter_id || null };
      }));
      for (const v of results) if (v) contents.push(v);
    }

    if (!contents.length) { completeJob(jobId, { empty: true, chapterName }); return; }

    const totalChars = contents.reduce((s, p) => s + p.text.length, 0);
    // Bei includeSubchapters: Sub-Kapitel-Header zwischen Seiten verschiedener
    // chapter_ids einstreuen. Pfad relativ zum Top-Kapitel — Top-Pfad wegkürzen,
    // damit AI nicht den eh schon im Prompt benannten Kapitelnamen doppelt sieht.
    const topPath = chMap[chapterIdInt] || chapterName || '';
    function _relPath(chId) {
      const full = chMap[chId] || '';
      if (!full || full === topPath) return '';
      if (topPath && full.startsWith(topPath + ' › ')) return full.slice(topPath.length + 3);
      return full;
    }
    function _buildText(items) {
      const out = [];
      let lastChId = null;
      for (const p of items) {
        if (includeSubchapters && p.chapterId !== lastChId) {
          const rel = _relPath(p.chapterId);
          if (rel) out.push(`## ${rel}`);
          lastChId = p.chapterId;
        }
        out.push(`### ${p.title}\n${p.text}`);
      }
      return out.join('\n\n---\n\n');
    }
    let r;
    // Grundlage der Note: Volltext des Kapitels oder verdichtete Teil-Analysen.
    let basis;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      const chText = _buildText(contents);
      updateJob(jobId, { progress: 65, statusText: 'job.phase.aiChapterReview' });
      r = await aiCall(jobId, tok,
        buildChapterReviewPrompt(chapterName, bookName, contents.length, chText, { ...narrative, reviewSchwerpunkt, komplettContext, position, werkstand, strukturContext, planContext, ideenContext }),
        SYSTEM_KAPITELREVIEW,
        65, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
      );
      const droppedQ = applyQuoteVerification(r, chText);
      if (droppedQ) logger.warn(`${droppedQ} Belegzitat(e) nicht im Kapiteltext gefunden – verworfen.`);
      basis = 'single';
    } else {
      // Kapitel sprengt Input-Budget → in Sub-Chunks zerlegen, je Analyse, dann synthetisieren.
      const groupKey = String(chapterId);
      const baseGroups = new Map([[groupKey, { name: chapterName, pages: contents }]]);
      const { chunkOrder, chunks } = splitGroupsIntoChunks(baseGroups, [groupKey], PER_CHUNK_LIMIT);
      logger.info(`Multi-Pass: ${chunkOrder.length} Teilabschnitte (${totalChars} chars > ${SINGLE_PASS_LIMIT})`);

      const subAnalyses = [];
      for (let i = 0; i < chunkOrder.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = chunks.get(chunkOrder[i]);
        const fromPct = 65 + Math.round((i / chunkOrder.length) * 25);
        const toPct   = 65 + Math.round(((i + 1) / chunkOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: 'job.phase.analyzing',
          statusParams: { current: i + 1, total: chunkOrder.length, name: chapterName },
        });
        const chunkText = _buildText(chunk.pages);
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(chapterName, bookName, chunk.pages.length, chunkText, {
            ...narrative, teil: chunkOrder.length > 1 ? { nr: i + 1, von: chunkOrder.length } : null,
          }),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null, undefined, SCHEMA_CHAPTER_ANALYSIS,
        );
        // Vor der Synthese verifizieren: die Belegzitate der Teil-Analysen sind
        // ab hier die einzige Zitatquelle der Kapitelbewertung.
        const droppedQ = applyQuoteVerification(ca, chunkText, 'zitate');
        if (droppedQ) logger.warn(`Abschnitt ${i + 1}: ${droppedQ} Belegzitat(e) nicht im Text gefunden – verworfen.`);
        subAnalyses.push({ pageCount: chunk.pages.length, ...ca });
      }

      updateJob(jobId, { progress: 90, statusText: 'job.phase.finalReview' });
      r = await aiCall(jobId, tok,
        buildChapterReviewMultiPassPrompt(chapterName, bookName, subAnalyses, contents.length, { ...narrative, reviewSchwerpunkt, komplettContext, position, werkstand, strukturContext, planContext, ideenContext }),
        SYSTEM_KAPITELREVIEW,
        90, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
      );
      const droppedQ = applyQuoteVerification(r, belegHaystack(subAnalyses));
      if (droppedQ) logger.warn(`${droppedQ} Belegzitat(e) stammen nicht aus den Teil-Analysen – verworfen.`);
      basis = 'multi';
    }

    if (r?.gesamtnote == null) throw i18nError('job.error.gesamtnoteMissing');
    // Grundlage + Achsen-Profil ins Ergebnis (siehe routes/jobs/review.js).
    r.basis = basis;
    r.profil = profil;
    // Umfang des Laufs: der Verlauf kennzeichnet ihn, und die Notenänderung
    // vergleicht nur Läufe mit gleichem Umfang.
    r.includeSubchapters = !!includeSubchapters;
    r.pageCount = contents.length;

    saveChapterMacroReviewCache(bookIdInt, email, chapterIdInt, pagesSig, r, effectiveProvider);

    insertChapterReview({
      bookId: bookIdInt, chapterId: chapterIdInt, review: r,
      model: _modelName(effectiveProvider), userEmail,
    });

    completeJob(jobId, {
      review: r,
      chapterId: chapterIdInt,
      chapterName,
      pageCount: contents.length,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok), `«${chapterName}» ${contents.length} Seiten, Note ${r.gesamtnote}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (chap=${chapterId}): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
kapitelRouter.post('/chapter-review', jsonBody, async (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  const chapter_id = toIntId(req.body?.chapter_id);
  const includeSubchapters = req.body?.include_subchapters === true;
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!chapter_id) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!guardBook(req, res, book_id, 'editor')) return;
  // Kapitel- und Buchname kommen aus dem Content-Store, nicht vom Client: beide
  // gehen in Prompt und Cache-Signatur. Das Kapitel muss im geprüften Buch liegen.
  let chapterName = '';
  let bookName = '';
  try {
    const ch = await contentStore.loadChapter(chapter_id);
    if (ch.book_id !== book_id) return res.status(400).json({ error_code: 'CHAPTER_NOT_IN_BOOK' });
    chapterName = ch.name || '';
    bookName = (await contentStore.loadBook(book_id)).name || '';
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error_code: 'NOT_FOUND' });
    throw e;
  }
  const userEmail = sessionEmail(req);
  // Dedup auf Kapitel-Ebene – parallele Reviews unterschiedlicher Kapitel sind ok.
  // Läuft schon ein Lauf mit ANDEREM Umfang (Sub-Kapitel an/aus), wäre ihn
  // still zurückzugeben falsch: der User bekäme ein Ergebnis, das er nicht
  // angefordert hat.
  const existing = findActiveJobId('chapter-review', chapter_id, userEmail);
  if (existing) {
    if (!!jobs.get(existing)?.includeSubchapters !== includeSubchapters) {
      return res.status(409).json({ error_code: 'CHAPTER_REVIEW_OTHER_SCOPE_RUNNING' });
    }
    return res.json({ jobId: existing, existing: true });
  }
  const label = chapterName ? 'job.label.chapterReviewChapter' : 'job.label.chapterReview';
  const labelParams = chapterName ? { name: chapterName } : null;
  const jobId = createJob('chapter-review', book_id, userEmail, label, labelParams, chapter_id);
  jobs.get(jobId).includeSubchapters = includeSubchapters;
  enqueueJob(jobId, () => runChapterReviewJob(
    jobId, book_id, chapter_id, chapterName, bookName, userEmail,
    { includeSubchapters },
  ));
  res.json({ jobId });
});

module.exports = { kapitelRouter, runChapterReviewJob };
