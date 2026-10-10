'use strict';
// Komplettanalyse-Kern-Job (Phasen P1–P8) + Nacht-Cron. Verify-Stufe,
// Anachronismus-Datenbasis und Per-Job-Claude-Overrides liegen in ./job-shared.
const logger = require('../../../logger');
const {
  db,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  backfillLocationChaptersFromScenes,
  rebuildFigureAppearances,
  getBookSettings,
} = require('../../../db/schema');

// F5: eigenständiger Checkpoint-Typ für den Konsolidierungs-Short-Circuit — getrennt vom
// Phase-1-Resume-Checkpoint ('komplett-analyse'), damit das Job-Ende-deleteCheckpoint ihn
// nicht mitlöscht. Persistiert über Läufe; self-invalidierend über die Sig.
const CONSOLIDATION_CP_TYPE = 'komplett-consolidation';
const appUsers = require('../../../db/app-users');
const bookAccess = require('../../../db/book-access');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  getPrompts, getBookPrompts,
  loadOrderedBookContents, idMapsFromContents, loadPageContents, groupByChapter, buildSinglePassBookText, cleanPageTextForAi,
  chunkLimitsFor, resolveExtractSinglePassLimit, BATCH_SIZE, jobAbortControllers,
  fmtTok, tps,
  createJob, enqueueJob, findActiveJobId,
  summarizeCostByPhase, formatCostByPhase,
} = require('../shared');
const { makeKomplettCall } = require('./call');
const { providerClass, maxParallelCalls, resolveProvider } = require('../../../lib/ai');
const contentStore = require('../../../lib/content-store');
const appSettings = require('../../../lib/app-settings');
const { setContext } = require('../../../lib/log-context');
const { runNonCritical, buildBookPagesSig, makePhaseTimer,
  buildConsolidationSig } = require('./utils');
const { loadAndValidateCheckpoint, restorePhase1FromCheckpoint } = require('./checkpoint');
const { remapSzenen, remapAssignments, saveSzenenAndEvents,
        planSzenenMatch, resolveSzenenForSave } = require('./remap');
const { judgeEntityPairs, isJudgeEnabled } = require('./entity-reconcile');
const {
  runPhase1, runPhase2, runPhase3, runPhase3Songs, runPhase3b,
  buildPrelimFigurenKompakt, runPhase3OrteCall,
  runZeitstrahlPhase, runCoverageAudit, komplettMaxTokens,
} = require('./phases');
const { _komplettAiOverrides, resolveRemapNames } = require('./job-shared');
const { loadOrteFromDb, countSongsInDb, countSzenenInDb, activeStepJob } = require('./scope');
const { normalizeKomplettScope, isFullKomplettScope, skippedKomplettSteps, KOMPLETT_STEPS } = require('../../../lib/komplett-scope');
const { enqueuePruefJobs } = require('./pruef-jobs');
const { COST_LABEL, relabel } = require('./cost-labels');
const { persistWorldFacts } = require('./world-facts-save');
const { extractCacheBase, consolidationFlags } = require('./signatures');
const { loadKatalogAnker } = require('./katalog-anker');

// ── Job: Komplettanalyse ─────────────────────────────────────────────────────
// Pipeline (token-optimiert):
//   P1 (Vollextraktion: Figuren+Orte+Fakten+Szenen+Events, parallel/Kapitel, SYSTEM_KOMPLETT_EXTRAKTION)
//      → Schema im System-Prompt gecacht; Szenen/Events mit Klarnamen (kein ID-Lookup nötig)
//   P2/P3 (Claude Multi-Pass parallel, sonst sequentiell):
//      P2 (Figuren konsolidieren + Soziogramm) → figNameToId aufbauen
//      P3 (Orte konsolidieren, prelim figurenKompakt im Prompt, figuren_namen→fig_id post-hoc) → ortNameToId
//   P3b (Kapitelübergreifende Beziehungen, nur Multi-Pass, non-critical)
//   P5 Szenen remappen
//   P6 Zeitstrahl + P8 Kontinuität: parallel bei Claude (P8 ownt Progress-Bar), sonst sequentiell
// opts.scope: Lauf-Umfang (Teil-Lauf) — welche Schritte dieser Lauf neu berechnet.
// Katalog + Normalisierung: lib/komplett-scope.js. Fehlt er, läuft alles (Nacht-Cron).
// ACHTUNG Positions-Reihenfolge: `provider` (Slot 6) wird vom Nacht-Cron gesetzt —
// opts MUSS dahinter stehen, sonst landet das Options-Objekt im Provider-Slot.
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, provider = undefined, opts = {}) {
  // Lauf-Umfang: normalisiert, damit ein Aufrufer ohne `scope` (Nacht-Cron, Tests)
  // unverändert den vollständigen Lauf bekommt.
  const scope = normalizeKomplettScope(opts.scope);
  const fullScope = isFullKomplettScope(scope);
  // Nur die Katalog-Schritte entscheiden über den Konsolidierungs-Checkpoint (F5).
  const catalogScopeFull = KOMPLETT_STEPS.filter(st => st.group === 'katalog').every(st => scope[st.key] === true);
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  // WICHTIG: effektiven (aufgelösten) Provider binden, nicht die rohe `provider`-Variable:
  // ohne expliziten Provider fiele aiCall auf 'claude' zurück und kappte das Output-Ceiling
  // auf ai.claude.max_tokens_out, während callAI den echten Provider anspricht (Truncation).
  const effectiveProvider = provider || resolveProvider({ userEmail });
  // Strategie-Entscheidungen dieser Pipeline haengen an der KLASSE, nicht am Namen
  // (SSoT: lib/ai/config.js#providerClass) — ein gehostetes Frontier-Modell ueber
  // openai-compat kann dasselbe wie Claude. Am Namen bleibt nur, was eine
  // Anthropic-API-Faehigkeit braucht (Tiered Routing, Prompt-Cache-Warmup,
  // phase1_concurrency, web_search-Faktencheck). Details: docs/ai-providers.md.
  const isCloudModel = providerClass(effectiveProvider) === 'cloud';
  const overrides = _komplettAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    log.info(`Komplettanalyse-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)} `
      + `(global model=${appSettings.get(`ai.${effectiveProvider}.model`)}, ctx=${appSettings.get(`ai.${effectiveProvider}.context_window`)}, `
      + `out=${appSettings.get(`ai.${effectiveProvider}.max_tokens_out`)}, timeout=${appSettings.get(`ai.${effectiveProvider}.timeout_ms`)}).`);
  }
  // Tiered Routing (nur Claude): die mechanischen Extraktions-Calls laufen auf einem
  // EIGENEN Tier — anderes Modell UND andere Denk-Tiefe — als die Konsolidierung und das
  // Kontinuitäts-Urteil (die folgen dem job-weiten ALS-Modell/-Effort =
  // ai.claude.model.komplett + ai.claude.effort.komplett).
  //
  // Warum ein Tier-Objekt und kein setContext: Extraktions- und Konsolidierungs-Calls
  // laufen über `settledAll` parallel; ein ALS-Patch würde den Nachbar-Call mittreffen.
  // Das `label` klassifiziert die Kosten (job.result.costByPhase) und beeinflusst den
  // Request nicht. Beide Felder leer → Verhalten identisch zu vorher.
  const extractTier = effectiveProvider === 'claude' ? {
    model: String(appSettings.get('ai.claude.model.komplett.extract') || '').trim() || undefined,
    effort: String(appSettings.get('ai.claude.effort.komplett.extract') || '').trim().toLowerCase() || undefined,
    label: COST_LABEL.extract,
  } : { label: COST_LABEL.extract };
  // Gap-/Coverage-Pässe laufen auf DEMSELBEN Tier (Modell + Effort) wie die
  // Basis-Extraktion, werden aber getrennt bepreist: sie hängen an eigenen
  // Hebeln (completeness_passes, coverage_audit_chapters) und vervielfachen die
  // Call-Zahl der Phase. In einem gemeinsamen Bucket wäre nicht ablesbar,
  // welcher der beiden Hebel das Geld kostet.
  const gapTier = relabel(extractTier, COST_LABEL.extractGap);
  const coverageTier = relabel(extractTier, COST_LABEL.coverage);
  // Geteilter Buch-Präfix → kein Schema (Cache-Regel, siehe ./call.js).
  const call = makeKomplettCall(effectiveProvider);
  // Per-Provider-Skalierung aus dessen `ai.<p>.context_window` (lib/ai.js#getContextConfigFor).
  // Bei Claude 200K-Kontext ≈ 420K Zeichen Single-Pass – reicht für fast alle Bücher.
  // Gegen das EIGENE Output-Cap dieser Pipeline gerechnet, nicht gegen das provider-weite:
  // `komplettMaxTokens` (Cloud: das Provider-Ceiling, lokal `ai.komplett.extract_max_tokens`)
  // ist das Output-Cap der Pipeline. Es wirkt nur, wenn ein Call es im `maxTokens`-Slot
  // übergibt (9. Argument von `call`, Muster phases/extraktion.js) — im `expectedChars`-Slot
  // ist es bloss eine Fortschritts-Schätzung, und aiCall reserviert dann das Provider-Ceiling.
  // Der Wert im `maxTokens`-Slot bestimmt auch den Kontext-Preflight in aiCall.
  // Mit dem provider-weiten `max_tokens_out` läge die Chunk-Grenze unter dem, was die Calls
  // tatsächlich tragen — bei einem lokalen Modell zerlegt das das Buch in deutlich mehr
  // Chunks als nötig (mehr Calls, mehr chunk-übergreifende Dubletten in der Konsolidierung).
  const { singlePass: singlePassLimit, perChunk: perChunkLimit } =
    chunkLimitsFor(effectiveProvider, { maxTokensOut: komplettMaxTokens(effectiveProvider) });
  // EXTRAKTIONS-Schwelle, entkoppelt von der Kontinuitäts-Schwelle (singlePassLimit): bei
  // Opus 4.8 + 1M würde sonst fast jedes Buch Single-Pass extrahiert (schlechterer Long-Tail-
  // Recall + Truncation-Risiko im 128K-Output). ai.komplett.extract_single_pass_cap > 0 zwingt
  // die Extraktion in kapitelweise Chunks (Gap-Pässe + Alias-Cluster greifen), während
  // Kontinuität/Erzählprofil weiter das ganze Buch sehen. Nur Claude.
  const extractCapChars = isCloudModel
    ? Math.max(0, parseInt(appSettings.get('ai.komplett.extract_single_pass_cap'), 10) || 0)
    : 0;
  const extractSinglePassLimit = resolveExtractSinglePassLimit(singlePassLimit, extractCapChars);
  const prompts = await getPrompts(userEmail);
  const sys = await getBookPrompts(bookId, email);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    const skippedSteps = skippedKomplettSteps(scope);
    if (skippedSteps.length) log.info(`Teil-Lauf – abgewählte Schritte: ${skippedSteps.join(', ')}.`);
    const cp = loadAndValidateCheckpoint(bookIdInt, email, log, jobId);

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 12),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, jobAbortControllers.get(jobId)?.signal);

    // Kapitel-scoped Page-Lookup gegen Namenskollisionen (derselbe Seitenname kann
    // in mehreren Kapiteln existieren) — SSoT shared/loader.js#idMapsFromContents,
    // derselbe Bau wie im Katalog-PUT (routes/figures.js).
    const idMaps = idMapsFromContents({ chNameToId, pages });
    // Kapitel-Umbenennung invalidiert den Multi-Pass-Delta-Cache über den Kapitelnamen
    // im Chunk-pages_sig (phases.js) — keine separate Invalidierungs-Funktion mehr nötig.

    // Buchtext-Preprocessing (claude-only): unbekannte HTML-Entities (&nbsp;,
    // &mdash;, …), Zero-Width-Zeichen, Soft Hyphen, NBSP, doppelte Spaces raus.
    // Wirkt auf pageContents → schlägt automatisch in fullBookText UND
    // Multi-Pass-Chunks durch (beide werden aus pageContents gebaut).
    // P1 und P8 nutzen identischen Buchtext → 1h-Cache-Read in P8 bleibt intakt.
    if (isCloudModel) {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForAi(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Buchtext-Preprocessing ${savedChars} Zeichen entfernt (Entities/Whitespace/ZWS).`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    // Einmal bauen, wiederverwenden (Phase 1 Single-Pass, Phase 3b, P8 Kontinuität)
    const fullBookText = buildSinglePassBookText(groups, groupOrder);
    // Single/Multi-Pass-Signal für die Frontend-Phasenanzeige: Im Single-Pass wird
    // Phase 3b übersprungen, die UI blendet den entsprechenden Eintrag aus. Kennzahl ist die
    // EXTRAKTIONS-Schwelle (sie bestimmt chapterFiguren.length > 1 → ob P2/P3/P3b laufen),
    // nicht die Kontinuitäts-Schwelle.
    const passMode = totalChars <= extractSinglePassLimit ? 'single' : 'multi';
    updateJob(jobId, { passMode });

    // completeness_passes (geclampt) verändert den Single-Pass-Extraktionsinhalt (zusätzliche
    // Long-Tail-Entitäten), muss also Teil der Cache-Version sein — sonst liefert ein Hochsetzen
    // von 0→N bei unverändertem Seitenstand weiter den alten HIT ohne Long-Tail (stiller
    // Qualitätsverlust). Über cacheVersion fliesst der Wert automatisch in den Single-Pass-Key,
    // die Multi-Pass-Chunk-Keys und den Checkpoint-bookPagesSig (alle drei invalidieren).
    const completenessPasses = Math.max(0, Math.min(3,
      parseInt(appSettings.get('ai.komplett.completeness_passes'), 10) || 0));

    // Content-verändernde Single-Pass-Erweiterung (nur Claude): der Szenen-Backfill
    // mutiert den gecachten __singlepass__-Katalog. Wie completeness_passes muss sein
    // Enablement in die cacheVersion, sonst friert ein Toggle den alten HIT ein. Einmal
    // berechnen und via ctx durchreichen → cacheVersion und Verhalten lesen dieselben Werte.
    // Der Coverage-Audit ist reine Messung (schreibt nichts) und gehört NICHT hinein.
    const coverageAuditChapters = Math.max(0, Math.min(20,
      parseInt(appSettings.get('ai.komplett.coverage_audit_chapters'), 10) || 0));
    const sceneBackfillEnabled = isCloudModel
      && appSettings.get('ai.komplett.scene_backfill') !== false;
    const sceneBackfillMinChars = Math.max(500, parseInt(appSettings.get('ai.komplett.scene_backfill_min_chars'), 10) || 3000);
    const figureBatchSize = Math.max(1, parseInt(appSettings.get('ai.komplett.figure_batch_size'), 10) || 20);

    // Cache-Version: was die Extraktions-Calls tatsächlich senden und wie sie aufgelöst
    // werden — Modell + Effort des Extraktions-Tiers nach Auflösung, die System-Blöcke
    // dieses Buchs (Buchkontext eingeschlossen) und die Extraktions-Prompt-Version
    // (./signatures.js, Begründung dort). Dazu nur beim Single-Pass dessen Erweiterungen
    // (Extraktions-Cap, Coverage-Stichprobe, Szenen-Backfill) und completeness_passes.
    // Basis-Chunks des Multi-Pass tragen die Erweiterungen nicht: ein Toggle daran soll
    // nicht alle Kapitel neu bezahlen (der :gap-Key trägt cp selbst).
    const extractVersion = prompts.KOMPLETT_EXTRACT_VERSION || prompts.PROMPTS_VERSION || '';
    const chunkCacheVersion = extractCacheBase({ provider: effectiveProvider, tier: extractTier, sys, extractVersion });
    const singlePassAug = isCloudModel
      ? `:esp${extractCapChars}:sb${sceneBackfillEnabled ? 1 : 0}:sbm${sceneBackfillMinChars}`
      : '';
    const cacheVersion = `${chunkCacheVersion}:cp${completenessPasses}${singlePassAug}`;
    // Buch-weite Signatur (Seitenstand + Settings + Modell/Prompt-Version) – dieselbe
    // Gate wie der chapter_extract_cache. Validiert den Checkpoint-Resume.
    const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);

    // Sammelt non-critical-Degradierungen (Soziogramm, P3b, Kontinuität), die
    // sonst nur in schreibwerkstatt.log landen → ins Job-Result, damit der User
    // „erfolgreich, aber Teilphase übersprungen" von „alles ok" unterscheiden kann.
    const warnings = [];
    // Katalog-Anker (./katalog-anker.js): ab dem zweiten Lauf sieht die Extraktion den
    // Bestand mit stabilen IDs und ordnet selbst zu. Erster Lauf: null.
    const katalogAnker = loadKatalogAnker(bookIdInt, email);
    if (katalogAnker) log.info(`Katalog-Anker: ${katalogAnker.figIds.size} Figuren, ${katalogAnker.ortIds.size} Orte im Prompt.`);
    const ctx = {
      katalogAnker, katalogBlock: katalogAnker?.block || null, scope,
      jobId, bookIdInt, bookName, email, call, tok, log,
      effectiveProvider, singlePassLimit, extractSinglePassLimit, perChunkLimit,
      cacheVersion, chunkCacheVersion, bookPagesSig, prompts, sys,
      idMaps, pageContents, groups, groupOrder, totalChars, fullBookText, warnings, completenessPasses,
      extractTier, gapTier, coverageTier,
      coverageAuditChapters, sceneBackfillEnabled, sceneBackfillMinChars, figureBatchSize,
    };
    pt.mark('Laden');

    // ── Phase 1: Vollextraktion ───────────────────────────────────────────────
    // Checkpoint nur resumen, wenn Seitenstand + Modell/Prompt-Version unverändert.
    // Sonst liefert restorePhase1FromCheckpoint stale Extraktion (Edit nach Crash,
    // PROMPTS_VERSION-Bump) – der chapter_extract_cache wäre hier sig-invalidiert,
    // der Checkpoint umging das bisher komplett.
    const cpUsable = cp?.phase === 'p1_full_done' && cp.bookPagesSig === bookPagesSig;
    if (cp && !cpUsable) {
      log.info('Checkpoint verworfen (Seiten oder Modell/Prompt-Version geändert) – Phase 1 neu.');
      deleteCheckpoint('komplett-analyse', bookIdInt, email);
    }
    const p1 = cpUsable
      ? restorePhase1FromCheckpoint(cp, tok, log, jobId)
      : await runPhase1(ctx);
    const { chapterFiguren, chapterOrte, chapterSongs, chapterFakten, chapterSzenen, chapterAssignments } = p1;
    pt.mark('P1 Extraktion');

    // ── F5: Konsolidierungs-Checkpoint (Short-Circuit von P2–P8) ─────────────
    // Der Delta-Cache macht Phase 1 bei unverändertem Seitenstand billig (Cache-HITs), aber
    // P2/P3/P6/P8 (die teuren Konsolidierungs-/Urteil-Calls) liefen bisher IMMER neu. Ist der
    // assemblierte Phase-1-Katalog + die konsolidierungs-relevanten Parameter unverändert, ist
    // der DB-Katalog bereits korrekt → P2–P8 überspringen. Reines Short-Circuit, kein
    // Merge-Eingriff (id-Stabilität unberührt). Die Sig ändert sich bei jeder Seiten-/Modell-/
    // Prompt-/Gap-/Alias-/Attr-Änderung automatisch (via cacheVersion bzw. Extraktions-Inhalt).
    // Modell + Effort der Konsolidierung nach Auflösung und ihre System-Blöcke
    // (./signatures.js). Der Entitäten-Judge verändert das Matching und damit den
    // Katalog — sein Toggle muss den Checkpoint ebenfalls invalidieren.
    const consolFlags = consolidationFlags({
      provider: effectiveProvider, sys, matchJudge: isJudgeEnabled(effectiveProvider),
    });
    // Konsolidierung hängt an allen Komplett-Prompts → zusätzlich der Gesamt-Hash.
    const consolidationSig = buildConsolidationSig(p1, `${cacheVersion}|${prompts.PROMPTS_VERSION || ''}`, consolFlags);
    const consolMarker = loadCheckpoint(CONSOLIDATION_CP_TYPE, bookIdInt, email);
    const figuresPresent = db.prepare(
      'SELECT COUNT(*) AS c FROM figures WHERE book_id = ? AND user_email IS ?'
    ).get(bookIdInt, email).c;
    if (consolMarker && consolMarker.sig === consolidationSig && figuresPresent > 0) {
      log.info('Konsolidierungs-Checkpoint HIT – Katalog unverändert, P2–P8 übersprungen.');
      deleteCheckpoint('komplett-analyse', bookIdInt, email);
      updateJob(jobId, { progress: 100, statusText: 'job.phase.consolidationCached' });
      completeJob(jobId, {
        figCount:    consolMarker.figCount ?? figuresPresent,
        orteCount:   consolMarker.orteCount ?? 0,
        songsCount:  consolMarker.songsCount ?? 0,
        szenenCount: consolMarker.szenenCount ?? 0,
        warnings,
        consolidationSkipped: true,
        tokensIn: tok.in, tokensOut: tok.out,
      }, tps(tok), `SKIP(P2–P8) fig=${consolMarker.figCount ?? figuresPresent}`);
      return;
    }

    // Welt-Fakten persistieren (Full-Replace) — abfragbar im Buch-Chat via list_world_facts.
    persistWorldFacts(ctx, chapterFakten, idMaps.chNameToId);

    // ── Phase 2 + 3: Figuren + Orte konsolidieren ────────────────────────────
    // Multi-Pass: P2 (Figuren-AI) und P3 (Orte-AI) sind unabhängig und werden parallel
    // gefahren. P3 nutzt prelim figurenKompakt (Pre-P2-Merge) im Prompt; nach P2-Merge
    // werden die Orte-figuren_namen via figNameToId auf die finalen kanonischen fig_ids
    // aufgelöst — der Preis der Parallelisierung ist also eine etwas ältere Figurenliste
    // im Orte-Prompt.
    // Single-Pass: kein AI-Call in P2/P3 → Parallelisierung bringt nichts.
    // Das Gate ist die PARALLELITÄT DES ENDPUNKTS, nicht die Provider-Klasse: ein lokaler
    // Server mit `ai.openai-compat.max_parallel > 1` verträgt die zwei Calls genauso, und
    // bei einem lokalen Modell wiegt der gesparte Call ein Vielfaches der Cloud-Ersparnis.
    // Ollama liefert 1 (globaler Mutex) und bleibt damit seriell wie bisher.
    // Teil-Lauf: ohne Schritt «Orte» entfällt P3 samt Konsolidierungs-Call — die
    // Namens→Handle-Karten kommen dann aus dem bestehenden Katalog, damit die Szenen
    // ihre Ortszuordnung behalten (sonst dropped remapSzenen jede ort_id).
    const isMultiPassParallel = maxParallelCalls(effectiveProvider) > 1 && chapterFiguren.length > 1 && scope.orte;
    let figuren, figNameToId, figNameToIdLower, figurenKompakt, isSinglePass;
    let orte, ortNameToId, ortNameToIdLower;
    if (isMultiPassParallel) {
      const prelimFigKompakt = buildPrelimFigurenKompakt(chapterFiguren);
      const [p2Result, orteRaw] = await Promise.all([
        runPhase2(ctx, chapterFiguren, chapterAssignments, chapterSzenen),
        runPhase3OrteCall(ctx, chapterOrte, prelimFigKompakt),
      ]);
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, isSinglePass } = p2Result);
      ({ orte, ortNameToId, ortNameToIdLower } =
        await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower, { prefetchedOrteRaw: orteRaw }));
    } else {
      ({ figuren, figNameToId, figNameToIdLower, figurenKompakt, isSinglePass } =
        await runPhase2(ctx, chapterFiguren, chapterAssignments, chapterSzenen));
      if (scope.orte) {
        ({ orte, ortNameToId, ortNameToIdLower } =
          await runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower));
      } else {
        ({ orte, ortNameToId, ortNameToIdLower } = loadOrteFromDb(bookIdInt, email));
        log.info(`Orte auf Wunsch übersprungen – ${orte.length} Schauplätze aus dem Katalog übernommen.`);
        updateJob(jobId, { progress: 55 });
      }
    }
    pt.mark('P2+P3 Konsolidierung');

    // ── Phase 3 Songs: Musikbibliothek konsolidieren ─────────────────────────
    let songsCount;
    if (scope.songs) {
      const r = await runPhase3Songs(ctx, chapterSongs || [], figurenKompakt, isSinglePass, figNameToId, figNameToIdLower);
      songsCount = r.songsCount ?? r.songs.length;
    } else {
      songsCount = countSongsInDb(bookIdInt, email);
      log.info(`Songs auf Wunsch übersprungen – bestehende Musikbibliothek (${songsCount}) bleibt.`);
      updateJob(jobId, { progress: 56 });
    }

    // ── Phase 3b: Kapitelübergreifende Beziehungen (non-critical, nur Multi-Pass) ──
    if (scope.beziehungen && chapterFiguren.length > 1 && figuren.length >= 2) {
      await runNonCritical('Phase 3b kapitelübergreifende Beziehungen',
        () => runPhase3b(ctx, figuren), log,
        { warnings, warnKey: 'job.warn.crossChapterFailed' });
    }
    pt.mark('Songs+P3b');

    // ── Block 2: Szenen remappen → Zeitstrahl + Kontinuitätsprüfung ──────────
    // Claude: P6 (Zeitstrahl) und P8 (Kontinuität) sind unabhängig und laufen
    // parallel. P8 dominiert zeitlich (voller Buchtext bei Single-Pass, sonst
    // Fakten-Listen) und kontrolliert die Progress-Bar (82..97); P6 läuft
    // silent. Lokale Provider sequentiell (Mutex serialisiert ohnehin).
    updateJob(jobId, { progress: 58, statusText: 'job.phase.processingScenes' });
    const locRows = db.prepare(
      'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));
    // Teil-Lauf: Szenen und Lebensereignisse sind zwei Schritte, die denselben
    // Schreibpfad teilen. Ist keiner von beiden gewählt, entfällt der ganze Block
    // inklusive Remap-Rescue und Szenen-Judge (beides KI-Calls) — der bestehende
    // Bestand bleibt dann unangetastet.
    const writeSzenen = scope.szenen;
    const writeEvents = scope.ereignisse;
    let szenenResult = { szenenCount: countSzenenInDb(bookIdInt, email), eventsCount: 0 };
    if (writeSzenen || writeEvents) {
      // Remap-Rescue (#8, nur Claude): unauflösbare Figuren-Klarnamen aus Szenen/Events dem Katalog
      // zuordnen (mutiert figNameToIdLower in place), BEVOR remapSzenen/remapAssignments sie droppen.
      // Non-fatal (AbortError propagiert); no-op wenn alle Namen bereits auflösbar sind.
      await resolveRemapNames(ctx, { chapterSzenen, chapterAssignments, figuren, figNameToId, figNameToIdLower });
      const szenen = writeSzenen
        ? remapSzenen(chapterSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, idMaps.chNameToId, log)
        : [];
      const assignments = writeEvents
        ? remapAssignments(chapterAssignments, figNameToId, figNameToIdLower, idMaps.chNameToId, log, jobId)
        : [];
      updateJob(jobId, { progress: 76, statusText: 'job.phase.savingScenes' });
      // Szenen: auflösen + Within-Run-Dedup EINMAL, damit Judge und Speichern auf
      // derselben Liste arbeiten (die Plan-Indizes zeigen sonst ins Leere). Danach den
      // Graubereich des Cross-Run-Matchings beurteilen lassen — Titel-Varianten derselben
      // Szene sind der häufigste stale-Dubletten-Grund.
      const szenenResolved = resolveSzenenForSave(szenen, idMaps);
      let szeneHint = null;
      try {
        const plan = planSzenenMatch(bookIdInt, email, szenenResolved.szenen, locIdToDbId);
        if (plan.unsure.length) {
          szeneHint = await judgeEntityPairs(ctx, 'szene', {
            incoming: szenenResolved.szenen, existing: plan.existing, unsure: plan.unsure,
          });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`Szenen-Match-Judge übersprungen (${e.message}) – Matching bleibt regelbasiert.`);
      }
      szenenResult = saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId,
        { resolved: szenenResolved, matchHint: szeneHint && szeneHint.size ? szeneHint : null,
          writeSzenen, writeEvents });
      if (!writeSzenen) szenenResult.szenenCount = countSzenenInDb(bookIdInt, email);
      backfillLocationChaptersFromScenes(bookIdInt, email);
    } else {
      log.info('Szenen und Lebensereignisse auf Wunsch übersprungen – bestehender Bestand bleibt.');
      // Die Orte hat P3 trotzdem neu geschrieben (haeufigkeit=1) — Haeufigkeit aus dem
      // bestehenden Szenen-Bestand wieder ableiten.
      backfillLocationChaptersFromScenes(bookIdInt, email);
      updateJob(jobId, { progress: 76 });
    }
    // Kapitel-Auftritte neu aufbauen — Full-Replace, JETZT liegen alle drei Quellen vor:
    // KI-`kapitel` aus Phase 2 (`figuren`) + die eben gespeicherten Szenen/Ereignisse.
    // Phase 2 schreibt den Index bewusst nicht (Begründung an rebuildFigureAppearances).
    // Non-fatal: bei Fehler bleibt der Stand des letzten vollständigen Laufs stehen.
    try {
      const { figuren: appFiguren, paare } = rebuildFigureAppearances(bookIdInt, email, figuren, idMaps);
      log.info(`Kapitel-Auftritte neu aufgebaut – ${paare} Paare für ${appFiguren} Figuren (figure_appearances).`);
    } catch (e) {
      log.warn(`Kapitel-Auftritts-Aufbau fehlgeschlagen: ${e.message}`);
    }
    pt.mark('P5 Szenen');

    // Zeitstrahl (P6) — die Phase kapselt ihre Fehler selbst. Die Kontinuitätsprüfung
    // (P8 samt Verify und Attribut-Detektor) und das Erzählprofil gehören NICHT mehr in
    // diesen Job: sie laufen als eigene Prüf-Jobs nach dem Katalog (./pruef-jobs.js).
    await runZeitstrahlPhase(ctx, { skip: !scope.ereignisse });
    pt.mark('P6 Zeitstrahl');

    // ── Coverage-Self-Audit (F2, non-critical, nur Claude): Extraktions-Recall messbar machen ──
    let coverage = null;
    if (isCloudModel && scope.coverage) {
      const orteNamen = db.prepare(
        'SELECT name FROM locations WHERE book_id = ? AND user_email IS ? AND stale = 0 ORDER BY sort_order'
      ).all(bookIdInt, email).map(o => o.name);
      coverage = await runNonCritical('Coverage-Self-Audit',
        () => runCoverageAudit(ctx, figuren.map(f => f.name), orteNamen), log);
      if (coverage && coverage.score != null) {
        const minScore = Number(appSettings.get('ai.komplett.coverage_min_score')) || 0.8;
        if (coverage.score < minScore) warnings.push({ key: 'job.warn.coverageLow', params: { score: coverage.score } });
      }
      pt.mark('Coverage-Audit');
    }

    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    // F5: Konsolidierungs-Checkpoint schreiben — ein unveränderter Folgelauf überspringt
    // P2–P6. Byte-identische Extraktion → identische Sig → HIT; jede Änderung verschiebt die Sig.
    //
    // NICHT, wenn ein Katalog-Schritt abgewählt war: der Marker behauptet „P2–P6 sind für
    // diesen Stand erledigt". Sonst bliebe der nächste Voll-Lauf am Short-Circuit hängen und
    // holte die abgewählten Schritte nie nach. Die Prüf-Schritte zählen hier nicht — sie
    // laufen als eigene Jobs und hängen nicht an diesem Marker.
    if (!catalogScopeFull) {
      log.info('Konsolidierungs-Checkpoint übersprungen – Teil-Lauf (abgewählte Katalog-Schritte sind nicht gelaufen).');
    } else {
      saveCheckpoint(CONSOLIDATION_CP_TYPE, bookIdInt, email, {
        sig: consolidationSig,
        figCount: figuren.length, orteCount: orte.length,
        songsCount, szenenCount: szenenResult.szenenCount,
      });
    }
    // Prüfung nach dem Katalog: als eigene Jobs eingereiht, die den fertigen Katalog lesen.
    const pruefJobs = enqueuePruefJobs({ bookId: bookIdInt, bookName, userEmail: email, scope, provider: effectiveProvider });
    log.info(`Phasen-Timing: ${pt.summary()}`);
    // Kosten-Aufschlüsselung: das ai_cost_ledger hält nur eine Summe pro Job, hier
    // steht, WO sie entstand (Extraktions-Tier vs. Rest). Erst damit ist nachweisbar,
    // ob eine Tier-/Effort-Umstellung wirklich gespart hat — und der Coverage-Score
    // daneben zeigt, ob es Recall gekostet hat.
    const costByPhase = summarizeCostByPhase(tok);
    if (costByPhase) log.info(`Kosten: ${formatCostByPhase(costByPhase)} → $${costByPhase.totalUsd.toFixed(2)}`);
    completeJob(jobId, {
      figCount:    figuren.length,
      orteCount:   orte.length,
      songsCount,
      szenenCount: szenenResult.szenenCount,
      warnings,
      ...(fullScope ? {} : { skippedSteps }),
      ...(coverage ? { coverage } : {}),
      ...(costByPhase ? { costByPhase } : {}),
      ...(Object.keys(pruefJobs).length ? { pruefJobs } : {}),
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `fig=${figuren.length} orte=${orte.length} songs=${songsCount} szenen=${szenenResult.szenenCount}${coverage?.score != null ? ` cov=${coverage.score}` : ''}${warnings.length ? ` warn=${warnings.length}` : ''}`);
    // Neue Szenen/Figuren/Orte/Fakten in den Embedding-Index holen (läuft schon
    // einer, hängt sich ein Folgelauf an). Non-fatal: die Analyse ist fertig.
    try { require('../embed-index').enqueueEmbedIndexJob(bookIdInt, null); }
    catch (e) { log.warn(`Embed-Index nach Komplettanalyse nicht eingereiht: ${e.message}`); }
  } catch (e) {
    if (e.name !== 'AbortError') {
      const cause = e.cause?.message || e.cause?.code || '';
      log.error(`Fehler: ${e.message}${cause ? ' (cause: ' + cause + ')' : ''}`);
    }
    failJob(jobId, e);
  }
}

// ── Nacht-Cron: Komplettanalyse für alle Bücher × alle User ──────────────────
async function runKomplettAnalyseAll() {
  const cronProvider = appSettings.get('ai.provider') || 'claude';
  const cronHostOk = cronProvider === 'openai-compat' ? !!appSettings.get('ai.openai-compat.host')
                   : cronProvider === 'ollama'        ? !!appSettings.get('ai.ollama.host')
                   : true;
  if (!cronHostOk) {
    logger.info(`Nacht-Analyse übersprungen: ai.${cronProvider}.host nicht konfiguriert.`);
    return;
  }

  const activeUsers = appUsers.listUsers().filter(u => u.status === 'active');
  if (!activeUsers.length) {
    logger.warn('Nacht-Analyse übersprungen: keine aktiven User.');
    return;
  }

  const books = await contentStore.listBooks(null);
  if (!books.length) {
    logger.info('Nacht-Analyse: keine Bücher vorhanden.');
    return;
  }

  // Pro Buch nur User mit book_access enqueuen — Privacy-Boundary respektiert.
  const accessByBook = new Map();
  for (const u of activeUsers) {
    for (const row of bookAccess.listBookIdsForUser(u.email)) {
      if (!accessByBook.has(row.book_id)) accessByBook.set(row.book_id, []);
      accessByBook.get(row.book_id).push(u.email);
    }
  }

  logger.info(`Nacht-Analyse: ${books.length} Buch/Bücher, ${activeUsers.length} aktive User.`);
  let queued = 0;
  for (const book of books) {
    const emails = accessByBook.get(book.id) || [];
    for (const email of emails) {
      // Auch ein Standalone-Teil-Job blockiert: der Cron-Lauf ohne Umfang enthält alle Schritte.
      if (findActiveJobId('komplett-analyse', book.id, email) || activeStepJob(book.id, email)) {
        logger.info(`Nacht-Analyse: Buch ${book.id} / ${email} – Komplettanalyse oder Teil-Job läuft bereits – überspringe.`);
        continue;
      }
      const label = `Nacht · ${book.name}`;
      const jobId = createJob('komplett-analyse', book.id, email, label);
      enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book.id, book.name, email, cronProvider));
      queued++;
    }
  }
  logger.info(`Nacht-Analyse: ${queued} Job(s) in Warteschlange eingereiht.`);
}

module.exports = { runKomplettAnalyseJob, runKomplettAnalyseAll };
