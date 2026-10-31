'use strict';

const express = require('express');
const { getBookSettings } = require('../../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, contentHttpError,
  loadOrderedBookContents, loadPageContents,
  createJob, enqueueJob, findActiveJobId,
  jobAbortControllers, BATCH_SIZE,
  jsonBody,
} = require('../shared');
const { buildExportFilename } = require('../../../lib/filenames');
const { loadFinetuneData } = require('./data-loader');
const { finalizeFinetuneSamples } = require('./finalize');
const { bookFingerprint, finetuneFilePath, saveFinetuneResult, loadFinetuneMeta } = require('./lib/store');
const { buildEvalPrompts } = require('./lib/eval-prompts');

const { buildStyleSamples } = require('./samples/style');
const { buildSceneSamples } = require('./samples/scene');
const { buildVerbatimSamples } = require('./samples/verbatim');
const { buildDialogSamples } = require('./samples/dialog');
const { buildAuthorChatSamples } = require('./samples/author-chat');
const { buildAiAugmentSamples } = require('./samples/ai-augment');
const {
  buildReaderSamples, buildReaderAiSamples, buildReaderConversations, buildReaderSystem,
} = require('./samples/reader');
const { guardBook, sessionEmail } = require('../../../lib/acl');
const { toIntId } = require('../../../lib/validate');
const { setContext } = require('../../../lib/log-context');

const finetuneExportRouter = express.Router();

async function runFinetuneExportJob(jobId, bookId, bookName, userEmail, opts) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Start: «${bookName}» types=${Object.entries(opts.types).filter(([,v]) => v).map(([k]) => k).join(',')}`);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, pages } = await loadOrderedBookContents(bookId)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 40),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 45, statusText: 'finetune.phase.loadMetadata' });

    const bookIdInt = parseInt(bookId);
    const settings = getBookSettings(bookIdInt, userEmail);
    const langIsEn = (settings.language || 'de') === 'en';

    const data = loadFinetuneData({ bookIdInt, userEmail, pageContents, langIsEn });

    const minChars = Math.max(80, opts.minChars | 0);
    const maxChars = Math.max(minChars + 100, opts.maxChars | 0);
    const valSplit = Math.max(0, Math.min(0.5, Number.isFinite(opts.valSplit) ? opts.valSplit : 0.1));
    const seed = Number.isFinite(opts.valSeed) ? opts.valSeed : 0;
    // `maxSeqTokens`: hartes Token-Limit nach Tekken-V7-Chat-Template-Wrapping.
    // 0/null = kein Filter. Sweet-Spots für Ministral-3-8B:
    //   • QLoRA 4-bit auf 16-20 GB (RTX 4000 Ada):  4096
    //   • QLoRA 4-bit auf 24 GB (RTX 3090/4090):   8192
    //   • LoRA 16-bit auf 48 GB (A6000):           8192-16384
    //   • LoRA 16-bit auf 80 GB (A100/H100):       16384-32768
    const maxSeqTokens = Math.max(0, Number(opts.maxSeqTokens) || 0);
    const emitText = !!opts.emitText;
    // `fulltext`: aktiviert lange Voll-Kapitel-Samples in scene.js
    // (Voll-Kapitel-Completion, Sliding-Window-Cuts, Kapitel→Kapitel-Continuation).
    // Default an — grösste Hebelwirkung für Memorisierung des Buchtexts und
    // gerechtfertigt durch das Ministral-3-Kontextfenster (262144 Tokens).
    // Die Slice-Grösse folgt `maxFullChars` (unten), damit sie ins Seq-Budget passt.
    const fulltext = opts.fulltext !== false;
    // `maxFullChars`: Cap für Voll-Kapitel-Slices, Wörtlich-Slices und das
    // Multi-Page-Kontextfenster. Ohne expliziten Wert aus `maxSeqTokens`
    // abgeleitet: 60 % des Sequenz-Budgets (in Zeichen) für den Text-Slice, der
    // Rest bleibt dem Prompt (Metadaten, Vorgänger-Tail, Kontextseiten). Ein
    // fester Wert über dem Budget hiesse, dass der Seq-Filter genau die Samples
    // verwirft, die den Buchtext am vollständigsten tragen. Ohne `maxSeqTokens`
    // 60000 chars ≈ 18000 Tekken-V7-Tokens DE.
    const charsPerToken = langIsEn ? 4.0 : 3.3;
    const derivedFullChars = maxSeqTokens > 0
      ? Math.floor((maxSeqTokens - 20) * charsPerToken * 0.6)
      : 60000;
    const maxFullChars = Math.max(maxChars, Number(opts.maxFullChars) || derivedFullChars);
    // `truncateLong`: maxSeqTokens als Cap (Assistant-Content trunkieren) statt
    // Drop. Bewahrt grosse Samples für kleinere seqlen-Trainings, riskiert dafür
    // Mid-Sentence-Cuts. Default false → bestehendes Verhalten (Drop).
    const truncateLong = !!opts.truncateLong;
    // `biasBoost`: Multiplikator für die Per-Entity/Per-Page-Caps der
    // deterministischen Sampler (Dialog-Reverse, Satz-Continuation, Fakten-,
    // Passagen-Caps). 1 = bisheriges Verhalten, >1 = mehr redundante Samples
    // pro Quelle → stärkeres Memorisierungs-Bias. Geclamped auf 1..5.
    const biasBoost = Math.max(1, Math.min(5, Number(opts.biasBoost) || 1));
    // `maxTypeShare`: deckelt jeden Sample-Typ auf diesen Anteil am Gesamt
    // (0 = aus). Hält die volumenstarken Text-Sampler davon ab, das
    // Welt-/Figurenwissen zu erschlagen. Geclamped in finalize auf 0..0.95.
    const maxTypeShare = Math.max(0, Math.min(0.95, Number(opts.maxTypeShare) || 0));

    // Einheitliche Identität über alle Sample-Typen: Modell soll *eine* Stimme
    // lernen — die des Buchs im Gespräch mit Lesern (docs/finetuning.md#leser-modell)
    // — statt mehrerer Personae. Task-Variation steckt im User-Message, nicht
    // im System-Prompt.
    const displayName = bookName || (langIsEn ? 'this book' : 'diesem Buch');
    const unifiedSys = buildReaderSystem(displayName, langIsEn);

    const samples = [];
    // Analyse-Antworten, die `voiceRewrite` im Buchton neu fasst (author-chat/index.js#pushQA).
    const voiceTargets = new Map();
    const counts = { style: 0, scene: 0, verbatim: 0, dialog: 0, authorChat: 0, aiAugment: 0, reader: 0 };

    // Normalised opts mit übernommenen Defaults — wird in alle Sub-Module gereicht.
    const optsNorm = { ...opts, minChars, maxChars, valSplit, valSeed: seed, maxSeqTokens, emitText,
                       fulltext, maxFullChars, truncateLong, biasBoost, maxTypeShare };

    const ctx = {
      jobId, logger,
      bookId, bookIdInt, bookName, userEmail,
      opts: optsNorm,
      langIsEn, displayName, unifiedSys,
      counts, samples, voiceTargets,
      pageContents,
      // Namen aus dem Buchbaum, auch für Abschnitte unter der Mindestlänge
      // (Verweise auf Kapitel/Abschnitte ohne JOIN auf die Inhaltstabellen).
      chMap, pageNameById: new Map(pages.map(p => [p.id, p.name])),
      ...data,
    };

    logger.info(`Seiten geladen: ${pageContents.length} Seiten, ${data.figNamesSorted.length} Figuren bekannt.`);

    if (opts.types.style) {
      updateJob(jobId, { progress: 55, statusText: 'finetune.phase.style' });
      buildStyleSamples(ctx);
      logger.info(`Sampler «style» fertig: ${counts.style} Samples.`);
    }

    if (opts.types.scene) {
      updateJob(jobId, { progress: 70, statusText: 'finetune.phase.scene' });
      buildSceneSamples(ctx);
      logger.info(`Sampler «scene» fertig: ${counts.scene} Samples.`);
    }

    if (opts.types.verbatim) {
      updateJob(jobId, { progress: 72, statusText: 'finetune.phase.verbatim' });
      buildVerbatimSamples(ctx);
      logger.info(`Sampler «verbatim» fertig: ${counts.verbatim} Samples.`);
    }

    // Dialog-Sammlung läuft immer, wenn Figuren bekannt sind — `dialogsByFigure`
    // füttert auch den authorChat-Block (Zitatsammlung pro Figur). Der eigentliche
    // dialog-Typ ist davon unabhängig per Checkbox steuerbar.
    if (data.figNamesSorted.length) {
      if (opts.types.dialog) {
        updateJob(jobId, { progress: 85, statusText: 'finetune.phase.dialog' });
      }
      buildDialogSamples(ctx);
      if (opts.types.dialog) logger.info(`Sampler «dialog» fertig: ${counts.dialog} Samples.`);
    }

    if (opts.types.authorChat) {
      updateJob(jobId, { progress: 90, statusText: 'finetune.phase.authorChat' });
      buildAuthorChatSamples(ctx);
      logger.info(`Sampler «authorChat» fertig: ${counts.authorChat} Samples.`);
    }

    // Leser-Samples laufen immer: sie tragen das Gespräch mit dem Buch.
    updateJob(jobId, { progress: 91, statusText: 'finetune.phase.reader' });
    buildReaderSamples(ctx);
    logger.info(`Sampler «reader» fertig: ${counts.reader} Samples, ${ctx.readerFigures.length} tragende Figuren.`);

    if (opts.types.aiAugment) {
      updateJob(jobId, { progress: 92, statusText: 'finetune.phase.aiAugment' });
      await buildAiAugmentSamples(ctx);
      logger.info(`Sampler «aiAugment» fertig: ${counts.aiAugment} Samples.`);
    }

    if (opts.ai.persona || opts.ai.deutung) {
      updateJob(jobId, { progress: 93, statusText: 'finetune.phase.readerAi' });
      await buildReaderAiSamples(ctx);
    }
    // Zuletzt: Gespräche übernehmen die (ggf. im Buchton neu gefassten) Antworten.
    buildReaderConversations(ctx);
    logger.info(`Sampler «reader» inkl. KI und Gespräche: ${counts.reader} Samples.`);

    updateJob(jobId, { progress: 95, statusText: 'finetune.phase.building' });

    const { stats, trainJsonl, valJsonl, allJsonl } = finalizeFinetuneSamples(ctx);
    const evalPrompts = buildEvalPrompts(ctx);
    const evalJsonl = evalPrompts.map(e => JSON.stringify(e)).join('\n') + (evalPrompts.length ? '\n' : '');
    // Der System-Prompt reist mit: das Modelfile der Karte muss ihn wörtlich
    // tragen, sonst verliert das Modell die trainierte Persona.
    stats.systemPrompt = unifiedSys;
    stats.voiceRewritten = counts.voiceRewritten || 0;
    stats.evalCount = evalPrompts.length;
    stats.evalBytes = Buffer.byteLength(evalJsonl, 'utf8');
    await saveFinetuneResult(bookId, userEmail, {
      trainJsonl, valJsonl, allJsonl, evalJsonl,
      meta: { bookName, createdAt: new Date().toISOString(), fingerprint: bookFingerprint(pages), stats },
    });
    const sampleBreakdown = `${counts.style}/${counts.scene}/${counts.verbatim}/${counts.dialog}/${counts.authorChat}/${counts.aiAugment}/${counts.reader} (sty/scn/vrb/dlg/ac/aug/rdr)`;
    completeJob(jobId, { stats }, null,
      `${stats.total} Samples [${sampleBreakdown}], ${stats.train} train + ${stats.val} val, dropped=${stats.dropped}, p95=${stats.tokensP95} tok, max=${stats.tokensMax} tok, recSeq=${stats.recommendedSeqLen}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

finetuneExportRouter.post('/finetune-export', jsonBody, (req, res) => {
  const { book_id, book_name, types, min_chars, max_chars, val_split, val_seed,
          max_seq_tokens, emit_text, fulltext, max_full_chars, truncate_long, bias_boost,
          max_type_share, ai } = req.body || {};
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: toIntId(book_id) });
  if (!guardBook(req, res, book_id, 'editor')) return;
  const aiOpts = {
    reversePrompts:        !!(ai && ai.reverse_prompts),
    factQA:                !!(ai && ai.fact_qa),
    voiceRewrite:          !!(ai && ai.voice_rewrite),
    persona:               !!(ai && ai.persona),
    deutung:               !!(ai && ai.deutung),
    reversePromptsPerPage: Number(ai && ai.reverse_prompts_per_page) || 0,
    factQAPerEntity:       Number(ai && ai.fact_qa_per_entity)       || 0,
    personaPerFigure:      Number(ai && ai.persona_per_figure)       || 0,
    deutungPerScene:       Number(ai && ai.deutung_per_scene)        || 0,
  };
  const aiAugmentEnabled = aiOpts.reversePrompts || aiOpts.factQA || aiOpts.voiceRewrite;
  const opts = {
    types: {
      style:      !!(types && types.style),
      scene:      !!(types && types.scene),
      verbatim:   !!(types && types.verbatim),
      dialog:     !!(types && types.dialog),
      authorChat: !!(types && types.authorChat),
      aiAugment:  aiAugmentEnabled,
    },
    minChars: Number(min_chars) || 200,
    maxChars: Number(max_chars) || 4000,
    valSplit: Number.isFinite(Number(val_split)) ? Number(val_split) : 0.1,
    valSeed:  Number(val_seed)  || 0,
    maxSeqTokens: Number(max_seq_tokens) || 0,
    emitText: !!emit_text,
    fulltext: fulltext !== false,
    maxFullChars: Number(max_full_chars) || 0,
    truncateLong: !!truncate_long,
    biasBoost: Number(bias_boost) || 1,
    maxTypeShare: Number(max_type_share) || 0,
    ai: aiOpts,
  };
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('finetune-export', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.finetuneExportBook' : 'job.label.finetuneExport';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('finetune-export', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runFinetuneExportJob(jobId, book_id, book_name || '', userEmail, opts));
  res.json({ jobId });
});

// Zuletzt gespeichertes Set dieses Users fürs Buch, samt Hinweis, ob sich der
// Buchstand seither geändert hat (`stale`). Neu generiert wird nur auf Klick.
finetuneExportRouter.get('/finetune-export/latest', async (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const meta = loadFinetuneMeta(bookId, sessionEmail(req));
  if (!meta) return res.json({ export: null });
  const { pages } = await loadOrderedBookContents(bookId).catch(e => { throw contentHttpError(e); });
  res.json({ export: { createdAt: meta.createdAt, stats: meta.stats, stale: meta.fingerprint !== bookFingerprint(pages) } });
});

// Herunterladbare Dateien des gespeicherten Sets und woran man erkennt, dass
// sie Inhalt haben. `all` (train + val) und `eval` (Testprompts) fehlen in
// Sets, die vor ihrer Einführung erzeugt wurden.
const KIND_PRESENT = {
  train: (st) => st.train > 0,
  val:   (st) => st.val > 0,
  all:   (st) => st.allBytes > 0,
  eval:  (st) => st.evalBytes > 0,
};

finetuneExportRouter.get('/finetune-export/:kind.jsonl', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  // Buchzugriff kann seit dem Export entzogen worden sein.
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const kind = req.params.kind;
  if (!Object.hasOwn(KIND_PRESENT, kind)) return res.status(400).json({ error_code: 'INVALID_KIND' });
  const userEmail = sessionEmail(req);
  const meta = loadFinetuneMeta(bookId, userEmail);
  if (!meta) return res.status(404).json({ error_code: 'JSONL_NOT_FOUND' });
  if (!KIND_PRESENT[kind](meta.stats || {})) return res.status(404).json({ error_code: 'JSONL_EMPTY' });
  const filename = buildExportFilename({
    prefix: `finetune-${kind}`,
    slug: meta.bookName || `book${bookId}`,
    ext: 'jsonl',
    date: new Date(meta.createdAt || Date.now()),
  });
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(finetuneFilePath(bookId, userEmail, kind));
});

module.exports = { finetuneExportRouter };
