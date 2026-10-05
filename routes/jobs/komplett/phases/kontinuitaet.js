'use strict';
// Block 2 der Komplettanalyse: Zeitstrahl (P6) und Kontinuitätsprüfung (P8)
// zusammen mit dem ergänzenden Attribut-Widerspruchs-Detektor (F4) und dem
// Persistieren des Ergebnisses.
//
// Beide Phasen sind read-only Endphasen — Figuren/Orte/Szenen liegen zu diesem
// Zeitpunkt bereits gültig in der DB. Darum darf hier NICHTS den Job über
// failJob kippen: jeder Zweig kapselt seine Fehler selbst und sammelt eine
// Warnung, nur AbortError (User-Abbruch) schlägt durch.
const { getBookSettings } = require('../../../../db/schema');
const appSettings = require('../../../../lib/app-settings');
const { toSystemBlocks, updateJob, retryOnTransientAi } = require('../../shared');
const { narrativeLabels } = require('../../narrative-labels');
const { buildBookSystemBlockText } = require('../utils');
const { saveKontinuitaetResult } = require('../remap');
const { verifyKontinuitaetProbleme, runAttributeContradictionCheck } = require('../job-shared');
// Direkt aus dem Phasen-Modul statt über die phases.js-Facade — die Facade lädt
// diese Datei mit und der Umweg wäre ein Zirkular-Import.
const { runZeitstrahl } = require('./beziehungen-zeitstrahl');
const { komplettMaxTokens } = require('./tokens');
const { COST_LABEL, costTier } = require('../cost-labels');

// P8-Call. Single-Pass (voller Buchtext im 1h-Cache) nur bei Cloud-Klasse, sonst
// Fakten-Multi-Pass. Fehler werden hier abgefangen: ein gescheiterter P8 (Trunkierung
// bei zu vielen Befunden, Parse-Fehler, erschöpfter Retry) darf den Katalog NICHT als
// „fehlgeschlagen" verwerfen — Kontinuität überspringen, vorheriges Ergebnis bleibt.
async function _runP8(ctx, { kontMultiPass, figKompakt, orteKompakt, chapterFakten, anachronismus }) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider,
    prompts, sys, pageContents, fullBookText, warnings } = ctx;
  try {
    if (!kontMultiPass) {
      log.info(`Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
      const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h', sharedPrefix: true };
      return await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email)), anachronismus),
        [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KONTINUITAET_BLOCKS, '1h')],
        82, 97, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_KONTINUITAET_PROBLEME,
        costTier(COST_LABEL.kontinuitaet),
      ), { log, label: 'Kontinuität Single-Pass (P8)' });
    }
    log.info(`Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
    return await retryOnTransientAi(() => call(jobId, tok,
      prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt, anachronismus,
          narrativeLabels(getBookSettings(bookIdInt, email))),
      sys.SYSTEM_KONTINUITAET_BLOCKS, 82, 97, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_KONTINUITAET_PROBLEME,
      costTier(COST_LABEL.kontinuitaet),
    ), { log, label: 'Kontinuität facts-basiert (P8)' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`Kontinuitätsprüfung fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
    warnings.push({ key: 'job.warn.continuityFailed' });
    return null;
  }
}

// P6 (Zeitstrahl) non-critical kapseln: ein Fehler im Zeitstrahl-DB-Save (oder im
// Konsolidierungs-Call, der im Fallback synchron speichert) darf den bereits gültig
// gespeicherten Katalog NICHT verwerfen — P6 ist Endphase, kein kritischer Pfad.
// AbortError (User-Cancel) muss aber durchschlagen → eigene Kapselung statt
// runNonCritical (das AbortError schluckt). _runP8 ist intern bereits so abgesichert;
// damit kann keiner der beiden Promise.all-Zweige den Job über failJob kippen.
async function _runZeitstrahlSafe(ctx, opts) {
  try { await runZeitstrahl(ctx, opts); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.log.warn(`Zeitstrahl-Phase fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
    ctx.warnings.push({ key: 'job.warn.timelineFailed' });
  }
}

/** Zeitstrahl + Kontinuität + Attribut-Detektor, inklusive Persistenz.
 *  Teil-Lauf: `skipContinuity` waehlt P8 (und mit ihm den Attribut-Detektor) ab,
 *  `skipZeitstrahl` den Zeitstrahl (P6) — die beiden sind im Modal getrennte Schritte
 *  und laufen hier nur zusammen, weil sie sich bei der Cloud-Klasse die Wartezeit
 *  teilen. Schreibt selbst in die DB; liefert nichts. */
async function runKontinuitaetPhase(ctx, {
  skipContinuity, skipZeitstrahl, isCloudModel, kontMultiPass,
  figKompakt, orteKompakt, chapterFakten, anachronismus, figNameToId,
}) {
  const { jobId, bookIdInt, email, log, effectiveProvider, idMaps, pageContents, warnings } = ctx;
  // Zeitstrahl abgewählt: bestehende `zeitstrahl_events` bleiben stehen. Der Aufruf
  // faellt weg statt mit leerer Eingabe zu laufen — P6 konsolidiert aus `figure_events`
  // und schriebe sonst denselben Stand neu, ohne dass ein Ereignis dazugekommen waere.
  const zeitstrahl = (opts) => skipZeitstrahl ? Promise.resolve() : _runZeitstrahlSafe(ctx, opts);
  if (skipZeitstrahl) log.info('Zeitstrahl (P6) auf Wunsch übersprungen – bestehender Zeitstrahl bleibt.');
  let kontResult;
  if (skipContinuity) {
    // Teil-Lauf: P8 abgewählt. Das vorherige Kontinuitäts-Ergebnis bleibt unangetastet
    // (P8 ist read-only). Die Bar muss über den P8-Bereich (82..97) hinweg selbst
    // vorrücken — sonst hängt sie bei 82, bis completeJob auf 100 springt.
    // Kein eigener statusText: runZeitstrahl (nicht-silent) setzt seinen eigenen.
    log.info('Kontinuitätsprüfung (P8) auf Wunsch übersprungen – bestehendes Ergebnis bleibt.');
    await zeitstrahl();
    updateJob(jobId, { progress: 97 });
    kontResult = null;
  } else if (isCloudModel) {
    // Parallel: P6 silent, P8 ownt Bar (82..97).
    updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
    const [, p8Out] = await Promise.all([
      zeitstrahl({ silent: true }),
      _runP8(ctx, { kontMultiPass, figKompakt, orteKompakt, chapterFakten, anachronismus }),
    ]);
    kontResult = p8Out;
  } else {
    // Kontinuitätsprüfung (P8) ist Cloud-only — für lokale Provider übersprungen:
    // ohne Single-Pass/Verify-Filter/Attribut-Check produziert der Fakten-Multi-Pass
    // zu viele False Positives. Der Zeitstrahl (P6) ist Kern-Katalog und läuft weiter.
    await zeitstrahl();
    // Ohne P6 setzt niemand die Bar in diesem Zweig — sonst steht sie bis completeJob.
    if (skipZeitstrahl) updateJob(jobId, { progress: 82 });
    kontResult = null;
  }
  // Pflichtfeld-Check als Degradierung (P8 read-only → kein throw): ein schema-valides
  // Ergebnis ohne «zusammenfassung» würde saveKontinuitaetResult wortlos null liefern
  // (kein Befund, kein Hinweis) → der User hielte die Prüfung für sauber durchgelaufen.
  if (kontResult && typeof kontResult.zusammenfassung === 'undefined') {
    log.warn('Kontinuitätsprüfung: Pflichtfeld «zusammenfassung» fehlt – Ergebnis verworfen, Warnung gesammelt.');
    warnings.push({ key: 'job.warn.continuityFailed' });
    kontResult = null;
  }
  if (kontResult && kontMultiPass && isCloudModel) {
    // Multi-Pass-Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
    // Scheitert die Stufe als Ganzes, wird P8 verworfen (ungeprüfte Multi-Pass-Befunde
    // wären überwiegend Fehlalarme) — der Katalog bleibt, Warnung statt failJob.
    try {
      kontResult = await verifyKontinuitaetProbleme(ctx, kontResult, 96, 97, { chapterFacts: chapterFakten });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Kontinuität Verify fehlgeschlagen – Ergebnis verworfen (Katalog bleibt erhalten): ${e.message}`);
      warnings.push({ key: 'job.warn.continuityFailed' });
      kontResult = null;
    }
  }

  // ── F4: Attribut-Widerspruchs-Detektor (non-critical, nur Cloud-Klasse) ──────
  // Deterministisch gefundene Cross-Chapter-Widersprüche (Lebensereignis-Jahre, Welt-Fakten),
  // die der fakten-basierte P8 pro Kapitel übersieht; das Modell urteilt (Effort low, attribute-check.js).
  // Bereits geurteilt → NICHT durch die verify-Stufe schleusen, sondern nach ihr einmischen.
  // Mit abgewähltem P8 entfällt er mit: er ist ein ERGÄNZENDER Kontinuitäts-Detektor
  // (seine Befunde werden in denselben Check geschrieben) — ihn allein laufen zu
  // lassen würde den bestehenden Check mit einem fast leeren neuen überschreiben.
  let attrFindings = [];
  if (!skipContinuity && isCloudModel && appSettings.get('ai.komplett.attribute_check') === true) {
    try {
      attrFindings = await runAttributeContradictionCheck(ctx, 97, 98);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Attribut-Widerspruchs-Detektor fehlgeschlagen (ignoriert): ${e.message}`);
      warnings.push({ key: 'job.warn.attributeCheckFailed' });
    }
  }

  if (kontResult) {
    if (attrFindings.length) {
      kontResult = { ...kontResult, probleme: [...(kontResult.probleme || []), ...attrFindings] };
    }
    // Single-Pass (Cloud, voller Buchtext im Prompt): Beleg-Zitate gegen den Text
    // prüfen. Multi-Pass hat die separate verify-Stufe; der Fakten-Pfad zitiert
    // Fakt-Aussagen → requireQuoteEvidence dort aus, die Seiten-Anker kommen über
    // die Fakten. F4-Befunde (`_source: 'attr'`) nimmt saveKontinuitaetResult von der
    // Beleg-Prüfung aus: ihre Stellen sind aus Katalogdaten gebaut, nicht zitiert.
    _saveSafe(ctx, () => saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log,
      { pageContents, requireQuoteEvidence: !kontMultiPass, chapterFacts: kontMultiPass ? chapterFakten : null }));
  } else if (attrFindings.length) {
    // P8 selbst fehlgeschlagen/leer, aber der Attribut-Detektor fand Cross-Chapter-Widersprüche:
    // eigenständig als Kontinuitäts-Check persistieren (nicht verlieren).
    _saveSafe(ctx, () => saveKontinuitaetResult(bookIdInt, email, { zusammenfassung: '', probleme: attrFindings },
      figNameToId, idMaps.chNameToId, effectiveProvider, log, { pageContents, requireQuoteEvidence: false }));
  }
}

// Persistenz des P8-Ergebnisses: ein Fehler beim Speichern (kaputter Befund, DB-Fehler
// in der Check-Transaktion) lässt den vorherigen Check stehen und darf den bereits
// gespeicherten Katalog nicht über failJob kippen.
function _saveSafe(ctx, fn) {
  try { fn(); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.log.warn(`Kontinuitäts-Ergebnis nicht gespeichert (Katalog bleibt erhalten): ${e.message}`);
    ctx.warnings.push({ key: 'job.warn.continuityFailed' });
  }
}

module.exports = { runKontinuitaetPhase };
