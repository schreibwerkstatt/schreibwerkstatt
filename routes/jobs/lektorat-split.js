'use strict';
// Claude-Split des Seiten-Lektorats: fokussierter Objektiv-Pass (K× parallel,
// Konsens) + fokussierter Stil-Pass (1×), konsolidiert zu einer dublettenfreien
// fehler-Liste. Ausgelagert aus lektorat.js, damit der Job-Router schlank bleibt.
// Zwei unabhängige Admin-Regler: ob überhaupt gesplittet wird (ai.lektorat_split)
// und – wenn ja – wie viele Objektiv-Läufe der Konsens fährt (ai.lektorat_objective_runs).
// Lokale Provider splitten nie (ein kombinierter Single-Call).

const { aiCall, i18nError, updateJob, _modelName } = require('./shared');
const appSettings = require('../../lib/app-settings');
const { setContext } = require('../../lib/log-context');
const { _claudeUsesAdaptiveThinking } = require('../../lib/ai');
const { consensusFindings, mergePasses } = require('../../lib/lektorat-consolidate');

// Ob der Split gefahren wird (fokussierte Einzel-Pässe statt einem grossen Kombi-Call).
// Unabhängig von der Lauf-Anzahl. Lokale Provider ignorieren das (immer 1 Kombi-Call).
function splitEnabled() {
  return appSettings.get('ai.lektorat_split') === true;
}

// Anzahl paralleler Objektiv-Läufe für den Konsens + Konsens-Schwelle.
// Admin-tunebar (ai.lektorat_objective_runs / ai.lektorat_consensus_threshold);
// Defaults kommen aus lib/app-settings.js (1 bzw. 2). Greift nur bei aktivem Split.
function objektivRuns() {
  const n = parseInt(appSettings.get('ai.lektorat_objective_runs'), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function consensusThreshold() {
  const n = parseInt(appSettings.get('ai.lektorat_consensus_threshold'), 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// Modell + Effort des Lektorats als EIN Job-Bag binden (setContext ersetzt `aiJob`
// ganz — zwei getrennte Setzer wuerden sich gegenseitig ueberschreiben). Nur Claude.
//   `ai.claude.model.lektorat` — eigenes Modell fuers Seiten- und Batch-Lektorat,
//     leer = folgt `ai.claude.model`. Erlaubt ein denkendes Modell (Opus/Sonnet 5)
//     fuers Lektorat, waehrend die uebrigen Jobs beim globalen Modell bleiben.
//   `ai.claude.effort.lektorat` — nur auf Modellen mit adaptivem Denken. Dort waehlt
//     die API ohne Feld den Modell-Default (meist 'high'), und das Modell denkt pro Pass Zehntausende Tokens
//     stumm (Minuten ohne Stream-Text, Output-Kosten ein Vielfaches). Sonnet 4.6 und
//     aelter denken nicht; ein Effort dort kuerzte die sichtbare Antwort.
// Rueckgabe: { model, cacheSuffix }. `model` ist das effektiv laufende Modell (fuer
// cacheVersion und page_checks.model), `cacheSuffix` = `:e=<effort>`
// oder '' — Caches ohne Effort (Sonnet 4.6) behalten so ihre bisherige Version.
function applyLektoratAiOverrides(effectiveProvider, logger) {
  const baseModel = _modelName(effectiveProvider);
  if (effectiveProvider !== 'claude') return { model: baseModel, cacheSuffix: '' };
  const override = String(appSettings.get('ai.claude.model.lektorat') || '').trim();
  const model = override || baseModel;
  const bag = { provider: 'claude' };
  if (override) bag.model = override;
  let cacheSuffix = '';
  if (_claudeUsesAdaptiveThinking(model)) {
    const effort = String(appSettings.get('ai.claude.effort.lektorat') || '').trim().toLowerCase();
    if (effort) { bag.effort = effort; cacheSuffix = `:e=${effort}`; }
  }
  if (Object.keys(bag).length > 1) {
    setContext({ aiJob: bag });
    logger.info(`Lektorat-Override: ${JSON.stringify(bag)}.`);
  }
  return { model, cacheSuffix };
}

// Statuszeile des Einzel-Lektorats. „KI denkt nach …", solange mindestens ein
// Teil-Call in seinem Thinking-Block steckt (adaptives Denken streamt bis zum ersten
// Text nur Pings, der Balken steht so lange still), sonst „X von Y fertig" bzw.
// „KI analysiert …". Parallele Calls beenden out-of-order → reine Zählung.
function _statusLine(jobId, total) {
  const thinking = new Set();
  let done = 0;
  const render = () => {
    if (thinking.size) updateJob(jobId, { statusText: 'job.phase.aiThinking' });
    else if (done > 0) updateJob(jobId, { statusText: 'job.phase.lektoratPasses', statusParams: { done, total } });
    else updateJob(jobId, { statusText: 'job.phase.aiAnalyzing' });
  };
  return {
    onThinking: (callId, on) => { if (on) thinking.add(callId); else thinking.delete(callId); render(); },
    passDone: () => { done++; render(); },
  };
}

// Kern-KI-Schritt des Lektorats. Split AN (Cloud/Claude): fokussierter Objektiv-Pass
// K× (Konsens ≥ Schwelle → maximale Präzision, filtert lauf-instabile Einzelgänger;
// K=1 = ein fokussierter Objektiv-Call ohne Konsens) PLUS fokussierter Stil-Pass 1×
// (kombinierter Prompt ohne objektive Typen, liefert szenen/stilanalyse/fazit),
// danach Span-Overlap-Merge zu einer dublettenfreien fehler-Liste. Objektiv-Läufe
// werden gestaffelt, damit der Prompt-Cache greift. Split AUS oder lokaler Provider:
// genau EIN kombinierter Call (Rechtschreibung + Stil + Szenen zusammen). Rückgabe
// hat stets die Form { fehler, szenen, stilanalyse, fazit } — Cache/History/Frontend gleich.
async function lektoratAnalyze({ jobId, tok, text, local, prompts, system, promptOpts, fromPct, toPct, buchtyp = null }) {
  const {
    buildLektoratPrompt,
    buildObjektivLektoratPrompt, buildStilLektoratPrompt,
    buildLektoratSchema, buildObjektivLektoratSchema,
  } = prompts;
  const split = local ? false : splitEnabled();
  const K = split ? Math.max(1, objektivRuns()) : 1;
  // Textsorte schneidet das Typ-Set im journalistischen Profil zusaetzlich zu
  // (kein `wertung` im Kommentar). Sie steht in promptOpts, damit sie ueber
  // dieselbe Struktur fliesst wie die uebrigen Prompt-Argumente — Schema und
  // Prompt duerfen hier nicht auseinanderlaufen.
  const textsorte = promptOpts?.textsorte || null;
  // Schema und Prompt-Enum müssen dasselbe Buchtyp-Profil sehen (Grammar vs. Text) —
  // sonst bietet die Grammar Typen an, die der Prompt verbietet.
  const kombiSchema = buildLektoratSchema({ buchtyp, textsorte });

  const trackPasses = fromPct != null && toPct != null;
  const status = trackPasses ? _statusLine(jobId, split ? K + 1 : 1) : null;
  if (status) tok.onThinking = status.onThinking;

  if (!split) {
    const prompt = buildLektoratPrompt(text, promptOpts);
    const result = await aiCall(jobId, tok, prompt, system, fromPct, toPct, 5000, 0.2, null, undefined, kombiSchema);
    if (!Array.isArray(result?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
    return result;
  }

  if (!tok.inflight) tok.inflight = new Map();   // parallele Live-Token-Summierung
  // Fortschritt über alle Teil-Calls (K Objektiv-Läufe + 1 Stil-Lauf) verteilen,
  // sofern ein Bereich vorgegeben ist (Einzel-Lektorat). Im Batch (fromPct/toPct = null)
  // steuert der Job den Balken per Seiten-Zähler – dann weder Range noch Teil-Call-
  // Zähler setzen (der würde sonst die Seiten-Statuszeile überschreiben).
  const total = K + 1;
  if (trackPasses) {
    tok.progressRange = { from: fromPct, to: toPct, total };
    tok.progressParts = new Map();
  }
  // Status-Zeile: nach jedem fertigen Teil-Call hochzählen (parallele Calls beenden
  // out-of-order → reine „X von Y fertig"-Zählung, kein Pass-Name). Gibt r durch,
  // damit die Ergebnisse der aiCalls unverändert weiterverwendet werden.
  const tick = (r) => {
    status?.passDone();
    return r;
  };
  const objektivOpts = {
    figuren: promptOpts.figuren, figurenBeziehungen: promptOpts.figurenBeziehungen,
    orte: promptOpts.orte, pageName: promptOpts.pageName, chapterName: promptOpts.chapterName,
    // Quellennachweis-Schutz gilt in BEIDEN Pässen: der Objektiv-Pass prüft
    // Rechtschreibung/Grammatik und würde Autorennamen + Jahreszahlen im
    // Kurzbeleg sonst anstreichen.
    hatBelege: promptOpts.hatBelege,
    // Benutzer-Wörterbuch: der Objektiv-Pass ist der, der Rechtschreibung prüft.
    woerterbuch: promptOpts.woerterbuch,
    langCode: promptOpts.langCode,
    // Schreibstelle: ein abgebrochener letzter Satz ist dort kein Grammatik-Befund.
    schreibfront: promptOpts.schreibfront,
    // Buchtyp entscheidet, welche objektiven Typen es überhaupt gibt (Fach-Profile:
    // nur rechtschreibung + grammatik, kein Dialogformat/Figurenkonsistenz).
    buchtyp,
    textsorte,
  };
  const objektivPrompt = buildObjektivLektoratPrompt(text, objektivOpts);
  const objektivSchema = buildObjektivLektoratSchema({
    buchtyp, textsorte, hasFiguren: (promptOpts.figuren || []).length > 0,
  });
  const stilPrompt = buildStilLektoratPrompt(text, promptOpts);
  const objCall = () => aiCall(jobId, tok, objektivPrompt, system, null, null, 4000, 0.2, null, undefined, objektivSchema).then(tick);

  // Stil-Pass parallel starten – eigener User-Prompt, profitiert nicht vom
  // Objektiv-Cache (teilt nur den kleinen System-Block). Eigenes Schema: das
  // Enum lässt die objektiven Typen weg, die der Objektiv-Pass liefert.
  const stilSchema = buildLektoratSchema({ buchtyp, textsorte, stilOnly: true });
  const stilPromise = aiCall(jobId, tok, stilPrompt, system, null, null, 5000, 0.2, null, undefined, stilSchema).then(tick);

  // Objektiv-Läufe STAFFELN statt sofort alle parallel: den ersten Lauf voll
  // abschliessen, damit er den Prompt-Cache primet (voller Input = System +
  // identischer Objektiv-Prompt). Erst danach die restlichen K-1 parallel – die
  // lesen dann den warmen Cache (cache_read statt K× Voll-Input). Gleichzeitiges
  // Feuern verfehlt den Cache komplett (jeder Lauf zahlt den vollen Input).
  // Betrifft NUR die Objektiv-Läufe untereinander und greift folglich erst ab K>1.
  // Der Stil-Pass läuft bewusst von Anfang an daneben: er hat einen eigenen
  // User-Prompt und teilt mit dem Objektiv-Pass nur den System-Block, kann also
  // von dessen Cache-Eintrag ohnehin nicht profitieren – ihn hinten anzustellen
  // würde nur Latenz kosten.
  const objRuns = [await objCall()];
  if (K > 1) {
    const rest = await Promise.all(Array.from({ length: K - 1 }, objCall));
    objRuns.push(...rest);
  }
  const stilResult = await stilPromise;

  if (!Array.isArray(stilResult?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
  const objFehlerRuns = objRuns.map(r => (Array.isArray(r?.fehler) ? r.fehler : []));
  const objConsensus = consensusFindings(objFehlerRuns, text, { threshold: consensusThreshold() });
  const fehler = mergePasses([objConsensus, stilResult.fehler], text);
  return { fehler, szenen: stilResult.szenen, stilanalyse: stilResult.stilanalyse, fazit: stilResult.fazit };
}

module.exports = { lektoratAnalyze, objektivRuns, consensusThreshold, splitEnabled, applyLektoratAiOverrides };
