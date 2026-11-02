'use strict';

const express = require('express');
const { getBookSettings } = require('../../../db/schema');
const { getMeta: getPublicationMeta } = require('../../../db/book-publication');
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
const {
  FINETUNE_FILE_KINDS, bookFingerprint, saveFinetuneExport, listFinetuneExports, getFinetuneExport, readFinetuneFile, deleteFinetuneExport,
} = require('../../../db/finetune-exports');
const JSZip = require('jszip');
const { buildEvalPrompts } = require('./lib/eval-prompts');
const { qualityLogLine, coreFactCoverage, coreFactVariants } = require('./lib/export-stats');
const { loadEventData } = require('./samples/author-chat/event-data');
const { buildCoreFactSamples, prepareFigureInfo } = require('./samples/core-facts');
const { checkRelations } = require('./lib/relation-check');
const { buildAiParaphraseSamples, buildAiWhyQuestions } = require('./samples/core-facts/ai-paraphrase');
const { relationTypes, finetuneProfiles, finetuneStudioFiles } = require('../../../lib/esm-bridge');
const { tServerParams } = require('../../../lib/i18n-server');
const { buildEvalJudgeMd } = require('./lib/eval/judge-md');
const { applyFinetuneAiOverrides } = require('./lib/ai-overrides');
const { resolveProvider } = require('../../../lib/ai');
const { fileSafeName, formatExportTimestamp } = require('../../../lib/filenames');

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
    const profiles = await finetuneProfiles();
    const profile = profiles.finetuneProfileById(opts.profileId);
    // Zeichen pro Token des Profil-Tokenizers (Tekken, Qwen …).
    const charsPerToken = profile.charsPerToken?.[langIsEn ? 'en' : 'de'] || (langIsEn ? 4.0 : 3.3);
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
    // `maxPerAnswer`: jede Assistant-Antwort höchstens so oft (0 = aus).
    // `maxFactShare`: Faktenfragen höchstens dieser Anteil, der Rest sind
    // Schreibaufgaben mit Buchtext als Ziel (0 = aus). Siehe finalize.js.
    const maxPerAnswer = Math.max(0, Math.min(50, Math.floor(Number(opts.maxPerAnswer ?? 2))));
    // Export-Vorgaben v3 (Kernwissen, Mischung nach Tokens, Längen, Absatz-
    // Budget, Ablehnen): Quelle ist das Trainingsprofil
    // (public/js/book/finetune-profiles.js#exportOptions); die Karte schickt sie
    // mit, fehlende Werte füllt der Server aus derselben Quelle.
    const exportOpts = normalizeExportOptions(profiles.exportOptions(profile), opts.export);

    // Einheitliche Identität über alle Sample-Typen: Modell soll *eine* Stimme
    // lernen — die des Buchs im Gespräch mit Lesern (docs/finetuning.md#leser-modell)
    // — statt mehrerer Personae. Task-Variation steckt im User-Message, nicht
    // im System-Prompt.
    const displayName = bookName || (langIsEn ? 'this book' : 'diesem Buch');
    const unifiedSys = buildReaderSystem(displayName, langIsEn);

    const samples = [];
    // Analyse-Antworten, die `voiceRewrite` im Buchton neu fasst (author-chat/index.js#pushQA).
    const voiceTargets = new Map();
    const counts = { style: 0, scene: 0, verbatim: 0, dialog: 0, authorChat: 0, aiAugment: 0, reader: 0, core: 0 };

    // Normalised opts mit übernommenen Defaults — wird in alle Sub-Module gereicht.
    const optsNorm = { ...opts, ...exportOpts, minChars, maxChars, valSplit, valSeed: seed, maxSeqTokens, emitText,
                       fulltext, maxFullChars, truncateLong, biasBoost, maxTypeShare,
                       maxPerAnswer, profileId: profile.id, charsPerToken, chatTemplate: profile.chatTemplate || 'mistral' };

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
      // Beziehungstypen (normalisieren, kanonische Richtung) — Kernwissen und
      // Falsche-Annahme-Fragen brauchen dieselbe Lesart wie der Figurengraph.
      relTypes: await relationTypes(),
      // Autor, Erscheinungsjahr, Verlag — Antworten auf Meta-Fragen
      // (samples/reader/refusals.js#buildMetaSamples), Quelle `book_publication`.
      publication: getPublicationMeta(bookIdInt),
      // Modell der KI-Teile (`ai.claude.model.finetune`, Standard Haiku) — geht
      // in jeden versionTag der Augment-Caches.
      aiModel: applyFinetuneAiOverrides(resolveProvider({ userEmail }), logger),
      ...data,
    };
    // Zeitstrahl einmal angereichert: Szenen-Sampler (Inhalt statt Lektorat),
    // Kernwissen (Ereignis-Facetten, Kapitelinhalt) und Buchwissen teilen ihn.
    Object.assign(ctx, loadEventData(ctx));

    // Beziehungsprüfung vor allen Samplern (lib/relation-check.js): betroffene
    // Paare fallen aus allen Fakten-Aufgaben. Konflikte bei Hauptfiguren
    // halten den Export an, bis der Autor sie bestätigt
    // (`allowRelationConflicts`) — korrigiert wird nichts.
    prepareFigureInfo(ctx);
    const relCheck = checkRelations(ctx);
    ctx.relationExcluded = relCheck.pairs;
    if (relCheck.conflicts.length) {
      logger.info(`Beziehungsprüfung: ${relCheck.conflicts.length} Konflikte (${relCheck.mainCount} mit Hauptfiguren), `
        + `${relCheck.pairs.size} Paare ausgelassen.`);
    }
    if (relCheck.mainCount && !opts.allowRelationConflicts) {
      completeJob(jobId, { blocked: 'relationConflicts', relationConflicts: publicConflicts(relCheck.conflicts) }, null,
        `angehalten: ${relCheck.mainCount} Beziehungskonflikte bei Hauptfiguren`);
      return;
    }

    logger.info(`Seiten geladen: ${pageContents.length} Seiten, ${data.figNamesSorted.length} Figuren bekannt.`);
    if (data.droppedSlugNames.length) {
      logger.info(`Ohne Anzeigenamen übersprungen: ${data.droppedSlugNames.join(', ')}`);
    }

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
      updateJob(jobId, { progress: 89, statusText: 'finetune.phase.coreFacts' });
      buildCoreFactSamples(ctx);
      logger.info(`Kernwissen fertig: ${counts.core} Samples, ${ctx.factCards.length} Faktenkarten, `
        + `${ctx.eligibleFigIds.size} Figuren ab ${optsNorm.minMentions} Erwähnungen, ${ctx.conflictDropped || 0} Beziehungen wegen Konflikt ausgelassen.`);
      if (optsNorm.aiParaphrase) {
        updateJob(jobId, { progress: 90, statusText: 'finetune.phase.aiParaphrase' });
        await buildAiParaphraseSamples(ctx);
      }
      if (optsNorm.aiWhyQuestions) {
        updateJob(jobId, { progress: 90, statusText: 'finetune.phase.aiWhyQuestions' });
        await buildAiWhyQuestions(ctx);
      }
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

    const fin = finalizeFinetuneSamples(ctx);
    const { stats, trainJsonl, valJsonl, allJsonl, valFamilyJsonl } = fin;
    logger.info(qualityLogLine(stats.quality));
    logger.info(`Verworfen: Karte=${stats.cardDropped} Kritik=${stats.critiqueDropped} Länge=${stats.lengthDropped} `
      + `Antwort-Budget=${stats.answerCapped} Absatz-Budget=${stats.paragraphCapped} Mischung=${JSON.stringify(stats.mixDropped)} `
      + `Split gemischt=${stats.splitMixed} Val-Überlappung=${stats.valPurged}`);
    const evalPrompts = buildEvalPrompts(ctx, { valUnits: fin.valUnits, trainPrompts: fin.trainPrompts });
    const evalJsonl = evalPrompts.map(e => JSON.stringify(e)).join('\n') + (evalPrompts.length ? '\n' : '');
    // Der System-Prompt reist mit: das Modelfile der Karte muss ihn wörtlich
    // tragen, sonst verliert das Modell die trainierte Persona.
    stats.systemPrompt = unifiedSys;
    stats.bookName = bookName || '';
    stats.lang = langIsEn ? 'en' : 'de';
    stats.evalDropped = ctx.evalDropped || null;
    stats.voiceRewritten = counts.voiceRewritten || 0;
    stats.evalCount = evalPrompts.length;
    stats.evalBytes = Buffer.byteLength(evalJsonl, 'utf8');
    stats.critiqueDropped = stats.critiqueDropped || 0;
    stats.factParaphraseCount = stats.quality.factParaphraseCount;
    stats.refusalCount = stats.quality.refusalCount;
    stats.verbatimTokenShare = stats.quality.verbatimTokenShare;
    stats.aiAugmentCount = (stats.aiAugmentCount || 0) + fin.trainOut.concat(fin.valOut).filter(s => s.aiParaphrase).length;
    stats.coreFactCoverage = coreFactCoverage(fin.trainOut, ctx.eligibleFigIds, ctx.relationFacts);
    stats.coreFactVariants = coreFactVariants(fin.trainOut, ctx.coreFactsByFig, (id) => ctx.figNameInfo?.get(id)?.name || id);
    stats.chapterMismatches = (ctx.chapterMismatches || []).slice(0, 50);
    stats.relationConflicts = publicConflicts(relCheck.conflicts);
    stats.relationConflictsMain = relCheck.mainCount;
    stats.relationConflictsAllowed = !!(relCheck.mainCount && opts.allowRelationConflicts);
    stats.conflictDropped = ctx.conflictDropped || 0;
    stats.relationResidual = ctx.relationResidual || 0;
    stats.factCards = (ctx.factCards || []).length;
    stats.profileId = profile.id;
    stats.exportOptions = exportOpts;
    const createdAt = new Date();
    // Gemeinsamer Namensstamm aller Downloads: <Buch>-<Profil>-<Zeitstempel>.
    stats.fileStem = `${fileSafeName(bookName || `book${bookId}`)}-${profile.id}-${formatExportTimestamp(createdAt)}`;
    await saveFinetuneExport(bookId, userEmail, {
      createdAt: createdAt.toISOString(), fingerprint: bookFingerprint(pages), stats,
      files: {
        train: trainJsonl, val: valJsonl, all: allJsonl, eval: evalJsonl,
        'val-facts': valFamilyJsonl.facts, 'val-writing': valFamilyJsonl.writing, 'val-persona': valFamilyJsonl.persona,
        'val-refusal': valFamilyJsonl.refusal, 'val-editor': valFamilyJsonl.editor,
      },
    });
    const sampleBreakdown = `${counts.style}/${counts.scene}/${counts.verbatim}/${counts.dialog}/${counts.authorChat}/${counts.core}/${counts.aiAugment}/${counts.reader} (sty/scn/vrb/dlg/ac/core/aug/rdr)`;
    completeJob(jobId, { stats }, null,
      `${stats.total} Samples [${sampleBreakdown}], ${stats.train} train + ${stats.val} val, dropped=${stats.dropped}, p95=${stats.tokensP95} tok, max=${stats.tokensMax} tok, recSeq=${stats.recommendedSeqLen}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Konfliktliste für Statistik und Karte: ohne die internen Paar-Schlüssel.
const publicConflicts = (list) => list.map(({ pairs, ...c }) => c);

const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : dflt);
const shareMap = (over, base) => Object.fromEntries(Object.entries(base)
  .map(([k, v]) => [k, clamp(over?.[k], 0, 1, v)]));

// Export-Vorgaben aus dem Body auf die Profil-Vorgaben legen, Werte begrenzen.
// Unbekannte Schlüssel fallen weg.
function normalizeExportOptions(base, over = {}) {
  const o = over && typeof over === 'object' ? over : {};
  const caps = { ...base.maxAnswerChars };
  if (o.maxAnswerChars && typeof o.maxAnswerChars === 'object') {
    for (const [k, v] of Object.entries(o.maxAnswerChars)) {
      const n = clamp(v, 0, 100000, null);
      if (n !== null && /^[a-zA-Z]+$/.test(k)) caps[k] = n;
    }
  }
  return {
    minMentions: Math.round(clamp(o.minMentions, 1, 1000, base.minMentions)),
    factParaphrases: Math.round(clamp(o.factParaphrases, 1, 10, base.factParaphrases)),
    maxVariantsPerFact: Math.round(clamp(o.maxVariantsPerFact, 1, 10, base.maxVariantsPerFact)),
    corePerTier: Object.fromEntries(Object.entries(base.corePerTier)
      .map(([k, v]) => [k, Math.round(clamp(o.corePerTier?.[k], 1, 13, v))])),
    coreFactRepeat: Math.round(clamp(o.coreFactRepeat, 1, 4, base.coreFactRepeat)),
    valRefusalMin: Object.fromEntries(Object.entries(base.valRefusalMin || {})
      .map(([k, v]) => [k, Math.round(clamp(o.valRefusalMin?.[k], 0, 100, v))])),
    familyTokenShares: shareMap(o.familyTokenShares, base.familyTokenShares),
    refusalShareBasis: 'count',
    refusalShare: clamp(o.refusalShare, 0, 0.5, base.refusalShare),
    refusalMix: shareMap(o.refusalMix, base.refusalMix),
    verbatimMaxTokenShare: clamp(o.verbatimMaxTokenShare, 0, 1, base.verbatimMaxTokenShare),
    maxAnswerChars: caps,
    maxTargetsPerParagraph: Math.round(clamp(o.maxTargetsPerParagraph, 0, 50, base.maxTargetsPerParagraph)),
    maxPerFactAnswer: Math.round(clamp(o.maxPerFactAnswer, 0, 50, base.maxPerFactAnswer ?? 0)),
    whoSaysMinWords: Math.round(clamp(o.whoSaysMinWords, 1, 50, base.whoSaysMinWords)),
    editorFeedback: typeof o.editorFeedback === 'boolean' ? o.editorFeedback : !!base.editorFeedback,
    aiParaphrase: typeof o.aiParaphrase === 'boolean' ? o.aiParaphrase : !!base.aiParaphrase,
    aiWhyQuestions: typeof o.aiWhyQuestions === 'boolean' ? o.aiWhyQuestions : !!base.aiWhyQuestions,
    critiquePatterns: Array.isArray(o.critiquePatterns) ? o.critiquePatterns.filter(p => typeof p === 'string' && p.length < 500).slice(0, 100) : undefined,
  };
}

// Zahl aus dem Body, sonst der Standard — 0 ist ein gültiger Wert («aus»).
const numOr = (v, dflt) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? dflt : Number(v));

finetuneExportRouter.post('/finetune-export', jsonBody, (req, res) => {
  const { book_id, book_name, types, min_chars, max_chars, val_split, val_seed,
          max_seq_tokens, emit_text, fulltext, max_full_chars, truncate_long, bias_boost,
          max_type_share, max_per_answer, ai, profile, export: exportBody, allow_relation_conflicts } = req.body || {};
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
    maxPerAnswer: numOr(max_per_answer, 2),
    profileId: typeof profile === 'string' ? profile : null,
    export: exportBody && typeof exportBody === 'object' ? exportBody : {},
    allowRelationConflicts: allow_relation_conflicts === true,
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

// Beziehungsprüfung ohne Export (lib/relation-check.js): die Karte zeigt die
// Konflikte vor dem Start, mit Verweis auf die Figuren. Keine KI, nur Daten.
finetuneExportRouter.get('/finetune-export/relation-check', async (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const userEmail = sessionEmail(req);
  const { chMap, pages } = await loadOrderedBookContents(bookId).catch(e => { throw contentHttpError(e); });
  const pageContents = await loadPageContents(pages, chMap, 30, null);
  const langIsEn = (getBookSettings(bookId, userEmail).language || 'de') === 'en';
  const ctx = { ...loadFinetuneData({ bookIdInt: bookId, userEmail, pageContents, langIsEn }), pageContents, relTypes: await relationTypes() };
  prepareFigureInfo(ctx);
  const { conflicts, mainCount } = checkRelations(ctx);
  res.json({ conflicts: publicConflicts(conflicts), mainCount });
});

// Gespeicherte Sets dieses Users fürs Buch, neuestes zuerst, je mit Hinweis,
// ob sich der Buchstand seither geändert hat (`stale`). Neu generiert wird nur
// auf Klick.
finetuneExportRouter.get('/finetune-export/list', async (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const metas = listFinetuneExports(bookId, sessionEmail(req));
  if (!metas.length) return res.json({ exports: [] });
  const { pages } = await loadOrderedBookContents(bookId).catch(e => { throw contentHttpError(e); });
  const fp = bookFingerprint(pages);
  res.json({ exports: metas.map(m => ({ id: m.id, createdAt: m.createdAt, stats: m.stats, stale: m.fingerprint !== fp })) });
});

// Dateiname: finetune-<art>-<Buch>-<Profil>-<Zeitstempel>. Sets ohne
// `fileStem` (vor dem Profil im Namen erzeugt) tragen Buch-ID + Zeitstempel.
function downloadName(ex, bookId, kind, ext) {
  if (ex.stats?.fileStem) return `finetune-${kind}-${ex.stats.fileStem}.${ext}`;
  return buildExportFilename({ prefix: `finetune-${kind}`, slug: `book${bookId}`, ext, date: new Date(ex.createdAt || Date.now()) });
}

const statsJson = (ex) => JSON.stringify({ createdAt: ex.createdAt, stats: ex.stats }, null, 2);

// Vorspann der Download-Routen: Buch-ID, ACL (Buchzugriff kann seit dem Export
// entzogen worden sein), Set per `?id=` — ohne `id` das neueste. Antwortet
// selbst und liefert dann null.
function savedExport(req, res) {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) { res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' }); return null; }
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'viewer')) return null;
  const id = req.query.id == null ? null : toIntId(req.query.id);
  if (req.query.id != null && !id) { res.status(400).json({ error_code: 'INVALID_EXPORT_ID' }); return null; }
  const ex = getFinetuneExport(bookId, sessionEmail(req), id);
  if (!ex) { res.status(404).json({ error_code: 'JSONL_NOT_FOUND' }); return null; }
  return { bookId, ex };
}

// Statistik eines gespeicherten Sets als Datei — dieselbe Struktur wie ein
// Eintrag von /finetune-export/list.
finetuneExportRouter.get('/finetune-export/stats.json', (req, res) => {
  const s = savedExport(req, res);
  if (!s) return;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(s.ex, s.bookId, 'stats', 'json')}"`);
  res.send(statsJson(s.ex));
});

// Alle Dateien eines Sets (jede gespeicherte JSONL + stats.json) als ZIP.
finetuneExportRouter.get('/finetune-export/export.zip', async (req, res) => {
  const s = savedExport(req, res);
  if (!s) return;
  const zip = new JSZip();
  for (const kind of FINETUNE_FILE_KINDS) {
    const buf = await readFinetuneFile(s.ex.id, kind);
    if (buf) zip.file(downloadName(s.ex, s.bookId, kind, 'jsonl'), buf);
  }
  zip.file(downloadName(s.ex, s.bookId, 'stats', 'json'), statsJson(s.ex));
  // Beilagen fürs Training, aus dem Set erzeugt (public/js/book/finetune-studio-files.js):
  // Studio-Config mit der empfohlenen Sequenzlänge, Modelfile mit dem
  // System-Prompt des Trainings, Bewertungsanleitung zum Eval-Set.
  const st = s.ex.stats || {};
  const locale = st.lang || 'de';
  const t = (key, params) => tServerParams(key, params, locale);
  const files = await finetuneStudioFiles();
  zip.file(downloadName(s.ex, s.bookId, 'studio-config', 'yaml'), files.studioYamlFor({ profileId: st.profileId, stats: st, t }));
  const modelfile = files.modelfileFor({ stats: st, bookName: st.bookName || '', t });
  if (modelfile) zip.file(downloadName(s.ex, s.bookId, 'Modelfile', 'txt'), modelfile);
  const judge = await evalJudgeMd(s.ex);
  if (judge) zip.file(downloadName(s.ex, s.bookId, 'eval-judge', 'md'), judge);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(s.ex, s.bookId, 'all-files', 'zip')}"`);
  res.setHeader('Content-Length', out.length);
  res.end(out);
});

// Bewertungsanleitung zum Eval-Set (lib/eval/judge-md.js), aus eval.jsonl erzeugt.
async function evalJudgeMd(ex) {
  const buf = await readFinetuneFile(ex.id, 'eval');
  if (!buf) return null;
  const items = buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return buildEvalJudgeMd(items, { bookName: ex.stats?.bookName || '', langIsEn: ex.stats?.lang === 'en' });
}

finetuneExportRouter.get('/finetune-export/eval-judge.md', async (req, res) => {
  const s = savedExport(req, res);
  if (!s) return;
  const md = await evalJudgeMd(s.ex);
  if (!md) return res.status(404).json({ error_code: 'JSONL_EMPTY' });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(s.ex, s.bookId, 'eval-judge', 'md')}"`);
  res.send(md);
});

finetuneExportRouter.get('/finetune-export/:kind.jsonl', async (req, res) => {
  const kind = req.params.kind;
  if (!FINETUNE_FILE_KINDS.includes(kind)) return res.status(400).json({ error_code: 'INVALID_KIND' });
  const s = savedExport(req, res);
  if (!s) return;
  const buf = await readFinetuneFile(s.ex.id, kind);
  if (!buf) return res.status(404).json({ error_code: 'JSONL_EMPTY' });
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName(s.ex, s.bookId, kind, 'jsonl')}"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

finetuneExportRouter.delete('/finetune-export/:id', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_EXPORT_ID' });
  if (!deleteFinetuneExport(bookId, sessionEmail(req), id)) return res.status(404).json({ error_code: 'JSONL_NOT_FOUND' });
  res.json({ ok: true });
});

module.exports = { finetuneExportRouter, runFinetuneExportJob };
