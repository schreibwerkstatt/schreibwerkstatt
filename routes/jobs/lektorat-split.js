'use strict';
// Claude-Split des Seiten-Lektorats: fokussierter Objektiv-Pass + fokussierter
// Stil-Pass, konsolidiert zu einer dublettenfreien fehler-Liste; lange Abschnitte
// in Stücken (lib/lektorat-chunks.js). Ausgelagert aus lektorat.js, damit der
// Job-Router schlank bleibt. Admin-Regler: ob überhaupt gesplittet wird
// (ai.lektorat_split). Nur Claude splittet (splitApplies); lokale Provider fahren
// einen kombinierten Single-Call, andere Provider der Cloud-Klasse den vollen
// Kombi-Prompt, lange Abschnitte in Stücken.

const { aiCall, i18nError, updateJob, _modelName, bindJobTier } = require('./shared');
const appSettings = require('../../lib/app-settings');
const logger = require('../../logger');
const { _claudeUsesAdaptiveThinking } = require('../../lib/ai');
const { bindJobOverride, openaiCompatThink } = require('../../lib/ai/config');
const { getContext } = require('../../lib/log-context');
const { mergePasses } = require('../../lib/lektorat-consolidate');
const { chunkingApplies, chunkText, chunkContext } = require('../../lib/lektorat-chunks');

// Ob der Split gefahren wird (fokussierte Einzel-Pässe statt einem grossen Kombi-Call).
// Unabhängig von der Lauf-Anzahl. Lokale Provider ignorieren das (immer 1 Kombi-Call).
function splitEnabled() {
  return appSettings.get('ai.lektorat_split') === true;
}

// Fährt DIESER Lauf den Split? Nur Claude: zwei Pässe je Text lohnen sich dort, weil
// sie parallel laufen und sich (in Stücken) einen gecachten Regel-Kopf teilen —
// beides Fähigkeiten der Anthropic-API. Ein anderer Provider der Cloud-Klasse
// (openai-compat mit `cloud`, z.B. Qwen über LocalAI, seriell, ohne Prompt-Cache)
// zahlte doppelt: ein 34K-Abschnitt brauchte im Split 11 Calls / 600 s gegen
// 6 Calls im Kombi in Stücken. SSoT für Lauf, Cache-Signatur und Batch-Pool.
function splitApplies(local, provider = 'claude') {
  return !local && provider === 'claude' && splitEnabled();
}

// Modell + Effort des Lektorats. Nur Claude.
//   Modell — die Stufe des Jobs (`check`/`batch-check`, routes/jobs/shared/model-tier.js),
//     gebunden beim Job-Start; Default «stark» = `ai.claude.model`.
//   `ai.claude.effort.lektorat` — nur auf Modellen mit adaptivem Denken. Dort waehlt
//     die API ohne Feld den Modell-Default (meist 'high'), und das Modell denkt pro Pass Zehntausende Tokens
//     stumm (Minuten ohne Stream-Text, Output-Kosten ein Vielfaches). Sonnet 4.6 und
//     aelter denken nicht; ein Effort dort kuerzte die sichtbare Antwort.
// Rueckgabe: { model, cacheSuffix }. `model` ist das effektiv laufende Modell (fuer
// cacheVersion und page_checks.model), `cacheSuffix` = `:e=<effort>`
// oder '' — Caches ohne Effort (Sonnet 4.6) behalten so ihre bisherige Version.
// Die Stufe bindet die Queue; ausserhalb (Eval-Skript) holt das der Aufruf hier nach —
// für den Job-Typ des Kontexts, sonst `check`.
function applyLektoratAiOverrides(effectiveProvider, logger) {
  if (effectiveProvider === 'openai-compat') return _openaiCompatLektoratOverrides(logger);
  if (effectiveProvider !== 'claude') return { model: _modelName(effectiveProvider), cacheSuffix: '' };
  bindJobTier(getContext().job || 'check', effectiveProvider);
  const model = _modelName(effectiveProvider);
  let cacheSuffix = '';
  if (_claudeUsesAdaptiveThinking(model)) {
    const effort = String(appSettings.get('ai.claude.effort.lektorat') || '').trim().toLowerCase();
    if (effort) {
      bindJobOverride('claude', { effort });
      cacheSuffix = `:e=${effort}`;
    }
  }
  logger.info(`Lektorat-Modell: ${model}${cacheSuffix ? ` (effort ${cacheSuffix.slice(3)})` : ''}.`);
  return { model, cacheSuffix };
}

// openai-compat mit Thinking: Denkbudget des Lektorats pro Aufruf
// (`ai.openai-compat.reasoning_budget.lektorat`, 0 = Alias-/Server-Default). Das Modell
// schöpft jedes Budget aus, darum formt es Laufzeit UND Befunde — `:rb=<n>` in der
// Cache-Version, damit eine Umstellung nicht das Ergebnis des alten Budgets liefert.
function _openaiCompatLektoratOverrides(logger) {
  const model = _modelName('openai-compat');
  const budget = openaiCompatThink() ? Math.max(0, parseInt(appSettings.get('ai.openai-compat.reasoning_budget.lektorat'), 10) || 0) : 0;
  if (!budget) return { model, cacheSuffix: '' };
  bindJobOverride('openai-compat', { reasoningBudget: budget });
  logger.info(`Lektorat-Modell: ${model} (Denkbudget ${budget}).`);
  return { model, cacheSuffix: `:rb=${budget}` };
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
// Merge über den ganzen Text. `cacheBlocks` (nur Claude, siehe sharedHeadBlocks):
// in Stücken teilen die Prompts eines Passes einen gecachten Kopf und starten gestaffelt.
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
  cacheBlocks = false, provider = 'claude',
}) {
  const {
    buildLektoratPrompt,
    buildObjektivLektoratPrompt, buildStilLektoratPrompt,
    buildLektoratSchema, buildObjektivLektoratSchema,
    buildBewertungLektoratPrompt, buildBewertungLektoratSchema,
  } = prompts;
  const split = splitApplies(local, provider);
  // Textsorte schneidet das Typ-Set im journalistischen Profil zusaetzlich zu
  // (kein `wertung` im Kommentar). Sie steht in promptOpts, damit sie ueber
  // dieselbe Struktur fliesst wie die uebrigen Prompt-Argumente — Schema und
  // Prompt duerfen hier nicht auseinanderlaufen.
  const textsorte = promptOpts?.textsorte || null;
  // Schema und Prompt-Enum müssen dasselbe Buchtyp-Profil sehen (Grammar vs. Text) —
  // sonst bietet die Grammar Typen an, die der Prompt verbietet.
  const kombiSchema = buildLektoratSchema({ buchtyp, textsorte });
  // Lange Abschnitte in Stücken (lib/lektorat-chunks.js): je Stück Objektiv + Stil
  // (Split) bzw. ein Kombi-Call (andere Provider der Cloud-Klasse), jeweils ohne
  // Bewertung, dazu EIN Bewertungs-Pass über den ganzen Abschnitt.
  const chunks = chunkingApplies(text.length, { local, split, provider }) ? chunkText(text) : null;
  // Batch: `callLimit` deckelt die gleichzeitigen Calls über alle Seiten des Laufs
  // (ai.lektorat_batch_concurrency) — ein Abschnitt in Stücken feuert sonst ein
  // Vielfaches der Calls, mit denen der Seiten-Pool rechnet.
  const limited = (fn) => (callLimit ? callLimit(fn) : fn());

  const trackPasses = fromPct != null && toPct != null;
  const total = !split ? (chunks ? chunks.length + 1 : 1) : chunks ? chunks.length * 2 + 1 : 2;
  const status = trackPasses ? _statusLine(jobId, total) : null;
  if (status) tok.onThinking = status.onThinking;

  // Logging (nur Diagnose, ändert nichts am Lauf): Plan des Abschnitts, Name je
  // Call für die Logzeile aus aiCall (shared/call-log.js), im Buch-Lektorat mit dem
  // Abschnitt davor, weil dort viele Abschnitte in einem Job laufen.
  const pfx = callLimit && promptOpts?.pageName ? `«${String(promptOpts.pageName).slice(0, 30)}» ` : '';
  const at = pfx ? ` ${pfx.trim()}` : '';
  const stueckArt = chunks ? `${chunks.length} Stücke à ${chunks.map(c => c.text.length).join('/')} Z.` : '';
  const planArt = !split ? (chunks ? `Kombi, ${stueckArt}` : 'ein Pass (kein Split)')
    : chunks ? stueckArt : 'am Stück (Objektiv + Stil)';
  logger.info(`Lektorat-Plan${at}:${text.length} Z., ${planArt}, Cache-Blöcke ${cacheBlocks ? 'ja' : 'nein'}, ${total} Calls${callLimit ? ', Buch-Lektorat' : ''}.`);

  if (!split && !chunks) {
    const prompt = buildLektoratPrompt(text, promptOpts);
    const result = await aiCall(jobId, tok, prompt, system, fromPct, toPct, 5000, 0.2, lektoratMaxTokens(text.length), undefined, kombiSchema, undefined, null, `${pfx}kombi`);
    if (!Array.isArray(result?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
    logger.info(`Lektorat-Befunde${at}: ${result.fehler.length} (ein Pass).`);
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

  // Prompts der beiden Pässe über EINEN Text (ganzer Abschnitt oder Stück).
  function objektivPromptFor(passText, promptOpts) {
    return buildObjektivLektoratPrompt(passText, {
      figuren: promptOpts.figuren, figurenBeziehungen: promptOpts.figurenBeziehungen,
      orte: promptOpts.orte, pageName: promptOpts.pageName, chapterName: promptOpts.chapterName,
      // Quellennachweis-Schutz gilt in BEIDEN Pässen: der Objektiv-Pass prüft
      // Rechtschreibung/Grammatik und würde Autorennamen + Jahreszahlen im
      // Kurzbeleg sonst anstreichen.
      hatBelege: promptOpts.hatBelege,
      // Benutzer-Wörterbuch: der Objektiv-Pass ist der, der Rechtschreibung prüft.
      woerterbuch: promptOpts.woerterbuch,
      // Korrektur-Sprache der Locale (ss statt ß, British spelling).
      korrekturRegeln: promptOpts.korrekturRegeln,
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
    });
  }
  // Stil-Pass: eigener User-Prompt, eigenes Schema — das Enum lässt die objektiven
  // Typen weg, die der Objektiv-Pass liefert.
  const stilPromptFor = (passText, promptOpts, ohneBewertung) =>
    buildStilLektoratPrompt(passText, { ...promptOpts, ohneBewertung });
  const runObjektiv = (prompt, passLen, onStart = null, label = 'objektiv') =>
    limited(() => aiCall(jobId, tok, prompt, system, null, null, 4000, 0.2, lektoratMaxTokens(passLen), undefined, objektivSchema, undefined, onStart, `${pfx}${label}`)).then(tick);
  const runStil = (prompt, passLen, stilSchema, onStart = null, label = 'stil') =>
    limited(() => aiCall(jobId, tok, prompt, system, null, null, 5000, 0.2, lektoratMaxTokens(passLen), undefined, stilSchema, undefined, onStart, `${pfx}${label}`)).then(tick);
  // Befundzahl je Pass vor dem Zusammenführen und danach (Merge entfernt Doppelungen).
  const logBefunde = (passes, merged) => logger.info(`Lektorat-Befunde${at}: ${passes.map(([n, l]) => `${n} ${l}`).join(', ')} → ${merged} nach Zusammenführung.`);
  const checkStil = (stil) => {
    if (!Array.isArray(stil?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
    return stil;
  };
  const objFehler = (obj) => (Array.isArray(obj?.fehler) ? obj.fehler : []);

  if (!chunks) {
    // Am Stück: Objektiv- und Stil-Pass parallel. Kein gemeinsamer Prompt-Kopf
    // (verschiedene Prompts und Schemas), darum auch kein Staffeln.
    const stilSchema = buildLektoratSchema({ buchtyp, textsorte, stilOnly: true });
    const [obj, stil] = await Promise.all([
      runObjektiv(objektivPromptFor(text, promptOpts), text.length),
      runStil(stilPromptFor(text, promptOpts, false), text.length, stilSchema),
    ]);
    checkStil(stil);
    const fehler = mergePasses([objFehler(obj), stil.fehler], text);
    logBefunde([['objektiv', objFehler(obj).length], ['stil', stil.fehler.length]], fehler.length);
    return { fehler, szenen: stil.szenen, stilanalyse: stil.stilanalyse, fazit: stil.fazit };
  }

  // In Stücken: jedes Stück sieht den Text davor/danach als Lesekontext (am Rand
  // des Abschnitts die echten Nachbarauszüge), eine eigene Stil-Obergrenze aus der
  // Stücklänge und die Schreibstelle nur im letzten Stück.
  // lektorat-filter lädt dieses Modul selbst (splitEnabled) — darum erst hier.
  const { effectiveStylisticCap } = require('./lektorat-filter');
  const bewertungSchema = buildBewertungLektoratSchema();
  const bewertungPromise = limited(() => aiCall(jobId, tok, buildBewertungLektoratPrompt(text, promptOpts), system,
    null, null, 3000, 0.2, lektoratMaxTokens(text.length), undefined, bewertungSchema, undefined, null, `${pfx}bewertung`)).then(tick);
  bewertungPromise.catch(() => {});
  const last = chunks.length - 1;
  const chunkOpts = chunks.map((c, i) => {
    const { before, after } = chunkContext(text, c);
    return {
      ...promptOpts,
      stylisticCap: effectiveStylisticCap(c.text.length),
      previousExcerpt: i === 0 ? promptOpts.previousExcerpt : before,
      nextExcerpt: i === last ? promptOpts.nextExcerpt : after,
      previousChapter: i === 0 ? promptOpts.previousChapter : null,
      nextChapter: i === last ? promptOpts.nextChapter : null,
      schreibfront: i === last ? promptOpts.schreibfront : false,
      stueckDavor: i > 0,
      stueckDanach: i < last,
    };
  });
  if (!split) {
    // Kombi in Stücken (Provider der Cloud-Klasse ausser Claude): je Stück der volle
    // Kombi-Prompt ohne Bewertung. Ohne Prompt-Cache kein gemeinsamer Kopf und kein
    // Staffeln; die Calls laufen so parallel, wie der Provider-Gate es zulässt.
    const kombiStueckSchema = buildLektoratSchema({ buchtyp, textsorte, ohneBewertung: true });
    const n = chunks.length;
    const parts = await Promise.all(chunks.map((c, i) => limited(() => aiCall(jobId, tok,
      buildLektoratPrompt(c.text, { ...chunkOpts[i], ohneBewertung: true }), system, null, null, 5000, 0.2,
      lektoratMaxTokens(c.text.length), undefined, kombiStueckSchema, undefined, null, `${pfx}kombi ${i + 1}/${n}`)).then(tick)));
    parts.forEach(checkStil);
    const bewertung = await bewertungPromise;
    const fehler = mergePasses(parts.map(r => r.fehler), text);
    logBefunde([['kombi', parts.reduce((s, r) => s + r.fehler.length, 0)]], fehler.length);
    return { fehler, szenen: bewertung?.szenen, stilanalyse: bewertung?.stilanalyse, fazit: bewertung?.fazit };
  }
  const stilSchema = buildLektoratSchema({ buchtyp, textsorte, stilOnly: true, ohneBewertung: true });
  // Prompt-Caching (nur Claude): die Stück-Prompts eines Passes sind bis kurz vor
  // dem Text identisch (Aufgabe + Regel-Korpus, mehrere tausend Tokens). Der
  // gemeinsame Kopf wird ein eigener Cache-Block, und je Pass startet erst EIN
  // Stück; die übrigen folgen, sobald dessen Antwort streamt — vorher ist der
  // Cache-Eintrag nicht lesbar, und parallel abgeschickte Calls zahlen alle den
  // vollen Input-Preis. Der System-Prompt (gleiches Schema je Pass) liest dabei mit.
  const cache = cacheBlocks;
  const prep = (list) => (cache ? sharedHeadBlocks(list) : list);
  const objPrompts = prep(chunks.map((c, i) => objektivPromptFor(c.text, chunkOpts[i])));
  const stilPrompts = prep(chunks.map((c, i) => stilPromptFor(c.text, chunkOpts[i], true)));
  // Gemeinsamer Kopf je Pass: Länge des Cache-Blocks oder warum es keinen gibt.
  const headInfo = (list) => (Array.isArray(list[0]) ? `${list[0][0].text.length} Z. Cache-Block` : (cache ? 'kein Block (Kopf unter Mindestlänge)' : 'kein Cache'));
  logger.info(`Lektorat-Stückköpfe${at}:objektiv ${headInfo(objPrompts)}, stil ${headInfo(stilPrompts)}; Start ${cache ? 'gestaffelt' : 'parallel'}.`);
  const t0 = Date.now();
  const onRelease = (pass) => () => logger.info(`Lektorat-Staffelung ${pfx}${pass}: Stück 1 streamt nach ${((Date.now() - t0) / 1000).toFixed(1)}s, Stücke 2–${chunks.length} starten.`);
  const launch = cache ? staggered : (ls) => ls.map(l => l(null));
  const n = chunks.length;
  const objPromises = launch(chunks.map((c, i) => (onStart) => runObjektiv(objPrompts[i], c.text.length, onStart, `objektiv ${i + 1}/${n}`)), onRelease('objektiv'));
  const stilPromises = launch(chunks.map((c, i) => (onStart) => runStil(stilPrompts[i], c.text.length, stilSchema, onStart, `stil ${i + 1}/${n}`)), onRelease('stil'));
  const [objs, stils] = await Promise.all([Promise.all(objPromises), Promise.all(stilPromises)]);
  stils.forEach(checkStil);
  const bewertung = await bewertungPromise;
  const fehler = mergePasses(chunks.flatMap((c, i) => [objFehler(objs[i]), stils[i].fehler]), text);
  logBefunde([
    ['objektiv', objs.reduce((s, o) => s + objFehler(o).length, 0)],
    ['stil', stils.reduce((s, st) => s + st.fehler.length, 0)],
  ], fehler.length);
  return { fehler, szenen: bewertung?.szenen, stilanalyse: bewertung?.stilanalyse, fazit: bewertung?.fazit };
}

// Gemeinsamer Kopf der Stück-Prompts eines Passes als Cache-Block. Länge = längstes
// gemeinsames Präfix aller Prompts, zurückgeschnitten auf das letzte Zeilenende —
// was je Stück variiert (Schreibstelle, Lesekontext, Text), liegt dahinter und
// bleibt ungecacht. Unter MIN_SHARED_HEAD_CHARS lohnt der Block nicht (das Minimum
// für einen Cache-Eintrag liegt je nach Modell bei 512–4096 Tokens); dann bleiben
// die Prompts Strings. Die Blöcke aneinandergehängt ergeben exakt den Prompt.
const MIN_SHARED_HEAD_CHARS = 2000;
function sharedHeadBlocks(prompts) {
  if (prompts.length < 2) return prompts;
  const first = prompts[0];
  let n = first.length;
  for (const p of prompts) {
    const max = Math.min(n, p.length);
    let i = 0;
    while (i < max && p.charCodeAt(i) === first.charCodeAt(i)) i++;
    n = i;
  }
  const cut = first.lastIndexOf('\n', n - 1) + 1;
  if (cut < MIN_SHARED_HEAD_CHARS) return prompts;
  const head = { type: 'text', text: first.slice(0, cut), cache_control: { type: 'ephemeral' } };
  return prompts.map(p => [head, { type: 'text', text: p.slice(cut) }]);
}

// Gestaffelter Start: launchers[i](onStart) startet einen Call. Der erste läuft
// sofort, die übrigen, sobald er streamt (onStart) oder fertig ist. Scheitert der
// erste vor dem Start, starten die übrigen nie — Promise.all des Aufrufers
// verwirft dann ohnehin.
// `onRelease` (optional, nur Logging) feuert einmal, wenn das Tor aufgeht.
function staggered(launchers, onRelease = null) {
  if (launchers.length < 2) return launchers.map(l => l(null));
  let release;
  const gate = new Promise((r) => { release = r; });
  if (onRelease) gate.then(() => { try { onRelease(); } catch { /* nur Logging */ } });
  const first = launchers[0](() => release());
  first.then(() => release(), () => {});
  return [first, ...launchers.slice(1).map(l => gate.then(() => l(null)))];
}

module.exports = { lektoratAnalyze, lektoratMaxTokens, splitEnabled, splitApplies, applyLektoratAiOverrides, sharedHeadBlocks, staggered };
