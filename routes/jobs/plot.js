'use strict';
// Plot-Werkstatt (Beat-Board): Brainstorm + Consistency als Job-Queue-Operationen.
// Beide Jobs operieren auf dem Board (plot_acts + plot_beats). Rein planend /
// überwachend — es wird NIE Text ins Manuskript geschrieben.
//
// Kontext-Loader + Budget: ./plot/context.js. Pure Nachbearbeitung des Consistency-
// Outputs + Vorlauf-Auswahl (Delta-Check): ./plot/result.js.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts,
  tps, createJob, enqueueJob, findActiveJobId, jsonBody, _modelName,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { resolveProvider } = require('../../lib/ai');
const { setContext } = require('../../lib/log-context');
const plotDb = require('../../db/plot');
const {
  commonPlotContext, consistencyExtras, rechercheContext, anchorContext, prioritize,
} = require('./plot/context');
const { normalizeKonflikte, normalizeErledigt, buildDeltaContext } = require('./plot/result');
const { resolveBeatRefs } = require('./plot/beat-refs');

const plotRouter = express.Router();

// Output-Budget: adaptives Denken (Claude 4.7+/5) zählt gegen max_tokens. Eine
// knappe Grenze bricht die JSON-Antwort nach dem Denken ab (truncated → Job-Fehler).
// Gedeckelt per Math.min gegen den Provider-Cap. Consistency auf grossem Board
// (~90 Beats + Vorlauf-Delta) braucht auf Opus 5.x mit Default-Effort mehr als 16K
// allein fürs Denken; der Deckel kostet nichts, gezahlt wird nur der echte Output.
const BRAINSTORM_MAX_TOKENS = 16000;
const CONSISTENCY_MAX_TOKENS = 48000;

// Zielakt passt zum Strang (Hybrid-Akte): ein Strang mit eigener Aktstruktur
// brainstormt nur in seinen eigenen Akten, ein Strang ohne (und die „ohne
// Strang"-Lane) nur in geteilten Akten — sonst landete ein Vorschlag in einer
// Zelle, die das Board gar nicht rendert.
function brainstormActFitsThread(act, threadId, threadHasOwnActs) {
  if (threadId == null) return act.thread_id == null;
  return threadHasOwnActs ? act.thread_id === threadId : act.thread_id == null;
}

// Belege je Beat aus dem Verankerungs-Index (stärkste Fundstelle mit page_id).
function _belegById(beats, anchorMap) {
  const out = {};
  if (!anchorMap) return out;
  for (const b of beats) {
    const top = (anchorMap[b.id]?.top || []).find(t => t.page_id);
    if (top) out[b.id] = { page_id: top.page_id, page_name: top.page_name || null };
  }
  return out;
}

// ── Brainstorm-Job ────────────────────────────────────────────────────────────

async function runPlotBrainstormJob(jobId, bookId, actId, threadId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildPlotSystemPrompt, buildPlotBrainstormPrompt, SCHEMA_PLOT_BRAINSTORM } = await getPrompts(userEmail);

  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const act = acts.find(a => a.id === actId);
    if (!act) throw i18nError('job.error.plot.actMissing');

    const ctx = await commonPlotContext(bookId, userEmail);
    const { BUCH_KONTEXT, limits, beats, outlineBeats, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, threads, kuerzungen, locale } = ctx;
    const threadInfo = threadId != null ? (threads.find(t => t.id === threadId) || null) : null;
    // Recherche nur für die Zielzelle: an einen Beat dieses Akts ODER den Ziel-Strang
    // geknüpftes Material.
    const actBeatIds = new Set(beats.filter(b => b.act_id === actId).map(b => b.id));
    const rech = prioritize(rechercheContext(bookId, userEmail)
      .filter(r => r.beatIds.some(id => actBeatIds.has(id))
        || (threadId != null && r.threadIds.includes(threadId))), limits.recherche);
    kuerzungen.recherche = { shown: rech.items.length, total: rech.total };

    logger.info(`Plot-Brainstorm Start: book=${bookId} akt="${act.name}"#${act.id}${threadInfo ? ` strang="${threadInfo.name}"` : ''} beats=${beats.length} figuren=${figuren.length} orte=${orte.length} zeitstrahl=${zeitstrahl.length} werkstatt=${werkstattFiguren.length} recherche=${rech.items.length} locale=${locale}`);
    updateJob(jobId, { statusText: 'job.plot.brainstorm.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildPlotBrainstormPrompt(act.id, acts, outlineBeats, BUCH_KONTEXT, figuren, kapitel, werkstattFiguren, threads, threadInfo, orte, zeitstrahl, rech.items,
        { locale, kuerzungen, descMax: limits.descMax }),
      buildPlotSystemPrompt(),
      10, 95, 1500, 0.3, BRAINSTORM_MAX_TOKENS, undefined, SCHEMA_PLOT_BRAINSTORM,
    );

    if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.plot.vorschlaegeMissing');
    // [#id]-Marker → «Titel»: Label und Begründung werden beim Übernehmen Titel und
    // Beschreibung des neuen Beats (plot/beat-refs.js).
    const titleOf = new Map(beats.map(b => [b.id, b.titel]));
    const vorschlaege = result.vorschlaege
      .filter(v => v && typeof v.label === 'string' && v.label.trim())
      .map(v => ({
        label: resolveBeatRefs(v.label.trim(), titleOf),
        begruendung: typeof v.begruendung === 'string' ? resolveBeatRefs(v.begruendung.trim(), titleOf) : '',
      }));

    // Lauf historisieren (nur bei echten Vorschlägen). Best-effort.
    let runId = null;
    if (vorschlaege.length) {
      try {
        runId = plotDb.insertPlotBrainstormRun({
          bookId, userEmail, actId, threadId: threadId ?? null,
          vorschlagCount: vorschlaege.length,
          result: { vorschlaege }, model: _modelName(resolveProvider({ userEmail })),
        });
      } catch (e) {
        logger.warn(`Plot-Brainstorm-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`);
      }
    }

    completeJob(jobId, { vorschlaege, actId, threadId: threadId ?? null, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${vorschlaege.length} Vorschläge für "${act.name}"`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Plot-Brainstorm-Fehler book=${bookId}: ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

// ── Consistency-Job ───────────────────────────────────────────────────────────

// Neuester Konsistenz-Lauf (Buch + User) als Vorlauf. Best-effort: ohne lesbaren
// Vorlauf läuft der Check normal.
function _loadVorlauf(bookId, userEmail, logger) {
  try {
    const last = plotDb.listPlotConsistencyRuns(bookId, userEmail)[0];
    return last ? plotDb.getPlotConsistencyRun(last.id) : null;
  } catch (e) {
    logger.warn(`Plot-Consistency: Vorlauf nicht lesbar book=${bookId}: ${e.message}`);
    return null;
  }
}

async function runPlotConsistencyJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const {
    buildPlotSystemPrompt, buildPlotConsistencyPrompt, buildPlotConsistencySchema,
    PLOT_KONFLIKT_TYP_ENUM, PLOT_AKTION_REL_TYPES,
  } = await getPrompts(userEmail);

  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const ctx = await commonPlotContext(bookId, userEmail);
    const { BUCH_KONTEXT, limits, beats, outlineBeats, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, threads, kuerzungen, locale } = ctx;
    if (!beats.length) throw i18nError('job.error.plot.boardEmpty');

    const { szenen, kontinuitaet, recherche, relations, weltgesetze } = consistencyExtras(bookId, userEmail, ctx);
    // Textbeleg-Verankerung: nur bei befülltem Index (sonst „nie gescannt" statt
    // „nicht im Buch" → falsche Drift-Flut).
    const { anchorMap, anchorInfo } = anchorContext(bookId, userEmail);
    // Delta-Check gegen den letzten Lauf.
    const vorlauf = _loadVorlauf(bookId, userEmail, logger);
    const delta = buildDeltaContext(vorlauf, beats, { maxKonflikte: limits.vorlauf });

    logger.info(`Plot-Consistency Start: book=${bookId} beats=${beats.length}/${outlineBeats.length} szenen=${szenen.length} kapitel=${kapitel.length} orte=${orte.length} zeitstrahl=${zeitstrahl.length} kontinuitaet=${kontinuitaet.length} werkstatt=${werkstattFiguren.length} straenge=${threads.length} recherche=${recherche.length} relationen=${relations.length} textbelege=${anchorMap ? Object.keys(anchorMap).length : 'aus'} weltgesetze=${weltgesetze.length} vorlauf=${delta ? `#${delta.runId} (${delta.konflikteTotal} Befunde, ${delta.geaendert.length} geändert)` : 'keiner'} locale=${locale}`);
    updateJob(jobId, { statusText: 'job.plot.consistency.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildPlotConsistencyPrompt(acts, outlineBeats, kapitel, szenen, figuren, BUCH_KONTEXT, werkstattFiguren, threads, orte, zeitstrahl, kontinuitaet, recherche, anchorMap, anchorInfo, relations, weltgesetze,
        { locale, kuerzungen, descMax: limits.descMax, delta }),
      buildPlotSystemPrompt(),
      10, 95, 6000, 0.3, CONSISTENCY_MAX_TOKENS, undefined, buildPlotConsistencySchema({ delta: !!delta }),
    );

    if (!Array.isArray(result?.konflikte)) throw i18nError('job.error.plot.konflikteMissing');
    if (typeof result.fazit !== 'string') throw i18nError('job.error.plot.fazitMissing');
    if (result.erledigt != null && !Array.isArray(result.erledigt)) throw i18nError('job.error.plot.erledigtInvalid');

    // Befunde auf den Vertrag bringen: beat_id aufs volle Board validiert (eindeutiger
    // Titel als Fallback), Typ/Schwere auf die Enums, Aktion serverseitig geprüft,
    // klickbare Fundstelle deterministisch aus dem Verankerungs-Index.
    const konflikte = normalizeKonflikte(result.konflikte, {
      beats, belegById: _belegById(beats, anchorMap),
      typEnum: PLOT_KONFLIKT_TYP_ENUM, relTypes: PLOT_AKTION_REL_TYPES, hasDelta: !!delta,
    });
    const erledigt = normalizeErledigt(result.erledigt, !!delta, beats);
    const fazit = result.fazit.trim();
    const vorlaufRunId = delta ? delta.runId : null;

    // Lauf historisieren. Best-effort: ein DB-Fehler hier darf das Resultat nicht verschlucken.
    let runId = null;
    try {
      runId = plotDb.insertPlotConsistencyRun({
        bookId, userEmail, konfliktCount: konflikte.length,
        result: { konflikte, fazit, erledigt, vorlauf_run_id: vorlaufRunId },
        model: _modelName(resolveProvider({ userEmail })),
      });
    } catch (e) {
      logger.warn(`Plot-Consistency-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`);
    }

    completeJob(jobId, { konflikte, fazit, erledigt, vorlaufRunId, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${konflikte.length} Konflikte`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Plot-Consistency-Fehler book=${bookId}: ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

plotRouter.post('/plot-brainstorm', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  const actId = toIntId(req.body?.act_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!actId)  return res.status(400).json({ error_code: 'ACT_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const userEmail = sessionEmail(req);

  const act = plotDb.getAct(actId);
  if (!act || act.book_id !== bookId || act.user_email !== userEmail) {
    return res.status(404).json({ error_code: 'ACT_NOT_FOUND' });
  }
  // Optionaler Strang (Grid): aufs (Buch, User)-Subset validieren, Fremd/leer → null.
  const threadId = plotDb._validThreadId(bookId, userEmail, toIntId(req.body?.thread_id));
  const ownActs = threadId != null && plotDb.threadHasOwnActs(bookId, userEmail, threadId);
  if (!brainstormActFitsThread(act, threadId, ownActs)) {
    return res.status(400).json({ error_code: 'ACT_THREAD_MISMATCH' });
  }

  const entityKey = `${bookId}|brainstorm|${actId}|${threadId || 'none'}`;
  const existing = findActiveJobId('plot-brainstorm', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('plot-brainstorm', bookId, userEmail, 'job.label.plotBrainstorm', { akt: act.name }, entityKey);
  enqueueJob(jobId, () => runPlotBrainstormJob(jobId, bookId, actId, threadId, userEmail));
  res.json({ jobId });
});

plotRouter.post('/plot-consistency', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const userEmail = sessionEmail(req);

  const existing = findActiveJobId('plot-consistency', bookId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('plot-consistency', bookId, userEmail, 'job.label.plotConsistency', {}, bookId);
  enqueueJob(jobId, () => runPlotConsistencyJob(jobId, bookId, userEmail));
  res.json({ jobId });
});

module.exports = { plotRouter, runPlotBrainstormJob, runPlotConsistencyJob, brainstormActFitsThread };
