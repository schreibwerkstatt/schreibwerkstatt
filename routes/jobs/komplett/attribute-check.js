'use strict';
// Attribut-Widerspruchs-Detektor (F4) der Kontinuitätsprüfung — läuft in P8 der
// Komplettanalyse (phases/kontinuitaet.js) und im Standalone-Job (job-kontinuitaet.js).
// Re-exportiert über ./job-shared.

const appSettings = require('../../../lib/app-settings');
const {
  listFigureDeathsWithChapterNames, listFigureScenesWithChapterNames,
  listDatedLifeEventsWithChapterNames, listSubjectWorldFactsWithChapterNames,
} = require('../../../db/content-names');
const { updateJob, settledAll } = require('../shared');
const { COST_LABEL, costTier } = require('./cost-labels');

// Herkunfts-Marke jedes F4-Befunds. saveKontinuitaetResult (remap.js) überspringt für
// so markierte Befunde die Zitat-Beleg-Prüfung: ihre Stellen sind aus Katalog-Daten
// gebaut (Szenen-Titel, Jahr, Fakt-Aussage), keine wörtlichen Buchzitate.
const ATTR_SOURCE = 'attr';
// Ausgabe-Deckel des Urteils. Adaptives Thinking zählt gegen max_tokens — ein knapper
// Deckel schneidet das Urteil ab (truncated → verworfen). Effort 'low' hält das Denken
// kurz; ausserhalb Claudes ignorieren die Provider den Effort (lib/ai/core.js).
const _JUDGE_MAX_TOKENS = 4000;
const _JUDGE_EFFORT = 'low';
// Anführungszeichen, die _stelleQuote (./utils) als Zitat-Klammer liest. Synthetische
// Werte (Szenen-Titel) dürfen keine tragen, sonst gälten sie als Buchzitat.
const _QUOTE_CHARS = /[«»„"“”]/g;
function _plain(s) { return String(s || '').replace(_QUOTE_CHARS, '').replace(/\s+/g, ' ').trim(); }

// ── Attribut-Widerspruchs-Detektor (F4) ─────────────────────────────────────
// Der fakten-basierte Multi-Pass-Kontinuitätscheck sieht Fakten nur pro Kapitel → Cross-Chapter-
// Widersprüche (Kapitel 2 vs. 40) fallen strukturell durch. Dieser Detektor baut aus bereits
// persistierten, per-Kapitel-strukturierten Daten (figure_events, world_facts, Szenen)
// deterministisch Kandidatenpaare und lässt das Modell nur diese beurteilen. Ergänzt P8
// (ersetzt nichts). Rein lesend.
const _ATTR_CANDIDATE_CAP = 15;
// Nur Ereignisse, die eine Figur höchstens EINMAL erlebt. Hochzeit gehört nicht dazu —
// wer zweimal heiratet, ist kein Kontinuitätsfehler.
const _SINGULAR_EVENT_LABEL = { geburt: 'Geburtsjahr', tod: 'Todesjahr' };
// Welt-Fakt-Kategorie → Befund-Typ (continuity_issues.typ, Frontend-Label kontinuitaet.typ.*).
const _FACT_KATEGORIE_TYP = {
  figur: 'figur', ort: 'ort', objekt: 'objekt', zeit: 'zeitlinie', historie: 'zeitlinie', ereignis: 'zeitlinie',
};
// Zwei Fakten zum selben Subjekt sind nur dann ein Kandidat, wenn sie über DASSELBE
// sprechen (Wortüberlapp) — „Fabrik liegt am Stadtrand" vs. „Fabrik hat 200 Arbeiter"
// ist Ergänzung, kein Widerspruch.
const _FACT_PAIR_OVERLAP_MIN = 0.3;

function _factNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function _factTokens(s, subjekt) {
  const skip = new Set(_factNorm(subjekt).split(/[^\p{L}\p{N}]+/u));
  return new Set(_factNorm(s).split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2 && !skip.has(t)));
}
function _overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / Math.min(a.size, b.size);
}

/** Deterministische Kandidatenpaare (KEIN KI-Call). Drei Detektoren, in dieser Priorität:
 *  T) Auftritt nach dem Tod: eine Figur hat ein Tod-Ereignis in Kapitel X und handelt in
 *     einer Szene eines späteren Kapitels (Buchreihenfolge `chapterOrder`, Kapitel-IDs) oder
 *     auf einer späteren Seite desselben Kapitels (Seitenreihenfolge `pageOrder`, Page-IDs).
 *  A) Singuläre Lebensereignisse (geburt/tod) einer Figur mit ≥2 verschiedenen sicheren Jahren.
 *  B) Welt-Fakten gleicher Kategorie zum selben subjekt, die über dasselbe sprechen, aber
 *     verschieden lauten, in verschiedenen Kapiteln — je Subjekt das ähnlichste Paar.
 *  Gibt `[{ typ, entity, entityFigName, attribut, hinweis?, wertA:{wert,kapitel,beleg}, wertB }]`,
 *  gedeckelt auf _ATTR_CANDIDATE_CAP. */
function buildAttributeContradictions(bookIdInt, email, { chapterOrder = null, pageOrder = null } = {}) {
  const candidates = [];
  const orderOf = new Map((chapterOrder || []).map((id, i) => [Number(id), i]));
  const pageOf = new Map((pageOrder || []).map((id, i) => [Number(id), i]));

  // T) Auftritt nach dem Tod. Späteres Kapitel ODER dasselbe Kapitel auf einer späteren
  //    Seite (nur wenn Tod und Szene eine Seite tragen und beide in `pageOrder` stehen).
  if (orderOf.size) {
    const deaths = listFigureDeathsWithChapterNames(bookIdInt, email);
    const seenFig = new Set();
    for (const d of deaths) {
      if (seenFig.has(d.figure_id)) continue;
      const deathPos = orderOf.get(Number(d.chapter_id));
      if (deathPos == null) continue;
      const deathPage = d.page_id != null ? pageOf.get(Number(d.page_id)) : undefined;
      const later = listFigureScenesWithChapterNames(d.figure_id)
        .map(sc => ({
          ...sc,
          pos: orderOf.get(Number(sc.chapter_id)),
          pagePos: sc.page_id != null ? pageOf.get(Number(sc.page_id)) : undefined,
        }))
        .filter(sc => sc.pos != null && (sc.pos > deathPos
          || (sc.pos === deathPos && deathPage != null && sc.pagePos != null && sc.pagePos > deathPage)))
        .sort((a, b) => a.pos - b.pos || (a.pagePos ?? 0) - (b.pagePos ?? 0));
      if (!later.length) continue;
      seenFig.add(d.figure_id);
      const sc = later[0];
      const sameChapter = sc.pos === deathPos;
      candidates.push({
        typ: 'figur',
        entity: d.fig_name,
        entityFigName: d.fig_name,
        attribut: 'Lebendig/tot',
        hinweis: sameChapter
          ? 'Wert A ist der Tod der Figur, Wert B eine Szene SPÄTER IM SELBEN Kapitel (in einem folgenden Abschnitt), in der sie mitwirkt. Kein Widerspruch ist es bei Rückblende, Erinnerung, Traum, Vision, blosser Erwähnung durch andere, Geist/Erscheinung als bewusstem Stilmittel, einem Scheintod, den der Text auflöst, oder wenn die Szene das Sterben selbst zeigt.'
          : 'Wert A ist der Tod der Figur, Wert B eine Szene in einem SPÄTEREN Kapitel, in der sie mitwirkt. Kein Widerspruch ist es bei Rückblende, Erinnerung, Traum, Vision, blosser Erwähnung durch andere, Geist/Erscheinung als bewusstem Stilmittel oder einem Scheintod, den der Text auflöst.',
        wertA: { wert: 'stirbt', kapitel: d.chapter_name || '', beleg: d.ereignis || '' },
        // Ohne Anführungszeichen: der Titel ist Katalog-Text, kein Buchzitat (_stelleQuote).
        wertB: { wert: `wirkt mit in der Szene: ${_plain(sc.titel)}`, kapitel: sc.chapter_name || '', beleg: sc.kommentar || '' },
        _priority: 0,
      });
    }
  }

  // A) Singuläre Lebensereignisse mit Jahres-Konflikt.
  const evRows = listDatedLifeEventsWithChapterNames(bookIdInt, email);
  const byFigSubtyp = new Map();
  for (const r of evRows) {
    const key = `${r.figure_id}|${r.subtyp}`;
    if (!byFigSubtyp.has(key)) byFigSubtyp.set(key, []);
    byFigSubtyp.get(key).push(r);
  }
  for (const rows of byFigSubtyp.values()) {
    const years = [...new Set(rows.map(r => r.year))];
    if (years.length < 2) continue;
    const lo = rows.reduce((a, b) => a.year <= b.year ? a : b);
    const hi = rows.reduce((a, b) => a.year >= b.year ? a : b);
    candidates.push({
      typ: 'zeitlinie',
      entity: lo.fig_name,
      entityFigName: lo.fig_name,
      attribut: _SINGULAR_EVENT_LABEL[lo.subtyp] || lo.subtyp,
      wertA: { wert: String(lo.year), kapitel: lo.chapter_name || '', beleg: lo.ereignis || '' },
      wertB: { wert: String(hi.year), kapitel: hi.chapter_name || '', beleg: hi.ereignis || '' },
      _priority: 1,
    });
  }

  // B) Welt-Fakten: gleiche Kategorie + gleiches subjekt, ähnliche Aussage, anderer Wortlaut.
  const wfRows = listSubjectWorldFactsWithChapterNames(bookIdInt, email);
  const bySubjekt = new Map();
  for (const r of wfRows) {
    const key = `${_factNorm(r.kategorie)}|${_factNorm(r.subjekt)}`;
    if (!_factNorm(r.subjekt)) continue;
    if (!bySubjekt.has(key)) bySubjekt.set(key, []);
    bySubjekt.get(key).push({ ...r, tokens: _factTokens(r.fakt, r.subjekt) });
  }
  for (const rows of bySubjekt.values()) {
    let best = null, bestScore = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (_factNorm(a.fakt) === _factNorm(b.fakt)) continue;
        if ((a.chapter_name || '') === (b.chapter_name || '')) continue;
        const score = _overlap(a.tokens, b.tokens);
        if (score > bestScore) { best = [a, b]; bestScore = score; }
      }
    }
    if (!best || bestScore < _FACT_PAIR_OVERLAP_MIN) continue;
    const [a, b] = best;
    candidates.push({
      typ: _FACT_KATEGORIE_TYP[_factNorm(a.kategorie)] || 'sonstiges',
      entity: a.subjekt,
      entityFigName: null,
      attribut: a.subjekt,
      wertA: { wert: a.fakt, kapitel: a.chapter_name || '', beleg: '' },
      wertB: { wert: b.fakt, kapitel: b.chapter_name || '', beleg: '' },
      _priority: 2,
      _score: bestScore,
    });
  }
  // Innerhalb einer Priorität die ähnlichsten Welt-Fakt-Paare zuerst (stärkster Verdacht).
  candidates.sort((x, y) => x._priority - y._priority || (y._score || 0) - (x._score || 0));
  return candidates.slice(0, _ATTR_CANDIDATE_CAP);
}

/** Beurteilt die Kandidaten aus buildAttributeContradictions per KI (Konsolidierungs-Tier,
 *  kein extractTier-Override, Effort 'low') und gibt bestätigte Widersprüche in Problem-Form
 *  zurück (kompatibel zu kontResult.probleme → wird dort eingemischt und mit gespeichert).
 *  Jeder Befund trägt `_source: 'attr'` (ATTR_SOURCE): seine Stellen sind aus Katalog-Daten
 *  gebaut, keine Buchzitate — saveKontinuitaetResult nimmt ihn darum von der Zitat-Beleg-
 *  Prüfung aus. Concurrency-Cap + Warmup wie die Verify-Stufe. Non-fatal: fehlgeschlagene
 *  Einzel-Urteile werden geloggt und, falls `ctx.warnings` existiert, als Warnung gemeldet. */
async function runAttributeContradictionCheck(ctx, fromPct, toPct) {
  const { call, prompts, sys, jobId, tok, bookName, bookIdInt, email, log, groupOrder, pageContents, warnings } = ctx;
  // Buchreihenfolge der Kapitel (groupOrder-Keys = chapter_id) und der Seiten (pageContents
  // liegt in Lesereihenfolge vor) für „Auftritt nach dem Tod".
  const chapterOrder = (groupOrder || []).filter(k => k !== '__ungrouped__').map(Number).filter(Number.isFinite);
  const pageOrder = (pageContents || []).map(p => Number(p?.id)).filter(Number.isFinite);
  const candidates = buildAttributeContradictions(bookIdInt, email, { chapterOrder, pageOrder });
  if (!candidates.length) return [];
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.checkAttributes' });
  const claudeConcurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
  const settled = await settledAll(candidates.map((cand) => async () => {
    const v = await call(jobId, tok,
      prompts.buildAttributeContradictionJudgePrompt(bookName, cand),
      sys.SYSTEM_KONTINUITAET_BLOCKS, null, null, 600, 0.3, _JUDGE_MAX_TOKENS, prompts.SCHEMA_ATTR_CONTRADICTION,
      { ...costTier(COST_LABEL.kontinuitaet), effort: _JUDGE_EFFORT });
    if (v?.widerspruch !== true) return null;
    const stelle = (w) => `${cand.attribut}: ${w.wert}${w.kapitel ? ` (Kapitel ${w.kapitel})` : ''}`;
    return {
      schwere: v.schwere || 'mittel',
      typ: cand.typ,
      beschreibung: v.beschreibung || '',
      stelle_a: stelle(cand.wertA),
      stelle_b: stelle(cand.wertB),
      empfehlung: v.empfehlung || '',
      figuren: cand.entityFigName ? [cand.entityFigName] : [],
      kapitel: [cand.wertA.kapitel, cand.wertB.kapitel].filter(Boolean),
      _source: ATTR_SOURCE,
    };
  }), { concurrency: claudeConcurrency, warmup: true });
  const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  // Fehlgeschlagene Urteile (abgeschnitten, Provider-Fehler) sind UNGEPRÜFTE Kandidaten,
  // keine verneinten — nicht still schlucken.
  const failed = settled.filter(r => r.status === 'rejected');
  if (failed.length) {
    log.warn(`Attribut-Widerspruchs-Detektor: ${failed.length}/${candidates.length} Urteile fehlgeschlagen (${failed[0].reason?.message || failed[0].reason}).`);
    if (Array.isArray(warnings)) {
      warnings.push({ key: 'job.warn.attributeCheckPartial', params: { failed: failed.length, total: candidates.length } });
    }
  }
  const findings = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (toPct != null) updateJob(jobId, { progress: toPct });
  log.info(`Attribut-Widerspruchs-Detektor: ${findings.length}/${candidates.length} Kandidaten als echter Widerspruch bestätigt.`);
  return findings;
}

module.exports = { buildAttributeContradictions, runAttributeContradictionCheck, ATTR_SOURCE };
