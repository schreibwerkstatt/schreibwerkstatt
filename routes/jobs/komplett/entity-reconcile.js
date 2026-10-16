'use strict';
// KI-Urteil für den Graubereich des Entitäten-Matchings (Figuren · Schauplätze · Szenen).
//
// Arbeitsteilung mit der deterministischen Schicht (lib/entity-match.js):
//   * Die Regel entscheidet, was sie sicher entscheiden kann — gleicher Name, Token-
//     Teilmenge mit Indizien, Qualifizierer-/Land-/Datums-Widerspruch.
//   * Was übrig bleibt, ist echter Graubereich («Schulhaus Frohheim» vs.
//     «Frohheim-Schule Olten», «Bahnhof» vs. «Bahnhof (Solothurn)»). Dort ist jede
//     Schwelle eine Münze: nur der Text weiss es. Diese Paare — und NUR sie — bekommt
//     das Modell vorgelegt.
// Der Nutzen dieser Aufteilung ist der Preis: eine Handvoll Paare mit je zwei Namen und
// zwei Kurzbeschreibungen kostet einen Bruchteil eines Gesamtlisten-Konsolidierungs-
// Calls, und die Regel bleibt für die klaren Fälle zuständig (kein Token für Fälle, die
// ohnehin entschieden sind).
//
// Ablauf pro Gattung, immer in dieser Reihenfolge:
//   1. `plan*Match` (NUR LESEND, aus db/ bzw. remap.js) → { matchOf, unsure }
//   2. `judgeEntityPairs` beurteilt `unsure` → Hint-Map der bestätigten Paare
//   3. `save*` mit `opts.matchHint` — die Schreibfunktion plant erneut, diesmal mit Hint
// Schritt 3 plant absichtlich neu statt den Plan aus Schritt 1 zu übernehmen: der Plan
// ist nur eine Vorschau, die Schreibfunktion bleibt die einzige Autorität über ihren
// eigenen Zustand (und ist ohne Job-Kontext weiterhin allein benutzbar).
//
// **Non-critical:** Kein Claude, Setting aus, Call gescheitert oder Antwort unbrauchbar
// → keine Hints, und das Matching bleibt exakt das der Regel. Ein ausgefallener Judge
// darf nie einen Merge erzwingen und nie den Job kippen.

const appSettings = require('../../../lib/app-settings');
const { updateJob, i18nErrText, settledAll } = require('../shared');
const { locationHintKey, figureHintKey, sceneHintKey } = require('../../../lib/entity-match');
const { komplettMaxTokens } = require('./phases/tokens');
const { providerClass } = require('../../../lib/ai');
const { COST_LABEL, costTier } = require('./cost-labels');

// Paare pro Call und Calls pro Gattung. Der Graubereich ist bei Figuren und Orten meist
// klein; bei Szenen paart der Planer innerhalb eines Kapitels jede neue mit jeder
// bestehenden Szene (bei ~200 Szenen weit über tausend Paare). Darum zählt die Auswahl
// mehr als der Deckel: pro Incoming nur die JUDGE_RANKS stärksten Kandidaten, und
// zuerst der beste Kandidat JEDES Incomings, bevor ein Zweitkandidat drankommt — sonst
// belegen wenige Incomings mit vielen ähnlichen Kandidaten den ganzen Deckel. Mehrere
// kleine Calls statt eines grossen: ein Paar kostet wenig, ein gescheiterter Call
// verliert nur seinen Teil.
const JUDGE_PAIR_CAP = 24;
const JUDGE_MAX_CALLS = 4;
const JUDGE_RANKS = 2;
const JUDGE_CONCURRENCY = 2;

/** Ordnet die unsicheren Paare für den Judge: ohne Dubletten, je Incoming höchstens
 *  JUDGE_RANKS Kandidaten, Rang vor Stärke (alle Erstkandidaten zuerst), innerhalb eines
 *  Rangs nach Namens-Ähnlichkeit, dann Indizien. Rein. */
function rankJudgePairs(unsure) {
  const byIndex = new Map();
  const seen = new Set();
  for (const u of (unsure || [])) {
    const key = `${u.index}|${u.existingId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byIndex.has(u.index)) byIndex.set(u.index, []);
    byIndex.get(u.index).push(u);
  }
  const strength = (a, b) => (b.sim - a.sim) || (b.evidence - a.evidence);
  const ranked = [];
  for (const list of byIndex.values()) {
    list.sort(strength).slice(0, JUDGE_RANKS).forEach((u, rank) => ranked.push({ u, rank }));
  }
  ranked.sort((x, y) => (x.rank - y.rank) || strength(x.u, y.u));
  return { ranked: ranked.map(r => r.u), total: seen.size };
}

function isJudgeEnabled(effectiveProvider) {
  if (providerClass(effectiveProvider) !== 'cloud') return false;
  const v = appSettings.get('ai.komplett.entity_match_judge');
  return v === undefined || v === null || v === '' ? true : v === true || v === 'true' || v === 1 || v === '1';
}

const HINT_KEY = { figur: figureHintKey, ort: locationHintKey, szene: sceneHintKey };

// Vergleichs-Steckbrief einer Seite für den Prompt. Bewusst knapp: Name, Typ, ein paar
// Zeilen Beschreibung, Kapitel/Seite/Figuren — mehr braucht die Entscheidung nicht, und
// jedes Zeichen zählt gegen das Budget.
function _sideOfIncoming(kind, e, ctx) {
  if (kind === 'figur') {
    return {
      name: e.name, typ: e.typ, beruf: e.beruf, geburtstag: e.geburtstag,
      kapitel: (e.kapitel || []).map(k => k?.name ?? k).filter(Boolean).slice(0, 4).join(', '),
      beschreibung: (e.beschreibung || '').slice(0, 220),
    };
  }
  if (kind === 'ort') {
    return {
      name: e.name, typ: e.typ, land: e.land,
      kapitel: (e.kapitel || []).map(k => (typeof k === 'object' && k ? k.name : k)).filter(Boolean).slice(0, 4).join(', '),
      figuren: (e.figuren_namen || []).slice(0, 5).join(', '),
      beschreibung: (e.beschreibung || '').slice(0, 220),
    };
  }
  return {
    name: e.titel, kapitel: e.kapitel, seite: e.seite,
    figuren: (e.figuren_namen || []).slice(0, 5).join(', '),
    beschreibung: (e.kommentar || '').slice(0, 220),
  };
}

// Steckbrief einer Bestands-Zeile. Die Felder heissen je Gattung anders (name/titel,
// beschreibung/kommentar) — hier normalisiert, damit der Prompt eine Form sieht.
function _sideOfExisting(kind, row) {
  if (kind === 'szene') {
    return { name: row.titel, beschreibung: (row.kommentar || '').slice(0, 220) };
  }
  return {
    name: row.name, typ: row.typ, land: row.land,
    beruf: row.beruf, geburtstag: row.geburtstag,
    beschreibung: (row.beschreibung || '').slice(0, 220),
  };
}

/** Beurteilt die unsicheren Paare einer Gattung und gibt die Hint-Map zurück
 *  (Map hintKey → existingId). `unsure` und `existing` kommen aus dem Planer,
 *  `incoming` ist die Liste, auf der geplant wurde (Index-Referenz!).
 *  Leere Map, wenn der Judge aus ist, es nichts zu urteilen gibt oder der Call scheitert. */
async function judgeEntityPairs(ctx, kind, { incoming, existing, unsure }) {
  const { jobId, bookName, call, tok, log, prompts, sys, effectiveProvider } = ctx;
  const hints = new Map();
  if (!isJudgeEnabled(effectiveProvider)) return hints;
  if (!unsure?.length) return hints;

  const exById = new Map(existing.map(r => [r.id, r]));
  const { ranked, total } = rankJudgePairs(unsure);
  const pairs = [];
  for (const u of ranked) {
    const inc = incoming[u.index];
    const ex = exById.get(u.existingId);
    if (!inc || !ex) continue;
    pairs.push({ nr: pairs.length + 1, u, a: _sideOfIncoming(kind, inc, ctx), b: _sideOfExisting(kind, ex) });
    if (pairs.length >= JUDGE_PAIR_CAP * JUDGE_MAX_CALLS) break;
  }
  if (!pairs.length) return hints;
  const dropped = total - pairs.length;
  if (dropped > 0) log.info(`Entitäten-Judge (${kind}): ${dropped} von ${total} Verdachtsfällen nicht vorgelegt (je Eintrag höchstens ${JUDGE_RANKS} Kandidaten, Deckel ${JUDGE_PAIR_CAP}×${JUDGE_MAX_CALLS}) – sie bleiben getrennt.`);

  updateJob(jobId, { statusText: 'job.phase.entityMatchJudge' });
  const batches = [];
  for (let i = 0; i < pairs.length; i += JUDGE_PAIR_CAP) batches.push(pairs.slice(i, i + JUDGE_PAIR_CAP));
  const settled = await settledAll(batches.map(batch => () => call(jobId, tok,
    prompts.buildEntityMatchJudgePrompt(bookName, kind, batch.map(p => ({ nr: p.nr, a: p.a, b: p.b }))),
    sys.SYSTEM_ORTE_BLOCKS, null, null, undefined, 0.2, komplettMaxTokens(effectiveProvider),
    prompts.SCHEMA_ENTITY_MATCH, costTier(COST_LABEL.match),
  )), batches.length > 1 ? { concurrency: JUDGE_CONCURRENCY } : {});
  const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  const paare = [];
  let failed = 0;
  settled.forEach((r, bi) => {
    const label = batches.length > 1 ? ` Teil ${bi + 1}/${batches.length}` : '';
    if (r.status === 'rejected') {
      failed++;
      log.warn(`Entitäten-Judge (${kind})${label} übersprungen (${i18nErrText(r.reason)}) – diese Paare bleiben regelbasiert.`);
    } else if (!Array.isArray(r.value?.paare)) {
      failed++;
      log.warn(`Entitäten-Judge (${kind})${label}: Antwort ohne paare-Array – diese Paare bleiben regelbasiert.`);
    } else {
      paare.push(...r.value.paare);
    }
  });
  if (failed) ctx.warnings?.push({ key: 'job.warn.entityMatchDegraded' });
  if (failed === batches.length) return hints;
  // «Erstes Urteil gilt» (unten) braucht die Rangfolge, nicht die Ankunftsreihenfolge
  // der Teil-Antworten.
  paare.sort((x, y) => Number(x?.nr) - Number(y?.nr));

  const keyOf = HINT_KEY[kind];
  const usedExisting = new Set();
  let confirmed = 0;
  for (const v of paare) {
    if (v?.gleich !== true) continue;
    const p = pairs.find(x => x.nr === Number(v.nr));
    if (!p) continue;
    const k = keyOf(incoming[p.u.index]);
    // Ein Incoming darf nur EIN Ziel bekommen und eine Bestands-Zeile nur EIN Incoming —
    // sagt das Modell bei einem ambigen Fall zweimal «gleich», gilt das erste Urteil
    // (stärkster Kandidat, die Liste ist danach sortiert).
    if (!k || hints.has(k) || usedExisting.has(p.u.existingId)) continue;
    hints.set(k, p.u.existingId);
    usedExisting.add(p.u.existingId);
    confirmed++;
  }
  log.info(`Entitäten-Judge (${kind}): ${confirmed}/${pairs.length} Verdachtsfälle als dieselbe Entität bestätigt.`);
  return hints;
}

module.exports = { judgeEntityPairs, isJudgeEnabled, rankJudgePairs, JUDGE_PAIR_CAP, JUDGE_MAX_CALLS };
