'use strict';
// Phase 2, Teil-Konsolidierung der Figuren: passt die Figurenliste nicht in EINEN Call,
// wird sie in Teilen konsolidiert statt ganz auf den regelbasierten Fallback zu fallen.
//
// **Why:** Der Konsolidierungs-Call gibt die ganze Figurenliste neu aus. Auf Modellen mit
// adaptivem Denken zählt das Reasoning gegen dasselbe `max_tokens` wie das JSON — bei
// ~120 Figuren aus sechs Kapiteln reichten 128K Output nicht mehr, der Call truncierte
// nach einer Viertelstunde, und das Buch verlor die KI-Zusammenführung ganz.
//
// Aufteilung: Figuren, die einen Namensbestandteil teilen («Hans», «Hans Meier»,
// «Frau Meier»), landen im selben Teil — genau unter ihnen sucht die Konsolidierung
// Dubletten. Was der Pre-Merge schon zusammengelegt hat, ist ohnehin eine Figur. Die
// Teile tragen je ihren eigenen ID-Raum; Beziehungen werden darum über den Zielnamen
// gebunden (rebindBeziehungenByName), und Kanten zu Figuren eines ANDEREN Teils, die
// das Modell nicht sehen konnte, werden aus der Eingabe übernommen.
const { normName, nameTokens } = require('../../../../lib/name-normalize');
const { updateJob, retryOnTransientAi, settledAll, i18nError, i18nErrText } = require('../../shared');
const { rebindBeziehungenByName } = require('../figuren-merge');
const { COST_LABEL, costTier } = require('../cost-labels');

/** Anteil des Output-Caps, den das JSON einer Konsolidierung höchstens belegen darf.
 *  Der Rest gehört dem adaptiven Denken (gleiches Budget) und der Schätz-Unschärfe. */
const KONSOL_SINGLE_RESERVE = 0.5;
/** Ziel je Teil: deutlich darunter, damit ein Teil auch bei viel Reasoning durchläuft. */
const KONSOL_BATCH_RESERVE = 0.35;
const KONSOL_CONCURRENCY = 3;

function _figSize(f) {
  return JSON.stringify(f || {}).length;
}

/** Teilt pre-gemergte Kapitel-Figuren in Teile von höchstens `maxChars` (JSON-Länge).
 *  Gibt Teile im Kapitel-Format zurück ([{ kapitel, figuren }]), damit der bestehende
 *  Prompt-Builder sie unverändert lesen kann. Rein, deterministisch. */
function planKonsolBatches(chapterFiguren, maxChars) {
  const entries = [];
  (chapterFiguren || []).forEach((cf, ci) => {
    for (const f of (cf.figuren || [])) entries.push({ ci, f, size: _figSize(f) });
  });
  // Union-Find über geteilte Namensbestandteile (Name + Kurzname).
  const parent = entries.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byToken = new Map();
  entries.forEach((e, i) => {
    const toks = new Set([...nameTokens(e.f.name), ...nameTokens(e.f.kurzname)]);
    for (const t of toks) {
      if (byToken.has(t)) parent[find(i)] = find(byToken.get(t));
      else byToken.set(t, i);
    }
  });
  const groups = new Map();
  entries.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  });
  // Grösste Gruppen zuerst (First-Fit-Decreasing); eine Gruppe über dem Ziel wird in
  // Namensreihenfolge zerlegt — ihre Teile bleiben dann wenigstens beieinander sortiert.
  const units = [];
  for (const g of groups.values()) {
    const total = g.reduce((s, e) => s + e.size, 0);
    if (total <= maxChars) { units.push({ entries: g, size: total }); continue; }
    const sorted = [...g].sort((a, b) => normName(a.f.name).localeCompare(normName(b.f.name)));
    let cur = { entries: [], size: 0 };
    for (const e of sorted) {
      if (cur.entries.length && cur.size + e.size > maxChars) { units.push(cur); cur = { entries: [], size: 0 }; }
      cur.entries.push(e); cur.size += e.size;
    }
    if (cur.entries.length) units.push(cur);
  }
  units.sort((a, b) => b.size - a.size);
  const bins = [];
  for (const u of units) {
    const bin = bins.find(b => b.size + u.size <= maxChars);
    if (bin) { bin.entries.push(...u.entries); bin.size += u.size; }
    else bins.push({ entries: [...u.entries], size: u.size });
  }
  // Zurück ins Kapitel-Format, Kapitelreihenfolge und Reihenfolge innerhalb erhalten.
  return bins.map(bin => {
    const perCh = new Map();
    for (const e of bin.entries) {
      if (!perCh.has(e.ci)) perCh.set(e.ci, []);
      perCh.get(e.ci).push(e.f);
    }
    return [...perCh.keys()].sort((a, b) => a - b)
      .map(ci => ({ kapitel: chapterFiguren[ci].kapitel, figuren: perCh.get(ci) }));
  });
}

/** Führt die Ergebnisse der Teile zu einer Liste mit global eindeutigen ids zusammen.
 *  `parts[i] = { input, figuren }` — `figuren` aus der KI-Konsolidierung des Teils oder,
 *  wenn sie scheiterte, die Eingabe selbst. Mutiert die Eingaben nicht. */
function _inputNames(input) {
  const names = new Set();
  for (const cf of input) for (const g of (cf.figuren || [])) {
    for (const nm of [g.name, g.kurzname]) { const k = normName(nm); if (k) names.add(k); }
  }
  return names;
}

function mergeKonsolParts(parts, log) {
  const out = [];
  let n = 0;
  let foreign = 0;
  const inputByPart = parts.map(p => _inputNames(p.input));
  for (const [pi, { input, figuren }] of parts.entries()) {
    const nameById = new Map();
    for (const f of (figuren || [])) if (f?.id != null && f.name) nameById.set(String(f.id), f.name);
    const inPart = inputByPart[pi];
    // Eine Ausgabe-Figur, deren Name nicht in diesem Teil, wohl aber in einem anderen
    // steht, hat das Modell aus einem Beziehungsziel erfunden — der andere Teil liefert
    // sie mit vollem Steckbrief. Neue kanonische Namen (in keinem Teil) bleiben.
    const ownedElsewhere = (f) => {
      const keys = [f?.name, f?.kurzname].map(normName).filter(Boolean);
      if (!keys.length || keys.some(k => inPart.has(k))) return false;
      return inputByPart.some((s, j) => j !== pi && keys.some(k => s.has(k)));
    };
    const kept = (figuren || []).filter(f => {
      if (!ownedElsewhere(f)) return true;
      foreign++;
      return false;
    });
    const partOut = kept.map(f => {
      const beziehungen = (f.beziehungen || []).map(bz => {
        if (!bz) return null;
        const name = bz.name || nameById.get(String(bz.figur_id ?? ''));
        return name ? { ...bz, name } : null;
      }).filter(Boolean);
      return { ...f, id: 'fig_' + (++n), beziehungen };
    });
    // Kanten zu Figuren anderer Teile aus der Eingabe übernehmen: das Modell kannte deren
    // ids nicht und hat sie im Zweifel weggelassen.
    const outByName = new Map();
    for (const f of partOut) {
      for (const nm of [f.name, f.kurzname]) { const k = normName(nm); if (k && !outByName.has(k)) outByName.set(k, f); }
    }
    for (const cf of input) for (const g of (cf.figuren || [])) {
      const owner = outByName.get(normName(g.name)) || outByName.get(normName(g.kurzname));
      if (!owner) continue;
      for (const bz of (g.beziehungen || [])) {
        const k = normName(bz?.name);
        if (!k || inPart.has(k)) continue;
        if (owner.beziehungen.some(b => normName(b.name) === k)) continue;
        owner.beziehungen.push({ ...bz });
      }
    }
    out.push(...partOut);
  }
  if (foreign) log?.info(`Figuren-Teile: ${foreign} Figur(en) verworfen, die nur als Beziehungsziel aus einem anderen Teil stammten.`);
  rebindBeziehungenByName(out, log);
  return out;
}

/** Konsolidiert die Teile parallel. Ein Teil, der truncierte, wird einmal halbiert; was
 *  dann noch scheitert, geht regelbasiert (als Eingabe) in das Ergebnis ein. Wirft nur,
 *  wenn KEIN Teil durchkam — dann ist der Fallback des Aufrufers ehrlicher. */
async function runKonsolBatched(ctx, preMerged, { cap, charsPerToken, fromPct, toPct }) {
  const { jobId, bookName, call, tok, log, prompts, sys } = ctx;
  const maxChars = Math.max(20000, Math.floor(cap * KONSOL_BATCH_RESERVE * charsPerToken));
  const batches = planKonsolBatches(preMerged, maxChars);
  const count = (b) => b.reduce((s, cf) => s + (cf.figuren || []).length, 0);
  log.info(`Phase-2-Figuren-Konsolidierung in ${batches.length} Teilen (${batches.map(count).join('+')} Figuren, Ziel ≤${maxChars} Zeichen je Teil).`);
  updateJob(jobId, { statusText: 'job.phase.consolidatingFigurenParts', statusParams: { n: batches.length } });

  const konsol = (input, label) => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildFiguresBasisConsolidationPrompt(bookName, input, sys.BUCH_KONTEXT || '', { teil: true }),
    sys.SYSTEM_FIGUREN_BLOCKS, fromPct, toPct, undefined, 0.2, cap, prompts.SCHEMA_FIGUREN_KONSOL,
    costTier(COST_LABEL.figuren),
  ), { log, label }).then(res => {
    if (!Array.isArray(res?.figuren)) throw i18nError('job.error.figurenMissing');
    return res.figuren;
  });

  const runPart = async (input, i) => {
    const label = `Figuren-Teil ${i + 1}/${batches.length}`;
    try {
      return [{ input, figuren: await konsol(input, label), ok: true }];
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const halves = e?.message === 'job.error.aiTruncated' && count(input) > 1
        ? planKonsolBatches(input, Math.ceil(input.reduce((s, cf) => s + cf.figuren.reduce((t, f) => t + _figSize(f), 0), 0) / 2))
        : null;
      if (halves && halves.length > 1) {
        log.warn(`${label} – Truncation, Retry in ${halves.length} kleineren Teilen.`);
        const res = [];
        for (const [hi, h] of halves.entries()) {
          try { res.push({ input: h, figuren: await konsol(h, `${label}.${hi + 1}`), ok: true }); }
          catch (e2) {
            if (e2.name === 'AbortError') throw e2;
            log.warn(`${label}.${hi + 1} übersprungen (${i18nErrText(e2)}) – regelbasiert übernommen.`);
            res.push({ input: h, figuren: h.flatMap(cf => cf.figuren || []), ok: false });
          }
        }
        return res;
      }
      log.warn(`${label} übersprungen (${i18nErrText(e)}) – regelbasiert übernommen.`);
      return [{ input, figuren: input.flatMap(cf => cf.figuren || []), ok: false }];
    }
  };

  const settled = await settledAll(batches.map((b, i) => () => runPart(b, i)), { concurrency: KONSOL_CONCURRENCY });
  const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  const failed = settled.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  const parts = settled.flatMap(r => r.value);
  const okParts = parts.filter(p => p.ok).length;
  if (!okParts) throw i18nError('job.error.figurenMissing');
  const figuren = mergeKonsolParts(parts, log);
  log.info(`Phase-2-Figuren-Konsolidierung: ${okParts}/${parts.length} Teile per KI, ${figuren.length} Figuren.`);
  return { figuren, degraded: okParts < parts.length };
}

module.exports = {
  KONSOL_SINGLE_RESERVE, KONSOL_BATCH_RESERVE,
  planKonsolBatches, mergeKonsolParts, runKonsolBatched,
};
