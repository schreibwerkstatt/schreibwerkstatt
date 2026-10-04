'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  getBookSettings, insertBookReview,
  loadChapterReviewCache, saveChapterReviewCache,
  loadBookReviewCache, saveBookReviewCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers, settledAll,
  _modelName, applyReviewAiOverrides, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
} = require('./shared');
const { narrativeLabels } = require('./narrative-labels');
const { loadReviewKomplettContext, loadReviewMotivContext, loadStrukturContext, loadWeltContext } = require('./review-context');
const { applyQuoteVerification, belegHaystack } = require('../../lib/quote-verify');
const { toIntId } = require('../../lib/validate');
const contentStore = require('../../lib/content-store');
const { resolveProvider } = require('../../lib/ai');
const { guardBook, sessionEmail } = require('../../lib/acl');

// Stabile, kurze Signatur für strukturierte Prompt-Vars (narrative,
// reviewSchwerpunkt, komplettContext). Identischer Inhalt → identische Sig.
function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

// pages_sig pro Chunk (analog Komplettanalyse): page_id:updated_at sortiert,
// plus alle Prompt-Vars, die das Kapitelanalyse-Ergebnis beeinflussen. `teil`
// steht drin, weil der Prompt eines Teil-Abschnitts anders lautet als der eines
// ganzen Kapitels.
function buildChapterPagesSig(chunk, { bookName, teil, narrativeSig, systemSig, cacheVersion }) {
  const pages = chunk.pages.map(p => `${p.id}:${p.updated_at || ''}`).sort().join('|');
  const teilSig = teil ? `${teil.nr}/${teil.von}` : '';
  return `${pages}||${chunk.name}||${bookName}||${teilSig}||${narrativeSig}||${systemSig}||${cacheVersion}`;
}

// Signatur der Multi-Pass-Synthese: sie hängt nur an den Kapitel-Analysen (deren
// Signaturen tragen den Seitenstand) und an den Prompt-Vars der Buchbewertung.
function buildSynthesisSig(chapterSigs, { bookName, optionsSig, cacheVersion }) {
  const h = crypto.createHash('sha1').update(chapterSigs.join('\n')).digest('hex');
  return `multi:${h}||${bookName}||${optionsSig}||${cacheVersion}`;
}

// Zeichenlänge eines System-Prompts (String oder Cache-Block-Array).
function _systemChars(system) {
  if (Array.isArray(system)) return system.reduce((s, b) => s + (b?.text?.length || 0), 0);
  return String(system || '').length;
}

// Pflichtfeld der Bewertung prüfen und normalisieren, BEVOR das Ergebnis in den
// Cache geht — ein kaputtes Ergebnis im Cache käme sonst bei jedem Lauf wieder.
// Skala 1.0–6.0; ein Zahl-String wird zur Zahl, sonst bleibt der Wert unberührt.
function normalizeGesamtnote(r) {
  const raw = r?.gesamtnote;
  if (raw == null || raw === '') throw i18nError('job.error.gesamtnoteMissing');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 6) {
    throw i18nError('job.error.gesamtnoteInvalid', { note: String(raw) });
  }
  r.gesamtnote = n;
  return r;
}

// Eine leere Kapitelanalyse ginge still als «–» in die Synthese ein und
// verzerrte die Note, ohne dass es jemand sieht.
function assertChapterAnalysis(ca, name) {
  const filled = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!ca || !(filled(ca.themen) || filled(ca.funktion_kurz))) {
    throw i18nError('job.error.chapterAnalysisEmpty', { name });
  }
}

// Ordnet jedem Chunk sein Kapitel (1-basiert in Lesereihenfolge) und — bei
// zerlegten Kapiteln — seine Teil-Nummer zu.
function chunkPlacement(chunkOrder, groupOrder) {
  const base = (key) => key.replace(/__sub\d+$/, '');
  const perGroup = new Map();
  for (const key of chunkOrder) perGroup.set(base(key), (perGroup.get(base(key)) || 0) + 1);
  const seen = new Map();
  const out = new Map();
  for (const key of chunkOrder) {
    const g = base(key);
    const nr = (seen.get(g) || 0) + 1;
    seen.set(g, nr);
    const von = perGroup.get(g);
    out.set(key, { kapitelNr: groupOrder.indexOf(g) + 1, teil: von > 1 ? { nr, von } : null });
  }
  return out;
}

// pages_sig fürs ganze Buch (Single-Pass-Review).
function buildBookReviewPagesSig(pageContents, { bookName, optionsSig, cacheVersion }) {
  const pages = pageContents
    .map(p => `${p.id}:${p.updated_at || ''}|${p.chapter_id ?? ''}:${p.chapter ?? ''}`)
    .sort()
    .join('|');
  return `${pages}||${bookName}||${optionsSig}||${cacheVersion}`;
}

const reviewRouter = express.Router();

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const {
    buildBookReviewSinglePassPrompt, buildChapterAnalysisPrompt, buildBookReviewMultiPassPrompt,
    buildReviewSchema, buildChapterAnalysisSchema, reviewProfil,
    getBuchtypReviewSchwerpunkt, PROMPTS_VERSION,
  } = prompts;
  const { SYSTEM_BUCHBEWERTUNG_BLOCKS: SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE_BLOCKS: SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  const narrative = narrativeLabels(bookSettings);
  // Genre-Schwerpunkt aus prompt-config.json laden und in Buchreview-Prompts
  // einkippen. Kapitelanalyse bleibt schwerpunkt-frei (würde Synthese verzerren).
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const reviewSchwerpunkt = getBuchtypReviewSchwerpunkt(locale, bookSettings?.buchtyp || null);
  // Komplett-Daten sind optional: ohne vorhergehende Komplettanalyse bleiben
  // die Buckets leer und der Prompt injiziert keinen Strukturdaten-Block.
  const komplettContext = loadReviewKomplettContext(bookId, userEmail);
  // Motiv-Werkstatt-Daten (Themen & Motive, Soll/Ist) — nur Buchbewertung, als
  // Autor-Absicht gerahmt (nicht Textwahrheit). Ohne Motiv-Werkstatt leer.
  const motivContext = loadReviewMotivContext(bookId, userEmail);
  const reviewBaseOptions = { ...narrative, reviewSchwerpunkt, komplettContext, motivContext };
  // Achsen-Set, Notenanker und Schema hängen am Bewertungsprofil des Buchtyps.
  const buchtyp = narrative.buchtyp || null;
  const profil = reviewProfil(buchtyp);
  const SCHEMA_REVIEW = buildReviewSchema({ buchtyp });
  const SCHEMA_CHAPTER_ANALYSIS = buildChapterAnalysisSchema({ buchtyp });

  const bookIdInt = parseInt(bookId);
  const email = userEmail || '';
  const effectiveProvider = resolveProvider({ userEmail });
  const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT, inputBudget: INPUT_BUDGET } = chunkLimitsFor(effectiveProvider);
  // Cache-Version: Modellname + Prompts-Schema-Version. Ändert sich eins davon,
  // werden alle persistierten Review-Caches automatisch verworfen.
  const effortSuffix = applyReviewAiOverrides(effectiveProvider, logger);
  const cacheVersion = `${_modelName(effectiveProvider)}${effortSuffix}:${PROMPTS_VERSION || ''}`;
  const narrativeSig = _sigHash(narrative);
  // Die System-Prompts tragen den Buch-Kontext (Freitext, Buchtyp-Zusatz, Status,
  // Schauplatz, reale Zeitlinie, Locale) und das Stilprofil. Gehasht wird der
  // gesendete Inhalt selbst statt einer Liste von Einstellungen — ein künftiger
  // Kontext-Baustein kann so nicht vergessen werden.
  const systemSigBook = _sigHash(SYSTEM_BUCHBEWERTUNG);
  const systemSigChapter = _sigHash(SYSTEM_KAPITELANALYSE);
  let optionsSig = _sigHash({ schwerpunkt: reviewSchwerpunkt, komplettContext, motivContext, narrative, systemSigBook });
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, pages } = await loadOrderedBookContents(bookId)
      .catch(e => { throw contentHttpError(e); });

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    const tok = { in: 0, out: 0, ms: 0 }; // akkumulierte Token über alle KI-Calls
    logger.info(`Start: «${bookName}» ${pages.length} Seiten`);
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, jobAbortControllers.get(jobId)?.signal);

    // Ist-Befunde des Struktur-Checks (nur journalistische Bücher; sonst null).
    // Erst hier ladbar, weil der Scope über die geladene Seitenliste läuft — und
    // damit auch erst hier in die Cache-Signatur einrechenbar.
    const strukturContext = loadStrukturContext(bookIdInt, pageContents, { scope: 'book' });
    if (strukturContext) {
      optionsSig = _sigHash({ optionsSig, strukturContext });
      logger.info(`Struktur-Befunde: ${strukturContext.geprueft}/${strukturContext.gesamt} Beiträge geprüft – fliessen in die Bewertung ein.`);
    }
    updateJob(jobId, { progress: 65 });
    const { groupOrder, groups } = groupByChapter(pageContents);

    // Weltaufbau-Messung am Fakten-Index. Braucht die Kapitel in Lesereihenfolge
    // (Verteilung ueber den Buchbogen) — darum erst hier, nach der Gruppierung, und
    // damit auch erst hier in die Cache-Signatur einrechenbar. Null, solange die
    // Komplettanalyse nie lief: „nicht erhoben" darf nicht als „weltarm" in die Note.
    const weltContext = loadWeltContext(bookIdInt, userEmail, groupOrder.map(k => groups.get(k).name));
    if (weltContext) {
      optionsSig = _sigHash({ optionsSig, weltContext });
      logger.info(`Weltaufbau-Befunde: ${weltContext.gesamt} Welt-Fakten, `
        + `${weltContext.kapitelAbdeckung.mitFakten}/${weltContext.kapitelAbdeckung.gesamt} Kapitel mit Fakt – fliessen in die Bewertung ein.`);
    }
    const reviewOptions = { ...reviewBaseOptions, strukturContext, weltContext };
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let r;
    // Auf welcher Grundlage die Note steht: Volltext oder verdichtete
    // Kapitelanalysen. Die beiden sind nicht vergleichbar (Zusammenfassungen
    // glätten Schwächen) — das Ergebnis muss es darum mitführen.
    let basis;
    // Kam das Endergebnis unverändert aus dem Cache? Dann ist es keine neue
    // Bewertung und bekommt keine zweite Historien-Zeile.
    let fromCache = false;

    // Single-Pass nur, wenn der FERTIGE Prompt ins Budget passt: SINGLE_PASS_LIMIT
    // misst nur den Buchtext, die Kontext-Blöcke (Komplettanalyse, Motive, Welt,
    // Struktur) kommen obendrauf. Passt er nicht, Multi-Pass statt Preflight-Fehler.
    let singlePrompt = null, bookText = null;
    if (totalChars <= SINGLE_PASS_LIMIT) {
      bookText = buildSinglePassBookText(groups, groupOrder);
      singlePrompt = buildBookReviewSinglePassPrompt(bookName, pageContents.length, bookText, reviewOptions);
      const promptChars = singlePrompt.length + _systemChars(SYSTEM_BUCHBEWERTUNG);
      if (promptChars > INPUT_BUDGET) {
        logger.info(`Single-Pass-Prompt ${promptChars} Zeichen > Budget ${INPUT_BUDGET} – weiche auf Multi-Pass aus.`);
        singlePrompt = null;
      }
    }

    if (singlePrompt) {
      updateJob(jobId, { progress: 65, statusText: 'job.phase.aiBookReview' });
      const bookPagesSig = buildBookReviewPagesSig(pageContents, { bookName, optionsSig, cacheVersion });
      const cached = loadBookReviewCache(bookIdInt, email, bookPagesSig, effectiveProvider);
      if (cached) {
        logger.info(`Single-Pass-Review – Cache-HIT (pages_sig match) – spart Review-Call.`);
        updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
        r = cached;
        fromCache = true;
      } else {
        r = await aiCall(jobId, tok,
          singlePrompt,
          SYSTEM_BUCHBEWERTUNG,
          65, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
        );
        normalizeGesamtnote(r);
        // Belegzitate gegen den tatsächlichen Buchtext prüfen. Ein nicht
        // auffindbares Zitat ist erfunden — es hat kein Sprungziel, an dem das
        // auffallen würde, also fällt es hier still heraus.
        const droppedQ = applyQuoteVerification(r, bookText);
        if (droppedQ) logger.warn(`${droppedQ} Belegzitat(e) nicht im Buchtext gefunden – verworfen.`);
        saveBookReviewCache(bookIdInt, email, bookPagesSig, r, effectiveProvider);
      }
      basis = 'single';
    } else {
      const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, PER_CHUNK_LIMIT);
      const placement = chunkPlacement(chunkOrder, groupOrder);
      const chapterSigs = new Array(chunkOrder.length);
      const chapterAnalyses = [];
      let completed = 0;
      let cacheHits = 0;

      const thunks = chunkOrder.map((key, gi) => async () => {
        if (jobAbortControllers.get(jobId)?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = chunks.get(key);
        const fromPct = 65 + Math.round((gi / chunkOrder.length) * 25);
        const toPct   = 65 + Math.round(((gi + 1) / chunkOrder.length) * 25);
        const { kapitelNr, teil } = placement.get(key);
        const pagesSig = buildChapterPagesSig(chunk, { bookName, teil, narrativeSig, systemSig: systemSigChapter, cacheVersion });
        chapterSigs[gi] = pagesSig;
        const cached = loadChapterReviewCache(bookIdInt, email, key, pagesSig, effectiveProvider);
        if (cached) {
          cacheHits++;
          completed++;
          updateJob(jobId, {
            progress: toPct,
            statusText: 'job.phase.analyzing',
            statusParams: { current: gi + 1, total: chunkOrder.length, name: chunk.name },
          });
          logger.info(`[${completed}/${chunkOrder.length}] «${chunk.name}» – Cache-HIT`);
          return { name: chunk.name, pageCount: chunk.pages.length, kapitelNr, teil, ...cached };
        }
        updateJob(jobId, {
          progress: fromPct,
          statusText: 'job.phase.analyzing',
          statusParams: { current: gi + 1, total: chunkOrder.length, name: chunk.name },
        });
        const chText = chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(chunk.name, bookName, chunk.pages.length, chText, { ...narrative, teil }),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null, undefined, SCHEMA_CHAPTER_ANALYSIS,
        );
        assertChapterAnalysis(ca, chunk.name);
        // Belegzitate der Zwischenstufe verifizieren, BEVOR sie in den Cache und
        // damit in die Synthese gehen: ab hier sieht keine Schicht den Volltext
        // dieses Kapitels wieder.
        const droppedQ = applyQuoteVerification(ca, chText, 'zitate');
        if (droppedQ) logger.warn(`«${chunk.name}»: ${droppedQ} Belegzitat(e) nicht im Kapiteltext gefunden – verworfen.`);
        saveChapterReviewCache(bookIdInt, email, key, pagesSig, ca, effectiveProvider);
        completed++;
        logger.info(`[${completed}/${chunkOrder.length}] «${chunk.name}» analysiert (${chunk.pages.length} Seiten)`);
        return { name: chunk.name, pageCount: chunk.pages.length, kapitelNr, teil, ...ca };
      });

      const results = await settledAll(thunks);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        chapterAnalyses.push(result.value);
      }
      if (cacheHits > 0) {
        logger.info(`Kapitelanalyse: ${cacheHits}/${chunkOrder.length} aus Cache (Delta-Cache spart Calls).`);
      }

      updateJob(jobId, {
        progress: 90,
        statusText: 'job.phase.finalReview',
      });
      // Synthese-Cache: kommen alle Kapitel aus dem Cache und hat sich an den
      // Prompt-Vars nichts geändert, ist auch die Synthese dieselbe. Teilt sich die
      // Zeile in book_review_cache mit dem Single-Pass (ein Endergebnis pro Buch).
      const synthSig = buildSynthesisSig(chapterSigs, { bookName, optionsSig, cacheVersion });
      const cachedSynth = loadBookReviewCache(bookIdInt, email, synthSig, effectiveProvider);
      if (cachedSynth) {
        logger.info(`Multi-Pass-Synthese – Cache-HIT – spart Final-Call.`);
        updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
        r = cachedSynth;
        fromCache = true;
      } else {
        r = await aiCall(jobId, tok,
          buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, pageContents.length, reviewOptions),
          SYSTEM_BUCHBEWERTUNG,
          90, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
        );
        normalizeGesamtnote(r);
        // Im Multi-Pass gibt es keinen Volltext mehr; zitierfähig sind nur die
        // Belegzitate der Kapitelanalysen.
        const droppedQ = applyQuoteVerification(r, belegHaystack(chapterAnalyses));
        if (droppedQ) logger.warn(`${droppedQ} Belegzitat(e) stammen nicht aus den Kapitelanalysen – verworfen.`);
        saveBookReviewCache(bookIdInt, email, synthSig, r, effectiveProvider);
      }
      basis = 'multi';
    }

    // Auch ein Cache-Treffer läuft durch die Prüfung: Einträge aus der Zeit vor
    // der Normalisierung können eine ungültige Note tragen.
    normalizeGesamtnote(r);
    // Grundlage + Achsen-Profil ins Ergebnis: das Frontend rendert die Achsen
    // dieses Laufs, nicht die des heute eingestellten Buchtyps — sonst fehlen
    // einer Alt-Bewertung nach einem Buchtyp-Wechsel die Abschnitte.
    r.basis = basis;
    r.profil = profil;

    const model = _modelName(effectiveProvider);
    // Cache-Treffer ohne Textänderung: steht dieselbe Bewertung schon zuoberst in
    // der Historie, keine Duplikat-Zeile — der Client meldet «unverändert».
    // Wurde der Eintrag inzwischen gelöscht, kommt er wieder hinein.
    const unchanged = !insertBookReview(
      { bookId: bookIdInt, review: r, model, userEmail },
      { skipIfSameAsLatest: fromCache },
    );

    completeJob(jobId, { review: r, unchanged, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `«${bookName}» ${pageContents.length} Seiten, Note ${r.gesamtnote}${unchanged ? ' (unverändert)' : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
reviewRouter.post('/review', jsonBody, async (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, book_id, 'editor')) return;
  // Buchname aus dem Content-Store, nicht vom Client: er geht in Prompt und
  // Cache-Signatur (buildBookReviewPagesSig).
  let bookName = '';
  try { bookName = (await contentStore.loadBook(book_id)).name || ''; }
  catch (e) {
    if (e?.status === 404) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
    throw e;
  }
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('review', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = bookName ? 'job.label.reviewBook' : 'job.label.review';
  const labelParams = bookName ? { name: bookName } : null;
  const jobId = createJob('review', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, bookName, userEmail));
  res.json({ jobId });
});

module.exports = { reviewRouter, runReviewJob, normalizeGesamtnote, chunkPlacement };
