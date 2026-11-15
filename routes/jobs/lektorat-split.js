'use strict';
// Claude-Split des Seiten-Lektorats: fokussierter Objektiv-Pass + fokussierter
// Stil-Pass, konsolidiert zu einer dublettenfreien fehler-Liste; lange Abschnitte
// in Stücken (lib/lektorat-chunks.js). Ausgelagert aus lektorat.js, damit der
// Job-Router schlank bleibt. Admin-Regler: ob überhaupt gesplittet wird
// (ai.lektorat_split). Lokale Provider splitten nie (ein kombinierter Single-Call).

const { aiCall, i18nError, updateJob, _modelName } = require('./shared');
const appSettings = require('../../lib/app-settings');
const { setContext } = require('../../lib/log-context');
const { _claudeUsesAdaptiveThinking } = require('../../lib/ai');
const { mergePasses } = require('../../lib/lektorat-consolidate');
const { chunkingApplies, chunkText, chunkContext } = require('../../lib/lektorat-chunks');

// Ob der Split gefahren wird (fokussierte Einzel-Pässe statt einem grossen Kombi-Call).
// Unabhängig von der Lauf-Anzahl. Lokale Provider ignorieren das (immer 1 Kombi-Call).
function splitEnabled() {
  return appSettings.get('ai.lektorat_split') === true;
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
// PLUS fokussierter Stil-Pass (kombinierter Prompt ohne objektive Typen, liefert
// szenen/stilanalyse/fazit), parallel, danach Span-Overlap-Merge zu einer
// dublettenfreien fehler-Liste. Split AUS oder lokaler Provider:
// genau EIN kombinierter Call (Rechtschreibung + Stil + Szenen zusammen). Rückgabe
// hat stets die Form { fehler, szenen, stilanalyse, fazit } — Cache/History/Frontend gleich.
// Split + langer Abschnitt (lib/lektorat-chunks.js#chunkingApplies): Objektiv- und
// Stil-Pass je Stück, der Stil-Pass dort ohne szenen/stilanalyse/fazit; die kommen
// aus einem Bewertungs-Pass über den ganzen Abschnitt. Alle Befunde gehen in einen
// Merge über den ganzen Text.
// Ausgabe-Deckel je Teil-Call (Tokens, inkl. Denken): ohne Wert gälte das Modell-
// maximum (128K), und ein Ausreisser in Schleife kostete ein Vielfaches eines
// normalen Laufs (beobachtet: 82K Output auf 63K Input). Ein normaler Pass liegt bei
// ~5–15K; der Deckel lässt reichlich Luft und wächst mit der Textlänge. Wird er
// erreicht, endet der Call als `truncated` (Fehler statt Teil-Befunde).
const LEKTORAT_MAX_TOKENS_BASE = 32000;
const LEKTORAT_MAX_TOKENS_CAP = 64000;
function lektoratMaxTokens(textLen) {
  const len = Number.isFinite(textLen) && textLen > 0 ? textLen : 0;
  return Math.min(LEKTORAT_MAX_TOKENS_CAP, LEKTORAT_MAX_TOKENS_BASE + Math.ceil(len / 2));
}

async function lektoratAnalyze({
  jobId, tok, text, local, prompts, system, promptOpts, fromPct, toPct, buchtyp = null, callLimit = null,
}) {
  const {
    buildLektoratPrompt,
    buildObjektivLektoratPrompt, buildStilLektoratPrompt,
    buildLektoratSchema, buildObjektivLektoratSchema,
    buildBewertungLektoratPrompt, buildBewertungLektoratSchema,
  } = prompts;
  const split = local ? false : splitEnabled();
  // Textsorte schneidet das Typ-Set im journalistischen Profil zusaetzlich zu
  // (kein `wertung` im Kommentar). Sie steht in promptOpts, damit sie ueber
  // dieselbe Struktur fliesst wie die uebrigen Prompt-Argumente — Schema und
  // Prompt duerfen hier nicht auseinanderlaufen.
  const textsorte = promptOpts?.textsorte || null;
  // Schema und Prompt-Enum müssen dasselbe Buchtyp-Profil sehen (Grammar vs. Text) —
  // sonst bietet die Grammar Typen an, die der Prompt verbietet.
  const kombiSchema = buildLektoratSchema({ buchtyp, textsorte });
  // Lange Abschnitte in Stücken (lib/lektorat-chunks.js): je Stück Objektiv + Stil
  // ohne Bewertung, dazu EIN Bewertungs-Pass über den ganzen Abschnitt.
  const chunks = split && chunkingApplies(text.length, { local, split }) ? chunkText(text) : null;
  // Batch: `callLimit` deckelt die gleichzeitigen Calls über alle Seiten des Laufs
  // (ai.lektorat_batch_concurrency) — ein Abschnitt in Stücken feuert sonst ein
  // Vielfaches der Calls, mit denen der Seiten-Pool rechnet.
  const limited = (fn) => (callLimit ? callLimit(fn) : fn());

  const trackPasses = fromPct != null && toPct != null;
  const total = !split ? 1 : chunks ? chunks.length * 2 + 1 : 2;
  const status = trackPasses ? _statusLine(jobId, total) : null;
  if (status) tok.onThinking = status.onThinking;

  if (!split) {
    const prompt = buildLektoratPrompt(text, promptOpts);
    const result = await aiCall(jobId, tok, prompt, system, fromPct, toPct, 5000, 0.2, lektoratMaxTokens(text.length), undefined, kombiSchema);
    if (!Array.isArray(result?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
    return result;
  }

  if (!tok.inflight) tok.inflight = new Map();   // parallele Live-Token-Summierung
  // Fortschritt über alle Teil-Calls verteilen, sofern ein Bereich vorgegeben ist
  // (Einzel-Lektorat). Im Batch (fromPct/toPct = null) steuert der Job den Balken
  // per Seiten-Zähler – dann weder Range noch Teil-Call-Zähler setzen (der würde
  // sonst die Seiten-Statuszeile überschreiben).
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
  const objektivSchema = buildObjektivLektoratSchema({
    buchtyp, textsorte, hasFiguren: (promptOpts.figuren || []).length > 0,
  });

  // Objektiv- und Stil-Pass über EINEN Text (ganzer Abschnitt oder Stück).
  // Rückgabe: { obj: Objektiv-Befunde, stil: Stil-Pass-Ergebnis }.
  async function passes(passText, promptOpts, { ohneBewertung = false } = {}) {
    const maxTokens = lektoratMaxTokens(passText.length);
    const objektivOpts = {
      figuren: promptOpts.figuren, figurenBeziehungen: promptOpts.figurenBeziehungen,
      orte: promptOpts.orte, pageName: promptOpts.pageName, chapterName: promptOpts.chapterName,
      // Quellennachweis-Schutz gilt in BEIDEN Pässen: der Objektiv-Pass prüft
      // Rechtschreibung/Grammatik und würde Autorennamen + Jahreszahlen im
      // Kurzbeleg sonst anstreichen.
      hatBelege: promptOpts.hatBelege,
      // Benutzer-Wörterbuch: der Objektiv-Pass ist der, der Rechtschreibung prüft.
      woerterbuch: promptOpts.woerterbuch,
      // Chat-Schreibweise im Nachrichtenverlauf: vor allem hier, wo Satzzeichen geprüft werden.
      hatNachrichten: promptOpts.hatNachrichten,
      langCode: promptOpts.langCode,
      // Volle Locale: en-GB und en-US setzen Anführungszeichen verschieden.
      locale: promptOpts.locale,
      // Schreibstelle: ein abgebrochener letzter Satz ist dort kein Grammatik-Befund.
      schreibfront: promptOpts.schreibfront,
      // Buchtyp entscheidet, welche objektiven Typen es überhaupt gibt (Fach-Profile:
      // nur rechtschreibung + grammatik, kein Dialogformat/Figurenkonsistenz).
      buchtyp,
      textsorte,
    };
    const objektivPrompt = buildObjektivLektoratPrompt(passText, objektivOpts);
    const objPromise = limited(() => aiCall(jobId, tok, objektivPrompt, system, null, null, 4000, 0.2, maxTokens, undefined, objektivSchema)).then(tick);

    // Stil-Pass parallel – eigener User-Prompt, eigenes Schema: das Enum lässt
    // die objektiven Typen weg, die der Objektiv-Pass liefert.
    const stilSchema = buildLektoratSchema({ buchtyp, textsorte, stilOnly: true, ohneBewertung });
    const stilPrompt = buildStilLektoratPrompt(passText, { ...promptOpts, ohneBewertung });
    const stilPromise = limited(() => aiCall(jobId, tok, stilPrompt, system, null, null, 5000, 0.2, maxTokens, undefined, stilSchema)).then(tick);
    const [obj, stil] = await Promise.all([objPromise, stilPromise]);
    if (!Array.isArray(stil?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
    return { obj: Array.isArray(obj?.fehler) ? obj.fehler : [], stil };
  }

  if (!chunks) {
    const { obj, stil } = await passes(text, promptOpts);
    const fehler = mergePasses([obj, stil.fehler], text);
    return { fehler, szenen: stil.szenen, stilanalyse: stil.stilanalyse, fazit: stil.fazit };
  }

  // In Stücken: jedes Stück sieht den Text davor/danach als Lesekontext (am Rand
  // des Abschnitts die echten Nachbarauszüge), eine eigene Stil-Obergrenze aus der
  // Stücklänge und die Schreibstelle nur im letzten Stück.
  // lektorat-filter lädt dieses Modul selbst (splitEnabled) — darum erst hier.
  const { effectiveStylisticCap } = require('./lektorat-filter');
  const bewertungSchema = buildBewertungLektoratSchema();
  const bewertungPromise = limited(() => aiCall(jobId, tok, buildBewertungLektoratPrompt(text, promptOpts), system,
    null, null, 3000, 0.2, lektoratMaxTokens(text.length), undefined, bewertungSchema)).then(tick);
  bewertungPromise.catch(() => {});
  const last = chunks.length - 1;
  const perChunk = await Promise.all(chunks.map((c, i) => {
    const { before, after } = chunkContext(text, c);
    return passes(c.text, {
      ...promptOpts,
      stylisticCap: effectiveStylisticCap(c.text.length),
      previousExcerpt: i === 0 ? promptOpts.previousExcerpt : before,
      nextExcerpt: i === last ? promptOpts.nextExcerpt : after,
      previousChapter: i === 0 ? promptOpts.previousChapter : null,
      nextChapter: i === last ? promptOpts.nextChapter : null,
      schreibfront: i === last ? promptOpts.schreibfront : false,
      stueckDavor: i > 0,
      stueckDanach: i < last,
    }, { ohneBewertung: true });
  }));
  const bewertung = await bewertungPromise;
  const fehler = mergePasses(perChunk.flatMap(r => [r.obj, r.stil.fehler]), text);
  return { fehler, szenen: bewertung?.szenen, stilanalyse: bewertung?.stilanalyse, fazit: bewertung?.fazit };
}

module.exports = { lektoratAnalyze, lektoratMaxTokens, splitEnabled, applyLektoratAiOverrides };
