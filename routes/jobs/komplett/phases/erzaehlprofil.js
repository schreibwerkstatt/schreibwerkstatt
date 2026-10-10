'use strict';
// Phase «Erzählprofil»: pro Kapitel Erzählperspektive/-zeit + Erzähler-/Fokusfigur,
// POV-Konfidenz/Beleg, Spannungs-Intensität (Pacing) und dominante Themen/Motive/Symbole.
// Single-Pass (Claude, ganzes Buch → ein Call gegen den gecachten Buchtext-Block wie P8) bzw.
// Multi-Pass (lokal/grosses Buch → ein Call pro Kapitel, concurrency wie Coverage-Audit).
// Non-critical, read-only Endphase: ein Fehler darf den bereits gespeicherten Katalog nicht
// kippen (Kapselung im Aufrufer via runNonCritical).
//
// Teil-Degradierungen landen als `ctx.warnings` (job.warn.*) im Job-Result statt nur im Log:
// im Multi-Pass gescheiterte Kapitel (ihr bisheriges Profil bleibt stehen) und ein
// gescheiterter Autoren-Befund (der alte wird dann gelöscht — er beschriebe ein Profil,
// das es so nicht mehr gibt).
const { saveChapterNarrativeProfiles, getBookSettings } = require('../../../../db/schema');
const { getNarrativeReport, saveAutorenBefund, deleteAutorenBefund } = require('../../../../db/narrative-report');
const { updateJob, toSystemBlocks, retryOnTransientAi, settledAll, i18nError } = require('../../shared');
const { buildBookSystemBlockText } = require('../utils');
const { komplettMaxTokens } = require('./tokens');
const { COST_LABEL, costTier } = require('../cost-labels');
const { withTtl } = require('../call');
const { providerClass } = require('../../../../lib/ai');

/** @returns {number} Anzahl gespeicherter Kapitel-Profile (0 wenn nichts erzeugt). */
async function runErzaehlprofil(ctx, opts = {}) {
  const {
    jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider,
    singlePassLimit, totalChars, fullBookText, pageContents, groups, groupOrder, idMaps, prompts, sys,
  } = ctx;
  const { figNameToId = {}, fromPct = 98, toPct = 99 } = opts;
  if (!groupOrder?.length) return 0;

  const cap = komplettMaxTokens(effectiveProvider);
  const singlePass = totalChars <= singlePassLimit && providerClass(effectiveProvider) === 'cloud';
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.narrativeProfile' });

  const warn = (w) => { if (Array.isArray(ctx.warnings)) ctx.warnings.push(w); };
  // Buchreihenfolge der Kapitel (SSoT für sort_order — nicht die Array-Position der
  // Modell-Antwort, die im Single-Pass vertauschen oder auslassen kann).
  const chapterOrder = groupOrder.filter(k => k !== '__ungrouped__').map(Number).filter(Number.isFinite);
  // Kapitel, deren Multi-Pass-Call scheiterte: ihr bisheriges Profil bleibt erhalten.
  let keepChapterIds = [];
  let profiles = [];
  if (singlePass) {
    // Ein Call über das ganze Buch → Array pro Kapitel. Buchtext im gecachten
    // System-Block (identisch zu P8/P1 → 1h-Cache-Read statt Neuübertragung).
    // Standalone-Job: ctx.bookBlockTtl = '5m' (einziger Leser, siehe ../call.js#withTtl).
    const ttl = ctx.bookBlockTtl || '1h';
    const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h', sharedPrefix: true };
    const res = await retryOnTransientAi(() => call(jobId, tok,
      prompts.buildErzaehlprofilSinglePassPrompt(bookName, null),
      withTtl([bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, '1h')], ttl),
      fromPct, toPct, cap, 0.2, null, prompts.SCHEMA_ERZAEHLPROFIL, costTier(COST_LABEL.erzaehlprofil),
    ), { log, label: 'Erzählprofil Single-Pass' });
    if (!Array.isArray(res?.kapitel)) throw i18nError('job.error.narrativeProfileMissing');
    profiles = res.kapitel;
  } else {
    // Ein Call pro Kapitel, parallel (concurrency 3 wie Coverage-Audit). Kapitel ist
    // bekannt → Schema ohne kapitel-Feld; wir hängen Name + ID selbst an. Abschnitte
    // ohne Kapitel (`__ungrouped__`) bekommen kein Profil.
    const keys = groupOrder.filter(k => k !== '__ungrouped__');
    const results = await settledAll(keys.map((key, gi) => () => {
      const group = groups.get(key);
      const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
      const fp = fromPct + Math.round(((gi) / keys.length) * (toPct - fromPct));
      const tp = fromPct + Math.round(((gi + 1) / keys.length) * (toPct - fromPct));
      return retryOnTransientAi(() => call(jobId, tok,
        prompts.buildErzaehlprofilChapterPrompt(bookName, group.name, chText),
        toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS),
        fp, tp, cap, 0.2, null, prompts.SCHEMA_ERZAEHLPROFIL_CHAPTER, costTier(COST_LABEL.erzaehlprofil),
      ), { log, label: `Erzählprofil «${group.name}»` })
        .then(r => (r ? { ...r, kapitel: group.name, chapter_id: Number(key) } : null));
    }), { concurrency: 3 });
    profiles = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    const aborted = results.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
    if (aborted) throw aborted.reason;
    const failedIdx = results.map((r, i) => (r.status === 'rejected' ? i : -1)).filter(i => i >= 0);
    if (failedIdx.length && !profiles.length) throw results[failedIdx[0]].reason;
    if (failedIdx.length) {
      keepChapterIds = failedIdx.map(i => Number(keys[i]));
      const names = failedIdx.map(i => groups.get(keys[i])?.name).filter(Boolean);
      log.warn(`Erzählprofil: ${failedIdx.length}/${keys.length} Kapitel übersprungen (bisheriges Profil bleibt): ${names.join(', ')}`);
      warn({ key: 'job.warn.narrativeProfileChaptersSkipped', params: { chapters: names.join(', '), count: failedIdx.length } });
    }
  }

  if (!profiles.length) { log.warn('Erzählprofil: keine auswertbaren Kapitel.'); return 0; }
  const bs = getBookSettings(bookIdInt, email);
  const declared = { erzaehlperspektive: bs?.erzaehlperspektive || null, erzaehlzeit: bs?.erzaehlzeit || null };
  const saved = saveChapterNarrativeProfiles(bookIdInt, email, profiles, idMaps.chNameToId, figNameToId,
    { chapterOrder, keepChapterIds });
  if (saved < profiles.length) log.info(`Erzählprofil: ${profiles.length - saved} Einträge ohne Kapitel-Zuordnung verworfen.`);
  log.info(`Erzählprofil gespeichert: ${saved} Kapitel${singlePass ? ' (Single-Pass)' : ' (Multi-Pass)'}.`);

  // KI-Dach-Befund (Autoren-Befund) über die jetzt frisch berechenbaren, DETERMINISTISCHEN
  // Struktur-Befunde. Nur Cloud-Klasse, non-critical (Fehler kippt das Kapitel-Profil nicht).
  // Ohne neuen Befund darf der alte nicht neben dem frischen Profil als aktuell stehen:
  // er verdichtet Struktur-Befunde eines Profils, das so nicht mehr existiert.
  if (saved > 0 && providerClass(effectiveProvider) === 'cloud') {
    try {
      await runAutorenBefund(ctx, { declared, fromPct: toPct, toPct });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Autoren-Befund übersprungen, alter Befund entfernt: ${e.message}`);
      deleteAutorenBefund(bookIdInt, email);
      warn({ key: 'job.warn.autorenBefundFailed' });
    }
  } else if (saved > 0) {
    deleteAutorenBefund(bookIdInt, email);
  }
  return saved;
}

/** Verdichtet die deterministischen Struktur-Befunde zu einer priorisierten
 *  Autoren-Einschätzung (ein Claude-Call, non-critical). Persistiert in narrative_report. */
async function runAutorenBefund(ctx, { declared, fromPct, toPct }) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider, prompts, sys } = ctx;
  const befund = getNarrativeReport(bookIdInt, email);
  if (!befund || befund.tooFewChapters || !befund.chapterCount) {
    // Unter der Kapitel-Schwelle gibt es keinen Befund — ein älterer Autoren-Befund
    // würde sonst neben einem Profil stehen bleiben, zu dem er nicht mehr passt.
    deleteAutorenBefund(bookIdInt, email);
    return;
  }
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.narrativeProfile' });
  const cap = komplettMaxTokens(effectiveProvider);
  const res = await retryOnTransientAi(() => call(jobId, tok,
    prompts.buildAutorenBefundPrompt(bookName, _computedOnly(befund), declared),
    toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS),
    fromPct, toPct, 4000, 0.5, null, prompts.SCHEMA_AUTOREN_BEFUND, costTier(COST_LABEL.erzaehlprofil),
  ), { log, label: 'Autoren-Befund' });
  if (!Array.isArray(res?.befunde)) throw i18nError('job.error.autorenBefundMissing');
  const befunde = res.befunde;
  saveAutorenBefund(bookIdInt, email, { zusammenfassung: res?.zusammenfassung || '', befunde });
  log.info(`Autoren-Befund gespeichert: ${befunde.length} Einträge.`);
}

/** Befund ohne die mangels Daten nicht berechneten Abschnitte: ein leeres Array liest
 *  das Modell sonst als «geprüft, nichts gefunden» und baut daraus einen Befund. */
function _computedOnly(befund) {
  const { computed = {}, ...rest } = befund;
  const out = { ...rest };
  if (!computed.encounters) delete out.encounters;
  if (!computed.spans) {
    delete out.droppedMotifs;
    out.locations = { oneOff: rest.locations?.oneOff || [] };
  }
  if (!computed.eventDeserts) delete out.eventDeserts;
  return out;
}

module.exports = { runErzaehlprofil, _computedOnly };
