'use strict';
// Phase 3b: kapitelübergreifende Beziehungen (Multi-Pass) · Phase 6: Zeitstrahl.
const { addFigurenBeziehungen, saveZeitstrahlEvents } = require('../../../../db/schema');
const { listFigureEventsForTimeline } = require('../../../../db/zeitstrahl');
const { i18nError, updateJob, toSystemBlocks } = require('../../shared');
const { buildBookSystemBlockText, consolidationFitsCap } = require('../utils');
const { komplettMaxTokens } = require('./tokens');
const { providerClass, getContextConfigFor } = require('../../../../lib/ai');
const appSettings = require('../../../../lib/app-settings');
const { COST_LABEL, costTier } = require('../cost-labels');

// Obergrenze für den Co-Occurrence-Auszug, wenn das Buch NICHT als gecachter Block
// mitgeht: der Auszug steht ungecacht im User-Turn. Mit der Single-Pass-Grenze als
// Deckel war das bei grossen Casts fast das ganze Buch pro Lauf (~1,5 Mio Zeichen).
const P3B_EXCERPT_MAX_CHARS = 200000;

/**
 * Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass).
 * Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
 * Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
 * verschiedener Kapitel hier nachträglich identifiziert.
 */
async function runPhase3b(ctx, figuren) {
  const { jobId, log, sys, singlePassLimit, bookName, fullBookText, pageContents, effectiveProvider } = ctx;

  updateJob(jobId, { progress: 56, statusText: 'job.phase.crossChapterRelations' });

  // Passt das ganze Buch ins Fenster (Cloud; Extraktion nur per extract_single_pass_cap
  // in Chunks gezwungen), geht es als derselbe 1h-Buchblock wie in P8 mit — P3b schreibt
  // ihn, P8 liest ihn (gleiches Tier, kein Schema: ../call.js). Billiger als ein
  // ungecachter Auszug und vollständiger.
  if (providerClass(effectiveProvider) === 'cloud' && fullBookText && fullBookText.length <= singlePassLimit) {
    const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h', sharedPrefix: true };
    log.info(`Phase 3b – ganzes Buch (${fullBookText.length} Zeichen) als gecachter Buchblock.`);
    return _runPhase3bCall(ctx, figuren, null, [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_FIGUREN_BLOCKS, '1h')]);
  }
  const excerptMax = Math.min(singlePassLimit, P3B_EXCERPT_MAX_CHARS);

  // Welle 3 · Co-Occurrence-basierter Textauswahl: Statt fullBookText zu trunkieren
  // (was bei lokalen Modellen bis zu 2/3 des Buchs verwirft), zielen wir auf
  // die Seiten ab, wo mindestens zwei Figuren aus verschiedenen Kapiteln gemeinsam
  // vorkommen. Das liefert dichtere Evidenz bei viel kleinerem Token-Budget.
  let textForPrompt = null;

  try {
    const { computeFigureMentions } = require('../../../../lib/page-index');
    const figInput = figuren.map(f => ({ id: f.id, name: f.name, kurzname: f.kurzname || '' }));
    const figPages = new Map();
    for (let pi = 0; pi < pageContents.length; pi++) {
      const mentions = computeFigureMentions(pageContents[pi].text, figInput);
      for (const m of mentions) {
        if (!figPages.has(m.figure_id)) figPages.set(m.figure_id, new Set());
        figPages.get(m.figure_id).add(pi);
      }
      // Event-Loop freigeben: bei grossen Büchern (Multi-Pass-Fall, viele Seiten × Figuren)
      // ist dieser synchrone Scan sonst sekundenlang blockierend für den Job-Worker.
      if (pi % 50 === 49) await new Promise(r => setImmediate(r));
    }
    const figToHome = Object.fromEntries(figuren.map(f => [f.id, (f.kapitel || [])[0]?.name || null]));
    const existingPairs = new Set();
    for (const f of figuren) {
      for (const b of (f.beziehungen || [])) {
        const [a, c] = f.id < b.figur_id ? [f.id, b.figur_id] : [b.figur_id, f.id];
        existingPairs.add(`${a}|${c}`);
      }
    }
    const candidatePageIdx = new Set();
    const figIds = figuren.map(f => f.id);
    for (let i = 0; i < figIds.length; i++) {
      for (let j = i + 1; j < figIds.length; j++) {
        const a = figIds[i], b = figIds[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (existingPairs.has(key)) continue;
        if (figToHome[a] && figToHome[b] && figToHome[a] === figToHome[b]) continue;
        const pa = figPages.get(a), pb = figPages.get(b);
        if (!pa || !pb) continue;
        // Schnittmenge über das KLEINERE Set iterieren (O(min) statt O(|pa|)).
        const [small, big] = pa.size <= pb.size ? [pa, pb] : [pb, pa];
        for (const pi of small) if (big.has(pi)) candidatePageIdx.add(pi);
      }
      // O(F²)-Paarschleife in Mikro-Batches: Worker-Event-Loop nicht sekundenlang blockieren.
      if (i % 25 === 24) await new Promise(r => setImmediate(r));
    }
    if (candidatePageIdx.size > 0) {
      const sortedIdx = [...candidatePageIdx].sort((x, y) => x - y);
      const parts = [];
      let total = 0;
      for (const pi of sortedIdx) {
        const p = pageContents[pi];
        const chunk = `## ${p.chapter || 'Sonstige'}\n### ${p.title}\n${p.text}`;
        if (total + chunk.length > excerptMax) break;
        parts.push(chunk);
        total += chunk.length;
      }
      if (parts.length > 0) {
        textForPrompt = parts.join('\n\n---\n\n');
        log.info(`Phase 3b Co-Occurrence – ${parts.length} Seiten (${total} Zeichen) aus ${candidatePageIdx.size} Kandidaten.`);
      }
    }
  } catch (e) {
    log.warn(`Phase 3b Co-Occurrence-Auswahl fehlgeschlagen, Fallback auf Trunkierung: ${e.message}`);
  }

  if (!textForPrompt) {
    textForPrompt = fullBookText.length <= excerptMax ? fullBookText : fullBookText.slice(0, excerptMax);
  }
  return _runPhase3bCall(ctx, figuren, textForPrompt, sys.SYSTEM_FIGUREN_BLOCKS);
}

async function _runPhase3bCall(ctx, figuren, textForPrompt, system) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, bookName, effectiveProvider } = ctx;
  const bzResult = await call(jobId, tok,
    prompts.buildKapiteluebergreifendeBeziehungenPrompt(bookName, figuren, textForPrompt),
    system, 56, 58, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_BEZIEHUNGEN,
    costTier(COST_LABEL.figuren),
  );
  // Pflichtfeld: ein leeres Array ist gültig («keine neuen Beziehungen»), ein fehlendes
  // nicht — der Aufrufer (runNonCritical) meldet das als Degradierung.
  if (!Array.isArray(bzResult?.beziehungen)) throw i18nError('job.error.beziehungenMissing');
  const newBz = bzResult.beziehungen;
  if (newBz.length > 0) addFigurenBeziehungen(bookIdInt, newBz, email, ctx.idMaps);
  log.info(`Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen.`);
}

/** P6: Zeitstrahl aus gespeicherten Events konsolidieren. */
async function runZeitstrahl(ctx, opts = {}) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;
  // silent: keine Progress-/Status-Updates; nötig wenn parallel zu P8 (Claude),
  // damit P8 die Bar exklusiv kontrolliert.
  const silent = !!opts.silent;

  if (!silent) updateJob(jobId, { progress: 78, statusText: 'job.phase.consolidatingTimeline' });
  const rawEvtRows = listFigureEventsForTimeline(bookIdInt, email);
  if (!rawEvtRows.length) return;

  const evtGroupMap = new Map();
  for (const row of rawEvtRows) {
    const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
    if (!evtGroupMap.has(key)) {
      evtGroupMap.set(key, {
        datum: row.datum,
        datum_label:      row.datum_label,
        datum_year:       row.datum_year,
        datum_month:      row.datum_month,
        datum_day:        row.datum_day,
        datum_ende_year:  row.datum_ende_year,
        datum_ende_month: row.datum_ende_month,
        datum_ende_day:   row.datum_ende_day,
        story_tag:        row.story_tag,
        datum_unsicher:   row.datum_unsicher ? true : false,
        subtyp:           row.subtyp || 'sonstiges',
        ereignis: row.ereignis, typ: row.evt_typ,
        bedeutung: row.bedeutung || '',
        kapitel: row.kapitel ? [row.kapitel] : [],
        seiten:  row.seite   ? [row.seite]   : [],
        figuren: [],
      });
    }
    const ev = evtGroupMap.get(key);
    // Sicheres Datum gewinnt: ist eine der zusammengeführten Figuren-Zeilen
    // explizit belegt (datum_unsicher=0), gilt das Gruppen-Event als sicher.
    if (!row.datum_unsicher) ev.datum_unsicher = false;
    if (!ev.figuren.some(f => f.id === row.fig_id))
      ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
    if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
    if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
  }

  // Strukturierte Sortierung — Events ohne Jahr ans Ende.
  const _sortKey = ev => [
    ev.datum_year  ?? 9999,
    ev.datum_month ?? 99,
    ev.datum_day   ?? 99,
    ev.story_tag   ?? 99999,
  ];
  const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => {
    const ka = _sortKey(a), kb = _sortKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });

  // Bei wenigen pre-gegroupeten Events bringt die KI-Konsolidierung fast nichts
  // (Dedup-Chance klein, kanonische Formulierung marginal) – direkt speichern spart
  // einen KI-Call (~2K Input + 3K Output).
  // Obergrenze für die lokale Klasse: die Konsolidierung ist rein kosmetisch (Dedup +
  // kanonische Formulierung), ihr Output wächst aber linear mit der Ereigniszahl. Bei
  // 20-30 tok/s kostet sie ab ein paar hundert Ereignissen zweistellige Minuten für
  // einen Gewinn, den der Fallback-Pfad (pre-gruppierte Events direkt persistieren) fast
  // vollständig mitliefert — und je grösser die Liste, desto wahrscheinlicher reisst sie
  // ohnehin am Output-Cap. Die Cloud-Klasse läuft weiter ohne Deckel (dort ist der Call
  // schnell, parallel zu P8 und günstig). 0 = kein Deckel.
  const localEventCap = providerClass(effectiveProvider) !== 'cloud'
    ? Math.max(0, parseInt(appSettings.get('ai.komplett.timeline_consolidate_max'), 10) || 0)
    : 0;
  const tooMany = localEventCap > 0 && zeitstrahlEvents.length > localEventCap;
  if (zeitstrahlEvents.length < 5 || tooMany) {
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    if (tooMany) {
      log.info(`${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert `
        + `(über dem Deckel ai.komplett.timeline_consolidate_max=${localEventCap} für lokale Modelle) `
        + '– spart einen langen KI-Call, die Ereignisse sind vollständig.');
      ctx.warnings?.push({ key: 'job.warn.timelineConsolidationSkipped', params: { count: zeitstrahlEvents.length } });
    } else {
      log.info(`${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert (unter Konsolidierungs-Schwelle) – spart einen KI-Call.`);
    }
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }

  // Preflight wie Phase 2 (alle Provider): die Antwort schreibt jedes Ereignis neu aus,
  // wächst also linear mit dem Input. Sprengt sie das Cap sicher, ist die Truncation
  // bezahlt und der Fallback unten trotzdem fällig — dann gleich direkt speichern.
  const ztPrompt = prompts.buildZeitstrahlConsolidationPrompt(zeitstrahlEvents);
  const ztCap = komplettMaxTokens(effectiveProvider);
  const ztFit = consolidationFitsCap({
    promptText: ztPrompt, dataText: JSON.stringify(zeitstrahlEvents),
    charsPerToken: getContextConfigFor(effectiveProvider).charsPerToken, cap: ztCap,
  });
  if (!ztFit.fits) {
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    log.warn(`${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert – erwarteter Output `
      + `~${ztFit.estOut} Tokens über dem Cap ${ztFit.cap} (Truncation wäre sicher).`);
    ctx.warnings?.push({ key: 'job.warn.timelineConsolidationTooLarge', params: { count: zeitstrahlEvents.length } });
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }

  let ztResult;
  try {
    ztResult = await call(jobId, tok,
      ztPrompt,
      sys.SYSTEM_ZEITSTRAHL_BLOCKS,
      silent ? null : 78, silent ? null : 82,
      undefined, 0.2, ztCap, prompts.SCHEMA_ZEITSTRAHL, costTier(COST_LABEL.zeitstrahl),
    );
    // Pflichtfeld: fehlt `ereignisse`, hat das Modell nicht wie verlangt geantwortet —
    // in den Fallback unten (pre-gruppierte Events), statt still nichts zu speichern.
    if (!Array.isArray(ztResult?.ereignisse)) throw i18nError('job.error.zeitstrahlMissing');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Die Konsolidierung ist rein kosmetisch (Dedup + kanonische Formulierung) – die
    // Events sind in `zeitstrahlEvents` bereits gruppiert und vollständig. Ein Fehler hier
    // (typisch: aiTruncated bei vielen Events + kleinem lokalem Output-Cap, Parse-Fehler,
    // erschöpfter Retry) darf den gesamten Katalog NICHT verwerfen – Figuren/Orte/Szenen
    // sind längst gespeichert. Fallback: pre-gruppierte Events direkt persistieren.
    log.warn(`Zeitstrahl-Konsolidierung fehlgeschlagen, speichere ${zeitstrahlEvents.length} pre-gruppierte Events direkt: ${e.message}`);
    // Degradierung user-sichtbar machen (wie Soziogramm/Orte/Songs/P3b/P8) — sonst sieht
    // der User nur „done" und kann holistisch-konsolidiert nicht von roh-durchgereicht
    // unterscheiden. Kein Datenverlust (Events bleiben gruppiert + persistiert).
    ctx.warnings?.push({ key: 'job.warn.zeitstrahlDegraded' });
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }
  saveZeitstrahlEvents(bookIdInt, email, ztResult.ereignisse, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
  log.info(`${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert (aus ${zeitstrahlEvents.length} vorgruppierten).`);
  if (!silent) updateJob(jobId, { progress: 82 });
}

/** P6 als Endphase der Komplettanalyse: ein Fehler im Zeitstrahl (Konsolidierungs-Call
 *  oder DB-Save) darf den bereits gültig gespeicherten Katalog nicht über failJob kippen —
 *  Warnung statt Abbruch. AbortError (User-Abbruch) schlägt durch. `skip` (Teil-Lauf ohne
 *  «Ereignisse»): bestehende `zeitstrahl_events` bleiben stehen, der Aufruf entfällt. */
async function runZeitstrahlPhase(ctx, { skip = false } = {}) {
  if (skip) {
    ctx.log.info('Zeitstrahl (P6) auf Wunsch übersprungen – bestehender Zeitstrahl bleibt.');
    updateJob(ctx.jobId, { progress: 97 });
    return;
  }
  try { await runZeitstrahl(ctx); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.log.warn(`Zeitstrahl-Phase fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
    ctx.warnings.push({ key: 'job.warn.timelineFailed' });
  }
  updateJob(ctx.jobId, { progress: 97 });
}

module.exports = { runPhase3b, runZeitstrahl, runZeitstrahlPhase };
